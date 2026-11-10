import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const { OPENCLAW_STATE_DIR: state, OPENCLAW_GATEWAY_PORT: port } = process.env
const [mode, successor] = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-mode'), 'utf8').trim().split(',')
if (mode === 'fail') {
  fs.writeFileSync(path.join(state, 'sample.txt'), 'failed candidate')
  console.error('fixture: could not start')
  process.exit(42)
}
const isSuccessor = process.env.FN_TEST_SUCCESSOR === '1'
const server = http.createServer((req, res) => {
  if (req.url === '/replace' && !isSuccessor && successor) {
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
  } else {
    res.end(req.url === '/readyz' ? 'ready' : '<openclaw-app></openclaw-app>')
  }
})
server.listen(Number(port), '127.0.0.1')
