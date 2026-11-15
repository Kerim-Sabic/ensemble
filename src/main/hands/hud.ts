import { BrowserWindow, globalShortcut, screen } from 'electron'
import type { AccentKey } from '@shared/types'
import { ACCENT } from '@shared/accents'
import type { ControlUi } from './types'

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** The page drawn over the whole display while an agent has the mouse. Clicks pass straight through it. */
export function hudHtml(name: string, accent: AccentKey): string {
  const a = ACCENT[accent] || ACCENT.slate
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
.edge{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px ${a.to}e6,inset 0 0 34px 3px ${a.to}66,inset 0 0 90px 10px ${a.from}26;animation:breathe 2.8s ease-in-out infinite}
@keyframes breathe{50%{opacity:.58}}
@keyframes drop{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}
.pill{position:fixed;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;height:40px;padding:0 8px 0 11px;border-radius:20px;background:rgba(24,24,22,.9);color:#f2f1ed;font-size:13px;box-shadow:0 0 0 1px rgba(255,255,255,.13),0 12px 34px rgba(0,0,0,.42);max-width:72vw;white-space:nowrap;animation:drop .32s cubic-bezier(.22,1,.36,1) both}
.orb{flex:none;width:18px;height:18px;border-radius:50%;background:radial-gradient(125% 125% at 30% 22%,${a.from} 0%,${a.to} 58%,#000 150%);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.45),0 0 12px ${a.to}99}
.who{font-weight:600}
.what{color:#bdbbb4;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
.kbd{margin-left:4px;padding:4px 9px;border-radius:12px;background:rgba(255,255,255,.12);font-size:11.5px;color:#e6e4de}
.kbd b{font-weight:600;color:#fff}
</style></head><body><div class="edge"></div>
<div class="pill"><span class="orb"></span><span class="who">${esc(name)}</span><span class="what" id="what">is using your computer</span><span class="kbd"><b>Esc</b> to stop</span></div>
<script>function say(t){document.getElementById('what').textContent=t}</script></body></html>`
}

/**
 * What the person sees on their own screen while an agent controls it: a glow
 * around the display, a line saying who is doing what, and Esc as the brake.
 * The app's own window steps aside so the agent sees what is behind it.
 */
export class ScreenHud implements ControlUi {
  private win: BrowserWindow | null = null
  private stop: (() => void) | null = null
  private tucked = false
  private armed = false

  constructor(private main: () => BrowserWindow | null) {}

  private arm(): void {
    if (this.armed || !this.stop) return
    try {
      this.armed = globalShortcut.register('Escape', () => this.stop?.())
    } catch {
      this.armed = false
    }
  }

  private disarm(): void {
    if (!this.armed) return
    this.armed = false
    try {
      globalShortcut.unregister('Escape')
    } catch {
      /* nothing was registered */
    }
  }

  begin(who: { name: string; accent: AccentKey }, stop: () => void): void {
    this.end()
    this.stop = stop
    const display = screen.getPrimaryDisplay()
    const b = display.bounds
    try {
      const win = new BrowserWindow({
        x: b.x,
        y: b.y,
        width: b.width,
        // One row short of the display, so Windows does not treat it as a full-screen app.
        height: b.height - 1,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        fullscreenable: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setIgnoreMouseEvents(true)
      // Keeps the notice out of the pictures the agent takes of the screen.
      win.setContentProtection(true)
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hudHtml(who.name, who.accent))}`)
      win.once('ready-to-show', () => !win.isDestroyed() && win.showInactive())
      this.win = win
    } catch {
      this.win = null
    }
    this.arm()
    // The agent can only work on what it can see: our own window gets out of the way.
    const m = this.main()
    if (m && !m.isDestroyed() && m.isVisible() && !m.isMinimized() && screen.getDisplayMatching(m.getBounds()).id === display.id) {
      m.minimize()
      this.tucked = true
    }
  }

  say(text: string): void {
    const w = this.win
    if (!w || w.isDestroyed()) return
    void w.webContents.executeJavaScript(`say(${JSON.stringify(text)})`).catch(() => undefined)
  }

  async pause<T>(fn: () => Promise<T>): Promise<T> {
    this.disarm()
    try {
      return await fn()
    } finally {
      setTimeout(() => this.arm(), 150)
    }
  }

  end(): void {
    this.disarm()
    this.stop = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    if (this.tucked) {
      this.tucked = false
      const m = this.main()
      if (m && !m.isDestroyed()) {
        m.restore()
        m.focus()
      }
    }
  }
}
