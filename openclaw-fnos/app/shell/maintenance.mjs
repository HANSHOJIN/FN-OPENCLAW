import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export const snapshotName = value => /^snapshot-[a-f0-9]{16}$/.test(value)

// Do not follow workspace symlinks: a state snapshot does not own external data.
export async function inspectTree(root) {
  if (!(await fs.promises.lstat(root)).isDirectory()) throw new Error('快照目录无效。')
  const digest = createHash('sha256')
  let bytes = 0
  let files = 0
  async function visit(relative) {
    const absolute = path.join(root, relative)
    const stat = await fs.promises.lstat(absolute)
    if (stat.isSymbolicLink()) {
      digest.update(JSON.stringify(['link', relative, await fs.promises.readlink(absolute)]) + '\n')
    } else if (stat.isDirectory()) {
      digest.update(JSON.stringify(['dir', relative]) + '\n')
      for (const entry of (await fs.promises.readdir(absolute)).sort()) await visit(path.join(relative, entry))
    } else if (stat.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk)
      bytes += stat.size
      files += 1
      digest.update(JSON.stringify(['file', relative, stat.size, hash.digest('hex')]) + '\n')
    } else throw new Error('状态目录包含不支持备份的特殊文件。')
  }
  await visit('')
  return { sha256: digest.digest('hex'), bytes, files }
}

export async function prepareUpgrade(core, { force = false } = {}) {
  let lease
  let suspensionId
  let committed = false
  try {
    const identity = await core.rpc('system.info')
    if (!Number.isSafeInteger(identity.pid) || !identity.processInstanceId) throw new Error('无法核对当前 Gateway 身份。')
    lease = await core.rpc('gateway.suspend.prepare', {
      requestId: 'fn-openclaw-' + randomUUID(), drain: true,
      terminalPolicy: force ? 'terminate' : 'preserve',
    })
    if (!lease.suspensionId || !Number.isFinite(lease.expiresAtMs)) throw new Error('当前 Gateway 无法提供维护窗口。')
    const id = lease.suspensionId
    const expiresAtMs = lease.expiresAtMs
    suspensionId = id
    while (!core.closing && !core.cancelUpdate) {
      const status = await core.rpc('gateway.suspend.status', { suspensionId: id, includeLifecycle: true })
      // Upstream status replies omit the ID; it is scoped by the request.
      // A ready reply may also omit the activity count and blockers.
      if ((status.suspensionId && status.suspensionId !== id) || status.expiresAtMs !== expiresAtMs) break
      lease = { ...status, suspensionId: id, activeCount: status.activeCount ?? (status.status === 'ready' ? 0 : undefined) }
      if (!Number.isFinite(lease.expiresAtMs) ||
          lease.expiresAtMs <= Date.now() + 10000 || !['ready', 'draining'].includes(lease.status)) break
      const blockers = (lease.blockers || []).map(({ kind, count }) => ({ kind, count }))
      core.updateProgress({ stage: 'waiting', message: force ? '正在准备强制切换。' : '等待活动任务结束，暂不切换版本。',
        activeCount: lease.activeCount, blockers, expiresAt: lease.expiresAtMs })
      if (core.cancelUpdate) break
      // Some upstream versions report ready while agent work is still active.
      // Independently require zero activity unless interruption was explicit.
      if (force || (lease.status === 'ready' && lease.activeCount === 0 && !blockers.some(b => b.count > 0))) {
        if (!Array.isArray(lease.writeCustody) || lease.writeCustody.some(b => b.count > 0)) {
          throw new Error('仍有待保存的数据，已取消切换。')
        }
        const handoff = {
          suspensionId: id, target: { pid: identity.pid, processInstanceId: identity.processInstanceId }, commit: true,
        }
        let result
        try { result = await core.rpc('gateway.suspend.handoff', handoff, { timeout: 30000 }) }
        catch {
          // Commit is idempotent for the same lease and process target. Recover
          // a lost reply without treating an uncertain commit as a fresh stop.
          result = await core.rpc('gateway.suspend.handoff', handoff, { timeout: 30000 })
        }
        if (result.status !== 'committed' || result.suspensionId !== id || result.expiresAtMs !== lease.expiresAtMs) {
          throw new Error('Gateway 未确认维护交接，已取消切换。')
        }
        committed = true
        return true
      }
      await delay(Math.min(5000, Math.max(100, lease.retryAfterMs || 5000)))
    }
    throw new Error(core.cancelUpdate ? '已取消更新，当前版本继续运行。' : '任务尚未结束或维护窗口已到期，本次更新已暂缓。')
  } catch (error) {
    core.updateProgress({ stage: 'deferred', message: error.message })
    core.log('更新暂缓：' + error.message)
    return false
  } finally {
    if (suspensionId && !committed) {
      try { await core.rpc('gateway.suspend.resume', { suspensionId }) }
      catch { core.log('未能确认维护窗口已释放；Gateway 会在租约到期后恢复接收任务。') }
    }
  }
}

export async function auditUpgrade(core, version) {
  if (!await core.gatewayReady({ verifyCore: true })) throw new Error('升级验收失败：网关或界面未就绪。')
  const sessions = await core.rpc('sessions.list', { limit: 1 }, { version })
  if (!Array.isArray(sessions.sessions)) throw new Error('升级验收失败：无法读取会话库。')
  const result = { gateway: true, sessions: true, sessionCount: sessions.count ?? sessions.sessions.length, findings: [] }
  try {
    const report = await core.cliJSON(version, ['doctor', '--lint', '--json'], { timeout: 60000, allowFailure: true })
    if (!Array.isArray(report.findings)) throw new Error('无法读取检查报告。')
    result.findings = report.findings.slice(0, 30).map(f => ({ checkId: f.checkId, severity: f.severity, message: String(f.message || '').replaceAll(core.token, '[redacted]').slice(0, 800) }))
  } catch {
    result.findings.push({ checkId: 'fn-openclaw/doctor', severity: 'warning', message: '只读兼容性检查未完成，请查看日志或运行 doctor --lint。' })
  }
  return result
}
