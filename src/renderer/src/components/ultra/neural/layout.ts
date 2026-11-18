// A chat's team as a neural network: every neuron is a real agent, every line a real hand-off.
// Columns follow how the work flows: the lead first, then whoever it handed work to, then whoever
// waited on them or was started by them, and so on. Agents of a kind sit together in a column.

import type { Account, Task } from '@shared/types'
import { baseName } from '../groups'

export type NeuronState = 'working' | 'asking' | 'waiting' | 'done' | 'trouble' | 'idle' | 'gone'

export interface Neuron {
  id: string
  account: Account
  lead: boolean
  /** Who started it (or the lead, for a teammate account). */
  parent?: string
  /** Which column it sits in: 0 is the lead. */
  col: number
  /** 0 for the lead and the accounts, then the depth it was started at. */
  depth: number
  /** Agents of a kind share a group: "scout", "builder". Accounts are each their own. */
  group: string
}

export type LinkKind = 'handoff' | 'wait' | 'started'

export interface Link {
  key: string
  from: string
  to: string
  kind: LinkKind
  /** Hand-offs: tasks under way along it, done, failed. A wait: whether it is still being waited on. */
  live: number
  done: number
  failed: number
}

export interface Net {
  neurons: Neuron[]
  links: Link[]
  /** Deepest level of agents started by agents (1 when only the lead started any). */
  depth: number
}

/** Builds the network from the team and its tasks. `team` should keep agents that were sent home. */
export function buildNeural(team: Account[], leadId: string | undefined, tasks: Task[]): Net {
  const ids = new Set(team.map((a) => a.id))
  const lead = leadId && ids.has(leadId) ? leadId : team[0]?.id
  const byTask = new Map(tasks.map((t) => [t.id, t]))

  const parentOf = (a: Account): string | undefined => {
    if (a.id === lead) return undefined
    const by = a.spawned?.by
    return by && ids.has(by) && by !== a.id ? by : lead
  }

  // Columns: at least one past whoever started it, and one past whoever it waits on.
  const col = new Map<string, number>()
  for (const a of team) col.set(a.id, a.id === lead ? 0 : 1)
  const before: [string, string][] = []
  for (const a of team) {
    const p = parentOf(a)
    if (p) before.push([p, a.id])
  }
  for (const t of tasks) {
    if (!ids.has(t.to)) continue
    if (ids.has(t.from) && t.from !== t.to && t.to !== lead) before.push([t.from, t.to])
    for (const a of t.after || []) {
      const src = byTask.get(a)?.to
      if (src && ids.has(src) && src !== t.to && t.to !== lead && src !== lead) before.push([src, t.to])
    }
  }
  for (let round = 0; round < 12; round++) {
    let moved = false
    for (const [a, b] of before) {
      const want = Math.min((col.get(a) ?? 0) + 1, 9)
      if ((col.get(b) ?? 1) < want) {
        col.set(b, want)
        moved = true
      }
    }
    if (!moved) break
  }

  const neurons: Neuron[] = team.map((a) => ({
    id: a.id,
    account: a,
    lead: a.id === lead,
    parent: parentOf(a),
    col: col.get(a.id) ?? 1,
    depth: a.spawned?.depth ?? 0,
    group: a.spawned ? baseName(a.name).toLowerCase() : `account:${a.id}`,
  }))

  const links = new Map<string, Link>()
  const add = (from: string, to: string, kind: LinkKind): Link => {
    const key = `${kind}:${from}>${to}`
    let l = links.get(key)
    if (!l) {
      l = { key, from, to, kind, live: 0, done: 0, failed: 0 }
      links.set(key, l)
    }
    return l
  }
  for (const t of tasks) {
    if (!ids.has(t.from) || !ids.has(t.to) || t.from === t.to) continue
    const l = add(t.from, t.to, 'handoff')
    if (t.status === 'running' || t.status === 'queued') l.live++
    else if (t.status === 'done') l.done++
    else if (t.status === 'failed' || t.status === 'interrupted') l.failed++
    for (const a of t.after || []) {
      const dep = byTask.get(a)
      if (!dep || !ids.has(dep.to) || dep.to === t.to) continue
      const w = add(dep.to, t.to, 'wait')
      if (dep.status === 'running' || dep.status === 'queued') w.live++
      else w.done++
    }
  }
  // Everyone hangs off someone, even before any work went their way.
  const fed = new Set([...links.values()].filter((l) => l.kind === 'handoff').map((l) => l.to))
  for (const n of neurons) if (n.parent && !fed.has(n.id)) add(n.parent, n.id, 'started')

  const depth = Math.max(0, ...neurons.map((n) => n.depth))
  return { neurons, links: [...links.values()], depth }
}

export interface Placed {
  x: number
  y: number
  r: number
}

export interface Shape {
  width: number
  height: number
  padX: number
  padTop: number
  padBottom: number
  /** Least room between two neurons above each other. */
  gap: number
  /** Most room between two neurons above each other, so a short column does not spread thin. */
  maxGap: number
  /** Radius of the lead, of an agent the lead started, and of one started deeper. */
  radius: [number, number, number]
  /** Most room between two columns, so a young network sits together in the middle instead of at the edges. */
  maxStep: number
}

export interface Block {
  /** `${col}|${group}` */
  key: string
  ids: string[]
  /** Where its members sit on average, and its left edge. */
  x: number
  y: number
  left: number
  top: number
  bottom: number
}

export interface Layout {
  pos: Map<string, Placed>
  /** Where to put the name of each group of three or more in one column. */
  groups: { key: string; label: string; x: number; y: number; count: number }[]
  /** Each group in each column, for drawing bundles and bands to and from it. */
  blocks: Map<string, Block>
  /** Which block a neuron belongs to. */
  blockOf: Map<string, string>
}

/**
 * Places the neurons. Columns are spread across the width and the whole is centred; inside a
 * column, neurons sit near those they come from (so lines cross little), with air between groups.
 * A column too tall for the height wraps into orderly sub-columns, filled top to bottom, so a
 * group stays together and nothing interleaves.
 */
export function layoutNeural(net: Net, s: Shape & { subW?: number }): Layout {
  const pos = new Map<string, Placed>()
  const groups: Layout['groups'] = []
  const blocksOut = new Map<string, Block>()
  const blockOf = new Map<string, string>()
  if (!net.neurons.length || s.width <= 0 || s.height <= 0) return { pos, groups, blocks: blocksOut, blockOf }

  const maxCol = Math.max(...net.neurons.map((n) => n.col))
  const cols: Neuron[][] = Array.from({ length: maxCol + 1 }, () => [])
  for (const n of net.neurons) cols[n.col].push(n)
  const used = cols.filter((c) => c.length)

  const incoming = new Map<string, string[]>()
  for (const l of net.links) incoming.set(l.to, [...(incoming.get(l.to) || []), l.from])
  const rank = new Map<string, number>()
  const order = new Map(net.neurons.map((n, i) => [n.id, i]))

  const span = Math.max(1, s.height - s.padTop - s.padBottom)
  const fit = Math.max(2, Math.floor(span / s.gap) + 1)
  const inner = Math.max(1, s.width - 2 * s.padX)
  const plan = used.map((c) => {
    // Sit near whoever feeds you; keep a group together around its own average.
    const bary = (n: Neuron): number => {
      const src = (incoming.get(n.id) || []).map((id) => rank.get(id)).filter((v): v is number => v !== undefined)
      return src.length ? src.reduce((a, b) => a + b, 0) / src.length : (order.get(n.id) ?? 0) / Math.max(1, net.neurons.length)
    }
    const byGroup = new Map<string, Neuron[]>()
    for (const n of c) byGroup.set(n.group, [...(byGroup.get(n.group) || []), n])
    const blocks = [...byGroup.values()]
      .map((g) => {
        const inside = g.map((n) => ({ n, b: bary(n) })).sort((a, b) => a.b - b.b || (order.get(a.n.id) ?? 0) - (order.get(b.n.id) ?? 0))
        return { g: inside.map((x) => x.n), b: inside.reduce((a, x) => a + x.b, 0) / inside.length, first: Math.min(...g.map((n) => order.get(n.id) ?? 0)) }
      })
      .sort((a, b) => a.b - b.b || a.first - b.first)
    const list = blocks.flatMap((x) => x.g)
    list.forEach((n, i) => rank.set(n.id, list.length > 1 ? i / (list.length - 1) : 0.5))
    // Rows needed: one per neuron plus a little air between groups.
    const rows = list.length + Math.max(0, blocks.length - 1) * 0.6
    const subs = Math.max(1, Math.ceil(rows / fit))
    return { list, blocks: blocks.map((x) => x.g), subs, rows }
  })

  const subW = Math.min(s.subW ?? 84, inner / Math.max(1, used.length) / 1.6)
  const widths = plan.map((p) => (p.subs - 1) * subW)
  const free = inner - widths.reduce((a, b) => a + b, 0)
  const step = plan.length > 1 ? Math.min(s.maxStep, free / (plan.length - 1)) : 0
  const whole = widths.reduce((a, b) => a + b, 0) + step * (plan.length - 1)
  let x = s.width / 2 - whole / 2

  plan.forEach((p, ci) => {
    const perRows = Math.ceil(p.rows / p.subs)
    const dy = perRows > 1 ? Math.min(s.maxGap, span / Math.max(1, perRows - 1)) : 0
    // Lay out a sequence of slots, a group break counting as 0.6 of a row; wrap to the next
    // sub-column when one is full, and never start a sub-column with a break.
    let sub = 0
    let row = 0
    const placed: { n: Neuron; sub: number; row: number }[] = []
    p.blocks.forEach((block, bi) => {
      if (bi > 0 && row > 0) row += 0.6
      // A small group does not split over two sub-columns when it fits in the next one.
      if (row > 0 && row + block.length - 1 > perRows - 1 + 0.01 && block.length <= perRows) {
        sub++
        row = 0
      }
      for (const n of block) {
        if (row > perRows - 1 + 0.01) {
          sub++
          row = 0
        }
        placed.push({ n, sub, row })
        row++
      }
    })
    // Each sub-column is centred on its own height.
    const heights = new Map<number, number>()
    for (const q of placed) heights.set(q.sub, Math.max(heights.get(q.sub) ?? 0, q.row))
    for (const q of placed) {
      const hgt = (heights.get(q.sub) ?? 0) * dy
      const y = s.padTop + span / 2 - hgt / 2 + q.row * dy
      const n = q.n
      const r = n.lead ? s.radius[0] : n.depth >= 2 ? s.radius[2] : s.radius[1]
      pos.set(n.id, { x: x + q.sub * subW, y: Math.min(s.padTop + span, Math.max(s.padTop, y)), r })
    }
    for (const block of p.blocks) {
      const ps = block.map((n) => pos.get(n.id) as Placed)
      const key = `${ci}|${block[0].group}`
      blocksOut.set(key, {
        key,
        ids: block.map((n) => n.id),
        x: ps.reduce((a, q) => a + q.x, 0) / ps.length,
        y: ps.reduce((a, q) => a + q.y, 0) / ps.length,
        left: Math.min(...ps.map((q) => q.x)),
        top: Math.min(...ps.map((q) => q.y)),
        bottom: Math.max(...ps.map((q) => q.y)),
      })
      for (const n of block) blockOf.set(n.id, key)
      if (block.length >= 3 && block[0].account.spawned) {
        const top = Math.min(...ps.map((q) => q.y - q.r))
        const cx = (Math.min(...ps.map((q) => q.x)) + Math.max(...ps.map((q) => q.x))) / 2
        groups.push({ key, label: block[0].group, x: cx, y: top, count: block.length })
      }
    }
    x += widths[ci] + step
  })
  return { pos, groups, blocks: blocksOut, blockOf }
}

/** A soft curve from one neuron to the next: it leaves forwards and arrives from behind. */
export function synapse(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const r = (n: number): number => Math.round(n * 10) / 10
  const dx = b.x - a.x
  if (dx > 8) {
    const c = dx * 0.55
    return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + c)} ${r(a.y)} ${r(b.x - c)} ${r(b.y)} ${r(b.x)} ${r(b.y)}`
  }
  // In the same column: bow out to the right.
  const bow = 26 + Math.abs(b.y - a.y) * 0.25
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + bow)} ${r(a.y)} ${r(b.x + bow)} ${r(b.y)} ${r(b.x)} ${r(b.y)}`
}
