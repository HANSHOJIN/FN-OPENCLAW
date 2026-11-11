import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { frameworkVersion, compareVersions, UpstreamVersions } from '../openclaw-fnos/app/shell/versions.mjs'

test('version ordering handles calendar components and numeric release revisions', () => {
  assert.equal(compareVersions('2026.11.10', '2026.11.3'), 1)
  assert.equal(compareVersions('2026.11.3', '2026.11.3-1'), -1)
  assert.equal(compareVersions('2026.11.3', '2026.11.3'), 0)
  assert.equal(compareVersions('2026.11.3-beta', '2026.11.3'), null)
})

test('framework versions use the installed app version, shipped metadata, then the development manifest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fnc-version-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const versionFile = path.join(root, 'framework-version')
  const manifestFile = path.join(root, 'manifest')
  fs.writeFileSync(versionFile, '2026.11.3-1\n')
  fs.writeFileSync(manifestFile, 'appname=openclaw-fnos\nversion=2026.11.2-13\n')
  const options = { versionFile, manifestFile, env: { TRIM_APPVER: '2026.11.3-2' } }
  assert.equal(frameworkVersion(options), '2026.11.3-2')
  options.env = {}
  assert.equal(frameworkVersion(options), '2026.11.3-1')
  fs.unlinkSync(versionFile)
  assert.equal(frameworkVersion(options), '2026.11.2-13')
  fs.unlinkSync(manifestFile)
  assert.equal(frameworkVersion(options), 'unknown')
})

test('upstream checks share pending requests, cache successes and recover from network failures', async () => {
  let now = 1000
  let calls = 0
  let fail = false
  const service = new UpstreamVersions({ now: () => now, fetcher: async (url, options) => {
    calls++
    assert.equal(url, 'https://registry.npmjs.org/openclaw/latest')
    assert.equal(options.redirect, 'error')
    assert.deepEqual(options.headers, { accept: 'application/json' })
    if (fail) throw new Error('offline')
    return Response.json({ name: 'openclaw', version: '2026.11.4' })
  } })
  const [a, b] = await Promise.all([service.check(), service.check()])
  assert.equal(calls, 1)
  assert.deepEqual(a, b)
  assert.equal((await service.check()).checkedAt, 1000)
  assert.equal(calls, 1)
  now += 61000
  fail = true
  await assert.rejects(service.check(), /offline/)
  assert.equal(service.cached.latest, '2026.11.4')
  fail = false
  assert.equal((await service.check()).checkedAt, now)
  assert.equal(calls, 3)
})

for (const [name, response] of [
  ['HTML error page', () => new Response('<h1>bad gateway</h1>', { headers: { 'content-type': 'text/html' } })],
  ['HTTP failure', () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })],
  ['malformed JSON', () => new Response('not JSON', { headers: { 'content-type': 'application/json' } })],
  ['unrelated package', () => Response.json({ name: 'other', version: '2026.11.4' })],
  ['prerelease version', () => Response.json({ name: 'openclaw', version: '2026.11.4-beta.1' })],
  ['oversized metadata', () => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })],
]) {
  test('upstream discovery rejects ' + name, async () => {
    const service = new UpstreamVersions({ fetcher: async () => response() })
    await assert.rejects(service.check())
    assert.equal(service.cached, undefined)
  })
}
