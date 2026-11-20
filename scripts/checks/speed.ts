import type { Ctx } from './ctx'
import type { Item } from '../../src/shared/types'
import { guessHeight, sameRows, windowOf } from '../../src/renderer/src/lib/windowing'
import { build, keepSame, withCounts, type Block } from '../../src/renderer/src/components/chat/blocks'

// A responsive window: the sums behind the windowed transcript. The timings themselves come from
// scripts/visual/perf-window.json, which drives the real window (see the note at its top).
export default async function checks(c: Ctx): Promise<void> {
  // ---- which rows are drawn ----
  const even = new Array(3000).fill(100)
  const mid = windowOf(even, 150_000, 900, 1400)
  c.check('speed: a 3,000-row chat draws only the rows near the view', mid.end - mid.start <= 40 && mid.start > 1400, JSON.stringify(mid))
  c.check('speed: the drawn rows cover the view and the overscan', mid.top <= 150_000 - 1400 && mid.total - mid.bottom >= 150_000 + 900 + 1400, JSON.stringify(mid))
  c.same('speed: space above, rows and space below add up to the whole', mid.top + (mid.end - mid.start) * 100 + mid.bottom, mid.total)
  const end = windowOf(even, 0, 900, 1400, true)
  c.check('speed: following the latest message draws the last rows', end.end === 3000 && end.bottom === 0 && end.start > 2900, JSON.stringify(end))
  const first = windowOf(even, 0, 900, 1400)
  c.check('speed: at the top the first rows are drawn', first.start === 0 && first.top === 0 && first.end <= 24, JSON.stringify(first))
  const past = windowOf(even, 10_000_000, 900, 1400)
  c.check('speed: scrolled past the end counts as the end', past.end === 3000 && past.bottom === 0, JSON.stringify(past))
  c.same('speed: nothing to draw', windowOf([], 0, 900, 1400), { start: 0, end: 0, top: 0, bottom: 0, total: 0 })
  const tall = windowOf([100, 20000, 100], 5000, 900, 100)
  c.check('speed: one row taller than the view is still drawn', tall.start === 1 && tall.end === 2, JSON.stringify(tall))
  // Uneven rows: the sums hold wherever the view is.
  let seed = 7
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const mixed = Array.from({ length: 2500 }, () => 20 + Math.floor(rnd() * 900))
  let ok = true
  for (let t = 0; t < 40; t++) {
    const at = Math.floor(rnd() * 1_200_000)
    const s = windowOf(mixed, at, 850, 1400)
    let drawn = 0
    for (let i = s.start; i < s.end; i++) drawn += mixed[i]
    const viewTop = Math.min(at, s.total - 850)
    if (s.top + drawn + s.bottom !== s.total || s.top > Math.max(0, viewTop - 1400) + 1 || s.top + drawn < Math.min(s.total, viewTop + 850 + 1400)) ok = false
  }
  c.check('speed: uneven rows always cover the view, and the sums hold', ok)
  c.check('speed: a scroll inside the same rows draws nothing again', sameRows(windowOf(even, 150_050, 900, 1400), windowOf(even, 150_080, 900, 1400)) && !sameRows(windowOf(even, 150_050, 900, 1400), windowOf(even, 152_000, 900, 1400)))
  c.check('speed: a long reply is guessed taller than a short one', guessHeight('assistant', 'x\n'.repeat(80)) > guessHeight('assistant', 'Done.') && guessHeight('assistant', 'y'.repeat(10_000_000)) <= 20000)

  // ---- rows that did not change are not drawn again ----
  let n = 0
  const id = (): string => `r${n++}`
  const ts = 1
  const turn = (): Item[] => {
    const tool = id()
    return [
      { id: id(), ts, kind: 'user', text: 'Fix the checkout' },
      { id: id(), ts, kind: 'thinking', text: 'Looking', durationMs: 2000 },
      { id: tool, ts, kind: 'tool', name: 'Task', status: 'done' },
      { id: id(), ts, kind: 'tool', name: 'Read', status: 'done', parentId: tool },
      { id: id(), ts, kind: 'tool', name: 'Bash', status: 'done' },
      { id: id(), ts, kind: 'assistant', text: 'Done: the tests pass.' },
      { id: id(), ts, kind: 'turn', status: 'done', durationMs: 4000, steps: 3 },
    ]
  }
  const items: Item[] = []
  for (let i = 0; i < 400; i++) items.push(...turn())
  const blocksOf = (list: Item[], prev: Block[]): Block[] => {
    const { blocks, children } = build(list)
    withCounts(blocks, children)
    return keepSame(prev, blocks)
  }
  const a = blocksOf(items, [])
  c.check('speed: the same rows give the very same blocks', blocksOf(items, a) === a)
  // A reply is being written at the end: one more row arrives, then the reply changes.
  const writing: Item = { id: id(), ts, kind: 'assistant', text: 'Wri', streaming: true }
  const b = blocksOf([...items, writing], a)
  c.check('speed: a new row at the end keeps every earlier block', b.length === a.length + 1 && a.every((x, i) => b[i] === x), `${a.length} -> ${b.length}`)
  const c2 = blocksOf([...items, { ...writing, text: 'Writing more' }], b)
  const changed = c2.filter((x, i) => x !== b[i]).length
  c.same('speed: a change to the reply being written changes one block', changed, 1)
  // A helper's tool row lands under a running tool: only that run of activity changes.
  const runs = a.filter((x) => x.type === 'activity')
  const lastTool = items[items.length - 5]
  const d = blocksOf([...items, { id: id(), ts, kind: 'tool', name: 'Grep', status: 'done', parentId: lastTool.id }], a)
  c.same('speed: a child row changes only its own run', d.filter((x, i) => x !== a[i]).length, 1)
  c.check('speed: runs of activity carry their own child counts', runs.some((r) => r.type === 'activity' && (r.kids?.size || 0) > 0))
}
