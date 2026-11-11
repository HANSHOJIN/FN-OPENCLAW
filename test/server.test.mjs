import assert from 'node:assert/strict'
import http from 'node:http'
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

async function fixture(t) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('export const ready = true')
  })
  upstream.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  const port = await listen(t, upstream)
  const shell = await listen(t, createServer({ port, token: 'test-token', phase: 'running' }))
  return (path, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: shell, path, headers })
    req.on('response', res => {
      res.resume()
      res.once('end', () => resolve(res))
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
