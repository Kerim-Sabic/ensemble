// Words that are still being written. They arrive a dozen times a second for
// every agent that is talking, so they are kept out of the store: only the one
// row that is showing the text hears about it, and at most once per drawn frame.
// When the text is finished the whole of it lands in the store as usual.

import { useCallback, useSyncExternalStore } from 'react'

const extra = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()
const dirty = new Set<string>()
let frame = 0

function tell(): void {
  frame = 0
  const ids = [...dirty]
  dirty.clear()
  for (const id of ids) for (const l of listeners.get(id) || []) l()
}

/** More text for a row that is being written. */
export function appendStream(id: string, text: string): void {
  extra.set(id, (extra.get(id) || '') + text)
  dirty.add(id)
  // A window nobody can see draws no frames, so nothing is redrawn until it is looked at again.
  if (!frame) frame = requestAnimationFrame(tell)
}

/** The row is finished or was replaced: hand back what was held for it and forget it. */
export function takeStream(id: string): string {
  const t = extra.get(id)
  if (t === undefined) return ''
  extra.delete(id)
  dirty.delete(id)
  return t
}

const off = (): void => undefined
const NONE = (): (() => void) => off

/** The text of a row, including whatever has arrived since the store last heard about it. */
export function useStreamed(id: string, base: string, streaming: boolean | undefined): string {
  const listen = useCallback(
    (l: () => void) => {
      let set = listeners.get(id)
      if (!set) listeners.set(id, (set = new Set()))
      set.add(l)
      return () => {
        set?.delete(l)
        if (set && !set.size && listeners.get(id) === set) listeners.delete(id)
      }
    },
    [id],
  )
  // Rows that are finished do not listen at all: a long chat has thousands of them.
  const more = useSyncExternalStore(streaming ? listen : NONE, () => extra.get(id) || '')
  return more ? base + more : base
}
