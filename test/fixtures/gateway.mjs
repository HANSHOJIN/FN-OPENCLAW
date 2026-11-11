import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const { OPENCLAW_STATE_DIR: state, OPENCLAW_GATEWAY_PORT: port } = process.env
const [mode, successor] = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-mode'), 'utf8').trim().split(',')
if (process.argv[3] === 'call') {
  const params = JSON.parse(process.argv[process.argv.indexOf('--params') + 1])
  const response = await fetch('http://127.0.0.1:' + port + '/fixture/rpc', { method: 'POST', body: JSON.stringify({ method: process.argv[4], params }) })
  console.log(await response.text())
  process.exit(0)
}
if (process.argv[2] === 'doctor') {
  console.log(JSON.stringify({ findings: [] }))
  process.exit(0)
}
if (mode === 'fail') {
  fs.writeFileSync(path.join(state, 'sample.txt'), 'failed candidate')
  console.error('fixture: could not start')
  process.exit(42)
}
const isSuccessor = process.env.FN_TEST_SUCCESSOR === '1'
let lease
const server = http.createServer(async (req, res) => {
  if (req.url === '/fixture/rpc') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { method, params } = JSON.parse(body)
    let value = {}
    if (method === 'system.info') value = { pid: process.pid, processInstanceId: 'fixture' }
    if (method === 'gateway.suspend.prepare') lease = { suspensionId: 'fixture-lease', expiresAtMs: Date.now() + 45000 }
    if (method.startsWith('gateway.suspend.')) value = { ...lease, status: 'ready', activeCount: 0, blockers: [], writeCustody: [] }
    if (method === 'gateway.suspend.handoff') value.status = 'committed'
    if (method === 'gateway.suspend.status') value = { status: 'ready', expiresAtMs: lease.expiresAtMs, writeCustody: [] }
    if (method === 'sessions.list') value = mode === 'broken-sessions' ? {} : { sessions: [], count: 0 }
    if (method === 'gateway.suspend.resume') { fs.writeFileSync(path.join(state, 'resumed'), 'yes'); value = { status: 'running' } }
    res.end(JSON.stringify(value))
  } else if (req.url === '/replace' && !isSuccessor && successor) {
    res.setHeader('connection', 'close')
    res.end('replacing')
    server.close(() => {
      const child = spawn(process.execPath, process.argv.slice(1), {
        env: { ...process.env, FN_TEST_SUCCESSOR: '1' },
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      process.exit(0)
    })
  } else if (req.url === '/pid') {
    res.end(String(process.pid))
  } else if (req.url === '/startupz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, status: 'started' }))
  } else if (req.url === '/readyz') {
    const ready = mode !== 'channel-offline'
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ready, coreReady: true, failing: ready ? [] : ['whatsapp'] }))
  } else {
    res.end('<openclaw-app></openclaw-app>')
  }
})
server.listen(Number(port), '127.0.0.1')
