import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DesktopDriver, DesktopShot, DesktopWindow } from './types'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/** Where the helper program lives: beside the app when installed, in the project while developing. */
export function findHands(extra: string[] = []): string | null {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const places = [...extra, res ? path.join(res, 'hands.exe') : '', path.join(process.cwd(), 'resources', 'hands.exe')].filter(Boolean)
  return places.find((p) => fs.existsSync(p)) || null
}

/**
 * Talks to hands.exe, the small helper that moves the mouse, presses keys and
 * takes pictures of the main display. One command at a time, in order.
 */
export class WindowsDesktop implements DesktopDriver {
  private child: ChildProcess | null = null
  private buf = ''
  private waiting: { resolve(line: string): void; reject(e: Error): void; timer: NodeJS.Timeout }[] = []
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private exe: string | null) {}

  available(): boolean {
    return process.platform === 'win32' && !!this.exe && fs.existsSync(this.exe)
  }

  private start(): ChildProcess {
    if (this.child) return this.child
    if (!this.exe) throw new Error('Computer control is not available in this install.')
    const child = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    this.buf = ''
    const fail = (why: string): void => {
      if (this.child === child) this.child = null
      for (const w of this.waiting.splice(0)) {
        clearTimeout(w.timer)
        w.reject(new Error(why))
      }
    }
    child.on('error', (e) => fail(e.message))
    child.on('exit', () => fail('The helper that controls the computer stopped.'))
    child.stdout?.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8')
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '')
        this.buf = this.buf.slice(i + 1)
        const w = this.waiting.shift()
        if (w) {
          clearTimeout(w.timer)
          w.resolve(line)
        }
      }
    })
    return child
  }

  /** Sends one command and returns what came after "ok". */
  private send(line: string, timeoutMs = 20000): Promise<string> {
    const run = (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        let child: ChildProcess
        try {
          child = this.start()
        } catch (e) {
          reject(e as Error)
          return
        }
        const timer = setTimeout(() => {
          const i = this.waiting.findIndex((w) => w.timer === timer)
          if (i >= 0) this.waiting.splice(i, 1)
          // A reply that never came would shift every later answer by one, so start over.
          this.dispose()
          reject(new Error('The computer did not respond in time.'))
        }, timeoutMs)
        this.waiting.push({
          timer,
          reject,
          resolve: (reply) => {
            if (reply === 'ok' || reply.startsWith('ok ')) resolve(reply.slice(3))
            else reject(new Error(reply.replace(/^err\s*/, '') || 'The action failed.'))
          },
        })
        child.stdin?.write(`${line}\n`)
      })
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  async shot(file: string, maxWidth: number, maxHeight: number, quality = 72): Promise<DesktopShot> {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const r = (await this.send(`shot ${Math.round(maxWidth)} ${Math.round(maxHeight)} ${quality} ${b64(file)}`)).split(' ').map(Number)
    return { file, width: r[0], height: r[1], screenWidth: r[2], screenHeight: r[3], cursorX: r[4], cursorY: r[5] }
  }

  async move(x: number, y: number): Promise<void> {
    await this.send(`move ${Math.round(x)} ${Math.round(y)}`)
  }

  async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', count = 1): Promise<void> {
    await this.send(`click ${Math.round(x)} ${Math.round(y)} ${button} ${count}`)
  }

  async press(x: number, y: number, down: boolean): Promise<void> {
    await this.send(`${down ? 'down' : 'up'} ${Math.round(x)} ${Math.round(y)} left`)
  }

  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await this.send(`drag ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)}`)
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.send(`scroll ${Math.round(x)} ${Math.round(y)} ${Math.round(dx)} ${Math.round(dy)}`)
  }

  async type(text: string): Promise<void> {
    // Long text takes a while to key in; allow for it.
    await this.send(`type ${b64(text)}`, 20000 + text.length * 12)
  }

  async key(combo: string): Promise<void> {
    await this.send(`key ${b64(combo)}`)
  }

  async windows(): Promise<DesktopWindow[]> {
    const raw = await this.send('windows')
    const at = raw.indexOf(' ')
    const body = at < 0 ? '' : raw.slice(at + 1)
    const out: DesktopWindow[] = []
    for (const row of body.split(';')) {
      const f = row.split('|')
      if (f.length < 8) continue
      out.push({
        id: f[0],
        app: f[1],
        x: Number(f[2]),
        y: Number(f[3]),
        width: Number(f[4]),
        height: Number(f[5]),
        front: f[6].includes('f'),
        minimized: f[6].includes('m'),
        title: Buffer.from(f[7], 'base64').toString('utf8'),
      })
    }
    return out
  }

  async focus(id: string): Promise<boolean> {
    return (await this.send(`focus ${id}`)) === 'front'
  }

  async open(target: string, args = ''): Promise<void> {
    await this.send(args ? `open ${b64(target)} ${b64(args)}` : `open ${b64(target)}`)
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const [x, y] = (await this.send('cursor')).split(' ').map(Number)
    return { x, y }
  }

  dispose(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin?.write('quit\n')
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }, 500)
  }
}
