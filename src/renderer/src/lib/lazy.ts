// For parts of the window that only report (the side panel, the team tabs, the network strip):
// they follow the store a moment late, and redraw as low-priority work that React interrupts
// whenever you type, click or scroll. With a team at work the store changes many times a second;
// drawn the urgent way, these parts were what made typing stutter.

import { startTransition, useEffect, useRef, useState } from 'react'
import { useStore } from '@/store'

type State = ReturnType<typeof useStore.getState>

/** How long a report may lag behind the store. Short enough to read as live. */
export const LAG_MS = 150

/**
 * Like `useStore(select)`, but its changes are drawn as low-priority work, at most once every
 * LAG_MS. `key` names everything else the selector reads (props): when it changes, the value is
 * read again at once. `select` must return the same value for the same state, as with useStore.
 */
export function useLazyStore<T>(select: (s: State) => T, key = ''): T {
  const sel = useRef(select)
  sel.current = select
  const [held, setHeld] = useState(() => ({ key, v: select(useStore.getState()) }))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = sel.current(useStore.getState())
    setHeld((h) => (h.key === key && Object.is(h.v, last) ? h : { key, v: last }))
    const check = (): void => {
      timer = undefined
      const next = sel.current(useStore.getState())
      if (Object.is(next, last)) return
      last = next
      startTransition(() => setHeld({ key, v: next }))
    }
    const off = useStore.subscribe(() => {
      if (!timer) timer = setTimeout(check, LAG_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [key])
  return held.key === key ? held.v : select(useStore.getState())
}
