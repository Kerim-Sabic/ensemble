// Goals, loops and ways of working: the words and small sums that the engine and the
// window both need, kept in one place so they always say the same thing.

import type { Goal, GoalAction, Loop, WorkMode } from './types'

/** What each way of working is called and what it does, for menus and tips. */
export const MODE_INFO: Record<WorkMode, { label: string; hint: string }> = {
  chat: { label: 'Auto', hint: 'The lead decides how to go about it' },
  quick: { label: 'Quick', hint: 'The lead answers alone. Fastest, and the least allowance' },
  plan: { label: 'Plan first', hint: 'You get a plan to approve before any work starts' },
  thorough: { label: 'Thorough', hint: 'The whole team from the start, and a fresh reviewer before the answer' },
  council: { label: 'Council', hint: 'Every model answers on its own, then the lead compares them' },
  research: { label: 'Deep research', hint: 'Several angles, a source for every claim, and a check of the facts' },
  ultra: { label: 'Ultra', hint: 'Many agents on the strongest models at full effort, cross-checked. Uses allowance very fast' },
  gocrazy: { label: 'Go crazy', hint: 'Ultra at full scale: a swarm of fast research agents, every top model building its own version, judges, rounds of refinement' },
}

/** What the app says when /gocrazy is sent while the chat's Ultra is off. */
export const GOCRAZY_NEEDS_ULTRA = 'Go crazy works in Ultra mode. Turn Ultra on first (/ultra on).'

/** How many extra agents one chat may have at once, by the way the current message is being worked. */
export const SPAWN_CAP_ULTRA = 16
export const SPAWN_CAP_GOCRAZY = 24

/**
 * The way a message really goes: the mode it was sent with, or 'ultra' when it was sent with none
 * (or as plain 'chat') while the chat's Ultra is on.
 */
export function effectiveMode(mode: WorkMode | undefined, ultra: boolean | undefined): WorkMode {
  if (mode && mode !== 'chat') return mode
  return ultra ? 'ultra' : 'chat'
}

/** A loop cannot run more often than this. */
export const MIN_EVERY = 60_000

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The paces offered for a loop. null is "the agent sets the pace itself". */
export const EVERY_PRESETS: { ms: number | null; label: string }[] = [
  { ms: null, label: 'Its own pace' },
  { ms: 5 * MIN, label: 'Every 5 min' },
  { ms: 15 * MIN, label: 'Every 15 min' },
  { ms: 30 * MIN, label: 'Every 30 min' },
  { ms: HOUR, label: 'Every hour' },
  { ms: 4 * HOUR, label: 'Every 4 hours' },
  { ms: DAY, label: 'Every day' },
]

/** How many rounds a goal may be given. */
export const ROUND_PRESETS = [5, 12, 25, 50]

/** A length of time in a few words: "45 s", "5 min", "1 h 30 min", "2 days". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`
  const d = Math.floor(h / 24)
  const hr = h % 24
  return hr ? `${d} d ${hr} h` : d === 1 ? '1 day' : `${d} days`
}

/** A loop's pace as a phrase: "every 5 min", "every day", "at its own pace". */
export function everyLabel(ms: number | null | undefined): string {
  if (!ms) return 'at its own pace'
  if (ms === HOUR) return 'every hour'
  if (ms === DAY) return 'every day'
  return `every ${span(ms)}`
}

/** Time left until `at`, for a clock that ticks: "0:42", "4:12", "1 h 5 min", "now". */
export function countdown(at: number | null | undefined, now = Date.now()): string {
  if (!at) return ''
  const ms = at - now
  if (ms <= 0) return 'now'
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return span(ms)
}

/**
 * Reads a pace someone typed: "10m", "90s", "2h", "1d", "15 min", "every 2 hours", "daily", "hourly".
 * Returns milliseconds (never less than a minute), or undefined when it is not a pace.
 */
export function parseEvery(raw: string): number | undefined {
  const s = raw.trim().toLowerCase().replace(/^every\s+/, '')
  if (s === 'hourly' || s === 'hour') return HOUR
  if (s === 'daily' || s === 'day') return DAY
  if (s === 'minute') return MIN
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(s)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const unit = m[2][0]
  const ms = unit === 's' ? n * 1000 : unit === 'm' ? n * MIN : unit === 'h' ? n * HOUR : n * DAY
  return Math.max(MIN_EVERY, Math.round(ms))
}

/** The commands the app itself answers to, whoever the message is for. Offered when "/" is typed. */
export const APP_COMMANDS: { name: string; description: string; hint?: string }[] = [
  { name: 'goal', description: 'Keep working until this is done, checking after every reply', hint: '<what done looks like>  ·  pause | resume | stop' },
  { name: 'loop', description: 'Send this again by itself, on a timer or at the agent\'s own pace', hint: '[5m | 2h | 1d] <what to do>  ·  stop' },
  { name: 'plan', description: 'Get a plan to approve before any work starts', hint: '<request>' },
  { name: 'quick', description: 'The lead answers alone: fastest, least allowance', hint: '<request>' },
  { name: 'thorough', description: 'The whole team from the start, and a fresh reviewer before the answer', hint: '<request>' },
  { name: 'council', description: 'Every model answers on its own, then the lead compares them', hint: '<question>' },
  { name: 'research', description: 'Several angles, sources for every claim, a check of the facts', hint: '<question>' },
  { name: 'ultra', description: 'Many agents on the strongest models at full effort. Uses allowance very fast', hint: 'on | off  ·  <request>' },
  { name: 'gocrazy', description: 'Ultra at full scale: research swarm, every top model builds, judges, refinement. Needs Ultra on', hint: '<request>' },
]

export type AppCommand =
  | { kind: 'goal'; text: string }
  | { kind: 'goal-action'; action: GoalAction | 'clear' }
  | { kind: 'loop'; every: number | null; prompt: string }
  | { kind: 'loop-stop' }
  | { kind: 'mode'; mode: WorkMode; text: string }
  /** "/ultra on" | "/ultra off" | "/ultra" (on: undefined, which flips it). */
  | { kind: 'ultra'; on?: boolean }

/**
 * Reads a message that starts with one of the app's own commands.
 *   /goal all tests pass and the build is green      /goal pause | resume | stop | clear | more
 *   /loop 10m check the deploy and tell me if it is live      /loop check my inbox      /loop stop
 *   /plan …   /quick …   /thorough …   /council …   /research …
 *   /ultra on | off      /ultra (flips it)      /ultra <request> (that one message in Ultra)
 *   /gocrazy <request> (only goes out while Ultra is on; the sender checks that)
 * Returns null for anything else, which is then sent as it is.
 */
export function parseCommand(text: string): AppCommand | null {
  const m = /^\/(goal|loop|plan|quick|thorough|council|research|ultra|gocrazy|go-crazy)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!m) return null
  const name = m[1].toLowerCase()
  const rest = (m[2] || '').trim()
  if (name === 'goal') {
    const word = rest.toLowerCase()
    if (word === 'pause' || word === 'resume' || word === 'stop' || word === 'more' || word === 'clear') return { kind: 'goal-action', action: word }
    if (word === 'off' || word === 'cancel' || word === 'end') return { kind: 'goal-action', action: 'stop' }
    return rest ? { kind: 'goal', text: rest } : null
  }
  if (name === 'loop') {
    if (/^(stop|off|cancel|end)$/i.test(rest)) return { kind: 'loop-stop' }
    if (!rest) return null
    // The pace comes first when there is one: "10m …", "every 2 hours …", "daily …".
    const lead = /^(every\s+\d+(?:\.\d+)?\s*[a-z]+|every\s+(?:minute|hour|day)|\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)|hourly|daily)\s+([\s\S]+)$/i.exec(rest)
    if (lead) {
      const every = parseEvery(lead[1])
      if (every) return { kind: 'loop', every, prompt: lead[2].trim() }
    }
    return { kind: 'loop', every: null, prompt: rest }
  }
  if (name === 'ultra') {
    const word = rest.toLowerCase()
    if (!word || word === 'toggle') return { kind: 'ultra' }
    if (word === 'on' || word === 'start') return { kind: 'ultra', on: true }
    if (word === 'off' || word === 'stop' || word === 'end') return { kind: 'ultra', on: false }
    return { kind: 'mode', mode: 'ultra', text: rest }
  }
  if (name === 'go-crazy') return rest ? { kind: 'mode', mode: 'gocrazy', text: rest } : null
  return rest ? { kind: 'mode', mode: name as WorkMode, text: rest } : null
}

/** A goal that is still in play: being worked on, or waiting for the user. */
export const goalOpen = (g: Goal | null | undefined): g is Goal => !!g && (g.status === 'active' || g.status === 'paused' || g.status === 'blocked')

/** Loops that are not over. */
export const liveLoops = (loops: Loop[] | undefined): Loop[] => (loops || []).filter((l) => l.status !== 'done')

/** Where a goal stands, in a few words. */
export function goalLine(g: Goal): string {
  switch (g.status) {
    case 'active':
      return g.checking ? 'Checking whether it is done' : g.round ? `Round ${g.round + 1} of ${g.maxRounds}` : 'Working on it'
    case 'paused':
      return 'Paused'
    case 'met':
      return g.round ? `Done after ${g.round + 1} rounds` : 'Done'
    case 'blocked':
      return 'Needs you'
    case 'stopped':
      return 'Stopped before it was done'
  }
}

/** Where a loop stands, in a few words. */
export function loopLine(l: Loop, now = Date.now()): string {
  if (l.status === 'done') return l.runs === 1 ? 'Ended after 1 run' : `Ended after ${l.runs} runs`
  if (l.status === 'paused') return 'Paused'
  if (l.running) return `Run ${l.runs} under way`
  if (!l.nextAt) return everyLabel(l.every)
  return l.nextAt <= now ? 'Next run is due' : `Next run in ${countdown(l.nextAt, now)}`
}
