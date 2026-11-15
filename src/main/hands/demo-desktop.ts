import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { DesktopDriver, DesktopShot, DesktopWindow } from './types'

// A pretend computer for demo mode: a drawn desktop with one small app on it.
// It lets the whole flow of "an agent uses your computer" be shown and checked
// without anything touching the real mouse, keyboard or screen.

const W = 1920
const H = 1080

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif}
body{background:radial-gradient(1200px 700px at 22% 18%,#f6d7b8 0%,transparent 60%),radial-gradient(1100px 800px at 82% 78%,#7e9ad6 0%,transparent 62%),linear-gradient(135deg,#27405f,#6f8fb8 55%,#e7c4a4)}
#win{display:none;position:absolute;left:500px;top:190px;width:920px;height:590px;border-radius:14px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.12),0 40px 100px rgba(10,20,40,.45);overflow:hidden}
#bar{height:48px;background:#f4f2ed;display:flex;align-items:center;gap:10px;padding:0 18px;font-size:15px;color:#3b3934;border-bottom:1px solid #e6e2d9}
#bar b{font-weight:600}#saved{margin-left:auto;color:#1c9a55;font-size:14px;display:none}
#t{padding:30px 34px;font-size:24px;line-height:1.5;color:#1f1e1b;white-space:pre-wrap;min-height:300px}
#t:empty::before{content:'Start typing…';color:#b9b6ae}
#task{position:absolute;left:0;right:0;bottom:0;height:56px;background:rgba(18,22,30,.74);display:flex;align-items:center;justify-content:center;gap:14px}
.ic{width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#ffd27a,#f08a3c)}.ic:nth-child(2){background:linear-gradient(135deg,#8fd3ff,#3b74f0)}.ic:nth-child(3){background:linear-gradient(135deg,#b6f0c4,#1fa35a)}.ic:nth-child(4){background:linear-gradient(135deg,#e2c9ff,#7a52e6)}
#clock{position:absolute;right:26px;color:#e9ecf2;font-size:14px}
#cur{position:absolute;left:960px;top:540px;width:26px;height:26px;transition:left .25s,top .25s}
</style></head><body>
<div id="win"><div id="bar"><b>Notes</b><span>Untitled</span><span id="saved">Saved</span></div><div id="t"></div></div>
<div id="task"><div class="ic"></div><div class="ic"></div><div class="ic"></div><div class="ic"></div><span id="clock">15:04</span></div>
<svg id="cur" viewBox="0 0 20 20"><path d="M2.2 1.6 17 8.3l-6.3 1.9-2.1 6.2L2.2 1.6Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
<script>
function openApp(){document.getElementById('win').style.display='block'}
function typeText(s){openApp();var t=document.getElementById('t');t.textContent+=s;document.getElementById('saved').style.display='none'}
function save(){document.getElementById('saved').style.display='inline'}
function cursor(x,y){var c=document.getElementById('cur');c.style.left=x+'px';c.style.top=y+'px'}
</script></body></html>`

export class DemoDesktop implements DesktopDriver {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private x = W / 2
  private y = H / 2
  private open_ = false

  available(): boolean {
    return true
  }

  private page(): Promise<BrowserWindow> {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, frame: false, skipTaskbar: true, webPreferences: { offscreen: true, sandbox: true } })
      this.win.setContentSize(W, H)
      this.ready = this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
    }
    const w = this.win
    return (this.ready as Promise<void>).then(() => w)
  }

  private async js(code: string): Promise<void> {
    const w = await this.page()
    await w.webContents.executeJavaScript(code).catch(() => undefined)
  }

  async shot(file: string, maxWidth: number, maxHeight: number, quality = 72): Promise<DesktopShot> {
    const w = await this.page()
    await new Promise((r) => setTimeout(r, 320))
    const full = await w.webContents.capturePage()
    const s = Math.min(1, maxWidth / W, maxHeight / H)
    const img = full.resize({ width: Math.round(W * s), height: Math.round(H * s), quality: 'good' })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, img.toJPEG(quality))
    const size = img.getSize()
    return { file, width: size.width, height: size.height, screenWidth: W, screenHeight: H, cursorX: this.x, cursorY: this.y }
  }

  async move(x: number, y: number): Promise<void> {
    this.x = x
    this.y = y
    await this.js(`cursor(${Math.round(x)},${Math.round(y)})`)
  }

  click(x: number, y: number): Promise<void> {
    return this.move(x, y)
  }

  press(x: number, y: number): Promise<void> {
    return this.move(x, y)
  }

  drag(_x1: number, _y1: number, x2: number, y2: number): Promise<void> {
    return this.move(x2, y2)
  }

  scroll(x: number, y: number): Promise<void> {
    return this.move(x, y)
  }

  type(text: string): Promise<void> {
    this.open_ = true
    return this.js(`typeText(${JSON.stringify(text)})`)
  }

  key(combo: string): Promise<void> {
    return /ctrl\+s/i.test(combo) ? this.js('save()') : Promise.resolve()
  }

  async windows(): Promise<DesktopWindow[]> {
    return this.open_ ? [{ id: '1', title: 'Untitled - Notes', app: 'Notes', x: 500, y: 190, width: 920, height: 590, front: true, minimized: false }] : []
  }

  async focus(): Promise<boolean> {
    return this.open_
  }

  open(): Promise<void> {
    this.open_ = true
    return this.js('openApp()')
  }

  async cursor(): Promise<{ x: number; y: number }> {
    return { x: this.x, y: this.y }
  }

  dispose(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
