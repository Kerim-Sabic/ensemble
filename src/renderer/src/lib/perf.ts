// Measuring the window's speed (scripts/visual/perf-window.json). Off unless a measuring run
// turns it on (localStorage "ensemble-perf" = "1", then a reload): then React reports every
// commit here, and the parts of the window that matter count how often they are drawn.
// Nothing is kept or sent anywhere; when it is off, `rendered` is one property check.

import { useLayoutEffect } from 'react'

type Perf = { renders: Record<string, number>; commits: number; commitMs: number[]; times?: Record<string, number[]> }

const w = window as unknown as { __ensemblePerf?: Perf; __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }

const on = ((): boolean => {
  try {
    return localStorage.getItem('ensemble-perf') === '1'
  } catch {
    return false
  }
})()

if (on && !w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
  const perf: Perf = { renders: {}, commits: 0, commitMs: [] }
  w.__ensemblePerf = perf
  // The same door React's own developer tools use: React calls it once per commit. This module
  // is imported before React, so the door is there when React looks for it.
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberRoot: () => {
      perf.commits++
      if (perf.commitMs.length < 20000) perf.commitMs.push(performance.now())
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
  }
}

/** Counts one drawing of a part of the window, while a measuring run is on. */
export function rendered(name: string): void {
  const p = w.__ensemblePerf
  if (p) p.renders[name] = (p.renders[name] || 0) + 1
}

/**
 * While a measuring run is on: how long one drawing of a part took, from the start of its
 * function to its layout effects (its own work, its children's and the change to the page).
 */
export function useRenderTime(name: string): void {
  const p = w.__ensemblePerf
  const t = p ? performance.now() : 0
  useLayoutEffect(() => {
    if (!p) return
    const d = performance.now() - t
    const list = (p.times ||= {})[name] || (p.times[name] = [])
    if (list.length < 5000) list.push(d)
  })
}

/** While a measuring run is on, how long `f` took, written down under `name`. Otherwise just `f()`. */
export function timed<T>(name: string, f: () => T): T {
  const p = w.__ensemblePerf
  if (!p) return f()
  const t = performance.now()
  const out = f()
  const list = (p.times ||= {})[name] || (p.times[name] = [])
  if (list.length < 5000) list.push(performance.now() - t)
  return out
}

const starts: Record<string, number> = {}

/** While a measuring run is on, marks the start of a part's drawing (see `Done`). */
export function began(name: string): void {
  if (w.__ensemblePerf) starts[name] = performance.now()
}

/**
 * Placed as the last child of a part: React draws it after everything else in that part, so the
 * time since `began` is what drawing the part and all it holds took (not the change to the page).
 */
export function Done({ name }: { name: string }): null {
  const p = w.__ensemblePerf
  if (p && starts[name]) {
    const list = (p.times ||= {})[`draw:${name}`] || (p.times[`draw:${name}`] = [])
    if (list.length < 5000) list.push(performance.now() - starts[name])
  }
  return null
}
