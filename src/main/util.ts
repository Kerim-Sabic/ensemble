import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

export const uid = (prefix = ''): string => prefix + randomUUID().replace(/-/g, '').slice(0, 12)

// ───────────── state on disk ─────────────
//
// Every state file (chats, tasks, settings, accounts, transcripts) stays plain JSON that any tool can read.
// Beside `x.json` live up to three small helpers:
//   x.json.sum      the SHA-256 of the state last committed (`cur`) and of the one before it (`prev`).
//                   It is written before the swap, so whatever moment a crash hits, the reader can tell
//                   which copy is whole and which is the newest.
//   x.json.bak      the last good state: the previous live file, moved aside (a rename, never a copy),
//                   kept for files up to BAK_MAX so a long transcript does not take twice its size for good.
//   x.json.pending  the new state when swapping it in kept failing (a scanner or backup holding the file).
//                   The live file is never truncated and rewritten in place; the reader prefers a pending
//                   copy whose checksum is the committed one.
// A temp file is `x.json.<pid>.tmp` (`.a.tmp` for background saves); those of dead processes are removed.

/** Files up to this size keep a last-good copy beside them. Larger ones (long transcripts) rely on the checked swap alone. */
export const BAK_MAX = 8 * 1024 * 1024

/** The file calls a save makes, replaceable in checks to make a rename fail or to stop a save midway. */
export const saveIo = {
  rename: (from: string, to: string): void => fs.renameSync(from, to),
  renameAsync: (from: string, to: string): Promise<void> => fs.promises.rename(from, to),
}

/** What the reader had to do to give back a whole state, newest last (at most 50). Shown loudly in the log as well. */
export const integrityLog: { file: string; what: 'recovered' | 'lost'; from?: string; at: number }[] = []
const report = (file: string, what: 'recovered' | 'lost', from?: string): void => {
  integrityLog.push({ file, what, from, at: Date.now() })
  if (integrityLog.length > 50) integrityLog.shift()
  if (what === 'lost') console.error('[state lost]', file, 'no whole copy could be read; starting from the default')
  else console.error('[state recovered]', file, `the main file was missing, damaged or behind; read ${from} instead`)
}

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
interface Sum {
  cur: string
  prev?: string
}
const readSum = (file: string): Sum | null => {
  try {
    const v = JSON.parse(fs.readFileSync(`${file}.sum`, 'utf8')) as Sum
    return typeof v?.cur === 'string' && /^[0-9a-f]{64}$/.test(v.cur) ? v : null
  } catch {
    return null
  }
}
interface Copy {
  path: string
  hash: string
  value: unknown
  mtime: number
}
/** A copy that parses, with its checksum; null when it is missing or not whole JSON. */
const load = (p: string): Copy | null => {
  try {
    const buf = fs.readFileSync(p)
    const value = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')) as unknown
    return { path: p, hash: sha(buf), value, mtime: fs.statSync(p).mtimeMs }
  } catch {
    return null
  }
}
const alive = (pid: number): boolean => {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const TEMP = /\.(\d+)\.(?:a\.)?tmp$/
/** The temp files beside a state file, with the process that wrote each. */
const tempsOf = (file: string): { path: string; pid: number }[] => {
  try {
    const dir = path.dirname(file)
    const base = `${path.basename(file)}.`
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base) && f.endsWith('.tmp'))
      .map((f) => ({ path: path.join(dir, f), pid: Number(TEMP.exec(f)?.[1] || 0) }))
  } catch {
    return []
  }
}
const swept = new Set<string>()
/** Removes temp files left by processes that are gone, once per folder per run (pass `again` to look once more). */
export function sweepTemps(dir: string, again = false): void {
  if (swept.has(dir) && !again) return
  swept.add(dir)
  try {
    for (const f of fs.readdirSync(dir)) {
      const pid = Number(TEMP.exec(f)?.[1] || 0)
      if (!pid || alive(pid)) continue
      const p = path.join(dir, f)
      // A crashed save that was whole and committed (its checksum is the current one) is the newest
      // state of its file: it stays until that file is read, and the reader adopts it.
      const sum = readSum(p.replace(TEMP, ''))
      if (sum && load(p)?.hash === sum.cur) continue
      fs.rmSync(p, { force: true })
    }
  } catch {
    /* the folder is not there yet */
  }
}

/**
 * Reads a state file, and only ever gives back a whole state. The main file is taken when its
 * checksum is the committed one. Otherwise the newest whole copy wins: a pending or temp copy
 * that carries the committed checksum (a save that was written but not swapped in), then the
 * main file with the checksum of the state before, a main file someone edited after the app's
 * last save, the last-good copy with a known checksum, then anything that at least parses. With no copy left, the fallback, said loudly.
 */
export function readJson<T>(file: string, fallback: T): T {
  const live = load(file)
  const sum = readSum(file)
  if (live && sum && live.hash === sum.cur) return live.value as T
  const pending = load(`${file}.pending`)
  // Files from before checksums, or whose sum was lost: a main file that parses is the state, unless a save is waiting beside it.
  if (live && !sum && !pending) return live.value as T
  const bak = load(`${file}.bak`)
  const temps = tempsOf(file)
  // A save on its way, by this process or another living one: its checksum is already recorded while the
  // old file is still in place. Give the newest whole state (the save's temp file once it is complete,
  // the old file until then) and write nothing: rewriting here would put the old state back over the new one.
  if (sum && live && live.hash === sum.prev) {
    const writing = temps.filter((t) => alive(t.pid))
    if (writing.length) {
      const ahead = writing.map((t) => load(t.path)).find((c) => !!c && c.hash === sum.cur)
      return (ahead || live).value as T
    }
  }
  // A temp file of a process that is still running is a save on its way: it will be swapped in by its writer, so it
  // is left alone while the main file can be used. One left by a dead process is a save that never got swapped in.
  const usable = !!live && (!sum || live.hash === sum.prev)
  const spare = [pending, ...temps.filter((t) => !usable || !alive(t.pid)).map((t) => load(t.path))].filter((c): c is Copy => !!c).sort((a, b) => b.mtime - a.mtime)
  // Written after the app's last save (the checksum is recorded after the state is written): someone edited the
  // file on purpose, by hand or with another tool. A file that changed without being written is damage.
  let edited = false
  try {
    edited = !!live && !!sum && live.mtime > fs.statSync(`${file}.sum`).mtimeMs
  } catch {
    /* no sum to compare with */
  }
  const pick =
    (sum && spare.find((c) => c.hash === sum.cur)) ||
    (sum && live && live.hash === sum.prev ? live : null) ||
    (edited ? live : null) ||
    (sum && bak && (bak.hash === sum.prev || bak.hash === sum.cur) ? bak : null) ||
    // Nothing carries a known checksum. Without a sum, a waiting save is newer than the main file; otherwise
    // a copy that parses is better than none, the main file first (it may have been edited by hand).
    (!sum && pending) ||
    live ||
    bak ||
    spare[0] ||
    null
  const tidy = (): void => {
    for (const t of temps) if (t.pid && !alive(t.pid)) fs.rmSync(t.path, { force: true })
  }
  if (!pick) {
    tidy()
    // A file that was simply never written is the ordinary first run; anything else is a loss.
    if (exists(file) || exists(`${file}.sum`) || exists(`${file}.bak`) || exists(`${file}.pending`) || temps.length) report(file, 'lost')
    return fallback
  }
  // A save that is waiting beside a held file is the state as designed: the next save swaps it in.
  const waiting = !!pending && pick.path === pending.path && !!sum && pick.hash === sum.cur
  if (!waiting) {
    if (pick.path !== file) report(file, 'recovered', path.basename(pick.path))
    // A main file that is damaged (not whole, or not any state the app committed, and not edited after it)
    // is kept aside for diagnosis before it is replaced, so it can never become the last-good copy.
    const damaged = pick.path !== file && exists(file) && (!live || (!!sum && live.hash !== sum.cur && live.hash !== sum.prev && !edited))
    if (damaged) {
      try {
        fs.renameSync(file, `${file}.damaged-${Date.now()}`)
      } catch {
        /* held by another program: the save below still will not keep it as last-good */
      }
    }
    // Put it back as the main file with a checksum that fits, so the next read is the plain one.
    writeJson(file, pick.value)
  }
  tidy()
  return pick.value as T
}

/** Removes a state file for good, with its checksum, last-good and waiting copies, so no reader brings it back. */
export function removeJson(file: string): void {
  for (const f of [file, `${file}.sum`, `${file}.bak`, `${file}.pending`, ...tempsOf(file).map((t) => t.path)]) fs.rmSync(f, { force: true })
}

const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const nap = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Writes a file and makes sure it has reached the disk before returning. */
function writeSynced(p: string, text: string): void {
  const fd = fs.openSync(p, 'w')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
/** The checksum of the state being committed, with that of the state it replaces (what the live file holds now). */
function nextSum(file: string, hash: string): string {
  const was = readSum(file)
  let prev: string | undefined
  // With a save still waiting beside the file, the live file holds the state before that one.
  if (was) prev = exists(`${file}.pending`) ? was.prev : was.cur
  else {
    try {
      prev = sha(fs.readFileSync(file))
    } catch {
      prev = undefined
    }
  }
  if (prev === hash) prev = was?.prev
  return JSON.stringify({ v: 1, cur: hash, prev, at: Date.now() })
}
/**
 * Whether the live file is a state the app committed (or one a person edited after the last save),
 * and so fit to keep as the last-good copy. Read before the new checksum is written. Small files only.
 */
function trustedLive(file: string): boolean {
  try {
    const st = fs.statSync(file)
    if (st.size > BAK_MAX) return false
    // The file is exactly what this app last wrote there (same size and time, so the checksum it
    // recorded is that of this file): trusted without reading and hashing it again. A transcript of
    // a few MB, saved every few seconds while its agent works, used to be read and hashed each time.
    const mine = ownWrites.get(file)
    if (mine && mine.size === st.size && mine.mtimeMs === st.mtimeMs) return true
    const was = readSum(file)
    if (!was) return true // from before checksums
    const h = sha(fs.readFileSync(file))
    if (h === was.cur || h === was.prev) return true
    return st.mtimeMs > fs.statSync(`${file}.sum`).mtimeMs
  } catch {
    return false
  }
}
/**
 * Keeps the live file as the last-good copy (small files only) by giving it a second name: a hard
 * link, so nothing is copied and the live file is never away, not even for a moment. The swap
 * then replaces only the live name. Best effort: where links are not possible, no copy is kept.
 */
/** What this app last put in each file (size and modified time, right after the swap), so the next save can trust it without reading it back. */
const ownWrites = new Map<string, { size: number; mtimeMs: number }>()
function remember(file: string): void {
  try {
    const st = fs.statSync(file)
    ownWrites.set(file, { size: st.size, mtimeMs: st.mtimeMs })
  } catch {
    ownWrites.delete(file)
  }
}

function keepLastGood(file: string, trusted: boolean): void {
  try {
    const whole = fs.statSync(file).size <= BAK_MAX
    // A live file that fails its checksum is damage: the earlier last-good copy stays as it is.
    if (whole && !trusted) return
    fs.rmSync(`${file}.bak`, { force: true })
    if (whole) fs.linkSync(file, `${file}.bak`)
  } catch {
    /* no live file yet, or the disk has no links: nothing to keep */
  }
}

/**
 * Saves a state file so that a crash, a power cut or a held file can never leave the only copy
 * half-written. The new state goes to a temp file and to disk (fsync); its checksum is recorded;
 * the live file is moved aside as the last-good copy; the temp file is swapped in. Another
 * program (a virus scanner, a backup) can hold the file for a moment: that is waited out. When
 * the swap keeps failing, the new state stays beside the file as `.pending`, which the reader
 * prefers, and the live file is left untouched. A save never takes the app down with it.
 */
export function writeJson(file: string, data: unknown): boolean {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    sweepTemps(dir)
    const json = JSON.stringify(data)
    writeSynced(tmp, json)
    const trusted = trustedLive(file)
    writeSynced(`${file}.sum`, nextSum(file, sha(json)))
    for (let i = 0; ; i++) {
      try {
        if (i === 0) keepLastGood(file, trusted)
        saveIo.rename(tmp, file)
        remember(file)
        fs.rmSync(`${file}.pending`, { force: true })
        return true
      } catch (e) {
        if (i >= 5 || !RETRY.has((e as NodeJS.ErrnoException).code || '')) {
          // Swapping the file in keeps failing: keep the new state beside it. The live file is not touched.
          try {
            fs.renameSync(tmp, `${file}.pending`)
          } catch {
            /* the temp file itself carries the committed checksum, and the reader finds it */
          }
          console.error('[save waiting]', file, (e as Error).message)
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
 * state always wins. `flushSync` is for the moment the app is closing. It follows
 * the same rules as writeJson: synced temp file, checksum, last-good copy, swap,
 * and a `.pending` copy instead of an in-place write when the swap keeps failing.
 */
export class Saver {
  private dirty = false
  private writing = false
  private timer: NodeJS.Timeout | null = null
  private last = 0
  private epoch = 0
  /** A save that must not wait for the gap was asked for while another was on its way to disk. */
  private urgent = false
  /** A save within a short time was asked for while another was on its way to disk. */
  private soonMs = 0

  constructor(
    private file: string,
    private get: () => unknown,
    private gapMs = 2500,
  ) {}

  /** Something changed; save it soon. */
  touch(): void {
    this.dirty = true
    if (this.writing || this.timer) return
    const wait = Math.max(0, this.last + this.gapMs - Date.now())
    this.dueAt = Date.now() + wait
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, wait)
  }

  /**
   * Something that should reach the disk soon, but that many other changes arrive with (reports
   * and handoffs in a big team): saved within `ms` of the last save, not at every change.
   */
  soon(ms: number): void {
    this.dirty = true
    if (this.writing) {
      this.soonMs = this.soonMs ? Math.min(this.soonMs, ms) : ms
      return
    }
    const due = Math.max(0, this.last + ms - Date.now())
    // Already waiting for something sooner: leave it. Waiting for the gap: bring it forward.
    if (this.timer) {
      if (this.dueAt <= Date.now() + due) return
      clearTimeout(this.timer)
    }
    this.dueAt = Date.now() + due
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, due)
  }

  private dueAt = 0

  /** A good moment to be up to date on disk (a reply just ended): save now. */
  now(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // A save already on its way holds the older state: this one follows it straight away, not after the gap.
    if (this.writing) this.urgent = true
    else void this.write()
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
      const fh = await fs.promises.open(tmp, 'w')
      try {
        await fh.writeFile(json)
        await fh.sync()
      } finally {
        await fh.close()
      }
      // A save made while this one was on its way to disk is newer; do not put this one over it.
      if (epoch !== this.epoch) {
        await fs.promises.rm(tmp, { force: true })
        return
      }
      const trusted = trustedLive(this.file)
      writeSynced(`${this.file}.sum`, nextSum(this.file, sha(json)))
      for (let i = 0; ; i++) {
        try {
          if (i === 0) keepLastGood(this.file, trusted)
          await saveIo.renameAsync(tmp, this.file)
          remember(this.file)
          await fs.promises.rm(`${this.file}.pending`, { force: true })
          break
        } catch (e) {
          if (i >= 5 || !RETRY.has((e as NodeJS.ErrnoException).code || '')) {
            // Kept beside the file for the reader; the next save tries the swap again.
            await fs.promises.rename(tmp, `${this.file}.pending`).catch(() => undefined)
            throw e
          }
          await new Promise((r) => setTimeout(r, 40 * (i + 1)))
        }
      }
    } catch (e) {
      this.dirty = true
      console.error('[save failed]', this.file, (e as Error).message)
    } finally {
      this.writing = false
      if (this.dirty && this.urgent) {
        this.urgent = false
        void this.write()
      } else if (this.dirty && this.soonMs) {
        const ms = this.soonMs
        this.soonMs = 0
        this.soon(ms)
      } else if (this.dirty && !this.timer) this.touch()
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

/** How fast the scripted demo team runs: ENSEMBLE_DEMO_SPEED, where 2 is twice as fast and 0.5 half. 1 when unset or not a number. */
export function demoSpeed(): number {
  const n = Number(process.env.ENSEMBLE_DEMO_SPEED || '1')
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * A wait as the engine should count it. In demo mode it follows the demo team's speed, so a slowed
 * demo behaves like a normal one stretched in time (and a fast one like a normal one squeezed).
 * Outside demo mode, and at speed 1, it is `ms` unchanged.
 */
export function demoTime(ms: number, demo: boolean): number {
  return demo ? ms / demoSpeed() : ms
}
