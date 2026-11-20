// Watches and Inbox: their own small store, fed by the engine's 'watches' and 'inbox' events, so
// nothing else in the window draws again when a watch looks. Until the engine is there, every call
// answers with nothing and the views show their empty states.
import { create } from 'zustand'
import type { InboxItem, UnattendedCaps, Watch, WatchInput } from '@shared/watches'
import { api } from '@/lib/util'

type Maybe<T> = ((...a: never[]) => Promise<T>) | undefined

/** The engine's calls, when they exist. */
interface WatchApi {
  watches?: () => Promise<Watch[]>
  saveWatch?: (input: WatchInput) => Promise<Watch>
  removeWatch?: (id: string) => Promise<void>
  runWatch?: (id: string) => Promise<Watch>
  inbox?: () => Promise<InboxItem[]>
  markInbox?: (id: string, patch: { read?: boolean; done?: boolean }) => Promise<InboxItem[]>
  unattendedToday?: () => Promise<{ runs: number; byAccount: Record<string, number>; caps: UnattendedCaps }>
}
const wapi = api as unknown as WatchApi
const has = (f: Maybe<unknown>): boolean => typeof f === 'function'

interface WatchState {
  /** null until read; [] when the engine is not there or there are none. */
  watches: Watch[] | null
  inbox: InboxItem[] | null
  /** Whether this build has watches at all. */
  available: boolean
  today: { runs: number; byAccount: Record<string, number>; caps: UnattendedCaps } | null
  /** The make-a-watch screen: closed, new (optionally prefilled), or editing one. */
  editing: { open: false } | { open: true; watch?: Watch; draft?: Partial<WatchInput> }
  /** Watches being looked at now (by "Look now"). */
  looking: Record<string, boolean>
}

export const useWatches = create<WatchState>(() => ({ watches: null, inbox: null, available: has(wapi.watches), today: null, editing: { open: false }, looking: {} }))

let started = false
/** Reads watches and inbox once and follows their events from then on. Safe to call many times. */
export function startWatches(): void {
  if (started) return
  started = true
  const set = useWatches.setState
  if (has(wapi.watches)) void wapi.watches!().then((w) => set({ watches: w }), () => set({ watches: [] }))
  else set({ watches: [] })
  if (has(wapi.inbox)) void wapi.inbox!().then((i) => set({ inbox: i }), () => set({ inbox: [] }))
  else set({ inbox: [] })
  void refreshToday()
  api.onEvent((ev) => {
    const e = ev as unknown as { type: string; watches?: Watch[]; items?: InboxItem[] }
    if (e.type === 'watches' && e.watches) {
      set({ watches: e.watches })
      void refreshToday()
    } else if (e.type === 'inbox' && e.items) set({ inbox: e.items })
  })
}

export async function refreshToday(): Promise<void> {
  if (!has(wapi.unattendedToday)) return
  try {
    useWatches.setState({ today: await wapi.unattendedToday!() })
  } catch {
    /* the limits panel shows the settings alone */
  }
}

export const watchApi = {
  async save(input: WatchInput): Promise<Watch | null> {
    if (!has(wapi.saveWatch)) return null
    const w = await wapi.saveWatch!(input)
    useWatches.setState((s) => ({ watches: !s.watches ? [w] : s.watches.some((x) => x.id === w.id) ? s.watches.map((x) => (x.id === w.id ? w : x)) : [...s.watches, w] }))
    return w
  },
  async remove(id: string): Promise<void> {
    if (!has(wapi.removeWatch)) return
    await wapi.removeWatch!(id)
    useWatches.setState((s) => ({ watches: (s.watches || []).filter((x) => x.id !== id) }))
  },
  async run(id: string): Promise<void> {
    if (!has(wapi.runWatch)) return
    useWatches.setState((s) => ({ looking: { ...s.looking, [id]: true } }))
    try {
      const w = await wapi.runWatch!(id)
      useWatches.setState((s) => ({ watches: (s.watches || []).map((x) => (x.id === w.id ? w : x)) }))
    } finally {
      useWatches.setState((s) => {
        const looking = { ...s.looking }
        delete looking[id]
        return { looking }
      })
    }
  },
  async pause(w: Watch, paused: boolean): Promise<void> {
    await watchApi.save({ id: w.id, name: w.name, prompt: w.prompt, trigger: w.trigger, cwd: w.cwd, account: w.account, hours: w.hours, onFind: w.onFind, status: paused ? 'paused' : 'active' })
  },
  async mark(id: string, patch: { read?: boolean; done?: boolean }): Promise<void> {
    // Shown at once; the engine's answer (or its event) settles it.
    useWatches.setState((s) => ({ inbox: (s.inbox || []).map((i) => (i.id === id ? { ...i, ...patch } : i)) }))
    if (!has(wapi.markInbox)) return
    try {
      useWatches.setState({ inbox: await wapi.markInbox!(id, patch) })
    } catch {
      /* the next event puts it right */
    }
  },
}

/** A watch an agent proposed: the user turns it on, or says no and it goes. */
export async function confirmWatch(w: Watch, yes: boolean): Promise<void> {
  if (yes) await watchApi.pause(w, false)
  else await watchApi.remove(w.id)
}

// The step scripts that take the window's pictures set demo state through this.
;(window as unknown as { __watches?: typeof useWatches }).__watches = useWatches

export const openWatchEditor = (watch?: Watch, draft?: Partial<WatchInput>): void => useWatches.setState({ editing: { open: true, watch, draft } })
export const closeWatchEditor = (): void => useWatches.setState({ editing: { open: false } })
