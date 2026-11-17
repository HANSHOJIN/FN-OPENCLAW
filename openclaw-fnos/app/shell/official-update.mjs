import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MIGRATION_MESSAGE = '本次升级需要迁移会话，请等待 FN-OPENCLAW 框架安装包。'
export const FRAMEWORK_MESSAGE = '当前安装方式不能通过官方命令直接升级，请等待 FN-OPENCLAW 框架安装包。'

const migrationCodes = new Set([
  'session-migration-required', 'session-sqlite-migration-required',
  'legacy-session-store-migration-required', 'legacy-session-store',
  'session-schema-migration-required',
])

export function assessOfficialPlan(report) {
  const steps = Array.isArray(report?.steps) ? report.steps.slice(0, 100) : []
  const facts = steps.flatMap(step => Array.isArray(step?.failureFacts) ? step.failureFacts.slice(0, 30) : [])
  const reasons = [report?.reason, ...facts.map(fact => fact?.code)].filter(value => typeof value === 'string')
  const diagnostics = [
    ...facts.map(fact => fact?.message), ...steps.map(step => step?.stderrTail),
    ...(Array.isArray(report?.notes) ? report.notes.slice(0, 100) : []),
  ].filter(value => typeof value === 'string').map(value => value.slice(0, 12000))
  const migrationRequired = reasons.some(code => migrationCodes.has(code)) ||
    diagnostics.some(value => /\bLegacy session store requires migration\b/i.test(value))
  // dry-run is a preview, not candidate-owned admission. It must not authorise
  // our old npm/copy-state flow, even if a future CLI emits a successful plan.
  const code = migrationRequired ? 'session-migration-required' :
    reasons.includes('unmanaged-package-install') || reasons.includes('installation-unclassified') ? 'unmanaged-package-install' :
      report?.status === 'error' || report?.status === 'failed' ? 'official-update-refused' : 'official-handoff-unavailable'
  return {
    allowed: false, requiresFramework: true, migrationRequired, code,
    message: migrationRequired ? MIGRATION_MESSAGE : code === 'unmanaged-package-install' ? FRAMEWORK_MESSAGE :
      '官方检查未确认可以直接升级，请等待 FN-OPENCLAW 框架安装包。',
    officialStatus: typeof report?.status === 'string' ? report.status.slice(0, 64) : 'unknown',
    officialMode: typeof report?.mode === 'string' ? report.mode.slice(0, 64) : 'unknown',
    ...(typeof report?.reason === 'string' && /^[a-z][a-z0-9-]{0,119}$/.test(report.reason) ? { officialReason: report.reason } : {}),
  }
}

export async function inspectOfficialUpdate(core, target) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-openclaw-update-check-'))
  const state = path.join(scratch, 'state'), home = path.join(scratch, 'home')
  fs.mkdirSync(state, { mode: 0o700 });fs.mkdirSync(home, { mode: 0o700 })
  try {
    // Inspect the real installation with the official CLI, but keep its optional
    // preview reports/history in a disposable profile. A fresh profile can prove
    // this install is unsupported; it cannot prove live session compatibility.
    const report = await core.cliJSON(core.version,
      ['update', '--tag', target, '--dry-run', '--json', '--timeout', '15'], {
        timeout: 25000, allowFailure: true,
        env: {
          HOME: home, USERPROFILE: home, OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
          OPENCLAW_GATEWAY_TOKEN: '',
        },
      })
    return assessOfficialPlan(report)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
