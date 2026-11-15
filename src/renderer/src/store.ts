import { useMemo } from 'react'
import { create } from 'zustand'
import type {
  Account,
  AccountStatus,
  AccountUsage,
  AgentState,
  Attachment,
  Bootstrap,
  Chat,
  Folder,
  FolderChanges,
  HubEvent,
  Item,
  LoginProgress,
  MemoryNote,
  ScreenKind,
  ScreenState,
  Settings,
  Task,
  VaultInfo,
} from '@shared/types'
import { api, errorText } from './lib/util'
import { forgetFrames, startFrames } from './lib/frames'
import { appendStream, takeStream } from './lib/streams'

/**
 * 'flow' is the Team view (who is talking to whom); 'team' is everyone's chat side by side;
 * 'now' is mission control: every chat that is being worked on, at once.
 */
export type View = 'chat' | 'flow' | 'team' | 'live' | 'memory' | 'library' | 'now'

/** Views that are not about one chat, and so stay up whichever chat is open. */
export const isGlobalView = (v: View): boolean => v === 'memory' || v === 'library' || v === 'now'

/** One thing an agent was seen doing, for the trail of its recent steps. */
export interface Step {
  text: string
  ts: number
}

/** How a screen is named everywhere: whose it is, in which chat, and whether it is a browser or the computer. */
export const screenKey = (chatId: string, accountId: string, kind: ScreenKind): string => `${chatId}:${accountId}:${kind}`

export type Modal =
  | null
  | { kind: 'settings' }
  | { kind: 'add-account' }
  | { kind: 'account'; id: string }
  | { kind: 'palette' }
  | { kind: 'task'; taskId: string }
  | { kind: 'diff'; chatId: string; path: string }
  | { kind: 'shortcuts' }
  | { kind: 'import' }
  | { kind: 'folder'; id: string }
  | { kind: 'connectors' }
  | { kind: 'confirm'; title: string; body: string; action: string; safe?: boolean; run(): void }

export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
}

interface State {
  ready: boolean
  env: Bootstrap['env']
  settings: Settings
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  usage: Record<string, AccountUsage>
  chats: Chat[]
  folders: Folder[]
  /** Everyone who can appear in a chat, by id: the accounts, and the agents that were started inside chats. */
  members: Record<string, Account>
  memory: MemoryNote[]
  /** Keyed by `${chatId}:${accountId}`. */
  agents: Record<string, AgentState>
  /** The last few things each agent was seen doing in its current reply. Keyed like `agents`. */
  trail: Record<string, Step[]>
  items: Record<string, Item[]>
  tasks: Record<string, Task[]>
  /** What is different on disk in each chat's folder. */
  changes: Record<string, FolderChanges>
  /** Browsers agents have open, and the computer's screen while one controls it. Keyed by screenKey. */
  screens: Record<string, ScreenState>
  /** Which screen the Live view is showing, and which step of its replay (null means live). */
  live: { key: string | null; step: string | null; control?: boolean }
  vault: VaultInfo | null
  loaded: Record<string, boolean>
  unread: Record<string, number>
  logins: Record<string, LoginProgress>
  /** A newer version of Ensemble, once one is found. */
  update: { state: 'downloading' | 'ready'; version: string } | null
  /** null means the blank "new chat" screen. */
  chatId: string | null
  /** Which teammate each chat is showing. */
  focus: Record<string, string>
  /** Teammate chosen on the new-chat screen, before the chat exists. */
  draftTo: string | null
  draftCwd: string | null
  /** The folder a chat that has not been started yet will be filed under. */
  draftFolder: string | null
  /** Who will lead the chat that has not been started yet, when it is not the usual lead. */
  draftLead: string | null
  view: View
  modal: Modal
  toasts: Toast[]
  dark: boolean

  init(): Promise<void>
  openChat(id: string, accountId?: string): Promise<void>
  /** Reads a chat's transcripts and tasks without opening it on screen. */
  ensureLoaded(id: string): Promise<void>
  /** `folderId` starts the new chat inside a folder. */
  newChat(folderId?: string | null): void
  setView(v: View): void
  /** Opens the Live view on a screen, optionally at one step of what was done there. */
  /** `control` hands you the mouse straight away, for signing in. */
  watch(key: string, step?: string | null, control?: boolean): void
  setLive(patch: Partial<State['live']>): void
  setFocus(accountId: string): void
  setModal(m: Modal): void
  setDraftCwd(cwd: string | null): void
  setDraftLead(accountId: string | null): void
  send(text: string, attachments?: Attachment[], to?: string): Promise<boolean>
  refreshChanges(chatId: string): void
  toggleInspector(): void
  toast(text: string, level?: Toast['level']): void
  dismissToast(id: number): void
  run<T>(p: Promise<T>): Promise<T | undefined>
}

const key = (chatId: string, accountId: string): string => `${chatId}:${accountId}`

let toastSeq = 1

/**
 * Who leads: the chat's own lead when it has one, otherwise the team's usual lead. On the
 * new-chat screen it is whoever was picked to lead the chat about to start; `usual` skips that.
 */
export function leadOf(s: Pick<State, 'accounts' | 'settings' | 'chats' | 'chatId' | 'draftLead'>, chatId: string | null = s.chatId, usual = false): Account | undefined {
  const usable = s.accounts.filter((a) => a.enabled)
  const own = chatId ? s.chats.find((c) => c.id === chatId)?.leadId : usual ? null : s.draftLead
  return (
    (own ? usable.find((a) => a.id === own) : undefined) ||
    usable.find((a) => a.id === s.settings.leadId) ||
    usable.find((a) => a.provider === 'claude' && a.configDir === null) ||
    usable.find((a) => a.provider === 'claude') ||
    usable[0]
  )
}

/** The teammate the current screen is talking to. */
export function focusOf(s: State): string | undefined {
  const lead = leadOf(s)?.id
  if (!s.chatId) return s.draftTo && s.accounts.some((a) => a.id === s.draftTo) ? s.draftTo : lead
  const f = s.focus[s.chatId]
  // An agent that was started inside a chat can be looked at in that chat only.
  const m = f ? s.members[f] : undefined
  return m && (!m.spawned || m.spawned.chatId === s.chatId) ? f : lead
}

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
}

function membersOf(accounts: Account[], chats: Chat[]): Record<string, Account> {
  const out: Record<string, Account> = {}
  for (const a of accounts) out[a.id] = a
  for (const c of chats) for (const a of c.agents || []) out[a.id] = a
  return out
}

/**
 * An agent started inside a chat has no sign-in or allowance of its own, so what is known
 * about its account (status, allowance) is made to answer under its id too.
 */
function withAgents<T>(rec: Record<string, T>, chats: Chat[]): Record<string, T> {
  let out = rec
  for (const c of chats) {
    for (const a of c.agents || []) {
      const v = a.spawned ? rec[a.spawned.base] : undefined
      if (v === undefined || out[a.id] === v) continue
      if (out === rec) out = { ...rec }
      out[a.id] = v
    }
  }
  return out
}

/** Lines that say nothing about what an agent is doing, and so are left out of its trail. */
const DULL = new Set(['Thinking', 'Writing', 'Waking up', 'Working'])
/** Which reply each trail belongs to, so a new reply starts a new trail. */
const trailTurn = new Map<string, number>()

/** Lets the window ask the message box for attention from outside React. */
export const uiBus = new EventTarget()

const changeTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Chats being read right now, so two askers share one read. */
const loading = new Map<string, Promise<void>>()

export const useStore = create<State>((set, get) => {
  const handle = (ev: HubEvent): void => {
    switch (ev.type) {
      case 'settings':
        set({ settings: ev.settings })
        return
      case 'accounts':
        set((s) => ({ accounts: ev.accounts, members: membersOf(ev.accounts, s.chats) }))
        return
      case 'account-status':
        set((s) => ({ statuses: withAgents({ ...s.statuses, [ev.status.accountId]: ev.status }, s.chats) }))
        return
      case 'account-usage':
        set((s) => ({ usage: withAgents({ ...s.usage, [ev.usage.accountId]: ev.usage }, s.chats) }))
        return
      case 'login':
        set((s) => ({ logins: { ...s.logins, [ev.progress.accountId]: ev.progress } }))
        return
      case 'chat':
        set((s) => {
          const chats = sortChats([...s.chats.filter((c) => c.id !== ev.chat.id), ev.chat])
          // Only a chat with agents of its own changes who can be looked up.
          if (!ev.chat.agents?.length) return { chats }
          return { chats, members: membersOf(s.accounts, chats), statuses: withAgents(s.statuses, chats), usage: withAgents(s.usage, chats) }
        })
        return
      case 'chat-removed':
        set((s) => ({ chats: s.chats.filter((c) => c.id !== ev.chatId), chatId: s.chatId === ev.chatId ? null : s.chatId }))
        return
      case 'folders':
        set({ folders: ev.folders })
        return
      case 'agent': {
        const k = key(ev.state.chatId, ev.state.accountId)
        set((s) => {
          const patch: Partial<State> = { agents: { ...s.agents, [k]: ev.state } }
          // Keep the last few things it did, so its work can be followed without opening its chat.
          const st = ev.state
          const turn = st.turnStartedAt || 0
          const fresh = !!turn && trailTurn.get(k) !== turn
          if (fresh) trailTurn.set(k, turn)
          const was = fresh ? [] : s.trail[k] || []
          const text = st.activity?.trim()
          if (text && !DULL.has(text) && st.phase !== 'idle' && st.phase !== 'error' && was[was.length - 1]?.text !== text) {
            patch.trail = { ...s.trail, [k]: [...was.slice(-5), { text, ts: Date.now() }] }
          } else if (fresh) patch.trail = { ...s.trail, [k]: was }
          return patch
        })
        return
      }
      case 'item': {
        const k = key(ev.chatId, ev.accountId)
        set((s) => {
          const patch: Partial<State> = {}
          if (s.loaded[ev.chatId]) {
            const list = s.items[k] || []
            if (!list.some((i) => i.id === ev.item.id)) patch.items = { ...s.items, [k]: [...list, ev.item] }
          }
          // A finished turn somewhere you are not looking is worth a dot.
          const watching = s.chatId === ev.chatId && s.view === 'chat' && focusOf(s) === ev.accountId
          if (ev.item.kind === 'turn' && !watching) patch.unread = { ...s.unread, [k]: (s.unread[k] || 0) + 1 }
          return patch
        })
        // A reply just ended: the files on disk may have changed.
        if (ev.item.kind === 'turn' && get().chatId === ev.chatId) get().refreshChanges(ev.chatId)
        return
      }
      case 'item-patch': {
        const k = key(ev.chatId, ev.accountId)
        // Whatever was still arriving for this row is settled by the change, or folded into it.
        const more = takeStream(ev.id)
        set((s) => {
          const list = s.items[k]
          if (!list) return {}
          // Changes are nearly always to something recent: look from the end.
          let i = list.length - 1
          while (i >= 0 && list[i].id !== ev.id) i--
          if (i < 0) return {}
          const was = list[i]
          const next = list.slice()
          next[i] = { ...was, ...(more && 'text' in was && !('text' in ev.patch) ? { text: was.text + more } : null), ...ev.patch } as Item
          return { items: { ...s.items, [k]: next } }
        })
        return
      }
      case 'item-delta':
        // Text being written goes straight to the row that shows it, not through the store:
        // putting it here would redraw the whole chat a dozen times a second per agent.
        if (get().loaded[ev.chatId]) appendStream(ev.id, ev.text)
        return
      case 'task':
        set((s) => {
          const list = s.tasks[ev.task.chatId] || []
          const i = list.findIndex((t) => t.id === ev.task.id)
          const next = i < 0 ? [...list, ev.task] : list.map((t) => (t.id === ev.task.id ? ev.task : t))
          return { tasks: { ...s.tasks, [ev.task.chatId]: next } }
        })
        return
      case 'memory':
        set({ memory: ev.notes })
        return
      case 'screen':
        set((s) => ({ screens: { ...s.screens, [screenKey(ev.screen.chatId, ev.screen.accountId, ev.screen.kind)]: ev.screen } }))
        return
      case 'screen-closed': {
        const k = screenKey(ev.chatId, ev.accountId, ev.kind)
        forgetFrames(k)
        set((s) => {
          const screens = { ...s.screens }
          delete screens[k]
          return { screens }
        })
        return
      }
      case 'vault':
        set({ vault: ev.vault })
        return
      case 'update':
        set({ update: { state: ev.state, version: ev.version } })
        return
      case 'toast':
        get().toast(ev.text, ev.level)
        return
      case 'focus-chat':
        void get().openChat(ev.chatId, ev.accountId)
        return
      case 'summon':
        if (ev.fresh) get().newChat()
        else if (get().view !== 'chat') get().setView('chat')
        uiBus.dispatchEvent(new Event('focus-composer'))
        return
    }
  }

  return {
    ready: false,
    env: { platform: 'win32', mica: false, home: '', version: '', demo: false, canBrowse: false, canControl: false },
    settings: {
      theme: 'system',
      leadId: null,
      defaultPermission: 'auto',
      defaultCwd: null,
      claudePath: null,
      onboarded: true,
      memoryEnabled: true,
      smartTitles: true,
      notifications: true,
      sidebarCollapsed: false,
      suggestions: true,
      inspector: true,
      keepRunning: false,
      globalHotkey: true,
      launchAtLogin: false,
      browser: true,
      computer: 'ask',
      vaultPath: null,
      vaultNotes: 'auto',
      lightTalk: true,
      smartModels: true,
      maxAgents: -1,
      maxPerAgent: 4,
      economy: 'auto',
      recall: true,
      chatNotes: true,
    },
    accounts: [],
    statuses: {},
    usage: {},
    chats: [],
    folders: [],
    members: {},
    memory: [],
    agents: {},
    trail: {},
    items: {},
    tasks: {},
    changes: {},
    screens: {},
    live: { key: null, step: null },
    vault: null,
    loaded: {},
    unread: {},
    logins: {},
    chatId: null,
    focus: {},
    draftTo: null,
    draftCwd: null,
    draftFolder: null,
    draftLead: null,
    update: null,
    view: 'chat',
    modal: null,
    toasts: [],
    dark: window.matchMedia('(prefers-color-scheme: dark)').matches,

    async init() {
      api.onEvent(handle)
      startFrames()
      const b = await api.bootstrap()
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', (e) => set({ dark: e.matches }))
      set({
        ready: true,
        env: b.env,
        settings: b.settings,
        accounts: b.accounts,
        statuses: withAgents(Object.fromEntries(b.statuses.map((s) => [s.accountId, s])), b.chats),
        usage: withAgents(Object.fromEntries(b.usage.map((u) => [u.accountId, u])), b.chats),
        chats: sortChats(b.chats),
        folders: b.folders || [],
        members: membersOf(b.accounts, b.chats),
        memory: b.memory,
        agents: Object.fromEntries(b.states.map((s) => [key(s.chatId, s.accountId), s])),
        screens: Object.fromEntries(b.screens.map((sc) => [screenKey(sc.chatId, sc.accountId, sc.kind), sc])),
        vault: b.vault,
        draftCwd: b.settings.defaultCwd || b.chats[0]?.cwd || b.env.home,
        dark: mq.matches,
      })

      // Come back to where things were. A chat that was cut short comes first, so the offer
      // to continue is the first thing on screen; otherwise the chat that was open, when the
      // window is coming back from a reload or the team is still at work in it.
      const last = recall()
      const cut = sortChats(b.chats.filter((c) => c.recovery))[0]
      const busy = (id: string): boolean => b.states.some((st) => st.chatId === id && st.phase !== 'idle' && st.phase !== 'error')
      const back = last && b.chats.some((c) => c.id === last.chatId) && (Date.now() - last.at < 3 * 60 * 1000 || busy(last.chatId)) ? last : null
      const open = cut?.id || back?.chatId
      if (open) {
        if (back && back.chatId === open && !isGlobalView(back.view)) set({ view: back.view })
        void get().openChat(open)
      }
      remember()
    },

    async ensureLoaded(id) {
      if (get().loaded[id] || loading.has(id)) return loading.get(id)
      const job = api
        .openChat(id)
        .then((snap) => {
          set((st) => {
            const items = { ...st.items }
            for (const [aid, list] of Object.entries(snap.items)) items[key(id, aid)] = list
            const agents = { ...st.agents }
            for (const a of snap.states) agents[key(a.chatId, a.accountId)] = a
            return { items, agents, tasks: { ...st.tasks, [id]: snap.tasks }, loaded: { ...st.loaded, [id]: true } }
          })
        })
        .finally(() => loading.delete(id))
      loading.set(id, job)
      return job
    },

    async openChat(id, accountId) {
      const s = get()
      set({
        chatId: id,
        view: isGlobalView(s.view) ? 'chat' : s.view,
        focus: accountId ? { ...s.focus, [id]: accountId } : s.focus,
      })
      try {
        await get().ensureLoaded(id)
      } catch (e) {
        get().toast(errorText(e), 'error')
        return
      }
      const f = focusOf(get())
      if (f) set((st) => ({ unread: { ...st.unread, [key(id, f)]: 0 } }))
      get().refreshChanges(id)
    },

    newChat(folderId = null) {
      const s = get()
      const current = s.chats.find((c) => c.id === s.chatId)
      // A chat started from inside a folder begins where that folder's last chat was working.
      const sibling = folderId ? s.chats.find((c) => c.folderId === folderId) : undefined
      set({ chatId: null, view: 'chat', draftTo: null, draftLead: null, draftFolder: folderId, draftCwd: sibling?.cwd || current?.cwd || s.draftCwd || s.settings.defaultCwd || s.env.home })
    },

    watch(k, step = null, control = false) {
      set({ view: 'live', live: { key: k, step, control } })
    },

    setLive(patch) {
      set((s) => ({ live: { ...s.live, ...patch } }))
    },

    setView(view) {
      set({ view })
      const s = get()
      const f = focusOf(s)
      if (view === 'chat' && s.chatId && f) set({ unread: { ...s.unread, [key(s.chatId, f)]: 0 } })
    },

    setFocus(accountId) {
      const s = get()
      if (!s.chatId) {
        set({ draftTo: accountId })
        return
      }
      set({ focus: { ...s.focus, [s.chatId]: accountId }, unread: { ...s.unread, [key(s.chatId, accountId)]: 0 } })
    },

    setModal(modal) {
      set({ modal })
    },

    setDraftCwd(draftCwd) {
      set({ draftCwd })
    },

    setDraftLead(draftLead) {
      // Picking who leads the next chat also makes them the one you are about to write to.
      set({ draftLead, draftTo: null })
    },

    async send(text, attachments, to) {
      const s = get()
      const target = to || focusOf(s)
      if (!target) {
        s.toast('Add an account first.', 'warn')
        return false
      }
      try {
        let chatId = s.chatId
        if (!chatId) {
          const chat = await api.createChat({ cwd: s.draftCwd, folderId: s.draftFolder })
          chatId = chat.id
          // Someone other than the usual lead was picked to lead this one.
          if (s.draftLead && s.draftLead === target) await api.setChatLead(chat.id, target).then((c) => Object.assign(chat, c))
          set((st) => ({
            chatId,
            draftFolder: null,
            draftLead: null,
            loaded: { ...st.loaded, [chat.id]: true },
            focus: { ...st.focus, [chat.id]: target },
            chats: sortChats([...st.chats.filter((c) => c.id !== chat.id), chat]),
            tasks: { ...st.tasks, [chat.id]: [] },
          }))
        } else if (to && s.focus[chatId] !== to) {
          set((st) => ({ focus: { ...st.focus, [chatId as string]: to } }))
        }
        await api.send({ chatId, to: target, text, attachments })
        return true
      } catch (e) {
        s.toast(errorText(e), 'error')
        return false
      }
    },

    refreshChanges(chatId) {
      // Several agents finishing together should cost one look at the folder, not four.
      const pending = changeTimers.get(chatId)
      if (pending) clearTimeout(pending)
      changeTimers.set(
        chatId,
        setTimeout(() => {
          changeTimers.delete(chatId)
          void api.folderChanges(chatId).then(
            (c) => set((s) => ({ changes: { ...s.changes, [chatId]: c } })),
            () => undefined,
          )
        }, 350),
      )
    },

    toggleInspector() {
      void api.updateSettings({ inspector: !get().settings.inspector })
    },

    toast(text, level = 'info') {
      const id = toastSeq++
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, text }] }))
      setTimeout(() => get().dismissToast(id), level === 'error' ? 8000 : 4500)
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    },

    async run(p) {
      try {
        return await p
      } catch (e) {
        get().toast(errorText(e), 'error')
        return undefined
      }
    },
  }
})

export const agentKey = key

// Which chat and view were on screen, kept so a reload or a relaunch can come back to them.
const PLACE = 'ensemble.place'

function recall(): { chatId: string; view: View; at: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE) || 'null') as { chatId?: unknown; view?: unknown; at?: unknown } | null
    if (!p || typeof p.chatId !== 'string' || typeof p.at !== 'number') return null
    const view = (['chat', 'flow', 'team', 'live', 'now'] as const).find((v) => v === p.view) || 'chat'
    return { chatId: p.chatId, view, at: p.at }
  } catch {
    return null
  }
}

let remembering = false
function remember(): void {
  if (remembering) return
  remembering = true
  const save = (): void => {
    const s = useStore.getState()
    try {
      if (s.chatId) localStorage.setItem(PLACE, JSON.stringify({ chatId: s.chatId, view: s.view, at: Date.now() }))
      else localStorage.removeItem(PLACE)
    } catch {
      /* nowhere to keep it: the app simply opens on a new chat next time */
    }
  }
  let was = ''
  useStore.subscribe((s) => {
    const now = `${s.chatId}:${s.view}`
    if (now === was) return
    was = now
    save()
  })
  // The time is what says the app was open a moment ago.
  setInterval(save, 60_000)
  save()
}

const NO_AGENTS: Account[] = []

/**
 * The team in this chat: its lead first, then the other accounts in the order they were
 * added, then the agents that were started inside the chat, each after whoever started it.
 */
export function useTeam(withGone = false): Account[] {
  const accounts = useStore((s) => s.accounts)
  const leadId = useStore((s) => leadOf(s)?.id)
  const agents = useStore((s) => (s.chatId ? s.chats.find((c) => c.id === s.chatId)?.agents : undefined) || NO_AGENTS)
  return useMemo(() => teamOf(accounts, leadId, agents, withGone), [accounts, leadId, agents, withGone])
}

/** `withGone` keeps agents that were sent home, so what they did can still be seen. */
export function teamOf(accounts: Account[], leadId: string | undefined, agents: Account[] = NO_AGENTS, withGone = false): Account[] {
  const on = accounts.filter((a) => a.enabled)
  const here = agents.filter((a) => withGone || !a.spawned?.gone)
  const out: Account[] = []
  // Everyone is followed by the agents they started, so a sub-agent sits next to its starter.
  const add = (a: Account): void => {
    out.push(a)
    for (const x of here) if (x.spawned?.by === a.id && !out.includes(x)) add(x)
  }
  for (const a of [...on.filter((a) => a.id === leadId), ...on.filter((a) => a.id !== leadId)]) add(a)
  for (const x of here) if (!out.includes(x)) add(x)
  return out
}

/** The accounts on the team, lead first. Agents started inside chats are not accounts and are left out. */
export function useAccounts(): Account[] {
  const accounts = useStore((s) => s.accounts)
  const leadId = useStore((s) => leadOf(s)?.id)
  return useMemo(() => teamOf(accounts, leadId), [accounts, leadId])
}

export const isBusy = (st: AgentState | undefined): boolean => !!st && st.phase !== 'idle' && st.phase !== 'error'

/** An account, or an agent that was started inside a chat, by id. */
export function useAccount(id: string | undefined): Account | undefined {
  return useStore((s) => (id ? s.members[id] : undefined))
}
