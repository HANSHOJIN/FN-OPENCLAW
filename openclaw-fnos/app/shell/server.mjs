import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Core, validVersion } from './core.mjs'
import { PREFIX, UI_PATH, FNOS_DESKTOP_PORT } from './defaults.mjs'

const files = new Map([
  ['/shell.css', ['shell.css', 'text/css']],
  ['/titlebar.css', ['titlebar.css', 'text/css']],
])
const phases = {
  stopped: '已停止', installing: '正在安装', starting: '正在启动', running: '运行中',
  stopping: '正在停止', retrying: '等待自动恢复', failed: 'Gateway 故障',
}
const readShell = name => fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const shellScript = '\n(() => {\n' + readShell('titlebar.js') + '\n' +
  readShell('shell.js').replace('__FN_OPENCLAW_PHASES__', JSON.stringify(phases)) + '\n})()\n'
const scriptHash = createHash('sha256').update(shellScript).digest('base64')
const shellTemplate = readShell('index.html')
const shellCSP = `default-src 'self'; script-src 'sha256-${scriptHash}'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`
const escapeHTML = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const originCookie = 'fn_openclaw_origin'

function isAdmin(req) {
  return /^\d+$/.test(req.headers['x-trim-userid'] ?? '') && req.headers['x-trim-isadmin'] === 'true'
}

function isRelayOrigin(origin) {
  return origin.protocol === 'https:' && /^[a-z0-9-]+\.app\.5ddd\.com$/.test(origin.hostname)
}

function isForwardedRelay(req, origin) {
  if (!isRelayOrigin(origin) || req.headers['x-forwarded-proto'] !== 'https') return false
  const host = new URL('http://' + req.headers.host).hostname
  return ['localhost', '127.0.0.1', '[::1]'].includes(host)
}

function isForwardedLAN(req, origin, desktopPort) {
  if (origin.protocol !== 'http:' || origin.port !== String(desktopPort) || net.isIP(origin.hostname) !== 4) return false
  const [a, b] = origin.hostname.split('.').map(Number)
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return false
  const host = new URL('http://' + req.headers.host).hostname
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) && req.headers['x-forwarded-proto'] === 'http'
}

function sameAppReferrer(req, origin) {
  const referrer = new URL(req.headers.referer)
  return referrer.origin === origin.origin &&
    (referrer.pathname === PREFIX || referrer.pathname.startsWith(PREFIX + '/'))
}

function sameOrigin(req, desktopPort, { allowRelayReferrer = true } = {}) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || !req.headers.host) return false
    const forwardedHost = new URL(parsed.protocol + '//' + req.headers.host)
    if (parsed.host === forwardedHost.host) return true
    // The native FN Connect bridge can replace Host with loopback. Require
    // both the browser's same-origin metadata and this application's referrer.
    if (parsed.hostname !== forwardedHost.hostname) {
      return allowRelayReferrer && site === 'same-origin' && isForwardedRelay(req, parsed) && sameAppReferrer(req, parsed)
    }
    if (forwardedHost.port) return false
    if (parsed.port === String(desktopPort) || site === 'same-origin') return true
    // fnOS forwards $host without its port. FN Connect may choose another
    // port for each connection, and the WebView may omit Fetch Metadata.
    return allowRelayReferrer && isRelayOrigin(parsed) && sameAppReferrer(req, parsed)
  } catch { return false }
}

function originProof(req, core, origin) {
  return createHmac('sha256', core.token)
    .update(JSON.stringify([origin, req.headers['x-trim-userid']]))
    .digest('hex')
}

function hasOriginProof(req, core) {
  if (!req.headers.origin) return false
  const proof = (req.headers.cookie || '').split(';').map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(originCookie + '='))?.slice(originCookie.length + 1)
  if (!proof || !/^[a-f\d]{64}$/.test(proof)) return false
  return timingSafeEqual(Buffer.from(proof), Buffer.from(originProof(req, core, req.headers.origin)))
}

function httpOrigin(req, core, desktopPort) {
  if (sameOrigin(req, desktopPort)) return true
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false
  try {
    const origin = new URL(req.headers.origin)
    // HTTP WebViews can omit Fetch Metadata. A previously authenticated app
    // navigation must have issued this origin-bound cookie before any fallback.
    return (isForwardedRelay(req, origin) || isForwardedLAN(req, origin, desktopPort)) &&
      sameAppReferrer(req, origin) && hasOriginProof(req, core)
  } catch { return false }
}

function setOriginCookie(req, core, headers, desktopPort) {
  try {
    const source = new URL(req.headers.origin || req.headers.referer)
    const headersForOrigin = { headers: { ...req.headers, origin: source.origin } }
    const site = req.headers['sec-fetch-site']
    const forwardedNavigation = !req.headers.origin && req.method === 'GET' && (!site || site === 'same-origin') &&
      (isForwardedLAN(req, source, desktopPort) || isForwardedRelay(req, source)) && sameAppReferrer(req, source)
    if (!sameOrigin(headersForOrigin, desktopPort) && !forwardedNavigation && !httpOrigin(headersForOrigin, core, desktopPort)) return
    const proof = originProof(req, core, source.origin)
    const cookie = `${originCookie}=${proof}; Path=${PREFIX}; HttpOnly; SameSite=Strict` +
      (source.protocol === 'https:' ? '; Secure' : '')
    headers['set-cookie'] = [...(headers['set-cookie'] || []), cookie]
  } catch { /* A later same-origin resource request can supply the origin. */ }
}

function websocketOrigin(req, core, desktopPort) {
  if (!req.headers.origin) return false
  if (sameOrigin(req, desktopPort, { allowRelayReferrer: false })) return true
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false
  // Chromium omits Sec-Fetch-Site on WebSocket upgrades. In that case,
  // require a proof issued to this admin on a same-origin HTTP request.
  try {
    if (!sameOrigin({ headers: { ...req.headers, 'sec-fetch-site': 'same-origin' } }, desktopPort) &&
        !isForwardedRelay(req, new URL(req.headers.origin)) && !isForwardedLAN(req, new URL(req.headers.origin), desktopPort)) return false
  } catch { return false }
  return hasOriginProof(req, core)
}

function requestURL(req) {
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) return
  try { return new URL(req.url, 'http://openclaw-fnos.local') } catch {}
}

function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function backendHeaders(req, port) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) =>
    !hop.has(name) && !name.startsWith('x-trim-') && !name.startsWith('x-forwarded-') &&
    !['forwarded', 'cookie', 'x-real-ip'].includes(name)))
  headers.host = '127.0.0.1:' + port
  if (headers.origin) headers.origin = 'http://' + headers.host
  return headers
}

function proxyHTTP(req, res, url, core, desktopPort) {
  const upstream = http.request({
    hostname: '127.0.0.1', port: core.port, method: req.method,
    path: url.pathname + url.search, headers: backendHeaders(req, core.port),
  }, response => {
    const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !hop.has(key)))
    // Keep referrers for same-origin imports, including imports from modules.
    headers['referrer-policy'] = 'same-origin'
    if (req.headers.origin || String(headers['content-type']).startsWith('text/html')) setOriginCookie(req, core, headers, desktopPort)
    if (String(headers['content-type']).startsWith('text/html')) {
      if (String(headers['content-security-policy']).includes("frame-ancestors 'none'")) {
        // Keep upstream script restrictions. Only permit embedding by the NAS shell.
        headers['content-security-policy'] = headers['content-security-policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'")
        headers['x-frame-options'] = 'SAMEORIGIN'
      }
    }
    response.on('error', () => res.destroy())
    res.writeHead(response.statusCode, headers)
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 503, { error: 'OpenClaw 网关暂不可用。' })
    else res.destroy()
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

function acceptAction(core, res, action, version, options) {
  if (action === 'update' && core.paused) {
    json(res, 409, { error: 'Gateway 已手动停止。请在维护结束后启动，再更新核心。' })
    return false
  }
  if (['update', 'rollback'].includes(action) && version === core.version) {
    json(res, 409, { error: '已是指定版本。' })
    return false
  }
  try {
    if (core.action(action, version, options)) return true
    json(res, 409, { error: '正在处理，请稍候。' })
  } catch (error) {
    core.log(error.message)
    json(res, 500, { error: '无法保存 Gateway 的启停状态，请查看日志。' })
  }
  return false
}

export function createServer(core, { desktopPort = FNOS_DESKTOP_PORT } = {}) {
  let lastRejection = 0
  const rejected = req => {
    if (!isAdmin(req) || Date.now() - lastRejection < 30000) return
    lastRejection = Date.now()
    // Deliberately omit origins, cookies, tokens and user/session identifiers.
    core.log?.('入口来源校验拒绝请求：' + JSON.stringify({
      transport: ['http', 'https'].includes(req.headers['x-forwarded-proto']) ? req.headers['x-forwarded-proto'] : 'missing/other',
      fetchSite: ['same-origin', 'cross-site', 'same-site', 'none'].includes(req.headers['sec-fetch-site']) ? req.headers['sec-fetch-site'] : 'missing',
      originPresent: Boolean(req.headers.origin), referrerPresent: Boolean(req.headers.referer), proofPresent: Boolean(req.headers.cookie?.includes(originCookie + '=')),
    }))
  }
  const server = http.createServer((req, res) => {
    const url = requestURL(req)
    if (!url || (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/'))) return json(res, 404, { error: '路径不存在。' })
    if (!isAdmin(req) || !httpOrigin(req, core, desktopPort)) {
      rejected(req)
      return json(res, 403, { error: '请通过飞牛管理员入口访问。' })
    }
    const route = url.pathname.slice(PREFIX.length)
    if (!route && req.method === 'GET') {
      res.writeHead(308, { location: PREFIX + '/' })
      return res.end()
    }
    if (route === '/' && req.method === 'GET') {
      const status = core.status()
      const page = shellTemplate.replace(/__FN_OPENCLAW_(STATUS|LOG|SCRIPT)__/g, (_, key) => {
        if (key === 'SCRIPT') return shellScript
        if (key === 'STATUS') return escapeHTML(phases[status.phase] + ' · ' + status.version)
        return escapeHTML(core.tail() || '暂无运行日志。')
      })
      const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': shellCSP,
        'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' }
      setOriginCookie(req, core, headers, desktopPort)
      res.writeHead(200, headers)
      return res.end(page)
    }
    if (route === '/favicon.png' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(fs.readFileSync(new URL('../ui/images/icon_64.png', import.meta.url)))
    }
    const file = files.get(route)
    if (req.method === 'GET' && file) {
      const [name, mime] = file
      res.writeHead(200, { 'content-type': mime + '; charset=utf-8', 'content-security-policy': shellCSP,
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(new URL('./' + name, import.meta.url)))
    }
    if (route === '/api/status' && req.method === 'GET') return json(res, 200, core.status())
    if (route === '/api/upstream' && req.method === 'GET') {
      return core.checkUpstream().then(value => json(res, 200, value))
        .catch(() => json(res, 503, { error: '无法检测上游版本，请检查网络后重试；当前内核不会改变。' }))
    }
    if (route === '/api/log' && req.method === 'GET') return json(res, 200, { log: core.tail() })
    if (route === '/api/snapshots' && req.method === 'GET') return json(res, 200, { snapshots: core.snapshots() })
    if (route === '/api/action' && req.method === 'POST') {
      if (req.headers['x-fn-openclaw-action'] !== '1') return json(res, 403, { error: '操作请求无效。' })
      const action = url.searchParams.get('action')
      if (action === 'cancel-update') { core.cancelUpdate = true; return json(res, 200, {}) }
      if (action === 'update') {
        const version = url.searchParams.get('version')
        if (!validVersion(version)) return json(res, 400, { error: '版本格式无效。' })
        if (acceptAction(core, res, action, version, { force: url.searchParams.get('force') === '1' })) return json(res, 202, {})
        return
      }
      if (action === 'rollback') {
        const restore = core.snapshots().find(item => item.name === url.searchParams.get('snapshot') && item.rollbackAvailable)
        if (!restore) return json(res, 400, { error: '没有可校验的回退快照。' })
        if (acceptAction(core, res, 'rollback', restore.version, { restore })) return json(res, 202, {})
        return
      }
      if (!['start', 'stop', 'restart'].includes(action)) return json(res, 400, { error: '未知操作。' })
      if (acceptAction(core, res, action)) return json(res, 202, {})
      return
    }
    if (route === '/open' && req.method === 'GET') {
      if (core.phase !== 'running' || core.available === false) return json(res, 503, { error: 'OpenClaw 正在维护或尚未启动。' })
      const headers = { location: UI_PATH + '/#token=' + core.token, 'referrer-policy': 'same-origin', 'cache-control': 'no-store' }
      setOriginCookie(req, core, headers, desktopPort)
      res.writeHead(303, headers)
      return res.end()
    }
    if (url.pathname === UI_PATH || url.pathname.startsWith(UI_PATH + '/')) {
      if (core.phase !== 'running' || core.available === false) return json(res, 503, { error: 'OpenClaw 正在维护或尚未启动。' })
      return proxyHTTP(req, res, url, core, desktopPort)
    }
    return json(res, 404, { error: '路径不存在。' })
  })
  server.on('upgrade', (req, socket, head) => {
    const url = requestURL(req)
    if (![UI_PATH, UI_PATH + '/'].includes(url?.pathname) ||
        !isAdmin(req) || !websocketOrigin(req, core, desktopPort) || core.phase !== 'running' || core.available === false) {
      rejected(req)
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    }
    const headers = backendHeaders(req, core.port)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    const upstream = http.request({
      hostname: '127.0.0.1', port: core.port, path: '/', method: 'GET', headers,
    })
    upstream.on('upgrade', (response, remote, rest) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        response.rawHeaders.reduce((lines, value, index) => lines + value + (index % 2 ? '\r\n' : ': '), '') + '\r\n')
      if (rest.length) socket.write(rest)
      if (head.length) remote.write(head)
      remote.on('error', () => socket.destroy())
      socket.on('close', () => remote.destroy())
      remote.on('close', () => socket.destroy())
      socket.pipe(remote).pipe(socket)
    })
    upstream.on('response', response => { response.resume(); socket.destroy() })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.end()
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { TRIM_APPDEST: app, TRIM_PKGVAR: data, TRIM_PKGETC: config, TRIM_PKGHOME: home } = process.env
  process.umask(0o077)
  const ca = '/etc/ssl/certs/ca-certificates.crt'
  const core = new Core({ data, config, home, npm: process.env.FN_OPENCLAW_NPM, ca: fs.existsSync(ca) && ca })
  const server = createServer(core)
  const socket = path.join(app, 'app.sock')
  const adminSocket = path.join(data, 'run', 'core-control.sock')
  if (fs.existsSync(adminSocket)) {
    if (!fs.lstatSync(adminSocket).isSocket()) throw new Error('Core control socket path is occupied')
    fs.unlinkSync(adminSocket)
  }
  // Local CLI and console share the same lifecycle controls.
  const admin = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/status') return json(res, 200, core.status())
    if (req.method === 'GET' && req.url === '/snapshots') return json(res, 200, { snapshots: core.snapshots() })
    if (req.method === 'GET' && req.url === '/check-updates') {
      try { return json(res, 200, await core.checkUpstream()) }
      catch { return json(res, 503, { error: '无法检测上游版本，请检查网络后重试。' }) }
    }
    if (req.method === 'POST' && req.url === '/cancel-update') { core.cancelUpdate = true; return json(res, 200, {}) }
    const localURL = requestURL(req)
    if (req.method === 'POST' && localURL?.pathname.startsWith('/rollback/')) {
      const restore = core.snapshots().find(item => item.name === localURL.pathname.slice('/rollback/'.length) && item.rollbackAvailable)
      if (!restore) return json(res, 400, { error: '没有可校验的回退快照。' })
      if (acceptAction(core, res, 'rollback', restore.version, { restore })) return json(res, 202, {})
      return
    }
    const action = req.url?.slice(1)
    if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
      if (!acceptAction(core, res, action)) return
      if (action !== 'stop') return json(res, 202, {})
      await core.job
      const status = core.status()
      return json(res, status.phase === 'stopped' ? 200 : 500, status)
    }
    const version = localURL?.pathname.slice('/update/'.length)
    if (req.method !== 'POST' || !localURL?.pathname.startsWith('/update/') || !validVersion(version)) return json(res, 400, { error: '版本格式无效。' })
    if (acceptAction(core, res, 'update', version, { force: localURL.searchParams.get('force') === '1' })) return json(res, 202, {})
  })
  admin.listen(adminSocket)
  server.listen(socket, () => {
    fs.chmodSync(socket, 0o600)
    core.action(core.paused ? 'stop' : 'boot')
  })
  const stop = async () => {
    if (core.closing) return
    admin.close()
    server.close()
    try { await core.close(); process.exit(0) }
    catch (error) { console.error(error.message); process.exit(1) }
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
