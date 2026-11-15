import type { AccentKey, ScreenInput } from '@shared/types'

// The contracts between the hub and the things that actually touch a browser or
// the computer. They are kept free of Electron so the hub can be driven from a
// plain terminal in tests.

/** What a page looks like to an agent: an outline with numbered things to act on. */
export interface PageSnapshot {
  url: string
  title: string
  outline: string
  /** How many numbered elements the outline holds. */
  refs: number
  scrollY: number
  scrollMax: number
  viewHeight: number
  /** The outline covers the part in view and a little beyond; these say whether the page goes on. */
  moreAbove: boolean
  moreBelow: boolean
  /** Things that happened since the last look: a download, a dialog the page raised. */
  notes: string[]
}

/** Where on the page something happened, in page pixels, and what it was. */
export interface PagePoint {
  x: number
  y: number
  label: string
}

export interface Picture {
  /** Base64 JPEG. */
  data: string
  width: number
  height: number
}

/** One agent's browser. */
export interface BrowserSurface {
  readonly width: number
  readonly height: number
  navigate(url: string): Promise<void>
  history(dir: 'back' | 'forward' | 'reload'): Promise<boolean>
  snapshot(): Promise<PageSnapshot>
  /** The next "are you sure?" box the page raises is answered OK instead of Cancel. */
  acceptNext(): Promise<void>
  click(target: { ref?: number; x?: number; y?: number }, opts?: { double?: boolean; button?: 'left' | 'right' | 'middle' }): Promise<PagePoint>
  type(text: string, opts: { ref?: number; append?: boolean; submit?: boolean }): Promise<PagePoint | null>
  select(ref: number, option: string): Promise<PagePoint>
  press(keys: string): Promise<void>
  scroll(dir: 'up' | 'down' | 'left' | 'right', screens: number, at?: { ref?: number; x?: number; y?: number }): Promise<void>
  find(text: string): Promise<boolean>
  text(): Promise<string>
  /** A picture of the page as it is now, also saved to `file` when given. */
  picture(file?: string): Promise<Picture | null>
  state(): { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
  /** The person's own mouse and keyboard. */
  input(ev: ScreenInput): void
  /** How closely someone is watching: 2 is every frame, 1 an occasional picture, 0 nobody. */
  watch(level: 0 | 1 | 2): void
  close(): void
}

export interface BrowserHooks {
  frame(jpeg: Buffer, width: number, height: number): void
  /** The address, title or loading state changed. */
  changed(): void
  closed(): void
}

export interface BrowserFactory {
  create(hooks: BrowserHooks): BrowserSurface
}

export interface DesktopWindow {
  id: string
  title: string
  app: string
  x: number
  y: number
  width: number
  height: number
  front: boolean
  minimized: boolean
}

export interface DesktopShot {
  file: string
  /** Size of the saved picture. */
  width: number
  height: number
  /** Size of the real screen it was taken from. */
  screenWidth: number
  screenHeight: number
  cursorX: number
  cursorY: number
}

/** The computer's own mouse, keyboard and screen. All positions are real screen pixels. */
export interface DesktopDriver {
  available(): boolean
  shot(file: string, maxWidth: number, maxHeight: number, quality?: number): Promise<DesktopShot>
  move(x: number, y: number): Promise<void>
  click(x: number, y: number, button?: 'left' | 'right' | 'middle', count?: number): Promise<void>
  press(x: number, y: number, down: boolean): Promise<void>
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>
  type(text: string): Promise<void>
  key(combo: string): Promise<void>
  windows(): Promise<DesktopWindow[]>
  focus(id: string): Promise<boolean>
  open(target: string, args?: string): Promise<void>
  cursor(): Promise<{ x: number; y: number }>
  dispose(): void
}

/** What the person sees on their own screen while an agent has the mouse. */
export interface ControlUi {
  /** An agent takes the controls. `stop` runs when the person presses Esc. */
  begin(who: { name: string; accent: AccentKey }, stop: () => void): void
  /** One line about what it is doing now. */
  say(text: string): void
  /** The agent is about to press Esc itself, which must not count as the person's. */
  pause<T>(fn: () => Promise<T>): Promise<T>
  end(): void
}

export interface HandsDrivers {
  browser?: BrowserFactory
  desktop?: DesktopDriver
  control?: ControlUi
}
