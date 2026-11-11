const byId = id => document.getElementById(id)
const statusLabel = byId('status')
const toolbar = byId('toolbar')
const dockToolbar = createTitlebarDock(toolbar, byId('toolbar-slot'))
const standaloneURL = new URL('./open', window.location.href).href
const power = byId('power')
const restart = byId('restart')
const logs = byId('logs')
const standalone = byId('standalone')
const frame = byId('control')
const log = byId('log')
const consolePanel = byId('console')
const notice = byId('gateway-notice')
const menuToggle = byId('menu-toggle')
const menuPanel = byId('menu-panel')
const maintenance = byId('maintenance')
const phases = __FN_OPENCLAW_PHASES__
watchControlTheme(frame, toolbar)

let status
let showLogs = false
let generation
let pending = false
let connectionError = ''
let actionError = ''
let upstream
let checkingUpstream = false
let checkedUpstream = false
let upstreamError = ''

function scrollLogToEnd() {
  log.scrollTop = log.scrollHeight
}

function statusText() {
  if (!status) return '正在连接…'
  const parts = [phases[status.phase], status.version]
  if (status.paused) parts.push('自动恢复已暂停')
  if (status.retryAt) parts.push(Math.max(0, Math.ceil((status.retryAt - Date.now()) / 1000)) + ' 秒后重试')
  if (status.retryExhausted) parts.push('已停止自动重试')
  if (status.failure) parts.push(status.failure)
  return parts.join(' · ')
}

function canStop() {
  return ['running', 'retrying'].includes(status?.phase)
}

function render() {
  dockToolbar()
  const running = status?.phase === 'running' && status.available !== false
  const locked = pending || !status || status.busy
  const update = status?.maintenance
  statusLabel.textContent = connectionError || actionError || statusText()
  toolbar.title = statusLabel.textContent
  notice.hidden = !status?.failure && !(status?.busy && ['downloading', 'waiting', 'snapshot', 'starting'].includes(update?.stage))
  notice.textContent = status?.failure ? statusText() : update?.message || ''
  power.textContent = canStop() ? '停止' : '启动'
  power.disabled = locked
  restart.disabled = locked || !running
  if (running) standalone.href = standaloneURL
  else standalone.removeAttribute('href')
  standalone.setAttribute('aria-disabled', String(!running))

  if (!running && generation !== undefined) {
    frame.removeAttribute('src')
    generation = undefined
  }
  if (running && generation !== status.generation) {
    generation = status.generation
    showLogs = false
    frame.src = './open'
  }
  const wasLogHidden = log.hidden
  consolePanel.hidden = running && !showLogs
  log.hidden = consolePanel.hidden
  frame.hidden = !consolePanel.hidden
  logs.setAttribute('aria-pressed', String(!consolePanel.hidden))
  if (wasLogHidden && !consolePanel.hidden) scrollLogToEnd()
  byId('update-status').textContent = update ? update.message + (Number.isFinite(update.activeCount) ? ' 活动任务：' + update.activeCount : '') : '尚未执行更新。'
  const findings = update?.audit?.findings || []
  byId('audit-summary').textContent = update?.audit ? 'Gateway 与会话库读取通过。兼容性提示：' + findings.length + ' 项。\n' + findings.map(f => (f.severity === 'error' ? '错误：' : '提示：') + f.message).join('\n') : ''
  byId('apply-update').disabled = locked || !running
  byId('cancel-update').disabled = !status?.busy || !['downloading', 'waiting'].includes(update?.stage)
  byId('framework-version').textContent = status?.frameworkVersion && status.frameworkVersion !== 'unknown' ? status.frameworkVersion : '未知'
  byId('core-version').textContent = status?.version || '未知'
  const versions = status?.upstream || upstream
  byId('upstream-version').textContent = versions?.latest || (checkingUpstream ? '检测中…' : '尚未检测')
  byId('check-upstream').disabled = !status || checkingUpstream
  const canUpdate = versions?.current === status?.version && versions?.updateAvailable
  byId('console-update').disabled = locked || !running || !canUpdate
  byId('console-update').title = !running ? '启动服务后可更新内核' : !canUpdate ? '检测到新版本后可更新' : '更新到 ' + versions.latest
  byId('console-rollback').disabled = locked || !status?.rollback
  byId('console-rollback').title = status?.rollback ? '恢复到 ' + status.rollback.version + ' 并启动' : '暂无经过校验的上次回滚快照'
  const result = checkingUpstream ? '正在检测上游正式版本…' : upstreamError ||
    (versions ? (versions.current !== status?.version ? '内核版本已变化，请重新检测。' : canUpdate ? '可更新到 ' + versions.latest : versions.comparison === -1 ? '当前内核高于上游正式版本。' : '当前已是最新内核。') +
      (Number.isFinite(versions.checkedAt) ? ' 检测时间：' + new Date(versions.checkedAt).toLocaleString() : '') : '尚未检测上游版本。')
  byId('upstream-result').textContent = result
  byId('console-maintenance').textContent = update?.message || ''
  if (!consolePanel.hidden && status && !checkedUpstream) {
    checkedUpstream = true
    queueMicrotask(checkUpstream)
  }
}

async function api(path, options) {
  const { timeoutMs = 5000, ...requestOptions } = options || {}
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('./api/' + path, { cache: 'no-store', signal: controller.signal, ...requestOptions })
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '无法连接应用壳。')
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('飞牛登录未通过，请从桌面重新打开应用。')
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function refresh() {
  try {
    status = await api('status')
    connectionError = ''
    render()
    if (!log.hidden) {
      const { log: content } = await api('log')
      if (log.hidden) return
      const text = content || '暂无运行日志。'
      if (log.textContent !== text) {
        const scrollTop = log.scrollTop
        const followLatest = log.scrollHeight - scrollTop - log.clientHeight < 24
        log.textContent = text
        if (followLatest) scrollLogToEnd()
        else log.scrollTop = scrollTop
      }
    }
  } catch (error) {
    status = undefined
    connectionError = error.message
    render()
  }
}

async function action(name, params = {}) {
  pending = true
  actionError = ''
  render()
  try { await api('action?' + new URLSearchParams({ action: name, ...params }), { method: 'POST', headers: { 'X-FN-OpenClaw-Action': '1' } }) }
  catch (error) { actionError = error.message }
  finally {
    await refresh()
    pending = false
    render()
  }
}

power.addEventListener('click', () => action(canStop() ? 'stop' : 'start'))
restart.addEventListener('click', () => action('restart'))
logs.addEventListener('click', () => { showLogs = !showLogs; render() })

async function checkUpstream() {
  if (checkingUpstream) return
  checkedUpstream = true
  checkingUpstream = true
  upstreamError = ''
  render()
  try { upstream = await api('upstream', { timeoutMs: 12000 }) }
  catch (error) { upstreamError = error.message }
  finally { checkingUpstream = false; render() }
}
byId('check-upstream').addEventListener('click', checkUpstream)
byId('console-update').addEventListener('click', () => {
  const versions = status?.upstream || upstream
  if (!versions?.updateAvailable || versions.current !== status?.version) return
  byId('target-version').value = versions.latest
  byId('force-update').checked = false
  showMaintenance()
})
byId('console-rollback').addEventListener('click', () => {
  const point = status?.rollback
  if (!point || status.busy) return
  if (!window.confirm('恢复到 ' + point.version + ' 的上次快照并启动？快照之后的会话变动将先备份，之后可通过新快照找回。')) return
  action('rollback', { snapshot: point.name })
})

function closeMenu() { menuPanel.hidePopover() }
menuToggle.addEventListener('click', () => {
  if (menuPanel.matches(':popover-open')) return closeMenu()
  const rect = menuToggle.getBoundingClientRect()
  const viewport = toolbar.ownerDocument.defaultView
  menuPanel.style.top = Math.max(8, Math.min(rect.bottom + 4, viewport.innerHeight - 230)) + 'px'
  menuPanel.style.left = Math.max(8, Math.min(rect.right - 180, viewport.innerWidth - 188)) + 'px'
  menuPanel.showPopover()
})
menuPanel.addEventListener('toggle', event => menuToggle.setAttribute('aria-expanded', String(event.newState === 'open')))
menuPanel.addEventListener('click', event => { if (event.target.closest('button, a')) closeMenu() })

async function showMaintenance() {
  maintenance.showModal()
  byId('snapshot-list').textContent = '正在读取快照…'
  try {
    const { snapshots } = await api('snapshots')
    const container = byId('snapshot-list')
    container.replaceChildren()
    if (!snapshots.length) container.textContent = '暂无快照。'
    for (const item of snapshots) {
      const row = document.createElement('p')
      const size = Number.isFinite(item.bytes) ? (item.bytes / 1024 ** 2).toFixed(1) + ' MB' : '大小未登记'
      row.append((item.version || '旧版快照') + ' · ' + size + ' · ' + (item.verified ? 'SHA256 已登记' : '未校验'))
      if (item.rollbackAvailable && item.version !== status?.version) {
        const button = document.createElement('button')
        button.textContent = '回退'
        button.disabled = Boolean(status?.busy)
        button.addEventListener('click', async () => {
          if (!window.confirm('回退到 ' + item.version + ' 的状态？此快照之后的会话变动不会出现在回退后的实例中；当前状态将另行备份。')) return
          await action('rollback', { snapshot: item.name })
          button.disabled = true
        })
        row.append(button)
      }
      container.append(row)
    }
  } catch (error) { byId('snapshot-list').textContent = error.message }
}
byId('updates').addEventListener('click', showMaintenance)
byId('close-maintenance').addEventListener('click', () => maintenance.close())
byId('apply-update').addEventListener('click', () => {
  const version = byId('target-version').value.trim()
  if (!/^\d{4}\.\d{1,2}\.\d{1,3}(?:-\d{1,3})?$/.test(version)) { byId('update-status').textContent = '请填写有效版本号。'; return }
  const force = byId('force-update').checked
  if (force && !window.confirm('确定中断活动任务和终端，并切换版本？待保存数据仍须先完成写入。')) return
  action('update', { version, force: force ? '1' : '0' })
})
byId('cancel-update').addEventListener('click', () => action('cancel-update'))

async function poll() {
  await refresh()
  setTimeout(poll, 1000)
}
scrollLogToEnd()
poll()
