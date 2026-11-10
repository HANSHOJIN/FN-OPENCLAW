import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { CORE_PORT, CORE_VERSION, UI_PATH } from './defaults.mjs'
import { INSTANCE_ENV, findGatewayProcesses, isSameProcess, ownsGatewayListener } from './gateway-process.mjs'

const RETRY_DELAYS = [2000, 5000, 15000, 30000]
const STABLE_UPTIME = 60000

export const validVersion = value => /^\d{4}\.\d{1,2}\.\d{1,3}(?:-\d{1,3})?$/.test(value)

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
    this.paused = fs.existsSync(this.pauseFile)
    this.npm = npm
    this.phase = 'stopped'
    this.generation = 0
    this.retryCount = 0
    this.failure = ''
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
    this.version = readJSON(this.activeFile)?.version ?? CORE_VERSION
    if (!validVersion(this.version)) throw new Error('运行版本记录无效。')
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
    this.log('OpenClaw 已就绪。')
  }

  async gatewayReady() {
    const base = 'http://127.0.0.1:' + this.port
    try {
      const ready = await fetch(base + '/readyz', { signal: AbortSignal.timeout(1500), redirect: 'manual' })
      await ready.body?.cancel()
      if (!ready.ok) return false
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

  async startCore(version = this.version, entry) {
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
      if (await this.gatewayReady() && this.phase === 'starting' && !this.closing &&
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
    if (target === this.version) throw new Error('已是指定版本。')
    // Install the candidate before taking the live state offline.
    let entry
    try { entry = await this.install(target) }
    catch (error) {
      if (this.phase === 'running') { this.log(error.message); return }
      throw error
    }
    if (this.closing) return
    await this.stopCore()
    await this.assertPortFree()
    if (this.closing) return
    this.recoverUpdate()
    const snapshot = 'snapshot-' + randomBytes(8).toString('hex')
    const backup = path.join(this.data, snapshot)
    const previous = this.version
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    saveJSON(this.transactionFile, { target, snapshot })
    try {
      fs.renameSync(this.stateDir, backup)
      await fs.promises.cp(backup, this.stateDir, { recursive: true, verbatimSymlinks: true })
      await this.startCore(target, entry)
      if (this.phase !== 'running') throw new Error('候选版本未完成启动。')
      saveJSON(this.activeFile, { version: target, previous, snapshot })
    } catch (error) {
      this.log(error.message)
      await this.stopCore()
      await this.assertPortFree()
      this.recoverUpdate()
      if (!this.closing) await this.startCore(previous)
      return
    }
    this.version = target
    this.log('已切换到 OpenClaw ' + target + '。')
    // The version switch is committed. Cleanup errors must never start the old runtime on the new state.
    try { fs.unlinkSync(this.transactionFile) }
    catch (error) { this.log('升级已提交，暂未清理恢复记录。' + error.message) }
  }

  action(action, version) {
    if (this.job || this.closing || (this.paused && ['boot', 'recover', 'update'].includes(action))) return false
    if (action === 'start' && this.phase === 'running') return true
    if (action === 'stop') this.setPaused(true)
    if (action === 'start' || action === 'restart') this.setPaused(false)
    this.cancelRecovery()
    if (['start', 'stop', 'restart'].includes(action)) this.retryCount = 0
    this.job = Promise.resolve().then(async () => {
      if (action === 'update') return this.update(version)
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
    await this.job
    await this.stopCore()
  }
}
