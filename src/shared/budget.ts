// How much allowance an account has left against how long it has to last, and
// what that says about which model it should run. Used by the hub (to choose
// models and teammates) and by the window (to show why).
//
// An allowance that refills soon is worth nothing once it has refilled, so what
// is left of it should be spent on the strongest model. One that has to last
// most of a week should not be burned in an afternoon.

import type { AccountUsage, UsageWindow } from './types'

/**
 * spend: more is left than the time remaining calls for, so use it freely.
 * steady: about on pace. save: being used faster than it can last. out: used up.
 */
export type Pace = 'spend' | 'steady' | 'save' | 'out'

export interface WindowBudget {
  /** 0..1 of the window still unused. */
  left: number
  /** Hours until it refills. null when the provider did not say. */
  hours: number | null
  resetsAt: number | null
  pace: Pace
}

export interface Budget {
  /** The short window (about five hours). */
  session?: WindowBudget
  weekly?: WindowBudget
  /** The strongest model's own allowance, when the plan meters it separately. */
  top?: WindowBudget & { label: string }
}

const SESSION_HOURS = 5
const WEEK_HOURS = 168

function windowBudget(w: UsageWindow | { utilization: number; resetsAt: number | null } | undefined, span: number, now: number): WindowBudget | undefined {
  if (!w || typeof w.utilization !== 'number') return undefined
  const stale = !!w.resetsAt && w.resetsAt <= now
  // A window whose refill time has passed is full again, whatever was last reported.
  const left = stale ? 1 : Math.min(1, Math.max(0, 1 - w.utilization))
  const hours = w.resetsAt && !stale ? (w.resetsAt - now) / 3600e3 : null
  const rejected = !stale && 'status' in w && w.status === 'rejected'
  let pace: Pace
  if (rejected || left <= 0.03) pace = 'out'
  else {
    // The share of the window's time that is still ahead. Unknown counts as half.
    const ahead = hours === null ? 0.5 : Math.min(1, Math.max(0, hours / span))
    const ratio = left / Math.max(ahead, 0.04)
    const closing = hours !== null && hours <= span * 0.15
    if ((ratio >= 1.4 && left >= 0.15) || (closing && left >= 0.2)) pace = 'spend'
    else if (ratio < 0.6 || left < 0.1) pace = 'save'
    else pace = 'steady'
  }
  return { left, hours, resetsAt: stale ? null : w.resetsAt, pace }
}

/** Which metered model a label such as "Fable" refers to. */
/** The plans meter the strongest Claude model on its own; its allowance goes by this name. */
const TOP = /fable|mythos/i
/** The strongest model of any provider. */
const TOP_ANY = /fable|mythos|astra/i

export function budgetOf(usage: AccountUsage | undefined, now = Date.now()): Budget {
  if (!usage) return {}
  const scoped = (usage.scoped || []).find((s) => TOP.test(s.label)) || usage.scoped?.[0]
  const top = scoped ? windowBudget(scoped, WEEK_HOURS, now) : undefined
  return {
    session: windowBudget(usage.session, SESSION_HOURS, now),
    weekly: windowBudget(usage.weekly, WEEK_HOURS, now),
    top: top && scoped ? { ...top, label: scoped.label } : undefined,
  }
}

/** top: the strongest model. strong: the next one down. mid: the everyday model. */
export type Tier = 'top' | 'strong' | 'mid' | 'light'

/** Strongest first. */
export const TIER_ORDER: Tier[] = ['top', 'strong', 'mid', 'light']

/** Each model family, strongest first. */
const FAMILY: { tier: Tier; match: RegExp }[] = [
  { tier: 'top', match: TOP_ANY },
  { tier: 'strong', match: /opus|(^|[^a-z])sol([^a-z]|$)/i },
  { tier: 'mid', match: /sonnet/i },
  { tier: 'light', match: /haiku|luna/i },
]

/** Which tier a model belongs to, by its id or name. */
export const tierOfModel = (model: string | null | undefined): Tier | null => (model ? FAMILY.find((f) => f.match.test(model))?.tier || null : null)

/** True for a model of the strongest family, by its id or its name. */
export const isTopModel = (model: string | null | undefined): boolean => !!model && TOP_ANY.test(model)

/**
 * The model an account has for a tier. A step down is taken when the account has no model
 * of that family, except from the top: an account without the strongest model is not given
 * a lesser one in its name.
 */
export function modelForTier<M extends { value: string; label: string }>(models: M[], tier: Tier): M | undefined {
  // The current generation goes by its short name; older ones carry a full id.
  const list = models.filter((m) => m.value && m.value !== 'default')
  const current = list.filter((m) => !/^claude-/.test(m.value))
  const pool = current.length ? current : list
  for (let i = FAMILY.findIndex((f) => f.tier === tier); i >= 0 && i < FAMILY.length; i++) {
    const m = pool.find((x) => FAMILY[i].match.test(x.value) || FAMILY[i].match.test(x.label))
    if (m) return m
    if (tier === 'top') return undefined
  }
  return undefined
}

export interface ModelAdvice {
  tier: Tier
  /** Set when there is allowance to burn: think harder as well. */
  effort?: 'high'
  /** One plain sentence saying why, for the person and for the lead. */
  why: string
}

export function hoursLabel(h: number | null): string {
  if (h === null) return ''
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} days`
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

/**
 * Which model an account's allowance can afford right now. `lead` keeps the
 * strongest model for as long as there is any of it left: planning and
 * checking are where it counts most. Returns null when there is nothing to go
 * on, and the account then runs whatever it is set to.
 */
export function adviseModel(b: Budget, role: 'lead' | 'worker'): ModelAdvice | null {
  const { weekly, top } = b
  if (!weekly && !top) return null
  if (weekly?.pace === 'out') return null
  const refill = (w: WindowBudget): string => (w.hours === null ? '' : `, refills in ${hoursLabel(w.hours)}`)

  if (top) {
    const name = top.label
    if (top.pace === 'out') return { tier: 'strong', why: `${name} allowance is used up${top.hours === null ? '' : ` for another ${hoursLabel(top.hours)}`}, so the next model down is used` }
    if (role === 'lead') {
      // The lead gives the strongest model up only when what is left of it would not last anyway.
      if (top.pace === 'save' && top.left < 0.15) return { tier: 'strong', why: `Only ${pct(top.left)} of the ${name} allowance is left${refill(top)}, so it is kept for the hardest work` }
      return { tier: 'top', effort: top.pace === 'spend' && weekly?.pace === 'spend' ? 'high' : undefined, why: top.pace === 'spend' ? `${pct(top.left)} of the ${name} allowance is left${refill(top)}: plenty to use` : `${pct(top.left)} of the ${name} allowance is left${refill(top)}` }
    }
    if (weekly?.pace === 'save') return { tier: 'mid', why: `Only ${pct(weekly.left)} of the week's allowance is left${refill(weekly)}, so it is being stretched` }
    if (top.pace === 'spend') return { tier: 'top', effort: weekly?.pace === 'spend' ? 'high' : undefined, why: `${pct(top.left)} of the ${name} allowance is left${refill(top)}: it would go unused otherwise` }
    if (top.pace === 'steady') return { tier: 'top', why: `${pct(top.left)} of the ${name} allowance is left${refill(top)}` }
    return { tier: 'strong', why: `${name} allowance is running low (${pct(top.left)} left${refill(top)}), kept for the hardest work` }
  }

  // No separate meter for the strongest model: go by the week as a whole.
  if (!weekly) return null
  if (weekly.pace === 'spend') return { tier: 'top', effort: 'high', why: `${pct(weekly.left)} of the week's allowance is left${refill(weekly)}: it would go unused otherwise` }
  if (weekly.pace === 'save' && role === 'worker') return { tier: 'mid', why: `Only ${pct(weekly.left)} of the week's allowance is left${refill(weekly)}, so it is being stretched` }
  return null
}

/**
 * How good an account is to hand work to, from its allowance alone: 0 is best.
 * Allowance that refills soonest with the most left comes first, since it is the
 * allowance that would otherwise be lost. An account close to its short-window
 * limit comes last however much of the week it has.
 */
export function spendScore(b: Budget): number {
  const w = b.weekly
  const s = b.session
  let score = 0.5
  if (w) {
    const ahead = w.hours === null ? 0.5 : Math.min(1, Math.max(0, w.hours / WEEK_HOURS))
    // Lots left and little time to use it in scores near 0; little left scores near 1.
    score = 1 - (0.55 * w.left * (1 - ahead) + 0.45 * w.left)
    if (w.pace === 'out') score += 5
    else if (w.pace === 'save') score += 0.35
  }
  if (s) {
    if (s.pace === 'out') score += 5
    else if (s.left < 0.15) score += 1.5
    else if (s.left < 0.3) score += 0.3
  }
  return score
}

const PACE_WORD: Record<Pace, string> = { spend: 'plenty to use', steady: 'on pace', save: 'running low', out: 'used up' }

/** "68% of the week left, refills in 17 h (plenty to use)" and the like, for the roster the lead reads. */
export function budgetLine(b: Budget): string {
  const part = (label: string, w: WindowBudget | undefined, word = true): string => (w ? `${pct(w.left)} of ${label} left${w.hours === null ? '' : `, refills in ${hoursLabel(w.hours)}`}${word ? ` (${PACE_WORD[w.pace]})` : ''}` : '')
  return [part("this session's allowance", b.session, false), part("the week's", b.weekly), b.top ? part(`the ${b.top.label} allowance`, b.top) : ''].filter(Boolean).join(' · ')
}

export const paceWord = (p: Pace): string => PACE_WORD[p]
