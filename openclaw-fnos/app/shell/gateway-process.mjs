import fs from 'node:fs'

export const INSTANCE_ENV = 'FN_OPENCLAW_GATEWAY_INSTANCE'

function readProc(callback) {
  try { return callback() }
  catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return undefined
    throw error
  }
}

function processIdentity(pid) {
  const stat = readProc(() => fs.readFileSync('/proc/' + pid + '/stat', 'utf8'))
  if (!stat) return
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  if (fields[0] === 'Z' || fields[0] === 'X') return
  return { pid, group: Number(fields[2]), session: Number(fields[3]), started: fields[19] }
}

export function isSameProcess(owner) {
  return processIdentity(owner.pid)?.started === owner.started
}

export function findGatewayProcesses(entry, env, instance) {
  if (process.platform !== 'linux') return []
  const executable = fs.realpathSync(process.execPath)
  const expected = {
    [INSTANCE_ENV]: instance,
    OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_GATEWAY_PORT: env.OPENCLAW_GATEWAY_PORT,
    OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN,
  }
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    const proc = '/proc/' + name
    const owner = processIdentity(Number(name))
    if (!owner) return []
    const command = readProc(() => fs.readFileSync(proc + '/cmdline', 'utf8').split('\0'))
    if (!command) return []
    const index = command.indexOf(entry)
    if (command[0] !== 'openclaw-gateway' &&
        (index < 1 || command[index + 1] !== 'gateway' || command[index + 2] !== 'run')) return []
    if (readProc(() => fs.statSync(proc).uid) !== process.getuid() ||
        readProc(() => fs.readlinkSync(proc + '/exe')) !== executable) return []
    const variables = readProc(() => new Set(fs.readFileSync(proc + '/environ', 'utf8').split('\0')))
    return variables && Object.entries(expected).every(([key, value]) => variables.has(key + '=' + value)) &&
      isSameProcess(owner) ? [owner] : []
  })
}

export function ownsGatewayListener(owner, port) {
  if (!isSameProcess(owner)) return false
  const endpoint = '0100007F:' + port.toString(16).padStart(4, '0').toUpperCase()
  const wildcard = '00000000:' + endpoint.split(':')[1]
  const sockets = fs.readFileSync('/proc/net/tcp', 'utf8').split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(row => row[3] === '0A' && (row[1] === endpoint || row[1] === wildcard))
  if (sockets.length !== 1 || sockets[0][1] !== endpoint) return false
  const target = 'socket:[' + sockets[0][9] + ']'
  const fdPath = '/proc/' + owner.pid + '/fd/'
  const descriptors = readProc(() => fs.readdirSync(fdPath))
  return Boolean(descriptors?.some(fd => readProc(() => fs.readlinkSync(fdPath + fd)) === target)) &&
    isSameProcess(owner)
}
