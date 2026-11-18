// The team as a brain: the lead at the centre with the goal around it, and around the lead its
// regions. A region is everything one agent the lead started went on to start (its subtree);
// regions that do the same kind of work (four builders, eight scouts) share one. Inside a region,
// helpers sit near whoever started them, deeper ones further out. Nothing here draws: it only
// works out where things go, from the same network the Team tab draws.

import type { AccentKey } from '@shared/types'
import type { Net, Neuron } from '../ultra/neural/layout'
import { plural } from '../ultra/groups'

export interface Region {
  key: string
  /** "Research", "Building", or the agents' own name when the kind is not clear. */
  label: string
  /** The colour the region is tinted with. */
  tone: AccentKey
  /** The agents the lead started that head this region, in the order they were started. */
  heads: string[]
  /** Everyone in it, heads first, then by depth. */
  ids: string[]
}

/** Kinds of work, tried in order: the first that matches the agents' names (then roles) wins. */
const KINDS: { label: string; tone: AccentKey; re: RegExp }[] = [
  { label: 'Memory', tone: 'amber', re: /memory|archiv|librar|record|board keeper|note.?keep|historian/i },
  { label: 'Critique', tone: 'rose', re: /critic|critique|review|red.?team|skeptic|devil/i },
  { label: 'Judging', tone: 'green', re: /judg|scor|rank|grade|jury/i },
  { label: 'Verification', tone: 'teal', re: /verif|fact|check|test|audit|\bqa\b|proof/i },
  { label: 'Research', tone: 'blue', re: /scout|research|search|source|explor|analy|investig|survey/i },
  { label: 'Building', tone: 'violet', re: /build|maker|writer|coder|develop|engineer|design|draft|implement|author/i },
  { label: 'Integration', tone: 'clay', re: /integrat|merg|synth|editor|assembl|final/i },
]

function kindOf(n: Neuron): (typeof KINDS)[number] | undefined {
  const name = n.account.name
  return KINDS.find((k) => k.re.test(n.group) || k.re.test(name)) || KINDS.find((k) => k.re.test(n.account.role || ''))
}

/** Splits the network into regions. The lead belongs to none. */
export function regionsOf(net: Net): Region[] {
  const byId = new Map(net.neurons.map((n) => [n.id, n]))
  const lead = net.neurons.find((n) => n.lead)
  const order = new Map(net.neurons.map((n, i) => [n.id, (n.account.spawned?.at ?? 0) * 1000 + i]))
  // The agent the lead started that each agent descends from.
  const headOf = new Map<string, string>()
  const climb = (n: Neuron): string => {
    const seen = new Set<string>()
    let cur = n
    while (cur.parent && cur.parent !== lead?.id && byId.has(cur.parent) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.parent) as Neuron
    }
    return cur.id
  }
  for (const n of net.neurons) if (!n.lead) headOf.set(n.id, climb(n))

  const regions = new Map<string, Region & { first: number }>()
  const heads = [...new Set(headOf.values())].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  for (const h of heads) {
    const n = byId.get(h) as Neuron
    const kind = kindOf(n)
    const key = kind ? `k:${kind.label}` : `g:${n.group}`
    let r = regions.get(key)
    if (!r) {
      r = { key, label: kind?.label || '', tone: kind?.tone || 'slate', heads: [], ids: [], first: order.get(h) ?? 0 }
      regions.set(key, r)
    }
    r.heads.push(h)
  }
  for (const r of regions.values()) {
    if (!r.label) {
      const first = byId.get(r.heads[0]) as Neuron
      const word = first.account.spawned ? first.group.charAt(0).toUpperCase() + first.group.slice(1) : first.account.name
      r.label = r.heads.length > 1 ? plural(word) : first.account.spawned ? first.account.name : word
    }
    // Heads first, then their helpers level by level, each level in the order its parents came.
    const inRegion = new Set(r.heads)
    for (const [id, h] of headOf) if (inRegion.has(h)) inRegion.add(id)
    const list: string[] = [...r.heads]
    let level = r.heads
    while (level.length) {
      const next: string[] = []
      for (const p of level)
        for (const n of net.neurons) if (n.parent === p && inRegion.has(n.id) && !list.includes(n.id)) next.push(n.id)
      next.sort((a, b) => list.indexOf(byId.get(a)?.parent ?? '') - list.indexOf(byId.get(b)?.parent ?? '') || (order.get(a) ?? 0) - (order.get(b) ?? 0))
      list.push(...next)
      level = next
    }
    r.ids = list
  }
  return [...regions.values()].sort((a, b) => a.first - b.first).map(({ first: _f, ...r }) => r)
}

// ───────────── where everything goes ─────────────

export interface Spot {
  x: number
  y: number
  r: number
}

export interface Lobe {
  key: string
  /** Its soft outline: a smooth closed path around its members. */
  d: string
  cx: number
  cy: number
  /** Its size: the circle the layout kept free for it, and the box its outline fills. */
  R: number
  box: { l: number; t: number; r: number; b: number }
  /** Where its name may go: centred above it or below it. The drawing picks the side that is free. */
  above: { x: number; y: number }
  below: { x: number; y: number }
  /** The side it would rather have: away from the centre. */
  prefer: 'above' | 'below'
}

export interface BrainLayout {
  pos: Map<string, Spot>
  lobes: Map<string, Lobe>
  centre: { x: number; y: number }
  /** The lead's radius; the goal ring sits just outside it. */
  leadR: number
  /** The room between neighbours, which the drawing scales its marks by. */
  step: number
}

export interface Frame {
  width: number
  height: number
  /** Room kept free at the top and bottom for the panel's own lines. */
  top: number
  bottom: number
  /** Room kept free around the goal at the centre. */
  core: number
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/** A smooth closed curve through the points (Catmull-Rom, as cubic Béziers). */
function smoothClosed(pts: { x: number; y: number }[]): string {
  if (pts.length < 3) return ''
  const r = (v: number): number => Math.round(v * 10) / 10
  const n = pts.length
  let d = `M ${r(pts[0].x)} ${r(pts[0].y)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    d += ` C ${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(p2.x)} ${r(p2.y)}`
  }
  return `${d} Z`
}

/** The convex hull of the points (monotone chain), counter-clockwise. */
function hull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: typeof p = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: typeof p = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

interface Disc {
  r: Region
  n: number
  R: number
  x: number
  y: number
}

/** Places the regions around the lead and their members inside them. */
export function layoutBrain(net: Net, regions: Region[], f: Frame): BrainLayout {
  const pos = new Map<string, Spot>()
  const lobes = new Map<string, Lobe>()
  const cx = f.width / 2
  const top = f.top
  const bottom = f.height - f.bottom
  const cy = (top + bottom) / 2
  const lead = net.neurons.find((n) => n.lead)
  const total = net.neurons.length
  const leadR = total > 30 ? 17 : total > 14 ? 19 : 21
  const out: BrainLayout = { pos, lobes, centre: { x: cx, y: cy }, leadR, step: 30 }
  if (f.width <= 0 || f.height <= 0) return out
  if (lead) pos.set(lead.id, { x: cx, y: cy, r: leadR })
  if (!regions.length) return out

  const padX = 26
  const labelRoom = 20
  const byId = new Map(net.neurons.map((n) => [n.id, n]))

  // Try the roomiest spacing first and tighten until the regions fit without overlapping.
  let discs: Disc[] = []
  let step = 34
  for (; step >= 15; step -= 1.5) {
    const c = step / 1.75
    discs = regions.map((r) => ({ r, n: r.ids.length, R: c * Math.sqrt(r.ids.length + 0.6) + step * 0.55, x: cx, y: cy }))
    // Two hemispheres: each region goes to the lighter side, so the brain stays balanced and
    // uses the width; on each side they run top to bottom in the order they were started.
    const sides: Disc[][] = [[], []]
    const weight = [0, 0]
    for (const d of discs) {
      const k = discs.length === 1 ? 1 : weight[0] <= weight[1] ? 0 : 1
      sides[k].push(d)
      weight[k] += d.R * d.R
    }
    sides.forEach((list, k) => {
      const sum = list.reduce((a, d) => a + d.R * 2 + 14, 0)
      // Left runs from upper left to lower left (angles falling), right from upper right to lower right.
      const range = Math.min(Math.PI * 0.86, Math.PI * 0.32 * Math.max(1, list.length - 0.4))
      let acc = 0
      for (const d of list) {
        const share = list.length === 1 ? 0.5 : (acc + d.R + 7) / sum
        acc += d.R * 2 + 14
        const t = (share - 0.5) * range
        const a = k === 0 ? Math.PI - t : t
        const ax = Math.max(f.core + d.R, f.width / 2 - padX - d.R)
        const ay = Math.max(f.core + d.R, (bottom - top) / 2 - labelRoom - d.R)
        d.x = cx + Math.cos(a) * ax * 0.78
        d.y = cy + Math.sin(a) * ay * 0.78
      }
    })
    // Settle: apart from each other, clear of the goal, inside the frame, drawn in towards the lead.
    for (let it = 0; it < 140; it++) {
      for (const d of discs) {
        d.x += (cx - d.x) * 0.012
        d.y += (cy - d.y) * 0.012
      }
      for (let i = 0; i < discs.length; i++)
        for (let j = i + 1; j < discs.length; j++) {
          const a = discs[i]
          const b = discs[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.hypot(dx, dy) || 0.01
          const want = a.R + b.R + 14
          if (dist < want) {
            const push = (want - dist) / 2
            a.x -= (dx / dist) * push
            a.y -= (dy / dist) * push
            b.x += (dx / dist) * push
            b.y += (dy / dist) * push
          }
        }
      for (const d of discs) {
        const dx = d.x - cx
        const dy = d.y - cy
        const dist = Math.hypot(dx, dy) || 0.01
        const want = f.core + d.R
        if (dist < want) {
          d.x = cx + (dx / dist) * want
          d.y = cy + (dy / dist) * want
        }
        d.x = Math.min(f.width - padX - d.R, Math.max(padX + d.R, d.x))
        d.y = Math.min(bottom - labelRoom - d.R, Math.max(top + labelRoom + d.R, d.y))
      }
    }
    // Fits when nothing overlaps any more (or the regions cannot get any smaller).
    let worst = 0
    for (let i = 0; i < discs.length; i++) {
      for (let j = i + 1; j < discs.length; j++) worst = Math.max(worst, discs[i].R + discs[j].R + 6 - Math.hypot(discs[i].x - discs[j].x, discs[i].y - discs[j].y))
      worst = Math.max(worst, f.core * 0.82 + discs[i].R - Math.hypot(discs[i].x - cx, discs[i].y - cy))
    }
    if (worst <= 0) break
  }
  out.step = step

  const r1 = Math.max(5.5, Math.min(10.5, step * 0.3))
  const radius = (n: Neuron): number => (n.id.startsWith(FOLD) ? Math.max(8, r1 * 1.05) : n.depth <= 1 ? r1 : n.depth === 2 ? r1 * 0.82 : r1 * 0.7)
  const c = step / 1.75

  for (const d of discs) {
    // Slots on a sunflower spiral, more than needed, so each agent can sit near whoever started it.
    const slots: { x: number; y: number; used: boolean }[] = []
    const count = d.n + Math.ceil(d.n * 0.4) + 2
    // Turn the spiral so its first slot faces the lead.
    const face = Math.atan2(cy - d.y, cx - d.x)
    for (let k = 0; k < count; k++) {
      const rr = c * Math.sqrt(k + 0.5)
      const a = face + k * GOLDEN
      slots.push({ x: d.x + Math.cos(a) * rr, y: d.y + Math.sin(a) * rr, used: false })
    }
    const toLead = { x: (cx - d.x) / (Math.hypot(cx - d.x, cy - d.y) || 1), y: (cy - d.y) / (Math.hypot(cx - d.x, cy - d.y) || 1) }
    for (const id of d.r.ids) {
      const n = byId.get(id)
      if (!n) continue
      let want: { x: number; y: number }
      const p = n.parent ? pos.get(n.parent) : undefined
      if (!p || n.parent === lead?.id) want = { x: d.x + toLead.x * c * 0.8, y: d.y + toLead.y * c * 0.8 }
      else {
        // Just beyond whoever started it, away from the lead.
        const ox = p.x - cx
        const oy = p.y - cy
        const o = Math.hypot(ox, oy) || 1
        want = { x: p.x + (ox / o) * step * 0.6, y: p.y + (oy / o) * step * 0.6 }
      }
      let best = -1
      let bestD = Infinity
      slots.forEach((s, i) => {
        if (s.used) return
        const dd = Math.hypot(s.x - want.x, s.y - want.y)
        if (dd < bestD) {
          bestD = dd
          best = i
        }
      })
      if (best < 0) continue
      slots[best].used = true
      pos.set(id, { x: slots[best].x, y: slots[best].y, r: radius(n) })
    }

    // The outline: a soft margin around every member, smoothed.
    const pad = step * 0.62
    const ring: { x: number; y: number }[] = []
    for (const id of d.r.ids) {
      const p = pos.get(id)
      if (!p) continue
      for (let k = 0; k < 12; k++) ring.push({ x: p.x + Math.cos((k / 12) * Math.PI * 2) * (pad + p.r), y: p.y + Math.sin((k / 12) * Math.PI * 2) * (pad + p.r) })
    }
    const h = hull(ring)
    const ys = h.map((q) => q.y)
    const xs = h.map((q) => q.x)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2
    lobes.set(d.r.key, {
      key: d.r.key,
      d: smoothClosed(h),
      cx: d.x,
      cy: d.y,
      R: d.R,
      box: { l: Math.min(...xs), t: minY, r: Math.max(...xs), b: maxY },
      above: { x: midX, y: minY + step * 0.15 },
      below: { x: midX, y: maxY + 10 - step * 0.15 },
      prefer: d.y <= cy + 1 ? 'above' : 'below',
    })
  }
  return out
}

/** A gentle curve between two points that bows to one side. */
export function arc(a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.14): string {
  const r = (v: number): number => Math.round(v * 10) / 10
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  return `M ${r(a.x)} ${r(a.y)} Q ${r(mx - dy * bend)} ${r(my + dx * bend)} ${r(b.x)} ${r(b.y)}`
}

/** A curve between two regions that sweeps in towards the centre, the way fibres cross a brain. */
export function bridge(a: { x: number; y: number }, b: { x: number; y: number }, centre: { x: number; y: number }, pull = 0.42): string {
  const r = (v: number): number => Math.round(v * 10) / 10
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const qx = mx + (centre.x - mx) * pull
  const qy = my + (centre.y - my) * pull
  return `M ${r(a.x)} ${r(a.y)} Q ${r(qx)} ${r(qy)} ${r(b.x)} ${r(b.y)}`
}

// ───────────── more agents than fit ─────────────

/** A fold: the agents of one level of a region that are not drawn one by one, shown as a count. */
export interface Fold {
  id: string
  /** The drawn agent they hang from. */
  anchor: string
  region: string
  /** Everyone folded into it. */
  ids: string[]
  /** Deepest and shallowest level among them. */
  from: number
  to: number
}

export const FOLD = 'fold:'

/**
 * Keeps the drawing readable however large the team grows: at most `budget` agents are drawn, shared
 * between regions by size, each region filled shallow levels first (heads, then their helpers, and so
 * on), so whoever is drawn always has their parent drawn too. The rest fold into one count per drawn
 * ancestor. Who is working does not decide what is drawn, so the picture holds still as work moves.
 */
export function condense(net: Net, regions: Region[], budget: number): { net: Net; regions: Region[]; folds: Map<string, Fold> } {
  const folds = new Map<string, Fold>()
  const total = regions.reduce((a, r) => a + r.ids.length, 0)
  if (total <= budget) return { net, regions, folds }
  const byId = new Map(net.neurons.map((n) => [n.id, n]))
  const keep = new Set(net.neurons.filter((n) => n.lead).map((n) => n.id))
  const out: Region[] = []
  for (const r of regions) {
    const share = Math.max(r.heads.length + 1, Math.floor((budget * r.ids.length) / total))
    // Leave room for the counts themselves.
    const shown = r.ids.slice(0, Math.max(r.heads.length, share - Math.ceil(share * 0.15)))
    for (const id of shown) keep.add(id)
    const ids = [...shown]
    // One fold per level of the region: "+19, level 5". It hangs from the drawn agent most of
    // its members descend from, so its fibre still says where that work came from.
    const byLevel = new Map<number, string[]>()
    for (const id of r.ids.slice(shown.length)) {
      const d = byId.get(id)?.depth ?? 0
      byLevel.set(d, [...(byLevel.get(d) || []), id])
    }
    for (const [d, members] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      // A fold of one is just the agent, when whoever started it is drawn.
      if (members.length === 1 && keep.has(byId.get(members[0])?.parent ?? '')) {
        keep.add(members[0])
        ids.push(members[0])
        continue
      }
      const votes = new Map<string, number>()
      for (const id of members) {
        let a = byId.get(id)?.parent
        while (a && !keep.has(a)) a = byId.get(a)?.parent
        if (a) votes.set(a, (votes.get(a) || 0) + 1)
      }
      const anchor = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
      if (!anchor) continue
      const fid = `${FOLD}${r.key}:${d}`
      folds.set(fid, { id: fid, anchor, region: r.key, ids: members, from: d, to: d })
      ids.push(fid)
    }
    out.push({ ...r, ids })
  }
  const neurons: Neuron[] = net.neurons.filter((n) => keep.has(n.id))
  for (const f of folds.values()) {
    const a = byId.get(f.anchor) as Neuron
    neurons.push({ ...a, id: f.id, lead: false, parent: f.anchor, depth: f.from, account: { ...a.account, id: f.id, name: `${f.ids.length} more` } })
  }
  const links = net.links.filter((l) => keep.has(l.from) && keep.has(l.to))
  return { net: { neurons, links, depth: net.depth }, regions: out, folds }
}
