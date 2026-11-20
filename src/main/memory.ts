import fs from 'node:fs'
import path from 'node:path'
import type { HubEvent, MemoryNote } from '@shared/types'
import { chooseCore, coreText, rankNotes, scopeKey, type Core, type NoteKind, type NoteSource, type NoteTrust, type NoteVersion } from '@shared/memory'
import { readJson, truncate, uid, writeJson } from './util'

/** How many earlier states of one note are kept for Undo. */
const MAX_VERSIONS = 12

/** What saving a note needs to know besides its words. */
export interface SaveInput {
  id?: string
  title: string
  body: string
  kind?: NoteKind
  /** A project folder, or null for everywhere. */
  scope?: string | null
  trust?: NoteTrust
  source?: NoteSource
  /** Set when a note should wait for the person's yes before it is used. */
  waiting?: boolean
  /** For a waiting note: the note it would change (or retire) when confirmed. */
  replaces?: string
  retires?: boolean
}

/**
 * The team's memory, with receipts. Every note says what it is, where it came from, how far it can
 * be trusted and which project it belongs to, and keeps its earlier states so a change can be
 * undone. Notes from before receipts are kept as they are and read as "saved before receipts".
 * Forgetting is real: the words leave this file, its earlier versions and its last-good copy.
 */
export class MemoryStore {
  notes: MemoryNote[]
  private file: string

  constructor(
    dataDir: string,
    private emit: (ev: HubEvent) => void,
  ) {
    this.file = path.join(dataDir, 'memory.json')
    this.notes = readJson<MemoryNote[]>(this.file, [])
    // Notes from before receipts: kept, marked by what is known of them.
    for (const n of this.notes) {
      if (n.trust) continue
      n.trust = n.author === 'you' ? 'user' : 'legacy'
      n.status = 'active'
      n.source = { by: n.author, at: n.createdAt }
    }
  }

  private commit(): void {
    this.notes.sort((a, b) => b.updatedAt - a.updatedAt)
    writeJson(this.file, this.notes)
    this.emit({ type: 'memory', notes: this.notes })
  }

  get(id: string): MemoryNote | undefined {
    return this.notes.find((n) => n.id === id)
  }

  /** Notes still in use or waiting, without the forgotten markers. */
  live(): MemoryNote[] {
    return this.notes.filter((n) => n.status !== 'forgotten')
  }

  private snapshot(n: MemoryNote, why: string): void {
    const v: NoteVersion = { title: n.title, body: n.body, kind: n.kind, trust: n.trust, status: n.status, scope: n.scope, source: n.source, at: n.updatedAt, why }
    n.versions = [...(n.versions || []), v].slice(-MAX_VERSIONS)
  }

  /**
   * Saves a note. A note with the same title in the same scope is a newer version of it, not a
   * second copy: the old state is kept in its versions. A waiting note never changes an active one
   * by itself: it is kept beside it until the person says yes.
   */
  save(input: SaveInput, author: string): MemoryNote {
    const now = Date.now()
    const title = truncate(input.title.trim() || 'Untitled', 120)
    const body = truncate(input.body.trim(), 4000)
    const scope = scopeKey(input.scope ?? null)
    const trust: NoteTrust = input.trust || (author === 'you' ? 'user' : 'inferred')
    const status = input.waiting ? 'waiting' : 'active'
    const source: NoteSource = input.source || { by: author, at: now }
    const existing = input.id ? this.get(input.id) : this.notes.find((n) => n.status !== 'forgotten' && n.status !== 'replaced' && (n.scope || null) === scope && n.title.toLowerCase() === title.toLowerCase())
    if (existing && existing.status !== 'forgotten' && !(status === 'waiting' && existing.status === 'active')) {
      if (existing.title === title && existing.body === body && existing.kind === (input.kind || existing.kind)) return existing
      this.snapshot(existing, author === 'you' ? 'edited by you' : 'replaced by a newer note')
      Object.assign(existing, { title, body, kind: input.kind || existing.kind, scope, trust, status, source, updatedAt: now })
      this.commit()
      return existing
    }
    const note: MemoryNote = {
      id: uid('m'),
      title,
      body,
      author,
      createdAt: now,
      updatedAt: now,
      kind: input.kind || 'fact',
      trust,
      status,
      scope,
      source,
      replaces: input.replaces ?? (existing && status === 'waiting' ? existing.id : undefined),
      retires: input.retires || undefined,
    }
    this.notes.push(note)
    this.commit()
    return note
  }

  /** A note that is no longer true: it stops being used, and Undo brings it back. */
  retire(id: string, why = 'retired'): boolean {
    const n = this.get(id)
    if (!n || n.status === 'forgotten' || n.status === 'replaced') return false
    this.snapshot(n, why)
    n.status = 'replaced'
    n.updatedAt = Date.now()
    this.commit()
    return true
  }

  /** Kept for the old API and tools: an agent or the person removing a note retires it. */
  delete(id: string): boolean {
    return this.retire(id, 'removed')
  }

  /** Back to the state before the last change. */
  undo(id: string): MemoryNote | null {
    const n = this.get(id)
    const v = n?.versions?.at(-1)
    if (!n || !v || n.status === 'forgotten') return null
    n.versions = n.versions!.slice(0, -1)
    Object.assign(n, { title: v.title, body: v.body, kind: v.kind, trust: v.trust, status: v.status || 'active', scope: v.scope ?? null, source: v.source, updatedAt: Date.now() })
    this.commit()
    return n
  }

  /**
   * The person's answer to a waiting note. Yes makes it theirs (trust "said by you"), and a note it
   * was meant to change or retire is changed or retired then, with its old state kept. No retires it.
   */
  decide(id: string, yes: boolean): MemoryNote | null {
    const n = this.get(id)
    if (!n || n.status !== 'waiting') return null
    const now = Date.now()
    if (!yes) {
      this.snapshot(n, 'you said no')
      n.status = 'replaced'
      n.updatedAt = now
      this.commit()
      return n
    }
    const target = n.replaces ? this.get(n.replaces) : undefined
    if (target && target.status !== 'forgotten') {
      this.snapshot(target, n.retires ? 'retired, you said yes' : 'replaced by a newer note, you said yes')
      if (n.retires) target.status = 'replaced'
      else Object.assign(target, { title: n.title, body: n.body, kind: n.kind, trust: 'user' as NoteTrust, status: 'active', source: { ...n.source, by: n.source?.by || 'review', at: now }, updatedAt: now })
      target.updatedAt = now
      // The proposal itself has done its job.
      n.status = 'replaced'
      n.updatedAt = now
      this.commit()
      return target
    }
    this.snapshot(n, 'you said yes')
    n.trust = 'user'
    n.status = 'active'
    n.updatedAt = now
    this.commit()
    return n
  }

  /**
   * Forgets a note for good: its words, its quote and every earlier version leave this file and the
   * last-good copy beside it. What stays is a marker that something was forgotten, and when. Returns
   * the words that were removed, so the caller can take them out of anything else that holds them.
   */
  forget(id: string): string[] {
    const n = this.get(id)
    if (!n || n.status === 'forgotten') return []
    const gone = [n.title, n.body, n.source?.quote || '', ...(n.versions || []).flatMap((v) => [v.title, v.body, v.source?.quote || ''])].filter((x) => x && x.length >= 6)
    const now = Date.now()
    const marker: MemoryNote = { id: n.id, title: '', body: '', author: n.author, createdAt: n.createdAt, updatedAt: now, status: 'forgotten', forgottenAt: now }
    this.notes = this.notes.map((x) => (x.id === id ? marker : x))
    // A waiting note that pointed at this one has nothing left to change, and its words (often the same ones) go too.
    for (const x of this.notes) {
      if (x.replaces !== id || x.status !== 'waiting') continue
      for (const w of [x.title, x.body, x.source?.quote || '']) if (w && w.length >= 6 && !gone.includes(w)) gone.push(w)
      x.status = 'replaced'
      x.title = ''
      x.body = ''
      if (x.source) x.source = { ...x.source, quote: undefined }
    }
    this.commit()
    // The last-good copy still holds the words: it goes. The next save makes a new one without them.
    fs.rmSync(`${this.file}.bak`, { force: true })
    fs.rmSync(`${this.file}.pending`, { force: true })
    return gone
  }

  /** What a chat's prompts carry from memory (see chooseCore). */
  core(ctx: { scope?: string | null; about?: string }): Core {
    return chooseCore(this.notes, ctx)
  }

  /** The core as prompt text, or '' when there is nothing in it. */
  digest(ctx: { scope?: string | null; about?: string } = {}): string {
    return coreText(this.core(ctx))
  }

  search(query: string, limit = 8, ctx: { scope?: string | null; everywhere?: boolean } = {}): MemoryNote[] {
    return rankNotes(this.notes, query, ctx)
      .slice(0, limit)
      .map((h) => h.note)
  }
}

/** Replaces every occurrence of the given words inside every string of a JSON value. */
function scrubValue(v: unknown, gone: string[]): unknown {
  if (typeof v === 'string') {
    let out = v
    for (const g of gone) if (out.includes(g)) out = out.split(g).join('(forgotten)')
    return out
  }
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, gone))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[k] = scrubValue(x, gone)
    return o
  }
  return v
}

/** Takes the words out of the rows an open session holds, in place. Returns whether any changed. */
export function scrubItems(items: unknown[], gone: string[]): boolean {
  let changed = false
  for (let i = 0; i < items.length; i++) {
    const before = JSON.stringify(items[i])
    if (!gone.some((g) => before.includes(JSON.stringify(g).slice(1, -1)))) continue
    const after = scrubValue(items[i], gone)
    Object.assign(items[i] as object, after)
    changed = true
  }
  return changed
}

/**
 * Takes forgotten words out of every chat file under the data folder: transcripts and task lists
 * (as JSON, saved the safe way, then without a last-good copy that still holds them) and the
 * execution traces (line by line). That covers what an agent wrote down when it saved the note
 * (memory_save's input and answer) and the quote it rested on, wherever it stands, the person's own
 * message included: there the quoted words read "(forgotten)", and the rest of the chat is kept.
 * Run after open sessions have been scrubbed and flushed. Returns how many files changed.
 */
export function scrubFiles(dataDir: string, gone: string[]): number {
  const words = gone.filter((g) => g.length >= 6)
  if (!words.length) return 0
  const esc = words.map((g) => JSON.stringify(g).slice(1, -1))
  // A trace clips long inputs: the start of the words is enough to find what is left of them there.
  const starts = esc.filter((e) => e.length > 48).map((e) => e.slice(0, 40))
  let changed = 0
  // The chat list holds snippets of what was said: saved the safe way (its checksum stays right), with
  // no last-good or waiting copy left that still holds the words.
  const list = path.join(dataDir, 'chats.json')
  try {
    const raw = fs.readFileSync(list, 'utf8')
    const copies = [`${list}.bak`, `${list}.pending`].filter((p) => fs.existsSync(p) && esc.some((e) => fs.readFileSync(p, 'utf8').includes(e)))
    if (esc.some((e) => raw.includes(e)) || copies.length) {
      writeJson(list, scrubValue(JSON.parse(raw), words))
      for (const p of [`${list}.bak`, `${list}.pending`]) fs.rmSync(p, { force: true })
      changed++
    }
  } catch {
    /* no chat list yet, or unreadable: left as it is */
  }
  const root = path.join(dataDir, 'chats')
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return 0
  }
  for (const d of dirs) {
    const dir = path.join(root, d)
    let files: string[] = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const full = path.join(dir, f)
      if (/^[^.]+\.json$/.test(f)) {
        let raw = ''
        try {
          raw = fs.readFileSync(full, 'utf8')
        } catch {
          continue
        }
        if (!esc.some((e) => raw.includes(e))) continue
        try {
          writeJson(full, scrubValue(JSON.parse(raw), words))
          fs.rmSync(`${full}.bak`, { force: true })
          changed++
        } catch {
          /* unreadable: left as it is */
        }
      } else if (/^trace(\.\d+)?\.jsonl$/.test(f)) {
        let raw = ''
        try {
          raw = fs.readFileSync(full, 'utf8')
        } catch {
          continue
        }
        if (!esc.some((e) => raw.includes(e)) && !starts.some((s) => raw.includes(s))) continue
        let out = raw
        for (const e of esc) out = out.split(e).join('(forgotten)')
        // A clipped copy: from its start to the end of that JSON string.
        for (const s of starts) {
          for (let at = out.indexOf(s); at >= 0; at = out.indexOf(s, at + 11)) {
            let end = at
            while (end < out.length && !(out[end] === '"' && out[end - 1] !== '\\')) end++
            out = `${out.slice(0, at)}(forgotten)${out.slice(end)}`
          }
        }
        fs.writeFileSync(full, out, 'utf8')
        changed++
      }
    }
  }
  return changed
}

/**
 * What the scripted demo team's memory holds, so "What I learned" shows real receipts without real
 * accounts: two things the person said, one decision a run proved, one note an agent inferred that
 * waits for a yes, and one note from before receipts. `folder` is the demo project.
 */
export function demoNotes(folder: string | null, chatId?: string, chatTitle = 'Pricing page'): SaveInput[] {
  const day = 86_400_000
  const now = Date.now()
  return [
    { title: 'Package manager', body: 'Use pnpm in every project, never npm.', kind: 'preference', scope: null, trust: 'user', source: { by: 'review', chatId, chatTitle, quote: 'Always use pnpm, never npm.', at: now - 3 * day } },
    { title: 'How to report', body: 'Lead with what changed and the evidence; keep the explanation to a few lines.', kind: 'preference', scope: null, trust: 'user', source: { by: 'review', chatId, chatTitle: 'Weekly report', quote: 'Lead with what changed and show me the evidence, keep it short.', at: now - 2 * day } },
    { title: 'Annual pricing', body: 'The annual plan is priced at ten months of the monthly price, and the toggle shows both.', kind: 'decision', scope: folder, trust: 'proven', source: { by: 'review', chatId, chatTitle, quote: 'the annual toggle changes the prices', proof: 'Proven by Tests passing (87 of 87)', at: now - day } },
    { title: 'Design reviews', body: 'Kerim seems to want a screenshot of every page change before it is merged.', kind: 'preference', scope: null, trust: 'inferred', waiting: true, source: { by: 'review', chatId, chatTitle, at: now - 3_600_000 } },
  ]
}
