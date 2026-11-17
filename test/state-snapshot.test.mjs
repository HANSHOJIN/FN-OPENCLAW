import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { inspectTree } from '../openclaw-fnos/app/shell/maintenance.mjs'
import { preservedStatePaths, normalizePreserved, cloneRuntimeState, movePreservedState } from '../openclaw-fnos/app/shell/state-snapshot.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fnc-state-snapshot-'))
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'source'), destination = path.join(root, 'destination')
  fs.mkdirSync(source)
  const write = (relative, text) => {
    const file = path.join(source, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  return { root, source, destination, write }
}

test('runtime snapshots exclude projects, caches and migration archives but protect live databases and credentials', async t => {
  const f = fixture(t)
  for (const relative of ['workspace/project/source.js', 'workspace/legacy/node_modules/package.bin',
    'workspace-other/project.txt', 'tmp/plugin-captures/capture.bin', 'backups/original.zip',
    'agents/main/session-sqlite-import-archive/archive.jsonl',
    'agents/main/agent/openclaw-transcript-labels-recovery-old/database.sqlite']) f.write(relative, 'user or regenerable content')
  for (const relative of ['openclaw.json', 'credentials/provider.json', 'state/openclaw.sqlite',
    'agents/main/agent/openclaw-agent.sqlite', 'agents/main/sessions/active.jsonl', 'unknown/keep.bin']) f.write(relative, 'runtime state')
  const preserved = preservedStatePaths(f.source)
  const before = await inspectTree(f.source, { exclude: preserved })
  await cloneRuntimeState(f.source, f.destination, preserved)
  assert.deepEqual(await inspectTree(f.destination), before)
  assert.equal(before.files, 6)
  assert.equal(fs.existsSync(path.join(f.destination, 'workspace')), false)
  assert.equal(fs.existsSync(path.join(f.destination, 'tmp')), false)
  assert.equal(fs.existsSync(path.join(f.destination, 'agents/main/session-sqlite-import-archive')), false)
  // A CoW clone must remain independent when the candidate writes to its DB.
  fs.writeFileSync(path.join(f.destination, 'state/openclaw.sqlite'), 'candidate migration')
  assert.equal(fs.readFileSync(path.join(f.source, 'state/openclaw.sqlite'), 'utf8'), 'runtime state')
})

test('user files move without copying and remain at the same content and inode', async t => {
  const f = fixture(t)
  const file = f.write('workspace/project.txt', 'original')
  const archive = f.write('agents/main/session-sqlite-import-archive/archive.jsonl', 'archive')
  f.write('agents/main/agent/openclaw-agent.sqlite', 'current database')
  const inodes = [fs.statSync(file).ino, fs.statSync(archive).ino]
  const preserved = preservedStatePaths(f.source)
  await cloneRuntimeState(f.source, f.destination, preserved)
  movePreservedState(f.source, f.destination, preserved)
  assert.equal(fs.statSync(path.join(f.destination, 'workspace/project.txt')).ino, inodes[0])
  assert.equal(fs.statSync(path.join(f.destination, 'agents/main/session-sqlite-import-archive/archive.jsonl')).ino, inodes[1])
  movePreservedState(f.source, f.destination, preserved) // A recovery retry is idempotent.
  assert.equal(fs.existsSync(path.join(f.source, 'workspace')), false)
})

test('conflicting user data is retained on both sides instead of overwritten', t => {
  const f = fixture(t)
  f.write('workspace/project.txt', 'current user file')
  fs.mkdirSync(path.join(f.destination, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(f.destination, 'workspace/project.txt'), 'other copy')
  assert.throws(() => movePreservedState(f.source, f.destination, ['workspace']), /冲突/)
  assert.equal(fs.readFileSync(path.join(f.source, 'workspace/project.txt'), 'utf8'), 'current user file')
  assert.equal(fs.readFileSync(path.join(f.destination, 'workspace/project.txt'), 'utf8'), 'other copy')
})

test('journal paths cannot escape state, and preserved symlinks do not expose linked data to the snapshot', async t => {
  const f = fixture(t)
  for (const value of ['../outside', '/outside', 'C:/outside', 'a/../../outside', 'a\\outside', '.', 'a//b', 'a/./b']) {
    assert.throws(() => normalizePreserved([value]), /无效/)
  }
  const external = path.join(f.root, 'external')
  fs.mkdirSync(external);fs.writeFileSync(path.join(external, 'project.txt'), 'external file')
  fs.symlinkSync(external, path.join(f.source, 'workspace'), process.platform === 'win32' ? 'junction' : 'dir')
  f.write('state/openclaw.sqlite', 'database')
  const preserved = preservedStatePaths(f.source)
  await cloneRuntimeState(f.source, f.destination, preserved)
  assert.equal(fs.existsSync(path.join(f.destination, 'workspace')), false)
  movePreservedState(f.source, f.destination, preserved)
  assert.equal(fs.lstatSync(path.join(f.destination, 'workspace')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(path.join(external, 'project.txt'), 'utf8'), 'external file')
})

test('a linked destination ancestor cannot redirect a nested archive move outside state', t => {
  const f = fixture(t)
  const file = f.write('agents/main/session-sqlite-import-archive/archive.jsonl', 'keep archive')
  const external = path.join(f.root, 'external')
  fs.mkdirSync(external);fs.mkdirSync(f.destination)
  fs.symlinkSync(external, path.join(f.destination, 'agents'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => movePreservedState(f.source, f.destination, ['agents/main/session-sqlite-import-archive']), /父目录/)
  assert.equal(fs.existsSync(file), true)
  assert.deepEqual(fs.readdirSync(external), [])
})
