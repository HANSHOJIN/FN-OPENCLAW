import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Core } from '../openclaw-fnos/app/shell/core.mjs'
import { CORE_VERSION, UI_PATH } from '../openclaw-fnos/app/shell/defaults.mjs'
import { prepareUpgrade, auditUpgrade } from '../openclaw-fnos/app/shell/maintenance.mjs'

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

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-openclaw-test-'))
  const probe = http.createServer()
  const port = await listen(probe)
  await close(probe)
  const options = { data: path.join(root, 'data'), config: path.join(root, 'etc'), home: path.join(root, 'home'), port }
  const core = new Core(options)
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
