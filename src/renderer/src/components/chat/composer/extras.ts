// What goes with a message besides its text: a way of working, or making it a goal or a loop.
// Kept per chat with the draft, so switching chats and back finds it as it was left.

import type { GoalCheck, GoalInput, LoopInput, WorkMode } from '@shared/types'
import { EVERY_PRESETS, GOCRAZY_NEEDS_ULTRA, MODE_INFO, everyLabel, parseCommand, parseEvery, type AppCommand } from '@shared/auto'

export interface Extras {
  mode: WorkMode
  /** The message becomes the chat's goal, or a loop. */
  kind: 'goal' | 'loop' | null
  doneWhen: string
  /** null: the settings' default. */
  rounds: number | null
  /** A time limit in minutes. null: none. */
  minutes: number | null
  /** null: the settings' default. */
  check: GoalCheck | null
  /** Milliseconds between runs. null: the agent sets the pace. */
  every: number | null
  until: string
  maxRuns: number | null
  /** The "make this a goal / loop" offer was turned down for this draft. */
  nudgeOff: boolean
  /** Ultra picked on the new-chat screen, before there is a chat to keep it. */
  ultra: boolean
}

export const NO_EXTRAS: Extras = {
  mode: 'chat',
  kind: null,
  doneWhen: '',
  rounds: null,
  minutes: null,
  check: null,
  every: null,
  until: '',
  maxRuns: null,
  nudgeOff: false,
  ultra: false,
}

export const TIME_LIMITS: { minutes: number | null; label: string }[] = [
  { minutes: null, label: 'No time limit' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 120, label: '2 h' },
  { minutes: 240, label: '4 h' },
  { minutes: 480, label: '8 h' },
]

export const RUN_LIMITS: (number | null)[] = [null, 3, 5, 10, 25, 50]

export const CHECKS: Record<GoalCheck, { label: string; hint: string }> = {
  fresh: { label: 'Fresh checker', hint: 'Someone who did not do the work says when it is done' },
  self: { label: "The lead's own word", hint: 'The lead says when it is done. Faster, and less allowance' },
}

/** The pace a loop runs at, as its pill shows it. */
export const paceLabel = (every: number | null): string => EVERY_PRESETS.find((p) => p.ms === every)?.label || `Every ${everyLabel(every).replace(/^every /, '')}`

/** What goes to the engine with the message. */
export function goalOf(x: Extras, defaults: { rounds: number; check: GoalCheck }): Partial<GoalInput> {
  return {
    doneWhen: x.doneWhen.trim() || undefined,
    maxRounds: x.rounds ?? defaults.rounds,
    minutes: x.minutes,
    check: x.check ?? defaults.check,
  }
}

export function loopOf(x: Extras): Partial<LoopInput> {
  return { every: x.every, until: x.until.trim() || undefined, maxRuns: x.maxRuns }
}

/** Go crazy only goes out while the chat's Ultra is on. */
export const gocrazyAllowed = (ultra: boolean | undefined): boolean => !!ultra

// ───────────── reading what was typed ─────────────

export type Preview = {
  tone: 'goal' | 'loop' | 'mode' | 'stop'
  label: string
  hint: string
  mode?: WorkMode
  /** The command is not finished: sending it now would not do what it says. */
  incomplete?: boolean
}

/** The pace of a "/loop 15m" that has nothing after the pace yet. */
export const lonePace = (cmd: AppCommand | null): number | undefined => (cmd?.kind === 'loop' && !cmd.every ? parseEvery(cmd.prompt) : undefined)

const GOAL_ACTION: Record<string, { label: string; hint: string }> = {
  pause: { label: 'Pauses the goal', hint: 'Work on it stops until you resume it' },
  resume: { label: 'Resumes the goal', hint: 'The lead picks it up where it stopped' },
  stop: { label: 'Stops the goal', hint: 'It ends here, done or not' },
  clear: { label: 'Clears the goal', hint: 'Takes the goal off this chat' },
  more: { label: 'More rounds for the goal', hint: 'Another batch of rounds, and it carries on' },
}

/** What a typed command will do, in a few words, before it is sent. `ultra`: the chat's Ultra is on. */
export function previewOf(cmd: AppCommand | null, ultra = false): Preview | null {
  if (!cmd) return null
  switch (cmd.kind) {
    case 'goal':
      return { tone: 'goal', label: 'Goal', hint: 'The team keeps working until this is done' }
    case 'goal-action':
      return { tone: 'stop', ...GOAL_ACTION[cmd.action] }
    case 'loop': {
      // "/loop 15m" with nothing after it yet: the pace is there, what to do is still to come.
      const pace = lonePace(cmd)
      if (pace) return { tone: 'loop', label: `${paceLabel(pace)} · say what to do`, hint: 'Now write what it should do each time, after the pace', incomplete: true }
      return {
        tone: 'loop',
        label: `Loop · ${cmd.every ? everyLabel(cmd.every) : 'its own pace'}`,
        hint: cmd.every ? `Runs now, then ${everyLabel(cmd.every)}` : 'Runs now, then again when the agent says the next run is due',
      }
    }
    case 'loop-stop':
      return { tone: 'stop', label: 'Stops the loops', hint: 'Every loop in this chat ends' }
    case 'mode':
      // Go crazy only goes out while the chat's Ultra is on: say so before, not after.
      if (cmd.mode === 'gocrazy' && !gocrazyAllowed(ultra)) return { tone: 'stop', label: 'Needs Ultra on', hint: GOCRAZY_NEEDS_ULTRA, mode: cmd.mode, incomplete: true }
      return { tone: 'mode', label: MODE_INFO[cmd.mode].label, hint: MODE_INFO[cmd.mode].hint, mode: cmd.mode }
    case 'ultra': {
      const on = cmd.on ?? !ultra
      if (on === ultra) return { tone: 'stop', label: on ? 'Ultra is already on' : 'Ultra is already off', hint: 'Sending this changes nothing', mode: 'ultra' }
      return on
        ? { tone: 'mode', label: 'Turns Ultra on', hint: 'Every message in this chat goes to many agents on the strongest models until you turn it off', mode: 'ultra' }
        : { tone: 'stop', label: 'Turns Ultra off', hint: 'Messages go back to the usual way of working', mode: 'ultra' }
    }
  }
  return null
}

export const commandOf = (text: string): AppCommand | null => (text.trimStart().startsWith('/') ? parseCommand(text) : null)

const LOOP_WORDS =
  /\b(every\s+(\d+(\.\d+)?\s*)?(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|morning|evening|night|week|weekday)|each\s+(morning|evening|night|day|hour|week|weekday)|hourly|daily|nightly|monitor|watch\s+for|keep\s+(checking|an\s+eye|watching|polling)|check\s+(back\s+)?(in|every)|poll)\b/i
const GOAL_WORDS =
  /\b(until|keep\s+going|keep\s+at\s+it|keep\s+working|don'?t\s+stop|do\s+not\s+stop|make\s+sure\s+(all|every|everything)|all\s+(the\s+)?tests\s+pass|tests\s+are\s+green|build\s+is\s+green|no\s+(more\s+)?(errors|failures|warnings)\s+(left|remain))\b/i

/** A message that reads like a job that should keep going by itself. */
export function nudgeOf(text: string): { kind: 'goal' | 'loop'; every?: number } | null {
  const t = text.trim()
  if (t.length < 20 || t.startsWith('/')) return null
  const loop = LOOP_WORDS.exec(t)
  if (loop) {
    const w = loop[0].toLowerCase()
    const n = /^every\s+(\d+(?:\.\d+)?\s*[a-z]+)/.exec(w)
    const every = n ? parseEvery(n[1]) : /hour/.test(w) ? 3_600_000 : /day|daily|morning|evening|night|weekday/.test(w) ? 86_400_000 : undefined
    return { kind: 'loop', every }
  }
  return GOAL_WORDS.test(t) ? { kind: 'goal' } : null
}
