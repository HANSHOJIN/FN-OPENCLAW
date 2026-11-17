import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Core } from '../openclaw-fnos/app/shell/core.mjs'
import { CORE_VERSION, UI_PATH } from '../openclaw-fnos/app/shell/defaults.mjs'
import { prepareUpgrade, auditUpgrade, inspectTree } from '../openclaw-fnos/app/shell/maintenance.mjs'
import { UpstreamVersions } from '../openclaw-fnos/app/shell/versions.mjs'
import { MIGRATION_MESSAGE, FRAMEWORK_MESSAGE } from '../openclaw-fnos/app/shell/official-update.mjs'

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise(resolve => server.close(resolve))
}

async function fixture(t, { officialUpdates = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-openclaw-test-'))
  const probe = http.createServer()
  const port = await listen(probe)
  await close(probe)
  const options = { data: path.join(root, 'data'), config: path.join(root, 'etc'), home: path.join(root, 'home'), port }
  const core = new Core(options)
  // Existing lifecycle/fault tests explicitly exercise the retained state-switch
  // engine. Public official-update admission has separate tests below.
  if (!officialUpdates) t.mock.method(core, 'update', core.switchRuntime.bind(core))
  const wrappers = [core]
  t.after(async () => {
    for (const wrapper of wrappers.reverse()) {
      if (!wrapper.closing) await wrapper.close()
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    core, port,
    replaceWrapper() {
      const next = new Core(options)
      if (!officialUpdates) t.mock.method(next, 'update', next.switchRuntime.bind(next))
      wrappers.push(next)
      return next
    },
    install(version, mode = 'serve') {
      const dir = path.join(core.runtimes, version)
      const module = path.join(dir, 'node_modules', 'openclaw')
      fs.mkdirSync(module, { recursive: true })
      fs.copyFileSync(new URL('./fixtures/gateway.mjs', import.meta.url), path.join(module, 'openclaw.mjs'))
      fs.writeFileSync(path.join(module, 'package.json'), JSON.stringify({ version }))
      fs.writeFileSync(path.join(module, 'fixture-mode'), mode)
      fs.writeFileSync(path.join(dir, 'installed'), version)
    },
  }
}

async function action(core, name, version) {
  assert.equal(core.action(name, version), true)
  await core.job
}

async function until(core, condition, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (!condition() && Date.now() < deadline) await delay(40)
  assert.ok(condition(), core.tail())
}

test('adopts an owned successor and can stop it after the wrapper restarts', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION, 'channel-offline,successor')
  await action(f.core, 'boot')
  assert.equal(f.core.phase, 'running', f.core.tail())
  const original = f.core.gateway.pid
  const base = 'http://127.0.0.1:' + f.port
  const response = await fetch(base + '/replace')
  assert.equal(await response.text(), 'replacing')
  await until(f.core, () => f.core.phase === 'running' && f.core.generation === 2)
  const successor = f.core.gateway.pid
  assert.notEqual(successor, original)
  assert.equal(Number(await (await fetch(base + '/pid')).text()), successor)
  assert.equal(f.core.gateway.adopted, true)
  assert.equal((f.core.tail().match(/启动 OpenClaw/g) ?? []).length, 1)

  // The earlier wrapper is gone from the lifecycle path, while its Gateway survives.
  f.core.closing = true
  const next = f.replaceWrapper()
  await action(next, 'boot')
  assert.equal(next.gateway.pid, successor)
  assert.equal(next.gateway.adopted, true)
  await action(next, 'stop')
  assert.equal(next.phase, 'stopped')
  assert.equal(next.status().paused, true)
  await next.assertPortFree()
})

test('a foreign ready listener is neither trusted nor stopped', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  let requests = 0
  const stranger = http.createServer((req, res) => {
    requests += 1
    res.end(req.url === '/readyz' ? 'ready' : '<openclaw-app></openclaw-app>')
  })
  await listen(stranger, f.port)
  t.after(() => close(stranger))
  await action(f.core, 'boot')
  assert.equal(f.core.phase, 'retrying')
  assert.match(f.core.failure, /端口 .* 已被占用/)
  assert.equal(requests, 0)
  assert.equal(stranger.listening, true)
  await action(f.core, 'stop')
  assert.equal(f.core.phase, 'failed')
  assert.equal(f.core.status().paused, true)
  assert.equal(stranger.listening, true)
  assert.equal(f.core.status().retryAt, null)
})

test('startup tolerates channel failures while upgrades still check core readiness', async t => {
  const f = await fixture(t)
  let startup = [200, { ok: true, status: 'started' }]
  let readiness = [503, { ready: false, coreReady: true, failing: ['whatsapp'] }]
  let ui = '<openclaw-app></openclaw-app>'
  let readyRequests = 0
  const gateway = http.createServer((req, res) => {
    if (req.url === UI_PATH + '/') {
      res.end(ui)
      return
    }
    if (req.url === '/readyz') readyRequests += 1
    const [status, body, type = 'application/json'] = req.url === '/startupz' ? startup : readiness
    res.writeHead(status, { 'content-type': type })
    res.end(type === 'application/json' ? JSON.stringify(body) : body)
  })
  await listen(gateway, f.port)
  t.after(() => close(gateway))
  assert.equal(await f.core.gatewayReady(), true)
  assert.equal(readyRequests, 0)
  assert.equal(await f.core.gatewayReady({ verifyCore: true }), true)

  readiness = [503, { ready: false, coreReady: false }]
  assert.equal(await f.core.gatewayReady(), true)
  assert.equal(await f.core.gatewayReady({ verifyCore: true }), false)
  readiness = [200, { ready: true }]
  for (const status of ['starting', 'draining']) {
    startup = [503, { ok: false, status }]
    assert.equal(await f.core.gatewayReady(), false)
  }
  startup = [200, { ok: true }]
  assert.equal(await f.core.gatewayReady(), false)
  for (const missing of [[404, {}], [200, '<html>fallback</html>', 'text/html']]) {
    startup = missing
    assert.equal(await f.core.gatewayReady(), true)
    assert.equal(await f.core.gatewayReady({ verifyCore: true }), true)
  }
  readiness = [200, '<html>fallback</html>', 'text/html']
  assert.equal(await f.core.gatewayReady(), false)
  startup = [200, { ok: true, status: 'started' }]
  ui = '<html>not the Control UI</html>'
  assert.equal(await f.core.gatewayReady(), false)
})

test('a candidate with an unhealthy channel can replace the active runtime', async t => {
  const f = await fixture(t)
  const candidate = '2099.1.1'
  f.install(CORE_VERSION)
  f.install(candidate, 'channel-offline')
  await action(f.core, 'boot')
  const sample = path.join(f.core.stateDir, 'sample.txt')
  fs.writeFileSync(sample, 'original data')
  await action(f.core, 'update', candidate)
  assert.equal(f.core.phase, 'running', f.core.tail())
  assert.equal(f.core.version, candidate)
  assert.equal(fs.readFileSync(sample, 'utf8'), 'original data')
})

test('an unexpected exit recovers and a manual stop cancels a pending recovery', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  await action(f.core, 'boot')
  const first = f.core.gateway.pid
  f.core.gateway.kill('SIGKILL')
  await until(f.core, () => f.core.phase === 'running' && f.core.generation === 2)
  assert.notEqual(f.core.gateway.pid, first)
  f.core.gateway.kill('SIGKILL')
  await until(f.core, () => f.core.phase === 'retrying')
  await action(f.core, 'stop')
  assert.equal(f.core.status().retryAt, null)
  assert.equal(f.replaceWrapper().status().paused, true)
})

test('repeated startup failures exhaust the backoff and preserve the error', { timeout: 80000 }, async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION, 'fail')
  await action(f.core, 'boot')
  await until(f.core, () => f.core.status().retryExhausted && !f.core.job, 70000)
  assert.equal(f.core.phase, 'failed')
  assert.equal(f.core.status().retryAt, null)
  assert.match(f.core.failure, /42/)
  assert.match(f.core.tail(), /fixture: could not start/)
  for (const [index, seconds] of [2, 5, 15, 30].entries()) {
    assert.ok(f.core.tail().includes('将在 ' + seconds + ' 秒后自动恢复 Gateway（第 ' + (index + 1) + ' 次）'))
  }
  f.install(CORE_VERSION)
  await action(f.core, 'start')
  assert.equal(f.core.phase, 'running', f.core.tail())
})

test('a failed candidate cannot replace the active version or its data', async t => {
  const f = await fixture(t)
  const candidate = '2099.1.1'
  f.install(CORE_VERSION)
  f.install(candidate, 'fail')
  await action(f.core, 'boot')
  const sample = path.join(f.core.stateDir, 'sample.txt')
  fs.writeFileSync(sample, 'original data')
  await action(f.core, 'update', candidate)
  assert.equal(f.core.phase, 'running', f.core.tail())
  assert.equal(f.core.version, CORE_VERSION)
  assert.equal(fs.readFileSync(sample, 'utf8'), 'original data')
  assert.equal(fs.existsSync(f.core.transactionFile), false)
  assert.equal(f.core.retryCount, 0)
})

test('interrupted update defers rollback while the port is in use', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  const { stateDir, transactionFile, data } = f.core
  const snapshot = 'snapshot-0123456789abcdef'
  const sample = path.join(stateDir, 'sample.txt')
  fs.mkdirSync(path.join(data, snapshot))
  fs.writeFileSync(path.join(data, snapshot, 'sample.txt'), 'original data')
  fs.mkdirSync(stateDir)
  fs.writeFileSync(sample, 'partially changed')
  fs.writeFileSync(transactionFile, JSON.stringify({ target: '2099.1.1', previous: CORE_VERSION, snapshot }))
  const listener = http.createServer()
  await listen(listener, f.port)
  t.after(() => close(listener))
  const resumed = f.replaceWrapper()
  assert.equal(fs.readFileSync(sample, 'utf8'), 'partially changed')
  await action(resumed, 'boot')
  assert.match(resumed.failure, /端口 .* 已被占用/)
  assert.equal(fs.readFileSync(sample, 'utf8'), 'partially changed')
  assert.equal(fs.existsSync(transactionFile), true)
  await close(listener)
  await action(resumed, 'start')
  assert.equal(resumed.phase, 'running', resumed.tail())
  assert.equal(fs.readFileSync(sample, 'utf8'), 'original data')
  assert.equal(fs.existsSync(transactionFile), false)
})

test('a cleanup error after commit leaves the new runtime active', async t => {
  const f = await fixture(t)
  const candidate = '2099.1.1'
  f.install(CORE_VERSION)
  f.install(candidate)
  await action(f.core, 'boot')
  const unlink = fs.unlinkSync
  const error = t.mock.method(fs, 'unlinkSync', filename => {
    if (filename === f.core.transactionFile) throw new Error('fixture: journal cleanup denied')
    return unlink(filename)
  })
  try {
    await action(f.core, 'update', candidate)
  } finally {
    error.mock.restore()
  }
  assert.equal(f.core.phase, 'running', f.core.tail())
  assert.equal(f.core.version, candidate)
  assert.equal(f.core.generation, 2)
  assert.equal(fs.existsSync(f.core.transactionFile), true)
  assert.match(f.core.tail(), /journal cleanup denied/)
  await f.core.close()
  const resumed = f.replaceWrapper()
  await action(resumed, 'boot')
  assert.equal(resumed.phase, 'running', resumed.tail())
  assert.equal(resumed.version, candidate)
  assert.equal(fs.existsSync(resumed.transactionFile), false)
})

test('an unavailable maintenance handshake leaves the serving Gateway and state untouched', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  f.install('2099.1.1')
  await action(f.core, 'boot')
  const pid = f.core.gateway.pid
  const sample = path.join(f.core.stateDir, 'sample.txt')
  fs.writeFileSync(sample, 'unchanged')
  t.mock.method(f.core, 'rpc', async () => { throw new Error('unsupported') })
  await action(f.core, 'update', '2099.1.1')
  assert.equal(f.core.gateway.pid, pid)
  assert.equal(f.core.available, true)
  assert.equal(f.core.status().maintenance.stage, 'deferred')
  assert.equal(fs.readFileSync(sample, 'utf8'), 'unchanged')
  assert.equal(fs.existsSync(f.core.transactionFile), false)
})

test('a ready label cannot interrupt active tasks without explicit force, and cancellation resumes admission', async t => {
  const f = await fixture(t)
  const calls = []
  t.mock.method(f.core, 'rpc', async method => {
    calls.push(method)
    if (method === 'system.info') return { pid: 123, processInstanceId: 'test' }
    if (method === 'gateway.suspend.status') f.core.cancelUpdate = true
    return { status: 'ready', activeCount: 2, blockers: [], writeCustody: [], suspensionId: 'lease', expiresAtMs: Date.now() + 45000 }
  })
  assert.equal(await prepareUpgrade(f.core), false)
  assert.ok(!calls.includes('gateway.suspend.handoff'))
  assert.equal(calls.at(-1), 'gateway.suspend.resume')
})

test('even explicit force refuses unsettled writes and releases the maintenance window', async t => {
  const f = await fixture(t)
  const calls = []
  t.mock.method(f.core, 'rpc', async method => {
    calls.push(method)
    if (method === 'system.info') return { pid: 123, processInstanceId: 'test' }
    return { status: 'draining', activeCount: 2, blockers: [], writeCustody: [{ count: 1 }], suspensionId: 'lease', expiresAtMs: Date.now() + 45000 }
  })
  assert.equal(await prepareUpgrade(f.core, { force: true }), false)
  assert.ok(!calls.includes('gateway.suspend.handoff'))
  assert.equal(calls.at(-1), 'gateway.suspend.resume')
})

test('unreadable candidate sessions roll back before browser ingress opens', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  f.install('2099.1.1', 'broken-sessions')
  await action(f.core, 'boot')
  const sample = path.join(f.core.stateDir, 'sample.txt')
  fs.writeFileSync(sample, 'original')
  await action(f.core, 'update', '2099.1.1')
  assert.equal(f.core.version, CORE_VERSION)
  assert.equal(f.core.available, true)
  assert.equal(f.core.status().maintenance.stage, 'rolled-back')
  assert.equal(fs.readFileSync(sample, 'utf8'), 'original')
})

test('verified rollback preserves the current state and snapshot tampering is refused', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  f.install('2099.1.1')
  await action(f.core, 'boot')
  const sample = path.join(f.core.stateDir, 'sample.txt')
  fs.writeFileSync(sample, 'before update')
  await action(f.core, 'update', '2099.1.1')
  const restore = f.core.snapshots()[0]
  assert.equal(restore.verified, true)
  assert.ok(restore.bytes > 0)
  fs.writeFileSync(sample, 'new messages')
  assert.equal(f.core.action('update', restore.version, { restore }), true)
  await f.core.job
  assert.equal(f.core.version, CORE_VERSION, f.core.tail())
  assert.equal(fs.readFileSync(sample, 'utf8'), 'before update')
  const back = f.core.snapshots().find(item => item.version === '2099.1.1')
  assert.equal(fs.readFileSync(path.join(f.core.data, back.name, 'sample.txt'), 'utf8'), 'new messages')
  fs.writeFileSync(path.join(f.core.data, back.name, 'sample.txt'), 'tampered')
  const pid = f.core.gateway.pid
  assert.equal(f.core.action('update', back.version, { restore: back }), true)
  await f.core.job
  assert.equal(f.core.gateway.pid, pid)
  assert.equal(f.core.maintenance.stage, 'failed')
})

test('shell default changes preserve an installed core version without an active.json', async t => {
  const f = await fixture(t)
  const previous = '2026.11.2'
  f.install(previous)
  await f.core.startCore(previous)
  fs.unlinkSync(f.core.activeFile)
  const next = f.replaceWrapper()
  assert.equal(next.version, previous)
})

test('legacy interrupted upgrades never mistake the candidate owner record for a commit', async t => {
  const f = await fixture(t)
  f.install('2026.11.2')
  const snapshot = 'snapshot-abcdef0123456789'
  fs.mkdirSync(path.join(f.core.data, snapshot))
  fs.writeFileSync(path.join(f.core.data, snapshot, 'sample.txt'), 'legacy original')
  fs.mkdirSync(f.core.stateDir)
  fs.writeFileSync(path.join(f.core.stateDir, 'sample.txt'), 'uncommitted candidate')
  fs.writeFileSync(f.core.ownerFile, JSON.stringify({ version: '2026.11.3', instance: 'a'.repeat(32) }))
  fs.writeFileSync(f.core.transactionFile, JSON.stringify({ target: '2026.11.3', snapshot }))
  const next = f.replaceWrapper()
  assert.equal(next.version, '2026.11.2')
  await action(next, 'boot')
  assert.equal(next.phase, 'running', next.tail())
  assert.equal(fs.readFileSync(path.join(next.stateDir, 'sample.txt'), 'utf8'), 'legacy original')
})

test('snapshot retention keeps only the rollback point and pending transaction, preserving legacy directories', async t => {
  const f = await fixture(t)
  const legacy = 'snapshot-aaaaaaaaaaaaaaaa'
  fs.mkdirSync(path.join(f.core.data, legacy))
  for (let i = 0; i < 5; i++) {
    const name = 'snapshot-' + String(i).padStart(16, '0')
    fs.mkdirSync(path.join(f.core.data, name))
    await f.core.recordSnapshot(name, CORE_VERSION, { sha256: 'a'.repeat(64), bytes: 1, files: 1 })
  }
  const records = JSON.parse(fs.readFileSync(f.core.snapshotsFile, 'utf8'))
  records.forEach((r, i) => { r.createdAt = i + 1 })
  fs.writeFileSync(f.core.snapshotsFile, JSON.stringify(records))
  fs.writeFileSync(f.core.activeFile, JSON.stringify({ version: CORE_VERSION, snapshot: records[0].name }))
  fs.writeFileSync(f.core.transactionFile, JSON.stringify({ target: '2099.1.1', snapshot: records[3].name }))
  f.core.pruneSnapshots()
  assert.ok(fs.existsSync(path.join(f.core.data, legacy)))
  assert.ok(fs.existsSync(path.join(f.core.data, records[0].name)), 'active rollback point')
  assert.ok(!fs.existsSync(path.join(f.core.data, records[1].name)), 'unprotected old snapshot')
  assert.ok(fs.existsSync(path.join(f.core.data, records[3].name)), 'pending transaction snapshot')
  assert.equal(f.core.snapshots().length, 3)
  fs.unlinkSync(f.core.transactionFile)
  f.core.pruneSnapshots()
  assert.equal(f.core.snapshots().length, 2, 'one registered rollback point and the untouched legacy directory')
})

test('an expired maintenance lease resumes without attempting a stop', async t => {
  const f = await fixture(t)
  const calls = []
  t.mock.method(f.core, 'rpc', async method => {
    calls.push(method)
    if (method === 'system.info') return { pid: 123, processInstanceId: 'test' }
    if (method === 'gateway.suspend.status') return { status: 'running' }
    return { suspensionId: 'lease', expiresAtMs: Date.now() + 45000 }
  })
  assert.equal(await prepareUpgrade(f.core), false)
  assert.equal(calls.at(-1), 'gateway.suspend.resume')
  assert.ok(!calls.includes('gateway.suspend.handoff'))
})

test('a lost handoff response is retried with the same lease and process identity', async t => {
  const f = await fixture(t)
  const expiresAtMs = Date.now() + 45000
  const handoffs = []
  t.mock.method(f.core, 'rpc', async (method, params) => {
    if (method === 'system.info') return { pid: 123, processInstanceId: 'test' }
    if (method === 'gateway.suspend.prepare') return { suspensionId: 'lease', expiresAtMs }
    if (method === 'gateway.suspend.status') return { status: 'ready', writeCustody: [], expiresAtMs }
    if (method === 'gateway.suspend.handoff') {
      handoffs.push(params)
      if (handoffs.length === 1) throw new Error('reply lost')
      return { status: 'committed', suspensionId: 'lease', expiresAtMs }
    }
    assert.fail('committed handoff must not resume admission')
  })
  assert.equal(await prepareUpgrade(f.core), true)
  assert.equal(handoffs.length, 2)
  assert.deepEqual(handoffs[0], handoffs[1])
})

for (const fault of ['stop', 'port check', 'journal write', 'status write']) {
  test('upgrade recovers service when the initial ' + fault + ' fails', async t => {
    const f = await fixture(t)
    f.install(CORE_VERSION)
    f.install('2099.1.1')
    await action(f.core, 'boot')
    const sample = path.join(f.core.stateDir, 'sample.txt')
    fs.writeFileSync(sample, 'original data')
    let injected = false
    if (fault === 'stop' || fault === 'port check') {
      const method = fault === 'stop' ? 'stopCore' : 'assertPortFree'
      const original = f.core[method].bind(f.core)
      t.mock.method(f.core, method, async (...args) => {
        if (!injected) { injected = true; throw new Error('fixture: ' + fault + ' failed') }
        return original(...args)
      })
    } else {
      const write = fs.writeFileSync
      t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        const matches = fault === 'journal write' ? file === f.core.transactionFile + '.next' :
          file === f.core.updateStatusFile + '.next' && (f.core.maintenance.blockIngress || injected)
        if (matches) { injected = true; throw new Error('fixture: ' + fault + ' failed') }
        return write(file, ...args)
      })
    }
    await action(f.core, 'update', '2099.1.1')
    assert.equal(injected, true)
    assert.equal(f.core.phase, 'running', f.core.tail())
    assert.equal(f.core.version, CORE_VERSION)
    assert.equal(f.core.available, true)
    assert.equal(f.core.maintenance.blockIngress, false)
    assert.equal(f.core.maintenance.stage, 'rolled-back')
    assert.equal(fs.readFileSync(sample, 'utf8'), 'original data')
    assert.equal(fs.existsSync(f.core.transactionFile), false)
    const res = await fetch('http://127.0.0.1:' + f.port + UI_PATH + '/')
    assert.match(await res.text(), /openclaw-app/)
  })
}

test('persistent port conflicts keep ingress blocked until automatic recovery verifies service', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  f.install('2099.1.1')
  await action(f.core, 'boot')
  const stranger = http.createServer()
  t.after(() => close(stranger))
  const stop = f.core.stopCore.bind(f.core)
  let injected = false
  t.mock.method(f.core, 'stopCore', async () => {
    await stop()
    if (!injected) { injected = true; await listen(stranger, f.port) }
  })
  await action(f.core, 'update', '2099.1.1')
  assert.equal(f.core.phase, 'retrying', f.core.tail())
  assert.equal(f.core.available, false)
  assert.equal(f.core.maintenance.blockIngress, true)
  assert.equal(f.core.maintenance.stage, 'failed')
  assert.equal(stranger.listening, true)
  await close(stranger)
  await until(f.core, () => f.core.available && !f.core.job)
  assert.equal(f.core.version, CORE_VERSION)
  assert.equal(f.core.maintenance.blockIngress, false)
  assert.equal(f.core.maintenance.stage, 'rolled-back')
  assert.equal(JSON.parse(fs.readFileSync(f.core.updateStatusFile, 'utf8')).blockIngress, false)
})

test('candidate ingress stays blocked until session and Doctor validation completes', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION)
  f.install('2099.1.1')
  await action(f.core, 'boot')
  const rpc = f.core.rpc.bind(f.core)
  let audited = false
  t.mock.method(f.core, 'rpc', async (method, ...args) => {
    if (method === 'sessions.list') {
      audited = true
      assert.equal(f.core.phase, 'running')
      assert.equal(f.core.available, false)
    }
    return rpc(method, ...args)
  })
  await action(f.core, 'update', '2099.1.1')
  assert.equal(audited, true)
  assert.equal(f.core.available, true)
  assert.equal(f.core.version, '2099.1.1')
})

test('a one-session response count is not reported as the total session count', async t => {
  const f = await fixture(t)
  t.mock.method(f.core, 'gatewayReady', async () => true)
  t.mock.method(f.core, 'rpc', async () => ({ sessions: [{ key: 'example' }], count: 1 }))
  t.mock.method(f.core, 'cliJSON', async () => ({ findings: [] }))
  const report = await auditUpgrade(f.core, CORE_VERSION)
  assert.equal(report.sessions, true)
  assert.equal(Object.hasOwn(report, 'sessionCount'), false)
})

test('version discovery is read-only and cached comparisons follow the active core', async t => {
  const f = await fixture(t)
  f.core.upstream = new UpstreamVersions({ fetcher: async () => Response.json({ name: 'openclaw', version: '2099.1.1' }) })
  t.mock.method(f.core, 'install', () => assert.fail('a version check cannot install anything'))
  const version = f.core.version
  const result = await f.core.checkUpstream()
  assert.equal(result.latest, '2099.1.1')
  assert.equal(result.current, version)
  assert.equal(result.updateAvailable, true)
  assert.equal(f.core.phase, 'stopped')
  assert.equal(f.core.version, version)
  f.core.version = '2099.1.2'
  assert.equal(f.core.status().upstream.updateAvailable, false)
  assert.equal(f.core.status().upstream.comparison, -1)
})

for (const failed of [false, true]) {
  test('manual rollback restores a verified snapshot when the Gateway is ' + (failed ? 'failing to start' : 'manually stopped'), async t => {
    const f = await fixture(t)
    const candidate = '2099.1.1'
    f.install(CORE_VERSION)
    f.install(candidate)
    await action(f.core, 'boot')
    const sample = path.join(f.core.stateDir, 'sample.txt')
    fs.writeFileSync(sample, 'before upgrade')
    await action(f.core, 'update', candidate)
    fs.writeFileSync(sample, 'after upgrade')
    const point = f.core.status().rollback
    assert.equal(point.version, CORE_VERSION)
    await action(f.core, 'stop')
    if (failed) {
      f.install(candidate, 'fail')
      await action(f.core, 'start')
      assert.equal(f.core.phase, 'retrying')
    } else assert.equal(f.core.paused, true)
    const rpc = f.core.rpc.bind(f.core)
    t.mock.method(f.core, 'rpc', (method, ...args) => {
      assert.ok(!method.startsWith('gateway.suspend.'), 'offline rollback cannot depend on a running Gateway')
      return rpc(method, ...args)
    })
    const restore = f.core.snapshots().find(item => item.name === point.name)
    assert.equal(f.core.action('rollback', restore.version, { restore }), true)
    await f.core.job
    assert.equal(f.core.phase, 'running', f.core.tail())
    assert.equal(f.core.available, true)
    assert.equal(f.core.version, CORE_VERSION)
    assert.equal(f.core.paused, false)
    assert.equal(fs.readFileSync(sample, 'utf8'), 'before upgrade')
    assert.equal(f.core.status().rollback.version, candidate)
  })
}

test('offline rollback does not replace state or stop an unrelated listener', async t => {
  const f = await fixture(t)
  const candidate = '2099.1.1'
  f.install(CORE_VERSION)
  f.install(candidate)
  await action(f.core, 'boot')
  await action(f.core, 'update', candidate)
  const restore = f.core.snapshots()[0]
  await action(f.core, 'stop')
  const sample = path.join(f.core.stateDir, 'sample.txt')
  fs.writeFileSync(sample, 'current state must survive')
  const stranger = http.createServer()
  await listen(stranger, f.port)
  t.after(() => close(stranger))
  assert.equal(f.core.action('rollback', restore.version, { restore }), true)
  await f.core.job
  assert.equal(f.core.available, false)
  assert.equal(f.core.version, candidate)
  assert.equal(stranger.listening, true)
  assert.equal(fs.readFileSync(sample, 'utf8'), 'current state must survive')
  assert.equal(fs.existsSync(path.join(f.core.data, restore.name)), true)
})

function writeState(core, relative, content) {
  const file = path.join(core.stateDir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

test('application-owned private roots reject group writes without changing project permissions', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t)
  const project = writeState(f.core, 'workspace/project.txt', 'user file')
  fs.chmodSync(project, 0o660)
  for (const dir of [f.core.data, f.core.env.HOME]) fs.chmodSync(dir, 0o770)
  f.replaceWrapper()
  assert.equal(fs.statSync(f.core.data).mode & 0o777, 0o750)
  assert.equal(fs.statSync(f.core.env.HOME).mode & 0o777, 0o750)
  assert.equal(fs.statSync(project).mode & 0o777, 0o660)
})

for (const legacy of [false, true]) {
  test('upgrades and ' + (legacy ? 'legacy full' : 'lean') + ' snapshot rollback keep current user files without copying them', async t => {
    const f = await fixture(t)
    f.install(CORE_VERSION);f.install('2099.1.1')
    await action(f.core, 'boot')
    const project = writeState(f.core, 'workspace/project.txt', 'original project')
    const archive = writeState(f.core, 'agents/main/session-sqlite-import-archive/archive.jsonl', 'original archive')
    const database = writeState(f.core, 'agents/main/agent/openclaw-agent.sqlite', 'original database')
    const inodes = [fs.statSync(project).ino, fs.statSync(archive).ino]
    await action(f.core, 'update', '2099.1.1')
    assert.equal(f.core.version, '2099.1.1', f.core.tail())
    let restore = f.core.snapshots()[0]
    assert.equal(restore.scope, 'runtime-state')
    assert.equal(fs.existsSync(path.join(f.core.data, restore.name, 'workspace')), false)
    assert.equal(fs.existsSync(path.join(f.core.data, restore.name, 'agents/main/session-sqlite-import-archive')), false)
    if (legacy) {
      const name = 'snapshot-fedcba9876543210'
      const directory = path.join(f.core.data, name)
      await fs.promises.cp(f.core.stateDir, directory, { recursive: true })
      await f.core.recordSnapshot(name, CORE_VERSION, await inspectTree(directory))
      restore = f.core.snapshots().find(item => item.name === name)
    }
    fs.writeFileSync(project, 'latest project edits')
    fs.writeFileSync(archive, 'latest archive content')
    fs.writeFileSync(database, 'migrated database')
    assert.equal(f.core.action('rollback', restore.version, { restore }), true)
    await f.core.job
    assert.equal(f.core.version, CORE_VERSION, f.core.tail())
    assert.equal(fs.readFileSync(database, 'utf8'), 'original database')
    assert.equal(fs.readFileSync(project, 'utf8'), 'latest project edits')
    assert.equal(fs.readFileSync(archive, 'utf8'), 'latest archive content')
    assert.deepEqual([fs.statSync(project).ino, fs.statSync(archive).ino], inodes)
  })
}

test('a failed candidate restores the database and preserves newly edited and newly created workspaces', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION);f.install('2099.1.1', 'fail')
  await action(f.core, 'boot')
  const project = writeState(f.core, 'workspace/project.txt', 'original project')
  const database = writeState(f.core, 'state/openclaw.sqlite', 'original database')
  const inode = fs.statSync(project).ino
  const start = f.core.startCore.bind(f.core)
  t.mock.method(f.core, 'startCore', async (version, ...args) => {
    if (version === '2099.1.1') {
      fs.writeFileSync(project, 'edits must survive failed startup')
      fs.writeFileSync(database, 'candidate database schema')
      writeState(f.core, 'workspace-new/new.txt', 'new user file')
    }
    return start(version, ...args)
  })
  await action(f.core, 'update', '2099.1.1')
  assert.equal(f.core.available, true, f.core.tail())
  assert.equal(f.core.maintenance.stage, 'rolled-back')
  assert.equal(fs.readFileSync(database, 'utf8'), 'original database')
  assert.equal(fs.readFileSync(project, 'utf8'), 'edits must survive failed startup')
  assert.equal(fs.statSync(project).ino, inode)
  assert.equal(fs.readFileSync(path.join(f.core.stateDir, 'workspace-new/new.txt'), 'utf8'), 'new user file')
})

test('a failure after moving some preserved directories puts them all back without overwrites', async t => {
  const f = await fixture(t)
  f.install(CORE_VERSION);f.install('2099.1.1')
  await action(f.core, 'boot')
  const project = writeState(f.core, 'workspace/project.txt', 'keep project')
  const cache = writeState(f.core, 'tmp/cache.txt', 'keep cache')
  const inodes = [fs.statSync(project).ino, fs.statSync(cache).ino]
  const rename = fs.renameSync
  let injected = false
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!injected && to === path.join(f.core.stateDir, 'workspace')) {
      injected = true;throw new Error('fixture: interrupted user data handoff')
    }
    return rename(from, to)
  })
  await action(f.core, 'update', '2099.1.1')
  assert.equal(injected, true)
  assert.equal(f.core.available, true, f.core.tail())
  assert.equal(f.core.version, CORE_VERSION)
  assert.equal(fs.readFileSync(project, 'utf8'), 'keep project')
  assert.equal(fs.readFileSync(cache, 'utf8'), 'keep cache')
  assert.deepEqual([fs.statSync(project).ino, fs.statSync(cache).ino], inodes)
})

for (const interruption of ['before copy', 'partial copy', 'partial user handoff', 'during recovery handoff', 'during recovery rename']) {
  test('lean snapshot recovery survives an interruption ' + interruption, async t => {
    const f = await fixture(t)
    const project = writeState(f.core, 'workspace/project.txt', 'keep project')
    writeState(f.core, 'tmp/cache.txt', 'keep temp')
    writeState(f.core, 'state/openclaw.sqlite', 'original database')
    const inode = fs.statSync(project).ino
    const snapshot = 'snapshot-0123456789abcdef', backup = path.join(f.core.data, snapshot)
    fs.writeFileSync(f.core.transactionFile, JSON.stringify({ format: 2, target: '2099.1.1', previous: CORE_VERSION,
      snapshot, preserved: ['workspace', 'tmp'] }))
    fs.renameSync(f.core.stateDir, backup)
    if (interruption !== 'before copy') {
      writeState(f.core, 'state/openclaw.sqlite', 'candidate database')
      if (interruption !== 'partial copy') {
        fs.renameSync(path.join(backup, 'workspace'), path.join(f.core.stateDir, 'workspace'))
      }
    }
    if (interruption.startsWith('during recovery')) {
      const rename = fs.renameSync
      let injected = false
      const error = t.mock.method(fs, 'renameSync', (from, to) => {
        if (!injected && (interruption.endsWith('handoff') ? to === path.join(backup, 'workspace') : to === f.core.stateDir)) {
          injected = true;throw new Error('fixture: machine stopped during recovery')
        }
        return rename(from, to)
      })
      assert.throws(() => f.core.recoverUpdate(), /machine stopped/)
      error.mock.restore()
      assert.equal(injected, true)
      assert.match(JSON.parse(fs.readFileSync(f.core.transactionFile, 'utf8')).failed, /^failed-/)
    }
    const resumed = f.replaceWrapper()
    resumed.recoverUpdate()
    assert.equal(fs.readFileSync(project, 'utf8'), 'keep project')
    assert.equal(fs.statSync(project).ino, inode)
    assert.equal(fs.readFileSync(path.join(resumed.stateDir, 'tmp/cache.txt'), 'utf8'), 'keep temp')
    assert.equal(fs.readFileSync(path.join(resumed.stateDir, 'state/openclaw.sqlite'), 'utf8'), 'original database')
    assert.equal(fs.existsSync(resumed.transactionFile), false)
  })
}

for (const report of [
  { status: 'skipped', mode: 'unknown', reason: 'unmanaged-package-install' },
  { status: 'error', mode: 'npm', reason: 'session-sqlite-migration-required' },
]) {
  test('public kernel update stops at official ' + report.reason + ' before downloading or stopping the Gateway', async t => {
    const f = await fixture(t, { officialUpdates: true })
    f.install(CORE_VERSION)
    await action(f.core, 'boot')
    const pid = f.core.gateway.pid
    const project = writeState(f.core, 'workspace/project.txt', 'untouched user file')
    const inode = fs.statSync(project).ino
    let calls = 0, stops = 0
    t.mock.method(f.core, 'cliJSON', async (version, args) => {
      calls++
      assert.equal(version, CORE_VERSION)
      assert.deepEqual(args, ['update', '--tag', '2099.1.1', '--dry-run', '--json', '--timeout', '15'])
      return report
    })
    for (const method of ['install', 'switchRuntime', 'rpc', 'recordSnapshot']) {
      t.mock.method(f.core, method, () => assert.fail('official refusal must not call ' + method))
    }
    const stop = f.core.stopCore.bind(f.core)
    t.mock.method(f.core, 'stopCore', (...args) => { stops++;return stop(...args) })
    for (const force of [false, true]) {
      assert.equal(f.core.action('update', '2099.1.1', { force }), true)
      await f.core.job
      assert.equal(f.core.gateway.pid, pid)
      assert.equal(f.core.available, true)
      assert.equal(f.core.version, CORE_VERSION)
      assert.equal(stops, 0)
      assert.equal(f.core.maintenance.stage, 'deferred')
      assert.equal(f.core.maintenance.message, report.reason.includes('migration') ? MIGRATION_MESSAGE : FRAMEWORK_MESSAGE)
      assert.equal(fs.existsSync(path.join(f.core.runtimes, '2099.1.1')), false)
      assert.equal(fs.existsSync(f.core.transactionFile), false)
      assert.equal(f.core.snapshots().length, 0)
      assert.equal(fs.readFileSync(project, 'utf8'), 'untouched user file')
      assert.equal(fs.statSync(project).ino, inode)
    }
    assert.equal(calls, 2)
  })
}

test('official check failures preserve service and never become a fallback install or a migration claim', async t => {
  const f = await fixture(t, { officialUpdates: true })
  f.install(CORE_VERSION)
  await action(f.core, 'boot')
  const pid = f.core.gateway.pid
  t.mock.method(f.core, 'cliJSON', async () => { throw new Error('fixture: registry timeout') })
  t.mock.method(f.core, 'install', () => assert.fail('failed inspection cannot install anything'))
  await action(f.core, 'update', '2099.1.1')
  assert.equal(f.core.gateway.pid, pid)
  assert.equal(f.core.available, true)
  assert.equal(f.core.maintenance.stage, 'deferred')
  assert.match(f.core.maintenance.message, /检查未完成/)
  assert.doesNotMatch(f.core.maintenance.message, /需要迁移会话/)
})

const frameworkPolicy = JSON.parse(fs.readFileSync(new URL('../openclaw-fnos/app/framework-upgrade.json', import.meta.url), 'utf8'))

for (const candidateFails of [false, true]) {
  test('an installed FPK applies its reviewed core adaptation once and ' + (candidateFails ? 'retains the old version on failure' : 'does not undo a later manual rollback'), async t => {
    const f = await fixture(t, { officialUpdates: true })
    f.install('2026.11.3');f.install(CORE_VERSION, candidateFails ? 'fail' : 'serve')
    f.core.version = '2026.11.3'
    f.core.frameworkVersion = frameworkPolicy.framework
    writeState(f.core, 'workspace/project.txt', 'keep user project')
    fs.writeFileSync(f.core.frameworkRequestFile, JSON.stringify(frameworkPolicy))
    t.mock.method(f.core, 'update', () => assert.fail('FPK adaptation is separate from unsupported online update'))
    await action(f.core, 'boot')
    assert.equal(f.core.available, true, f.core.tail())
    assert.equal(f.core.version, candidateFails ? '2026.11.3' : CORE_VERSION)
    assert.equal(fs.existsSync(f.core.frameworkRequestFile), false)
    assert.equal(JSON.parse(fs.readFileSync(f.core.frameworkAttemptFile, 'utf8')).outcome, candidateFails ? 'not-applied' : 'complete')
    if (!candidateFails) {
      const restore = f.core.snapshots().find(item => item.version === '2026.11.3')
      assert.equal(f.core.action('rollback', restore.version, { restore }), true)
      await f.core.job
      assert.equal(f.core.version, '2026.11.3')
    }
    await f.core.close()
    const resumed = f.replaceWrapper()
    resumed.frameworkVersion = frameworkPolicy.framework
    await action(resumed, 'boot')
    assert.equal(resumed.version, '2026.11.3', 'a consumed FPK request must never reapply on later boots')
    assert.equal(fs.readFileSync(path.join(resumed.stateDir, 'workspace/project.txt'), 'utf8'), 'keep user project')
  })
}

test('an FPK request cannot select an unreviewed source or a different target', async t => {
  const f = await fixture(t, { officialUpdates: true })
  f.install('2026.11.2');f.core.version = '2026.11.2';f.core.frameworkVersion = frameworkPolicy.framework
  fs.writeFileSync(f.core.frameworkRequestFile, JSON.stringify(frameworkPolicy))
  t.mock.method(f.core, 'switchRuntime', () => assert.fail('unreviewed sources cannot migrate'))
  await action(f.core, 'boot')
  assert.equal(f.core.available, true)
  assert.equal(f.core.version, '2026.11.2')
  assert.equal(JSON.parse(fs.readFileSync(f.core.frameworkAttemptFile, 'utf8')).outcome, 'unsupported-source')
  fs.writeFileSync(f.core.frameworkRequestFile, JSON.stringify({ ...frameworkPolicy, target: '2099.1.1' }))
  await f.core.applyFrameworkUpgrade()
  assert.equal(f.core.version, '2026.11.2')
})
