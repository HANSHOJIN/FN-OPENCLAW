"""Build the x86_64 fnOS package with fnpack and verify its Unix metadata."""

import argparse
import gzip
import hashlib
import io
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NODE_ARCHIVE = 'node-v24.22.2-linux-x64.tar.gz'
NODE_SHA256 = '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9'
PACKAGE_VERSION = re.search(r'(?m)^version=(\S+)$', (ROOT / 'openclaw-fnos' / 'manifest').read_text('utf-8')).group(1)
FILENAME = f'OpenClaw-fnOS-{PACKAGE_VERSION}-x86_64.fpk'


def hash_file(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def node_archive():
    cache = ROOT / '.build' / NODE_ARCHIVE
    cache.parent.mkdir(exist_ok=True)
    if not cache.exists():
        partial = cache.with_suffix('.part')
        url = f'https://nodejs.org/dist/v24.22.2/{NODE_ARCHIVE}'
        with urllib.request.urlopen(url, timeout=120) as response, partial.open('wb') as out:
            shutil.copyfileobj(response, out)
        if hash_file(partial) != NODE_SHA256:
            raise ValueError('Node.js 下载校验失败。')
        partial.replace(cache)
    if hash_file(cache) != NODE_SHA256:
        raise ValueError('Node.js 归档校验失败。')
    return cache


def normalize(raw, output, temp):
    nested = temp / 'normalized-app.tgz'
    with tarfile.open(raw, 'r:gz') as outer:
        with tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r:gz') as src, nested.open('wb') as out:
            with gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as gz, tarfile.open(fileobj=gz, mode='w') as dst:
                for member in src:
                    executable = member.name.lstrip('./').startswith('bin/')
                    copy_entry(dst, member, src.extractfile(member) if member.isfile() else None, executable)
        manifest = outer.extractfile('manifest').read().decode('utf-8').replace('\r\n', '\n')
        manifest, count = re.subn(r'(?m)^checksum\s*=.*$', 'checksum = ' + hash_file(nested, 'md5'), manifest)
        if count != 1:
            raise ValueError('fnpack 未生成唯一的 checksum。')
        with output.open('wb') as out, gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as dst:
                for member in outer:
                    if member.name == 'manifest':
                        content = manifest.encode()
                        member.size = len(content)
                        copy_entry(dst, member, io.BytesIO(content))
                    elif member.name == 'app.tgz':
                        member.size = nested.stat().st_size
                        with nested.open('rb') as app:
                            copy_entry(dst, member, app)
                    else:
                        copy_entry(dst, member, outer.extractfile(member) if member.isfile() else None, member.name.startswith('cmd/'))


def copy_entry(archive, member, content, executable=False):
    member.uid = member.gid = 0
    member.uname = member.gname = 'root'
    member.mode = 0o755 if member.isdir() or executable else 0o644
    member.mtime = 0
    member.pax_headers = {}
    archive.addfile(member, content)


def verify(output):
    with tarfile.open(output, 'r:gz') as archive:
        manifest = archive.extractfile('manifest').read().decode()
        checksums = re.findall(r'(?m)^checksum\s*=\s*([a-f0-9]{32})\s*$', manifest)
        if checksums != [hashlib.file_digest(archive.extractfile('app.tgz'), 'md5').hexdigest()]:
            raise ValueError('FPK checksum 与 app.tgz 不一致。')
        for hook in ('main', 'upgrade_init', 'uninstall_init'):
            member = archive.getmember('cmd/' + hook)
            if member.mode != 0o755 or b'\r' in archive.extractfile(member).read():
                raise ValueError('启动脚本权限或换行错误。')
        with tarfile.open(fileobj=archive.extractfile('app.tgz'), mode='r:gz') as app:
            if app.getmember('bin/fn-openclaw-core').mode != 0o755:
                raise ValueError('核心更新命令缺少执行权限。')
            for file in ('ui/config', 'shell/server.mjs', 'shell/core.mjs', 'shell/index.html',
                         'shell/shell.js', 'shell/shell.css', 'shell/titlebar.js', 'shell/titlebar.css'):
                app.getmember(file)
            runtime = app.extractfile('node-runtime.tar.gz')
            if hashlib.file_digest(runtime, 'sha256').hexdigest() != NODE_SHA256:
                raise ValueError('FPK 内 Node.js 校验失败。')
            with tarfile.open(fileobj=app.extractfile('node-runtime.tar.gz'), mode='r:gz') as node:
                binary = node.extractfile('node-v24.22.2-linux-x64/bin/node').read(20)
                if binary[:6] != b'\x7fELF\x02\x01' or int.from_bytes(binary[18:20], 'little') != 62:
                    raise ValueError('Node.js 不是 Linux x86_64 ELF。')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fnpack', type=Path, required=True)
    args = parser.parse_args()
    fnpack = args.fnpack.resolve(strict=True)
    runtime = node_archive()
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='build-', dir=ROOT / '.build') as workspace:
        temp = Path(workspace)
        stage = temp / 'openclaw-fnos'
        shutil.copytree(ROOT / 'openclaw-fnos', stage)
        shutil.copyfile(runtime, stage / 'app' / 'node-runtime.tar.gz')
        subprocess.run([str(fnpack), 'build', '--directory', str(stage)], cwd=stage, check=True)
        packages = list(stage.glob('*.fpk'))
        if len(packages) != 1:
            raise RuntimeError('fnpack 未生成安装包。')
        raw = packages[0]
        verified = temp / FILENAME
        normalize(raw, verified, temp)
        verify(verified)
        output = dist / FILENAME
        verified.replace(output)
    output.with_suffix('.fpk.sha256').write_text(f'{hash_file(output)}  {output.name}\n', encoding='ascii')
    print(output)


if __name__ == '__main__':
    main()
