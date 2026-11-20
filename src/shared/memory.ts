// Memory with receipts: the pure parts, shared by the engine, the window and the checks.
//
// What the research behind this says (Helix: Knowledge/Concepts/Self-improving agents.md, 2026-11-20):
// keep the raw record and search it, load little, keep a lesson only with its source, and do not let
// an agent save whatever it likes (agents that keep everything get worse; a small fixed memory and
// strictly checked entries do better). So every note carries where it came from and how much it can
// be trusted, only what the person said or a run proved goes into the part of a prompt that reads as
// instructions, and that part has a small fixed budget chosen by relevance, not by date.

/** What a note is. */
export type NoteKind = 'preference' | 'fact' | 'decision' | 'lesson'
/**
 * How far a note can be trusted, set by the app from where its words came from, never by a model.
 * user: the person said it (or said yes to it). proven: a passing run, a goal a fresh checker
 * confirmed, or an independent review shows it. inferred: an agent's own reading. outside: read
 * from content the team fetched (a page, a file, a tool's output). legacy: saved before receipts.
 */
export type NoteTrust = 'user' | 'proven' | 'inferred' | 'outside' | 'legacy'
/** active: in use. waiting: needs the person's yes first. replaced: a newer note or a retirement took its place. forgotten: its words are gone. */
export type NoteStatus = 'active' | 'waiting' | 'replaced' | 'forgotten'

export const NOTE_KINDS: NoteKind[] = ['preference', 'fact', 'decision', 'lesson']

/** Where a note came from. */
export interface NoteSource {
  /** Who saved it: 'you', an account or agent id, or 'review' (the app's own look back at a chat). */
  by: string
  chatId?: string
  /** The chat's title when the note was made, so the receipt reads well after a rename or deletion. */
  chatTitle?: string
  /** The transcript row the note rests on, and whose transcript it is in. */
  itemId?: string
  accountId?: string
  /** The task it came from, when it came from one. */
  taskId?: string
  /** The exact words in that row the note rests on. */
  quote?: string
  /** What proved it, for a proven note ("Tests passed", "A fresh checker confirmed the goal"). */
  proof?: string
  at: number
}

/** An earlier state of a note, kept when it is changed, so Undo can bring it back. */
export interface NoteVersion {
  title: string
  body: string
  kind?: NoteKind
  trust?: NoteTrust
  status?: NoteStatus
  scope?: string | null
  source?: NoteSource
  at: number
  /** Why it changed: "replaced by a newer note", "edited by you", "retired". */
  why?: string
}

/** The fixed budget of memory that goes into every prompt, in words. About 400 tokens. */
export const CORE_WORDS = 300
/** Of that, at most this much is the person's standing preferences, so a project's notes always get room. */
export const PREFERENCE_WORDS = 180

// ───────────── words ─────────────

const STOP = new Set(
  'a an and are as at be but by can do does for from has have i if in into is it its me my not of on or our so that the their them then there these they this to us was we were what when which who will with you your yes no ok please'.split(' '),
)

/** The words of a text that carry meaning, lower case, with a plain-English plural cut back. */
export function words(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue
    out.push(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw)
  }
  return out
}

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** Text compared loosely: case, runs of space and typographic quotes do not matter. */
export function loose(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether a quote really is in a row's text. Short quotes prove nothing, so they do not count. */
export function quoteIn(rowText: string, quote: string): boolean {
  const q = loose(quote).replace(/^["'\s]+|["'\s.…]+$/g, '')
  if (q.length < 12) return false
  return loose(rowText).includes(q)
}

/** Words that frame a preference without adding to it ("Use the dark theme..." for "dark theme..."). */
const FRAMING = new Set(['use', 'prefer', 'preferred', 'preference', 'user', 'want', 'wants', 'like', 'likes', 'keep', 'should'])
/** Actions a model must never put into every prompt on its own say-so, whatever the quote: they wait for the user's yes. */
const RISKY = /\b(without asking|don'?t ask|do not ask|push(es|ed|ing)?|publish\w*|deploy\w*|delete\w*|pay(s|ing|ment)?|send(s|ing)?)\b/i
/** Words that make a standing order. */
const STANDING = /\b(always|never)\b/i
const flatText = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

/**
 * Whether a note written by a model says only what the user's quote says, so it may be used at once:
 * - no risky action (push, publish, deploy, delete, pay, send, without asking), ever;
 * - every meaningful word of its body is in the quote (bar a few framing words);
 * - a standing order ("always", "never") only as the user said it, the same sentence word for word,
 *   so words picked out of a sentence cannot be turned into a rule the user did not give.
 * Anything else waits for the user's yes.
 */
export function faithfulTo(body: string, quote: string): boolean {
  if (RISKY.test(body)) return false
  const said = new Set(words(quote))
  if (!words(body).every((w) => said.has(w) || FRAMING.has(w))) return false
  if (STANDING.test(body)) return flatText(quote).includes(flatText(body))
  return true
}

/** A folder path in the form notes are scoped by: forward slashes, lower case, no trailing slash. */
export function scopeKey(folder: string | null | undefined): string | null {
  if (!folder) return null
  return folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() || null
}

// ───────────── what is never kept ─────────────

/**
 * What a note must never be, from Hermes Agent's review rules (read 2026-11-20) and what they were
 * patched against: an environment failure, a negative claim about a tool ("these harden into
 * refusals... for months"), a one-off story, something that resolved itself, a secret. Returns the
 * reason, or null when the note may be kept.
 */
export function neverKeep(text: string): string | null {
  const t = text.toLowerCase()
  if (/\b(api[_ -]?key|password|passwd|secret|token)\b\s*[:=]|sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{20,}|-----begin [a-z ]*private key/i.test(text)) return 'a secret'
  if (/\b(enoent|eperm|eacces|econnreset|econnrefused|etimedout|timed out|rate limit|429|503|502|out of memory|disk (is )?full|permission denied|not installed|command not found|no such file|network error|offline)\b/.test(t)) return 'an environment failure'
  if (/\b(doesn'?t|does not|can'?t|cannot|won'?t|never) (work|run|load|connect|be used)\b|\b(is|was) (broken|unreliable|useless)\b|\bdon'?t use\b.*\b(tool|search|browser|command)\b/.test(t)) return 'a negative claim about a tool'
  if (/\b(today|this morning|just now|right now|yesterday|for now|temporarily|this time)\b/.test(t)) return 'something that only held for a moment'
  if (/\b(fixed itself|went away|resolved itself|works now|working again)\b/.test(t)) return 'something that resolved itself'
  return null
}

// ───────────── receipts in plain words ─────────────

const DAY = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const dayLabel = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export interface ReceiptNote {
  trust?: NoteTrust
  status?: NoteStatus
  source?: NoteSource
  updatedAt: number
  createdAt: number
}

/** One sentence saying where a note came from: "You said this on 20 Nov in Pricing page." */
export function receiptLine(n: ReceiptNote, nameOf: (id: string) => string = (id) => id): string {
  const s = n.source
  const when = dayLabel(s?.at || n.createdAt)
  const where = s?.chatTitle ? ` in ${s.chatTitle}` : ''
  switch (n.trust) {
    case 'user':
      return s?.by === 'you' && !s.quote ? `You added this on ${when}.` : s?.quote ? `You said this on ${when}${where}.` : `You confirmed this on ${when}.`
    case 'proven':
      return `${s?.proof || 'Proven by a check'} on ${when}${where}.`
    case 'inferred':
      return `${s?.by === 'review' ? 'Picked up from' : `${nameOf(s?.by || '')} took this from`} ${s?.chatTitle || 'a chat'} on ${when}. Not confirmed by you.`
    case 'outside':
      return `Read from outside content on ${when}${where}. Never used as an instruction.`
    default:
      return `Saved before Ensemble kept receipts${s?.by && s.by !== 'you' ? `, by ${nameOf(s.by)}` : ''}.`
  }
}

// ───────────── choosing what goes into a prompt ─────────────

export interface CoreNote {
  id: string
  title: string
  body: string
  kind?: NoteKind
  trust?: NoteTrust
  status?: NoteStatus
  scope?: string | null
  updatedAt: number
}

/** Whether a note may sit in the part of a prompt that reads as instructions. */
export function instructs(n: CoreNote): boolean {
  if ((n.status || 'active') !== 'active') return false
  const trust = n.trust || 'legacy'
  return trust === 'user' || trust === 'proven' || trust === 'legacy'
}

/** How well a note fits a set of words: shared words, weighted by how rare they are among the notes. */
function fit(noteWords: Set<string>, query: string[], df: Map<string, number>, total: number): number {
  let s = 0
  for (const q of new Set(query)) if (noteWords.has(q)) s += Math.log(1 + total / (1 + (df.get(q) || 0)))
  return s
}

export interface Core {
  /** The notes chosen, in the order they appear. */
  picked: CoreNote[]
  words: number
  budget: number
  /** Notes that could have gone in (relevant, or a standing preference) but found no room. */
  leftOut: number
  /** Notes held back because they are not confirmed yet. */
  waiting: number
}

/**
 * The memory a prompt starts with: first the person's own standing preferences (said by them, or
 * proven), then the notes of this chat's project, then other notes that fit what the chat is about,
 * each group ordered by how well it fits the chat. Nothing that waits for a yes, nothing read from
 * outside, nothing scoped to another project. Stops at the budget and says how much did not fit.
 */
export function chooseCore(notes: CoreNote[], ctx: { scope?: string | null; about?: string; budget?: number; preferenceBudget?: number }): Core {
  const budget = ctx.budget ?? CORE_WORDS
  const prefBudget = Math.min(budget, ctx.preferenceBudget ?? PREFERENCE_WORDS)
  const scope = scopeKey(ctx.scope)
  const usable = notes.filter((n) => instructs(n) && (!n.scope || n.scope === scope))
  const waiting = notes.filter((n) => n.status === 'waiting' && (!n.scope || n.scope === scope)).length
  const query = words(ctx.about || '')
  const sets = new Map(usable.map((n) => [n.id, new Set(words(`${n.title} ${n.body}`))]))
  const df = new Map<string, number>()
  for (const set of sets.values()) for (const w of set) df.set(w, (df.get(w) || 0) + 1)
  const score = (n: CoreNote): number => fit(sets.get(n.id) || new Set(), query, df, usable.length)
  const byFit = (a: CoreNote, b: CoreNote): number => score(b) - score(a) || b.updatedAt - a.updatedAt

  const prefs = usable.filter((n) => n.kind === 'preference' || (!n.kind && (n.trust === 'user' || n.trust === 'legacy') && !n.scope)).sort(byFit)
  const own = usable.filter((n) => !prefs.includes(n) && n.scope && n.scope === scope).sort(byFit)
  const others = usable.filter((n) => !prefs.includes(n) && !own.includes(n) && score(n) > 0).sort(byFit)

  const picked: CoreNote[] = []
  let used = 0
  let leftOut = 0
  const take = (list: CoreNote[], cap: number): void => {
    for (const n of list) {
      const w = wordCount(`${n.title}: ${n.body}`) + 1
      if (used + w > cap) {
        leftOut++
        continue
      }
      picked.push(n)
      used += w
    }
  }
  take(prefs, prefBudget)
  take(own, budget)
  take(others, budget)
  return { picked, words: used, budget, leftOut, waiting }
}

/** The core as the lines a prompt carries. */
export function coreText(core: Core): string {
  const lines = core.picked.map((n) => `- ${n.title}: ${n.body.replace(/\s+/g, ' ')}`)
  if (core.leftOut) lines.push(`- (${core.leftOut} more ${core.leftOut === 1 ? 'note' : 'notes'} did not fit; memory_search finds them)`)
  return lines.join('\n')
}

// ───────────── searching notes ─────────────

export interface NoteHit<N> {
  note: N
  score: number
}

/**
 * Notes ranked for a query: how well they fit (rare shared words count most, the title double),
 * this project's notes ahead of other projects', confirmed ahead of unconfirmed, and newer ahead of
 * older (a note loses half its age weight over 180 days). Forgotten and replaced notes never come back.
 */
export function rankNotes<N extends CoreNote>(notes: N[], query: string, ctx: { scope?: string | null; now?: number; everywhere?: boolean } = {}): NoteHit<N>[] {
  const now = ctx.now ?? Date.now()
  const scope = scopeKey(ctx.scope)
  const live = notes.filter((n) => n.status !== 'forgotten' && n.status !== 'replaced' && (ctx.everywhere || !n.scope || n.scope === scope))
  const q = words(query)
  const df = new Map<string, number>()
  const sets = new Map(live.map((n) => [n.id, { title: new Set(words(n.title)), all: new Set(words(`${n.title} ${n.body}`)) }]))
  for (const s of sets.values()) for (const w of s.all) df.set(w, (df.get(w) || 0) + 1)
  const out: NoteHit<N>[] = []
  for (const n of live) {
    const s = sets.get(n.id)!
    let score = q.length ? fit(s.all, q, df, live.length) + 0.5 * fit(s.title, q, df, live.length) : 1
    if (score <= 0) continue
    if (scope && n.scope === scope) score *= 1.4
    if (n.status === 'waiting' || n.trust === 'inferred' || n.trust === 'outside') score *= 0.7
    score *= 0.6 + 0.4 * Math.pow(0.5, (now - n.updatedAt) / (180 * DAY))
    out.push({ note: n, score })
  }
  return out.sort((a, b) => b.score - a.score)
}

// ───────────── the review's proposals ─────────────

export interface Proposal {
  action: 'add' | 'update' | 'retire'
  /** For update and retire: the note it is about. */
  id?: string
  kind: NoteKind
  title: string
  body: string
  /** 'project' keeps it to this chat's folder; 'everywhere' is for the person's general preferences. */
  scope: 'project' | 'everywhere'
  /** The exact words it rests on, and the row they are in (the label the review was shown, such as r12). */
  quote: string
  row: string
}

/** Reads the review's answer: a JSON object with a "proposals" list. Anything malformed is dropped, never repaired by guessing. */
export function readProposals(raw: string): Proposal[] {
  const m = /\{[\s\S]*\}/.exec(raw || '')
  if (!m) return []
  let data: unknown
  try {
    data = JSON.parse(m[0])
  } catch {
    return []
  }
  const list = (data as { proposals?: unknown }).proposals
  if (!Array.isArray(list)) return []
  const out: Proposal[] = []
  for (const p of list.slice(0, 12)) {
    if (!p || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    const action = o.action === 'update' || o.action === 'retire' ? o.action : o.action === 'add' ? 'add' : null
    const kind = NOTE_KINDS.includes(o.kind as NoteKind) ? (o.kind as NoteKind) : 'fact'
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : ''
    const body = typeof o.body === 'string' ? o.body.trim().slice(0, 600) : ''
    const quote = typeof o.quote === 'string' ? o.quote.trim().slice(0, 400) : ''
    const row = typeof o.row === 'string' ? o.row.trim() : ''
    if (!action || !quote || !row || (action !== 'retire' && (!title || !body))) continue
    if ((action === 'update' || action === 'retire') && typeof o.id !== 'string') continue
    out.push({ action, id: typeof o.id === 'string' ? o.id : undefined, kind, title, body, scope: o.scope === 'everywhere' ? 'everywhere' : 'project', quote, row })
  }
  return out
}
