import path from 'node:path'
import type { Goal, ModelRecord, Task } from '@shared/types'
import { runOf } from '@shared/trace'
import { TIER_ORDER, type Tier } from '@shared/budget'
import { readJson, writeJson } from './util'

// What the team has learned about its models, and how it picks the model for a task it hands out.
//
// An outcome counts only on real evidence: an independent review, a goal check by someone who did
// none of the work, a test or build run seen in the execution trace, or (weakly) the assigner's own
// rating. A task that merely ended says nothing about how good the work was, so a cheaper model
// cannot earn more work just by finishing. Failing at the work (not the network, a limit or a crash)
// is seen for every task and counts on its own.
//
// Every outcome is put, by a stable hash of its task, either in the set the decision is fitted on
// (about 80%) or in a held-out set (about 20%). A move to a stronger or cheaper model is proposed
// from the fitted set and made only when the held-out set, which the proposal never saw, bears it out.

/** Model families by the words in their names, with the tier each one belongs to. */
const FAMILIES: { name: string; match: RegExp; tier: Tier }[] = [
  { name: 'Fable', match: /fable/i, tier: 'top' },
  { name: 'Mythos', match: /mythos/i, tier: 'top' },
  { name: 'Astra', match: /astra/i, tier: 'top' },
  { name: 'Opus', match: /opus/i, tier: 'strong' },
  { name: 'Sol', match: /(^|[^a-z])sol([^a-z]|$)/i, tier: 'strong' },
  { name: 'Sonnet', match: /sonnet/i, tier: 'mid' },
  { name: 'Haiku', match: /haiku/i, tier: 'light' },
  { name: 'Luna', match: /luna/i, tier: 'light' },
]

export const familyOf = (model: string | undefined | null): { name: string; tier: Tier } | null => (model ? FAMILIES.find((f) => f.match.test(model)) || null : null)

export type Verdict = 'enough' | 'too_weak' | 'more_than_needed'

/** Kinds of work, told apart by the words a task is described with. The first that matches wins. */
const KINDS: { kind: string; label: string; match: RegExp }[] = [
  // A plain chore says so with its first word, whatever it is done to: "Rename the image files" is routine, not media.
  { kind: 'routine', label: 'routine jobs', match: /^\s*(rename|move|extract|list|format|convert|collect|sort|count|download|copy|clean up|tidy)\b/i },
  { kind: 'review', label: 'reviews and checks', match: /\b(review|audit|verify|check(ing)?|critique|second opinion|qa)\b/i },
  { kind: 'media', label: 'images, sound and video', match: /\b(image|illustration|picture|photo|logo|icon|svg|draw|voice|audio|sound|music|video|clip|render)\b/i },
  { kind: 'research', label: 'research', match: /\b(research|find out|look up|investigate|compare|survey|sources?|market|competitor)\b/i },
  { kind: 'code', label: 'code', match: /\b(build|implement|fix|bug|refactor|code|endpoint|api|component|page|function|test(s)?|migrat\w*|deploy|script)\b/i },
  { kind: 'writing', label: 'writing', match: /\b(write|draft|summar\w*|translate|copy|chapter|article|post|email|docs?|readme|report)\b/i },
]

/** What kind of work a task is: its title says it best, and the start of its brief settles the rest. */
export function kindOf(title: string, brief = ''): string {
  const pick = (t: string): string | undefined => KINDS.find((k) => k.match.test(t))?.kind
  // A brief's first word is not a chore's first word, so the brief is only read for its subject.
  return pick(title) || pick(` ${brief.slice(0, 400)}`) || 'other'
}

export const kindLabel = (kind: string | undefined): string => KINDS.find((k) => k.kind === kind)?.label || 'other work'

// ----- the numbers routing goes by (one place, so they can be read and checked) -----

/** Weighted results the fitted set needs before it can move a decision. */
export const FLOOR = 8
/** A step up when the share that falls short is likely above UP; a step down when likely below DOWN. The gap stops flip-flopping. */
export const UP = 0.3
export const DOWN = 0.2
/** How likely, on the fitted set, before a move is proposed. */
export const SURE = 0.9
/**
 * The held-out set: its share of tasks, and the weighted results it needs before it can bear out a
 * move. A wrong step down costs quality and a wrong step up only allowance, so down needs more.
 */
export const HOLDOUT = { share: 0.2, up: 2, down: 4 } as const
/** What each kind of evidence about a finished task's quality weighs. The strongest an attempt has decides it. */
export const WEIGHTS = { review: 1, goal: 0.5, run: 0.5, vote: 0.25 } as const
/** Evidence loses half its weight in this time. */
const HALF_LIFE = 45 * 86_400_000
const MAX_RECENT = 1024
/**
 * Grouping by similar words: a past task whose share of words in common (Jaccard) is SIM_MIN or less
 * is not alike; from there its weight rises to full at SIM_FULL. Two tasks with the same title and
 * nothing else in common sit near 0.35, so they count for little.
 */
const SIM_MIN = 0.3
const SIM_FULL = 0.8
/** The held-out results needed before similar-word grouping may replace the kind, and by how much it must predict better. */
const GROUPING_MIN = 20
const GROUPING_MARGIN = 0.01

/** A stable hash (FNV-1a, then mixed): the same answer on every machine and after every restart. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Whether a task's outcomes are held out from the data decisions are fitted on. Decided by its id alone. */
export const heldOut = (key: string): boolean => hash(key) % 1000 < HOLDOUT.share * 1000

export type Difficulty = 'easy' | 'standard' | 'hard'
type Features = { kind: string; difficulty: Difficulty; words: string[] }
type RoutingTask = { title: string; brief?: string; effort?: string; kind?: string; chatId: string; id: string }
type Model = string | undefined | null
type Decision = { tier: Tier; why: string; trial: boolean }

/** Words that say little about the work itself. */
const STOP = new Set(
  'this that with from into have will what when where which their there then than them they your about after before also each other some such only just more most make made over under very been being were does done should would could must need needs using used like here these those every work task please sure keep want them first next last back still able'.split(' '),
)
const stem = (w: string): string => (w.length > 5 ? w.replace(/(?:ing|ed|es|s)$/, '') : w)

/** The words and file types a task is described with, sorted: what "tasks like this one" are matched by. */
export function wordsOf(title: string, brief = ''): string[] {
  const text = `${title}\n${brief.slice(0, 600)}`.toLowerCase()
  const out = new Set<string>()
  for (const m of text.matchAll(/\.([cm]?[jt]sx?|json|py|rs|go|sql|ya?ml|md|css|html|toml|png|svg|jpe?g|mp4|wav|mp3)\b/g)) out.add(`.${m[1]}`)
  for (const w of text.match(/[a-z][a-z0-9]{3,}/g) || []) {
    if (out.size >= 40) break
    if (!STOP.has(w)) out.add(stem(w))
  }
  return [...out].sort()
}

export function taskFeatures(task: Pick<RoutingTask, 'title' | 'brief' | 'effort' | 'kind'>): Features {
  const brief = task.brief || ''
  const text = task.title + '\n' + brief
  const kind = task.kind || kindOf(task.title, brief)
  const files = new Set(text.match(/\b[\w./\\-]+\.(?:[cm]?[jt]sx?|json|py|rs|go|sql|ya?ml|md|css|html|toml)\b/gi))
  const hazards = new Set(text.toLowerCase().match(/\b(?:architecture|concurrency|concurrent|security|migration|migrate|deadlock|race condition|compatibility|distributed|cryptography)\b/g))
  const requirements = text.match(/(?:^\s*(?:[-*]|\d+[.)])\s+|\b(?:must|preserve|without|constraint|ensure)\b)/gim) || []
  const score = Math.min(2, hazards.size) * 2 + Number(files.size >= 2) + Number(files.size >= 4)
    + Number(requirements.length >= 3) + Number(brief.length >= 500) + Number(brief.length >= 1600)
    + Number(kind === 'review') + Number(/\bindependent(?:ly)?\b|\bsomeone else.s\b|\banother (?:agent|author|team)/i.test(text))
    + (['max', 'xhigh'].includes(task.effort || '') ? 3 : task.effort === 'high' ? 2 : 0)
  return { kind, difficulty: score >= 4 ? 'hard' : score >= 1 ? 'standard' : 'easy', words: wordsOf(task.title, brief) }
}

/** What is known of one model's attempt at one task. */
type Attempt = { ok?: boolean; vote?: Verdict; review?: Verdict; run?: 'pass' | 'fail'; goal?: boolean }
type Observation = Features & { key: string; at: number; attempts: Record<string, Attempt>; trial?: boolean }
type History = { version: 3; models: Record<string, ModelRecord>; recent: Observation[]; easySinceTrial: number }
const empty = (): History => ({ version: 3, models: {}, recent: [], easySinceTrial: 0 })
const validKind = (k: unknown): k is string => k === 'other' || KINDS.some(({ kind }) => kind === k)
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0)
const counts = (x: Record<string, unknown>) => ({ enough: count(x.enough), weak: count(x.weak), more: count(x.more) })
const names = (tier: Tier): string => ({ top: 'top', strong: 'strong', mid: 'mid-sized', light: 'lightweight' })[tier]
const taskKey = (t: Pick<RoutingTask, 'chatId' | 'id'>): string => t.chatId + '/' + t.id
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const verdictOf = (v: unknown): Verdict | undefined => (v === 'enough' || v === 'more_than_needed' || v === 'too_weak' ? v : undefined)

// Old totals (version 1) have no task identities or difficulty: kept for reporting only.
// Version 2 rows carry over; they have no words, so similar-word grouping matches them by kind alone.
function loadHistory(raw: unknown): History {
  const h = empty()
  if (!object(raw)) return h
  const rows = raw.version === 2 || raw.version === 3
  const models = rows ? raw.models : raw
  for (const { name, tier } of FAMILIES) {
    const r = object(models) ? models[name] : null
    if (!object(r)) continue
    const kinds: NonNullable<ModelRecord['kinds']> = {}
    if (object(r.kinds)) for (const [k, v] of Object.entries(r.kinds)) {
      if (validKind(k) && object(v)) kinds[k] = counts(v)
    }
    h.models[name] = { family: name, tier, done: count(r.done), failed: count(r.failed), updatedAt: count(r.updatedAt), ...counts(r), kinds }
  }
  if (!rows) return h
  h.easySinceTrial = Math.min(19, count(raw.easySinceTrial))
  if (Array.isArray(raw.recent)) for (const s of raw.recent.slice(-MAX_RECENT)) {
    if (!object(s) || typeof s.key !== 'string' || !validKind(s.kind) || !object(s.attempts)) continue
    if (s.difficulty !== 'easy' && s.difficulty !== 'standard' && s.difficulty !== 'hard') continue
    const attempts: Observation['attempts'] = {}
    for (const { name } of FAMILIES) {
      const a = s.attempts[name]
      if (!object(a)) continue
      attempts[name] = {
        ok: typeof a.ok === 'boolean' ? a.ok : undefined,
        vote: verdictOf(a.vote),
        review: verdictOf(a.review),
        run: a.run === 'pass' || a.run === 'fail' ? a.run : undefined,
        goal: a.goal === true ? true : undefined,
      }
    }
    const words = Array.isArray(s.words) ? s.words.filter((w): w is string => typeof w === 'string').slice(0, 40).sort() : []
    h.recent.push({ key: s.key, kind: s.kind, difficulty: s.difficulty, words, at: count(s.at), trial: s.trial === true, attempts })
  }
  return h
}

/** What is known of a finished attempt's quality. A task that only ended has none, and a failed one is counted apart. */
function quality(a: Attempt): { w: number; bad: boolean } | null {
  if (a.ok === false) return null
  if (a.review) return { w: WEIGHTS.review, bad: a.review === 'too_weak' }
  if (a.goal) return { w: WEIGHTS.goal, bad: false }
  if (a.run) return { w: WEIGHTS.run, bad: a.run === 'fail' }
  if (a.vote) return { w: WEIGHTS.vote, bad: a.vote === 'too_weak' }
  return null
}

/**
 * The evidence on one tier for one kind of task. Weighted (by time, likeness and the kind of
 * evidence) for the decision; plain counts of the same attempts for the sentence a person reads.
 */
type Tally = {
  /** Attempts that ended, finished or failed at their work, and those that failed. */
  ended: number
  failed: number
  /** Evidence about the quality of finished attempts, and how much of it says they fell short. */
  judged: number
  bad: number
  /** Ratings (reviews and the assigner's), and how much of them said "more than needed". */
  rated: number
  excess: number
  /** Plain counts: attempts with a known result, those that fell short, ratings, and "more than needed". */
  n: number
  short: number
  ratings: number
  over: number
}
const zero = (): Tally => ({ ended: 0, failed: 0, judged: 0, bad: 0, rated: 0, excess: 0, n: 0, short: 0, ratings: 0, over: 0 })
function add(t: Tally, a: Attempt, w: number, counted = true): void {
  if (a.ok !== undefined) {
    t.ended += w
    if (!a.ok) t.failed += w
  }
  const q = quality(a)
  if (q) {
    t.judged += w * q.w
    if (q.bad) t.bad += w * q.w
  }
  if (counted && (a.ok === false || q)) {
    t.n++
    if (a.ok === false || q?.bad) t.short++
  }
  const rating = a.review || a.vote
  if (rating && a.ok !== false) {
    const v = a.review ? WEIGHTS.review : WEIGHTS.vote
    t.rated += w * v
    if (counted) t.ratings++
    if (rating === 'more_than_needed') {
      t.excess += w * v
      if (counted) t.over++
    }
  }
}

// A uniform prior on each unknown rate, its binomial likelihood integrated on a midpoint grid so
// fractional (weighted, time-discounted) observations keep their weight.
const GRID = Array.from({ length: 100 }, (_, i) => (i + 0.5) / 100)
function mass(yes: number, no: number): number[] {
  const logs = GRID.map((p) => yes * Math.log(p) + no * Math.log1p(-p))
  const peak = Math.max(...logs)
  const m = logs.map((l) => Math.exp(l - peak))
  const sum = m.reduce((a, b) => a + b, 0)
  return m.map((x) => x / sum)
}
const above = (m: number[], limit: number): number => m.reduce((s, x, i) => s + (GRID[i] > limit ? x : 0), 0)
/**
 * How likely the share of tasks that fall short is above (or below) a line. Falling short is failing
 * at the work (rate f, seen for every attempt) or finishing work that is not good enough (rate q,
 * seen only where it was checked): 1 - (1 - f)(1 - q). Estimating the two apart keeps the attempts
 * nobody checked out of the quality estimate without making failures look more common than they are.
 */
function shortChance(t: Tally, limit: number, side: 'above' | 'below'): number {
  const f = mass(t.failed, t.ended - t.failed)
  const q = mass(t.bad, t.judged - t.bad)
  // For each f, the short share passes the line exactly when q passes 1 - (1 - limit) / (1 - f):
  // a running total over the sorted q grid answers that at once.
  const upTo = [0]
  for (const x of q) upTo.push(upTo[upTo.length - 1] + x)
  const n = GRID.length
  let p = 0
  for (let i = 0; i < n; i++) {
    if (f[i] < 1e-12) continue
    const line = (1 - (1 - limit) / (1 - GRID[i])) * n - 0.5
    if (side === 'above') {
      // q above the line: grid points j > line.
      const from = Math.min(n, Math.max(0, Math.floor(line) + 1))
      p += f[i] * (upTo[n] - upTo[from])
    } else {
      // q below the line: grid points j < line.
      const to = Math.min(n, Math.max(0, Math.ceil(line)))
      p += f[i] * upTo[to]
    }
  }
  return p
}

type Fit = 'poor' | 'good' | 'unknown'
/** What the fitted set says of a tier, with the confidence it asks for. */
function judge(t: Tally): Fit {
  // Failing at the work is seen for every attempt, so it can show by itself that a model is too weak.
  if (t.ended >= FLOOR && above(mass(t.failed, t.ended - t.failed), UP) >= SURE) return 'poor'
  // How good finished work was is known only where someone or something checked it.
  if (t.judged < FLOOR) return 'unknown'
  if (shortChance(t, UP, 'above') >= SURE) return 'poor'
  if (t.ended >= FLOOR && shortChance(t, DOWN, 'below') >= SURE) return 'good'
  return 'unknown'
}
/** Ratings say a tier is more than this work needs: confidently at least half the time. */
const overqualified = (t: Tally): boolean => t.rated >= FLOOR && above(mass(t.excess, t.rated - t.excess), 0.5) >= SURE

/**
 * Whether the held-out set bears out a move the fitted set proposes: enough results of its own, and
 * their observed share on the proposed side of the same line. It is a second, independent sample, so
 * the chance of a wrong move is the fitted set's chance times the held-out set's.
 */
function bearsOut(h: Tally, move: 'up' | 'down' | 'over'): boolean {
  const f = h.ended > 0 ? h.failed / h.ended : 0
  const q = h.judged > 0 ? h.bad / h.judged : 0
  const s = 1 - (1 - f) * (1 - q)
  if (move === 'up') return h.failed + h.judged >= HOLDOUT.up && s > UP
  if (move === 'down') return h.judged >= HOLDOUT.down && h.ended >= HOLDOUT.down && s < DOWN
  return h.rated >= HOLDOUT.down && h.excess / h.rated >= 0.5
}

/** Sorted-list overlap (Jaccard) of two sets of words. */
function overlap(a: string[], b: string[]): number {
  let i = 0
  let j = 0
  let both = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      both++
      i++
      j++
    } else if (a[i] < b[j]) i++
    else j++
  }
  const all = a.length + b.length - both
  return all ? both / all : 0
}

export type Grouping = 'kind' | 'similar'
/** How well each way of grouping past tasks predicted the held-out outcomes (Brier score: lower is better). */
export interface GroupingScore {
  mode: Grouping
  kind: number | null
  similar: number | null
  /** Weighted held-out results the scores rest on. */
  scored: number
}

export class Learning {
  private file: string
  private data: History
  /** Recorded results since start, so the grouping is scored again once enough new ones came in. */
  private changes = 0
  private scored: (GroupingScore & { at: number }) | null = null
  private tokenCache = new WeakMap<Observation, string[]>()
  private splitCache = new WeakMap<Observation, boolean>()

  constructor(dataDir: string, private now: () => number = Date.now) {
    this.file = path.join(dataDir, 'learning.json')
    const raw = readJson<unknown>(this.file, null)
    this.data = loadHistory(raw)
    if (object(raw) && raw.version !== 3 && (Object.keys(this.data.models).length || this.data.recent.length)) {
      this.save()
      this.flush()
    }
  }

  private dirty = false
  /** Results recorded in one go (an outcome, a rating, a run) are written once, as soon as that step ends. */
  private save(): void {
    if (this.dirty) return
    this.dirty = true
    queueMicrotask(() => this.flush())
  }
  /** Writes what is waiting to be written now. */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    writeJson(this.file, this.data)
  }
  private rec(model: Model): ModelRecord | null {
    const f = familyOf(model)
    if (!f) return null
    return (this.data.models[f.name] ||= { family: f.name, tier: f.tier, done: 0, failed: 0, enough: 0, weak: 0, more: 0, updatedAt: 0 })
  }
  private find(task: Pick<RoutingTask, 'chatId' | 'id'>): Observation | undefined {
    const key = taskKey(task)
    return this.data.recent.find((s) => s.key === key)
  }
  private row(task: RoutingTask): Observation {
    let row = this.find(task)
    if (!row) {
      row = { ...taskFeatures(task), key: taskKey(task), at: this.now(), attempts: {} }
      this.data.recent.push(row)
      if (this.data.recent.length > MAX_RECENT) this.data.recent.shift()
    }
    return row
  }

  /** A task ended: finished (ok), or failed at its work. On its own a finished task is no evidence of good work. */
  outcome(model: Model, ok: boolean, task?: RoutingTask): void {
    const r = this.rec(model)
    if (!r) return
    if (task) {
      const a = (this.row(task).attempts[r.family] ||= {})
      if (a.ok !== undefined) return
      a.ok = ok
      this.changes++
    }
    if (ok) r.done++
    else r.failed++
    r.updatedAt = this.now()
    this.save()
  }

  workFailure(error?: string): boolean {
    return !/\b(?:ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENOSPC|ENOMEM|service unavailable|internal server error|bad gateway|gateway timeout|network error|network connection|connection (?:timed out|refused|closed)|fetch failed|rate limit(?:ed)?)\b|\bHTTP\s+5\d\d\b/i.test(error || '')
  }

  reviewed(model: Model, task: RoutingTask): boolean {
    const family = familyOf(model)
    return !!(family && this.find(task)?.attempts[family.name]?.review)
  }

  /** A rating: by whoever handed the task out, or (independent) by someone who did not. */
  vote(model: Model, verdict: Verdict, kind?: string, task?: RoutingTask, independent = false): string | null {
    const r = this.rec(model)
    if (!r) return null
    if (task) {
      const s = this.row(task)
      const a = (s.attempts[r.family] ||= {})
      const source = independent ? 'review' : 'vote'
      if (a[source]) return r.family
      a[source] = verdict
      kind = s.kind
      this.changes++
    }
    const field = verdict === 'enough' ? 'enough' : verdict === 'too_weak' ? 'weak' : 'more'
    r[field]++
    if (validKind(kind)) ((r.kinds ||= {})[kind] ||= { enough: 0, weak: 0, more: 0 })[field]++
    r.updatedAt = this.now()
    this.save()
    return r.family
  }

  private mark<K extends 'run' | 'goal'>(model: Model, task: RoutingTask, field: K, value: NonNullable<Attempt[K]>): boolean {
    const r = this.rec(model)
    if (!r) return false
    const a = (this.row(task).attempts[r.family] ||= {})
    if (a[field] !== undefined) return false
    a[field] = value
    r.updatedAt = this.now()
    this.changes++
    this.save()
    return true
  }

  /**
   * Tests, builds, type checks and lint the task's own work ran, as the execution trace recorded
   * them (hub.evidence for the task). The last run of each kind counts: all passing is evidence of
   * good work, any failing of work that fell short. With none, nothing is recorded.
   */
  proveFrom(model: Model, task: RoutingTask, evidence: { ran: { command: string; ok: boolean; ts: number }[] }): 'pass' | 'fail' | null {
    const last = new Map<string, boolean>()
    for (const r of [...evidence.ran].sort((a, b) => a.ts - b.ts)) {
      const what = runOf(r.command)
      if (what) last.set(what, r.ok)
    }
    if (!last.size) return null
    const result = [...last.values()].every(Boolean) ? 'pass' : 'fail'
    this.mark(model, task, 'run', result)
    return result
  }

  /**
   * A goal found met by a checker who did none of the work: the tasks finished in the round it
   * judged share the credit. A goal the lead marks met by itself is not independent and counts for nothing.
   */
  goalMet(goal: Pick<Goal, 'check' | 'createdAt' | 'log'>, tasks: Pick<Task, 'chatId' | 'id' | 'title' | 'brief' | 'kind' | 'status' | 'ranOn' | 'finishedAt'>[]): number {
    if (goal.check !== 'fresh') return 0
    const from = Math.max(goal.createdAt || 0, ...goal.log.filter((l) => !l.met).map((l) => l.ts))
    let n = 0
    for (const t of tasks) if (t.status === 'done' && t.ranOn && (t.finishedAt || 0) >= from && this.mark(t.ranOn, t, 'goal', true)) n++
    return n
  }

  list(): ModelRecord[] {
    return Object.values(this.data.models).sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
  }
  reset(): void {
    this.data = empty()
    this.changes++
    this.scored = null
    this.save()
  }

  /** Whether a row is held out, worked out once per row. */
  private held(s: Observation): boolean {
    let h = this.splitCache.get(s)
    if (h === undefined) this.splitCache.set(s, (h = heldOut(s.key)))
    return h
  }

  private tokens(s: Observation): string[] {
    let t = this.tokenCache.get(s)
    if (!t) {
      t = [...s.words, `kind:${s.kind}`].sort()
      this.tokenCache.set(s, t)
    }
    return t
  }

  /** How much a past task counts as being like this one: by kind, or by the words both are described with. */
  private likeness(mode: Grouping, row: Observation, s: Observation): number {
    if (s.difficulty !== row.difficulty) return 0
    if (mode === 'kind') return s.kind === row.kind ? 1 : 0
    const j = overlap(this.tokens(row), this.tokens(s))
    return Math.max(0, Math.min(1, (j - SIM_MIN) / (SIM_FULL - SIM_MIN)))
  }

  /** The evidence per tier on tasks like `row`, from the given rows. */
  private tally(mode: Grouping, row: Observation, tiers: Tier[], from: Observation[]): Tally[] {
    const out = tiers.map(zero)
    const now = this.now()
    for (const s of from) {
      const like = this.likeness(mode, row, s)
      if (!like) continue
      const w = like * 2 ** (-Math.max(0, now - s.at) / HALF_LIFE)
      for (const [family, a] of Object.entries(s.attempts)) {
        const i = tiers.indexOf(familyOf(family)?.tier as Tier)
        // The plain counts in the sentence take only tasks at least half alike.
        if (i >= 0) add(out[i], a, w, like >= 0.5)
      }
    }
    return out
  }

  /**
   * Which way of grouping past tasks routing uses. The kind (from words in the title) is the simple
   * default; grouping by similar words and file types replaces it only when, on the held-out set, it
   * predicted who fell short better, with enough held-out results to tell. Scored again as results come in.
   */
  grouping(): GroupingScore {
    if (this.scored && this.changes - this.scored.at < 25) return this.scored
    const fit = this.data.recent.filter((s) => !this.held(s))
    const held = this.data.recent.filter((s) => this.held(s) && Object.keys(s.attempts).length)
    const score = { kind: { se: 0, w: 0 }, similar: { se: 0, w: 0 } }
    for (const h of held) {
      const tiers = [...new Set(Object.keys(h.attempts).map((f) => familyOf(f)?.tier).filter((t): t is Tier => !!t))]
      for (const mode of ['kind', 'similar'] as const) {
        const t = this.tally(mode, h, tiers, fit)
        for (const [family, a] of Object.entries(h.attempts)) {
          const e = t[tiers.indexOf(familyOf(family)?.tier as Tier)]
          if (!e) continue
          // Each part predicted on its own: failing at the work, and the quality of finished work.
          if (a.ok !== undefined) {
            const f = (e.failed + 1) / (e.ended + 2)
            score[mode].se += (Number(!a.ok) - f) ** 2
            score[mode].w += 1
          }
          const q = quality(a)
          if (q) {
            const p = (e.bad + 1) / (e.judged + 2)
            score[mode].se += q.w * (Number(q.bad) - p) ** 2
            score[mode].w += q.w
          }
        }
      }
    }
    const kind = score.kind.w ? score.kind.se / score.kind.w : null
    const similar = score.similar.w ? score.similar.se / score.similar.w : null
    const mode: Grouping = kind !== null && similar !== null && score.kind.w >= GROUPING_MIN && similar < kind - GROUPING_MARGIN ? 'similar' : 'kind'
    this.scored = { mode, kind, similar, scored: Math.round(score.kind.w * 100) / 100, at: this.changes }
    return this.scored
  }

  /** Called only for a real automatic assignment. Previewing a roster consumes no trials. */
  decide(base: Tier, task: RoutingTask, available = TIER_ORDER): Decision {
    const prior = this.find(task)
    const row = prior || this.row(task)
    const tiers = TIER_ORDER.filter((t) => available.includes(t))
    const baseline = tiers.indexOf(base)
    const mode = this.grouping().mode
    const level = row.difficulty === 'standard' ? 'ordinary' : row.difficulty
    const about = mode === 'similar' ? `Tasks like this one at ${level} difficulty` : `${sentence(kindLabel(row.kind))} at ${level} difficulty`
    const fit = this.tally(mode, row, tiers, this.data.recent.filter((s) => !this.held(s)))
    const held = this.tally(mode, row, tiers, this.data.recent.filter((s) => this.held(s)))
    const verdicts = fit.map(judge)
    // The sentence gives plain counts of the attempts behind the decision; the decision itself weighs
    // them (independent checks over the assigner's rating, recent over old, closer likeness over less).
    const times = (n: number): string => (n === 1 ? '1 time' : `${n} times`)
    const shortOf = (e: Tally): string => `${times(e.short)} out of ${e.n}`
    const heldOf = (e: Tally): string => `${e.short} out of ${e.n} in the held-out check`
    let index = baseline
    let trial = false
    let why = 'The usual model for this part of the team; there is not yet enough evidence at this difficulty to change it'
    if (baseline >= 0) {
      let blocked = -1
      while (index > 0 && verdicts[index] === 'poor') {
        if (!bearsOut(held[index], 'up')) {
          blocked = index
          break
        }
        index--
      }
      if (index < baseline) why = `${about} fell short ${shortOf(fit[baseline])} on ${names(base)} models, and ${heldOf(held[baseline])}, so this one runs on a stronger model`
      else if (blocked >= 0) why = `${about} fell short ${shortOf(fit[baseline])} on ${names(base)} models, but the held-out check does not bear that out yet (${held[baseline].short} out of ${held[baseline].n}), so the usual model stays`
      else {
        for (let i = tiers.length - 1; i > baseline; i--) {
          if (verdicts[i] === 'good' && bearsOut(held[i], 'down')) {
            index = i
            break
          }
        }
        if (index > baseline) why = `${about} fell short only ${shortOf(fit[index])} on ${names(tiers[index])} models, and ${heldOf(held[index])}, so this one runs on that cheaper model`
        const cheaper = index + 1
        // Still open: nothing is known of the cheaper tier, or the fitted set thinks it good and the
        // held-out set has not borne that out yet. Trials go on until it is settled, so the held-out
        // set can fill; stopping them there would leave it short for good.
        const open = cheaper < tiers.length && (verdicts[cheaper] === 'unknown' || (verdicts[cheaper] === 'good' && !bearsOut(held[cheaper], 'down')))
        if (open && verdicts[index] !== 'poor') {
          const e = fit[index]
          if (overqualified(e) && bearsOut(held[index], 'over')) {
            index = cheaper
            why = `Ratings found ${names(tiers[index - 1])} models more than needed ${times(e.over)} out of ${e.ratings} for ${about.toLowerCase()}, and ${held[index - 1].over} out of ${held[index - 1].ratings} in the held-out check, so this one runs a step down`
          } else if (row.difficulty === 'easy') {
            // Exploration: picked by a counter, never by the held-out hash, so trial outcomes fall
            // into the fitted and held-out sets in the same proportions as every other task's.
            if (!prior) this.data.easySinceTrial++
            trial = !!prior?.trial || this.data.easySinceTrial >= 20
            if (trial) {
              this.data.easySinceTrial = 0
              row.trial = true
              index = cheaper
              why = 'A trial: one easy task in twenty goes to a cheaper model to see whether it can handle ' + kindLabel(row.kind) + '; a miss counts against it once'
            }
          }
        }
      }
    }
    if (!prior) this.save()
    return { tier: tiers[index] || base, why, trial }
  }

  /** Old callers with only a kind cannot establish difficulty or authorize exploration. */
  shift(tier: Tier, kind?: string): -1 | 0 | 1 {
    if (!kind) return 0
    const row: Observation = { kind, difficulty: 'standard', words: [], key: '', at: this.now(), attempts: {} }
    const [e] = this.tally('kind', row, [tier], this.data.recent.filter((s) => !this.held(s)))
    return judge(e) === 'poor' && TIER_ORDER.indexOf(tier) > 0 ? 1 : 0
  }

  summary(): string {
    return this.list()
      .map((r) => {
        const votes = [r.enough && r.enough + ' enough', r.weak && r.weak + ' too weak', r.more && r.more + ' more than needed'].filter(Boolean).join(', ')
        return '- ' + r.family + ': finished ' + r.done + ' of ' + (r.done + r.failed) + ' attempts' + (votes ? ', rated ' + votes : '')
      })
      .join('\n')
  }
}
