// The team as a neural network that forms while it works. Every neuron is a real agent and every
// line a real hand-off: a task from one agent to another, or one task waiting on another's.
// A pulse runs along a line when work goes out and back when the report returns; a neuron
// breathes while its agent works, settles when it is done, and is hollow while it waits.

import './styles'
import '../styles'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Account, AgentState, Task } from '@shared/types'
import { agentKey, isBusy, leadOf, teamOf, useStore } from '@/store'
import { ACCENT, cn, prettyModel } from '@/lib/util'
import { textWidth } from '../fit'
import { plural } from '../groups'
import { buildNeural, layoutNeural, synapse, type Layout, type Link, type Net, type Neuron, type NeuronState, type Shape } from './layout'

const NO_TASKS: Task[] = []
const NO_AGENTS: Account[] = []

export type Variant = 'full' | 'card' | 'strip' | 'mini'

/** True while the window is in its dark look. */
export function useDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

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

const limitedNow = (u: { session?: { status?: string; utilization: number; resetsAt?: number | null }; weekly?: { status?: string; utilization: number; resetsAt?: number | null } } | undefined): boolean =>
  !![u?.session, u?.weekly].find((w) => w && (w.status === 'rejected' || w.utilization >= 1) && (!w.resetsAt || w.resetsAt > Date.now()))

/** Everything the picture is drawn from, read so that it changes only when something drawn changes. */
export function useNeural(chatId: string) {
  const accounts = useStore((s) => s.accounts)
  const agents = useStore((s) => s.chats.find((c) => c.id === chatId)?.agents ?? NO_AGENTS)
  const leadId = useStore((s) => leadOf(s, chatId)?.id)
  const tasks = useStore((s) => s.tasks[chatId] ?? NO_TASKS)
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === chatId)?.ultra)
  // Agents sent home stay in the picture, settled, so a finished stage does not vanish.
  const team = useMemo(() => teamOf(accounts, leadId, agents, true), [accounts, leadId, agents])
  // Who is busy right now, as one string: an account at work belongs in the picture.
  const busySig = useStore((s) => team.filter((a) => !a.spawned && isBusy(s.agents[agentKey(chatId, a.id)])).map((a) => a.id).join('|'))
  // An account appears as a neuron only once work has gone to it, from it, or through it.
  const { members, bench } = useMemo(() => {
    const busy = new Set(busySig.split('|').filter(Boolean))
    const touched = new Set<string>()
    for (const t of tasks) {
      touched.add(t.from)
      touched.add(t.to)
    }
    for (const a of team) if (a.spawned?.by) touched.add(a.spawned.by)
    const out: Account[] = []
    const rest: Account[] = []
    for (const a of team) (a.spawned || a.id === leadId || touched.has(a.id) || busy.has(a.id) ? out : rest).push(a)
    return { members: out, bench: rest }
  }, [team, tasks, leadId, busySig])
  const net = useMemo(() => buildNeural(members, leadId, tasks), [members, leadId, tasks])
  // Each member's phase and whether its sign-in is out of allowance, as one string.
  const sig = useStore((s) =>
    team
      .map((a) => {
        const st = s.agents[agentKey(chatId, a.id)]
        return `${st?.phase || 'idle'}${limitedNow(s.usage[a.spawned?.base || a.id] as never) ? '!' : ''}`
      })
      .join('|'),
  )
  const states = useMemo(() => {
    const parts = sig.split('|')
    const open = new Map<string, number>()
    const waits = new Set<string>()
    const holding = new Set<string>()
    const done = new Set<string>()
    const failed = new Map<string, number>()
    for (const t of tasks) {
      if (t.status === 'running') open.set(t.to, (open.get(t.to) || 0) + 1)
      else if (t.status === 'queued') waits.add(t.to)
      else if (t.status === 'done') done.add(t.to)
      else if (t.status === 'failed') failed.set(t.to, t.finishedAt || 1)
      if (t.holding && t.status === 'running') holding.add(t.to)
    }
    const out = new Map<string, NeuronState>()
    team.forEach((a, i) => {
      const p = parts[i] || 'idle'
      const phase = p.replace(/!$/, '')
      const limited = p.endsWith('!')
      let st: NeuronState
      if (a.spawned?.gone) st = 'gone'
      else if (phase === 'waiting') st = 'asking'
      else if (phase === 'error' || (limited && !isBusy({ phase } as AgentState))) st = 'trouble'
      else if (isBusy({ phase } as AgentState)) st = 'working'
      // Its task is under way but it waits on helpers of its own, or its turn has not come.
      else if (holding.has(a.id) || (waits.has(a.id) && !open.has(a.id))) st = 'waiting'
      else if (failed.has(a.id) && !done.has(a.id)) st = 'trouble'
      else if (done.has(a.id)) st = 'done'
      else st = 'idle'
      out.set(a.id, st)
    })
    return out
  }, [sig, tasks, team])
  return { team, net, tasks, states, ultra, leadId, bench }
}

// ───────────── shapes per size ─────────────

function shapeFor(variant: Variant, count: number, w: number, h: number): Shape & { labels: boolean; groups: boolean; subW: number } {
  const few = count <= 12
  const many = count > 24
  switch (variant) {
    case 'full': {
      const span = Math.max(1, h - 100)
      return {
        width: w,
        height: h,
        padX: Math.max(64, Math.min(110, w * 0.06)),
        padTop: 58,
        padBottom: 42,
        gap: many ? 28 : 34,
        // Short columns spread out over the height they have, instead of huddling in the middle.
        maxGap: Math.max(70, span / (few ? 5 : 8)),
        radius: few ? [24, 14, 11] : many ? [19, 10, 8.5] : [22, 12, 10],
        maxStep: 520,
        subW: 96,
        labels: true,
        groups: true,
      }
    }
    case 'card':
      return { width: w, height: h, padX: 46, padTop: 36, padBottom: 26, gap: 26, maxGap: 56, radius: many ? [13, 7.5, 6.5] : [15, 9, 7.5], maxStep: 320, subW: 82, labels: true, groups: true }
    case 'strip':
      return { width: w, height: h, padX: 22, padTop: 11, padBottom: 11, gap: 12, maxGap: 22, radius: [8, 4.8, 4], maxStep: 220, subW: 16, labels: false, groups: false }
    default:
      return { width: w, height: h, padX: 6, padTop: 4, padBottom: 4, gap: 4, maxGap: 7, radius: [4, 2.3, 1.9], maxStep: 70, subW: 6, labels: false, groups: false }
  }
}

/** How tall the card version should be for this many agents. */
export function cardHeight(net: Net): number {
  const perCol = new Map<number, number>()
  for (const n of net.neurons) perCol.set(n.col, (perCol.get(n.col) || 0) + 1)
  const groupsPer = new Map<number, Set<string>>()
  for (const n of net.neurons) groupsPer.set(n.col, (groupsPer.get(n.col) || new Set()).add(n.group))
  let most = 1
  for (const [c, k] of perCol) most = Math.max(most, k + ((groupsPer.get(c)?.size || 1) - 1) * 0.6)
  return Math.round(Math.max(180, Math.min(460, 34 + 28 + Math.min(most, 14) * 28)))
}

// ───────────── drawing ─────────────

const WORD: Record<NeuronState, string> = {
  working: 'Working',
  asking: 'Needs your OK',
  waiting: 'Waiting',
  done: 'Done',
  trouble: 'Needs attention',
  idle: 'Free',
  gone: 'Sent home',
}

interface Pulse {
  id: string
  from: string
  to: string
  dir: 'out' | 'back'
  color: string
}

/** A neuron at work is drawn larger than one at rest, so the eye goes to where the work is. */
const SCALE: Record<NeuronState, number> = { working: 1.28, asking: 1.2, trouble: 1.05, waiting: 0.95, idle: 0.85, done: 0.86, gone: 0.72 }

function NeuronGlyph({ n, p, st, dark, born, delay }: { n: Neuron; p: { x: number; y: number; r: number }; st: NeuronState; dark: boolean; born: boolean; delay: number }) {
  const acc = ACCENT[n.account.accent || 'slate']
  const r = p.r * (n.lead ? Math.max(1, SCALE[st]) : SCALE[st])
  const g = `nn-core-${n.account.accent || 'slate'}`
  const halo = `nn-halo-${n.account.accent || 'slate'}`
  const ring = dark ? acc.from : acc.to
  return (
    <g className={born ? 'nn-born' : undefined} style={born ? { animationDelay: `${0.45 + delay}s` } : undefined}>
      {st === 'working' && <circle className="nn-breathe" r={r * 3.1} fill={`url(#${halo})`} />}
      {st === 'asking' && <circle className="nn-breathe" r={r + 5} fill="none" strokeWidth={1.6} style={{ stroke: 'var(--warn)' }} />}
      {st === 'gone' ? (
        <>
          <circle r={r} fill={`url(#${g})`} opacity={0.32} />
          <circle r={r + 2} fill="none" strokeWidth={1} strokeDasharray="2 2.2" style={{ stroke: 'var(--ink-3)' }} />
        </>
      ) : st === 'waiting' ? (
        <>
          <circle r={r} strokeWidth={1.6} style={{ fill: 'var(--nn-bg)', stroke: ring }} />
          <circle r={Math.max(1.2, r * 0.28)} fill={ring} opacity={0.75} />
        </>
      ) : (
        <>
          {/* At rest a neuron keeps its colour but quietly: work in progress is what shines. */}
          <circle r={r} fill={`url(#${g})`} opacity={st === 'idle' ? 0.5 : st === 'done' ? 0.78 : 1} />
          {/* The light on top, as on every orb in the app. */}
          {r > 5 && <ellipse cx={-r * 0.28} cy={-r * 0.42} rx={r * 0.48} ry={r * 0.28} fill="#fff" opacity={st === 'working' || st === 'asking' ? 0.6 : 0.3} />}
          {st === 'done' && <circle r={r + 2.4} fill="none" stroke={ring} strokeOpacity={0.3} strokeWidth={1} />}
        </>
      )}
      {st === 'working' && r > 4 && (
        <circle className="nn-spin" r={r + 3.5} fill="none" stroke={ring} strokeWidth={1.8} strokeLinecap="round" strokeDasharray={`${(r + 3.5) * 1.9} ${(r + 3.5) * 4.4}`} />
      )}
      {st === 'trouble' && (
        <>
          <circle r={r + 3} fill="none" strokeWidth={1.5} style={{ stroke: 'var(--bad)' }} />
          {r > 4 && <circle cx={r * 0.78} cy={-r * 0.78} r={Math.max(2.4, r * 0.32)} strokeWidth={1.2} style={{ fill: 'var(--bad)', stroke: 'var(--nn-bg)' }} />}
        </>
      )}
    </g>
  )
}

function linkStyle(l: Link, active: string, target: string, ultra: boolean): { stroke: string; width: number; dash?: string; opacity: number } {
  if (l.kind === 'started') return { stroke: 'var(--ink)', width: 0.9, dash: '2 4', opacity: 0.16 }
  if (l.kind === 'wait') return l.live ? { stroke: 'var(--ink)', width: 0.8, dash: '2 3.5', opacity: 0.2 } : { stroke: target, width: 0.7, opacity: 0.16 }
  if (l.live) return { stroke: ultra ? active : target, width: 1.6, opacity: 0.85 }
  if (l.failed && !l.done) return { stroke: 'var(--bad)', width: 1.1, opacity: 0.55 }
  return { stroke: target, width: 1.1, opacity: 0.42 }
}

/** Work under way along a line: a short bright comet with a soft tail, visible in a still too. */
function Comet({ d, stroke, width }: { d: string; stroke: string; width: number }) {
  return (
    <>
      <path className="nn-flow" d={d} pathLength={100} fill="none" strokeWidth={width + 5} strokeLinecap="round" strokeDasharray="16 84" strokeOpacity={0.18} style={{ d: `path('${d}')`, stroke }} />
      <path className="nn-flow" d={d} pathLength={100} fill="none" strokeWidth={width + 1.1} strokeLinecap="round" strokeDasharray="8 92" strokeOpacity={1} style={{ d: `path('${d}')`, stroke }} />
    </>
  )
}

interface Routes {
  trunks: { key: string; from: string; d: string; links: Link[] }[]
  lines: { l: Link; d: string; branch?: boolean }[]
  bands: { key: string; d: string; width: number }[]
  waits: Link[]
  /** The whole route from one agent to another, trunk and branch together, for pulses. */
  pathOf(from: string, to: string): string | null
}

/**
 * How the lines are drawn. Hand-offs from one agent to three or more members of one group share
 * a trunk that splits just before the group. "Waits for" lines between groups become one band
 * per pair of groups; the single ones are drawn only on hover.
 */
function route(net: Net, layout: Layout): Routes {
  const { pos, blocks, blockOf } = layout
  const trunks: Routes['trunks'] = []
  const lines: Routes['lines'] = []
  const bands = new Map<string, { from: string; to: string; n: number }>()
  const waits: Link[] = []
  const via = new Map<string, { trunk: string; branch: string }>()
  const direct = (l: Link): void => {
    const a = pos.get(l.from)
    const b = pos.get(l.to)
    if (a && b) lines.push({ l, d: synapse(a, b) })
  }

  const byBundle = new Map<string, Link[]>()
  for (const l of net.links) {
    if (l.kind === 'wait') {
      waits.push(l)
      const a = blockOf.get(l.from)
      const b = blockOf.get(l.to)
      if (!a || !b) continue
      const k = `${a}>${b}`
      const e = bands.get(k) || { from: a, to: b, n: 0 }
      e.n++
      bands.set(k, e)
      continue
    }
    const blk = blockOf.get(l.to)
    const size = blk ? blocks.get(blk)?.ids.length || 0 : 0
    if (l.kind === 'handoff' && blk && size >= 3) {
      const k = `${l.from}>${blk}`
      byBundle.set(k, [...(byBundle.get(k) || []), l])
    } else direct(l)
  }

  for (const [k, ls] of byBundle) {
    const a = pos.get(ls[0].from)
    const blk = blocks.get(blockOf.get(ls[0].to) as string)
    if (!a || !blk || ls.length < 3) {
      ls.forEach(direct)
      continue
    }
    // The trunk ends a little before the group, level with its middle.
    const gapX = Math.max(26, Math.min(90, (blk.left - a.x) * 0.3))
    const split = { x: blk.left - gapX, y: blk.y }
    if (split.x <= a.x + 10) {
      ls.forEach(direct)
      continue
    }
    const trunk = synapse(a, split)
    trunks.push({ key: k, from: ls[0].from, d: trunk, links: ls })
    for (const l of ls) {
      const b = pos.get(l.to)
      if (!b) continue
      const branch = synapse(split, b)
      lines.push({ l, d: branch, branch: true })
      via.set(`${l.from}>${l.to}`, { trunk, branch })
    }
  }

  const bandList: Routes['bands'] = []
  for (const [k, e] of bands) {
    const A = blocks.get(e.from)
    const B = blocks.get(e.to)
    if (!A || !B || A.key === B.key) continue
    const right = Math.max(...A.ids.map((id) => pos.get(id)?.x ?? A.x))
    const d = synapse({ x: right + 12, y: A.y }, { x: B.left - 14, y: B.y })
    bandList.push({ key: k, d, width: Math.min(8, 2 + Math.sqrt(e.n) * 1.3) })
  }

  return {
    trunks,
    lines,
    bands: bandList,
    waits,
    pathOf(from, to) {
      const v = via.get(`${from}>${to}`)
      if (v) return `${v.trunk} ${v.branch.replace(/^M\s*[-\d.]+\s+[-\d.]+\s*/, '')}`
      const a = pos.get(from)
      const b = pos.get(to)
      return a && b ? synapse(a, b) : null
    },
  }
}

/**
 * The network itself, at one of four sizes: `full` for the Team tab, `card` for mission control,
 * `strip` for the band above a chat, `mini` for the one-line summary.
 */
export const NeuralNetwork = memo(function NeuralNetwork({
  chatId,
  variant,
  onOpen,
  className,
  height,
  bg = 'var(--surface-2)',
}: {
  chatId: string
  variant: Variant
  /** The colour behind it, so names and hollow neurons cut cleanly out of the lines. */
  bg?: string
  onOpen?(id: string): void
  className?: string
  /** Fixed height; otherwise it fills its box. */
  height?: number
}) {
  const [ref, size] = useSize()
  const { net, states, ultra, tasks } = useNeural(chatId)
  const dark = useDark()
  const shape = useMemo(() => shapeFor(variant, net.neurons.length, size.w, height ?? size.h), [variant, net.neurons.length, size.w, size.h, height])
  const layout: Layout = useMemo(() => layoutNeural(net, shape), [net, shape])
  const interactive = variant !== 'mini'
  const [focus, setFocus] = useState<string | null>(null)
  const uid = useMemo(() => `nn${Math.random().toString(36).slice(2, 7)}`, [])

  // Who was there already: only agents that arrive while you watch grow in, each on its own
  // clock, so a stream of arrivals does not keep pushing the earlier ones back.
  const known = useRef<Set<string> | null>(null)
  const growing = useRef(new Map<string, number>())
  const [, settle] = useState(0)
  const born = useMemo(() => {
    if (!known.current) {
      if (net.neurons.length) known.current = new Set(net.neurons.map((n) => n.id))
      return growing.current
    }
    let fresh = 0
    for (const n of net.neurons) {
      if (known.current.has(n.id)) continue
      known.current.add(n.id)
      growing.current.set(n.id, Math.min(0.5, fresh++ * 0.08))
      const id = n.id
      setTimeout(() => {
        growing.current.delete(id)
        settle((x) => x + 1)
      }, 1800)
    }
    return growing.current
  }, [net.neurons])

  // Work going out and reports coming back run along the lines as pulses.
  const [pulses, setPulses] = useState<Pulse[]>([])
  const prev = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = new Map(tasks.map((t) => [t.id, t.status]))
    if (!before || variant === 'mini') return
    const add: Pulse[] = []
    for (const t of tasks) {
      const was = before.get(t.id)
      if (was === t.status) continue
      if (t.from === t.to) continue
      if (!was || (was === 'queued' && t.status === 'running')) add.push({ id: `${t.id}:o:${t.status}`, from: t.from, to: t.to, dir: 'out', color: 'var(--nn-active)' })
      else if (t.status === 'done' || t.status === 'failed') add.push({ id: `${t.id}:b`, from: t.from, to: t.to, dir: 'back', color: t.status === 'failed' ? 'var(--bad)' : 'var(--nn-active)' })
    }
    if (!add.length) return
    setPulses((p) => [...p.slice(-24), ...add])
    const t = setTimeout(() => setPulses((p) => p.filter((x) => !add.includes(x))), 1300)
    return () => clearTimeout(t)
  }, [tasks, variant])

  const near = useMemo(() => {
    if (!focus) return null
    const s = new Set([focus])
    for (const l of net.links) {
      if (l.from === focus) s.add(l.to)
      if (l.to === focus) s.add(l.from)
    }
    return s
  }, [focus, net.links])

  const byId = useMemo(() => new Map(net.neurons.map((n) => [n.id, n])), [net.neurons])
  const routes = useMemo(() => route(net, layout), [net, layout])

  // Names are written where they fit: the lead first, then those at work, then the rest.
  const { labelled, titles } = useMemo(() => {
    const out = new Set<string>()
    const titles: typeof layout.groups = []
    if (!shape.labels) return { labelled: out, titles }
    type R = { l: number; t: number; r: number; b: number }
    const hit = (a: R, b: R): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
    const boxes: (R & { id: string })[] = []
    for (const n of net.neurons) {
      const p = layout.pos.get(n.id)
      if (p) boxes.push({ id: n.id, l: p.x - p.r * 1.3 - 3, t: p.y - p.r * 1.3 - 3, r: p.x + p.r * 1.3 + 3, b: p.y + p.r * 1.3 + 3 })
    }
    const kept: R[] = []
    if (shape.groups) {
      for (const g of layout.groups) {
        const w = textWidth(`${g.label}s · ${g.count}`, variant === 'full' ? 11 : 10) + 8
        const r: R = { l: g.x - w / 2, t: g.y - 24, r: g.x + w / 2, b: g.y - 8 }
        if (r.l < 2 || r.r > shape.width - 2 || r.t < 0) continue
        if (kept.some((k) => hit(k, r)) || boxes.some((k) => hit(k, r))) continue
        kept.push(r)
        titles.push(g)
      }
    }
    const rank = (n: Neuron): number => (n.lead ? 0 : states.get(n.id) === 'working' || states.get(n.id) === 'asking' ? 1 : states.get(n.id) === 'gone' ? 3 : 2)
    for (const n of [...net.neurons].sort((a, b) => rank(a) - rank(b))) {
      const p = layout.pos.get(n.id)
      if (!p) continue
      const w = Math.min(96, textWidth(n.account.name, 11) + 6)
      const top = p.y + p.r * 1.3 + 4
      const r: R = { l: p.x - w / 2, t: top, r: p.x + w / 2, b: top + 14 }
      if (r.l < 10 || r.r > shape.width - 10 || r.b > shape.height - 2) continue
      if (kept.some((k) => hit(k, r)) || boxes.some((k) => k.id !== n.id && hit(k, r))) continue
      kept.push(r)
      out.add(n.id)
    }
    return { labelled: out, titles }
  }, [shape, net.neurons, layout, states, variant])

  const accents = useMemo(() => [...new Set(net.neurons.map((n) => n.account.accent || 'slate'))], [net.neurons])
  const open = useCallback((id: string) => onOpen?.(id), [onOpen])
  const onKey = (e: KeyboardEvent, id: string): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open(id)
    }
  }

  const w = shape.width
  const h = shape.height
  const focused = focus ? byId.get(focus) : undefined
  const fp = focus ? layout.pos.get(focus) : undefined

  return (
    <div
      ref={ref}
      className={cn('relative w-full select-none', className)}
      style={{ height: height ?? '100%', ['--nn-active' as string]: ultra ? `url(#${uid}-ultra)` : 'var(--ink-2)', ['--nn-bg' as string]: bg }}
      data-nn-focus={focus ? '' : undefined}
      onMouseLeave={() => setFocus(null)}
    >
      {w > 0 && h > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 overflow-visible" role="group" aria-label="The team as a network">
          <defs>
            <linearGradient id={`${uid}-ultra`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={w} y2={0}>
              <stop offset="0" style={{ stopColor: 'var(--ux-1)' }} />
              <stop offset="0.5" style={{ stopColor: 'var(--ux-2)' }} />
              <stop offset="1" style={{ stopColor: 'var(--ux-3)' }} />
            </linearGradient>
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

          {/* "Waits for" between whole stages: one soft band each, under everything. */}
          {routes.bands.map((band) => (
            <path
              key={band.key}
              className="nn-link"
              d={band.d}
              fill="none"
              strokeWidth={band.width}
              strokeLinecap="round"
              strokeOpacity={dark ? 0.04 : 0.035}
              style={{ d: `path('${band.d}')`, stroke: 'var(--ink)' }}
            />
          ))}
          {/* The single waits only for the neuron under the pointer. */}
          {near &&
            routes.waits
              .filter((l) => l.from === focus || l.to === focus)
              .map((l) => {
                const a = layout.pos.get(l.from)
                const b = layout.pos.get(l.to)
                if (!a || !b) return null
                const d = synapse(a, b)
                return <path key={l.key} className="nn-link" data-near="" d={d} fill="none" strokeWidth={1.1} strokeDasharray="2 3.5" strokeLinecap="round" strokeOpacity={0.6} style={{ stroke: 'var(--ink-2)' }} />
              })}

          {/* Trunks: hand-offs from one agent to a whole group travel together and split near it. */}
          {routes.trunks.map((t) => {
            const live = t.links.some((l) => l.live > 0)
            const acc = ACCENT[byId.get(t.links[0].to)?.account.accent || 'slate']
            const stroke = live && ultra ? `url(#${uid}-ultra)` : dark ? acc.from : acc.to
            const isNear = !!focus && (t.from === focus || t.links.some((l) => l.to === focus))
            const width = (live ? 1.7 : 1.2) + Math.sqrt(t.links.length) * 0.45
            const grow = t.links.every((l) => born.has(l.to))
            return (
              <g key={t.key} className="nn-link" data-near={isNear ? '' : undefined}>
                {live && variant !== 'mini' && !grow && <path d={t.d} fill="none" strokeWidth={width * 3.2} strokeOpacity={0.1} strokeLinecap="round" style={{ d: `path('${t.d}')`, stroke }} />}
                <path
                  className={grow ? 'nn-grow' : undefined}
                  d={t.d}
                  pathLength={grow ? 100 : undefined}
                  fill="none"
                  strokeWidth={width}
                  strokeOpacity={live ? 0.9 : isNear ? 0.8 : 0.42}
                  strokeDasharray={grow ? '100 100' : undefined}
                  strokeLinecap="round"
                  style={{ d: `path('${t.d}')`, stroke }}
                />
                {live && variant !== 'mini' && !grow && <Comet d={t.d} stroke={stroke} width={width} />}
              </g>
            )
          })}

          {/* Every other hand-off, and the branches at the end of each trunk. */}
          {routes.lines.map(({ l, d, branch }) => {
            const t = byId.get(l.to)
            const acc = ACCENT[t?.account.accent || 'slate']
            const st = linkStyle(l, `url(#${uid}-ultra)`, dark ? acc.from : acc.to, ultra)
            const isNear = !!near && (l.from === focus || l.to === focus)
            const grow = born.has(l.to)
            return (
              <g key={`${l.key}${branch ? ':b' : ''}`} className="nn-link" data-near={isNear ? '' : undefined}>
                {l.kind === 'handoff' && l.live > 0 && variant !== 'mini' && !grow && (
                  <path d={d} fill="none" strokeWidth={st.width * 3} strokeOpacity={0.1} strokeLinecap="round" style={{ d: `path('${d}')`, stroke: st.stroke }} />
                )}
                <path
                  className={grow ? 'nn-grow' : undefined}
                  style={{ d: `path('${d}')`, stroke: st.stroke, ...(grow ? { animationDelay: `${born.get(l.to) || 0}s` } : null) }}
                  d={d}
                  pathLength={grow ? 100 : undefined}
                  fill="none"
                  strokeWidth={isNear ? st.width + 0.8 : variant === 'mini' ? Math.min(st.width, 0.8) : st.width}
                  strokeOpacity={isNear ? Math.max(st.opacity, 0.8) : st.opacity}
                  strokeDasharray={grow ? '100 100' : st.dash}
                  strokeLinecap="round"
                />
                {l.kind === 'handoff' && l.live > 0 && variant !== 'mini' && !grow && <Comet d={d} stroke={st.stroke} width={st.width} />}
              </g>
            )
          })}

          {pulses.map((p) => {
            // Drawn along the route as it is now, so a pulse follows the network when it reflows.
            if (born.has(p.to)) return null
            const d = routes.pathOf(p.from, p.to)
            if (!d) return null
            return (
              <g key={p.id} className="nn-pulse pointer-events-none">
                <path className={p.dir === 'out' ? 'nn-out' : 'nn-back'} d={d} pathLength={100} fill="none" strokeWidth={9} strokeOpacity={0.22} strokeLinecap="round" strokeDasharray="12 88" style={{ d: `path('${d}')`, stroke: p.color }} />
                <path className={p.dir === 'out' ? 'nn-out' : 'nn-back'} d={d} pathLength={100} fill="none" strokeWidth={2.8} strokeLinecap="round" strokeDasharray="7 93" style={{ d: `path('${d}')`, stroke: p.color }} />
              </g>
            )
          })}

          {shape.groups &&
            titles.map((g) => (
              <text
                key={g.key}
                x={g.x}
                y={g.y - 12}
                textAnchor="middle"
                className="nn-label fill-ink-3 font-medium"
                style={{ fontSize: variant === 'full' ? 11 : 10, letterSpacing: '0.02em', paintOrder: 'stroke', stroke: 'var(--nn-bg)', strokeWidth: 3 }}
              >
                {plural(g.label.charAt(0).toUpperCase() + g.label.slice(1))} · {g.count}
              </text>
            ))}

          {net.neurons.map((n) => {
            const p = layout.pos.get(n.id)
            if (!p) return null
            const raw = states.get(n.id) || 'idle'
            const st: NeuronState = n.lead && raw === 'idle' ? 'done' : raw
            const isNear = !!near?.has(n.id)
            const by = n.parent ? byId.get(n.parent)?.account.name : undefined
            return (
              <g
                key={n.id}
                className="nn-node outline-none"
                style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                data-near={isNear ? '' : undefined}
                tabIndex={interactive ? 0 : -1}
                role={interactive ? 'button' : undefined}
                aria-label={interactive ? `${n.account.name}${n.lead ? ', lead' : ''}: ${WORD[st]}${by ? `, started by ${by}` : ''}` : undefined}
                onMouseEnter={interactive ? () => setFocus(n.id) : undefined}
                onFocus={interactive ? () => setFocus(n.id) : undefined}
                onBlur={interactive ? () => setFocus((f) => (f === n.id ? null : f)) : undefined}
                onClick={interactive ? () => open(n.id) : undefined}
                onKeyDown={interactive ? (e) => onKey(e, n.id) : undefined}
                cursor={interactive ? 'pointer' : undefined}
              >
                {/* A larger, invisible target, so small neurons are easy to point at. */}
                {interactive && <circle r={Math.max(p.r + 6, 11)} fill="transparent" />}
                <NeuronGlyph n={n} p={p} st={st} dark={dark} born={born.has(n.id)} delay={born.get(n.id) || 0} />
                {focus === n.id && <circle r={p.r + 6.5} fill="none" strokeWidth={1.5} strokeOpacity={0.9} style={{ stroke: 'var(--link)' }} />}
              </g>
            )
          })}

          {shape.labels &&
            net.neurons.map((n) => {
              const p = layout.pos.get(n.id)
              if (!p || (!labelled.has(n.id) && focus !== n.id)) return null
              const st = states.get(n.id)
              const fs = n.lead ? 12 : 11
              const tw = textWidth(n.account.name, fs) + 10
              const ty = p.r * 1.3 + 14
              return (
                <g
                  key={n.id}
                  className="nn-node nn-label pointer-events-none"
                  data-near={near?.has(n.id) ? '' : undefined}
                  style={{ transform: `translate(${p.x}px, ${p.y}px)`, ...(born.has(n.id) ? { animation: `nn-fade 0.4s ease-out ${0.75 + (born.get(n.id) || 0)}s both` } : null) }}
                >
                  {/* A soft plate of the background under each name, so no line runs through it. */}
                  <rect x={-tw / 2} y={ty - fs + 0.5} width={tw} height={fs + 5} rx={(fs + 5) / 2} opacity={0.88} style={{ fill: 'var(--nn-bg)' }} />
                  <text
                    className={cn(st === 'working' || st === 'asking' || n.lead ? 'fill-ink font-medium' : st === 'gone' ? 'fill-ink-3' : 'fill-ink-2')}
                    y={ty}
                    textAnchor="middle"
                    style={{ fontSize: fs }}
                  >
                    {n.account.name}
                  </text>
                </g>
              )
            })}
        </svg>
      )}

      {interactive && focused && fp && <NeuronCard chatId={chatId} n={focused} st={states.get(focused.id) || 'idle'} x={fp.x} y={fp.y} r={fp.r} w={w} h={h} by={focused.parent ? byId.get(focused.parent)?.account.name : undefined} />}

      {/* For a screen reader: the same team as a list, who started whom and who is working. */}
      {interactive && (
        <ul className="sr-only">
          {net.neurons.map((n) => (
            <li key={n.id}>
              <button onClick={() => open(n.id)}>
                {n.account.name}
                {n.lead ? ', lead' : ''}: {WORD[states.get(n.id) || 'idle']}
                {n.parent && byId.get(n.parent) ? `, started by ${byId.get(n.parent)?.account.name}` : ''}
                {n.account.role ? `. ${n.account.role}` : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

// ───────────── the card beside a neuron ─────────────

const NO_TASK: Task[] = []

function NeuronCard({ chatId, n, st, x, y, r, w, h, by }: { chatId: string; n: Neuron; st: NeuronState; x: number; y: number; r: number; w: number; h: number; by?: string }) {
  const agent = useStore((s): AgentState | undefined => s.agents[agentKey(chatId, n.id)])
  const tasks = useStore((s) => s.tasks[chatId] ?? NO_TASK)
  const mine = tasks.filter((t) => t.to === n.id)
  const current = mine.find((t) => t.status === 'running') || mine.find((t) => t.status === 'queued')
  const last = [...mine].reverse().find((t) => t.status === 'done' || t.status === 'failed')
  const task = current || last
  const model = task?.modelLabel || prettyModel(agent?.model) || prettyModel(n.account.model)
  const effort = task?.effort || n.account.effort
  const line =
    st === 'working' || st === 'asking'
      ? agent?.activity || 'Working'
      : st === 'waiting'
        ? task?.waitingFor
          ? `Waits for ${task.waitingFor}`
          : 'Waiting for its turn'
        : last?.result
          ? last.result.replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim()
          : WORD[st]
  const cardW = 260
  const left = x + r + 14 + cardW > w ? Math.max(4, x - r - 14 - cardW) : x + r + 14
  const top = Math.min(Math.max(4, y - 30), Math.max(4, h - 120))
  const tone = st === 'trouble' ? 'text-bad' : st === 'asking' ? 'text-warn' : st === 'working' ? 'text-ink' : 'text-ink-3'
  return (
    <div className="pointer-events-none absolute z-10 w-[260px] animate-fade-in rounded-[12px] bg-raised px-3 py-2.5 shadow-pop" style={{ left, top }}>
      <div className="flex items-baseline gap-1.5">
        <span className="truncate text-[13px] font-semibold">{n.account.name}</span>
        {n.lead && <span className="text-[11px] text-ink-3">Lead</span>}
        <span className={cn('ml-auto shrink-0 text-[11px] font-medium', tone)}>{WORD[st]}</span>
      </div>
      {(n.account.role || task?.title) && <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-2">{task?.title || n.account.role}</div>}
      {(model || by) && (
        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-ink-3">
          {model && (
            <span>
              {model}
              {effort ? `, ${effort} effort` : ''}
            </span>
          )}
          {by && <span>Started by {by}</span>}
        </div>
      )}
      <div className={cn('mt-1.5 line-clamp-2 text-[12px] leading-snug', st === 'working' ? 'shimmer-text' : 'text-ink-2')}>{line}</div>
      <div className="mt-1.5 text-[10.5px] text-ink-4">Click to open the conversation</div>
    </div>
  )
}

// ───────────── legend and numbers ─────────────

function Dot({ st }: { st: NeuronState }) {
  const r = 5
  return (
    <svg width={22} height={22} viewBox="-11 -11 22 22" aria-hidden className="shrink-0">
      {st === 'working' && <circle r={9} opacity={0.18} style={{ fill: 'var(--ux-2)' }} />}
      {st === 'asking' && <circle r={8} fill="none" strokeWidth={1.4} style={{ stroke: 'var(--warn)' }} />}
      {st === 'gone' ? (
        <>
          <circle r={r} opacity={0.32} style={{ fill: 'var(--ink-2)' }} />
          <circle r={r + 2} fill="none" strokeWidth={1} strokeDasharray="2 2" style={{ stroke: 'var(--ink-3)' }} />
        </>
      ) : st === 'waiting' ? (
        <>
          <circle r={r} strokeWidth={1.4} style={{ fill: 'var(--nn-bg)', stroke: 'var(--ink-2)' }} />
          <circle r={1.5} style={{ fill: 'var(--ink-2)' }} />
        </>
      ) : (
        <circle r={r} opacity={st === 'idle' ? 0.45 : 1} style={{ fill: 'var(--ink-2)' }} />
      )}
      {st === 'working' && <circle r={7.6} fill="none" strokeWidth={1.3} strokeDasharray="7 20" strokeLinecap="round" style={{ stroke: 'var(--ink-2)' }} />}
      {st === 'done' && <circle r={7.4} fill="none" strokeOpacity={0.4} strokeWidth={1} style={{ stroke: 'var(--ink-2)' }} />}
      {st === 'trouble' && <circle r={7.6} fill="none" strokeWidth={1.4} style={{ stroke: 'var(--bad)' }} />}
    </svg>
  )
}

export function NeuralLegend({ className }: { className?: string }) {
  const states: NeuronState[] = ['working', 'waiting', 'done', 'asking', 'trouble', 'gone']
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-ink-3', className)} style={{ ['--nn-bg' as string]: 'var(--surface-2)' }}>
      {states.map((s) => (
        <span key={s} className="flex items-center gap-1">
          <Dot st={s} />
          {WORD[s]}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg width={22} height={8} aria-hidden>
          <path d="M1 4 H21" strokeWidth={1.4} strokeLinecap="round" style={{ stroke: 'var(--ink-2)' }} />
        </svg>
        Hand-off
      </span>
      <span className="flex items-center gap-1.5">
        <svg width={22} height={8} aria-hidden>
          <path d="M1 4 H21" strokeWidth={1} strokeDasharray="2 3" strokeLinecap="round" style={{ stroke: 'var(--ink-3)' }} />
        </svg>
        Waits for
      </span>
    </div>
  )
}

/** "22 agents · 9 working · 14 of 22 tasks done · 3 levels" */
export function useNeuralNumbers(chatId: string) {
  const { net, states, tasks, team } = useNeural(chatId)
  const present = team.filter((a) => !a.spawned?.gone).length
  const gone = team.length - present
  const working = [...states.values()].filter((s) => s === 'working' || s === 'asking').length
  const done = tasks.filter((t) => t.status === 'done').length
  return { present, gone, working, done, tasks: tasks.length, depth: net.depth, neurons: net.neurons.length }
}
