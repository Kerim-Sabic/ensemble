import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { HubEvent, Item, ScreenFrame, ScreenInput, ScreenKind, ScreenState, Settings } from '@shared/types'
import type { AgentSession } from '../session'
import type { TeamTool, ToolOutput } from '../providers/types'
import { truncate, uid } from '../util'
import type { BrowserSurface, DesktopShot, HandsDrivers, PagePoint, PageSnapshot } from './types'

// Gives agents hands: a web browser of their own, and the computer's real mouse,
// keyboard and screen. This file decides what they may do and records each step
// so the person can watch it live and replay it later; the drivers do the touching.

export interface HandsHost {
  dataDir: string
  settings(): Settings
  updateSettings(patch: Partial<Settings>): void
  emit(ev: HubEvent): void
  frame(f: ScreenFrame): void
  /** Stops an agent, as if the person had pressed Stop. */
  stop(chatId: string, accountId: string): void
}

type ScreenItem = Extract<Item, { kind: 'screen' }>

interface Screen {
  key: string
  state: ScreenState
  surface?: BrowserSurface
  /** How many places show this screen as a small picture, and how many show it live. */
  watchers: number
  full: number
  idle?: NodeJS.Timeout
}

const levelOf = (scr: { watchers: number; full: number }): 0 | 1 | 2 => (scr.full > 0 ? 2 : scr.watchers > 0 ? 1 : 0)

const BROWSER_IDLE_MS = 20 * 60 * 1000
const DESKTOP_IDLE_MS = 45 * 1000
const SHOT_W = 1280
const SHOT_H = 800

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const quote = (s: string, max = 44): string => `"${truncate(s.replace(/\s+/g, ' ').trim(), max)}"`
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
const pair = (v: unknown): [number, number] | undefined => {
  if (!Array.isArray(v) || v.length < 2) return undefined
  const x = num(v[0])
  const y = num(v[1])
  return x === undefined || y === undefined ? undefined : [x, y]
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function siteOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' ? decodeURIComponent(u.pathname.split('/').pop() || 'a file') : u.host.replace(/^www\./, '')
  } catch {
    return truncate(url, 40)
  }
}

export class Hands {
  private screens = new Map<string, Screen>()
  /** Chats where the person has said yes to computer control. */
  private granted = new Set<string>()
  /** Who has the mouse right now. Only one agent can. */
  private driving: { session: AgentSession; idle?: NodeJS.Timeout; stream?: NodeJS.Timeout } | null = null
  private asks = new Map<string, AbortController>()
  private blocked = new Map<string, number>()
  private scale: { x: number; y: number } | null = null

  constructor(
    private host: HandsHost,
    private drivers: HandsDrivers,
  ) {}

  get canBrowse(): boolean {
    return !!this.drivers.browser
  }

  get canControl(): boolean {
    return !!this.drivers.desktop?.available()
  }

  /** Which hands an agent has right now, for its briefing. */
  abilities(): { browser: boolean; computer: boolean } {
    const s = this.host.settings()
    return { browser: this.canBrowse && s.browser, computer: this.canControl && s.computer !== 'off' }
  }

  states(): ScreenState[] {
    return [...this.screens.values()].map((s) => ({ ...s.state }))
  }

  private key(chatId: string, accountId: string, kind: ScreenKind): string {
    return `${chatId}:${accountId}:${kind}`
  }

  private publish(scr: Screen): void {
    if (scr.surface) Object.assign(scr.state, scr.surface.state())
    this.host.emit({ type: 'screen', screen: { ...scr.state } })
  }

  private drop(scr: Screen): void {
    if (!this.screens.delete(scr.key)) return
    if (scr.idle) clearTimeout(scr.idle)
    this.host.emit({ type: 'screen-closed', chatId: scr.state.chatId, accountId: scr.state.accountId, kind: scr.state.kind })
  }

  private shotFile(chatId: string, id: string): string {
    return path.join(this.host.dataDir, 'chats', chatId, 'screens', `${id}.jpg`)
  }

  // ───────────── steps in the transcript ─────────────

  private begin(session: AgentSession, surface: ScreenKind, action: string, doing: string): ScreenItem {
    const item: ScreenItem = { id: uid('s'), kind: 'screen', ts: Date.now(), surface, action, label: doing, status: 'running' }
    session.add(item)
    session.emit({ type: 'status', text: doing })
    return item
  }

  private finish(session: AgentSession, item: ScreenItem, patch: Partial<ScreenItem>): void {
    session.patch(item.id, { status: 'done', durationMs: Date.now() - item.ts, ...patch })
  }

  private fail(session: AgentSession, item: ScreenItem, error: string): void {
    session.patch(item.id, { status: 'error', error, durationMs: Date.now() - item.ts })
  }

  // ───────────── the browser ─────────────

  private browserFor(chatId: string, accountId: string): Screen {
    const key = this.key(chatId, accountId, 'browser')
    let scr = this.screens.get(key)
    if (scr?.surface) return scr
    if (!this.drivers.browser) throw new Error('This install cannot open a browser.')
    scr = { key, watchers: scr?.watchers || 0, full: scr?.full || 0, state: { chatId, accountId, kind: 'browser', active: false, width: 1280, height: 800 } }
    const mine = scr
    mine.surface = this.drivers.browser.create({
      frame: (jpeg, width, height) => this.host.frame({ key, width, height, data: jpeg }),
      changed: () => this.screens.get(key) === mine && this.publish(mine),
      closed: () => this.screens.get(key) === mine && this.drop(mine),
    })
    mine.state.width = mine.surface.width
    mine.state.height = mine.surface.height
    mine.surface.watch(levelOf(mine))
    this.screens.set(key, mine)
    return mine
  }

  private touch(scr: Screen): void {
    if (scr.idle) clearTimeout(scr.idle)
    scr.idle = setTimeout(() => {
      // A browser nobody has used for a while is closed to free its memory.
      if (!scr.state.active && scr.watchers === 0 && scr.full === 0) scr.surface?.close()
      else this.touch(scr)
    }, BROWSER_IDLE_MS)
  }

  private pageText(snap: PageSnapshot, lead: string): string {
    const where =
      snap.scrollMax > 4
        ? `Scrolled ${Math.round((snap.scrollY / snap.scrollMax) * 100)}% of the way down a page about ${(1 + snap.scrollMax / Math.max(1, snap.viewHeight)).toFixed(1)} screens long.`
        : 'The whole page fits in view.'
    return [
      lead,
      ...snap.notes,
      `<page title="${snap.title.replace(/"/g, "'")}" address="${snap.url}">`,
      where,
      snap.moreAbove ? '(More of the page is above this: scroll up to list it.)' : '',
      snap.outline || '(Nothing on the page reads as text. Use the look action to see it.)',
      snap.moreBelow ? '(The page goes on below this: scroll down, or use find, to list more.)' : '',
      '</page>',
    ]
      .filter(Boolean)
      .join('\n')
  }

  private async useBrowser(session: AgentSession, a: Record<string, unknown>): Promise<string | ToolOutput> {
    if (!this.host.settings().browser) return 'The browser is switched off in Settings. Tell the user if the task needs it.'
    const action = str(a.action)
    const { chat, account } = session
    if (action === 'close') {
      const scr = this.screens.get(this.key(chat.id, account.id, 'browser'))
      scr?.surface?.close()
      return 'The browser is closed.'
    }
    const scr = this.browserFor(chat.id, account.id)
    const b = scr.surface as BrowserSurface
    this.touch(scr)
    if (!scr.state.active) {
      scr.state.active = true
      this.publish(scr)
    }
    const ref = num(a.ref)
    const xy = pair(a.coordinate)
    const text = str(a.text)
    const target = ref !== undefined ? { ref } : xy ? { x: xy[0], y: xy[1] } : undefined
    const point = (p: PagePoint | null | undefined, did: string): void => {
      if (!p) return
      scr.state.pointer = { x: p.x / b.width, y: p.y / b.height, action, label: did, ts: Date.now() }
    }

    let doing: string
    switch (action) {
      case 'open':
        if (!str(a.url)) return 'Give the address to open in url.'
        doing = `Opening ${siteOf(/^[a-z]+:/i.test(str(a.url)) || /^[a-zA-Z]:[\\/]/.test(str(a.url)) ? str(a.url) : `https://${str(a.url)}`)}`
        break
      case 'click':
        if (!target) return 'Say what to click: a number from the outline in ref, or a position from a picture in coordinate.'
        doing = 'Clicking'
        break
      case 'type':
        doing = text.length > 60 ? `Typing ${text.length} characters` : `Typing ${quote(text)}`
        break
      case 'select':
        if (ref === undefined || !text) return 'For select, give the dropdown in ref and the option in text.'
        doing = `Choosing ${quote(text)}`
        break
      case 'press':
        if (!str(a.key)) return 'Give the key to press in key, for example Enter or Control+A.'
        doing = `Pressing ${str(a.key)}`
        break
      case 'scroll':
        doing = `Scrolling ${str(a.direction) || 'down'}`
        break
      case 'back':
        doing = 'Going back'
        break
      case 'forward':
        doing = 'Going forward'
        break
      case 'reload':
        doing = 'Reloading the page'
        break
      case 'find':
        if (!text) return 'Give the words to look for in text.'
        doing = `Looking for ${quote(text)}`
        break
      case 'look':
        doing = 'Looking at the page'
        break
      case 'read':
        doing = 'Reading the page'
        break
      case 'wait':
        doing = 'Waiting for the page'
        break
      case 'sign_in':
        {
          const u = str(a.url)
          // A local file has a name rather than a site.
          const site = !u ? '' : /^[a-zA-Z]:[\\/]/.test(u) ? u.split(/[\\/]/).pop() || '' : siteOf(/^[a-z]+:/i.test(u) ? u : `https://${u}`)
          doing = site ? `Asking you to sign in to ${site}` : 'Asking you to sign in'
        }
        break
      default:
        return `"${action}" is not something the browser tool does. Use open, click, type, select, press, scroll, back, forward, reload, find, look, read, wait, sign_in or close.`
    }

    const step = this.begin(session, 'browser', action, doing)
    try {
      let lead = ''
      let did = doing
      let at: PagePoint | null | undefined
      if (a.accept === true) await b.acceptNext()
      switch (action) {
        case 'sign_in': {
          // The page goes up first, so the user lands on it, then the agent waits for them.
          if (str(a.url)) await b.navigate(str(a.url))
          const site = siteOf(b.state().url || str(a.url)) || 'the site'
          const ok = await session.askSignIn(site, b.state().url || str(a.url), text)
          did = ok ? `You signed in to ${site}` : `You did not sign in to ${site}`
          lead = ok
            ? `The user says they have signed in to ${site} in your browser. The sign-in is kept for the whole team, so next time it is already done. Check the page below and carry on.`
            : `The user did not sign in to ${site}. Carry on without it if you can, or say in your reply what you could not do and why.`
          break
        }
        case 'open':
          await b.navigate(str(a.url))
          did = `Opened ${siteOf(b.state().url || str(a.url))}`
          lead = `${did}.`
          break
        case 'click':
          at = await b.click(target as { ref?: number; x?: number; y?: number })
          did = at.label ? `Clicked ${quote(at.label)}` : 'Clicked'
          lead = `${did}.`
          break
        case 'type':
          at = await b.type(text, { ref, append: a.append === true, submit: a.submit === true })
          did = `${text.length > 60 ? `Typed ${text.length} characters` : `Typed ${quote(text)}`}${at?.label ? ` into ${quote(at.label, 30)}` : ''}${a.submit === true ? ' and pressed Enter' : ''}`
          lead = `${did}.`
          break
        case 'select':
          at = await b.select(ref as number, text)
          did = `Chose ${quote(at.label)}`
          lead = `${did}.`
          break
        case 'press':
          await b.press(str(a.key))
          did = `Pressed ${str(a.key)}`
          lead = `${did}.`
          break
        case 'scroll': {
          const dir = (['up', 'down', 'left', 'right'] as const).find((d) => d === a.direction) || 'down'
          await b.scroll(dir, num(a.amount) ?? 1, target)
          did = `Scrolled ${dir}`
          lead = `${did}.`
          break
        }
        case 'back':
        case 'forward':
        case 'reload': {
          const ok = await b.history(action)
          did = action === 'reload' ? 'Reloaded the page' : ok ? `Went ${action}` : `Could not go ${action}`
          lead = ok ? `${did}.` : `There is no page to go ${action} to.`
          break
        }
        case 'find': {
          const ok = await b.find(text)
          did = ok ? `Found ${quote(text)}` : `Did not find ${quote(text)}`
          lead = ok ? `${did} and scrolled to it.` : `${quote(text)} does not appear on this page.`
          break
        }
        case 'wait':
          await sleep(Math.max(0.2, Math.min(30, num(a.amount) ?? 2)) * 1000)
          did = 'Waited'
          lead = 'Waited.'
          break
        case 'look':
          did = 'Looked at the page'
          break
        case 'read':
          did = 'Read the page'
          break
      }
      point(at, did)
      const pic = await b.picture(this.shotFile(chat.id, step.id)).catch(() => null)
      const st = b.state()
      this.finish(session, step, { label: did, url: st.url || undefined, shot: pic ? this.shotFile(chat.id, step.id) : undefined, x: at ? at.x / b.width : undefined, y: at ? at.y / b.height : undefined })
      this.publish(scr)
      this.touch(scr)

      if (action === 'read') {
        const body = truncate((await b.text()).trim(), 30000)
        return `<page title="${st.title.replace(/"/g, "'")}" address="${st.url}">\n${body || '(The page has no text.)'}\n</page>`
      }
      const snap = await b.snapshot()
      const out = this.pageText(snap, lead)
      if (action === 'look' && pic) {
        return { text: `${out}\n\nThe picture shows the part of the page in view, ${pic.width} by ${pic.height} pixels. A position in it can be passed as coordinate.`, images: [{ data: pic.data, mime: 'image/jpeg' }] }
      }
      return out
    } catch (e) {
      const why = (e as Error).message
      this.fail(session, step, why)
      this.publish(scr)
      return { text: `That did not work: ${why}`, isError: true }
    }
  }

  // ───────────── the computer ─────────────

  private async mayControl(session: AgentSession): Promise<string | null> {
    const s = this.host.settings()
    const name = session.account.name
    if (s.computer === 'off') return 'Control of the computer is switched off in Settings. Do the task another way, or tell the user it needs that switched on.'
    if ((this.blocked.get(session.key) || 0) > Date.now()) return 'The user stopped you. Do not touch the computer again until they ask.'
    const other = this.driving
    if (other && other.session !== session) {
      if (other.session.busy) return `${other.session.account.name} is using the computer right now, and only one teammate can at a time. Carry on with something else, or try again when they are done.`
      this.letGo()
    }
    if (s.computer === 'on' || this.granted.has(session.chat.id)) return null
    const ac = new AbortController()
    this.asks.set(session.key, ac)
    try {
      const { decision } = await session.askPermission({
        toolName: 'mcp__team__computer',
        title: `${name} wants to use your mouse and keyboard`,
        detail: 'It will see your main display and work in your apps for the rest of this chat. A notice stays on screen while it is in control, and pressing Esc stops it.',
        input: {},
        canRemember: true,
        signal: ac.signal,
      })
      if (decision === 'deny') return 'The user did not allow control of the computer. Do the task another way, or explain what you need it for.'
      if (decision === 'always') this.host.updateSettings({ computer: 'on' })
      this.granted.add(session.chat.id)
      return null
    } finally {
      this.asks.delete(session.key)
    }
  }

  private desktopScreen(session: AgentSession): Screen {
    const key = this.key(session.chat.id, session.account.id, 'desktop')
    let scr = this.screens.get(key)
    if (!scr) {
      scr = { key, watchers: 0, full: 0, state: { chatId: session.chat.id, accountId: session.account.id, kind: 'desktop', active: false, width: SHOT_W, height: 720 } }
      this.screens.set(key, scr)
    }
    return scr
  }

  private take(session: AgentSession): Screen {
    const scr = this.desktopScreen(session)
    if (this.driving?.session !== session) {
      this.letGo()
      this.driving = { session }
      this.drivers.control?.begin({ name: session.account.name, accent: session.account.accent }, () => {
        this.blocked.set(session.key, Date.now() + 6000)
        this.host.stop(session.chat.id, session.account.id)
        this.letGo()
      })
      this.stream()
    }
    const d = this.driving as NonNullable<Hands['driving']>
    if (d.idle) clearTimeout(d.idle)
    // Hands the screen back when the agent has moved on to other work.
    d.idle = setTimeout(() => this.driving?.session === session && this.letGo(), DESKTOP_IDLE_MS)
    if (!scr.state.active) {
      scr.state.active = true
      this.publish(scr)
    }
    return scr
  }

  private letGo(): void {
    const d = this.driving
    if (!d) return
    this.driving = null
    if (d.idle) clearTimeout(d.idle)
    if (d.stream) clearInterval(d.stream)
    this.drivers.control?.end()
    // Nobody is in control any more, so there is no live screen to show: only the recording remains.
    const scr = this.screens.get(this.key(d.session.chat.id, d.session.account.id, 'desktop'))
    if (scr) this.drop(scr)
  }

  /** While someone is watching the computer's screen in the app, keep the picture fresh. */
  private stream(): void {
    const d = this.driving
    if (!d) return
    if (d.stream) clearInterval(d.stream)
    d.stream = undefined
    const scr = this.screens.get(this.key(d.session.chat.id, d.session.account.id, 'desktop'))
    if (!scr || scr.full <= 0 || !this.drivers.desktop) return
    const file = path.join(this.host.dataDir, 'chats', d.session.chat.id, 'screens', 'live.jpg')
    let busy = false
    d.stream = setInterval(() => {
      if (busy || this.driving !== d) return
      busy = true
      void this.drivers.desktop
        ?.shot(file, SHOT_W, SHOT_H, 60)
        .then((s) => this.sendShot(scr, s))
        .catch(() => undefined)
        .finally(() => (busy = false))
    }, 700)
  }

  private sendShot(scr: Screen, s: DesktopShot): void {
    try {
      this.host.frame({ key: scr.key, width: s.width, height: s.height, data: fs.readFileSync(s.file) })
    } catch {
      /* the picture is still saved for the replay */
    }
    if (scr.state.width !== s.width || scr.state.height !== s.height) {
      scr.state.width = s.width
      scr.state.height = s.height
    }
  }

  private async useComputer(session: AgentSession, a: Record<string, unknown>): Promise<string | ToolOutput> {
    const desk = this.drivers.desktop
    if (!desk?.available()) return 'This computer cannot be controlled from here. Do the task another way.'
    const refusal = await this.mayControl(session)
    if (refusal) return refusal
    const scr = this.take(session)
    const action = str(a.action)
    const text = str(a.text)
    const { chat } = session

    // Positions arrive in the pixels of the picture the agent last saw.
    if (!this.scale) {
      const probe = await desk.shot(this.shotFile(chat.id, 'probe'), SHOT_W, SHOT_H, 40)
      this.scale = { x: probe.screenWidth / probe.width, y: probe.screenHeight / probe.height }
      scr.state.width = probe.width
      scr.state.height = probe.height
      fs.rmSync(probe.file, { force: true })
    }
    const sc = this.scale
    const real = (p: [number, number]): [number, number] => [p[0] * sc.x, p[1] * sc.y]
    const xy = pair(a.coordinate)
    const from = pair(a.start_coordinate)

    let doing: string
    let settle = 700
    switch (action) {
      case 'screenshot':
        doing = 'Looking at the screen'
        settle = 0
        break
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click':
        if (!xy) return 'Give the position to click in coordinate, as [x, y] pixels of the latest screenshot.'
        doing = action === 'right_click' ? 'Right-clicking' : action === 'double_click' ? 'Double-clicking' : 'Clicking'
        break
      case 'mouse_move':
        if (!xy) return 'Give the position in coordinate.'
        doing = 'Moving the pointer'
        settle = 350
        break
      case 'left_click_drag':
        if (!xy || !from) return 'A drag needs start_coordinate and coordinate.'
        doing = 'Dragging'
        break
      case 'type':
        if (!text) return 'Give the text to type in text.'
        doing = text.length > 60 ? `Typing ${text.length} characters` : `Typing ${quote(text)}`
        settle = 450
        break
      case 'key':
        if (!text) return 'Give the key or combination in text, for example "ctrl+s" or "Return".'
        doing = `Pressing ${text}`
        break
      case 'scroll':
        doing = `Scrolling ${str(a.scroll_direction) || 'down'}`
        settle = 500
        break
      case 'wait':
        doing = 'Waiting'
        settle = 0
        break
      case 'open':
        if (!text) return 'Say what to open in text: a program name, a file path or a web address.'
        doing = `Opening ${truncate(text, 40)}`
        settle = 2200
        break
      case 'windows':
        doing = 'Checking which windows are open'
        settle = 0
        break
      case 'focus_window':
        if (!text) return 'Give part of the window title in text.'
        doing = `Bringing ${quote(text, 30)} to the front`
        settle = 500
        break
      default:
        return `"${action}" is not something the computer tool does. Use screenshot, left_click, right_click, double_click, mouse_move, left_click_drag, type, key, scroll, wait, open, windows or focus_window.`
    }

    this.drivers.control?.say(doing)
    const step = this.begin(session, 'desktop', action, doing)
    try {
      let did = doing
      let note = ''
      let at: [number, number] | undefined
      switch (action) {
        case 'left_click':
        case 'right_click':
        case 'middle_click':
        case 'double_click':
        case 'triple_click': {
          at = xy as [number, number]
          const [x, y] = real(at)
          await desk.click(x, y, action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left', action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1)
          did = `${action === 'right_click' ? 'Right-clicked' : action === 'double_click' ? 'Double-clicked' : 'Clicked'} at ${Math.round(at[0])}, ${Math.round(at[1])}`
          break
        }
        case 'mouse_move': {
          at = xy as [number, number]
          const [x, y] = real(at)
          await desk.move(x, y)
          did = 'Moved the pointer'
          break
        }
        case 'left_click_drag': {
          at = xy as [number, number]
          const [x1, y1] = real(from as [number, number])
          const [x2, y2] = real(at)
          await desk.drag(x1, y1, x2, y2)
          did = 'Dragged'
          break
        }
        case 'type':
          await desk.type(text)
          did = text.length > 60 ? `Typed ${text.length} characters` : `Typed ${quote(text)}`
          break
        case 'key': {
          const run = (): Promise<void> => desk.key(text)
          // Esc is also how the person stops the agent, so ours must not count as theirs.
          if (/\b(esc|escape)\b/i.test(text) && this.drivers.control) await this.drivers.control.pause(run)
          else await run()
          did = `Pressed ${text}`
          break
        }
        case 'scroll': {
          const dir = str(a.scroll_direction) || 'down'
          const n = Math.max(1, Math.min(30, Math.round(num(a.scroll_amount) ?? 3)))
          const c = await desk.cursor()
          const [x, y] = xy ? real(xy) : [c.x, c.y]
          at = xy
          await desk.scroll(x, y, dir === 'left' ? -n : dir === 'right' ? n : 0, dir === 'up' ? n : dir === 'down' ? -n : 0)
          did = `Scrolled ${dir}`
          break
        }
        case 'wait':
          await sleep(Math.max(0.2, Math.min(30, num(a.duration) ?? 2)) * 1000)
          did = 'Waited'
          break
        case 'screenshot':
          did = 'Looked at the screen'
          break
        case 'windows':
          did = 'Checked which windows are open'
          break
        case 'open':
          await desk.open(text)
          did = `Opened ${truncate(text, 40)}`
          break
        case 'focus_window': {
          const want = text.toLowerCase()
          const all = await desk.windows()
          const w = all.find((x) => x.title.toLowerCase().includes(want)) || all.find((x) => x.app.toLowerCase() === want)
          if (!w) throw new Error(`No open window has "${text}" in its title. Open windows: ${all.map((x) => x.title).slice(0, 12).join(' | ') || 'none'}`)
          await desk.focus(w.id)
          did = `Brought ${quote(w.title, 30)} to the front`
          break
        }
      }
      if (action === 'screenshot' || action === 'windows' || action === 'focus_window' || action === 'open') {
        if (settle) await sleep(settle)
        settle = 0
        const all = await desk.windows().catch(() => [])
        if (all.length) note = `\nOpen windows, front first: ${all.slice(0, 14).map((w) => `${w.title}${w.minimized ? ' (minimized)' : ''}`).join(' | ')}`
      }
      if (settle) await sleep(settle)
      const shot = await desk.shot(this.shotFile(chat.id, step.id), SHOT_W, SHOT_H)
      this.scale = { x: shot.screenWidth / shot.width, y: shot.screenHeight / shot.height }
      this.sendShot(scr, shot)
      const px = at ? at[0] / shot.width : shot.cursorX / shot.screenWidth
      const py = at ? at[1] / shot.height : shot.cursorY / shot.screenHeight
      scr.state.pointer = { x: px, y: py, action, label: did, ts: Date.now() }
      this.finish(session, step, { label: did, shot: shot.file, x: at ? px : undefined, y: at ? py : undefined })
      this.publish(scr)
      this.drivers.control?.say(did)
      return {
        text: `${did}. This is the screen now, ${shot.width} by ${shot.height} pixels; positions are counted from its top-left corner.${note}`,
        images: [{ data: fs.readFileSync(shot.file).toString('base64'), mime: 'image/jpeg' }],
      }
    } catch (e) {
      const why = (e as Error).message
      this.fail(session, step, why)
      return { text: `That did not work: ${why}`, isError: true }
    }
  }

  // ───────────── what agents are offered ─────────────

  toolsFor(session: AgentSession): TeamTool[] {
    const can = this.abilities()
    const tools: TeamTool[] = []
    if (can.browser) {
      tools.push({
        name: 'browser',
        description:
          'Use a real web browser that is yours in this chat: open pages, click, type, scroll and read. The user can watch it live and can take the mouse themselves, for example to sign in. Each call returns an outline of the page with a number in brackets before everything you can click or type into; pass that number as ref. The look action also returns a picture, for when layout or images matter; pictures cost more allowance than the outline, so look when you need to see. For reading a public page or searching the web, your own web tools are quicker. Use the browser when a page needs interaction or a signed-in session, or to check how something looks, such as a site the team is building.',
        schema: {
          action: z
            .enum(['open', 'click', 'type', 'select', 'press', 'scroll', 'back', 'forward', 'reload', 'find', 'look', 'read', 'wait', 'sign_in', 'close'])
            .describe(
              'open (needs url) · click (ref or coordinate) · type (text, optional ref; replaces what the box held unless append is true) · select (ref and text: choose a dropdown option) · press (key) · scroll (direction, amount in screens) · back · forward · reload · find (text: scroll to where it appears) · look (outline plus a picture) · read (the whole page as text) · wait (amount in seconds) · sign_in (url of the sign-in page, text saying why you need it: asks the user to sign in in your browser and waits until they have) · close',
            ),
          url: z.string().optional().describe('For open: the address, a localhost address, or a path to a local HTML file'),
          ref: z.number().optional().describe('The number in brackets of the element to act on, from the latest outline'),
          coordinate: z.array(z.number()).optional().describe('[x, y] in the picture from look, for something that has no number'),
          text: z.string().optional().describe('For type: the text. For select: the option. For find: the words to look for. For sign_in: why you need the user signed in, in a sentence'),
          key: z.string().optional().describe('For press: a key or combination, such as Enter, Escape, Tab, ArrowDown, PageDown, Control+A'),
          direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('For scroll'),
          amount: z.number().optional().describe('For scroll: screens to move (default 1). For wait: seconds (default 2)'),
          submit: z.boolean().optional().describe('For type: press Enter afterwards'),
          append: z.boolean().optional().describe('For type: add to what the box holds instead of replacing it'),
          accept: z.boolean().optional().describe('Answer OK if the page asks "are you sure?" during this action. Without it, such a question is answered Cancel'),
        },
        run: (a) => this.useBrowser(session, a),
      })
    }
    if (can.computer) {
      tools.push({
        name: 'computer',
        description:
          "See and control this computer's screen with the mouse and keyboard, the way the user would. Every action returns a fresh picture of the main display; positions are pixels in that picture, counted from its top-left corner. The user sees a notice while you are in control and can stop you with Esc. It is slow, and each picture costs allowance, so when a command or a file edit does the same job, do that instead; use this for what only exists in an app's window. Check the picture after each step before taking the next. Only one teammate can use the computer at a time.",
        schema: {
          action: z
            .enum(['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move', 'left_click_drag', 'type', 'key', 'scroll', 'wait', 'open', 'windows', 'focus_window'])
            .describe(
              'screenshot · left_click, right_click, middle_click, double_click, triple_click, mouse_move (coordinate) · left_click_drag (start_coordinate and coordinate) · type (text) · key (text, such as "ctrl+s", "alt+tab", "Return", "win") · scroll (scroll_direction, scroll_amount, optional coordinate) · wait (duration) · open (text: a program name, file path or web address) · windows (list the open windows) · focus_window (text: part of a window title)',
            ),
          coordinate: z.array(z.number()).optional().describe('[x, y] in pixels of the latest picture'),
          start_coordinate: z.array(z.number()).optional().describe('For left_click_drag: where the drag starts'),
          text: z.string().optional().describe('The text to type, the key to press, what to open, or part of a window title'),
          scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
          scroll_amount: z.number().optional().describe('Notches of the mouse wheel (default 3)'),
          duration: z.number().optional().describe('For wait: seconds'),
        },
        run: (a) => this.useComputer(session, a),
      })
    }
    return tools
  }

  // ───────────── what the person does ─────────────

  /** Someone started or stopped looking at a screen. `full` is the live view; otherwise a small picture that only needs an occasional frame. */
  watch(key: string, on: boolean, full = false): void {
    const scr = this.screens.get(key)
    if (!scr) return
    if (full) scr.full = Math.max(0, scr.full + (on ? 1 : -1))
    else scr.watchers = Math.max(0, scr.watchers + (on ? 1 : -1))
    scr.surface?.watch(levelOf(scr))
    if (scr.state.kind === 'desktop') this.stream()
  }

  /** Sends the current picture of a screen again, for a viewer that missed the last one. */
  refresh(key: string): void {
    const scr = this.screens.get(key)
    if (scr?.surface) scr.surface.watch(levelOf(scr))
  }

  input(chatId: string, accountId: string, ev: ScreenInput): void {
    this.screens.get(this.key(chatId, accountId, 'browser'))?.surface?.input(ev)
  }

  async go(chatId: string, accountId: string, to: string): Promise<void> {
    const scr = this.browserFor(chatId, accountId)
    const b = scr.surface as BrowserSurface
    this.touch(scr)
    if (to === 'back' || to === 'forward' || to === 'reload') await b.history(to)
    else await b.navigate(to)
    this.publish(scr)
  }

  async open(chatId: string, accountId: string, url?: string): Promise<void> {
    if (!this.host.settings().browser) throw new Error('The browser is switched off in Settings.')
    const scr = this.browserFor(chatId, accountId)
    this.touch(scr)
    this.publish(scr)
    if (url) await this.go(chatId, accountId, url)
  }

  close(chatId: string, accountId: string): void {
    this.screens.get(this.key(chatId, accountId, 'browser'))?.surface?.close()
  }

  // ───────────── lifecycle ─────────────

  /** A turn ended: the agent's screens go quiet and the computer is handed back. */
  release(session: AgentSession): void {
    this.asks.get(session.key)?.abort()
    if (this.driving?.session === session) this.letGo()
    const desk = this.screens.get(this.key(session.chat.id, session.account.id, 'desktop'))
    if (desk) this.drop(desk)
    const scr = this.screens.get(this.key(session.chat.id, session.account.id, 'browser'))
    if (scr?.state.active) {
      scr.state.active = false
      this.publish(scr)
    }
  }

  closeChat(chatId: string): void {
    this.granted.delete(chatId)
    if (this.driving?.session.chat.id === chatId) this.letGo()
    for (const scr of [...this.screens.values()]) {
      if (scr.state.chatId !== chatId) continue
      if (scr.surface) scr.surface.close()
      else this.drop(scr)
    }
  }

  dispose(): void {
    this.letGo()
    for (const scr of [...this.screens.values()]) scr.surface?.close()
    this.screens.clear()
    this.drivers.desktop?.dispose()
  }
}
