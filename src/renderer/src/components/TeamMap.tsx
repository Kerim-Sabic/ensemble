import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { LayoutGrid, Maximize2, Minus, Plus, UserRound } from 'lucide-react'
import type { Account, AgentState, Task } from '@shared/types'
import { agentKey, isBusy, useStore } from '@/store'
import { accentVars, cn, prettyModel, runLabel } from '@/lib/util'
import { YOU, type Beat, type BeatKind } from '@/lib/teamflow'
import { Tip } from './ui'
import { Orb, UsageMeter } from './Orb'

// The team as a map you can move around: drag the background to pan, scroll to zoom,
// drag a card to put it somewhere else. Whenever someone new joins and would be out of
// sight, the view moves to show everyone again, so a new agent is never missed.

export interface Packet {
  id: string
  from: string
  to: string
  kind: BeatKind
}

interface Point {
  x: number
  y: number
}

interface View {
  x: number
  y: number
  k: number
}

const PACKET: Record<BeatKind, string> = { said: 'message', reply: 'reply', task: 'task', report: 'report', note: 'note', question: 'question', answer: 'answer', joined: 'new agent' }

/** Card sizes in map units. The zoom does the shrinking, so they are always drawn the same. */
const W = { you: 92, lead: 252, member: 216 }
const H = { you: 36, lead: 84, member: 76 }
const UNIT = 236
const MIN_K = 0.3
const MAX_K = 1.6
/** How many cards sit side by side on a row before the next row starts. */
const PER_ROW = 5

const sizeOf = (id: string, leadId: string | undefined): { w: number; h: number } =>
  id === YOU ? { w: W.you, h: H.you } : id === leadId ? { w: W.lead, h: H.lead } : { w: W.member, h: H.member }

/** You on top, the lead below, those it works with in rows under it, and under each of them the agents they started. */
function layout(team: Account[], lead: Account | undefined, parentOf: (a: Account) => string): Record<string, Point> {
  const pos: Record<string, Point> = {}
  if (!lead) return pos
  pos[YOU] = { x: 0, y: 0 }
  pos[lead.id] = { x: 0, y: 118 }
  const others = team.filter((a) => a.id !== lead.id)
  const firsts = others.filter((a) => parentOf(a) === lead.id)
  const groups = firsts.map((a) => ({ node: a, kids: others.filter((x) => x !== a && parentOf(x) === a.id) }))
  // Anyone whose place could not be worked out still gets one.
  const placed = new Set([lead.id, ...groups.flatMap((g) => [g.node.id, ...g.kids.map((k) => k.id)])])
  for (const a of others) if (!placed.has(a.id)) groups.push({ node: a, kids: [] })
  // Groups are laid out in lines that are never wider than a few cards.
  const lines: (typeof groups)[] = []
  let line: typeof groups = []
  let units = 0
  for (const g of groups) {
    const u = Math.max(1, g.kids.length)
    if (line.length && units + u > PER_ROW) {
      lines.push(line)
      line = []
      units = 0
    }
    line.push(g)
    units += u
  }
  if (line.length) lines.push(line)
  let y = 118 + 158
  for (const l of lines) {
    const total = l.reduce((n, g) => n + Math.max(1, g.kids.length), 0)
    let x = (-total * UNIT) / 2
    for (const g of l) {
      const span = Math.max(1, g.kids.length) * UNIT
      pos[g.node.id] = { x: x + span / 2, y }
      g.kids.forEach((k, i) => (pos[k.id] = { x: x + (i + 0.5) * UNIT, y: y + 132 }))
      x += span
    }
    y += l.some((g) => g.kids.length) ? 132 + 132 : 116
  }
  return pos
}

/** Keeps the pointer while dragging, even outside the map. A pointer that cannot be kept just is not. */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id)
  } catch {
    /* dragging still works while the pointer stays over the map */
  }
}

/** A soft curve from one card to another, used by the links and by what travels along them. */
const curve = (p: Point, q: Point): string => {
  const m = (p.y + q.y) / 2
  return `M ${p.x} ${p.y} C ${p.x} ${m}, ${q.x} ${m}, ${q.x} ${q.y}`
}

function YouNode({ at }: { at: Point }) {
  return (
    <div className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: at.x, top: at.y }}>
      <div className="flex h-9 items-center gap-2 rounded-full bg-surface pr-3.5 pl-2.5 text-[12.5px] font-medium shadow-card">
        <span className="flex size-[22px] items-center justify-center rounded-full bg-ink text-inverse">
          <UserRound className="size-3" strokeWidth={2.4} />
        </span>
        You
      </div>
    </div>
  )
}

const AgentNode = memo(function AgentNode({
  chatId,
  account,
  lead,
  at,
  fresh,
  dragging,
  onPointerDown,
  onOpen,
}: {
  chatId: string
  account: Account
  lead: boolean
  at: Point
  fresh: boolean
  dragging: boolean
  onPointerDown(e: ReactPointerEvent, id: string): void
  onOpen(id: string): void
}) {
  const st = useStore((s): AgentState | undefined => s.agents[agentKey(chatId, account.id)])
  const status = useStore((s) => s.statuses[account.id])
  const usage = useStore((s) => (account.spawned ? undefined : s.usage[account.id]?.session))
  const base = useStore((s) => (account.spawned ? s.members[account.spawned.base]?.name : undefined))
  const by = useStore((s) => (account.spawned ? s.members[account.spawned.by]?.name : undefined))
  const task = useStore((s) => (st?.taskId ? s.tasks[chatId]?.find((t) => t.id === st.taskId) : undefined))
  const busy = isBusy(st)
  const gone = !!account.spawned?.gone
  const out = status?.state === 'signed-out'
  const model = prettyModel(st?.model) || status?.models?.find((m) => m.value === (account.model || ''))?.label || status?.models?.find((m) => m.isDefault)?.label || status?.models?.find((m) => m.value === 'default')?.description
  const tip = [account.spawned ? `${account.role || 'Agent'} · started by ${by || 'a teammate'}, on ${base || 'an'} account` : account.role, st?.modelWhy].filter(Boolean).join('\n')
  const card = (
    <button
      onPointerDown={(e) => onPointerDown(e, account.id)}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(account.id)
      }}
      style={{ left: at.x, top: at.y, width: lead ? W.lead : W.member, ...accentVars(account.accent) }}
      className={cn(
        'group/n absolute z-10 flex -translate-x-1/2 -translate-y-1/2 touch-none items-center gap-3 rounded-[18px] bg-surface text-left shadow-card transition-shadow duration-200 hover:shadow-float',
        lead ? 'px-4 py-3.5' : 'px-3.5 py-3',
        busy && 'shadow-[0_0_0_1px_color-mix(in_oklab,var(--a2)_50%,var(--line)),0_16px_40px_-18px_color-mix(in_oklab,var(--a2)_60%,transparent)]',
        fresh && 'map-fresh',
        dragging ? 'cursor-grabbing shadow-pop' : 'cursor-pointer',
        gone && 'opacity-55 saturate-50',
      )}
    >
      <Orb account={account} size={lead ? 44 : account.spawned ? 32 : 36} phase={st?.phase} off={out || gone} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className={cn('truncate font-semibold', lead ? 'text-[14.5px]' : 'text-[13.5px]')}>{account.name}</span>
          {lead && <span className="text-[11px] text-ink-3">Lead</span>}
          {account.spawned && <span className="shrink-0 text-[10.5px] text-ink-4">{gone ? 'Sent home' : account.spawned.depth > 1 ? 'Sub-agent' : 'Agent'}</span>}
        </span>
        <span className="block truncate text-[12px] leading-[17px]">
          {out ? (
            <span className="text-warn">Signed out</span>
          ) : st?.phase === 'waiting' ? (
            <span className="font-medium text-warn">{st.activity || 'Needs your OK'}</span>
          ) : busy ? (
            <span className="shimmer-text">{st?.activity || 'Working'}</span>
          ) : (
            <span className="text-ink-3">{task ? task.title : account.role?.trim() || 'Free'}</span>
          )}
        </span>
        <span className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-4">
          <span className="min-w-0 flex-1 truncate">{task && busy && runLabel(task) ? runLabel(task) : model || (account.provider === 'chatgpt' ? 'ChatGPT' : 'Claude')}</span>
          {usage && <UsageMeter window={usage} />}
        </span>
      </span>
    </button>
  )
  return tip ? (
    <Tip label={<span className="block whitespace-pre-line">{tip}</span>} side="bottom">
      {card}
    </Tip>
  ) : (
    card
  )
})

/** Places dragged by hand, kept per chat so the map looks the same next time. */
function usePlaces(chatId: string) {
  const keyOf = `ensemble.map.${chatId}`
  const read = (): Record<string, Point> => {
    try {
      return JSON.parse(localStorage.getItem(keyOf) || '{}') as Record<string, Point>
    } catch {
      return {}
    }
  }
  const [places, setPlaces] = useState<Record<string, Point>>(read)
  useEffect(() => setPlaces(read()), [chatId]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useCallback(
    (next: Record<string, Point>) => {
      setPlaces(next)
      try {
        if (Object.keys(next).length) localStorage.setItem(keyOf, JSON.stringify(next))
        else localStorage.removeItem(keyOf)
      } catch {
        /* the map just forgets */
      }
    },
    [keyOf],
  )
  return [places, save] as const
}

type Drag = { kind: 'pan'; sx: number; sy: number; vx: number; vy: number } | { kind: 'node'; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }

export function TeamMap({
  chatId,
  team,
  leadId,
  beats,
  tasks,
  packets,
  onOpen,
}: {
  chatId: string
  team: Account[]
  leadId: string | undefined
  beats: Beat[]
  tasks: Task[]
  packets: Packet[]
  onOpen(id: string): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const lead = team.find((a) => a.id === leadId) || team[0]
  const parentOf = useCallback((a: Account): string => (a.spawned && team.some((x) => x.id === a.spawned?.by) ? a.spawned.by : lead?.id || ''), [team, lead?.id])
  const ids = team.map((a) => a.id).join(',')
  const auto = useMemo(() => layout(team, lead, parentOf), [ids, lead?.id, parentOf]) // eslint-disable-line react-hooks/exhaustive-deps
  const [places, setPlaces] = usePlaces(chatId)
  const at = useMemo(() => {
    const out: Record<string, Point> = { ...auto }
    for (const [id, p] of Object.entries(places)) if (out[id]) out[id] = p
    return out
  }, [auto, places])

  // ── the view: where the map is and how close ──
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [glide, setGlide] = useState(false)
  const touched = useRef(false)
  const glideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const move = useCallback((v: View, smooth = false) => {
    setGlide(smooth)
    if (smooth) {
      clearTimeout(glideTimer.current)
      glideTimer.current = setTimeout(() => setGlide(false), 420)
    }
    setView(v)
  }, [])

  const bounds = useMemo(() => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [id, p] of Object.entries(at)) {
      const s = sizeOf(id, lead?.id)
      x0 = Math.min(x0, p.x - s.w / 2)
      x1 = Math.max(x1, p.x + s.w / 2)
      y0 = Math.min(y0, p.y - s.h / 2)
      y1 = Math.max(y1, p.y + s.h / 2)
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null
  }, [at, lead?.id])

  const fit = useCallback(
    (smooth = true) => {
      if (!bounds || !size.w || !size.h) return
      const pad = 56
      const k = Math.max(MIN_K, Math.min(1.05, (size.w - pad * 2) / (bounds.x1 - bounds.x0), (size.h - pad * 2) / (bounds.y1 - bounds.y0)))
      move({ k, x: size.w / 2 - ((bounds.x0 + bounds.x1) / 2) * k, y: size.h / 2 - ((bounds.y0 + bounds.y1) / 2) * k }, smooth)
    },
    [bounds, size, move],
  )

  // Is every card in sight right now?
  const allSeen = useMemo(() => {
    if (!bounds) return true
    const sx = (x: number): number => x * view.k + view.x
    const sy = (y: number): number => y * view.k + view.y
    return sx(bounds.x0) >= -4 && sy(bounds.y0) >= -4 && sx(bounds.x1) <= size.w + 4 && sy(bounds.y1) <= size.h + 4
  }, [bounds, view, size])

  // Fit when the map first appears, when the window changes size (until you have moved it
  // yourself), and whenever someone joins who would otherwise be out of sight.
  const seenIds = useRef<string>('')
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!size.w || !size.h || !bounds) return
    const before = seenIds.current ? new Set(seenIds.current.split(',')) : null
    seenIds.current = ids
    const joined = before ? team.filter((a) => !before.has(a.id)).map((a) => a.id) : []
    if (joined.length) {
      setFresh(new Set(joined))
      setTimeout(() => setFresh(new Set()), 4200)
    }
    if (!before || !touched.current || joined.length) fit(!!before)
  }, [ids, size.w, size.h]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    touched.current = false
    seenIds.current = ''
  }, [chatId])

  const zoomAt = useCallback(
    (factor: number, cx = size.w / 2, cy = size.h / 2, smooth = false) => {
      touched.current = true
      setView((v) => {
        const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor))
        const r = k / v.k
        return { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r }
      })
      setGlide(smooth)
    },
    [size],
  )

  // Scrolling zooms around the pointer. It has to be a listener that may stop the page scrolling.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // A trackpad scroll that is mostly sideways moves the map instead.
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        touched.current = true
        setGlide(false)
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
        return
      }
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // ── dragging: the background pans, a card moves ──
  const drag = useRef<Drag | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)
  const suppressClick = useRef(false)

  const startPan = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
    capture(e.currentTarget as HTMLElement, e.pointerId)
    setPanning(true)
  }
  const startNode = useCallback(
    (e: ReactPointerEvent, id: string) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const p = at[id]
      if (!p) return
      // Not captured yet: a press that does not move is a click on the card, and a captured
      // pointer would send that click somewhere else.
      drag.current = { kind: 'node', id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false }
    },
    [at],
  )
  const onMove = (e: ReactPointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (d.kind === 'pan') {
      touched.current = true
      setGlide(false)
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
      return
    }
    if (!d.moved && Math.hypot(dx, dy) < 5) return
    if (!d.moved && box.current) capture(box.current, e.pointerId)
    d.moved = true
    setDragId(d.id)
    setPlaces({ ...places, [d.id]: { x: d.ox + dx / view.k, y: d.oy + dy / view.k } })
  }
  const endDrag = (): void => {
    const d = drag.current
    drag.current = null
    setPanning(false)
    setDragId(null)
    if (d?.kind === 'node' && d.moved) {
      // The click that ends a drag is not a click on the card.
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 0)
    }
  }
  const open = useCallback((id: string) => !suppressClick.current && onOpen(id), [onOpen])

  // ── what is drawn ──
  const links = useMemo(() => {
    const m = new Map<string, { a: string; b: string; tasks: number; questions: number; notes: number; total: number }>()
    const touch = (a: string, b: string): { a: string; b: string; tasks: number; questions: number; notes: number; total: number } => {
      const k = [a, b].sort().join('|')
      let e = m.get(k)
      // Kept in the direction of the first link made, which is parent to child.
      if (!e) m.set(k, (e = { a, b, tasks: 0, questions: 0, notes: 0, total: 0 }))
      return e
    }
    if (lead) {
      touch(YOU, lead.id)
      for (const o of team) if (o.id !== lead.id) touch(parentOf(o), o.id)
    }
    for (const b of beats) {
      const e = touch(b.from, b.to)
      e.total++
      if (b.kind === 'task') e.tasks++
      else if (b.kind === 'question') e.questions++
      else if (b.kind === 'note') e.notes++
    }
    return [...m.values()]
  }, [beats, lead, team, parentOf])

  const working = useMemo(() => {
    const s = new Set<string>()
    for (const t of tasks) if (t.status === 'running') s.add([t.from, t.to].sort().join('|'))
    return s
  }, [tasks])
  const accentOf = (id: string): string => (id === YOU ? 'var(--ink-2)' : `var(--acc-${id})`)
  const vars = useMemo(() => {
    const v: Record<string, string> = {}
    for (const a of team) v[`--acc-${a.id}`] = (accentVars(a.accent) as Record<string, string>)['--a2']
    return v as CSSProperties
  }, [team])

  const moved = Object.keys(places).some((id) => at[id])

  return (
    <div
      ref={box}
      onPointerDown={startPan}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.layer) fit()
      }}
      className={cn('relative min-h-0 flex-1 touch-none overflow-hidden select-none', panning ? 'cursor-grabbing' : 'cursor-grab')}
      style={vars}
    >
      <div className="hero pointer-events-none absolute inset-0 opacity-70" />
      {/* A faint grid that moves with the map, so it is clear the map moves. */}
      <div
        className="map-grid pointer-events-none absolute inset-0"
        style={{ backgroundSize: `${28 * view.k}px ${28 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      />
      <div
        data-layer="1"
        className={cn('absolute top-0 left-0 origin-top-left', glide && 'transition-transform duration-[400ms] ease-out')}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden>
          {links.map((l) => {
            const p = at[l.a]
            const q = at[l.b]
            if (!p || !q) return null
            const k = [l.a, l.b].sort().join('|')
            const on = working.has(k)
            const member = l.a === YOU || l.a === lead?.id ? l.b : l.a
            const d = curve(p, q)
            return (
              <g key={k}>
                <path d={d} fill="none" stroke={l.total ? 'var(--line-2)' : 'var(--line)'} strokeWidth={(l.total ? 1.75 : 1.25) / Math.min(1, view.k)} strokeDasharray={l.total ? undefined : '3 5'} />
                {on && <path d={d} fill="none" stroke={accentOf(member)} strokeWidth={2.25} strokeLinecap="round" strokeDasharray="2 10" className="flow-dash" opacity={0.9} />}
              </g>
            )
          })}
        </svg>
        {links.map((l) => {
          const p = at[l.a]
          const q = at[l.b]
          if (!p || !q || !(l.tasks || l.questions || l.notes)) return null
          const parts = [l.tasks && `${l.tasks} ${l.tasks === 1 ? 'task' : 'tasks'}`, l.questions && `${l.questions} ${l.questions === 1 ? 'question' : 'questions'}`, l.notes && `${l.notes} ${l.notes === 1 ? 'note' : 'notes'}`].filter(Boolean)
          return (
            <span
              key={`${l.a}|${l.b}`}
              className="tabular pointer-events-none absolute z-[5] -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface-2 px-2 py-px text-[10.5px] whitespace-nowrap text-ink-3 shadow-[0_0_0_1px_var(--line)]"
              style={{ left: (p.x + q.x) / 2, top: (p.y + q.y) / 2 }}
            >
              {parts.join(' · ')}
            </span>
          )
        })}
        {packets.map((pk) => {
          const p = at[pk.from]
          const q = at[pk.to]
          if (!p || !q) return null
          return (
            <span key={pk.id} className="flow-packet-path pointer-events-none absolute top-0 left-0 z-20 flex items-center gap-1.5" style={{ offsetPath: `path("${curve(p, q)}")`, ['--c' as string]: accentOf(pk.from) }}>
              <span className="flow-dot" />
              <span className="rounded-full bg-[var(--c)] px-1.5 py-px text-[10px] leading-[14px] font-medium text-white shadow-[0_1px_4px_rgba(0,0,0,0.25)]">{PACKET[pk.kind]}</span>
            </span>
          )
        })}
        {at[YOU] && <YouNode at={at[YOU]} />}
        {team.map((a) => at[a.id] && <AgentNode key={a.id} chatId={chatId} account={a} lead={a.id === lead?.id} at={at[a.id]} fresh={fresh.has(a.id)} dragging={dragId === a.id} onPointerDown={startNode} onOpen={open} />)}
      </div>

      {/* Controls. Pointer events stop here so pressing them does not start a pan. */}
      <div onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} className="absolute bottom-3 left-3 z-30 flex cursor-default items-center gap-0.5 rounded-[11px] bg-surface p-0.5 shadow-float">
        <Tip label="Zoom out" side="top">
          <button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25, undefined, undefined, true)} className="flex size-7 items-center justify-center rounded-[8px] text-ink-2 hover:bg-hover hover:text-ink">
            <Minus className="size-3.5" />
          </button>
        </Tip>
        <Tip label="Actual size" side="top">
          <button onClick={() => zoomAt(1 / view.k, undefined, undefined, true)} className="tabular h-7 w-12 rounded-[8px] text-[11.5px] text-ink-2 hover:bg-hover hover:text-ink">
            {Math.round(view.k * 100)}%
          </button>
        </Tip>
        <Tip label="Zoom in" side="top">
          <button aria-label="Zoom in" onClick={() => zoomAt(1.25, undefined, undefined, true)} className="flex size-7 items-center justify-center rounded-[8px] text-ink-2 hover:bg-hover hover:text-ink">
            <Plus className="size-3.5" />
          </button>
        </Tip>
        <span className="mx-0.5 h-4 w-px bg-line" />
        <Tip label="Show everyone (or double-click the map)" side="top">
          <button
            aria-label="Show everyone"
            onClick={() => {
              touched.current = false
              fit()
            }}
            className={cn('flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12px] font-medium hover:bg-hover hover:text-ink', allSeen ? 'text-ink-2' : 'text-link')}
          >
            <Maximize2 className="size-3.5" /> {allSeen ? 'Fit' : 'Show everyone'}
          </button>
        </Tip>
        {moved && (
          <Tip label="Put every card back where it started" side="top">
            <button
              aria-label="Tidy up"
              onClick={() => {
                setPlaces({})
                setTimeout(() => fit(), 0)
              }}
              className="flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink"
            >
              <LayoutGrid className="size-3.5" /> Tidy up
            </button>
          </Tip>
        )}
      </div>
      <div className="pointer-events-none absolute right-3 bottom-3 z-30 flex flex-col items-end gap-2">
        {!allSeen && bounds && <MiniMap at={at} bounds={bounds} view={view} size={size} leadId={lead?.id} team={team} onCenter={(x, y) => {
          touched.current = true
          move({ ...view, x: size.w / 2 - x * view.k, y: size.h / 2 - y * view.k }, true)
        }} />}
        <span className="rounded-full bg-surface/80 px-2.5 py-1 text-[11px] text-ink-3 shadow-[0_0_0_1px_var(--line)] backdrop-blur-sm">Drag to move around · scroll to zoom · drag a card to place it</span>
      </div>
    </div>
  )
}

/** A small picture of the whole map with the part on screen marked. Click it to go there. */
function MiniMap({ at, bounds, view, size, leadId, team, onCenter }: { at: Record<string, Point>; bounds: { x0: number; y0: number; x1: number; y1: number }; view: View; size: { w: number; h: number }; leadId: string | undefined; team: Account[]; onCenter(x: number, y: number): void }) {
  const MW = 176
  const MH = 112
  // The picture covers the map and the part on screen, whichever reaches further.
  const vx0 = -view.x / view.k
  const vy0 = -view.y / view.k
  const vx1 = vx0 + size.w / view.k
  const vy1 = vy0 + size.h / view.k
  const x0 = Math.min(bounds.x0, vx0) - 40
  const y0 = Math.min(bounds.y0, vy0) - 40
  const x1 = Math.max(bounds.x1, vx1) + 40
  const y1 = Math.max(bounds.y1, vy1) + 40
  const s = Math.min(MW / (x1 - x0), MH / (y1 - y0))
  const ox = (MW - (x1 - x0) * s) / 2
  const oy = (MH - (y1 - y0) * s) / 2
  const px = (x: number): number => ox + (x - x0) * s
  const py = (y: number): number => oy + (y - y0) * s
  const go = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    onCenter((e.clientX - r.left - ox) / s + x0, (e.clientY - r.top - oy) / s + y0)
  }
  const accent = new Map(team.map((a) => [a.id, (accentVars(a.accent) as Record<string, string>)['--a2']]))
  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation()
        capture(e.currentTarget, e.pointerId)
        go(e)
      }}
      onPointerMove={(e) => e.buttons === 1 && go(e)}
      className="pointer-events-auto relative animate-fade-in cursor-pointer overflow-hidden rounded-[12px] bg-surface/90 shadow-float backdrop-blur-sm"
      style={{ width: MW, height: MH }}
      title="Click to move there"
    >
      {Object.entries(at).map(([id, p]) => {
        const sz = sizeOf(id, leadId)
        return (
          <span
            key={id}
            className="absolute rounded-[3px]"
            style={{ left: px(p.x - sz.w / 2), top: py(p.y - sz.h / 2), width: Math.max(4, sz.w * s), height: Math.max(3, sz.h * s), background: id === YOU ? 'var(--ink-3)' : accent.get(id) || 'var(--ink-4)', opacity: 0.85 }}
          />
        )
      })}
      <span className="absolute rounded-[4px] border-[1.5px] border-link bg-[color-mix(in_oklab,var(--link)_8%,transparent)]" style={{ left: px(vx0), top: py(vy0), width: (vx1 - vx0) * s, height: (vy1 - vy0) * s }} />
    </div>
  )
}
