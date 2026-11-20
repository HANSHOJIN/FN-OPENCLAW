import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { CORE_PORT, CORE_VERSION, UI_PATH } from './defaults.mjs'
import { INSTANCE_ENV, findGatewayProcesses, isSameProcess, ownsGatewayListener } from './gateway-process.mjs'
import { inspectTree, prepareUpgrade, auditUpgrade, snapshotName } from './maintenance.mjs'
import { validVersion, frameworkVersion, compareVersions, UpstreamVersions } from './versions.mjs'
import { preservedStatePaths, normalizePreserved, cloneRuntimeState, movePreservedState } from './state-snapshot.mjs'
import { FRAMEWORK_MESSAGE, inspectOfficialUpdate } from './official-update.mjs'
import { kernelConfigHash, preflightKernelDatabases, verifyLocalDatabaseConfig } from './kernel-compatibility.mjs'

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
  constructor({ data, config, home, npm, ca, updatePlugin, port = CORE_PORT }) {
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
    this.frameworkRequestFile = path.join(data, 'framework-update.json')
    this.frameworkAttemptFile = path.join(data, 'framework-update-attempt.json')
    this.paused = fs.existsSync(this.pauseFile)
    this.npm = npm
    this.updatePlugin = updatePlugin
    this.phase = 'stopped'
    this.generation = 0
    this.retryCount = 0
    this.failure = ''
    this.frameworkVersion = frameworkVersion()
    this.upstream = new UpstreamVersions()
    for (const dir of [data, config, home, this.runtimes]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'linux') continue
      // fnOS creates application-owned roots as 0770. Newer cores reject
      // writable temp ancestors. Tighten only these owned private roots;
      // retain read/search bits and never recurse into workspace/share data.
      const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try {
        const info = fs.fstatSync(fd)
        if (info.uid === process.getuid() && (info.mode & 0o022)) fs.fchmodSync(fd, info.mode & 0o7755)
      } finally { fs.closeSync(fd) }
    }
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

  // Existing clients can drain their work before maintenance stops the Gateway.
  get chatBlocked() { return Boolean(this.preparingFrameworkUpgrade || this.maintenanceAction) }

  cancelMaintenance() {
    this.cancelUpdate = true
    if (this.inspector && ['checking', 'preflighting'].includes(this.maintenance?.stage)) {
      void this.stopChild(this.inspector).catch(() => {})
    }
    if (!this.job && this.preparedKernel) {
      this.preparedKernel = undefined
      this.finishMaintenance({ stage: 'deferred', message: '已取消更新，当前版本继续运行。' })
    }
  }

  updateProgress(value) {
    const now = Date.now()
    this.maintenance = { startedAt: now, ...this.maintenance, ...value, updatedAt: now }
    if (value.stage) {
      if (['complete', 'deferred', 'failed', 'rolled-back'].includes(value.stage)) this.maintenance.finishedAt = now
      else delete this.maintenance.finishedAt
    }
    saveJSON(this.updateStatusFile, this.maintenance)
  }

  finishMaintenance(value) {
    // A status-file failure must not undo a verified recovery. updateProgress
    // updates memory first, so the serving decision still reflects that recovery.
    try { this.updateProgress(value) }
    catch (error) { this.log('无法保存维护结果：' + error.message) }
  }

  async cliJSON(version, args, { timeout = 15000, allowFailure = false, env = {} } = {}) {
    const child = spawn(process.execPath, [this.gatewayEntry(version), ...args], {
      env: { ...this.env, ...env, OPENCLAW_SUPERVISOR_MODE: 'external' }, cwd: env.HOME ?? this.env.HOME,
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
      if (journal.format === 2) {
        if (journal.failed && !/^failed-[0-9a-f]{16}$/.test(journal.failed)) throw new Error('升级恢复目录记录无效。')
        const failed = path.join(this.data, journal.failed ?? 'failed-' + randomBytes(8).toString('hex'))
        // Persist the staging location before renaming anything, so an app or
        // machine restart can finish putting the same user files back.
        journal.failed = path.basename(failed)
        journal.preserved = normalizePreserved([
          ...normalizePreserved(journal.preserved),
          ...preservedStatePaths(snapshot), ...preservedStatePaths(this.stateDir), ...preservedStatePaths(failed),
        ])
        saveJSON(this.transactionFile, journal)
        if (fs.existsSync(this.stateDir)) {
          if (fs.existsSync(failed)) throw new Error('升级恢复目录冲突，已保留全部数据。')
          fs.renameSync(this.stateDir, failed)
        }
        movePreservedState(failed, snapshot, journal.preserved)
      } else if (fs.existsSync(this.stateDir)) {
        fs.renameSync(this.stateDir, path.join(this.data, 'failed-' + randomBytes(8).toString('hex')))
      }
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
      available: this.available, chatBlocked: this.chatBlocked,
      maintenance: this.preparingFrameworkUpgrade ?? this.maintenance ?? null,
      preparedKernel: this.preparedKernel ? { id: this.preparedKernel.id, target: this.preparedKernel.target } : null,
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

  async install(version, { engineStrict = false } = {}) {
    const dir = path.join(this.runtimes, version)
    const module = path.join(dir, 'node_modules', 'openclaw')
    const entry = this.gatewayEntry(version)
    const installed = () => {
      const manifest = readJSON(path.join(module, 'package.json'))
      if (manifest?.version !== version || !fs.existsSync(entry)) return false
      if (engineStrict && this.npm && (typeof manifest.engines?.node !== 'string' ||
          !createRequire(this.npm)('semver').satisfies(process.version, manifest.engines.node))) {
        throw new Error('框架的 Node.js 无法满足候选内核要求。' + FRAMEWORK_MESSAGE)
      }
      return true
    }
    if (fs.existsSync(path.join(dir, 'installed')) && installed()) return entry
    if (!this.gateway) this.phase = 'installing'
    this.log('正在下载 OpenClaw ' + version + '，首次安装可能需要几分钟。')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const installEnv = { ...this.env }
    delete installEnv.OPENCLAW_GATEWAY_TOKEN
    const child = this.run([this.npm, 'install', '--prefix', dir, '--cache', path.join(this.data, 'npm-cache'),
      '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--save-exact',
      ...(engineStrict ? ['--engine-strict'] : []), 'openclaw@' + version], installEnv)
    this.installer = child
    const result = await child.finished
    this.installer = undefined
    if (result.code !== 0 || !installed()) {
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
        message: '已恢复至 OpenClaw ' + this.version + '，当前服务正常。',
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

  async linkUpdateCommand(version) {
    if (!this.updatePlugin || compareVersions(version, '2026.11.6') < 0) return
    const marker = path.join(this.stateDir, '.fn-update-linked')
    if (fs.existsSync(marker) || this.attemptedUpdateCommand) return
    this.attemptedUpdateCommand = true
    // The CLI requires explicit consent for local sources. Only link the FPK's
    // own fixed plugin directory; registry/install-policy blocks still apply.
    const child = this.run([this.gatewayEntry(version), 'plugins', 'install', '--link', '--force',
      '--acknowledge-install-policy-warning', '--accept-capabilities', this.updatePlugin], {
      ...this.env, OPENCLAW_SUPERVISOR_MODE: 'external',
    })
    this.inspector = child
    const timer = setTimeout(() => { void this.stopChild(child).catch(() => {}) }, 60000)
    try {
      const result = await child.finished
      if (result.code === 0) fs.writeFileSync(marker, '', { mode: 0o600 })
      else this.log('未能注册 /fn_update，查看日志中的插件安装信息。')
    } catch (error) {
      this.log('未能登记 /fn_update：' + error.message)
    } finally {
      clearTimeout(timer)
      if (this.inspector === child) this.inspector = undefined
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
    // Link once on a normal boot. A candidate launch must not rewrite config.
    if (!verifyCore) await this.linkUpdateCommand(version)
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

  async update(target) {
    this.cancelUpdate = false
    this.preparedKernel = undefined
    this.maintenance = undefined
    this.updateProgress({ stage: 'checking', target, blockIngress: false, message: '正在检查正式版及更新条件。' })
    try {
      const upstream = await this.checkUpstream()
      target ??= upstream.latest
      if (!validVersion(target) || target !== upstream.latest) {
        throw new Error('请选择上游当前的正式版本。')
      }
      if (compareVersions(target, this.version) !== 1) {
        this.finishMaintenance({ stage: 'deferred', target, message: '当前内核已是最新版本或高于上游正式版。' })
        return
      }
      this.updateProgress({ target })
      const check = await inspectOfficialUpdate(this, target).catch(() => {
        throw new Error('官方升级检查未完成，请稍后重试。')
      })
      this.updateProgress({ check })
      if (check.migrationRequired || !['unmanaged-package-install', 'external-supervisor-update-required'].includes(check.code)) {
        throw new Error(check.message)
      }
      if (this.cancelUpdate || this.closing) throw new Error('已取消更新，当前版本继续运行。')
      const configHash = kernelConfigHash(this)
      verifyLocalDatabaseConfig((await this.rpc('config.get')).config)
      if (kernelConfigHash(this) !== configHash) throw new Error('配置在检查期间已变更，请重新检查。')
      this.updateProgress({ stage: 'downloading', previous: this.version, message: '正在准备候选内核。' })
      const entry = await this.install(target, { engineStrict: true })
      this.updateProgress({ stage: 'preflighting', message: '候选内核正在验证数据库副本。' })
      const agents = await preflightKernelDatabases(this, target)
      if (!this.available || kernelConfigHash(this) !== configHash) throw new Error('服务或配置已变更，请重新检查。')
      const prepared = { id: randomBytes(16).toString('hex'), target, previous: this.version, configHash, entry }
      this.updateProgress({ stage: 'awaiting-confirmation', agents, message: '兼容性检查通过，请在控制台确认切换。' })
      this.preparedKernel = prepared
    } catch (error) {
      const message = this.cancelUpdate || this.closing ? '已取消更新，当前版本继续运行。' : error.message
      this.finishMaintenance({ stage: 'deferred', blockIngress: false, message })
      this.log(message)
    }
  }

  async activateKernel(prepared, { force = false } = {}) {
    try {
      if (!this.available || kernelConfigHash(this) !== prepared.configHash) {
        throw new Error('服务或配置已变更，请重新检查。')
      }
    } catch (error) {
      this.finishMaintenance({ stage: 'deferred', message: error.message })
      return
    }
    await this.switchRuntime(prepared.target, { force, prepared })
  }

  frameworkUpgradePolicy() {
    const request = readJSON(this.frameworkRequestFile)
    if (!request) return
    const policy = readJSON(new URL('../framework-upgrade.json', import.meta.url))
    if (!policy || policy.framework !== this.frameworkVersion || policy.target !== CORE_VERSION ||
        request.framework !== policy.framework || request.target !== policy.target || !Array.isArray(policy.from)) {
      throw new Error('安装包的内核适配记录不匹配，当前版本继续运行。')
    }
    return policy
  }

  async applyFrameworkUpgrade() {
    if (this.paused || this.phase !== 'running' || this.closing) return
    let policy
    try {
      policy = this.frameworkUpgradePolicy()
      if (!policy) return
      // Consume before doing work: interrupted or failed package handoffs must
      // not repeatedly migrate state at every subsequent service restart.
      fs.renameSync(this.frameworkRequestFile, this.frameworkAttemptFile)
    } catch (error) {
      this.log(error.message)
      return
    }
    const previous = this.version
    const record = outcome => {
      try { saveJSON(this.frameworkAttemptFile, { framework: policy.framework, target: policy.target,
        previous, current: this.version, outcome, updatedAt: Date.now() }) }
      catch (error) { this.log('无法保存框架适配结果：' + error.message) }
    }
    if (this.version === policy.target) { record('already-current'); return }
    if (!policy.from.includes(this.version)) {
      this.finishMaintenance({ stage: 'deferred', target: policy.target, blockIngress: false,
        message: '本安装包尚未验证当前内核的迁移路径，请等待对应的 FN-OPENCLAW 框架安装包。' })
      record('unsupported-source')
      return
    }
    this.log('正在应用框架安装包的 OpenClaw ' + policy.target + ' 适配。')
    record('starting')
    const startedAt = this.preparingFrameworkUpgrade?.startedAt
    this.maintenanceAction = true
    this.preparingFrameworkUpgrade = undefined
    try {
      await this.switchRuntime(policy.target, { doctorFix: policy.doctorFix === true, startedAt, registerUpdateCommand: true })
      record(this.version === policy.target && this.available ? 'complete' : 'not-applied')
    } catch (error) {
      record('failed')
      throw error
    }
  }

  // Doctor can spend a long time archiving and migrating a large NAS profile.
  // Only its exit status or an explicit cancellation may end this step.
  async repairCore(version) {
    if (!this.switchingUpdate || this.phase !== 'stopped' || this.gateway) {
      throw new Error('Doctor 修复需要已停止的安装包维护窗口。')
    }
    if (this.cancelUpdate || this.closing) throw new Error('Doctor 数据库适配已取消。')
    await this.assertPortFree()
    this.updateProgress({ stage: 'doctor', doctorStartedAt: Date.now(), doctorStep: '启动官方 Doctor', message: '正在适配会话数据库。' })
    this.log('正在使用 OpenClaw ' + version + ' 的 Doctor 适配已备份的运行数据。')
    this.log('Doctor 不设总时长上限，进度见后续输出；取消升级或停用应用会中止适配并恢复旧版。')
    const child = this.run([this.gatewayEntry(version), 'doctor', '--fix', '--non-interactive', '--yes'], {
      ...this.env, OPENCLAW_SUPERVISOR_MODE: 'external',
    })
    this.inspector = child
    const names = {
      startup: '启动官方 Doctor', 'archive preparation': '准备修复前归档',
      'maintenance begin': '取得数据库维护权限', 'Preserve original state': '保留修复前数据库',
    }
    const listeners = [child.stdout, child.stderr].map(stream => {
      let pending = ''
      const receive = chunk => {
        pending += chunk
        const lines = pending.split('\n');pending = lines.pop().slice(-1024)
        for (const raw of lines) {
          const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
          const match = /^Doctor:\s+(.+)$/.exec(line)
          // The upstream elapsed-time heartbeat is not a new maintenance step.
          if (!match || /\(\d+s elapsed\)$/.test(match[1])) continue
          const step = names[match[1]] || match[1].slice(0, 120)
          if (this.maintenance?.stage === 'doctor' && this.maintenance.doctorStep !== step) {
            this.finishMaintenance({ doctorStep: step })
          }
        }
      }
      stream.on('data', receive)
      return () => stream.off('data', receive)
    })
    let cancelled = false
    const timer = setInterval(() => {
      if (!this.cancelUpdate || cancelled) return
      cancelled = true
      this.finishMaintenance({ stage: 'canceling', message: '正在停止官方 Doctor，随后恢复旧版。' })
      void this.stopChild(child).catch(() => {})
    }, 250)
    try {
      const result = await child.finished
      if (cancelled || this.cancelUpdate || this.closing) throw new Error('Doctor 数据库适配已取消。')
      if (result.code !== 0) throw new Error('Doctor 数据库适配失败，请查看运行日志。')
    } finally {
      clearInterval(timer)
      listeners.forEach(dispose => dispose())
      if (this.inspector === child) this.inspector = undefined
    }
  }

  async switchRuntime(target, { force = false, restore, allowOffline = false, doctorFix = false,
    startedAt = Date.now(), prepared, registerUpdateCommand = false } = {}) {
    if (!validVersion(target)) throw new Error('版本格式无效。')
    if (target === this.version) throw new Error('已是指定版本。')
    this.cancelUpdate = false
    this.maintenance = undefined
    this.updateProgress({ stage: 'downloading', target, previous: this.version, startedAt, force,
      message: '正在准备目标版本。', blockIngress: false })
    // Install the candidate before taking the live state offline.
    let entry
    try {
      if (restore) {
        if (!snapshotName(restore.name) || restore.version !== target || !restore.sha256) throw new Error('回退快照记录无效。')
        const actual = await inspectTree(path.join(this.data, restore.name))
        if (actual.sha256 !== restore.sha256) throw new Error('快照校验未通过，已取消回退。')
      }
      entry = prepared?.entry ?? await this.install(target)
    }
    catch (error) {
      this.updateProgress({ stage: 'failed', message: error.message, reason: error.message })
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
      if (prepared) {
        if (kernelConfigHash(this) !== prepared.configHash) throw new Error('配置已变更，请重新检查。')
        this.updateProgress({ stage: 'preflighting', message: '停机后正在核对最新数据库副本。' })
        await preflightKernelDatabases(this, target)
        if (kernelConfigHash(this) !== prepared.configHash) throw new Error('配置已变更，请重新检查。')
        this.updateProgress({ stage: 'snapshot', message: '正在创建并校验回滚快照。' })
      }
      const snapshot = 'snapshot-' + randomBytes(8).toString('hex')
      const backup = path.join(this.data, snapshot)
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const source = restore ? path.join(this.data, restore.name) : backup
      const preserved = normalizePreserved([
        ...preservedStatePaths(this.stateDir),
        ...(restore ? preservedStatePaths(source) : []),
      ])
      saveJSON(this.transactionFile, { format: 2, target, previous, snapshot, preserved })
      fs.renameSync(this.stateDir, backup)
      const verified = await inspectTree(backup, { exclude: preserved })
      const expected = restore ? await inspectTree(source, { exclude: preserved }) : verified
      await cloneRuntimeState(source, this.stateDir, preserved)
      const copied = await inspectTree(this.stateDir)
      if (copied.sha256 !== expected.sha256) throw new Error('数据副本校验失败。')
      movePreservedState(backup, this.stateDir, preserved)
      await this.recordSnapshot(snapshot, previous, { ...verified, scope: 'runtime-state', preserved })
      if (doctorFix && !restore) {
        this.updateProgress({ snapshot, bytes: verified.bytes, verified: true })
        await this.repairCore(target)
      }
      if (registerUpdateCommand) await this.linkUpdateCommand(target)
      this.updateProgress({ stage: 'starting', snapshot, bytes: verified.bytes, verified: true, message: '正在启动并验收目标版本。' })
      await this.startCore(target, entry, { verifyCore: true })
      if (this.phase !== 'running') throw new Error('候选版本未完成启动。')
      this.updateProgress({ stage: 'verifying', message: '目标版本已启动，正在验收网关和会话库。' })
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
      this.finishMaintenance({ stage: 'recovering', blockIngress: true, reason: error.message,
        message: '正在恢复 OpenClaw ' + previous + '，等待服务重新就绪。' })
      try {
        await this.stopCore()
        await this.assertPortFree()
        this.recoverUpdate()
        if (!this.closing) await this.startCore(previous)
        if (this.phase === 'running' && !this.closing) {
          this.finishMaintenance({ stage: 'rolled-back', blockIngress: false, reason: error.message,
            message: '已恢复至 OpenClaw ' + previous + '，当前服务正常。' })
        }
      } catch (recoveryError) {
        this.finishMaintenance({ stage: 'failed', blockIngress: true, reason: recoveryError.message,
          message: '切换失败，OpenClaw ' + previous + ' 尚未恢复就绪。' })
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
    if (this.job || this.closing || (this.paused && ['boot', 'recover', 'update', 'activate'].includes(action))) return false
    const approval = this.preparedKernel
    if (action === 'activate' && (!approval || approval.id !== options?.approval || approval.previous !== this.version)) return false
    if (action === 'start' && this.phase === 'running') return true
    if (action === 'stop') this.setPaused(true)
    if (action === 'start' || action === 'restart') this.setPaused(false)
    this.cancelRecovery()
    if (['start', 'stop', 'restart', 'rollback'].includes(action)) this.retryCount = 0
    this.maintenanceAction = ['update', 'activate', 'rollback'].includes(action)
    if (this.preparedKernel && action !== 'update') {
      this.preparedKernel = undefined
      if (action !== 'activate') {
        this.finishMaintenance({ stage: 'deferred', message: '检查结果已失效，需要切换版本时请重新检查。' })
      }
    }
    if (action === 'boot' || action === 'start') {
      try {
        const policy = this.frameworkUpgradePolicy()
        if (policy && this.version !== policy.target && policy.from.includes(this.version)) {
          this.preparingFrameworkUpgrade = {
            stage: 'preparing-framework', target: policy.target, previous: this.version, startedAt: Date.now(),
          }
        }
      } catch {
        // Report invalid requests in applyFrameworkUpgrade after the installed core is available.
      }
    }
    this.job = Promise.resolve().then(async () => {
      if (action === 'update') return this.update(version, options)
      if (action === 'activate') return this.activateKernel(approval, options)
      if (action === 'rollback') {
        if (!options?.restore) throw new Error('请选择已校验的回滚快照。')
        return this.switchRuntime(version, { ...options, allowOffline: true })
      }
      const interrupted = fs.existsSync(this.transactionFile)
      if (!interrupted && !['stop', 'restart'].includes(action) && await this.adoptGateway()) {
        if (action === 'boot' || action === 'start') await this.applyFrameworkUpgrade()
        return
      }
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
        if (action === 'boot' || action === 'start') await this.applyFrameworkUpgrade()
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
      this.maintenanceAction = false
      this.preparingFrameworkUpgrade = undefined
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
