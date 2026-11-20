import { writeJson } from './util'

/**
 * Writes a state file a moment after it changes rather than at every change, through writeJson
 * (checksum, last-good copy, never half-written). A chat's tasks.json, rewritten whole on every
 * task change, was written 276 times in a 36 s scripted run of two Go crazy teams (harness,
 * 2026-11-20); on Kerim's computer that file is 650 KB, and each write also hashes it and waits for
 * the disk twice, on the app's main thread. Changes in the same short window are one write.
 * The wait is short (WRITE_LATER_MS) and everything due is written before the app closes.
 */
export const WRITE_LATER_MS = 300

export class LaterWrites {
  private due = new Map<string, { get: () => unknown; timer: NodeJS.Timeout }>()
  /** Writes done, for the checks. */
  written = 0

  constructor(private ms = WRITE_LATER_MS) {}

  /** `file` changed: it is written within `ms`, with what `get` returns then. */
  put(file: string, get: () => unknown): void {
    const d = this.due.get(file)
    if (d) {
      d.get = get
      return
    }
    this.due.set(file, { get, timer: setTimeout(() => this.write(file), this.ms) })
  }

  private write(file: string): void {
    const d = this.due.get(file)
    if (!d) return
    clearTimeout(d.timer)
    this.due.delete(file)
    writeJson(file, d.get())
    this.written++
  }

  /** Writes now what is due for files under `prefix` (all of them without one). */
  flush(prefix = ''): void {
    for (const f of [...this.due.keys()]) if (f.startsWith(prefix)) this.write(f)
  }

  /** Forgets what is due for files under `prefix` (a chat being deleted), so nothing is written back. */
  drop(prefix: string): void {
    for (const [f, d] of [...this.due]) {
      if (!f.startsWith(prefix)) continue
      clearTimeout(d.timer)
      this.due.delete(f)
    }
  }

  get pending(): number {
    return this.due.size
  }
}
