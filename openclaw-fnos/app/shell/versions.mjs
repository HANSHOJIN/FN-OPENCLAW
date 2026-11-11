import fs from 'node:fs'

export const validVersion = value => /^\d{4}\.\d{1,2}\.\d{1,3}(?:-\d{1,3})?$/.test(value)

export function compareVersions(left, right) {
  if (!validVersion(left) || !validVersion(right)) return null
  const a = left.split(/[.-]/).map(Number)
  const b = right.split(/[.-]/).map(Number)
  for (let i = 0; i < 4; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return Math.sign((a[i] || 0) - (b[i] || 0))
  }
  return 0
}

export function frameworkVersion({ env = process.env, versionFile = new URL('../framework-version', import.meta.url),
  manifestFile = new URL('../../manifest', import.meta.url) } = {}) {
  if (validVersion(env.TRIM_APPVER)) return env.TRIM_APPVER
  try {
    const value = fs.readFileSync(versionFile, 'utf8').trim()
    if (validVersion(value)) return value
  } catch { /* Development checkouts read the source manifest instead. */ }
  try {
    const value = fs.readFileSync(manifestFile, 'utf8').match(/^version\s*=\s*(\S+)\s*$/m)?.[1]
    if (validVersion(value)) return value
  } catch { /* Never guess the framework version from the core version. */ }
  return 'unknown'
}

export class UpstreamVersions {
  constructor({ fetcher = globalThis.fetch, now = Date.now } = {}) {
    this.fetcher = fetcher
    this.now = now
  }

  async check() {
    if (this.cached && this.now() - this.cached.checkedAt < 60000) return this.cached
    if (this.pending) return this.pending
    this.pending = (async () => {
      const response = await this.fetcher('https://registry.npmjs.org/openclaw/latest', {
        headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000),
      })
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel()
        throw new Error('无法读取上游版本信息，请稍后重试。')
      }
      const reader = response.body.getReader()
      const chunks = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > 1024 * 1024) throw new Error('上游版本信息超出预期大小。')
          chunks.push(Buffer.from(value))
        }
      } finally { await reader.cancel().catch(() => {}) }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (value.name !== 'openclaw' || !validVersion(value.version)) throw new Error('上游未返回可用的正式版本。')
      this.cached = { latest: value.version, checkedAt: this.now() }
      return this.cached
    })()
    try { return await this.pending }
    finally { this.pending = undefined }
  }
}
