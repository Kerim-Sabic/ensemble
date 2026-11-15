import { app, BrowserWindow, session, type NativeImage, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ScreenInput } from '@shared/types'
import type { BrowserFactory, BrowserHooks, BrowserSurface, PagePoint, PageSnapshot, Picture } from './types'
import { ACCEPT_JS, DIALOGS_JS, FOCUSED_JS, SNAPSHOT_JS, TEXT_JS, findJs, focusJs, locateJs, scriptClickJs, selectJs } from './page-script'

const WIDTH = 1280
const HEIGHT = 800
// Every agent's browser shares one profile, so signing in to a site once is enough.
const PARTITION = 'persist:ensemble-browser'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const live = new Map<number, ElectronBrowser>()
let prepared: Session | null = null

function profile(): Session {
  if (prepared) return prepared
  const ses = session.fromPartition(PARTITION)
  // Present as an ordinary browser; some sites turn away anything that names itself an app shell.
  ses.setUserAgent(
    ses
      .getUserAgent()
      .replace(/\s(Electron|ensemble|Ensemble)\/\S+/g, '')
      .trim(),
  )
  // A page an agent opened never gets the camera, the microphone, location or notifications.
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.on('will-download', (_e, item, wc) => {
    const owner = wc ? live.get(wc.id) : undefined
    const dir = app.getPath('downloads')
    const parsed = path.parse(item.getFilename() || 'download')
    let file = path.join(dir, parsed.base)
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${parsed.name} (${n})${parsed.ext}`)
    item.setSavePath(file)
    item.once('done', (_ev, state) => owner?.note(state === 'completed' ? `A file was downloaded to ${file}` : `A download of ${parsed.base} did not finish.`))
  })
  prepared = ses
  return ses
}

const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  space: 'Space',
  ' ': 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  page_up: 'PageUp',
  page_down: 'PageDown',
  plus: 'Plus',
}

const MODIFIERS: Record<string, 'control' | 'shift' | 'alt' | 'meta'> = {
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta',
}

type Mod = 'control' | 'shift' | 'alt' | 'meta'

interface Located {
  x: number
  y: number
  empty: boolean
  hit: boolean
  label: string
  kind: string
  tag: string
  type: string
  disabled: boolean
  editable: boolean
}

function keyCode(name: string): string | null {
  const k = name.trim()
  if (!k) return null
  const named = NAMED_KEYS[k.toLowerCase()]
  if (named) return named
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase()
  if (k.length === 1) return k
  return null
}

function mods(list?: string[]): Mod[] {
  return (list || []).map((m) => MODIFIERS[m.toLowerCase()]).filter((m): m is Mod => !!m)
}

/** One agent's browser: a real Chromium page drawn off-screen and streamed to the app as pictures. */
export class ElectronBrowser implements BrowserSurface {
  readonly width = WIDTH
  readonly height = HEIGHT
  private win: BrowserWindow
  private wc: WebContents
  private last: NativeImage | null = null
  private sentAt = 0
  private trailing: NodeJS.Timeout | null = null
  private level: 0 | 1 | 2 = 0
  private boosted: NodeJS.Timeout | null = null
  private painted: (() => void)[] = []
  private notes: string[] = []
  private closed = false
  private id = 0

  constructor(private hooks: BrowserHooks) {
    this.win = new BrowserWindow({
      show: false,
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      frame: false,
      skipTaskbar: true,
      webPreferences: {
        offscreen: true,
        session: profile(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })
    this.wc = this.win.webContents
    const id = this.wc.id
    this.id = id
    live.set(id, this)
    this.win.setContentSize(WIDTH, HEIGHT)
    // A page nobody is looking at is drawn once a second; that is enough to keep its picture current.
    this.wc.setFrameRate(1)
    this.wc.setAudioMuted(true)

    this.wc.on('paint', (_e, _dirty, image) => {
      this.last = image
      for (const done of this.painted.splice(0)) done()
      this.frame()
    })
    const changed = (): void => {
      if (!this.closed) this.hooks.changed()
    }
    this.wc.on('did-start-loading', changed)
    this.wc.on('did-stop-loading', changed)
    this.wc.on('did-navigate', changed)
    this.wc.on('did-navigate-in-page', changed)
    this.wc.on('page-title-updated', changed)
    // Links that would open another window open here instead: one agent, one page.
    this.wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) setImmediate(() => !this.closed && void this.wc.loadURL(url).catch(() => undefined))
      return { action: 'deny' }
    })
    this.wc.on('will-prevent-unload', (e) => e.preventDefault())
    this.wc.on('render-process-gone', () => {
      this.note('The page stopped working and was reloaded.')
      if (!this.closed) this.wc.reload()
    })
    this.win.on('closed', () => {
      live.delete(id)
      if (this.closed) return
      this.closed = true
      this.hooks.closed()
    })
    try {
      this.wc.debugger.attach('1.3')
      void this.wc.debugger.sendCommand('Page.enable').catch(() => undefined)
      void this.wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DIALOGS_JS }).catch(() => undefined)
    } catch {
      /* pages can still be used; a pop-up box would just have to be dismissed by hand */
    }
    this.wc.focus()
  }

  note(text: string): void {
    if (this.notes.length < 12) this.notes.push(text)
  }

  private alive(): void {
    if (this.closed || this.win.isDestroyed()) throw new Error('The browser was closed. Open a page to start it again.')
  }

  // ───────────── pictures ─────────────

  private encode(image: NativeImage): { jpeg: Buffer; width: number; height: number } {
    const size = image.getSize()
    const img = size.width > WIDTH ? image.resize({ width: WIDTH, quality: 'good' }) : image
    const s = img.getSize()
    return { jpeg: img.toJPEG(72), width: s.width, height: s.height }
  }

  /** How often the page is drawn: smoothly while someone watches or the agent acts, barely otherwise. */
  private pace(): void {
    if (this.closed || this.win.isDestroyed()) return
    try {
      this.wc.setFrameRate(this.level === 2 || this.boosted ? 12 : this.level === 1 ? 2 : 1)
    } catch {
      /* the page is going away */
    }
  }

  /** Draws at full speed for a moment, so what the agent just did shows up at once. */
  private boost(): void {
    if (this.boosted) clearTimeout(this.boosted)
    this.boosted = setTimeout(() => {
      this.boosted = null
      this.pace()
    }, 2500)
    this.pace()
  }

  /** Waits until the page has been drawn again, so a picture taken now shows the page as it is now. */
  private repaint(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(done, 500)
      this.painted.push(done)
      this.boost()
      try {
        this.wc.invalidate()
      } catch {
        done()
      }
    })
  }

  /** Passes the latest picture on, at most every so often; the last one of a burst always gets through. */
  private frame(): void {
    if (this.closed || !this.last) return
    const gap = this.level === 2 ? 85 : this.level === 1 ? 1500 : 6000
    const wait = this.sentAt + gap - Date.now()
    if (wait > 0) {
      if (!this.trailing) {
        this.trailing = setTimeout(() => {
          this.trailing = null
          this.frame()
        }, wait)
      }
      return
    }
    this.sentAt = Date.now()
    try {
      const f = this.encode(this.last)
      this.hooks.frame(f.jpeg, f.width, f.height)
    } catch {
      /* a frame that fails to encode is simply skipped */
    }
  }

  watch(level: 0 | 1 | 2): void {
    this.level = level
    this.pace()
    if (level) {
      this.sentAt = 0
      this.frame()
    }
  }

  async picture(file?: string): Promise<Picture | null> {
    this.alive()
    await this.repaint()
    let image = this.last
    if (!image || image.isEmpty()) {
      try {
        image = await this.wc.capturePage()
      } catch {
        image = null
      }
    }
    if (!image || image.isEmpty()) return null
    const f = this.encode(image)
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, f.jpeg)
    }
    return { data: f.jpeg.toString('base64'), width: f.width, height: f.height }
  }

  // ───────────── moving around ─────────────

  private async run<T>(code: string, ms = 8000): Promise<T> {
    this.alive()
    return (await Promise.race([
      this.wc.executeJavaScript(code, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The page did not answer in time. It may still be loading.')), ms)),
    ])) as T
  }

  /** Waits for the page to stop loading and for things to stop moving. */
  private async settle(max = 8000): Promise<void> {
    this.boost()
    await sleep(170)
    const t0 = Date.now()
    while (!this.closed && this.wc.isLoadingMainFrame() && Date.now() - t0 < max) await sleep(90)
    const t1 = Date.now()
    while (!this.closed && this.wc.isLoading() && Date.now() - t1 < 1500) await sleep(90)
    await sleep(260)
  }

  async navigate(input: string): Promise<void> {
    this.alive()
    let url = input.trim()
    if (!url) throw new Error('Give an address to open.')
    if (/^[a-zA-Z]:[\\/]/.test(url)) url = `file:///${url.replace(/\\/g, '/')}`
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = /^(localhost|127\.|\[::1\]|\d+\.\d+\.\d+\.\d+)/i.test(url) ? `http://${url}` : `https://${url}`
    if (!/^(https?|file):/i.test(url) && url !== 'about:blank') throw new Error('Only web addresses and local files can be opened.')
    const loading = this.wc.loadURL(url).then(
      () => null,
      (e: Error & { code?: string; errno?: number }) => (e.errno === -3 || e.code === 'ERR_ABORTED' ? null : e),
    )
    const err = await Promise.race([loading, sleep(25000).then(() => 'slow' as const)])
    if (err === 'slow') this.note('The page is taking a long time to load; this is what it shows so far.')
    else if (err) throw new Error(`The page could not be opened (${err.code || err.message.split('\n')[0]}).`)
    await this.settle(4000)
  }

  async history(dir: 'back' | 'forward' | 'reload'): Promise<boolean> {
    this.alive()
    const h = this.wc.navigationHistory
    if (dir === 'back') {
      if (!h.canGoBack()) return false
      h.goBack()
    } else if (dir === 'forward') {
      if (!h.canGoForward()) return false
      h.goForward()
    } else this.wc.reload()
    await this.settle()
    return true
  }

  state(): { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean } {
    if (this.closed || this.win.isDestroyed()) return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    const h = this.wc.navigationHistory
    return { url: this.wc.getURL(), title: this.wc.getTitle(), loading: this.wc.isLoading(), canGoBack: h.canGoBack(), canGoForward: h.canGoForward() }
  }

  async snapshot(): Promise<PageSnapshot> {
    const r = await this.run<Omit<PageSnapshot, 'notes'> & { notes?: string[] }>(SNAPSHOT_JS)
    return { ...r, notes: [...this.notes.splice(0), ...(r.notes || [])] }
  }

  // ───────────── acting ─────────────

  private async mouse(x: number, y: number, opts: { double?: boolean; button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    const px = Math.round(x)
    const py = Math.round(y)
    const button = opts.button || 'left'
    this.wc.sendInputEvent({ type: 'mouseMove', x: px, y: py })
    await sleep(40)
    this.wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button, clickCount: 1 })
    this.wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button, clickCount: 1 })
    if (opts.double) {
      await sleep(60)
      this.wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button, clickCount: 2 })
      this.wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button, clickCount: 2 })
    }
  }

  private async locate(ref: number): Promise<Located> {
    const loc = await this.run<Located & { error?: string }>(locateJs(ref))
    if (!loc || loc.error) throw new Error(`Number ${ref} is no longer on the page. Look at the page again for fresh numbers.`)
    return loc
  }

  /** The next "are you sure?" box the page raises is answered OK instead of Cancel. */
  async acceptNext(): Promise<void> {
    await this.run(ACCEPT_JS).catch(() => undefined)
  }

  async click(target: { ref?: number; x?: number; y?: number }, opts: { double?: boolean; button?: 'left' | 'right' | 'middle' } = {}): Promise<PagePoint> {
    this.alive()
    let point: PagePoint
    if (target.ref !== undefined) {
      const loc = await this.locate(target.ref)
      if (loc.disabled) throw new Error(`"${loc.label}" is switched off on the page and cannot be clicked right now.`)
      if (loc.tag === 'SELECT') throw new Error(`"${loc.label}" is a dropdown. Use the select action with the option you want.`)
      point = { x: loc.x, y: loc.y, label: loc.label || loc.kind }
      if (loc.empty) await this.run(scriptClickJs(target.ref))
      else {
        if (!loc.hit) this.note(`Something else on the page sits on top of "${loc.label}", so the click may have landed on that. Look again to check.`)
        await this.mouse(loc.x, loc.y, opts)
      }
    } else if (typeof target.x === 'number' && typeof target.y === 'number') {
      const x = Math.max(0, Math.min(WIDTH - 1, target.x))
      const y = Math.max(0, Math.min(HEIGHT - 1, target.y))
      const label = await this.run<string>(
        `(function(){var e=document.elementFromPoint(${Math.round(x)},${Math.round(y)});if(!e)return '';var t=(e.getAttribute('aria-label')||e.innerText||e.value||e.alt||'');return String(t).replace(/\\s+/g,' ').trim().slice(0,60)})()`,
      ).catch(() => '')
      point = { x, y, label }
      await this.mouse(x, y, opts)
    } else throw new Error('Say what to click: a number from the outline (ref) or a position (coordinate).')
    await this.settle()
    return point
  }

  async type(text: string, opts: { ref?: number; append?: boolean; submit?: boolean }): Promise<PagePoint | null> {
    this.alive()
    let point: PagePoint | null = null
    const refuse = 'That is a password box. Passwords are for the person to type: ask them to take over the browser in the Live view and sign in themselves.'
    if (opts.ref !== undefined) {
      const loc = await this.locate(opts.ref)
      if (loc.type === 'password') throw new Error(refuse)
      if (loc.disabled) throw new Error(`"${loc.label}" is switched off on the page and cannot be typed into right now.`)
      if (!loc.editable) throw new Error(`"${loc.label}" is not something you can type into.`)
      point = { x: loc.x, y: loc.y, label: loc.label || loc.kind }
      if (!loc.empty) await this.mouse(loc.x, loc.y)
      await sleep(70)
      await this.run(focusJs(opts.ref, !opts.append))
    } else {
      const f = await this.run<{ editable: boolean; password: boolean }>(FOCUSED_JS)
      if (f.password) throw new Error(refuse)
      if (!f.editable) throw new Error('Nothing on the page is ready to take text. Click a text box first, or pass its number as ref.')
    }
    if (text) await this.wc.insertText(text)
    else if (!opts.append) this.key('Backspace', [])
    if (opts.submit) {
      await sleep(80)
      this.key('Enter', [])
    }
    await this.settle(opts.submit ? 8000 : 1500)
    return point
  }

  async select(ref: number, option: string): Promise<PagePoint> {
    const r = await this.run<{ error?: string; options?: string[]; x: number; y: number; label: string; chosen: string }>(selectJs(ref, option))
    if (r.error === 'gone') throw new Error(`Number ${ref} is no longer on the page. Look at the page again for fresh numbers.`)
    if (r.error === 'notselect') throw new Error('That is not a plain dropdown. Click it to open it, look again, then click the option you want.')
    if (r.error === 'nooption') throw new Error(`There is no option like "${option}". The options are: ${(r.options || []).join(' / ')}`)
    await this.settle(1500)
    return { x: r.x, y: r.y, label: `${r.label}: ${r.chosen}` }
  }

  private key(code: string, modifiers: Mod[]): void {
    this.wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers })
    // The key press alone moves nothing in a text box; the character event does.
    if (code === 'Enter') this.wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
    else if (code === 'Space' && !modifiers.includes('control') && !modifiers.includes('meta')) this.wc.sendInputEvent({ type: 'char', keyCode: ' ', modifiers })
    else if (code.length === 1 && !modifiers.includes('control') && !modifiers.includes('meta') && !modifiers.includes('alt')) this.wc.sendInputEvent({ type: 'char', keyCode: code, modifiers })
    this.wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
  }

  async press(keys: string): Promise<void> {
    this.alive()
    for (const combo of keys.split(/\s+/).filter(Boolean)) {
      const parts = combo === '+' ? ['plus'] : combo.split('+').filter(Boolean)
      const modifiers: Mod[] = []
      let code: string | null = null
      for (const p of parts) {
        const m = MODIFIERS[p.toLowerCase()]
        if (m) modifiers.push(m)
        else code = keyCode(p)
      }
      if (!code) throw new Error(`"${combo}" is not a key this browser knows. Use names like Enter, Escape, Tab, ArrowDown, PageDown, or combinations like Control+A.`)
      if (code.length === 1 && modifiers.length) code = code.toUpperCase()
      this.key(code, modifiers)
      await sleep(60)
    }
    await this.settle()
  }

  async scroll(dir: 'up' | 'down' | 'left' | 'right', screens: number, at?: { ref?: number; x?: number; y?: number }): Promise<void> {
    this.alive()
    let x = WIDTH / 2
    let y = HEIGHT / 2
    if (at?.ref !== undefined) {
      const loc = await this.locate(at.ref)
      x = loc.x
      y = loc.y
    } else if (typeof at?.x === 'number' && typeof at?.y === 'number') {
      x = at.x
      y = at.y
    }
    const n = Math.max(0.1, Math.min(10, screens || 1))
    const amount = Math.round((dir === 'up' || dir === 'down' ? HEIGHT : WIDTH) * 0.85 * n)
    const steps = Math.max(1, Math.round(n * 3))
    this.wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    for (let i = 0; i < steps; i++) {
      const d = Math.round(amount / steps)
      this.wc.sendInputEvent({
        type: 'mouseWheel',
        x: Math.round(x),
        y: Math.round(y),
        deltaX: dir === 'left' ? d : dir === 'right' ? -d : 0,
        deltaY: dir === 'up' ? d : dir === 'down' ? -d : 0,
        canScroll: true,
      })
      await sleep(45)
    }
    await sleep(420)
  }

  async find(text: string): Promise<boolean> {
    const ok = await this.run<boolean>(findJs(text))
    await sleep(200)
    return ok
  }

  async text(): Promise<string> {
    return this.run<string>(TEXT_JS)
  }

  // ───────────── the person's own hands ─────────────

  input(ev: ScreenInput): void {
    if (this.closed || this.win.isDestroyed()) return
    try {
      if (ev.type === 'mouse') {
        const x = Math.round(ev.x * WIDTH)
        const y = Math.round(ev.y * HEIGHT)
        const modifiers = mods(ev.mods)
        if (ev.action === 'move') this.wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
        else this.wc.sendInputEvent({ type: ev.action === 'down' ? 'mouseDown' : 'mouseUp', x, y, button: ev.button || 'left', clickCount: ev.clicks || 1, modifiers })
      } else if (ev.type === 'wheel') {
        this.wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(ev.x * WIDTH), y: Math.round(ev.y * HEIGHT), deltaX: -ev.dx, deltaY: -ev.dy, canScroll: true })
      } else {
        const code = keyCode(ev.key)
        if (!code) return
        const modifiers = mods(ev.mods)
        if (ev.action === 'up') {
          this.wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
          return
        }
        const shortcut = modifiers.includes('control') || modifiers.includes('meta') || modifiers.includes('alt')
        this.wc.sendInputEvent({ type: 'keyDown', keyCode: code.length === 1 && shortcut ? code.toUpperCase() : code, modifiers })
        if (code === 'Enter') this.wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
        else if (!shortcut && ev.key.length === 1) this.wc.sendInputEvent({ type: 'char', keyCode: ev.key, modifiers })
      }
    } catch {
      /* a key this browser has no name for: ignore it */
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.trailing) clearTimeout(this.trailing)
    if (this.boosted) clearTimeout(this.boosted)
    for (const done of this.painted.splice(0)) done()
    live.delete(this.id)
    try {
      if (!this.win.isDestroyed() && this.wc.debugger.isAttached()) this.wc.debugger.detach()
    } catch {
      /* already detached */
    }
    if (!this.win.isDestroyed()) this.win.destroy()
    this.hooks.closed()
  }
}

export const electronBrowsers: BrowserFactory = {
  create: (hooks: BrowserHooks) => new ElectronBrowser(hooks),
}
