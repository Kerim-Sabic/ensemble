// Watches and Inbox in plain words: what a watch looks at, when it looks next, what its last look
// found and what it cost, and how the inbox groups and counts. Pure functions, no DOM and no store,
// so the window and scripts/checks/inboxui.ts share them. No text here ever counts agents.
import type { InboxItem, UnattendedCaps, Watch, WatchInput, WatchOutcome, WatchRun, WatchTrigger } from '@shared/watches'

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]

const pad = (n: number): string => String(n).padStart(2, '0')
/** 07:00, from a Date or an "HH:MM" string. */
export const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** "every 30 minutes", "every 2 hours", "every day". */
export function everyWords(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? 'every day' : `every ${min / 1440} days`
  if (min % 60 === 0) return min === 60 ? 'every hour' : `every ${min / 60} hours`
  return `every ${min} minutes`
}

/** Which days: "every day", "on weekdays", "at weekends", "on Mon, Wed and Fri". */
export function daysWords(days?: number[]): string {
  const d = [...new Set(days || [])].filter((x) => x >= 0 && x <= 6).sort()
  if (!d.length || d.length === 7) return 'every day'
  if (d.join() === WEEKDAYS.join()) return 'on weekdays'
  if (d.join() === '0,6') return 'at weekends'
  const names = d.map((x) => DAY_SHORT[x])
  return `on ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`
}

/** A short form of a web address for a line: no scheme, no "www.", no trailing slash. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')
}

/** The last part or two of a folder path. */
export function shortPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/') || p
}

/** What a watch looks at, as a sentence: "Failed checks on owner/repo", "Every day at 07:00". */
export function triggerLine(t: WatchTrigger): string {
  switch (t.kind) {
    case 'schedule': {
      if (t.at) {
        const days = daysWords(t.days)
        return days === 'every day' ? `Every day at ${t.at}` : `${days.charAt(0).toUpperCase()}${days.slice(1)} at ${t.at}`
      }
      const w = everyWords(Math.max(5, t.every || 60))
      return w.charAt(0).toUpperCase() + w.slice(1)
    }
    case 'github':
      return `${t.on === 'ci-failed' ? 'Failed checks' : t.on === 'issue' ? 'New issues' : 'New pull requests'} on ${t.repo}`
    case 'url':
      return `Changes to ${shortUrl(t.url)}`
    case 'path':
      return `Changes in ${shortPath(t.path)}`
    case 'command':
      return 'Changes in what a command prints'
  }
}

const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** When a watch looks next: "In 12 min", "Today at 18:00", "Tomorrow at 07:00", "Mon at 07:00", "Paused". */
export function nextLine(w: Pick<Watch, 'status' | 'nextAt'>, now = Date.now()): string {
  if (w.status === 'paused') return 'Paused'
  if (w.nextAt == null) return 'Looking now'
  const ms = w.nextAt - now
  if (ms <= 30_000) return 'Any moment'
  if (ms < 60 * 60_000) return `In ${Math.max(1, Math.round(ms / 60_000))} min`
  const at = new Date(w.nextAt)
  const days = Math.round((dayStart(at) - dayStart(new Date(now))) / 86_400_000)
  if (days === 0) return `Today at ${clock(at)}`
  if (days === 1) return `Tomorrow at ${clock(at)}`
  if (days < 7) return `${DAY_SHORT[at.getDay()]} at ${clock(at)}`
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Each outcome in plain words, and how it reads at a glance. */
export const OUTCOME: Record<WatchOutcome, { words: string; tone: 'quiet' | 'news' | 'bad' | 'muted' }> = {
  quiet: { words: 'Nothing new', tone: 'quiet' },
  found: { words: 'Found something', tone: 'news' },
  handed: { words: 'Handed to the team', tone: 'news' },
  failed: { words: 'Could not look', tone: 'bad' },
  skipped: { words: 'Skipped', tone: 'muted' },
  capped: { words: 'Held back by today\'s limit', tone: 'muted' },
  missed: { words: 'Missed while Ensemble was closed', tone: 'muted' },
}

/** What a run found, in one line: the outcome, and its note when there is one. */
export function outcomeLine(r: Pick<WatchRun, 'outcome' | 'note'> | undefined): string {
  if (!r) return 'Has not looked yet'
  const o = OUTCOME[r.outcome]
  const note = r.note?.trim()
  if (!note) return o.words
  if (r.outcome === 'quiet') return `${o.words}: ${note}`
  if (r.outcome === 'found' || r.outcome === 'handed') return note
  return `${o.words}: ${note}`
}

/** Today's looks of a watch, and how many needed a model (a look without one costs nothing). */
export function costToday(w: Pick<Watch, 'runs'>, now = Date.now()): { looks: number; model: number; failed: number; tokens: number } {
  const from = dayStart(new Date(now))
  const today = w.runs.filter((r) => r.at >= from && r.outcome !== 'skipped' && r.outcome !== 'capped' && r.outcome !== 'missed')
  return { looks: today.length, model: today.filter((r) => !!r.model).length, failed: today.filter((r) => r.outcome === 'failed').length, tokens: today.reduce((t, r) => t + (r.tokens || 0), 0) }
}

/** Looks that needed a model today, over every watch: what counts against the daily limits. */
export function modelLooksToday(watches: Pick<Watch, 'runs'>[], now = Date.now()): number {
  return watches.reduce((n, w) => n + costToday(w, now).model, 0)
}

/** "4 looks today, 1 with a model" / "1 look today, no model needed" / "No looks yet today". */
export function costLine(w: Pick<Watch, 'runs'>, now = Date.now()): string {
  const c = costToday(w, now)
  if (!c.looks) return 'No looks yet today'
  const looks = `${c.looks} ${c.looks === 1 ? 'look' : 'looks'} today`
  // "No model needed" is said of looks that saw nothing new; a look that failed did not get that far.
  if (!c.model) return `${looks}, ${c.failed ? (c.looks === 1 ? 'without a model' : 'none with a model') : 'no model needed'}`
  return `${looks}, ${c.model === c.looks ? (c.looks === 1 ? 'with a model' : 'all with a model') : `${c.model} with a model`}`
}

/** What a finding leads to. */
export const onFindWords = (onFind: Watch['onFind']): string => (onFind === 'team' ? 'Hands it to the team as Verified work' : 'Tells you')

// ───────────── the inbox ─────────────

export interface InboxGroups {
  needsYou: InboxItem[]
  found: InboxItem[]
  failed: InboxItem[]
  done: InboxItem[]
}

/**
 * The inbox as it is shown: what needs the user first (what lapses soonest at the top), then what
 * was found for them (newest first), then watches that keep failing. Done items are kept apart.
 */
export function groupInbox(items: InboxItem[]): InboxGroups {
  const open = items.filter((i) => !i.done)
  const lapse = (i: InboxItem): number => i.approval?.expiresAt ?? Infinity
  return {
    needsYou: open.filter((i) => i.kind === 'needs-you').sort((a, b) => lapse(a) - lapse(b) || b.at - a.at),
    found: open.filter((i) => i.kind === 'found').sort((a, b) => b.at - a.at),
    failed: open.filter((i) => i.kind === 'failed').sort((a, b) => b.at - a.at),
    done: items.filter((i) => i.done).sort((a, b) => b.at - a.at),
  }
}

/** The count beside "Inbox" in the sidebar: what needs the user. Unread findings show as a dot instead. */
export function inboxCount(items: InboxItem[], now = Date.now()): { needs: number; unread: number } {
  const open = items.filter((i) => !i.done)
  return {
    needs: open.filter((i) => i.kind === 'needs-you' && !(i.approval?.expiresAt && i.approval.expiresAt <= now)).length,
    unread: open.filter((i) => i.kind !== 'needs-you' && !i.read).length,
  }
}

/** When an approval lapses: "Lapses in 38 min", "Lapses at 18:30", "Lapsed". */
export function lapseLine(expiresAt: number | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null
  const ms = expiresAt - now
  if (ms <= 0) return 'Lapsed'
  if (ms < 60 * 60_000) return `Lapses in ${Math.max(1, Math.round(ms / 60_000))} min`
  const at = new Date(expiresAt)
  const days = Math.round((dayStart(at) - dayStart(new Date(now))) / 86_400_000)
  return `Lapses ${days === 0 ? '' : days === 1 ? 'tomorrow ' : `${DAY_SHORT[at.getDay()]} `}at ${clock(at)}`
}

/** "At most 60 looks a day, 30 per account; no looks on an account with less than 30% left". */
export function capsLine(c: UnattendedCaps): string {
  return `At most ${c.runsPerDay} looks a day, ${c.runsPerAccount} per account; no looks on an account with less than ${c.keepFree}% left`
}

// ───────────── making a watch ─────────────

/** The answer to "When?", as the form holds it. */
export type When =
  | { kind: 'every'; minutes: number }
  | { kind: 'daily'; at: string; days: 'all' | 'weekdays' }
  | { kind: 'github'; repo: string; on: 'ci-failed' | 'issue' | 'pr' }
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'command'; command: string }

export function triggerOf(w: When): WatchTrigger {
  switch (w.kind) {
    case 'every':
      return { kind: 'schedule', every: Math.max(5, Math.round(w.minutes)) }
    case 'daily':
      return { kind: 'schedule', at: w.at, days: w.days === 'weekdays' ? WEEKDAYS : undefined }
    case 'github':
      return { kind: 'github', repo: w.repo.trim(), on: w.on }
    case 'url':
      return { kind: 'url', url: w.url.trim() }
    case 'path':
      return { kind: 'path', path: w.path.trim() }
    case 'command':
      return { kind: 'command', command: w.command.trim() }
  }
}

export function whenOf(t: WatchTrigger): When {
  switch (t.kind) {
    case 'schedule':
      return t.at ? { kind: 'daily', at: t.at, days: t.days?.join() === WEEKDAYS.join() ? 'weekdays' : 'all' } : { kind: 'every', minutes: t.every || 60 }
    case 'github':
      return { kind: 'github', repo: t.repo, on: t.on }
    case 'url':
      return { kind: 'url', url: t.url }
    case 'path':
      return { kind: 'path', path: t.path }
    case 'command':
      return { kind: 'command', command: t.command }
  }
}

const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/

/** What is still missing or wrong before a watch can be saved, in plain words; null when it is fine. */
export function problemOf(input: { prompt: string; when: When; hours?: [number, number] | null }): string | null {
  if (!input.prompt.trim()) return 'Say what to keep an eye on.'
  const w = input.when
  if (w.kind === 'every' && (!Number.isFinite(w.minutes) || w.minutes < 5)) return 'Look at most every 5 minutes.'
  if (w.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.at)) return 'Give the time as hours and minutes, for example 07:00.'
  if (w.kind === 'github' && !REPO.test(w.repo.trim())) return 'Give the repository as owner/name, for example Kerim-Sabic/ensemble.'
  if (w.kind === 'url' && !/^https?:\/\/\S+\.\S+/i.test(w.url.trim())) return 'Give the full address of the page, starting with https://.'
  if (w.kind === 'path' && !w.path.trim()) return 'Choose the folder or file to watch.'
  if (w.kind === 'command' && !w.command.trim()) return 'Give the command to run.'
  if (input.hours && !(input.hours[0] >= 0 && input.hours[1] <= 24 && input.hours[0] < input.hours[1])) return 'The hours should run from an earlier hour to a later one.'
  return null
}

/** A name from the prompt when none was given: its first words. */
export function nameFrom(prompt: string): string {
  const s = prompt.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  if (s.length <= 48) return s.charAt(0).toUpperCase() + s.slice(1)
  const cut = s.slice(0, 48)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 24 ? cut.lastIndexOf(' ') : 48)}…`.replace(/^./, (c) => c.toUpperCase())
}

/**
 * Ready-made watches that fit the folder a chat is in. Only ones the existing triggers can really
 * do: GitHub ones need the folder's repository; the others need nothing more.
 */
export function readyMade(opts: { repo?: string | null; cwd?: string | null }): (WatchInput & { why: string })[] {
  const out: (WatchInput & { why: string })[] = []
  if (opts.repo) {
    out.push({ name: `Failed checks on ${opts.repo}`, prompt: 'When a CI run fails, find which step and test failed and why, in a few lines.', trigger: { kind: 'github', repo: opts.repo, on: 'ci-failed' }, onFind: 'tell', why: 'Tells you what broke, with the failing test' })
    out.push({ name: `New issues on ${opts.repo}`, prompt: 'Summarise each new issue in one line and say whether it looks like a bug, a question or a request.', trigger: { kind: 'github', repo: opts.repo, on: 'issue' }, onFind: 'tell', why: 'One line per new issue' })
    out.push({ name: 'Morning summary of open pull requests', prompt: `List the open pull requests on ${opts.repo} that wait for a review, oldest first.`, trigger: { kind: 'schedule', at: '08:00', days: WEEKDAYS }, onFind: 'tell', why: 'Weekdays at 08:00' })
  }
  if (opts.cwd) out.push({ name: `Changes in ${shortPath(opts.cwd)}`, prompt: 'When files change here, say what changed and whether anything looks broken.', trigger: { kind: 'path', path: opts.cwd }, cwd: opts.cwd, onFind: 'tell', why: 'Notices edits in this folder' })
  return out.slice(0, 4)
}
