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
const notice = byId('gateway-notice')
const phases = __FN_OPENCLAW_PHASES__
watchControlTheme(frame, toolbar)

let status
let showLogs = false
let generation
let pending = false
let connectionError = ''
let actionError = ''

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
  const running = status?.phase === 'running'
  const locked = pending || !status || status.busy
  statusLabel.textContent = connectionError || actionError || statusText()
  toolbar.title = statusLabel.textContent
  notice.hidden = !status?.failure
  notice.textContent = notice.hidden ? '' : statusText()
  power.textContent = canStop() ? '停止' : '启动'
  power.disabled = locked
  restart.disabled = locked || !running
  logs.disabled = !running
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
  log.hidden = running && !showLogs
  frame.hidden = !log.hidden
  logs.setAttribute('aria-pressed', String(!log.hidden))
  if (wasLogHidden && !log.hidden) scrollLogToEnd()
}

async function api(path, options) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch('./api/' + path, { cache: 'no-store', signal: controller.signal, ...options })
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

async function action(name) {
  pending = true
  actionError = ''
  render()
  try { await api('action?action=' + name, { method: 'POST', headers: { 'X-FN-OpenClaw-Action': '1' } }) }
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

async function poll() {
  await refresh()
  setTimeout(poll, 1000)
}
scrollLogToEnd()
poll()
