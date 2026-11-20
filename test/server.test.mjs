import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { createServer } from '../openclaw-fnos/app/shell/server.mjs'
import { PREFIX, UI_PATH } from '../openclaw-fnos/app/shell/defaults.mjs'

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  return server.address().port
}

async function fixture(t, overrides = {}) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('export const ready = true')
  })
  upstream.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const port = await listen(t, upstream)
  const shell = await listen(t, createServer({ port, token: 'test-token', phase: 'running',
    status: () => ({ phase: 'running', version: '2026.11.4' }), tail: () => '', ...overrides }))
  return (path, headers, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: shell, path, headers, method })
    req.on('response', res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.once('end', () => resolve(Object.assign(res, { text })))
      res.once('error', reject)
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out')))
    req.end()
  })
}

const relay = 'device-test.app.5ddd.com'
const admin = { 'x-trim-userid': '1000', 'x-trim-isadmin': 'true' }
const asset = UI_PATH + '/assets/index.js'

async function ticket(request, headers) {
  const entry = await request(PREFIX + '/', headers)
  assert.equal(entry.statusCode, 200)
  assert.equal(entry.headers['cache-control'], 'no-store')
  assert.match(entry.headers['content-security-policy'], /script-src 'sha256-/)
  return entry.text.match(/name="fn-openclaw-navigation" content="([^"]+)"/)[1]
}

test('a fresh authenticated navigation repairs a stale proof without Referrer or Fetch Metadata', async t => {
  const request = await fixture(t)
  const ingress = { ...admin, host: '127.0.0.1', 'x-forwarded-proto': 'https' }
  const oldOrigin = 'https://' + relay + ':41001'
  const origin = 'https://' + relay + ':42163'
  const old = await request(PREFIX + '/open', { ...ingress, referer: oldOrigin + PREFIX + '/' })
  const oldCookie = old.headers['set-cookie'][0].split(';')[0]
  const navigation = await ticket(request, { ...ingress, cookie: oldCookie })
  const headers = { ...ingress, origin, cookie: oldCookie }
  const ws = { ...headers, connection: 'Upgrade', upgrade: 'websocket' }
  assert.equal((await request(UI_PATH + '/', ws)).statusCode, 403)
  const proof = await request(PREFIX + '/api/navigation-proof', { ...headers, 'x-fn-openclaw-navigation': navigation }, 'POST')
  assert.equal(proof.statusCode, 200)
  assert.deepEqual(JSON.parse(proof.text), { ready: true })
  assert.equal(proof.headers['access-control-allow-origin'], undefined)
  assert.match(proof.headers['set-cookie'][0], /; HttpOnly; SameSite=Strict; Secure$/)
  const cookie = proof.headers['set-cookie'][0].split(';')[0]
  assert.notEqual(cookie.split('=')[0], oldCookie.split('=')[0])
  const both = oldCookie + '; ' + cookie
  assert.equal((await request(asset, { ...headers, cookie: both })).statusCode, 200)
  assert.equal((await request(UI_PATH + '/', { ...ws, cookie: both })).statusCode, 101)
  assert.equal((await request(UI_PATH + '/', { ...ws, origin: oldOrigin, cookie: both })).statusCode, 101)
  assert.equal((await request(asset, { ...headers, cookie, referer: origin + '/other-app/' })).statusCode, 403)
})

test('navigation bootstrap supports LAN and port-stripped relay entrances', async t => {
  const request = await fixture(t)
  for (const [origin, host, proto] of [
    ['http://192.168.50.76:5666', '127.0.0.1', 'http'],
    ['https://' + relay + ':42163', relay, 'https'],
    ['http://desktop.test:5666', 'desktop.test', 'http'],
  ]) {
    const ingress = { ...admin, host, 'x-forwarded-proto': proto }
    const navigation = await ticket(request, ingress)
    const proof = await request(PREFIX + '/api/navigation-proof', { ...ingress, origin, 'x-fn-openclaw-navigation': navigation }, 'POST')
    assert.equal(proof.statusCode, 200, origin)
    assert.equal(proof.headers['set-cookie'][0].includes('; Secure'), origin.startsWith('https:'))
    const cookie = proof.headers['set-cookie'][0].split(';')[0]
    assert.equal((await request(asset, { ...ingress, origin, cookie })).statusCode, 200, origin)
    assert.equal((await request(UI_PATH + '/', { ...ingress, origin, cookie, connection: 'Upgrade', upgrade: 'websocket' })).statusCode, 101, origin)
  }
})

test('FN Connect can switch between remote HTTPS and LAN HTTP transport without changing the browser origin', async t => {
  const request = await fixture(t)
  const origin = 'https://' + relay + ':39419'
  const lan = { ...admin, host: 'localhost', 'x-forwarded-proto': 'http' }
  const remote = { ...lan, 'x-forwarded-proto': 'https' }
  const proofPath = PREFIX + '/api/navigation-proof'
  const handshake = { connection: 'Upgrade', upgrade: 'websocket' }
  const old = await request(PREFIX + '/open', { ...remote, referer: origin + PREFIX + '/' })
  const cookie = old.headers['set-cookie'][0].split(';')[0]
  assert.equal((await request(UI_PATH, { ...remote, origin, cookie, ...handshake })).statusCode, 101)
  assert.equal((await request(UI_PATH, { ...lan, origin, cookie, ...handshake })).statusCode, 101)

  const navigation = await ticket(request, lan)
  const bootstrap = { ...lan, origin, referer: origin + PREFIX + '/', 'sec-fetch-site': 'same-origin',
    'x-fn-openclaw-navigation': navigation }
  const proof = await request(proofPath, bootstrap, 'POST')
  assert.equal(proof.statusCode, 200)
  assert.match(proof.headers['set-cookie'][0], /; HttpOnly; SameSite=Strict; Secure$/)
  const fresh = proof.headers['set-cookie'][0].split(';')[0]
  assert.equal((await request(asset, { ...lan, origin, cookie: fresh })).statusCode, 200)
  assert.equal((await request(asset, { ...lan, origin, referer: origin + PREFIX + '/', 'sec-fetch-site': 'same-origin' })).statusCode, 403)
  for (const changes of [
    { 'x-fn-openclaw-navigation': '' }, { 'sec-fetch-site': 'cross-site' },
    { referer: 'https://unrelated.test/' }, { origin: 'https://unrelated.test' },
    { host: '192.168.50.76' }, { 'x-trim-isadmin': 'false' },
  ]) {
    const rejected = await request(proofPath, { ...bootstrap, ...changes }, 'POST')
    assert.equal(rejected.statusCode, 403, JSON.stringify(changes))
    assert.equal(rejected.headers['set-cookie'], undefined)
  }
  const ws = { ...lan, origin, cookie: fresh, ...handshake }
  for (const changes of [
    { cookie: '' }, { 'x-trim-userid': '1001' }, { 'x-trim-isadmin': 'false' },
    { 'sec-fetch-site': 'cross-site' }, { host: '192.168.50.76' },
    { origin: 'https://' + relay + ':39420' }, { origin: 'https://unrelated.test' },
  ]) assert.equal((await request(UI_PATH, { ...ws, ...changes })).statusCode, 403, JSON.stringify(changes))
})

test('bootstrap rejects forged, expired, cross-origin or non-admin requests', async t => {
  const request = await fixture(t)
  const ingress = { ...admin, host: '127.0.0.1', 'x-forwarded-proto': 'https' }
  const navigation = await ticket(request, ingress)
  const origin = 'https://' + relay + ':42163'
  const valid = { ...ingress, origin, 'x-fn-openclaw-navigation': navigation }
  const signed = (now, user = '1000') => {
    const value = now + '.' + 'a'.repeat(32)
    return value + '.' + createHmac('sha256', 'test-token').update(JSON.stringify([value, user])).digest('hex')
  }
  for (const change of [
    { 'x-fn-openclaw-navigation': '' },
    { 'x-fn-openclaw-navigation': navigation.slice(0, -1) + (navigation.endsWith('0') ? '1' : '0') },
    { 'x-fn-openclaw-navigation': signed(Date.now() - 301000) },
    { 'x-fn-openclaw-navigation': signed(Date.now() + 60000) },
    { 'x-trim-userid': '1001' }, { 'x-trim-isadmin': 'false' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { origin: '' }, { origin: 'null' }, { origin: origin + '/' },
    { origin: 'https://evil.test' }, { origin: 'http://' + relay + ':42163' },
    { host: 'other-device.app.5ddd.com' }, { host: relay + ':41001' },
    { 'x-forwarded-proto': 'ftp' },
  ]) {
    const response = await request(PREFIX + '/api/navigation-proof', { ...valid, ...change }, 'POST')
    assert.equal(response.statusCode, 403, JSON.stringify(change))
    assert.equal(response.headers['set-cookie'], undefined)
    assert.doesNotMatch(response.text, /test-token|[a-f0-9]{64}/)
  }
})

test('independent origin cookies are bounded without clearing other application cookies', async t => {
  const request = await fixture(t)
  const ingress = { ...admin, host: '127.0.0.1', 'x-forwarded-proto': 'https' }
  const navigation = await ticket(request, ingress)
  const jar = new Map([['nas-session', 'private']])
  for (let port = 41000; port < 41009; port++) {
    const response = await request(PREFIX + '/api/navigation-proof', { ...ingress,
      origin: 'https://' + relay + ':' + port, 'x-fn-openclaw-navigation': navigation,
      cookie: [...jar].map(([name, value]) => name + '=' + value).join('; '),
    }, 'POST')
    assert.equal(response.statusCode, 200)
    for (const line of response.headers['set-cookie']) {
      const [name, value] = line.split(';')[0].split('=')
      if (line.includes('Max-Age=0')) jar.delete(name)
      else jar.set(name, value)
    }
  }
  assert.equal(jar.size, 7)
  assert.equal(jar.get('nas-session'), 'private')
})

test('FN Connect assets accept changing relay ports with same-origin referrers', async t => {
  const request = await fixture(t)
  for (const port of [41001, 44889, 45123]) {
    const origin = 'https://' + relay + ':' + port
    const result = await request(asset, { ...admin, host: relay, origin, referer: origin + UI_PATH + '/' })
    assert.equal(result.statusCode, 200, String(port))
    assert.equal(result.headers['content-type'], 'text/javascript')
  }
})

test('the relay fallback rejects unrelated origins, referrers and non-admins', async t => {
  const request = await fixture(t)
  const origin = 'https://' + relay + ':44889'
  const valid = { ...admin, host: relay, origin, referer: origin + UI_PATH + '/' }
  for (const change of [
    { host: 'other-device.app.5ddd.com' },
    { host: relay + ':41001' },
    { origin: 'https://other-device.app.5ddd.com:44889' },
    { referer: 'https://' + relay + ':41001' + UI_PATH + '/' },
    { referer: origin + '/other-app/' },
    { referer: '' },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-trim-isadmin': 'false' },
  ]) {
    assert.equal((await request(asset, { ...valid, ...change })).statusCode, 403, JSON.stringify(change))
  }
  const desktop = 'http://desktop.test:5666'
  assert.equal((await request(asset, { ...admin, host: 'desktop.test', origin: desktop })).statusCode, 200)
  const custom = 'https://desktop.test:44889'
  assert.equal((await request(asset, { ...admin, host: 'desktop.test', origin: custom, referer: custom + UI_PATH + '/' })).statusCode, 403)
})

test('relay WebSockets with stripped ports require proof bound to the origin and admin', async t => {
  const request = await fixture(t)
  const origin = 'https://' + relay + ':44889'
  const entry = await request(PREFIX + '/open', { ...admin, host: relay, referer: origin + PREFIX + '/' })
  assert.equal(entry.statusCode, 303)
  const [cookie] = entry.headers['set-cookie']
  assert.match(cookie, /; Secure$/)
  const headers = { ...admin, host: relay, origin, connection: 'Upgrade', upgrade: 'websocket' }
  assert.equal((await request(UI_PATH + '/', headers)).statusCode, 403)
  assert.equal((await request(UI_PATH + '/', { ...headers, referer: origin + UI_PATH + '/' })).statusCode, 403)
  const withProof = { ...headers, cookie: cookie.split(';')[0] }
  assert.equal((await request(UI_PATH + '/', withProof)).statusCode, 101)
  assert.equal((await request(UI_PATH + '/', { ...withProof, 'x-trim-userid': '1001' })).statusCode, 403)
  assert.equal((await request(UI_PATH + '/', { ...withProof, origin: 'https://' + relay + ':41001' })).statusCode, 403)
})

test('the native relay can rewrite Host to loopback without losing its same-origin checks', async t => {
  const request = await fixture(t)
  const origin = 'https://' + relay + ':40177'
  const ingress = { ...admin, host: '127.0.0.1', 'x-forwarded-host': 'relay-ingress.test', 'x-forwarded-proto': 'https' }
  const context = { ...ingress, 'sec-fetch-site': 'same-origin' }
  const module = { ...context, origin, referer: origin + UI_PATH + '/' }
  assert.equal((await request(asset, module)).statusCode, 200)
  for (const change of [
    { host: 'other-device.app.5ddd.com' },
    { 'x-forwarded-proto': 'http' },
    { 'sec-fetch-site': '' },
    { 'sec-fetch-site': 'cross-site' },
    { referer: origin + '/other-app/' },
    { referer: 'https://other-device.app.5ddd.com:40177' + UI_PATH + '/' },
    { 'x-trim-isadmin': 'false' },
  ]) {
    assert.equal((await request(asset, { ...module, ...change })).statusCode, 403, JSON.stringify(change))
  }

  const open = await request(PREFIX + '/open', { ...context, referer: origin + PREFIX + '/' })
  assert.equal(open.statusCode, 303)
  const cookie = open.headers['set-cookie'][0].split(';')[0]
  const ws = { ...ingress, origin, connection: 'Upgrade', upgrade: 'websocket' }
  assert.equal((await request(UI_PATH + '/', ws)).statusCode, 403)
  assert.equal((await request(UI_PATH + '/', { ...ws, cookie })).statusCode, 101)
  assert.equal((await request(UI_PATH + '/', { ...ws, cookie, 'sec-fetch-site': 'cross-site' })).statusCode, 403)
  assert.equal((await request(UI_PATH + '/', { ...ws, cookie, origin: 'https://' + relay + ':41001' })).statusCode, 403)
})

test('LAN HTTP WebViews without Fetch Metadata use a signed app-navigation proof', async t => {
  const request = await fixture(t)
  const origin = 'http://192.168.50.76:5666'
  const ingress = { ...admin, host: '127.0.0.1', 'x-forwarded-proto': 'http' }
  const module = { ...ingress, origin, referer: origin + UI_PATH + '/' }
  assert.equal((await request(asset, module)).statusCode, 403)
  const entry = await request(PREFIX + '/open', { ...ingress, referer: origin + PREFIX + '/' })
  assert.equal(entry.statusCode, 303)
  const cookie = entry.headers['set-cookie'][0].split(';')[0]
  assert.ok(!entry.headers['set-cookie'][0].includes('; Secure'))
  const allowed = { ...module, cookie }
  assert.equal((await request(asset, allowed)).statusCode, 200)
  assert.equal((await request(UI_PATH + '/', { ...ingress, origin, cookie, connection: 'Upgrade', upgrade: 'websocket' })).statusCode, 101)
  for (const change of [
    { cookie: '' }, { 'x-trim-userid': '1001' }, { 'x-trim-isadmin': 'false' },
    { origin: 'http://192.168.50.77:5666' }, { origin: 'http://192.168.50.76:5667' },
    { origin: 'http://public.test:5666' }, { host: 'other-device.test' },
    { 'x-forwarded-proto': 'https' }, { 'sec-fetch-site': 'cross-site' },
    { referer: origin + '/other-app/' },
  ]) assert.equal((await request(asset, { ...allowed, ...change })).statusCode, 403, JSON.stringify(change))
})

test('native HTTPS navigation can bootstrap proof when the WebView omits Fetch Metadata', async t => {
  const request = await fixture(t)
  const origin = 'https://' + relay + ':41045'
  const ingress = { ...admin, host: '127.0.0.1', 'x-forwarded-proto': 'https' }
  const module = { ...ingress, origin, referer: origin + UI_PATH + '/assets/entry.js' }
  assert.equal((await request(asset, module)).statusCode, 403)
  const open = await request(PREFIX + '/open', { ...ingress, referer: origin + PREFIX + '/' })
  const cookie = open.headers['set-cookie'][0].split(';')[0]
  assert.equal((await request(asset, { ...module, cookie })).statusCode, 200)
  assert.equal((await request(asset, { ...module, cookie, 'sec-fetch-site': 'cross-site' })).statusCode, 403)
  const bad = await request(PREFIX + '/open', { ...ingress, referer: origin + '/another-app/' })
  assert.equal(bad.headers['set-cookie'], undefined)
})

test('upstream discovery works with a stopped core and retains admin and origin checks', async t => {
  let calls = 0
  const request = await fixture(t, { phase: 'stopped', checkUpstream: async () => {
    calls++
    return { latest: '2026.11.4', current: '2026.11.3', updateAvailable: true }
  } })
  const response = await request(PREFIX + '/api/upstream', admin)
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.text).latest, '2026.11.4')
  assert.equal(calls, 1)
  assert.equal((await request(PREFIX + '/api/upstream', {})).statusCode, 403)
  assert.equal((await request(PREFIX + '/api/upstream', { ...admin, origin: 'https://unrelated.test', 'sec-fetch-site': 'cross-site' })).statusCode, 403)
  assert.equal(calls, 1)
})

test('an automatic update keeps new chat closed while the existing Gateway serves', async t => {
  const request = await fixture(t, {
    available: true, chatBlocked: true,
    status: () => ({
      phase: 'running', version: '2026.11.5', chatBlocked: true,
      maintenance: { stage: 'preparing-framework', target: '2026.11.6' },
    }),
  })
  const context = { ...admin, host: '127.0.0.1', 'sec-fetch-site': 'same-origin' }
  const page = await request(PREFIX + '/', context)
  assert.equal(page.statusCode, 200)
  assert.match(page.text, /准备自动升级 · 目标 2026\.11\.6/)
  const entry = await request(PREFIX + '/open', context)
  assert.equal(entry.statusCode, 503)
  assert.match(entry.text, /正在更新或回滚/)
  assert.equal((await request(asset, context)).statusCode, 200)
})

test('only an authenticated console action can confirm a prepared online update', async t => {
  const id = '1'.repeat(32)
  const actions = []
  const request = await fixture(t, {
    preparedKernel: { id },
    action: (...args) => { actions.push(args); return true },
  })
  const headers = { ...admin, 'sec-fetch-site': 'same-origin', 'x-fn-openclaw-action': '1' }
  const route = PREFIX + '/api/action?action=activate&approval='
  assert.equal((await request(route + id, { ...headers, 'x-trim-isadmin': 'false' }, 'POST')).statusCode, 403)
  assert.equal((await request(route + id, { ...headers, 'x-fn-openclaw-action': '' }, 'POST')).statusCode, 403)
  assert.equal((await request(route + '2'.repeat(32), headers, 'POST')).statusCode, 409)
  assert.equal((await request(route + id, headers, 'POST')).statusCode, 202)
  assert.deepEqual(actions, [['activate', undefined, { approval: id, force: false }]])
})

test('upstream lookup failures return a clear error without exposing internal diagnostics', async t => {
  const request = await fixture(t, { checkUpstream: async () => { throw new Error('private diagnostic') } })
  const response = await request(PREFIX + '/api/upstream', admin)
  assert.equal(response.statusCode, 503)
  assert.match(JSON.parse(response.text).error, /无法检测上游版本/)
  assert.doesNotMatch(response.text, /private diagnostic/)
})

test('the console can request the same verified rollback while the Gateway is paused', async t => {
  const restore = { name: 'snapshot-aaaaaaaaaaaaaaaa', version: '2026.11.3', rollbackAvailable: true }
  let captured
  const request = await fixture(t, {
    phase: 'stopped', paused: true, version: '2099.1.1', snapshots: () => [restore],
    action: (...args) => { captured = args; return true },
  })
  const response = await request(PREFIX + '/api/action?action=rollback&snapshot=' + restore.name,
    { ...admin, 'x-fn-openclaw-action': '1' }, 'POST')
  assert.equal(response.statusCode, 202)
  assert.deepEqual(captured, ['rollback', restore.version, { restore }])
})
