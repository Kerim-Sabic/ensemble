// Whether an account can take work right now, worked out from its usage windows. Used by the
// hub (to hand work over before an account fails) and by the window (to show each account's state).
//
// 'low' is a warning with some give in it: an account becomes low at 90% of its session window or
// 95% of its week, and only stops being low once it is clearly below that again (or the window
// refills), so an account hovering around the line does not flip back and forth.

import type { AccountUsage, Supply, UsageWindow } from './types'

/** How full a window is when the account counts as running low. */
export const LOW_AT = { session: 0.9, weekly: 0.95 } as const
/** How far below the line an account that was low must fall before it counts as fine again. */
export const LOW_EASE = 0.08

const OK: Supply = { state: 'ok', until: null }

const live = (w: UsageWindow | undefined, now: number): w is UsageWindow => !!w && typeof w.utilization === 'number' && (!w.resetsAt || w.resetsAt > now)

/**
 * Where an account stands. `was` is what it was last time, for the give described above.
 * Out wins over low; when both windows are out, the later refill is the one that counts.
 */
export function supplyOf(u: Pick<AccountUsage, 'session' | 'weekly'> | undefined, was?: Supply, now = Date.now()): Supply {
  if (!u) return OK
  const wins: ['session' | 'weekly', UsageWindow | undefined][] = [
    ['session', u.session],
    ['weekly', u.weekly],
  ]
  let out: Supply | null = null
  for (const [name, w] of wins) {
    if (!live(w, now) || !w.resetsAt) continue
    if (w.status === 'rejected' || w.utilization >= 1) {
      if (!out || (out.until || 0) < w.resetsAt) out = { state: 'out', until: w.resetsAt, window: name }
    }
  }
  if (out) return out
  const wasLow = was?.state === 'low' || was?.state === 'out'
  let low: Supply | null = null
  for (const [name, w] of wins) {
    if (!live(w, now)) continue
    const line = LOW_AT[name] - (wasLow ? LOW_EASE : 0)
    if (w.utilization >= line && (!low || (low.until || 0) < (w.resetsAt || 0))) low = { state: 'low', until: w.resetsAt, window: name }
  }
  return low || OK
}

/** The state as stored, unless the window behind it has refilled since: then it is worked out again. */
export function supplyNow(u: AccountUsage | undefined, now = Date.now()): Supply {
  const s = u?.supply
  if (s && (s.state === 'ok' || !s.until || s.until > now)) return s
  return supplyOf(u, undefined, now)
}

/**
 * The state in a few words, for a list of accounts: "Running low", "Out until 14:30",
 * "Out until 14:30 · covered by Claude 3". Empty when the account is fine.
 */
export function supplyWords(s: Supply, clock: (ts: number) => string, coveredBy?: string): string {
  const cover = coveredBy ? ` · covered by ${coveredBy}` : ''
  if (s.state === 'out') return `${s.until ? `Out until ${clock(s.until)}` : 'Out of usage'}${cover}`
  if (s.state === 'low') return `Running low${cover}`
  return coveredBy ? `Covered by ${coveredBy}` : ''
}

/** The one line the chat shows when a teammate took over as lead by itself. */
export function handoverLine(next: string, prev: string, why: 'out' | 'low', until: number | null, clock: (ts: number) => string): string {
  const what = why === 'out' ? `${prev} ran out of usage` : `${prev} is about to run out of usage`
  return `${next} took over as lead: ${what}.${until ? ` ${prev} is back at ${clock(until)}.` : ''}`
}
