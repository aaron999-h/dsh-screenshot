/**
 * Screenshot-to-draft plugin, Client half.
 *
 * Registers a 「截图提问」 row in the composer `+` menu (the command menu shared
 * with a typed `/`). The row asks the Host to run a desktop-wide selector with
 * the WeChat-style annotator, then hands the returned crop to the composer as
 * if the user had pasted an image: the composer has no public "add this File"
 * call for sibling plugins, while its document-level paste route is exactly the
 * door a real Ctrl+V uses, caps and busy refusal included.
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')

    const h = React.createElement
    const { useEffect, useSyncExternalStore } = React
    const NS = 'screenshot'

    /* ------------------------------------------------------------------ *
     * Copy
     * ------------------------------------------------------------------ */
    const en = {
      rowLabel: 'Screenshot',
      rowDescription: 'Select a region on the desktop and attach it to the draft',
      failedTitle: 'Selection failed',
      captureFailed: 'Could not capture the screen: {error}',
      attachFailed: 'Could not attach the image: {error}',
      attachRefused: 'The composer did not take the image; it may be sending a message right now',
      alreadyOpen: 'Another selection window is already open',
      retry: 'Retry',
      close: 'Close',
    }

    const zh = {
      rowLabel: '截图提问',
      rowDescription: '在全桌面框选一块区域，并把截图添加到对话里',
      failedTitle: '截图失败',
      captureFailed: '截屏失败：{error}',
      attachFailed: '添加图片失败：{error}',
      attachRefused: '输入框没有接收这张图片，可能正在发送消息',
      alreadyOpen: '已经有一个截图窗口打开了',
      retry: '重试',
      close: '关闭',
    }

    /* ------------------------------------------------------------------ *
     * Styles (injected once, keyed by module id)
     * ------------------------------------------------------------------ */
    const CSS = [
      '.sshot-layer{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;background:rgba(0,0,0,.32)}',
      '.sshot-card{min-width:320px;max-width:440px;display:flex;flex-direction:column;gap:10px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l1,#33353d);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#1b1c21);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.45));color:var(--dsw-alias-label-primary,#e9eaee);font-size:14px;line-height:22px}',
      '.sshot-title{font-size:15px;font-weight:600}',
      '.sshot-message{color:var(--dsw-alias-label-secondary,#b6b8c2);font-size:13px;line-height:20px;word-break:break-word}',
      '.sshot-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
      '.sshot-button{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1,#33353d);border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}',
      '.sshot-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.sshot-button[data-primary="true"]{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
    ].join('\n')

    function injectStyles() {
      if (typeof document === 'undefined') return
      const id = `${NS}/dialog.css`
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------ *
     * Button glyph: crop corners plus a shutter dot.
     * ------------------------------------------------------------------ */
    function ScreenshotIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2 5.5V3.5A1.5 1.5 0 0 1 3.5 2h2' }),
        h('path', { d: 'M14 5.5V3.5A1.5 1.5 0 0 0 12.5 2h-2' }),
        h('path', { d: 'M2 10.5v2A1.5 1.5 0 0 0 3.5 14h2' }),
        h('path', { d: 'M14 10.5v2A1.5 1.5 0 0 1 12.5 14h-2' }),
        h('circle', { cx: 8, cy: 8, r: 2.1 }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Translation (a slot normally hands one over)
     * ------------------------------------------------------------------ */
    let fallbackTranslate = (key) => key

    /**
     * A translator for one mounted component: the slot's own `t` wins, but a
     * namespace miss falls back to the plugin-bound translator instead of
     * showing the raw key.
     * @param props - slot props.
     */
    function translatorFor(props) {
      return (key, params) => {
        const viaSlot = typeof props?.t === 'function' ? props.t(key, params) : undefined
        if (typeof viaSlot === 'string' && viaSlot !== key) return viaSlot
        return fallbackTranslate(key, params)
      }
    }

    /* ------------------------------------------------------------------ *
     * Locale id for the selector's instruction line
     * ------------------------------------------------------------------ */
    let localeId = () => 'en'

    /* ------------------------------------------------------------------ *
     * Per-Session capture surface
     * ------------------------------------------------------------------ */
    function createSurface() {
      let state = { open: false, phase: 'idle', error: undefined }
      const listeners = new Set()
      let deliver = undefined

      const publish = (next) => {
        state = next
        for (const listener of listeners) listener()
      }

      return {
        get state() { return state },
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        setDeliver(next) { deliver = next },
        deliver(file) {
          if (deliver === undefined) throw new Error('the composer is not mounted yet')
          return deliver(file)
        },
        start() {
          if (state.phase === 'capturing') return false
          publish({ open: false, phase: 'capturing', error: undefined })
          return true
        },
        close() { publish({ open: false, phase: 'idle', error: undefined }) },
        fail(error) { publish({ open: true, phase: 'failed', error }) },
      }
    }

    const surfaces = new Map()

    function surfaceFor(sessionId) {
      const key = String(sessionId)
      let surface = surfaces.get(key)
      if (surface === undefined) {
        surface = createSurface()
        surfaces.set(key, surface)
      }
      return surface
    }

    /* ------------------------------------------------------------------ *
     * Host round trip
     * ------------------------------------------------------------------ */
    async function post(path, query) {
      const url = new URL(path, document.baseURI)
      for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'x-dsh-screenshot': '1' },
      })
      const body = await response.json().catch(() => undefined)
      if (body === undefined) throw new Error(`HTTP ${String(response.status)}`)
      if (body.ok === true) return body
      if (body.cancelled === true) throw new Error('cancelled')
      throw new Error(body.error ?? `HTTP ${String(response.status)}`)
    }

    /**
     * Ask the Host for a fresh region and hand the crop to the composer.
     * @param surface - this Session's surface.
     */
    async function run(surface) {
      if (!surface.start()) return
      try {
        const body = await post('screenshot/v6/capture', { lang: localeId() })
        const blob = await (await fetch(body.image)).blob()
        const stamp = new Date()
        const pad = (value) => String(value).padStart(2, '0')
        const name = `screenshot-${String(stamp.getFullYear())}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`
        const file = new File([blob], name, { type: 'image/png' })
        if (!surface.deliver(file)) throw new Error(fallbackTranslate('attachRefused'))
        surface.close()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'cancelled') surface.close()
        else if (message === 'a selection is already open') surface.fail(fallbackTranslate('alreadyOpen'))
        else surface.fail(message)
      }
    }

    /**
     * Add one image to the composer draft through its paste route.
     *
     * A paste landing outside any editable control is routed to the addressed
     * composer's intake, which is where the image caps, the busy-phase refusal
     * and the upload staging live. The legacy `addFiles` seat is used when a
     * shell still projects it.
     * @param inputActions - the composer seat handed to this slot.
     * @param file - cropped PNG.
     * @returns whether the draft took the file.
     */
    function attachFile(inputActions, file) {
      if (typeof inputActions?.addFiles === 'function') {
        const refused = inputActions.addFiles([file])
        if (typeof refused === 'string' && refused !== '') throw new Error(refused)
        return true
      }
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      })
      document.body.dispatchEvent(event)
      return event.defaultPrevented
    }

    /* ------------------------------------------------------------------ *
     * Failure dialog (the selector itself is drawn by the Host)
     * ------------------------------------------------------------------ */
    function ScreenshotDialog(props) {
      const surface = props.surface
      const t = translatorFor(props)
      const state = useSyncExternalStore(surface.subscribe, surface.getSnapshot)

      useEffect(() => {
        surface.setDeliver((file) => attachFile(props.inputActions, file))
      })

      if (!state.open || state.phase !== 'failed') return null

      const layer = h('div', { className: 'sshot-layer' },
        h('div', { className: 'sshot-card', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'sshot-title' }, t('failedTitle')),
          h('div', { className: 'sshot-message' }, t('captureFailed', { error: String(state.error ?? '') })),
          h('div', { className: 'sshot-actions' },
            h('button', {
              type: 'button',
              className: 'sshot-button',
              onClick: () => { surface.close() },
            }, t('close')),
            h('button', {
              type: 'button',
              className: 'sshot-button',
              'data-primary': 'true',
              onClick: () => { surface.close(); void run(surface) },
            }, t('retry')),
          ),
        ),
      )

      return ReactDOM.createPortal(layer, document.body)
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        injectStyles()
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-screenshot: copy')
        fallbackTranslate = ctx.locale.bind(NS)
        localeId = () => {
          const snapshot = ctx.locale.getSnapshot()
          return typeof snapshot?.active === 'string' ? snapshot.active : 'en'
        }

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'screenshot-dialog',
          order: 30,
          locale: NS,
          inject: (sessionId) => ({ surface: surfaceFor(sessionId) }),
        }, ScreenshotDialog))

        ctx.inject(['commandUi'], (scope) => scope.effect(() => scope.commandUi.register({
          name: 'screenshot',
          label: () => fallbackTranslate('rowLabel'),
          description: () => fallbackTranslate('rowDescription'),
          icon: ScreenshotIcon,
          available: () => 'dshDesktop' in globalThis,
          ui: {
            kind: 'action',
            run: (session) => { void run(surfaceFor(session.sessionId)) },
          },
        }), 'dsh-screenshot: composer row'))
      },
    }
  },
})
