const WINDOW = '.trim-ui__app-layout--window'
const HEADER = '.trim-ui__app-layout--header'
const MINIMIZE = '.app-layout-header-minimize'

function watchControlTheme(frame, toolbar) {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  let controlRoot
  let lastMode
  function sync() {
    const mode = controlRoot?.getAttribute('data-theme-mode')
    if (mode === 'dark' || mode === 'light') lastMode = mode
    const scheme = lastMode ?? (systemTheme.matches ? 'dark' : 'light')
    document.documentElement.dataset.fnOpenclawScheme = scheme
    toolbar.dataset.fnOpenclawScheme = scheme
  }

  const observer = new MutationObserver(sync)
  frame.addEventListener('load', () => {
    observer.disconnect()
    controlRoot = frame.contentDocument?.documentElement
    if (controlRoot) observer.observe(controlRoot, { attributes: true, attributeFilter: ['data-theme-mode'] })
    sync()
  })
  systemTheme.addEventListener('change', sync)
  sync()
}

// The desktop and the app iframe share an origin on supported fnOS layouts.
// Keep the toolbar in the app for any other host, including a direct visit.
function createTitlebarDock(toolbar, slot) {
  let mounted
  const stylesheet = new URL('./titlebar.css', document.baseURI).href
  const stopDrag = event => event.stopPropagation()
  for (const event of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick']) {
    toolbar.addEventListener(event, stopDrag)
  }

  function restore() {
    if (!mounted) return
    mounted.link.remove()
    mounted = undefined
    toolbar.removeAttribute('data-fn-openclaw-titlebar')
    slot.append(toolbar)
  }

  function sync() {
    const host = window.frameElement?.closest(WINDOW)
    const header = host?.querySelector(HEADER)
    const minimize = header?.querySelector(MINIMIZE)
    if (!minimize || !header.isConnected) {
      restore()
      return
    }
    if (mounted?.header === header && mounted.minimize === minimize) {
      if (!mounted.ready || header.contains(toolbar)) return
    }
    restore()

    // Place the toolbar just before the host's existing window buttons.
    let controls = minimize
    while (controls.parentElement !== header) controls = controls.parentElement
    if (controls.querySelector('.trim-ui__app-layout--header-title')) controls = minimize

    const doc = header.ownerDocument
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = stylesheet
    const dock = { header, minimize, link, ready: false }
    mounted = dock
    link.addEventListener('load', () => {
      if (mounted !== dock) return
      if (!controls.isConnected || !header.contains(controls)) return restore()
      toolbar.setAttribute('data-fn-openclaw-titlebar', '')
      controls.before(toolbar)
      dock.ready = true
    }, { once: true })
    // On CSP or network failure, keep the original toolbar in place.
    doc.head.append(link)
  }

  window.addEventListener('pagehide', restore)
  return () => {
    try { sync() } catch { restore() }
  }
}
