// Which agent tabs fit in the row: the lead and the agents that matter now come first, and
// whoever does not fit goes into one "+N" chip. Widths come from the real text, measured with
// the same font the tabs use.

import { useLayoutEffect, useState } from 'react'
import type { Account, AgentPhase } from '@shared/types'

let ctx: CanvasRenderingContext2D | null = null

export function textWidth(text: string, px: number, weight = 500): number {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * px * 0.6
  ctx.font = `${weight} ${px}px 'Inter Variable', 'Segoe UI', system-ui, sans-serif`
  return ctx.measureText(text).width
}

/** The width of one tab as the row draws it: padding, the orb, the name, and the marks after it. */
export function tabWidth(a: Account, lead: boolean, dot: boolean): number {
  let w = 7 + (a.spawned ? 16 : 18) + 8 + textWidth(a.name, 13) + 12
  if (a.spawned) w += 16 // the small "started by" arrow in front, and its gap
  if (lead) w += 8 + textWidth('Lead', 11, 400)
  if (dot) w += 8 + 6
  return Math.ceil(w)
}

/** The "+N" chip: up to three faces, the count, and a dot when some are at work. */
export function chipWidth(hidden: number): number {
  const faces = Math.min(3, hidden)
  return Math.ceil(6 + 16 + (faces - 1) * 16 * 0.72 + 6 + textWidth(`+${hidden}`, 12.5) + 6 + 6 + 10)
}

const GAP = 4

/**
 * Picks the tabs to show in `width` pixels. Order of claim: the lead, the agent being viewed,
 * anyone waiting for you, anyone at work, the other accounts, then the rest. Shown tabs keep
 * the team's order.
 */
export function fitTabs(
  team: Account[],
  width: number,
  o: { leadId?: string; focusId?: string; phases: Map<string, AgentPhase>; dots: Set<string> },
): { shown: Account[]; hidden: Account[] } {
  if (width <= 0) return { shown: team.slice(0, 1), hidden: team.slice(1) }
  const busy = (a: Account): boolean => {
    const p = o.phases.get(a.id)
    return !!p && p !== 'idle' && p !== 'error'
  }
  const rank = (a: Account): number =>
    a.id === o.leadId ? 0 : a.id === o.focusId ? 1 : o.phases.get(a.id) === 'waiting' ? 2 : busy(a) ? 3 : !a.spawned ? 4 : a.spawned.gone ? 6 : 5
  const order = team
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a)
  const keep = new Set<string>()
  let used = 0
  for (const a of order) {
    const w = tabWidth(a, a.id === o.leadId, o.dots.has(a.id) && a.id !== o.focusId)
    const left = team.length - keep.size - 1
    const need = used + (keep.size ? GAP : 0) + w + (left > 0 ? GAP + chipWidth(left) : 0)
    // The lead and the agent being viewed always get a tab; the rest only while there is room.
    if (need <= width || rank(a) <= 1) {
      keep.add(a.id)
      used += (keep.size > 1 ? GAP : 0) + w
    }
  }
  return { shown: team.filter((a) => keep.has(a.id)), hidden: team.filter((a) => !keep.has(a.id)) }
}

/**
 * The width of an element, measured again whenever it changes. A callback ref, so it also
 * works for an element that appears after the first render.
 */
export function useMeasured<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, w]
}
