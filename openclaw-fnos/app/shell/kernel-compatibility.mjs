import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { FRAMEWORK_MESSAGE, MIGRATION_MESSAGE } from './official-update.mjs'

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function kernelConfigHash(core) {
  const config = fs.readFileSync(ownedFile(core.stateDir, core.env.OPENCLAW_CONFIG_PATH))
  if (config.includes('$include')) throw new Error('当前配置引用了外部文件，无法验证在线切换。' + FRAMEWORK_MESSAGE)
  return createHash('sha256').update(config).digest('hex')
}

export function verifyLocalDatabaseConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('无法读取当前 Gateway 的数据库配置。')
  const db = config.database ?? {}
  if ((db.engine && db.engine !== 'sqlite') ||
      Object.entries(db.families ?? {}).some(([name, engine]) => engine !== 'sqlite' || !['state', 'agent'].includes(name)) ||
      config.session?.store || config.agents?.list?.some(agent => agent.agentDir)) {
    throw new Error('在线更新暂只支持应用目录内的默认 SQLite 会话库。' + FRAMEWORK_MESSAGE)
  }
}

function ownedFile(root, file) {
  try {
    if (!path.isAbsolute(file) || !fs.lstatSync(root).isDirectory() || !fs.lstatSync(file).isFile() ||
        fs.realpathSync(file) !== path.join(fs.realpathSync(root), path.relative(root, file)) ||
        path.relative(root, file).split(path.sep).includes('..')) {
      throw new Error('会话数据库位于应用目录之外或为链接。' + FRAMEWORK_MESSAGE)
    }
    return file
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到需要验证的数据库。' + FRAMEWORK_MESSAGE)
    throw error
  }
}

async function copyDatabase(root, file, destination, checkCancelled) {
  checkCancelled()
  const db = new DatabaseSync(ownedFile(root, file), { readOnly: true, timeout: 5000 })
  try {
    await backup(db, destination)
  } finally {
    db.close()
  }
  checkCancelled()
  const copy = new DatabaseSync(destination)
  try { copy.exec('PRAGMA journal_mode=DELETE') }
  finally { copy.close() }
}

function listAgentStores(root, sharedCopy) {
  const db = new DatabaseSync(sharedCopy, { readOnly: true })
  let records
  try { records = db.prepare('SELECT agent_id, path FROM agent_databases').all() }
  finally { db.close() }
  const agents = path.join(root, 'agents')
  if (fs.existsSync(agents) && !fs.lstatSync(agents).isDirectory()) {
    throw new Error('代理目录为外部链接。' + FRAMEWORK_MESSAGE)
  }
  for (const id of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
    const dir = path.join(agents, id)
    const stat = fs.lstatSync(dir)
    if (stat.isSymbolicLink()) throw new Error('代理目录为外部链接。' + FRAMEWORK_MESSAGE)
    if (!stat.isDirectory()) continue
    const file = path.join(dir, 'agent', 'openclaw-agent.sqlite')
    if (fs.existsSync(path.join(dir, 'sessions', 'sessions.json'))) throw new Error(MIGRATION_MESSAGE)
    if (fs.existsSync(file)) records.push({ agent_id: id, path: file })
  }
  const stores = new Map()
  const physicalAgents = path.join(fs.realpathSync(root), 'agents')
  for (const { agent_id: id, path: file } of records) {
    if (typeof id !== 'string' || !AGENT_ID.test(id)) throw new Error('代理数据库归属无法核对。' + FRAMEWORK_MESSAGE)
    const relative = path.join(id, 'agent', 'openclaw-agent.sqlite')
    const expected = path.join(agents, relative)
    const registered = typeof file === 'string' ? file.split('/').join(path.sep) : undefined
    if (registered !== path.join('agents', relative) && registered !== expected && registered !== path.join(physicalAgents, relative)) {
      throw new Error('发现使用自定义路径的代理数据库。' + FRAMEWORK_MESSAGE)
    }
    stores.set(expected, id)
  }
  return stores
}

function verifyReport(report, kind, id) {
  if (report?.schema !== 'openclaw.' + kind + '-schema-preflight.v1' ||
      (id && report.agentId !== id)) throw new Error('候选版本未提供可验证的数据库报告。' + FRAMEWORK_MESSAGE)
  if (report.status === 'migration-required' ||
      (Number.isSafeInteger(report.foundVersion) && Number.isSafeInteger(report.targetVersion) &&
        report.foundVersion < report.targetVersion)) throw new Error(MIGRATION_MESSAGE)
  if (report.status !== 'exact') throw new Error('候选版本未确认数据库完全兼容。' + FRAMEWORK_MESSAGE)
}

export async function preflightKernelDatabases(core, version) {
  const checkCancelled = () => {
    if (core.cancelUpdate || core.closing) throw new Error('已取消更新，当前版本继续运行。')
  }
  const scratch = fs.mkdtempSync(path.join(core.data, 'kernel-check-'))
  const root = core.stateDir
  const stateCopy = path.join(scratch, 'shared.sqlite')
  const env = { HOME: scratch, USERPROFILE: scratch, OPENCLAW_HOME: scratch, OPENCLAW_STATE_DIR: scratch,
    OPENCLAW_CONFIG_PATH: path.join(scratch, 'openclaw.json'), OPENCLAW_GATEWAY_TOKEN: '' }
  const inspect = args => {
    const bytes = fs.statSync(args[1]).size
    const timeout = Math.min(12 * 60 * 60 * 1000, 180000 + Math.ceil(bytes / 1024 ** 3) * 180000)
    return core.cliJSON(version, ['database', ...args, '--json'], { env, timeout, allowFailure: true })
  }
  try {
    await copyDatabase(root, path.join(root, 'state', 'openclaw.sqlite'), stateCopy, checkCancelled)
    verifyReport(await inspect(['preflight', stateCopy]), 'state')
    checkCancelled()
    const stores = listAgentStores(root, stateCopy)
    fs.unlinkSync(stateCopy)
    const agentCopy = path.join(scratch, 'agent.sqlite')
    for (const [file, id] of stores) {
      await copyDatabase(root, file, agentCopy, checkCancelled)
      verifyReport(await inspect(['preflight-agent', agentCopy, '--agent-id', id]), 'agent', id)
      checkCancelled()
      fs.unlinkSync(agentCopy)
    }
    return stores.size
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
