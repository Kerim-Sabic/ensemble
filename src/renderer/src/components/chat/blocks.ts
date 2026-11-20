// The transcript's rows grouped into blocks (a reply, a run of tool use, a batch handed out), and
// the sums the windowed transcript needs. Pure, so scripts/checks/speed.ts can check it.

import type { Item, ScreenKind } from '../../../../shared/types'
import type { ActivityItem } from './ToolRows'
import { guessHeight } from '../../lib/windowing'

export type Delegate = Extract<Item, { kind: 'delegate' }>
export type Spawn = Extract<Item, { kind: 'spawn' }>
export type ScreenStep = Extract<Item, { kind: 'screen' }>
export type ScreenBlock = { type: 'screen'; key: string; surface: ScreenKind; items: ScreenStep[]; latest?: boolean }

export type Block =
  | { type: 'label'; key: string }
  | ScreenBlock
  | { type: 'activity'; key: string; items: ActivityItem[]; kids?: Map<string, number> }
  | { type: 'delegates'; key: string; items: Delegate[] }
  | { type: 'spawns'; key: string; items: Spawn[] }
  | { type: 'item'; key: string; item: Item }


/** A goal check, a loop run, a goal set or resumed: the app speaking for you, so the next reply answers it. */
export const autoTurn = (it: Item): boolean => it.kind === 'auto' && (it.event === 'check' || it.event === 'run' || it.event === 'set' || it.event === 'resumed')

export function build(items: Item[]): { blocks: Block[]; children: Map<string, number> } {
  const blocks: Block[] = []
  const children = new Map<string, number>()
  // One window per screen per turn: it appears where the agent first used the screen.
  let cards: Partial<Record<ScreenKind, ScreenBlock>> = {}
  let needLabel = true
  const label = (id: string): void => {
    if (!needLabel) return
    blocks.push({ type: 'label', key: `l-${id}` })
    needLabel = false
  }
  for (const it of items) {
    const last = blocks[blocks.length - 1]
    switch (it.kind) {
      case 'user':
      case 'peer':
        blocks.push({ type: 'item', key: it.id, item: it })
        needLabel = true
        cards = {}
        break
      case 'auto':
        blocks.push({ type: 'item', key: it.id, item: it })
        if (autoTurn(it)) {
          needLabel = true
          cards = {}
        }
        break
      case 'screen': {
        label(it.id)
        let card = cards[it.surface]
        if (!card) {
          card = { type: 'screen', key: `sc-${it.id}`, surface: it.surface, items: [] }
          cards[it.surface] = card
          blocks.push(card)
        }
        card.items.push(it)
        const tail = blocks[blocks.length - 1]
        if (tail?.type === 'activity') tail.items.push(it)
        else blocks.push({ type: 'activity', key: it.id, items: [it] })
        break
      }
      case 'tool':
        if (it.parentId) {
          children.set(it.parentId, (children.get(it.parentId) || 0) + 1)
          break
        }
      // falls through
      case 'thinking':
        if (it.kind === 'thinking' && !it.streaming && !it.text.trim() && (it.durationMs || 0) < 1000) break
        label(it.id)
        if (last?.type === 'activity') last.items.push(it)
        else blocks.push({ type: 'activity', key: it.id, items: [it] })
        break
      case 'delegate':
        label(it.id)
        if (last?.type === 'delegates') last.items.push(it)
        else blocks.push({ type: 'delegates', key: it.id, items: [it] })
        break
      case 'spawn':
        label(it.id)
        if (last?.type === 'spawns') last.items.push(it)
        else blocks.push({ type: 'spawns', key: it.id, items: [it] })
        break
      case 'assistant':
        if (!it.text.trim() && !it.streaming) break
        label(it.id)
        blocks.push({ type: 'item', key: it.id, item: it })
        break
      case 'turn':
        cards = {}
      // falls through
      case 'notice':
        blocks.push({ type: 'item', key: it.id, item: it })
        break
      default:
        label(it.id)
        blocks.push({ type: 'item', key: it.id, item: it })
    }
  }
  // The newest window onto each screen is the one that keeps following it.
  const seen = new Set<ScreenKind>()
  for (let i = blocks.length - 1; i >= 0 && seen.size < 2; i--) {
    const b = blocks[i]
    if (b.type !== 'screen' || seen.has(b.surface)) continue
    seen.add(b.surface)
    b.latest = true
  }
  return { blocks, children }
}

/** Each activity run gets its own child counts, so a change to one run does not redraw the others. */
export function withCounts(blocks: Block[], children: Map<string, number>): void {
  for (const b of blocks) {
    if (b.type !== 'activity') continue
    let kids: Map<string, number> | undefined
    for (const it of b.items) {
      const n = children.get(it.id)
      if (n) (kids ||= new Map()).set(it.id, n)
    }
    b.kids = kids || NO_KIDS
  }
}
export const NO_KIDS = new Map<string, number>()

const sameKids = (a: Map<string, number>, b: Map<string, number>): boolean => {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** The block drawn last time when nothing in it changed, so its row is not drawn again. */
export function sameBlock(a: Block, b: Block): boolean {
  if (a.type !== b.type || a.key !== b.key) return false
  if (a.type === 'item') return a.item === (b as typeof a).item
  if (a.type === 'label') return true
  const x = a.items as unknown[]
  const y = (b as { items: unknown[] }).items
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  if (a.type === 'screen') return a.latest === (b as ScreenBlock).latest
  if (a.type === 'activity') return sameKids(a.kids || NO_KIDS, (b as typeof a).kids || NO_KIDS)
  return true
}

export function keepSame(prev: Block[], next: Block[]): Block[] {
  if (!prev.length) return next
  const old = new Map<string, Block>()
  // Changes nearly always land at the end: only the last stretch can differ in practice, but
  // checking all of them is cheap next to drawing.
  for (const b of prev) old.set(b.key, b)
  let same = prev.length === next.length
  const out = next.map((b, i) => {
    const o = old.get(b.key)
    const keep = o && sameBlock(o, b) ? o : b
    if (keep !== prev[i]) same = false
    return keep
  })
  return same ? prev : out
}

/** How tall a block probably is before it has been drawn. */
export function guess(b: Block, compact?: boolean): number {
  if (b.type === 'label') return compact ? 0 : guessHeight('label')
  if (b.type === 'item') {
    const it = b.item
    const text = 'text' in it && typeof it.text === 'string' ? it.text : ''
    return guessHeight(it.kind, text)
  }
  return guessHeight(b.type, '', b.items.length)
}

