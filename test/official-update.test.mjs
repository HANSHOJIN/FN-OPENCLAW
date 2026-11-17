import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { assessOfficialPlan, inspectOfficialUpdate, MIGRATION_MESSAGE, FRAMEWORK_MESSAGE } from '../openclaw-fnos/app/shell/official-update.mjs'

test('the real unmanaged package refusal requires a framework package without claiming session migration', () => {
  const decision = assessOfficialPlan({ status: 'skipped', mode: 'unknown', reason: 'unmanaged-package-install',
    steps: [{ failureFacts: [{ check: 'installation-inspection', code: 'installation-unclassified' }], stderrTail: 'private paths and diagnostics' }] })
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, 'unmanaged-package-install')
  assert.equal(decision.migrationRequired, false)
  assert.equal(decision.message, FRAMEWORK_MESSAGE)
  assert.ok(!JSON.stringify(decision).includes('private paths'))
})

test('an explicit official session migration requirement gets the requested message', () => {
  for (const report of [
    { status: 'error', reason: 'session-sqlite-migration-required' },
    { status: 'error', reason: 'database-schema-preflight', steps: [{ failureFacts: [{ code: 'legacy-session-store-migration-required' }] }] },
    { status: 'skipped', reason: 'database-schema-preflight', steps: [{ stderrTail: 'Legacy session store requires migration: /private/profile/agents/main/sessions/sessions.json' }] },
  ]) {
    const decision = assessOfficialPlan(report)
    assert.equal(decision.allowed, false)
    assert.equal(decision.migrationRequired, true)
    assert.equal(decision.message, MIGRATION_MESSAGE)
  }
})

test('unknown, failed and successful previews cannot authorise the retired state-copy upgrade flow', () => {
  for (const report of [null, {}, { status: 'error', reason: 'registry-unavailable' },
    { dryRun: true, mode: 'npm', currentVersion: '2026.11.3', targetVersion: '2026.11.4', notes: [] },
    { status: 'ok', migrationRequired: false, mode: 'npm' }]) {
    const decision = assessOfficialPlan(report)
    assert.equal(decision.allowed, false)
    assert.equal(decision.requiresFramework, true)
    assert.equal(decision.migrationRequired, false)
  }
})

for (const fails of [false, true]) {
  test('official preview reports use a disposable profile which is removed on ' + (fails ? 'failure' : 'success'), async () => {
    let scratch, state
    const core = {
      version: '2026.11.3',
      cliJSON: async (version, args, options) => {
        assert.equal(version, '2026.11.3')
        assert.deepEqual(args, ['update', '--tag', '2026.11.4', '--dry-run', '--json', '--timeout', '15'])
        assert.equal(options.allowFailure, true)
        scratch = options.env.HOME;state = options.env.OPENCLAW_STATE_DIR
        assert.ok(fs.existsSync(scratch) && fs.existsSync(state))
        assert.equal(options.env.OPENCLAW_GATEWAY_TOKEN, '')
        fs.writeFileSync(state + '/official-preview-report.json', '{}')
        if (fails) throw new Error('fixture: CLI timed out')
        return { status: 'skipped', reason: 'unmanaged-package-install' }
      },
    }
    if (fails) await assert.rejects(inspectOfficialUpdate(core, '2026.11.4'), /timed out/)
    else assert.equal((await inspectOfficialUpdate(core, '2026.11.4')).code, 'unmanaged-package-install')
    assert.equal(fs.existsSync(scratch), false)
    assert.equal(fs.existsSync(state), false)
  })
}
