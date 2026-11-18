// The shape of a chat's team as a network: who is in it, who started whom, and the work handed
// between them, laid out in layers like a neural network (the lead on the left, the agents it
// started next, their sub-agents after them).

import type { Account, Task } from '@shared/types'

export interface NetNode {
  id: string
  account: Account
  /** 0 for the lead, 1 for whoever the lead works with or started, 2 for their sub-agents. */
  layer: number
  /** Who started it, or the lead for the other accounts. */
  parent?: string
  lead: boolean
}

export interface NetEdge {
  key: string
  from: string
  to: string
  /** Tasks handed along this edge so far. */
  tasks: number
  /** Of those, still queued or under way. */
  live: number
  done: number
  failed: number
  /** No task went along it yet: it only says who started whom. */
  structural: boolean
}

export interface Net {
  nodes: NetNode[]
  edges: NetEdge[]
}

export function buildNet(team: Account[], leadId: string | undefined, tasks: Task[]): Net {
  const ids = new Set(team.map((a) => a.id))
  const lead = leadId && ids.has(leadId) ? leadId : team[0]?.id
  const byId = new Map(team.map((a) => [a.id, a]))
  const layers = new Map<string, number>()
  const parentOf = (a: Account): string | undefined => {
    if (a.id === lead) return undefined
    const by = a.spawned?.by
    return by && ids.has(by) && by !== a.id ? by : lead
  }
  const layerOf = (a: Account, depth = 0): number => {
    const known = layers.get(a.id)
    if (known !== undefined) return known
    const p = parentOf(a)
    const pa = p ? byId.get(p) : undefined
    const l = !pa || depth > 6 ? 0 : layerOf(pa, depth + 1) + 1
    layers.set(a.id, l)
    return l
  }
  const nodes: NetNode[] = team.map((a) => ({ id: a.id, account: a, layer: layerOf(a), parent: parentOf(a), lead: a.id === lead }))

  const edges = new Map<string, NetEdge>()
  for (const t of tasks) {
    if (!ids.has(t.from) || !ids.has(t.to) || t.from === t.to) continue
    const key = `${t.from}>${t.to}`
    const e = edges.get(key) || { key, from: t.from, to: t.to, tasks: 0, live: 0, done: 0, failed: 0, structural: false }
    e.tasks++
    if (t.status === 'queued' || t.status === 'running') e.live++
    else if (t.status === 'done') e.done++
    else if (t.status === 'failed') e.failed++
    edges.set(key, e)
  }
  // Everyone hangs off someone, even before any work went their way.
  const fed = new Set([...edges.values()].map((e) => e.to))
  for (const n of nodes) {
    if (!n.parent || fed.has(n.id)) continue
    const key = `${n.parent}>${n.id}`
    edges.set(key, { key, from: n.parent, to: n.id, tasks: 0, live: 0, done: 0, failed: 0, structural: true })
  }
  return { nodes, edges: [...edges.values()] }
}

export interface Shape {
  height: number
  /** Room kept free at the left and right, and at the top and bottom. */
  padX: number
  padY: number
  /** The least distance between two nodes above each other. */
  gap: number
  /** The distance between two sub-columns of one crowded layer. */
  sub: number
}

/**
 * Where each node goes in a box `width` wide. Layers become columns from left to right; a layer
 * with more nodes than fit in one column spreads over several, offset by half a step so they
 * interlock.
 */
export function place(nodes: NetNode[], width: number, shape: Shape): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (!nodes.length || width <= 0) return out
  const { height, padX, padY, gap, sub } = shape
  const max = Math.max(...nodes.map((n) => n.layer))
  const cols: NetNode[][] = Array.from({ length: max + 1 }, () => [])
  for (const n of nodes) cols[n.layer].push(n)
  // Children sit in the order of their parents, so lines cross as little as they can.
  for (let l = 1; l < cols.length; l++) {
    const order = new Map(cols[l - 1].map((n, i) => [n.id, i]))
    cols[l] = cols[l]
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (order.get(a.n.parent || '') ?? 999) - (order.get(b.n.parent || '') ?? 999) || a.i - b.i)
      .map((x) => x.n)
  }
  const used = cols.filter((c) => c.length)
  const span = Math.max(height - 2 * padY, 1)
  const fit = Math.max(1, Math.floor(span / gap) + 1)
  const plan = used.map((c) => {
    const subs = Math.ceil(c.length / fit)
    return { c, subs, per: Math.ceil(c.length / subs), w: (subs - 1) * sub }
  })
  const inner = Math.max(width - 2 * padX, 1)
  const free = inner - plan.reduce((s, p) => s + p.w, 0)
  const step = plan.length > 1 ? Math.max(free / (plan.length - 1), sub) : 0
  let x = plan.length > 1 ? padX : width / 2 - plan[0].w / 2
  for (const p of plan) {
    p.c.forEach((n, i) => {
      const col = Math.floor(i / p.per)
      const row = i % p.per
      const m = col === p.subs - 1 ? p.c.length - col * p.per : p.per
      const dy = m > 1 ? Math.min(gap * 1.9, span / (m - 1)) : 0
      // Every other sub-column is set half a step down, like cells in a honeycomb.
      // Only as far as the free room allows, so nothing leaves the box.
      const stagger = p.subs > 1 && col % 2 === 1 && m < fit ? Math.min(dy / 2, Math.max(0, (span - (m - 1) * dy) / 2)) : 0
      out.set(n.id, { x: x + col * sub, y: height / 2 + (row - (m - 1) / 2) * dy + stagger })
    })
    x += p.w + step
  }
  return out
}

/** A soft curve from one node to the next, leaving forwards and arriving from behind. */
export function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const r = (n: number): number => Math.round(n * 10) / 10
  const dx = b.x - a.x
  if (dx > 6) {
    const c = dx * 0.5
    return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + c)} ${r(a.y)} ${r(b.x - c)} ${r(b.y)} ${r(b.x)} ${r(b.y)}`
  }
  // Same column, or backwards: bow out to the right.
  const bow = 28 + Math.abs(b.y - a.y) * 0.2
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + bow)} ${r(a.y)} ${r(b.x + bow)} ${r(b.y)} ${r(b.x)} ${r(b.y)}`
}
