import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

export const uid = (prefix = ''): string => prefix + randomUUID().replace(/-/g, '').slice(0, 12)

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T
  } catch {
    // The file is missing or damaged. A copy that was being written when the app died may be whole.
    try {
      const dir = path.dirname(file)
      const base = `${path.basename(file)}.`
      const spare = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(base) && f.endsWith('.tmp'))
        .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      for (const c of spare) {
        try {
          return JSON.parse(fs.readFileSync(c.f, 'utf8')) as T
        } catch {
          /* that one is half-written; try the next */
        }
      }
    } catch {
      /* nothing to fall back on */
    }
    return fallback
  }
}

const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const nap = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Write through a temp file so a crash never leaves half a file behind. Another
 * program (a virus scanner, a backup) can hold the file for a moment; that is
 * waited out, and a save never takes the app down with it.
 */
export function writeJson(file: string, data: unknown): boolean {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const json = JSON.stringify(data)
    fs.writeFileSync(tmp, json)
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file)
        return true
      } catch (e) {
        if (i >= 5 || !RETRY.has((e as NodeJS.ErrnoException).code || '')) {
          // Swapping the file in keeps failing: write it in place rather than lose the save.
          fs.writeFileSync(file, json)
          fs.rmSync(tmp, { force: true })
          return true
        }
        nap(15 * (i + 1))
      }
    }
  } catch (e) {
    console.error('[save failed]', file, (e as Error).message)
    return false
  }
}

/**
 * Saves a large file (a transcript) without making the app wait for the disk:
 * the write happens in the background, at most every so often, and the latest
 * state always wins. `flushSync` is for the moment the app is closing.
 */
export class Saver {
  private dirty = false
  private writing = false
  private timer: NodeJS.Timeout | null = null
  private last = 0
  private epoch = 0

  constructor(
    private file: string,
    private get: () => unknown,
    private gapMs = 2500,
  ) {}

  /** Something changed; save it soon. */
  touch(): void {
    this.dirty = true
    if (this.writing || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, Math.max(0, this.last + this.gapMs - Date.now()))
  }

  /** A good moment to be up to date on disk (a reply just ended): save now. */
  now(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.writing) void this.write()
  }

  private async write(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    this.writing = true
    this.last = Date.now()
    const epoch = this.epoch
    const tmp = `${this.file}.${process.pid}.a.tmp`
    try {
      const json = JSON.stringify(this.get())
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      await fs.promises.writeFile(tmp, json)
      // A save made while this one was on its way to disk is newer; do not put this one over it.
      if (epoch !== this.epoch) {
        await fs.promises.rm(tmp, { force: true })
        return
      }
      for (let i = 0; ; i++) {
        try {
          await fs.promises.rename(tmp, this.file)
          break
        } catch (e) {
          if (i >= 5 || !RETRY.has((e as NodeJS.ErrnoException).code || '')) throw e
          await new Promise((r) => setTimeout(r, 40 * (i + 1)))
        }
      }
    } catch (e) {
      this.dirty = true
      console.error('[save failed]', this.file, (e as Error).message)
    } finally {
      this.writing = false
      if (this.dirty && !this.timer) this.touch()
    }
  }

  flushSync(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty && !this.writing) return
    this.dirty = false
    this.epoch++
    writeJson(this.file, this.get())
  }
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void } {
  let t: NodeJS.Timeout | null = null
  let last: A | null = null
  const run = (): void => {
    t = null
    if (last) {
      const a = last
      last = null
      fn(...a)
    }
  }
  const wrapped = ((...a: A) => {
    last = a
    if (t) clearTimeout(t)
    t = setTimeout(run, ms)
  }) as ((...a: A) => void) & { flush(): void }
  wrapped.flush = () => {
    if (t) clearTimeout(t)
    run()
  }
  return wrapped
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'account'
  )
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${s.slice(0, head)}\n… ${s.length - max} characters hidden …\n${s.slice(-tail)}`
}

// Variables that belong to whichever Claude or Codex session launched us. Passing
// them on would point every agent at the wrong account or the wrong session.
const STRIP_EXACT = new Set([
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_PID',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'CODEX_THREAD_ID',
  'ELECTRON_RUN_AS_NODE',
])
const STRIP_PATTERN = /^CLAUDE_CODE_.*(SESSION|MESSAGING|SOCKET|TOKEN|ENTRYPOINT|CHILD|PARENT|AGENT|TEAM|SSE_PORT)/

export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (STRIP_EXACT.has(k) || STRIP_PATTERN.test(k)) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

export const home = (): string => os.homedir()

export function tildify(p: string): string {
  const h = home()
  return p.toLowerCase().startsWith(h.toLowerCase()) ? '~' + p.slice(h.length) : p
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(v: T): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: v, done: false })
    else this.items.push(v)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters) w({ value: undefined as never, done: true })
    this.waiters = []
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => this.waiters.push(res))
      },
    }
  }
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return (
    { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] ||
    'application/octet-stream'
  )
}
