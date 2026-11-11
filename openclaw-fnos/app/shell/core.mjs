import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { CORE_PORT, CORE_VERSION, UI_PATH } from './defaults.mjs'
import { INSTANCE_ENV, findGatewayProcesses, isSameProcess, ownsGatewayListener } from './gateway-process.mjs'
import { inspectTree, prepareUpgrade, auditUpgrade, snapshotName } from './maintenance.mjs'
import { validVersion, frameworkVersion, compareVersions, UpstreamVersions } from './versions.mjs'

const RETRY_DELAYS = [2000, 5000, 15000, 30000]
const STABLE_UPTIME = 60000

export { validVersion } from './versions.mjs'

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

function saveJSON(file, value) {
  fs.writeFileSync(file + '.next', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(file + '.next', file)
}

function groupHasLiveProcess(pid) {
  if (process.platform !== 'linux') return false
  try { process.kill(-pid, 0) }
  catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
  // An exited orphan may still be a zombie, which cannot hold the Gateway open.
  return fs.readdirSync('/proc').some(entry => {
    if (!/^\d+$/.test(entry)) return false
    try {
      const stat = fs.readFileSync('/proc/' + entry + '/stat', 'utf8')
      const [state, , group] = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
      return Number(group) === pid && state !== 'Z'
    } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return false
      throw error
    }
  })
}

async function stopProcess(exited, send) {
  const waitForExit = async timeout => {
    const deadline = performance.now() + timeout
    while (!exited() && performance.now() < deadline) await delay(100)
    return exited()
  }
  if (exited()) return
  send('SIGTERM')
  if (await waitForExit(12000)) return
  send('SIGKILL')
  if (!await waitForExit(2000)) throw new Error('无法确认 OpenClaw 进程已退出。')
}

export class Core {
  constructor({ data, config, home, npm, ca, port = CORE_PORT }) {
    this.data = data
    this.port = port
    this.stateDir = path.join(data, 'state')
    this.runtimes = path.join(data, 'cores')
    this.logFile = path.join(data, 'gateway.log')
    this.activeFile = path.join(data, 'active.json')
    this.transactionFile = path.join(data, 'update.json')
    this.ownerFile = path.join(data, 'gateway-owner.json')
    this.pauseFile = path.join(data, 'gateway-stopped')
    this.updateStatusFile = path.join(data, 'update-status.json')
    this.snapshotsFile = path.join(data, 'snapshots.json')
    this.paused = fs.existsSync(this.pauseFile)
    this.npm = npm
    this.phase = 'stopped'
    this.generation = 0
    this.retryCount = 0
    this.failure = ''
    this.frameworkVersion = frameworkVersion()
    this.upstream = new UpstreamVersions()
    for (const dir of [data, config, home, this.runtimes]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tokenFile = path.join(config, 'gateway.token')
    if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 })
    this.token = fs.readFileSync(tokenFile, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('网关凭据文件格式无效。')
    this.env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: path.join(this.stateDir, 'openclaw.json'),
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_GATEWAY_TOKEN: this.token,
      OPENCLAW_NO_AUTO_UPDATE: '1',
      PATH: [path.dirname(process.execPath), process.env.PATH,
        process.platform === 'win32' ? undefined : '/usr/local/bin:/usr/bin:/bin']
        .filter(Boolean).join(path.delimiter),
      ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}),
    }
    // Installing a new shell must not silently upgrade an existing instance.
    const active = readJSON(this.activeFile)
    const interrupted = readJSON(this.transactionFile)
    const legacyVersion = '2026.11.2'
    const existingVersion = fs.existsSync(this.stateDir) ? readJSON(this.ownerFile)?.version ??
      (fs.existsSync(path.join(this.runtimes, legacyVersion, 'installed')) ? legacyVersion : undefined) : undefined
    // An old interrupted transaction may have overwritten gateway-owner.json
    // with the candidate. That is not evidence of a committed version switch.
    this.version = active?.version ?? (interrupted ? interrupted.previous ?? legacyVersion : existingVersion) ?? CORE_VERSION
    if (!validVersion(this.version)) throw new Error('运行版本记录无效。')
    this.maintenance = readJSON(this.updateStatusFile)
    if (this.maintenance) {
      this.maintenance.blockIngress = false
      if (!['complete', 'deferred', 'failed', 'rolled-back'].includes(this.maintenance.stage)) {
        this.maintenance.stage = 'interrupted'
        this.maintenance.message = '上次更新中断，请核对当前版本和日志。'
      }
    }
  }

  get available() { return this.phase === 'running' && !this.maintenance?.blockIngress }

  updateProgress(value) {
    this.maintenance = { ...this.maintenance, ...value, updatedAt: Date.now() }
    saveJSON(this.updateStatusFile, this.maintenance)
  }

  finishMaintenance(value) {
    // A status-file failure must not undo a verified recovery. updateProgress
    // updates memory first, so the serving decision still reflects that recovery.
    try { this.updateProgress(value) }
    catch (error) { this.log('无法保存维护结果：' + error.message) }
  }

  async cliJSON(version, args, { timeout = 15000, allowFailure = false } = {}) {
    const child = spawn(process.execPath, [this.gatewayEntry(version), ...args], {
      env: { ...this.env, OPENCLAW_SUPERVISOR_MODE: 'external' }, cwd: this.env.HOME,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.inspector = child
    let output = ''
    let bytes = 0
    let overflow = false
    let expired = false
    const timer = setTimeout(() => { expired = true; void this.stopChild(child).catch(() => {}) }, timeout)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1024 * 1024) { overflow = true; void this.stopChild(child).catch(() => {}); return }
      output += chunk
    })
    child.stderr.resume() // CLI diagnostics may contain private paths; never forward raw output.
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      if (expired || overflow || (code !== 0 && !allowFailure)) throw new Error('CLI 检查失败或超时。')
      return JSON.parse(output)
    } finally {
      clearTimeout(timer)
      if (this.inspector === child) this.inspector = undefined
    }
  }

  rpc(method, params = {}, { version = this.version, timeout = 15000 } = {}) {
    const url = 'ws://127.0.0.1:' + this.port
    return this.cliJSON(version, ['gateway', 'call', method, '--expect-url', url,
      '--params', JSON.stringify(params), '--json', '--timeout', String(timeout)], { timeout: timeout + 5000 })
  }

  snapshots() {
    const records = readJSON(this.snapshotsFile) ?? []
    return fs.readdirSync(this.data).filter(snapshotName).flatMap(name => {
      if (!fs.lstatSync(path.join(this.data, name)).isDirectory()) return []
      const saved = records.find(item => item.name === name)
      return [{ name, ...saved, verified: Boolean(saved?.sha256), rollbackAvailable: Boolean(saved?.sha256 && validVersion(saved.version)) }]
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  rollbackPoint() {
    try {
      const name = readJSON(this.activeFile)?.snapshot
      if (!snapshotName(name)) return null
      const saved = (readJSON(this.snapshotsFile) ?? []).find(item => item.name === name)
      if (!saved || !validVersion(saved.version) || saved.version === this.version || !/^[a-f0-9]{64}$/.test(saved.sha256)) return null
      if (!fs.lstatSync(path.join(this.data, name)).isDirectory()) return null
      return { name, version: saved.version, bytes: saved.bytes }
    } catch { return null }
  }

  async checkUpstream() {
    await this.upstream.check()
    return this.upstreamStatus()
  }

  upstreamStatus() {
    if (!this.upstream.cached) return null
    const comparison = compareVersions(this.upstream.cached.latest, this.version)
    return { ...this.upstream.cached, current: this.version, comparison, updateAvailable: comparison === 1 }
  }

  async recordSnapshot(name, version, verification) {
    const records = readJSON(this.snapshotsFile) ?? []
    records.push({ name, version, createdAt: Date.now(), ...verification })
    saveJSON(this.snapshotsFile, records)
  }

  pruneSnapshots() {
    // Only newly verified snapshots are managed. Preserve legacy/unregistered data.
    const protectedNames = new Set([readJSON(this.activeFile)?.snapshot, readJSON(this.transactionFile)?.snapshot])
    const records = readJSON(this.snapshotsFile) ?? []
    for (const item of records) {
      if (protectedNames.has(item.name) || !snapshotName(item.name)) continue
      const target = path.join(this.data, item.name)
      if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target, { recursive: true })
    }
    saveJSON(this.snapshotsFile, records.filter(item => fs.existsSync(path.join(this.data, item.name))))
  }

  recoverUpdate() {
    const journal = readJSON(this.transactionFile)
    if (!journal) return
    if (!/^snapshot-[0-9a-f]{16}$/.test(journal.snapshot)) throw new Error('升级恢复记录无效。')
    const snapshot = path.join(this.data, journal.snapshot)
    if (this.version !== journal.target && fs.existsSync(snapshot)) {
      if (fs.existsSync(this.stateDir)) fs.renameSync(this.stateDir, path.join(this.data, 'failed-' + randomBytes(8).toString('hex')))
      fs.renameSync(snapshot, this.stateDir)
      this.log('已恢复升级前的 OpenClaw 数据。')
    }
    fs.unlinkSync(this.transactionFile)
  }

  log(value) {
    const safe = String(value).replaceAll(this.token, '[redacted]')
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 4 * 1024 * 1024) {
        if (fs.existsSync(this.logFile + '.1')) fs.unlinkSync(this.logFile + '.1')
        fs.renameSync(this.logFile, this.logFile + '.1')
      }
      fs.appendFileSync(this.logFile, safe.endsWith('\n') ? safe : safe + '\n', { mode: 0o600 })
    } catch (error) {
      console.error('OpenClaw log write:', error.code)
    }
  }

  tail() {
    let fd
    try {
      fd = fs.openSync(this.logFile, 'r')
      const size = fs.fstatSync(fd).size
      const buffer = Buffer.alloc(Math.min(size, 65536))
      const read = fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length)
      return buffer.subarray(0, read).toString('utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return ''
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }

  status() {
    return {
      phase: this.phase, version: this.version, generation: this.generation, busy: Boolean(this.job),
      paused: this.paused, failure: this.failure, retryAt: this.retryAt ?? null,
      retryExhausted: this.phase === 'failed' && !this.paused && this.retryCount >= RETRY_DELAYS.length,
      available: this.available, maintenance: this.maintenance ?? null,
      frameworkVersion: this.frameworkVersion, rollback: this.rollbackPoint(),
      upstream: this.upstreamStatus(),
    }
  }

  setPaused(paused) {
    if (this.paused === paused) return
    if (paused) fs.writeFileSync(this.pauseFile, '', { mode: 0o600 })
    else fs.rmSync(this.pauseFile, { force: true })
    this.paused = paused
  }

  cancelRecovery() {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.retryAt = undefined
  }

  scheduleRecovery() {
    if (this.closing || this.paused || this.job || this.phase !== 'failed') return
    const wait = RETRY_DELAYS[this.retryCount]
    if (wait === undefined) {
      this.log('自动恢复已停止，连续重试 ' + RETRY_DELAYS.length + ' 次未能稳定运行。请查看日志，修复后可手动启动。')
      return
    }
    this.phase = 'retrying'
    this.retryAt = Date.now() + wait
    this.log('将在 ' + wait / 1000 + ' 秒后自动恢复 Gateway（第 ' + (this.retryCount + 1) + ' 次）。')
    this.retryTimer = setTimeout(() => {
      this.cancelRecovery()
      this.retryCount += 1
      this.action('recover')
    }, wait)
  }

  recordFailure(message) {
    this.phase = 'failed'
    this.failure = String(message).replaceAll(this.token, '[redacted]')
    this.log(this.failure)
  }

  run(args, env = this.env) {
    const child = spawn(process.execPath, args, {
      env,
      cwd: this.env.HOME,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      let pending = ''
      stream.on('data', chunk => {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop()
        if (lines.length) this.log(lines.join('\n'))
        if (pending.length > 16384) { this.log(pending); pending = '' }
      })
      stream.on('end', () => { if (pending) this.log(pending) })
    }
    child.finished = new Promise(resolve => {
      child.once('error', error => this.log(error.message))
      child.once('close', (code, signal) => {
        resolve({ code, signal })
      })
    })
    child.exited = new Promise(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', error => resolve({ error }))
    })
    return child
  }

  async install(version) {
    const dir = path.join(this.runtimes, version)
    const module = path.join(dir, 'node_modules', 'openclaw')
    const entry = this.gatewayEntry(version)
    if (fs.existsSync(path.join(dir, 'installed')) && readJSON(path.join(module, 'package.json'))?.version === version && fs.existsSync(entry)) return entry
    if (!this.gateway) this.phase = 'installing'
    this.log('正在下载 OpenClaw ' + version + '，首次安装可能需要几分钟。')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const installEnv = { ...this.env }
    delete installEnv.OPENCLAW_GATEWAY_TOKEN
    const child = this.run([this.npm, 'install', '--prefix', dir, '--cache', path.join(this.data, 'npm-cache'),
      '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--save-exact', 'openclaw@' + version], installEnv)
    this.installer = child
    const result = await child.finished
    this.installer = undefined
    if (result.code !== 0 || readJSON(path.join(module, 'package.json'))?.version !== version || !fs.existsSync(entry)) {
      throw new Error('OpenClaw 下载或安装失败。可在日志中查看详情。')
    }
    fs.writeFileSync(path.join(dir, 'installed'), version)
    return entry
  }

  gatewayEntry(version) {
    return path.join(this.runtimes, version, 'node_modules', 'openclaw', 'openclaw.mjs')
  }

  ownedGateways(version) {
    if (process.platform !== 'linux') return []
    const owner = readJSON(this.ownerFile)
    if (!owner) return []
    if (!validVersion(owner.version) || !/^[a-f0-9]{32}$/.test(owner.instance)) throw new Error('Gateway 归属记录无效。')
    if (version && owner.version !== version) return []
    return findGatewayProcesses(this.gatewayEntry(owner.version), this.env, owner.instance)
  }

  watchGateway(gateway) {
    this.gateway = gateway
    gateway.exited.then(({ code, signal, error }) => {
      if (this.gateway !== gateway || this.phase === 'stopping' || this.closing) return
      if (this.phase === 'running' && performance.now() - this.readySince >= STABLE_UPTIME) this.retryCount = 0
      const reason = signal ?? code
      this.recordFailure(error?.message ?? 'OpenClaw Gateway 已退出' + (reason == null ? '。' : '（' + reason + '）。'))
      this.scheduleRecovery()
    })
  }

  markRunning() {
    this.phase = 'running'
    this.failure = ''
    this.readySince = performance.now()
    this.generation += 1
    if (this.maintenance?.blockIngress && !this.switchingUpdate) {
      this.finishMaintenance({
        blockIngress: false,
        stage: this.maintenance.target === this.version ? 'complete' : 'rolled-back',
        message: '当前版本已恢复就绪，入口已重新开放。',
      })
    }
    this.log('OpenClaw 已就绪。')
  }

  async gatewayReady({ verifyCore = false } = {}) {
    const base = 'http://127.0.0.1:' + this.port
    const probe = route => fetch(base + route, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(1500), redirect: 'manual',
    })
    try {
      const startup = await probe('/startupz')
      // Older cores can return a 404 or their HTML fallback for this route.
      const legacy = startup.status === 404 ||
        (startup.ok && startup.headers.get('content-type')?.startsWith('text/html'))
      if (legacy || !startup.ok) {
        await startup.body?.cancel()
        if (!legacy) return false
      } else if ((await startup.json())?.status !== 'started') {
        return false
      }
      if (legacy || verifyCore) {
        const ready = await probe('/readyz')
        if (!ready.ok && (legacy || ready.status !== 503)) {
          await ready.body?.cancel()
          return false
        }
        const health = await ready.json()
        // A candidate with a working core can be activated even if a channel is offline.
        if (ready.ok ? health?.ready !== true : health?.ready !== false || health?.coreReady !== true) return false
      }
      const ui = await fetch(base + UI_PATH + '/', { signal: AbortSignal.timeout(3000), redirect: 'manual' })
      return ui.ok && (await ui.text()).includes('<openclaw-app')
    } catch { return false }
  }

  async adoptGateway() {
    const deadline = Date.now() + 120000
    while (!this.closing) {
      const owners = this.ownedGateways(this.version)
      if (!owners.length) return false
      this.phase = 'starting'
      const owner = owners.find(candidate => ownsGatewayListener(candidate, this.port))
      if (owner && await this.gatewayReady() && !this.closing && ownsGatewayListener(owner, this.port)) {
        const exited = new Promise(resolve => {
          const timer = setInterval(() => {
            if (isSameProcess(owner)) return
            clearInterval(timer)
            resolve({})
          }, 500)
          timer.unref()
        })
        this.watchGateway({ ...owner, adopted: true, exited })
        this.log('已接管本实例的 Gateway（PID ' + owner.pid + '）。')
        this.markRunning()
        return true
      }
      if (Date.now() >= deadline) throw new Error('已找到本实例的 Gateway，但未能确认它已就绪。')
      await delay(500)
    }
    return false
  }

  async assertPortFree() {
    for (const host of ['127.0.0.1', '::1']) {
      const probe = net.createServer()
      try {
        await new Promise((resolve, reject) => {
          probe.once('error', reject)
          probe.listen(this.port, host, () => probe.close(resolve))
        })
      } catch (error) {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) continue
        if (error.code === 'EADDRINUSE') throw new Error('Gateway 端口 ' + this.port + ' 已被占用（' + host + '）。')
        throw error
      }
    }
  }

  async startCore(version = this.version, entry, { verifyCore = false } = {}) {
    entry ??= await this.install(version)
    if (this.closing) return
    this.phase = 'starting'
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(this.env.OPENCLAW_CONFIG_PATH)) {
      saveJSON(this.env.OPENCLAW_CONFIG_PATH, {
        gateway: {
          mode: 'local', bind: 'loopback', port: this.port,
          auth: { mode: 'token' },
          controlUi: { basePath: UI_PATH, allowedOrigins: ['http://127.0.0.1:' + this.port], experimental: { customPlugins: false } },
        },
      })
    }
    // Fail if someone else already owns this port, rather than proxying to them.
    await this.assertPortFree()
    if (this.closing) return
    if (!fs.existsSync(this.activeFile)) saveJSON(this.activeFile, { version })
    const instance = randomBytes(16).toString('hex')
    saveJSON(this.ownerFile, { version, instance })
    this.log('启动 OpenClaw ' + version + '。')
    const child = this.run([entry, 'gateway', 'run', '--port', String(this.port), '--bind', 'loopback', '--auth', 'token'], {
      ...this.env,
      OPENCLAW_SUPERVISOR_MODE: 'external',
      [INSTANCE_ENV]: instance,
    })
    this.watchGateway(child)
    const deadline = Date.now() + 120000
    while (Date.now() < deadline && this.phase === 'starting' && !this.closing) {
      if (await this.gatewayReady({ verifyCore }) && this.phase === 'starting' && !this.closing &&
          (process.platform !== 'linux' || this.ownedGateways(version).some(owner => ownsGatewayListener(owner, this.port)))) {
        this.markRunning()
        return
      }
      await delay(500)
    }
    if (!this.closing) throw new Error(this.phase === 'failed' ? this.failure : 'OpenClaw 或 Control UI 启动超时。请核对网关配置。')
  }

  async stopChild(child) {
    if (!child?.pid) return
    const exited = () => (child.exitCode !== null || child.signalCode !== null) && !groupHasLiveProcess(child.pid)
    const send = signal => {
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await stopProcess(exited, send)
  }

  async stopCore() {
    this.phase = 'stopping'
    if (this.gateway && !this.gateway.adopted) await this.stopChild(this.gateway)
    const owners = this.ownedGateways()
    for (const owner of owners) {
      // A detached successor may outlive the child the shell originally started.
      const group = owner.group > 1 && owner.group === owner.session && owner.group !== process.pid ? owner.group : 0
      const exited = () => !isSameProcess(owner) && (!group || !groupHasLiveProcess(group))
      await stopProcess(exited, signal => {
        if (!isSameProcess(owner)) return
        try { process.kill(group ? -group : owner.pid, signal) }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      })
    }
    if (this.ownedGateways().length) throw new Error('仍有本实例的 Gateway 进程正在运行。')
    if (this.gateway || owners.length) this.log('OpenClaw Gateway 进程已退出。')
    this.gateway = undefined
    this.phase = 'stopped'
  }

  async update(target, { force = false, restore, allowOffline = false } = {}) {
    if (!validVersion(target)) throw new Error('版本格式无效。')
    if (target === this.version) throw new Error('已是指定版本。')
    this.cancelUpdate = false
    this.maintenance = undefined
    this.updateProgress({ stage: 'downloading', target, force, message: '正在准备目标版本。', blockIngress: false })
    // Install the candidate before taking the live state offline.
    let entry
    try {
      if (restore) {
        if (!snapshotName(restore.name) || restore.version !== target || !restore.sha256) throw new Error('回退快照记录无效。')
        const actual = await inspectTree(path.join(this.data, restore.name))
        if (actual.sha256 !== restore.sha256) throw new Error('快照校验未通过，已取消回退。')
      }
      entry = await this.install(target)
    }
    catch (error) {
      this.updateProgress({ stage: 'failed', message: error.message })
      if (this.phase === 'running') { this.log(error.message); return }
      throw error
    }
    if (this.closing) return
    if (this.cancelUpdate) {
      this.updateProgress({ stage: 'deferred', message: '已取消更新，当前版本继续运行。' })
      return
    }
    if (!(allowOffline && restore && this.phase !== 'running') && !await prepareUpgrade(this, { force })) return
    const previous = this.version
    this.switchingUpdate = true
    try {
      if (allowOffline && restore) this.setPaused(false)
      this.updateProgress({ stage: 'snapshot', message: '正在备份并校验数据。', blockIngress: true })
      await this.stopCore()
      await this.assertPortFree()
      if (this.closing) return
      this.recoverUpdate()
      const snapshot = 'snapshot-' + randomBytes(8).toString('hex')
      const backup = path.join(this.data, snapshot)
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      saveJSON(this.transactionFile, { target, previous, snapshot })
      fs.renameSync(this.stateDir, backup)
      const verified = await inspectTree(backup)
      const source = restore ? path.join(this.data, restore.name) : backup
      await fs.promises.cp(source, this.stateDir, { recursive: true, verbatimSymlinks: true })
      const copied = await inspectTree(this.stateDir)
      if (copied.sha256 !== (restore?.sha256 ?? verified.sha256)) throw new Error('数据副本校验失败。')
      await this.recordSnapshot(snapshot, previous, verified)
      this.updateProgress({ stage: 'starting', snapshot, bytes: verified.bytes, verified: true, message: '正在启动并验收目标版本。' })
      await this.startCore(target, entry, { verifyCore: true })
      if (this.phase !== 'running') throw new Error('候选版本未完成启动。')
      const audit = await auditUpgrade(this, target)
      saveJSON(this.activeFile, { version: target, previous, snapshot })
      // After active.json commits, recovery must never restore the predecessor.
      this.version = target
      this.updateProgress({ stage: 'complete', audit, blockIngress: false, message: '已完成切换和验收。' })
    } catch (error) {
      if (this.version === target) {
        this.log('版本已提交，保存验收报告失败：' + error.message)
        if (this.phase === 'running' && await this.gatewayReady()) {
          this.finishMaintenance({ stage: 'complete', blockIngress: false, message: '版本已切换并就绪，保存验收报告时发生错误。' })
          return
        }
        this.finishMaintenance({ stage: 'failed', blockIngress: true, message: '版本已提交，但网关尚未恢复就绪。' })
        throw error
      }
      this.log(error.message)
      try {
        await this.stopCore()
        await this.assertPortFree()
        this.recoverUpdate()
        if (!this.closing) await this.startCore(previous)
        if (this.phase === 'running' && !this.closing) {
          this.finishMaintenance({ stage: 'rolled-back', blockIngress: false, message: '切换失败，已恢复旧版。' + error.message })
        }
      } catch (recoveryError) {
        this.finishMaintenance({ stage: 'failed', blockIngress: true, message: '切换失败，旧版尚未恢复就绪。' + recoveryError.message })
        throw new Error(error.message + ' 恢复失败：' + recoveryError.message)
      }
      return
    } finally {
      this.switchingUpdate = false
    }
    this.log('已切换到 OpenClaw ' + target + '。')
    // The version switch is committed. Cleanup errors must never start the old runtime on the new state.
    try { fs.unlinkSync(this.transactionFile) }
    catch (error) { this.log('升级已提交，暂未清理恢复记录。' + error.message) }
    try { this.pruneSnapshots() }
    catch (error) { this.log('暂未清理旧快照：' + error.message) }
  }

  action(action, version, options) {
    if (this.job || this.closing || (this.paused && ['boot', 'recover', 'update'].includes(action))) return false
    if (action === 'start' && this.phase === 'running') return true
    if (action === 'stop') this.setPaused(true)
    if (action === 'start' || action === 'restart') this.setPaused(false)
    this.cancelRecovery()
    if (['start', 'stop', 'restart', 'rollback'].includes(action)) this.retryCount = 0
    this.job = Promise.resolve().then(async () => {
      if (action === 'update') return this.update(version, options)
      if (action === 'rollback') {
        if (!options?.restore) throw new Error('请选择已校验的回滚快照。')
        return this.update(version, { ...options, allowOffline: true })
      }
      const interrupted = fs.existsSync(this.transactionFile)
      if (!interrupted && !['stop', 'restart'].includes(action) && await this.adoptGateway()) return
      if (action === 'stop' || action === 'restart' || interrupted || this.gateway) await this.stopCore()
      if (action === 'stop') {
        this.phase = 'stopping'
        await this.assertPortFree()
        this.recoverUpdate()
        this.phase = 'stopped'
        this.failure = ''
        this.log('Gateway 已停止，端口已释放。自动恢复已暂停。')
      } else if (!this.closing) {
        if (interrupted) {
          await this.assertPortFree()
          this.recoverUpdate()
        }
        await this.startCore()
      }
    }).catch(async error => {
      let message = error.message
      if (action !== 'stop' && this.gateway) {
        try { await this.stopCore() }
        catch (cleanupError) { message += ' ' + cleanupError.message }
      }
      this.recordFailure(message)
    }).finally(() => {
      this.job = undefined
      this.scheduleRecovery()
    })
    return true
  }

  async close() {
    this.closing = true
    this.cancelRecovery()
    await this.stopChild(this.installer)
    await this.stopChild(this.inspector)
    await this.job
    await this.stopCore()
  }
}
