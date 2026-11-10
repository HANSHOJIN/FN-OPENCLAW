import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Core } from '../openclaw-fnos/app/shell/core.mjs'
import { CORE_VERSION, UI_PATH } from '../openclaw-fnos/app/shell/defaults.mjs'

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
  fs.writeFileSync(transactionFile, JSON.stringify({ target: '2099.1.1', snapshot }))
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
