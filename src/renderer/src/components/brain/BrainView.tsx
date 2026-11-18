// The brain view: what a chat looks like while Ultra goes crazy on a goal. The whole team is drawn
// as a brain: the lead at the centre with the goal around it as a ring of rounds, and around the
// lead its regions, each a softly tinted lobe of the agents doing one kind of work, helpers
// nested inside down to the deepest level. Hand-offs pulse along the fibres, regions that talk
// to each other are joined by faint bridges, new agents grow out of whoever started them and
// finished ones settle and dim. Above it the goal and the last check; below it, one calm line.

import './styles'
import '../ultra/neural/styles'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Brain, ChevronDown, Pause, Play, Plus, Square, Target } from 'lucide-react'
import type { AccentKey, Account, Goal } from '@shared/types'
import { formatValue, type ChartBlock } from '@shared/iui'
import { goalLine, span } from '@shared/auto'
import { useStore } from '@/store'
import { ACCENT, api, cn } from '@/lib/util'
import { Button, IconButton, Tip } from '../ui'
import { MetMark } from '../auto/shared'
import { Comet, NeuronCard, WORD, useDark, useNeural } from '../ultra/neural/Neural'
import { textWidth } from '../ultra/fit'
import type { Neuron, NeuronState } from '../ultra/neural/layout'
import { FOLD, arc, bridge, condense, layoutBrain, regionsOf, type BrainLayout, type Fold, type Region } from './model'
import { useActivity, useLaterals, useRubricChart, type BrainMode } from './hooks'

const EASE = [0.22, 1, 0.36, 1] as const
const FOLD_KEY = 'ensemble.brain.folded'

function useSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    if (!el) return
    const read = (): void => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, size]
}

const tone = (k: AccentKey, dark: boolean): string => (dark ? ACCENT[k].from : ACCENT[k].to)

// ───────────── the goal at the centre ─────────────

type Outcome = 'active' | 'checking' | 'paused' | 'blocked' | 'met' | 'stopped'

function outcomeOf(g: Goal): Outcome {
  if (g.status === 'active') return g.checking ? 'checking' : 'active'
  return g.status
}

/** The rounds as a ring around the lead: one arc per round, the one under way alive. */
function GoalRing({ goal, x, y, r, uid }: { goal: Goal; x: number; y: number; r: number; uid: string }) {
  const o = outcomeOf(goal)
  const max = Math.max(1, goal.maxRounds)
  const at = Math.min(goal.round, max - 1)
  const R = r + 10
  const fresh = o === 'met' && !!goal.endedAt && Date.now() - goal.endedAt < 15_000
  // Met: one closed ring, whatever round it took. Otherwise one arc per round while they fit.
  const segs = max <= 30 && o !== 'met'
  const gap = segs ? Math.min(0.2, (Math.PI * 2) / max / 3.2) : 0
  const start = -Math.PI / 2
  const seg = (Math.PI * 2) / max
  const pt = (a: number, rr = R): string => `${(x + Math.cos(a) * rr).toFixed(1)} ${(y + Math.sin(a) * rr).toFixed(1)}`
  const arcD = (a0: number, a1: number): string => `M ${pt(a0)} A ${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1)}`
  const colour = (i: number): { stroke: string; op: number; live?: boolean } => {
    // Met: the whole ring closes in green, whatever round it took.
    if (o === 'met') return { stroke: 'var(--ok)', op: 1 }
    if (i < at) return { stroke: o === 'stopped' ? 'var(--ink-3)' : 'var(--ink-2)', op: o === 'stopped' ? 0.7 : 1 }
    if (i > at) return { stroke: 'var(--ink-3)', op: 0.45 }
    if (o === 'blocked') return { stroke: 'var(--warn)', op: 1, live: true }
    if (o === 'stopped') return { stroke: 'var(--ink-3)', op: 0.6 }
    if (o === 'paused') return { stroke: 'var(--ink-2)', op: 0.9 }
    return { stroke: 'var(--ux-2)', op: 1, live: true }
  }
  const words: Record<Outcome, { t: string; cls: string }> = {
    active: { t: goal.round ? `Round ${goal.round + 1} of ${max}` : `Round 1 of ${max}`, cls: 'fill-ink' },
    checking: { t: 'Checking the work', cls: 'fill-ink' },
    paused: { t: 'Paused', cls: 'fill-ink-2' },
    blocked: { t: 'Needs you', cls: '' },
    met: { t: 'Goal met', cls: '' },
    stopped: { t: 'Stopped', cls: 'fill-ink-2' },
  }
  const sub =
    o === 'met'
      ? `${goal.round + 1} ${goal.round ? 'rounds' : 'round'}${goal.endedAt ? ` · ${span(goal.endedAt - goal.createdAt)}` : ''}`
      : o === 'stopped'
        ? `Not met after ${goal.round + 1} ${goal.round ? 'rounds' : 'round'}`
        : o === 'checking'
          ? `Round ${goal.round + 1} of ${max}`
          : ''
  return (
    <g className="pointer-events-none">
      {/* A soft disc of the panel's own colour, so fibres stop short of the goal. */}
      <circle cx={x} cy={y} r={R + 7} style={{ fill: 'var(--nn-bg)' }} opacity={0.92} />
      {o === 'blocked' && <circle className="bn-breathe" cx={x} cy={y} r={R + 6} fill="none" strokeWidth={7} strokeOpacity={0.28} style={{ stroke: 'var(--warn)' }} />}
      {o === 'met' && <circle cx={x} cy={y} r={R + 5} fill="none" strokeWidth={8} strokeOpacity={0.16} style={{ stroke: 'var(--ok)' }} />}
      {fresh && <circle className="bn-ripple" cx={x} cy={y} r={R} fill="none" strokeWidth={2} style={{ stroke: 'var(--ok)' }} />}
      {segs && (o === 'active' || o === 'checking') && (
        <path
          className="bn-breathe"
          d={arcD(start + at * seg + gap / 2, start + (at + 1) * seg - gap / 2)}
          fill="none"
          strokeWidth={9}
          strokeLinecap="round"
          strokeOpacity={0.18}
          style={{ stroke: 'var(--ux-2)' }}
        />
      )}
      {segs ? (
        Array.from({ length: max }, (_, i) => {
          const c = colour(i)
          const d = max === 1 ? `M ${pt(start)} A ${R} ${R} 0 1 1 ${pt(start - 0.001)}` : arcD(start + i * seg + gap / 2, start + (i + 1) * seg - gap / 2)
          return <path key={i} d={d} fill="none" strokeWidth={i === at && c.live ? 3.6 : 3}
 strokeLinecap="round" strokeOpacity={c.op} className={c.live ? 'bn-breathe' : undefined} style={{ stroke: c.stroke }} />
        })
      ) : (
        <>
          <circle cx={x} cy={y} r={R} fill="none" strokeWidth={3} strokeOpacity={o === 'met' ? 1 : 0.4} style={{ stroke: o === 'met' ? 'var(--ok)' : 'var(--ink-3)' }} />
          {o !== 'met' && <path d={arcD(start, start + Math.max(0.05, ((at + 0.5) / max) * Math.PI * 2 - 0.001))} fill="none" strokeWidth={3} strokeLinecap="round" style={{ stroke: `url(#${uid}-ux)` }} />}
        </>
      )}
      {/* While the check runs, a point of light goes round the ring. */}
      {o === 'checking' && (
        <g className="bn-orbit" style={{ transformOrigin: `${x}px ${y}px` }}>
          <circle cx={x} cy={y - R} r={6} opacity={0.22} style={{ fill: 'var(--ux-2)' }} />
          <circle cx={x} cy={y - R} r={2.8} style={{ fill: 'var(--ux-2)' }} />
        </g>
      )}
      <text x={x} y={y + R + 19} textAnchor="middle" className={cn('tabular font-semibold', words[o].cls)} style={{ fontSize: 12.5, letterSpacing: '-0.005em', paintOrder: 'stroke', stroke: 'var(--nn-bg)', strokeWidth: 4, fill: o === 'met' ? 'var(--ok)' : o === 'blocked' ? 'var(--warn)' : undefined }}>
        {words[o].t}
      </text>
      {sub && (
        <text x={x} y={y + R + 34} textAnchor="middle" className="tabular fill-ink-3" style={{ fontSize: 11, paintOrder: 'stroke', stroke: 'var(--nn-bg)', strokeWidth: 4 }}>
          {sub}
        </text>
      )}
    </g>
  )
}

/** A check on the lead once the goal is met. */
function MetBadge({ x, y, r }: { x: number; y: number; r: number }) {
  const b = 8
  const bx = x + r * 0.78
  const by = y + r * 0.78
  return (
    <g className="bn-pop pointer-events-none">
      <circle cx={bx} cy={by} r={b + 2} style={{ fill: 'var(--nn-bg)' }} />
      <circle cx={bx} cy={by} r={b} style={{ fill: 'var(--ok)' }} />
      <path d={`M ${bx - 3.4} ${by + 0.2} L ${bx - 1} ${by + 2.6} L ${bx + 3.6} ${by - 2.4}`} fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}

// ───────────── the brain itself ─────────────

interface Pulse {
  id: string
  d: string
  dir: 'out' | 'back'
  color: string
}

const DIM: Partial<Record<NeuronState, number>> = { done: 0.7, gone: 0.5, idle: 0.85 }

/**
 * One agent, drawn calmly enough that forty of them read at once: solid and softly lit while it
 * works, hollow while it waits, smaller and quieter once done, a faint point once sent home.
 * The same states as the Team tab's network, without its spinners.
 */
function BrainGlyph({ n, r, st, dark, lead }: { n: Neuron; r: number; st: NeuronState; dark: boolean; lead?: boolean }) {
  const k = n.account.accent || 'slate'
  const ring = dark ? ACCENT[k].from : ACCENT[k].to
  const core = `url(#nn-core-${k})`
  if (st === 'gone') return <circle r={r * 0.62} fill={core} opacity={0.4} />
  if (st === 'waiting')
    return (
      <>
        <circle r={r * 0.92} strokeWidth={1.5} style={{ fill: 'var(--nn-bg)', stroke: ring }} />
        <circle r={Math.max(1.4, r * 0.3)} fill={ring} opacity={0.8} />
      </>
    )
  const big = st === 'working' || st === 'asking'
  const rr = lead ? r : big ? r : st === 'done' ? r * 0.8 : r * 0.86
  return (
    <>
      {/* The lead's activity is the ring of rounds around it, so it needs no halo of its own. */}
      {big && !lead && <circle className="bn-breathe" r={rr * 2.3} fill={`url(#nn-halo-${k})`} />}
      {st === 'asking' && <circle className="bn-breathe" r={rr + 4.5} fill="none" strokeWidth={1.5} style={{ stroke: 'var(--warn)' }} />}
      <circle r={rr} fill={core} opacity={st === 'idle' ? 0.55 : st === 'done' && !lead ? 0.7 : 1} />
      {rr > 4.5 && <ellipse cx={-rr * 0.28} cy={-rr * 0.42} rx={rr * 0.46} ry={rr * 0.27} fill="#fff" opacity={big || lead ? 0.55 : 0.25} />}
      {st === 'trouble' && <circle r={rr + 3} fill="none" strokeWidth={1.5} style={{ stroke: 'var(--bad)' }} />}
    </>
  )
}

/** "12 more at level 5, mostly under Builder A, 5 working" */
function foldWords(f: Fold, by: string | undefined, states: Map<string, NeuronState>): string {
  const busy = f.ids.filter((id) => states.get(id) === 'working' || states.get(id) === 'asking').length
  const levels = f.from === f.to ? `level ${f.from}` : `levels ${f.from} to ${f.to}`
  return `${f.ids.length} more at ${levels}${by ? `, mostly under ${by}` : ''}${busy ? `, ${busy} working` : ''}`
}

/** Helpers folded into one mark: a ring with their count, lit while any of them works. */
function FoldGlyph({ f, r, st, color }: { f: Fold; r: number; st: NeuronState; color: string }) {
  const live = st === 'working' || st === 'asking'
  const label = f.ids.length > 99 ? '99+' : `+${f.ids.length}`
  return (
    <>
      {live && <circle className="bn-breathe" r={r + 4} fill="none" strokeWidth={3} strokeOpacity={0.22} style={{ stroke: color }} />}
      <circle r={r} strokeWidth={1.3} strokeDasharray={live ? undefined : '2.2 1.8'} style={{ fill: 'var(--nn-bg)', stroke: color }} />
      <text y={3.4} textAnchor="middle" className="tabular font-semibold" style={{ fontSize: label.length > 2 ? 8.5 : 9.5, fill: color }}>
        {label}
      </text>
    </>
  )
}

export const BrainCanvas = memo(function BrainCanvas({ chatId, goal, onOpen, className }: { chatId: string; goal: Goal; onOpen?(id: string): void; className?: string }) {
  const [ref, size] = useSize()
  const { net: full, states: raw, tasks, ultra } = useNeural(chatId)
  const dark = useDark()
  const uid = useMemo(() => `bn${Math.random().toString(36).slice(2, 7)}`, [])
  const allRegions = useMemo(() => regionsOf(full), [full])
  const fullOf = useMemo(() => new Map(allRegions.map((r) => [r.key, r])), [allRegions])
  // Draw only what the panel can hold: past that, helpers fold into a count on their nearest drawn ancestor.
  const budget = size.w > 0 && size.h > 0 ? Math.max(30, Math.min(80, Math.floor((size.w * size.h) / 4200))) : 80
  const { net, regions, folds } = useMemo(() => condense(full, allRegions, budget), [full, allRegions, budget])
  // Which drawn mark stands for each agent: itself, or the fold it is in.
  const shownOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of folds.values()) for (const id of f.ids) m.set(id, f.id)
    return (id: string): string => m.get(id) ?? id
  }, [folds])
  // A fold works while anyone in it works, waits while anyone waits, and is done once all are.
  const states = useMemo(() => {
    if (!folds.size) return raw
    const out = new Map(raw)
    for (const f of folds.values()) {
      const all = f.ids.map((id) => raw.get(id) || 'idle')
      const st: NeuronState = all.some((x) => x === 'working' || x === 'asking') ? 'working' : all.some((x) => x === 'trouble') ? 'trouble' : all.some((x) => x === 'waiting') ? 'waiting' : all.every((x) => x === 'done' || x === 'gone') ? (all.every((x) => x === 'gone') ? 'gone' : 'done') : 'idle'
      out.set(f.id, st)
    }
    return out
  }, [raw, folds])
  const regionOf = useMemo(() => {
    const m = new Map<string, Region>()
    for (const r of regions) for (const id of r.ids) m.set(id, r)
    return m
  }, [regions])
  const leadR = net.neurons.length > 30 ? 17 : net.neurons.length > 14 ? 19 : 21
  const layout: BrainLayout = useMemo(
    () => layoutBrain(net, regions, { width: size.w, height: size.h, top: 6, bottom: 8, core: leadR + 62 }),
    [net, regions, size.w, size.h, leadR],
  )
  const { pos, lobes, centre } = layout
  const leadId = net.neurons.find((n) => n.lead)?.id
  // Each agent wears its region's colour, so a lobe reads as one thing; the lead keeps its own.
  const tinted = useMemo(
    () => net.neurons.map((n): Neuron => (n.lead || !regionOf.get(n.id) ? n : { ...n, account: { ...n.account, accent: regionOf.get(n.id)?.tone ?? n.account.accent } })),
    [net.neurons, regionOf],
  )
  const byId = useMemo(() => new Map(tinted.map((n) => [n.id, n])), [tinted])
  const memberIds = useMemo(() => full.neurons.map((n) => n.id), [full.neurons])
  const rawLaterals = useLaterals(chatId, memberIds)
  const laterals = useMemo(() => rawLaterals.map((m) => ({ ...m, from: shownOf(m.from), to: shownOf(m.to) })).filter((m) => m.from !== m.to), [rawLaterals, shownOf])

  // New agents grow out of whoever started them: drawn first where their parent is, then they glide out.
  const known = useRef<Set<string> | null>(null)
  const arriving = useRef(new Map<string, { x: number; y: number }>())
  const [released, setReleased] = useState(0)
  useMemo(() => {
    if (!pos.size) return
    if (!known.current) {
      known.current = new Set(pos.keys())
      return
    }
    for (const [id] of pos) {
      if (known.current.has(id)) continue
      known.current.add(id)
      const p = byId.get(id)?.parent
      const from = (p && pos.get(p)) || centre
      arriving.current.set(id, { x: from.x, y: from.y })
    }
  }, [pos, byId, centre])
  useEffect(() => {
    if (!arriving.current.size) return
    const ids = [...arriving.current.keys()]
    let r2 = 0
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        for (const id of ids) arriving.current.delete(id)
        setReleased((n) => n + 1)
      })
    })
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
    }
  })
  const growing = useRef(new Map<string, number>())
  useEffect(() => {
    for (const id of arriving.current.keys()) {
      if (growing.current.has(id)) continue
      growing.current.set(id, window.setTimeout(() => growing.current.delete(id), 1200))
    }
  }, [released, pos])
  const at = (id: string): { x: number; y: number; r: number } | undefined => {
    const p = pos.get(id)
    const a = arriving.current.get(id)
    return p && a ? { ...p, x: a.x, y: a.y } : p
  }

  // The fibre from whoever started an agent to the agent. The lead's leave from the edge of the goal.
  const ringOut = leadR + 17
  const fibre = useCallback(
    (from: string, to: string): string | null => {
      const a = pos.get(from)
      const b = pos.get(to)
      if (!a || !b) return null
      if (from === leadId) {
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 1
        return arc({ x: a.x + (dx / d) * ringOut, y: a.y + (dy / d) * ringOut }, b, 0.1)
      }
      return arc(a, b, 0.16)
    },
    [pos, leadId, ringOut],
  )
  const links = useMemo(() => new Map(net.links.map((l) => [l.key, l])), [net.links])

  // Bridges: work and messages that cross from one region to another, one soft bridge per pair.
  const bridges = useMemo(() => {
    const pairs = new Map<string, { a: string; b: string; n: number; live: boolean }>()
    const add = (x: string, y: string, live: boolean): void => {
      const A = regionOf.get(x)
      const B = regionOf.get(y)
      if (!A || !B || A.key === B.key) return
      const [a, b] = A.key < B.key ? [A.key, B.key] : [B.key, A.key]
      const k = `${a}|${b}`
      const e = pairs.get(k) || { a, b, n: 0, live: false }
      e.n++
      e.live = e.live || live
      pairs.set(k, e)
    }
    for (const l of net.links) {
      const child = byId.get(l.to)
      if (child?.parent === l.from) continue
      add(l.from, l.to, l.live > 0)
    }
    const recent = Date.now() - 20_000
    for (const m of laterals) add(m.from, m.to, m.ts > recent)
    const out: { key: string; d: string; n: number; live: boolean }[] = []
    for (const [k, e] of pairs) {
      const A = lobes.get(e.a)
      const B = lobes.get(e.b)
      if (!A || !B) continue
      const dx = B.cx - A.cx
      const dy = B.cy - A.cy
      const d = Math.hypot(dx, dy) || 1
      const ra = Math.min(d * 0.3, 26)
      out.push({ key: k, d: bridge({ x: A.cx + (dx / d) * ra, y: A.cy + (dy / d) * ra }, { x: B.cx - (dx / d) * ra, y: B.cy - (dy / d) * ra }, centre, 0.16), n: e.n, live: e.live })
    }
    return out
  }, [net.links, laterals, regionOf, lobes, byId, centre])

  // Direct messages between agents of different regions: their own faint fibre, the last few only.
  const messages = useMemo(() => {
    const seen = new Set<string>()
    const out: { key: string; d: string }[] = []
    for (const m of [...laterals].reverse()) {
      const a = pos.get(m.from)
      const b = pos.get(m.to)
      const A = regionOf.get(m.from)
      const B = regionOf.get(m.to)
      if (!a || !b || !A || !B || A.key === B.key) continue
      const k = [m.from, m.to].sort().join('~')
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ key: k, d: bridge(a, b, centre, 0.16) })
      if (out.length >= 10) break
    }
    return out
  }, [laterals, pos, regionOf, centre])

  // Work going out and reports coming back run along the fibres as pulses; so do messages.
  const [pulses, setPulses] = useState<Pulse[]>([])
  const prev = useRef<Map<string, string> | null>(null)
  const pathFor = useCallback(
    (from: string, to: string): string | null => {
      if (byId.get(to)?.parent === from) return fibre(from, to)
      const a = pos.get(from)
      const b = pos.get(to)
      return a && b ? bridge(a, b, centre, 0.16) : null
    },
    [byId, fibre, pos, centre],
  )
  useEffect(() => {
    const before = prev.current
    prev.current = new Map(tasks.map((t) => [t.id, t.status]))
    if (!before) return
    const add: Pulse[] = []
    for (const t of tasks) {
      const was = before.get(t.id)
      if (was === t.status || t.from === t.to || arriving.current.has(t.to)) continue
      const out = !was || (was === 'queued' && t.status === 'running')
      const back = t.status === 'done' || t.status === 'failed'
      if (!out && !back) continue
      const d = pathFor(shownOf(t.from), shownOf(t.to))
      if (d) add.push({ id: `${t.id}:${t.status}`, d, dir: out ? 'out' : 'back', color: t.status === 'failed' ? 'var(--bad)' : `url(#${uid}-ux)` })
    }
    if (!add.length) return
    setPulses((p) => [...p.slice(-30), ...add])
    const tm = setTimeout(() => setPulses((p) => p.filter((x) => !add.includes(x))), 1300)
    return () => clearTimeout(tm)
  }, [tasks, pathFor, uid, shownOf])
  const lastMsg = useRef<number | null>(null)
  useEffect(() => {
    const newest = laterals.length ? laterals[laterals.length - 1].ts : 0
    if (lastMsg.current === null) {
      lastMsg.current = newest
      return
    }
    const fresh = laterals.filter((m) => m.ts > (lastMsg.current as number))
    lastMsg.current = Math.max(lastMsg.current, newest)
    const add: Pulse[] = []
    for (const m of fresh) {
      const d = pathFor(m.from, m.to)
      if (d) add.push({ id: `m:${m.from}>${m.to}@${m.ts}`, d, dir: 'out', color: 'var(--ux-3)' })
    }
    if (!add.length) return
    setPulses((p) => [...p.slice(-30), ...add])
    const tm = setTimeout(() => setPulses((p) => p.filter((x) => !add.includes(x))), 1300)
    return () => clearTimeout(tm)
  }, [laterals, pathFor])

  // Pointing at an agent: it and whoever it works with stay bright, the rest step back.
  const [focus, setFocus] = useState<string | null>(null)
  const near = useMemo(() => {
    if (!focus) return null
    const s = new Set([focus])
    for (const l of net.links) {
      if (l.from === focus) s.add(l.to)
      if (l.to === focus) s.add(l.from)
    }
    const n = byId.get(focus)
    if (n?.parent) s.add(n.parent)
    for (const m of tinted) if (m.parent === focus) s.add(m.id)
    return s
  }, [focus, net.links, byId, tinted])

  const w = size.w
  const h = size.h
  // Where each region's name goes: the side away from the goal unless that runs off the panel or
  // into another region (or a name already placed), then the other side, then the clearer of the two.
  const labels = useMemo(() => {
    type R = { l: number; t: number; r: number; b: number }
    const hit = (a: R, b: R): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
    const placed: R[] = []
    const out: { r: Region; x: number; y: number }[] = []
    const core: R = { l: centre.x - leadR - 44, t: centre.y - leadR - 14, r: centre.x + leadR + 44, b: centre.y + leadR + 50 }
    for (const r of regions) {
      const lobe = lobes.get(r.key)
      if (!lobe) continue
      const words = `${r.label}  ${r.ids.length > 9 ? '10 of 10 working' : '1 of 9 working'}`
      const tw = textWidth(words, 11.5) + 8
      const tries = (lobe.prefer === 'above' ? [lobe.above, lobe.below] : [lobe.below, lobe.above]).map((p) => {
        const x = Math.min(w - tw / 2 - 6, Math.max(tw / 2 + 6, p.x))
        const box: R = { l: x - tw / 2, t: p.y - 12, r: x + tw / 2, b: p.y + 3 }
        let cost = 0
        if (box.t < 0 || box.b > h) cost += 100
        for (const [k, other] of lobes) if (k !== r.key && hit(box, other.box)) cost += 10
        if (hit(box, core)) cost += 20
        for (const q of placed) if (hit(box, q)) cost += 50
        return { x, y: Math.min(h - 4, Math.max(13, p.y)), box, cost }
      })
      const best = tries[0].cost <= tries[1].cost ? tries[0] : tries[1]
      placed.push(best.box)
      out.push({ r, x: best.x, y: best.y })
    }
    return out
  }, [regions, lobes, centre, leadR, w, h])

  // Names, where they fit: only while the team is small enough to read them all at a glance.
  const names = useMemo(() => {
    const out = new Set<string>()
    if (net.neurons.length > 18) return out
    type R = { l: number; t: number; r: number; b: number }
    const hit = (a: R, b: R): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
    const taken: R[] = []
    for (const n of tinted) {
      const p = pos.get(n.id)
      if (p) taken.push({ l: p.x - p.r - 4, t: p.y - p.r - 4, r: p.x + p.r + 4, b: p.y + p.r + 4 })
    }
    for (const l of labels) {
      const tw = textWidth(l.r.label, 11.5) + 70
      taken.push({ l: l.x - tw / 2, t: l.y - 13, r: l.x + tw / 2, b: l.y + 4 })
    }
    taken.push({ l: centre.x - leadR - 40, t: centre.y - leadR - 14, r: centre.x + leadR + 40, b: centre.y + leadR + 52 })
    for (const n of tinted) {
      // Not the lead, not a region of one, not the agent heading a region: the region's name says those.
      if (n.lead || folds.has(n.id) || n.parent === leadId || (regionOf.get(n.id)?.ids.length ?? 0) <= 1) continue
      const p = pos.get(n.id)
      if (!p) continue
      const w = n.account.name.length * 6 + 6
      const r: R = { l: p.x - w / 2, t: p.y + p.r * 1.3 + 2, r: p.x + w / 2, b: p.y + p.r * 1.3 + 15 }
      if (r.l < 4 || r.r > size.w - 4 || r.b > size.h) continue
      if (taken.some((k) => hit(k, r) && !(k.l === p.x - p.r - 4 && k.t === p.y - p.r - 4))) continue
      taken.push(r)
      out.add(n.id)
    }
    return out
  }, [tinted, pos, centre, leadR, size.w, size.h, net.neurons.length, regionOf, labels, leadId, folds])

  const accents = useMemo(() => [...new Set(tinted.map((n) => n.account.accent || 'slate'))], [tinted])
  const tones = useMemo(() => [...new Set(regions.map((r) => r.tone))], [regions])
  const open = useCallback((id: string) => onOpen?.(id), [onOpen])
  const onKey = (e: KeyboardEvent, id: string): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open(id)
    }
  }
  const working = (id: string): boolean => {
    const s = states.get(id)
    return s === 'working' || s === 'asking'
  }
  const o = outcomeOf(goal)
  const focused = focus ? byId.get(focus) : undefined
  const fp = focus ? pos.get(focus) : undefined

  return (
    <div
      ref={ref}
      className={cn('relative h-full w-full select-none', className)}
      style={{ ['--nn-bg' as string]: 'var(--surface)', ['--nn-active' as string]: ultra ? `url(#${uid}-ux)` : 'var(--ink-2)' }}
      data-nn-focus={focus ? '' : undefined}
      onMouseLeave={() => setFocus(null)}
    >
      {w > 0 && h > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 overflow-visible" role="group" aria-label="The team as a brain, grouped by the work each part does">
          <defs>
            <linearGradient id={`${uid}-ux`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={w} y2={h}>
              <stop offset="0" style={{ stopColor: 'var(--ux-1)' }} />
              <stop offset="0.5" style={{ stopColor: 'var(--ux-2)' }} />
              <stop offset="1" style={{ stopColor: 'var(--ux-3)' }} />
            </linearGradient>
            {tones.map((k) => (
              <radialGradient key={k} id={`${uid}-cloud-${k}`}>
                <stop offset="0" stopColor={tone(k, dark)} stopOpacity={dark ? 0.2 : 0.15} />
                <stop offset="0.55" stopColor={tone(k, dark)} stopOpacity={dark ? 0.1 : 0.075} />
                <stop offset="1" stopColor={tone(k, dark)} stopOpacity={0} />
              </radialGradient>
            ))}
            {accents.map((k) => {
              const a = ACCENT[k]
              return (
                <g key={k}>
                  <radialGradient id={`nn-core-${k}`} cx="0.32" cy="0.25" r="0.85">
                    <stop offset="0" stopColor={a.from} />
                    <stop offset="0.62" stopColor={a.to} />
                    <stop offset="1" stopColor={a.to} stopOpacity={0.92} />
                  </radialGradient>
                  <radialGradient id={`nn-halo-${k}`}>
                    <stop offset="0" stopColor={dark ? a.from : a.to} stopOpacity={dark ? 0.5 : 0.38} />
                    <stop offset="1" stopColor={dark ? a.from : a.to} stopOpacity={0} />
                  </radialGradient>
                </g>
              )
            })}
          </defs>

          {/* The lobes: a soft cloud of the region's colour around each member, denser where they
              crowd together, a little brighter while the region works. */}
          {regions.map((r) => {
            const busy = r.ids.filter(working).length
            const settled = r.ids.every((id) => {
              const s = states.get(id)
              return s === 'done' || s === 'gone'
            })
            const level = o === 'met' ? 0.5 : busy ? 1 : settled ? 0.45 : 0.75
            const cloud = layout.step * 1.25
            return (
              <g key={r.key} className="bn-fade" opacity={level}>
                {r.ids.map((id) => {
                  const p = at(id)
                  if (!p) return null
                  return <circle key={id} className="nn-node" style={{ transform: `translate(${p.x}px, ${p.y}px)` }} r={cloud + p.r} fill={`url(#${uid}-cloud-${r.tone})`} />
                })}
              </g>
            )
          })}

          {/* Bridges between regions that hand each other work or talk directly. */}
          {bridges.map((b) => (
            <g key={b.key} className="nn-link">
              <path className="bn-path" d={b.d} style={{ d: `path('${b.d}')`, stroke: 'var(--ink)' }} fill="none" strokeWidth={1 + Math.min(2.4, Math.sqrt(b.n) * 0.55)} strokeLinecap="round" opacity={b.live ? 0.13 : 0.07} />
              {b.live && <path className="bn-drift" d={b.d} pathLength={100} fill="none" strokeWidth={1.2} strokeDasharray="1.5 6.5" strokeLinecap="round" opacity={0.45} style={{ stroke: 'var(--ink-3)' }} />}
            </g>
          ))}
          {messages.map((m) => (
            <path key={m.key} className="nn-link bn-path" d={m.d} style={{ d: `path('${m.d}')`, stroke: 'var(--ux-3)' }} fill="none" strokeWidth={0.9} strokeDasharray="2 3.5" strokeLinecap="round" opacity={0.42} />
          ))}

          {/* Fibres: from whoever started each agent to the agent. */}
          {tinted.map((n) => {
            if (!n.parent || !pos.has(n.id) || !pos.has(n.parent)) return null
            const d = fibre(n.parent, n.id)
            if (!d) return null
            const l = links.get(`handoff:${n.parent}>${n.id}`)
            const live = !!l && l.live > 0
            const isNear = !!near && (near.has(n.id) && (focus === n.id || focus === n.parent))
            const col = n.parent === leadId && live ? `url(#${uid}-ux)` : tone((n.account.accent || 'slate') as AccentKey, dark)
            const grow = growing.current.has(n.id) || arriving.current.has(n.id)
            const width = n.parent === leadId ? (live ? 1.6 : 1.15) : live ? 1.3 : 0.9
            const st = states.get(n.id)
            const op = live ? 0.85 : st === 'gone' ? 0.16 : st === 'done' ? 0.3 : n.parent === leadId ? 0.34 : 0.4
            return (
              <g key={`f:${n.id}`} className="nn-link" data-near={isNear ? '' : undefined}>
                {live && !grow && <path d={d} fill="none" strokeWidth={width * 3.2} strokeOpacity={0.1} strokeLinecap="round" style={{ d: `path('${d}')`, stroke: col }} className="bn-path" />}
                <path
                  className={cn('bn-path', grow && 'nn-grow')}
                  d={d}
                  pathLength={grow ? 100 : undefined}
                  strokeDasharray={grow ? '100 100' : undefined}
                  fill="none"
                  strokeWidth={isNear ? width + 0.8 : width}
                  strokeOpacity={isNear ? Math.max(op, 0.85) : op}
                  strokeLinecap="round"
                  style={{ d: `path('${d}')`, stroke: col }}
                />
                {live && !grow && n.parent === leadId && <Comet d={d} stroke={col} width={width} />}
              </g>
            )
          })}

          {pulses.map((p) => (
            <g key={p.id} className="pointer-events-none">
              <path className={p.dir === 'out' ? 'nn-out' : 'nn-back'} d={p.d} pathLength={100} fill="none" strokeWidth={8} strokeOpacity={0.2} strokeLinecap="round" strokeDasharray="12 88" style={{ stroke: p.color }} />
              <path className={p.dir === 'out' ? 'nn-out' : 'nn-back'} d={p.d} pathLength={100} fill="none" strokeWidth={2.6} strokeLinecap="round" strokeDasharray="7 93" style={{ stroke: p.color }} />
            </g>
          ))}

          {/* Before anyone else joins: one quiet line where the regions will form. */}
          {!regions.length && o !== 'met' && o !== 'stopped' && (
            <text x={centre.x} y={centre.y + leadR + 64} textAnchor="middle" className="fill-ink-4" style={{ fontSize: 11.5 }}>
              The team forms around the goal as the lead starts agents
            </text>
          )}
          {/* The goal, around the lead. */}
          {leadId && pos.get(leadId) && <GoalRing goal={goal} x={centre.x} y={centre.y} r={leadR} uid={uid} />}

          {tinted.map((n) => {
            const p = at(n.id)
            if (!p) return null
            const raw = states.get(n.id) || 'idle'
            const st: NeuronState = n.lead && raw === 'idle' ? 'done' : raw
            const isNear = !!near?.has(n.id)
            const by = n.parent ? byId.get(n.parent)?.account.name : undefined
            const born = arriving.current.has(n.id) || growing.current.has(n.id)
            return (
              <g
                key={n.id}
                className="nn-node outline-none"
                style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                opacity={n.lead ? 1 : (DIM[st] ?? 1)}
                data-near={isNear ? '' : undefined}
                tabIndex={0}
                role="button"
                aria-label={folds.has(n.id) ? foldWords(folds.get(n.id) as Fold, byId.get(folds.get(n.id)?.anchor ?? '')?.account.name, states) : `${n.account.name}${n.lead ? ', lead' : ''}: ${WORD[st]}${by ? `, started by ${by}` : ''}${regionOf.get(n.id) ? `, in ${regionOf.get(n.id)?.label}` : ''}`}
                onMouseEnter={() => setFocus(n.id)}
                onFocus={() => setFocus(n.id)}
                onBlur={() => setFocus((f) => (f === n.id ? null : f))}
                onClick={() => open(folds.get(n.id)?.anchor ?? n.id)}
                onKeyDown={(e) => onKey(e, folds.get(n.id)?.anchor ?? n.id)}
                cursor="pointer"
              >
                <circle r={Math.max(p.r + 6, 11)} fill="transparent" />
                <g className={born ? 'bn-pop' : undefined}>
                  {folds.has(n.id) ? (
                    <FoldGlyph f={folds.get(n.id) as Fold} r={p.r} st={st} color={tone((n.account.accent || 'slate') as AccentKey, dark)} />
                  ) : (
                    <BrainGlyph n={n} r={p.r} st={n.lead ? (o === 'met' ? 'done' : st === 'working' || st === 'asking' ? st : 'done') : st} dark={dark} lead={n.lead} />
                  )}
                </g>
                {focus === n.id && <circle r={p.r + 6.5} fill="none" strokeWidth={1.5} strokeOpacity={0.9} style={{ stroke: 'var(--link)' }} />}
              </g>
            )
          })}
          {o === 'met' && leadId && <MetBadge x={centre.x} y={centre.y} r={leadR} />}

          {/* Names, while there are few enough to read. */}
          {[...names].map((id) => {
            const n = byId.get(id)
            const p = at(id)
            if (!n || !p) return null
            const st = states.get(id)
            return (
              <text
                key={`n:${id}`}
                className={cn('nn-node nn-label pointer-events-none', st === 'working' || st === 'asking' ? 'fill-ink-2 font-medium' : 'fill-ink-3')}
                data-near={near?.has(id) ? '' : undefined}
                style={{ transform: `translate(${p.x}px, ${p.y}px)`, fontSize: 10.5, paintOrder: 'stroke', stroke: 'var(--nn-bg)', strokeWidth: 3 }}
                y={p.r * 1.3 + 12}
                textAnchor="middle"
              >
                {n.account.name}
              </text>
            )
          })}

          {/* Each region's name: quiet, just outside its lobe, on whichever side is free. */}
          {labels.map(({ r, x, y }) => {
            const all = fullOf.get(r.key)?.ids ?? r.ids
            const busy = all.filter(working).length
            const settled = !busy && all.every((id) => states.get(id) === 'done' || states.get(id) === 'gone')
            return (
              <text
                key={`l:${r.key}`}
                x={x}
                y={y}
                textAnchor="middle"
                className="bn-fade pointer-events-none font-medium"
                style={{ fontSize: 11.5, letterSpacing: '0.01em', paintOrder: 'stroke', stroke: 'var(--nn-bg)', strokeWidth: 4 }}
              >
                <tspan className={settled ? 'fill-ink-3' : 'fill-ink-2'}>{r.label}</tspan>
                <tspan className="tabular fill-ink-4" dx={5}>
                  {busy ? `${busy} of ${all.length} working` : all.length}
                </tspan>
              </text>
            )
          })}
        </svg>
      )}

      {focused && fp && folds.has(focused.id) && (
        <div className="pointer-events-none absolute z-10 w-[240px] animate-fade-in rounded-[12px] bg-raised px-3 py-2.5 text-[12px] leading-snug shadow-pop" style={{ left: fp.x + 260 > w ? Math.max(4, fp.x - 254) : fp.x + 16, top: Math.min(Math.max(4, fp.y - 24), Math.max(4, h - 90)) }}>
          <div className="text-[13px] font-semibold">{foldWords(folds.get(focused.id) as Fold, byId.get(folds.get(focused.id)?.anchor ?? '')?.account.name, states)}</div>
          <div className="mt-1.5 text-[10.5px] text-ink-4">Click to open {byId.get(folds.get(focused.id)?.anchor ?? '')?.account.name ?? 'whoever started them'}</div>
        </div>
      )}
      {focused && fp && !folds.has(focused.id) && <NeuronCard chatId={chatId} n={focused} st={states.get(focused.id) || 'idle'} x={fp.x} y={fp.y} r={fp.r} w={w} h={h} by={focused.parent ? byId.get(focused.parent)?.account.name : undefined} />}

      {/* For a screen reader: the regions and who is in them. */}
      <ul className="sr-only">
        {regions.map((r) => (
          <li key={r.key}>
            {r.label}: {r.ids.map((id) => `${byId.get(id)?.account.name} (${WORD[states.get(id) || 'idle']})`).join(', ')}
          </li>
        ))}
      </ul>
    </div>
  )
})

// ───────────── the rubric, if the lead charted it ─────────────

function RubricSpark({ chart }: { chart: ChartBlock }) {
  const series = chart.series.slice(0, 3)
  const all = series.flatMap((s) => s.data.filter((v): v is number => typeof v === 'number'))
  if (!all.length) return null
  const W = 112
  const H = 30
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const span = hi - lo || 1
  const n = chart.x.length
  const xs = (i: number): number => (n > 1 ? (i / (n - 1)) * (W - 6) + 3 : W / 2)
  const ys = (v: number): number => H - 4 - ((v - lo) / span) * (H - 8)
  const main = series[0]
  const last = [...main.data].reverse().find((v): v is number => typeof v === 'number')
  const line = (s: (typeof series)[number]): string =>
    s.data
      .map((v, i) => (typeof v === 'number' ? `${xs(i).toFixed(1)} ${ys(v).toFixed(1)}` : null))
      .filter(Boolean)
      .map((p, i) => `${i ? 'L' : 'M'} ${p}`)
      .join(' ')
  return (
    <Tip label={`${chart.title || 'Rubric scores'}, as the lead charted it`} side="bottom">
      <div className="flex h-11 shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
        <div className="leading-tight">
          <div className="text-[10.5px] text-ink-3">{series.length > 1 ? main.name : 'Rubric'}</div>
          <div className="tabular text-[13px] font-semibold">{last !== undefined ? formatValue(last, chart.format || 'number', chart.unit) : '–'}</div>
        </div>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="overflow-visible">
          {series.slice(1).map((s) => (
            <path key={s.name} d={line(s)} fill="none" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--ink-4)' }} />
          ))}
          <path d={line(main)} fill="none" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--ux-2)' }} />
          {main.data.map((v, i) => (typeof v === 'number' ? <circle key={i} cx={xs(i)} cy={ys(v)} r={i === main.data.length - 1 ? 2.6 : 1.6} style={{ fill: 'var(--ux-2)' }} /> : null))}
        </svg>
      </div>
    </Tip>
  )
}

// ───────────── the panel ─────────────

const NO_TEAM: Account[] = []

function ActivityLine({ chatId, goal, team, regionTone }: { chatId: string; goal: Goal; team: Account[]; regionTone(id: string): AccentKey | undefined }) {
  const { now, busy } = useActivity(chatId, team)
  const dark = useDark()
  const o = outcomeOf(goal)
  let key: string
  let body: ReactNode
  if (o === 'checking') {
    key = 'checking'
    body = (
      <>
        <Target className="size-3.5 shrink-0 text-ink-2" strokeWidth={2} />
        <span className="shimmer-text truncate">{goal.check === 'fresh' ? 'A fresh pair of eyes is checking the work against the goal' : 'The lead is checking the work against the goal'}</span>
      </>
    )
  } else if (o === 'met' || o === 'stopped' || o === 'blocked' || o === 'paused') {
    key = `${o}:${goal.note || ''}`
    const text =
      o === 'met'
        ? "Everything the goal asked for is in. The lead's final answer is in the chat below."
        : o === 'blocked'
          ? goal.note || 'The lead needs an answer from you before it can go on.'
          : o === 'paused'
            ? 'Paused. Nothing new starts until you resume.'
            : goal.note || 'Stopped before the goal was met.'
    body = <span className={cn('truncate', o === 'blocked' ? 'text-ink' : 'text-ink-2')}>{text}</span>
  } else if (now) {
    const t = regionTone(now.who.id)
    key = `${now.who.id}:${now.text}`
    body = (
      <>
        <span className="relative flex size-2 shrink-0">
          <span className="bn-breathe absolute inset-0 rounded-full" style={{ background: t ? tone(t, dark) : 'var(--ink-2)', opacity: 0.35, transform: 'scale(1.9)' }} />
          <span className="relative size-2 rounded-full" style={{ background: t ? tone(t, dark) : 'var(--ink-2)' }} />
        </span>
        <span className="shrink-0 font-medium text-ink">{now.who.name}</span>
        <span className="truncate text-ink-2">{now.text}</span>
      </>
    )
  } else {
    key = 'between'
    body = <span className="truncate text-ink-3">{busy ? 'At work' : 'Between rounds: the lead is deciding what comes next'}</span>
  }
  return (
    <div className="flex min-w-0 flex-1 items-center text-[12.5px]" aria-live="polite">
      <div key={key} className="bn-line-in flex min-w-0 items-center gap-2">
        {body}
      </div>
    </div>
  )
}

function Numbers({ chatId }: { chatId: string }) {
  const { team, states, net } = useNeural(chatId)
  const present = team.filter((a) => !a.spawned?.gone).length
  const working = [...states.values()].filter((s) => s === 'working' || s === 'asking').length
  const bits = [`${present} ${present === 1 ? 'agent' : 'agents'}`]
  if (working) bits.push(`${working} working`)
  if (net.depth > 1) bits.push(`${net.depth} levels deep`)
  return <span className="tabular shrink-0 text-[12px] text-ink-3 max-[1000px]:hidden">{bits.join(' · ')}</span>
}

/**
 * The brain view as it sits at the top of a chat. `mode` comes from useBrainMode; the panel
 * fades in when it turns on and out when it turns off.
 */
export function BrainPanel({ chatId, mode, onOpen }: { chatId: string; mode: BrainMode; onOpen?(id: string): void }) {
  const goal = mode.goal
  const run = useStore((s) => s.run)
  const [busy, setBusy] = useState(false)
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLD_KEY) === '1')
  const { team, net, leadId } = useNeural(chatId)
  const regions = useMemo(() => regionsOf(net), [net])
  const toneOf = useMemo(() => {
    const m = new Map<string, AccentKey>()
    for (const r of regions) for (const id of r.ids) m.set(id, r.tone)
    return m
  }, [regions])
  const chart = useRubricChart(chatId, leadId)
  if (!goal) return null
  const o = outcomeOf(goal)
  const act = (p: Promise<unknown>): void => {
    setBusy(true)
    void run(p).then(() => setBusy(false))
  }
  const fold = (): void => {
    setFolded((f) => {
      localStorage.setItem(FOLD_KEY, f ? '0' : '1')
      return !f
    })
  }
  const verdict = goal.note
    ? o === 'met' || o === 'blocked' || o === 'stopped'
      ? goal.note
      : `Last check: ${goal.note}`
    : goal.doneWhen
      ? `Done when ${goal.doneWhen.replace(/^done when\s+/i, '')}`
      : goal.check === 'fresh'
        ? 'Checked after every round by a fresh pair of eyes'
        : 'Checked after every round'
  const state =
    o === 'met' ? (
      <span className="flex items-center gap-1.5 font-semibold text-ok">
        <MetMark goal={goal} size={14} /> Goal met
      </span>
    ) : o === 'blocked' ? (
      <span className="font-semibold text-warn">Needs you</span>
    ) : o === 'stopped' ? (
      <span className="font-medium text-ink-2">Stopped before it was met</span>
    ) : o === 'checking' ? (
      <span className="shimmer-text font-medium">{goalLine(goal)}</span>
    ) : (
      <span className="tabular font-medium text-ink-2">{o === 'paused' ? 'Paused' : `Round ${goal.round + 1} of ${goal.maxRounds}`}</span>
    )
  const frame =
    o === 'met'
      ? 'shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ok)_45%,transparent)]'
      : o === 'blocked'
        ? 'shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_50%,transparent)]'
        : 'ux-ultra-frame'
  return (
    <motion.div
      key="brain"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.45, ease: EASE }}
      className="mx-auto w-full max-w-[1240px] overflow-hidden px-5"
      data-brain-view
    >
      <motion.div
        initial={{ scale: 0.985, y: -4 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE }}
        className={cn('relative mt-1 mb-2 flex flex-col overflow-hidden rounded-[18px] bg-surface transition-shadow duration-500', frame)}
      >
        {/* Depth through light: a soft glow behind the work, nothing drawn that means nothing. */}
        <div
          className="pointer-events-none absolute inset-0 transition-opacity duration-700"
          aria-hidden
          style={{
            opacity: o === 'met' ? 0.6 : 1,
            background:
              o === 'met'
                ? 'radial-gradient(50% 60% at 50% 50%, color-mix(in oklab, var(--ok) 8%, transparent), transparent 70%)'
                : 'radial-gradient(46% 62% at 50% 52%, color-mix(in oklab, var(--ux-2) 7%, transparent), transparent 72%), radial-gradient(30% 50% at 12% 60%, color-mix(in oklab, var(--ux-1) 5%, transparent), transparent 70%), radial-gradient(30% 50% at 88% 40%, color-mix(in oklab, var(--ux-3) 5%, transparent), transparent 70%)',
          }}
        />
        <div className="relative flex items-start gap-3 px-4 pt-3 pb-1">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ink-3">
              <Tip label="Shown while Ultra goes crazy on a goal: every agent, grouped by the work it does, around the goal" side="bottom">
                <span className="flex shrink-0 items-center gap-1.5 font-medium text-ink-2">
                  <Brain className="size-3.5" strokeWidth={1.9} />
                  Brain view
                </span>
              </Tip>
              <span className="text-ink-4">·</span>
              <span className="min-w-0 truncate text-[12px]">{state}</span>
            </div>
            <div className="mt-1 truncate text-[14.5px] leading-[20px] font-semibold tracking-[-0.01em]" title={goal.text}>
              {goal.text}
            </div>
            <div className={cn('mt-0.5 truncate text-[12.5px] leading-[18px]', o === 'blocked' ? 'text-ink' : 'text-ink-2')} title={verdict}>
              {verdict}
            </div>
          </div>
          {chart && !folded && <RubricSpark chart={chart} />}
          <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
            {o === 'blocked' && (
              <Button size="sm" variant="soft" disabled={busy} onClick={() => act(api.goalAction(chatId, 'resume'))}>
                <Play className="size-3" /> Carry on
              </Button>
            )}
            {o === 'stopped' && (
              <Button size="sm" variant="soft" disabled={busy} onClick={() => act(api.goalAction(chatId, goal.round + 1 >= goal.maxRounds ? 'more' : 'resume'))}>
                {goal.round + 1 >= goal.maxRounds ? (
                  <>
                    <Plus className="size-3.5" /> Give it more rounds
                  </>
                ) : (
                  <>
                    <Play className="size-3" /> Pick it up again
                  </>
                )}
              </Button>
            )}
            {mode.ended && (
              <Button size="sm" variant="ghost" onClick={mode.dismiss}>
                Back to the chat
              </Button>
            )}
            {o === 'paused' && (
              <IconButton label="Resume" side="bottom" disabled={busy} onClick={() => act(api.goalAction(chatId, 'resume'))}>
                <Play className="size-3.5" />
              </IconButton>
            )}
            {(o === 'active' || o === 'checking') && (
              <IconButton label="Pause" side="bottom" disabled={busy} onClick={() => act(api.goalAction(chatId, 'pause'))}>
                <Pause className="size-3.5" />
              </IconButton>
            )}
            {!mode.ended && (
              <IconButton label="Stop working on this goal" side="bottom" disabled={busy} onClick={() => act(api.goalAction(chatId, 'stop'))}>
                <Square className="size-3 fill-current" strokeWidth={0} />
              </IconButton>
            )}
            <IconButton label={folded ? 'Show the brain' : 'Fold the brain'} side="bottom" onClick={fold}>
              <ChevronDown className={cn('size-3.5 transition-transform duration-200', !folded && 'rotate-180')} />
            </IconButton>
          </div>
        </div>
        <AnimatePresence initial={false}>
          {!folded && (
            <motion.div
              key="body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.32, ease: EASE }}
              className="relative overflow-hidden"
            >
              <div className="h-[clamp(250px,44vh,500px)]">
                <BrainCanvas chatId={chatId} goal={goal} onOpen={onOpen} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="relative flex h-9 items-center gap-4 border-t border-line/70 px-4">
          <ActivityLine chatId={chatId} goal={goal} team={team.length ? team : NO_TEAM} regionTone={(id) => toneOf.get(id)} />
          <Numbers chatId={chatId} />
        </div>
      </motion.div>
    </motion.div>
  )
}
