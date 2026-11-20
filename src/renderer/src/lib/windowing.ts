// Which rows of a long list to draw: only those near what can be seen, with empty space of the
// right height standing in for the rest, so a chat of thousands of rows scrolls like a short one.
// Pure, so it can be checked without a window (scripts/checks/speed.ts).

export interface Span {
  /** First row drawn. */
  start: number
  /** One past the last row drawn. */
  end: number
  /** Height of the space standing in for the rows before `start`. */
  top: number
  /** Height of the space standing in for the rows from `end` on. */
  bottom: number
  /** Height of everything. */
  total: number
}

/**
 * The rows to draw for a view `viewport` tall scrolled to `scrollTop`, with `overscan` drawn beyond
 * each edge so a fast scroll does not show empty space. `atEnd` reads the view as scrolled to the
 * very end, whatever `scrollTop` says (a chat that follows its latest message).
 */
export function windowOf(heights: ArrayLike<number>, scrollTop: number, viewport: number, overscan: number, atEnd = false): Span {
  const n = heights.length
  let total = 0
  for (let i = 0; i < n; i++) total += heights[i]
  if (!n) return { start: 0, end: 0, top: 0, bottom: 0, total: 0 }
  const view = Math.max(0, viewport)
  const at = atEnd ? Math.max(0, total - view) : Math.min(Math.max(0, scrollTop), Math.max(0, total - view))
  const from = at - overscan
  const to = at + view + overscan
  let acc = 0
  let start = 0
  while (start < n - 1 && acc + heights[start] <= from) acc += heights[start++]
  const top = acc
  let end = start
  while (end < n && acc < to) acc += heights[end++]
  if (end === start) acc += heights[end++]
  return { start, end, top, bottom: total - acc, total }
}

/** Two spans draw the same rows (so nothing needs drawing again). */
export const sameRows = (a: Span, b: Span): boolean => a.start === b.start && a.end === b.end

/**
 * How tall a row probably is before it has been drawn, from what it holds: a guess that only has
 * to be near, because every row is measured once it is drawn and the guess is then forgotten.
 */
export function guessHeight(kind: string, text = '', count = 1): number {
  switch (kind) {
    case 'label':
      return 30
    case 'assistant':
    case 'peer': {
      // About 95 characters to a line of 26 px, code lines shorter and closer; then the gaps.
      const lines = text.split('\n')
      let h = 24
      for (const l of lines) h += l.length > 95 ? Math.ceil(l.length / 95) * 26 : 22
      return Math.min(h, 20000)
    }
    case 'user':
      return 56 + Math.ceil(text.length / 70) * 22
    case 'activity':
      return 40
    case 'delegates':
      return 30 + Math.ceil(count / 3) * 96
    case 'spawns':
      return count >= 3 ? 52 : 44 * count
    case 'image':
      return 300
    case 'screen':
      return 340
    case 'turn':
      return 64
    default:
      return 48
  }
}
