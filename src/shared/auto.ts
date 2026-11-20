// Goals, loops and ways of working: the words and small sums that the engine and the
// window both need, kept in one place so they always say the same thing.

import type { Goal, GoalAction, Loop, WorkMode } from './types'
import { parseAddress } from './github'

/** What each way of working is called and what it does, for menus and tips. */
export const MODE_INFO: Record<WorkMode, { label: string; hint: string }> = {
  chat: { label: 'Team', hint: 'The lead plans and brings in the team' },
  quick: { label: 'Quick', hint: 'Answered now, without the team' },
  plan: { label: 'Plan first', hint: 'You get a plan to approve before any work starts' },
  thorough: { label: 'Verified', hint: 'The team does it, a reviewer who did none of the work checks it, and you see the evidence' },
  council: { label: 'Council', hint: 'Every model answers on its own, then the lead compares them' },
  research: { label: 'Deep research', hint: 'Several angles, a source for every claim, and a check of the facts' },
  ultra: { label: 'Ultra', hint: 'The strongest models at full effort, cross-checked. Uses allowance very fast' },
  gocrazy: { label: 'Go crazy', hint: 'Ultra at full scale, with rounds of building, judging and refining. Uses allowance fastest' },
}

/** What the app says when /gocrazy is sent while the chat's Ultra is off. */
export const GOCRAZY_NEEDS_ULTRA = 'Go crazy works in Ultra mode. Turn Ultra on first (/ultra on).'

/** How many extra agents one chat may have at once, by the way the current message is being worked. */
export const SPAWN_CAP_ULTRA = 20
/**
 * Going crazy there is no set number: the cap is what this machine can carry right now (free memory
 * and processor cores, hub.machineCap), worked out again at every spawn. This is only a safety stop
 * against a runaway, far above what any machine reaches: every agent's events pass through the
 * app's one main thread, and the roster each agent reads lists everyone.
 */
export const SPAWN_CAP_GOCRAZY = 200
/** What one agent is reckoned to take in memory, in MB: its CLI process and the connector servers it starts. */
export const AGENT_MB = 400
/** Going crazy, how many live agents each processor core is reckoned to carry (they mostly wait on the network). */
export const AGENTS_PER_CORE = 6
/** Going crazy, the lead tries again once when its first turn on a substantial request started fewer agents than this. */
export const CRAZY_FLOOR = 8
/** Going crazy, how many agents the lead of a region (an agent the lead started) may run of its own. */
export const REGION_TEAM = 12

/**
 * How many levels of agents a chat may hold below its lead: 1 is an agent the lead started, 2 an
 * agent one of those started, and so on. Deeper teams only while the user chose to spend.
 */
export const MAX_DEPTH_USUAL = 2
export const MAX_DEPTH_ULTRA = 3
export const MAX_DEPTH_GOCRAZY = 8

/**
 * A message that needs a direct answer, not a team: a thank-you, a clicked choice from an earlier
 * answer, or a short question about how things stand.
 */
export function isSmallTalk(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/^(?:Chose|Answers):/i.test(t)) return true
  if (t.length < 40 && /^(thanks|thank you|thx|ty|cheers|great|nice|perfect|awesome|ok|okay|cool|looks good|got it|yes|no)\b/i.test(t)) return true
  return t.length < 80 && /\?$/.test(t) && /\b(status|where are we|how far|done yet|progress|how is it going|any news)\b/i.test(t)
}

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
  // The three main ways of working first. "/thorough" still works when typed; "/verified" is its name now.
  { name: 'quick', description: 'Quick: answered now, without the team', hint: '<request>' },
  { name: 'team', description: 'Team: the lead plans and brings in the team', hint: '<request>' },
  { name: 'verified', description: 'Verified: the team does it, a reviewer who did none of the work checks it, and you see the evidence', hint: '<request>' },
  { name: 'goal', description: 'Keep working until this is done, checking after every reply', hint: '<what done looks like>  ·  pause | resume | stop' },
  { name: 'loop', description: 'Send this again by itself, on a timer or when the lead judges it is time', hint: '[5m | 2h | 1d] <what to do>  ·  stop' },
  { name: 'plan', description: 'Get a plan to approve before any work starts', hint: '<request>' },
  { name: 'council', description: 'Every model answers on its own, then the lead compares them', hint: '<question>' },
  { name: 'research', description: 'Several angles, sources for every claim, a check of the facts', hint: '<question>' },
  { name: 'ultra', description: 'The strongest models at full effort, cross-checked. Uses allowance very fast', hint: 'on | off  ·  <request>' },
  { name: 'gocrazy', description: 'Ultra at full scale, with rounds of building, judging and refining. Needs Ultra on', hint: '<request>' },
  // Opened by the window (From GitHub); the engine never sees it as a command.
  { name: 'github', description: 'Start from a GitHub issue, pull request or failed run, as verified work', hint: '<address>' },
  // Opened by the window too (the make-a-watch screen); the engine never passes it to an agent.
  { name: 'watch', description: 'Keep an eye on something by itself and tell you only when it finds something', hint: '<what to keep an eye on>' },
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
   * "/github" opens From GitHub; "/github <address>" opens it on that repository, issue, pull request
   * or failed run. `ok` is false when the address is not a GitHub one: nothing opens and nothing is sent.
   * The window handles it; the engine never passes it to an agent.
   */
  | { kind: 'github'; address: string; ok: boolean }
  /** "/watch" opens the make-a-watch screen, with the rest (if any) as what to keep an eye on. The window handles it. */
  | { kind: 'watch'; text: string }

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
  const m = /^\/(goal|loop|plan|quick|team|verified|thorough|council|research|ultra|gocrazy|go-crazy|github|watch)(?:\s+([\s\S]*))?$/i.exec(text.trim())
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
  if (name === 'github') return { kind: 'github', address: rest, ok: !rest || !!parseAddress(rest) }
  if (name === 'watch') return { kind: 'watch', text: rest }
  if (name === 'go-crazy') return rest ? { kind: 'mode', mode: 'gocrazy', text: rest } : null
  // The names people see: Team is the usual way ('chat'), Verified is 'thorough'.
  if (name === 'team') return rest ? { kind: 'mode', mode: 'chat', text: rest } : null
  if (name === 'verified') return rest ? { kind: 'mode', mode: 'thorough', text: rest } : null
  return rest ? { kind: 'mode', mode: name as WorkMode, text: rest } : null
}

/** A goal that is still in play: being worked on, or waiting for the user. */
export const goalOpen = (g: Goal | null | undefined): g is Goal => !!g && (g.status === 'active' || g.status === 'paused' || g.status === 'blocked')

/** Loops that are not over. */
export const liveLoops = (loops: Loop[] | undefined): Loop[] => (loops || []).filter((l) => l.status !== 'done')

/** Where a goal stands, in a few words. */
export function goalLine(g: Goal): string {
  switch (g.status) {
    case 'active': {
      if (g.checking) return 'Checking whether it is done'
      const where = g.round ? `Round ${g.round + 1} of ${g.maxRounds}` : ''
      // What it waits for, so a goal whose lead is idle does not look stuck.
      const wait = g.waiting === 'team' ? 'Waiting for the team' : g.waiting === 'retry' ? 'A reply failed, trying again shortly' : ''
      return where && wait ? `${where} · ${wait.charAt(0).toLowerCase()}${wait.slice(1)}` : wait || where || 'Working on it'
    }
    case 'paused':
      return g.waiting === 'allowance' ? 'Waiting for the allowance to come back' : 'Paused'
    case 'met':
      return g.round ? `Done after ${g.round + 1} rounds` : 'Done'
    case 'blocked':
      return 'Needs you'
    case 'stopped':
      return 'Stopped before it was met'
  }
}

/** Where a loop stands, in a few words. */
export function loopLine(l: Loop, now = Date.now()): string {
  if (l.status === 'done') return l.runs === 1 ? 'Ended after 1 run' : `Ended after ${l.runs} runs`
  if (l.status === 'paused') return 'Paused'
  if (l.running) return `Run ${l.runs} under way`
  if (!l.nextAt) return everyLabel(l.every)
  // A run that is due does not barge in: it starts as soon as whoever runs it is free.
  return l.nextAt <= now ? 'Next run starts when the agent is free' : `Next run in ${countdown(l.nextAt, now)}`
}

/**
 * Names in plain words, for the window: "Scout 1 and Scout 2". A long list folds numbered or
 * lettered names into groups: "4 scouts and Builder A".
 */
export function namesLine(names: string[]): string {
  const list = [...new Set(names.filter(Boolean))]
  const join = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
  if (list.length <= 3) return join(list)
  const groups = new Map<string, string[]>()
  for (const n of list) {
    const stem = n.replace(/\s+(\d+|[A-Z])$/, '').trim() || n
    groups.set(stem, [...(groups.get(stem) || []), n])
  }
  return join([...groups].map(([stem, xs]) => (xs.length > 1 ? `${xs.length} ${stem.toLowerCase()}${/s$/i.test(stem) ? '' : 's'}` : xs[0])))
}
