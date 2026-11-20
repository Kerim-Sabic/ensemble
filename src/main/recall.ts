// Search over the raw record: every chat's own words, returned as the real messages, with the chat,
// the date and who said it. The research behind memory with receipts (Helix, Self-improving agents,
// 2026-11-20) found plain retrieval of the original text matching or beating extracted memories, so
// this is the source of truth; notes are only the small part that is always loaded.
//
// Nothing here runs on the hot path. A chat's index is built the first time a search needs it, a
// little at a time (the work yields between chats and every 2,000 rows), and it is kept until that
// chat's files change. Indexes nobody searched for ten minutes are dropped, so memory stays small.
import fs from 'node:fs'
import path from 'node:path'
import type { Chat, HistoryHit, Item } from '@shared/types'
import { scopeKey, words } from '@shared/memory'

export interface RecallHost {
  dataDir: string
  chats(): Chat[]
  /** The rows of an agent's transcript while its session is open (they may be newer than the file), else null. */
  liveItems(chatId: string, accountId: string): Item[] | null
  nameOf(accountId: string): string
}

interface Row {
  itemId: string
  accountId: string
  user: boolean
  ts: number
  text: string
  len: number
}

interface ChatIndex {
  stamp: string
  rows: Row[]
  /** term -> row numbers, each once */
  post: Map<string, number[]>
  avgLen: number
  used: number
}

const DAY = 86_400_000
const KEEP_MS = 10 * 60_000
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

/** A chat's words, indexed so a search answers in milliseconds however long the chat is. */
export class Recall {
  private indexes = new Map<string, ChatIndex>()
  private building = new Map<string, Promise<ChatIndex>>()
  /** How long the last search took, and how many rows it looked at, for the checks and the report. */
  last = { ms: 0, rows: 0 }

  constructor(private host: RecallHost) {}

  private files(chatId: string): string[] {
    try {
      return fs.readdirSync(path.join(this.host.dataDir, 'chats', chatId)).filter((f) => /^[^.]+\.json$/.test(f) && f !== 'tasks.json')
    } catch {
      return []
    }
  }

  /** What a chat's index was built from: its transcript files and what open sessions hold. Cheap: no file is read. */
  private stamp(chat: Chat): string {
    const parts: string[] = []
    for (const f of this.files(chat.id)) {
      const accountId = f.slice(0, -5)
      const live = this.host.liveItems(chat.id, accountId)
      if (live) {
        parts.push(`${accountId}:live:${live.length}:${live.at(-1)?.id || ''}`)
        continue
      }
      try {
        const st = fs.statSync(path.join(this.host.dataDir, 'chats', chat.id, f))
        parts.push(`${accountId}:${st.size}:${st.mtimeMs}`)
      } catch {
        /* gone since the listing */
      }
    }
    return parts.join('|')
  }

  private async build(chat: Chat, stamp: string): Promise<ChatIndex> {
    const rows: Row[] = []
    for (const f of this.files(chat.id)) {
      const accountId = f.slice(0, -5)
      let items = this.host.liveItems(chat.id, accountId)
      if (!items) {
        try {
          const all = JSON.parse(await fs.promises.readFile(path.join(this.host.dataDir, 'chats', chat.id, f), 'utf8')) as Item[]
          items = Array.isArray(all) ? all : []
        } catch {
          items = []
        }
      }
      for (const it of items) {
        if ((it.kind !== 'user' && it.kind !== 'assistant') || !it.text?.trim()) continue
        rows.push({ itemId: it.id, accountId, user: it.kind === 'user', ts: it.ts, text: it.text, len: 0 })
      }
    }
    const post = new Map<string, number[]>()
    let total = 0
    for (let i = 0; i < rows.length; i++) {
      if (i % 2000 === 1999) await yieldNow()
      const ws = words(rows[i].text)
      rows[i].len = ws.length
      total += ws.length
      for (const w of new Set(ws)) {
        const list = post.get(w)
        if (list) list.push(i)
        else post.set(w, [i])
      }
    }
    return { stamp, rows, post, avgLen: rows.length ? total / rows.length : 1, used: Date.now() }
  }

  private async indexOf(chat: Chat): Promise<ChatIndex> {
    const stamp = this.stamp(chat)
    const have = this.indexes.get(chat.id)
    if (have && have.stamp === stamp) {
      have.used = Date.now()
      return have
    }
    const key = `${chat.id}@${stamp}`
    let p = this.building.get(key)
    if (!p) {
      p = this.build(chat, stamp).finally(() => this.building.delete(key))
      this.building.set(key, p)
    }
    const idx = await p
    this.indexes.set(chat.id, idx)
    return idx
  }

  /** Drops indexes nobody has searched for a while. */
  tidy(now = Date.now()): void {
    for (const [id, idx] of this.indexes) if (now - idx.used > KEEP_MS) this.indexes.delete(id)
  }

  /**
   * The messages that best match a query, best first. Ranked by BM25 over the words (rare words
   * count most), with the words appearing together as a phrase counting extra, the person's own
   * messages a little ahead of the team's, and older messages slowly losing weight (half over a year).
   * `scope` keeps to chats in one project folder; `exclude` leaves one chat out (the one asking).
   */
  async search(query: string, opts: { scope?: string | null; exclude?: string; limit?: number; now?: number } = {}): Promise<HistoryHit[]> {
    const started = performance.now()
    const q = [...new Set(words(query))]
    const limit = opts.limit ?? 8
    const now = opts.now ?? Date.now()
    if (!q.length) return []
    const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim()
    const scope = scopeKey(opts.scope)
    const chats = this.host.chats().filter((c) => c.id !== opts.exclude && (!scope || scopeKey(c.cwd) === scope))
    const hits: HistoryHit[] = []
    let looked = 0
    let n = 0
    for (const chat of chats) {
      if (++n % 4 === 0) await yieldNow()
      const idx = await this.indexOf(chat)
      looked += idx.rows.length
      const N = idx.rows.length
      if (!N) continue
      const scores = new Map<number, number>()
      for (const term of q) {
        const list = idx.post.get(term)
        if (!list) continue
        const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5))
        for (const r of list) {
          const row = idx.rows[r]
          // How often the word is in this row, counted only for rows that have it.
          let tf = 0
          const lower = row.text.toLowerCase()
          for (let at = lower.indexOf(term); at >= 0 && tf < 8; at = lower.indexOf(term, at + term.length)) tf++
          tf = Math.max(1, tf)
          const k1 = 1.2
          const b = 0.75
          const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * row.len) / idx.avgLen))
          scores.set(r, (scores.get(r) || 0) + s)
        }
      }
      for (const [r, base] of scores) {
        const row = idx.rows[r]
        let s = base
        if (phrase.length > 3 && q.length > 1 && row.text.toLowerCase().includes(phrase)) s *= 1.6
        if (row.user) s *= 1.15
        s *= 0.5 + 0.5 * Math.pow(0.5, Math.max(0, now - row.ts) / (365 * DAY))
        hits.push({ chatId: chat.id, title: chat.title, itemId: row.itemId, accountId: row.accountId, who: row.user ? 'you' : this.host.nameOf(row.accountId), ts: row.ts, text: snippet(row.text, q), score: s })
      }
    }
    hits.sort((a, b) => b.score - a.score || b.ts - a.ts)
    this.last = { ms: performance.now() - started, rows: looked }
    this.tidy(now)
    return hits.slice(0, limit)
  }
}

/** Up to about 300 characters of a message around its first matching word. */
export function snippet(text: string, q: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= 300) return flat
  const lower = flat.toLowerCase()
  let at = -1
  for (const t of q) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  const from = Math.max(0, at - 100)
  return `${from > 0 ? '…' : ''}${flat.slice(from, from + 300)}${from + 300 < flat.length ? '…' : ''}`
}

/** One line per hit, for an agent: who said it, when, in which chat, and the words. */
export function historyLines(hits: HistoryHit[], ago: (ts: number) => string): string {
  return hits.map((h) => `${h.who === 'you' ? 'You' : h.who}, ${ago(h.ts)}, in "${h.title}" (row ${h.itemId}):\n${h.text}`).join('\n\n')
}
