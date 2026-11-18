// A live picture of a chat's team as a network: a node for the lead and every teammate or agent
// started in the chat, a line for the work handed between them. A node breathes while its agent
// works and dims once it is done; work under way runs along its line as a small light.

import './styles'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Account, Task } from '@shared/types'
import { agentKey, isBusy, leadOf, teamOf, useStore } from '@/store'
import { ACCENT, accentVars, cn } from '@/lib/util'
import { Tip } from '../ui'
import { Orb } from '../Orb'
import { buildNet, curve, place, type NetEdge, type Shape } from './net'
import { textWidth } from './fit'

const NO_TASKS: Task[] = []
const NO_AGENTS: Account[] = []

type Variant = 'mini' | 'strip' | 'panel'

const SHAPES: Record<Variant, Shape & { lead: number; node: number; sub2: number; labels: boolean }> = {
  // A thumbnail of the network, inside a one-line summary: dots and lines only.
  mini: { height: 26, padX: 6, padY: 4, gap: 5.5, sub: 7, lead: 9, node: 5, sub2: 4, labels: false },
  strip: { height: 80, padX: 22, padY: 12, gap: 18, sub: 26, lead: 20, node: 12, sub2: 10, labels: false },
  // Names sit under the nodes here, so columns keep a name's width apart and rows a name's height.
  panel: { height: 180, padX: 44, padY: 26, gap: 44, sub: 96, lead: 28, node: 20, sub2: 16, labels: true },
}

/** The width of an element, kept up to date. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** Who is in the chat and the work between them. Shared by the network and its caption. */
export function useNet(chatId: string) {
  const accounts = useStore((s) => s.accounts)
  const agents = useStore((s) => s.chats.find((c) => c.id === chatId)?.agents ?? NO_AGENTS)
  const leadId = useStore((s) => leadOf(s, chatId)?.id)
  const tasks = useStore((s) => s.tasks[chatId] ?? NO_TASKS)
  // The same people the Inspector and the tabs count: everyone still in the chat. Agents sent
  // home are counted apart, as finished, and are not drawn.
  const team = useMemo(() => teamOf(accounts, leadId, agents, false), [accounts, leadId, agents])
  const finished = useMemo(() => agents.filter((a) => a.spawned?.gone).length, [agents])
  const net = useMemo(() => buildNet(team, leadId, tasks), [team, leadId, tasks])
  // Who is at work, as a string: the picture redraws when that changes, not on every word.
  const busySig = useStore((s) => team.map((a) => (isBusy(s.agents[agentKey(chatId, a.id)]) ? '1' : '0')).join(''))
  const busy = useMemo(() => new Set(team.filter((_, i) => busySig[i] === '1').map((a) => a.id)), [team, busySig])
  return { team, net, tasks, busy, leadId, finished }
}

const Node = memo(function Node({
  chatId,
  account,
  x,
  y,
  size,
  lead,
  dim,
  label,
  onOpen,
}: {
  chatId: string
  account: Account
  x: number
  y: number
  size: number
  lead: boolean
  dim: boolean
  label: boolean
  onOpen?(id: string): void
}) {
  const st = useStore((s) => s.agents[agentKey(chatId, account.id)])
  const busy = isBusy(st)
  const gone = !!account.spawned?.gone
  const what = st?.phase === 'waiting' ? 'Needs your OK' : busy ? st?.activity || 'Working' : gone ? 'Sent home' : 'Free'
  const tip = (
    <span className="flex max-w-[260px] flex-col">
      <span className="font-semibold">
        {account.name}
        {lead && <span className="font-normal opacity-60"> · Lead</span>}
      </span>
      {(account.role || account.spawned) && <span className="truncate font-normal opacity-70">{account.role || 'Agent'}</span>}
      <span className="truncate font-normal opacity-90">{what}</span>
    </span>
  )
  return (
    <div
      className="ux-node absolute top-0 left-0"
      style={{ transform: `translate(${x - size / 2}px, ${y - size / 2}px)`, width: size, height: size, ...accentVars(account.accent) }}
    >
      <div className="ux-in relative size-full">
        {busy && (
          <span
            className="ux-halo pointer-events-none absolute rounded-full"
            style={{ inset: -size * 0.75, background: 'radial-gradient(closest-side, color-mix(in oklab, var(--a2) 34%, transparent), transparent)' }}
          />
        )}
        <Tip label={tip} side="top">
          <button aria-label={account.name} style={{ opacity: dim ? 0.45 : 1 }} onClick={() => onOpen?.(account.id)} className="relative block size-full rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--a2)]">
            <Orb account={account} size={size} phase={st?.phase} off={gone} />
          </button>
        </Tip>
        {label && (
          <span
            className={cn('pointer-events-none absolute top-full left-1/2 mt-1 max-w-[84px] -translate-x-1/2 truncate text-center text-[10.5px] leading-tight', busy ? 'font-medium text-ink' : dim ? 'text-ink-3' : 'text-ink-2')}
            // A soft halo the colour of the panel, so a name stays legible where lines run behind it.
            style={{ textShadow: '0 0 3px var(--surface-2), 0 0 3px var(--surface-2), 0 0 6px var(--surface-2)' }}
          >
            {account.name}
          </span>
        )}
      </div>
    </div>
  )
})

function Edge({ edge, d, color, len }: { edge: NetEdge; d: string; color: string; len: number }) {
  const path = (extra: CSSProperties) => ({ d: `path('${d}')`, ...extra }) as CSSProperties
  if (edge.structural) {
    return <path className="ux-edge" d={d} fill="none" strokeWidth={1} strokeDasharray="2 4" strokeLinecap="round" style={path({ stroke: 'color-mix(in oklab, var(--ink) 16%, transparent)' })} />
  }
  const tone = edge.live ? color : edge.failed && !edge.done ? 'var(--bad)' : color
  return (
    <g>
      {edge.live > 0 && (
        <path className="ux-edge" d={d} fill="none" strokeWidth={6} strokeLinecap="round" style={path({ stroke: `color-mix(in oklab, ${color} 13%, transparent)` })} />
      )}
      <path
        className="ux-edge"
        d={d}
        fill="none"
        strokeWidth={edge.live ? 1.5 : 1.15}
        strokeLinecap="round"
        style={path({ stroke: `color-mix(in oklab, ${tone} ${edge.live ? 62 : 34}%, transparent)` })}
      />
      {edge.live > 0 && (
        <path
          className="ux-edge ux-flow"
          d={d}
          pathLength={100}
          fill="none"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeDasharray="9 91"
          // Longer lines carry their light a little longer, so it moves at about the same speed everywhere.
          style={path({ stroke: color, animationDuration: `${Math.min(2.8, Math.max(1.2, len / 140))}s`, filter: `drop-shadow(0 0 3px ${color})` })}
        />
      )}
    </g>
  )
}

/**
 * The network itself. `strip` is the compact one at the top of a chat; `panel` is the larger
 * one in mission control, with names under the nodes.
 */
export function AgentNetwork({ chatId, variant = 'strip', onOpen, className }: { chatId: string; variant?: Variant; onOpen?(id: string): void; className?: string }) {
  const [ref, width] = useWidth()
  const { net, busy } = useNet(chatId)
  // The large one grows with its busiest layer, up to seven rows, before it spreads sideways.
  const shape = useMemo(() => {
    const base = SHAPES[variant]
    if (variant !== 'panel') return base
    const most = Math.max(1, ...Object.values(net.nodes.reduce<Record<number, number>>((m, n) => ({ ...m, [n.layer]: (m[n.layer] || 0) + 1 }), {})))
    const rows = Math.min(most, 7)
    // Room for every row, plus a line under the lowest for its name.
    return { ...base, height: Math.max(150, Math.min(340, base.padY * 2 + (rows - 1) * base.gap + 14 + 8)) }
  }, [variant, net.nodes])
  const dark = useDark()
  // Names hang under the nodes: the nodes keep clear of the bottom edge by a line's height.
  const pos = useMemo(() => place(net.nodes, width, shape.labels ? { ...shape, height: shape.height - 14 } : shape), [net.nodes, width, shape])
  const byId = useMemo(() => new Map(net.nodes.map((n) => [n.id, n])), [net.nodes])
  // Whoever did work that is now finished, and is not at it any more, steps back.
  const worked = useMemo(() => new Set(net.edges.filter((e) => !e.structural && e.done + e.failed > 0 && !e.live).map((e) => e.to)), [net.edges])
  const waitingFor = useMemo(() => new Set(net.edges.filter((e) => e.live).map((e) => e.to)), [net.edges])
  const sizeOf = (n: { lead: boolean; layer: number }): number => (n.lead ? shape.lead : n.layer >= 2 ? shape.sub2 : shape.node)
  // Names are written only where they fit: the lead's first, then those at work, then the rest,
  // each kept only if it touches no other name, no other node and no edge of the box. The
  // others still show their name on hover.
  const labelled = useMemo(() => {
    const out = new Set<string>()
    if (!shape.labels) return out
    type R = { l: number; t: number; r: number; b: number }
    const hit = (a: R, b: R): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
    const nodes: (R & { id: string })[] = []
    for (const n of net.nodes) {
      const p = pos.get(n.id)
      if (!p) continue
      const z = sizeOf(n) / 2 + 2
      nodes.push({ id: n.id, l: p.x - z, t: p.y - z, r: p.x + z, b: p.y + z })
    }
    const kept: R[] = []
    const rank = (n: (typeof net.nodes)[number]): number => (n.lead ? 0 : busy.has(n.id) ? 1 : 2)
    for (const n of [...net.nodes].sort((a, b) => rank(a) - rank(b))) {
      const p = pos.get(n.id)
      if (!p) continue
      const w = Math.min(84, textWidth(n.account.name, 10.5) + 4)
      const top = p.y + sizeOf(n) / 2 + 4
      const r: R = { l: p.x - w / 2, t: top, r: p.x + w / 2, b: top + 13 }
      if (r.l < 2 || r.r > width - 2 || r.b > shape.height) continue
      if (kept.some((k) => hit(k, r)) || nodes.some((k) => k.id !== n.id && hit(k, r))) continue
      kept.push(r)
      out.add(n.id)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, net.nodes, pos, busy, width])

  if (variant === 'mini') {
    return (
      <div ref={ref} className={cn('relative select-none', className)} style={{ height: shape.height }} aria-hidden>
        {width > 0 && (
          <svg className="absolute inset-0 overflow-visible" width={width} height={shape.height}>
            {net.edges.map((e) => {
              const a = pos.get(e.from)
              const b = pos.get(e.to)
              if (!a || !b) return null
              const acc = ACCENT[byId.get(e.to)?.account.accent || 'slate']
              return (
                <path
                  key={e.key}
                  d={curve(a, b)}
                  fill="none"
                  strokeWidth={e.live ? 1 : 0.75}
                  style={{ stroke: e.structural ? 'color-mix(in oklab, var(--ink) 14%, transparent)' : `color-mix(in oklab, ${dark ? acc.from : acc.to} ${e.live ? 70 : 32}%, transparent)` }}
                />
              )
            })}
            {net.nodes.map((n) => {
              const p = pos.get(n.id)
              if (!p) return null
              const acc = ACCENT[n.account.accent || 'slate']
              const on = n.lead || busy.has(n.id)
              return (
                <g key={n.id} opacity={on ? 1 : 0.4}>
                  {busy.has(n.id) && <circle cx={p.x} cy={p.y} r={sizeOf(n)} style={{ fill: `color-mix(in oklab, ${acc.to} 22%, transparent)` }} />}
                  <circle cx={p.x} cy={p.y} r={sizeOf(n) / 2} style={{ fill: dark ? acc.from : acc.to }} />
                </g>
              )
            })}
          </svg>
        )}
      </div>
    )
  }

  return (
    <div ref={ref} className={cn('relative w-full select-none', className)} style={{ height: shape.height }}>
      {width > 0 && (
        <>
          <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={shape.height} aria-hidden>
            {net.edges.map((e) => {
              const a = pos.get(e.from)
              const b = pos.get(e.to)
              if (!a || !b) return null
              const acc = ACCENT[byId.get(e.to)?.account.accent || 'slate']
              const color = dark ? acc.from : acc.to
              return <Edge key={e.key} edge={e} d={curve(a, b)} color={color} len={Math.hypot(b.x - a.x, b.y - a.y)} />
            })}
          </svg>
          {net.nodes.map((n) => {
            const p = pos.get(n.id)
            if (!p) return null
            const size = sizeOf(n)
            const dim = !n.lead && !busy.has(n.id) && !waitingFor.has(n.id) && (!!n.account.spawned?.gone || worked.has(n.id) || !!n.account.spawned)
            return <Node key={n.id} chatId={chatId} account={n.account} x={p.x} y={p.y} size={size} lead={n.lead} dim={dim} label={labelled.has(n.id)} onOpen={onOpen} />
          })}
        </>
      )}
    </div>
  )
}

/** True while the window is in its dark look. */
function useDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}
