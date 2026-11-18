// Flow and tree diagrams with an automatic layered layout: each node goes one layer after
// whatever leads to it, layers are ordered to keep links from crossing, and links are drawn as
// soft curves with a small arrow.
import { useMemo, useState } from 'react'
import type { DiagramBlock } from '@shared/iui'
import { Card } from './kit'
import { fit, seriesColor, textWidth, useWidth } from './Chart'

const NODE_H = 34
const PAD_X = 14
const MIN_W = 72
const MAX_W = 190
const GAP_LAYER = 64
const GAP_NODE = 16

type Placed = { id: string; label: string; text: string; group?: string; x: number; y: number; w: number; layer: number }

export function layout(b: DiagramBlock, direction: 'right' | 'down' = b.direction): { nodes: Placed[]; width: number; height: number; back: boolean } {
  const ids = b.nodes.map((n) => n.id)
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  const into = new Map<string, string[]>(ids.map((id) => [id, []]))
  // Links that would close a loop are left out of the layering (they are still drawn).
  const state = new Map<string, number>()
  const forward: { from: string; to: string }[] = []
  const visit = (id: string): void => {
    state.set(id, 1)
    for (const e of b.edges) {
      if (e.from !== id) continue
      const s = state.get(e.to) || 0
      if (s === 1) continue
      forward.push(e)
      if (s === 0) visit(e.to)
    }
    state.set(id, 2)
  }
  const roots = ids.filter((id) => !b.edges.some((e) => e.to === id))
  for (const r of roots.length ? roots : ids.slice(0, 1)) if (!state.get(r)) visit(r)
  for (const id of ids) if (!state.get(id)) visit(id)
  for (const e of forward) {
    if (!out.get(e.from)!.includes(e.to)) out.get(e.from)!.push(e.to)
    if (!into.get(e.to)!.includes(e.from)) into.get(e.to)!.push(e.from)
  }
  // Longest path from a start.
  const layer = new Map<string, number>()
  const order: string[] = []
  const indeg = new Map(ids.map((id) => [id, into.get(id)!.length]))
  const queue = ids.filter((id) => indeg.get(id) === 0)
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const t of out.get(id)!) {
      layer.set(t, Math.max(layer.get(t) || 0, (layer.get(id) || 0) + 1))
      indeg.set(t, indeg.get(t)! - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0)
  const layers: string[][] = []
  for (const id of ids) {
    const l = layer.get(id)!
    ;(layers[l] ||= []).push(id)
  }
  for (let i = 0; i < layers.length; i++) layers[i] ||= []
  // A few sweeps of the barycentre rule keep links from crossing.
  const pos = new Map<string, number>()
  const index = (): void => layers.forEach((L) => L.forEach((id, i) => pos.set(id, i)))
  index()
  const bary = (id: string, nbrs: string[]): number => (nbrs.length ? nbrs.reduce((t, n) => t + (pos.get(n) || 0), 0) / nbrs.length : pos.get(id) || 0)
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse()
    for (const i of range) {
      layers[i].sort((a, c) => bary(a, down ? into.get(a)! : out.get(a)!) - bary(c, down ? into.get(c)! : out.get(c)!))
      layers[i].forEach((id, k) => pos.set(id, k))
    }
  }
  const byId = new Map(b.nodes.map((n) => [n.id, n]))
  const across = direction === 'right'
  // A node with a group wears a dot before its name, which needs room of its own.
  const sizes = new Map(ids.map((id) => [id, Math.max(MIN_W, Math.min(MAX_W, textWidth(byId.get(id)!.label, 12.5, 500) + PAD_X * 2 + (byId.get(id)!.group ? 12 : 0)))]))
  // Along the flow: each layer is as deep as its widest node (across) or one node tall (down).
  const depth = layers.map((L) => (across ? Math.max(...L.map((id) => sizes.get(id)!), MIN_W) : NODE_H))
  const lane = layers.map((L) => L.reduce((t, id) => t + (across ? NODE_H : sizes.get(id)!) + GAP_NODE, -GAP_NODE))
  const span = Math.max(...lane)
  const nodes: Placed[] = []
  let at = 0
  layers.forEach((L, li) => {
    let off = (span - lane[li]) / 2
    for (const id of L) {
      const n = byId.get(id)!
      const w = sizes.get(id)!
      const x = across ? at + (depth[li] - w) / 2 : off
      const y = across ? off : at
      nodes.push({ id, label: n.label, text: fit(n.label, w - PAD_X * 2 - (n.group ? 12 : 0) + 2, 12.5), group: n.group, x, y, w, layer: li })
      off += (across ? NODE_H : w) + GAP_NODE
    }
    at += depth[li] + (across ? GAP_LAYER : GAP_LAYER - 18)
  })
  const width = across ? at - GAP_LAYER : span
  const height = across ? span : at - (GAP_LAYER - 18)
  const lay = new Map(nodes.map((n) => [n.id, n.layer]))
  const back = b.edges.some((e) => (lay.get(e.to) ?? 0) <= (lay.get(e.from) ?? 0))
  return { nodes, width: Math.max(width, 1), height: Math.max(height, NODE_H), back }
}

export function Diagram({ block }: { block: DiagramBlock }) {
  const [box, avail] = useWidth<HTMLDivElement>()
  // The way the model asked for, unless the other way fits the space much better.
  const { nodes, width, height, back, direction } = useMemo(() => {
    const want = layout(block)
    const other = block.direction === 'right' ? 'down' : 'right'
    const alt = layout(block, other)
    const fitOf = (l: { width: number }): number => (avail ? Math.min(1, avail / (l.width + 16)) : 1)
    return fitOf(want) < 0.92 && fitOf(alt) > fitOf(want) + 0.08 ? { ...alt, direction: other } : { ...want, direction: block.direction }
  }, [block, avail])
  const [hover, setHover] = useState<string | null>(null)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const groups = [...new Set(nodes.map((n) => n.group).filter(Boolean))] as string[]
  const across = direction === 'right'
  const pad = 6
  const edges = block.edges
    .map((e, i) => {
      const a = byId.get(e.from)
      const c = byId.get(e.to)
      if (!a || !c) return null
      let d: string
      let mx: number
      let my: number
      const back = c.layer <= a.layer
      if (across) {
        const x1 = back ? a.x + a.w / 2 : a.x + a.w
        const y1 = back ? a.y + NODE_H : a.y + NODE_H / 2
        const x2 = back ? c.x + c.w / 2 : c.x - 4
        const y2 = back ? c.y + NODE_H : c.y + NODE_H / 2
        if (back) {
          const dip = Math.max(y1, y2) + 30
          d = `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2 + 4}`
          mx = (x1 + x2) / 2
          my = dip - 8
        } else {
          const k = Math.max(24, (x2 - x1) / 2)
          d = `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`
          mx = (x1 + x2) / 2
          my = (y1 + y2) / 2
        }
      } else {
        const x1 = a.x + a.w / 2
        const y1 = a.y + NODE_H
        const x2 = c.x + c.w / 2
        const y2 = back ? c.y + NODE_H / 2 : c.y - 4
        const k = Math.max(16, Math.abs(y2 - y1) / 2)
        d = back ? `M${a.x + a.w},${a.y + NODE_H / 2} C${a.x + a.w + 40},${a.y} ${c.x + c.w + 40},${c.y + NODE_H} ${c.x + c.w + 4},${c.y + NODE_H / 2}` : `M${x1},${y1} C${x1},${y1 + k} ${x2},${y2 - k} ${x2},${y2}`
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2
      }
      const on = !hover || hover === e.from || hover === e.to
      return { key: i, d, mx, my, label: e.label, on }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  const W = width + pad * 2 + (across || !back ? 0 : 48)
  const H = height + pad * 2 + (back && across ? 34 : 0)
  // Wider than the space: drawn smaller, down to three quarters, then it scrolls.
  const scale = avail ? Math.max(0.75, Math.min(1, avail / W)) : 1
  const story = block.edges.map((e) => `${byId.get(e.from)?.label} to ${byId.get(e.to)?.label}${e.label ? ` (${e.label})` : ''}`).join('; ')
  return (
    <Card title={block.title} label="Diagram">
      <div ref={box} className="-mx-1 overflow-x-auto px-1 pb-1">
        <svg width={W * scale} height={H * scale} viewBox={`${-pad} ${-pad} ${W} ${H}`} role="img" aria-label={`${block.kind === 'tree' ? 'Tree' : 'Flow'} diagram${block.title ? `: ${block.title}` : ''}. ${nodes.length} nodes. ${story}`} className="mx-auto block">
          <defs>
            <marker id="iui-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1,1 L7,4 L1,7" fill="none" stroke="var(--ink-3)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>
          {edges.map((e) => (
            <path key={e.key} d={e.d} fill="none" stroke={e.on && hover ? 'var(--ink-2)' : 'var(--ink-4)'} strokeWidth={e.on && hover ? 1.6 : 1.25} markerEnd="url(#iui-arrow)" opacity={e.on ? 1 : 0.35} style={{ transition: 'opacity .15s, stroke .15s' }} />
          ))}
          {edges.map((e) =>
            e.label ? (
              <g key={`l${e.key}`} opacity={e.on ? 1 : 0.35}>
                <rect x={e.mx - textWidth(e.label, 10.5) / 2 - 5} y={e.my - 9} width={textWidth(e.label, 10.5) + 10} height={17} rx={5} fill="var(--surface)" stroke="var(--line)" />
                <text x={e.mx} y={e.my} dy="0.34em" textAnchor="middle" fontSize={10.5} fill="var(--ink-2)">
                  {e.label}
                </text>
              </g>
            ) : null,
          )}
          {nodes.map((n) => {
            const g = n.group ? groups.indexOf(n.group) : -1
            const on = !hover || hover === n.id || block.edges.some((e) => (e.from === hover && e.to === n.id) || (e.to === hover && e.from === n.id))
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} opacity={on ? 1 : 0.45} style={{ transition: 'opacity .15s' }}>
                <title>{n.label}</title>
                <rect width={n.w} height={NODE_H} rx={9} fill={g >= 0 ? `color-mix(in oklab, ${seriesColor(g)} 10%, var(--surface))` : 'var(--surface-2)'} stroke={hover === n.id ? 'var(--ink-3)' : g >= 0 ? `color-mix(in oklab, ${seriesColor(g)} 45%, transparent)` : 'var(--line-2)'} strokeWidth={1} />
                {g >= 0 && <circle cx={11} cy={NODE_H / 2} r={3} fill={seriesColor(g)} />}
                <text x={n.w / 2 + (g >= 0 ? 6 : 0)} y={NODE_H / 2} dy="0.35em" textAnchor="middle" fontSize={12.5} fontWeight={500} fill="var(--ink)">
                  {n.text}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      {groups.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
          {groups.map((g, i) => (
            <span key={g} className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
              <span className="size-2 rounded-full" style={{ background: seriesColor(i) }} />
              {g}
            </span>
          ))}
        </div>
      )}
    </Card>
  )
}
