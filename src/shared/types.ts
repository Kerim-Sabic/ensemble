// Types shared by the main process, the preload bridge and the renderer.

import type { ConnectorInput, ConnectorTest, ConnectorView, FoundConnector } from './connectors'

export type Provider = 'claude' | 'chatgpt'

export type AccentKey = 'clay' | 'violet' | 'teal' | 'blue' | 'amber' | 'rose' | 'green' | 'slate'
export const ACCENTS: AccentKey[] = ['clay', 'violet', 'teal', 'blue', 'amber', 'rose', 'green', 'slate']

/** How much an agent may do without asking. Maps onto each provider's own modes. */
export type PermissionLevel = 'ask' | 'edits' | 'auto' | 'full'

export interface Account {
  id: string
  name: string
  provider: Provider
  /** null means the provider's default folder (~/.claude or ~/.codex). */
  configDir: string | null
  accent: AccentKey
  /** null means "whatever this account is set to use". */
  model: string | null
  effort: string | null
  /** What this teammate is best used for, in the user's words. The lead sees it. */
  role?: string | null
  enabled: boolean
  createdAt: number
  /**
   * Set on an agent that another agent started inside one chat. It is not an account of its
   * own: it works on `base`'s sign-in and allowance, and exists only in that chat.
   */
  spawned?: SpawnInfo
}

export interface SpawnInfo {
  chatId: string
  /** The account whose sign-in and allowance it uses. */
  base: string
  /** Who started it: an account id, or another spawned agent's id. */
  by: string
  /** 1 for an agent the lead started, 2 for a sub-agent started by one of those. */
  depth: number
  at: number
  /** Sent home: it no longer takes work, but what it did stays readable. */
  gone?: boolean
}

/** The account an agent's sign-in, allowance and status belong to. */
export const baseOf = (a: Pick<Account, 'id' | 'spawned'>): string => a.spawned?.base || a.id

export interface ModelOption {
  value: string
  label: string
  description?: string
  efforts?: string[]
  /** The effort the provider uses when none is chosen. */
  defaultEffort?: string
  /** The model the provider picks when none is chosen. */
  isDefault?: boolean
}

/** A slash command or skill the account's agent understands, e.g. /review. */
export interface CommandInfo {
  name: string
  description: string
  hint?: string
}

export interface AccountStatus {
  accountId: string
  state: 'checking' | 'ready' | 'signed-out' | 'error'
  email?: string
  plan?: string
  organization?: string
  error?: string
  models?: ModelOption[]
  commands?: CommandInfo[]
  checkedAt: number
}

export interface UsageWindow {
  /** 0..1 */
  utilization: number
  /** epoch ms */
  resetsAt: number | null
  status?: 'allowed' | 'allowed_warning' | 'rejected'
}

export interface AccountUsage {
  accountId: string
  session?: UsageWindow
  weekly?: UsageWindow
  scoped?: { label: string; utilization: number; resetsAt: number | null }[]
  updatedAt: number
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  leadId: string | null
  defaultPermission: PermissionLevel
  defaultCwd: string | null
  claudePath: string | null
  onboarded: boolean
  memoryEnabled: boolean
  smartTitles: boolean
  notifications: boolean
  sidebarCollapsed: boolean
  /** Offer a likely next message after each reply. */
  suggestions: boolean
  /** The activity panel beside the chat. */
  inspector: boolean
  /** Closing the window keeps the team running in the tray. */
  keepRunning: boolean
  /** Ctrl+Shift+Space brings the window up from anywhere. */
  globalHotkey: boolean
  launchAtLogin: boolean
  /** Agents may use the built-in web browser. */
  browser: boolean
  /** Agents may use this computer's screen, mouse and keyboard: never, after asking in each chat, or freely. */
  computer: 'off' | 'ask' | 'on'
  /** The folder of notes the team reads before work and writes what it learns into. null means none. */
  vaultPath: string | null
  /** When the team writes to the vault: only when asked, or on its own after substantial work. */
  vaultNotes: 'ask' | 'auto'
  /**
   * Spend as little allowance as possible on the team talking among itself: notes wait for
   * the reader's next piece of work, reports are read together, quick questions go to the
   * teammate's lightest model.
   */
  lightTalk: boolean
  /**
   * Choose each agent's model from what its account can afford: the strongest model while
   * there is allowance to spare before it resets, a step down when it is running short.
   * An account with a model picked by hand is left alone.
   */
  smartModels: boolean
  /** How many extra agents the team may start in one chat. 0 means none, -1 lets the app decide from the allowance left. */
  maxAgents: number
  /** How many agents any one agent may start. */
  maxPerAgent: number
  /**
   * How models are chosen further down the team. 'auto': the lead gets the strongest model
   * the allowance allows, those it hands work to a step down, their sub-agents a step further,
   * adjusted by what the team has learned. 'saver': one step cheaper again. 'quality': no steps down.
   */
  economy: 'saver' | 'auto' | 'quality'
  /** Look in the vault for notes that bear on each new request and task, and put them in front of the agent. */
  recall: boolean
  /** Keep a note in the vault of every substantial chat: what was asked, what came of it, what was decided. */
  chatNotes: boolean
  /** How many times the lead is sent back to a goal before the app stops and asks. */
  goalRounds: number
  /** Who says a goal is met: a fresh checker that did not do the work, or the lead's own word. */
  goalCheck: GoalCheck
}

/** What the team has learned about one model family. */
export interface ModelRecord {
  family: string
  tier: 'top' | 'strong' | 'mid' | 'light'
  done: number
  failed: number
  /** Ratings from whoever handed the work out. */
  enough: number
  weak: number
  more: number
  updatedAt: number
  /** The same ratings, split by the kind of work, so a model can be right for one kind and not another. */
  kinds?: Record<string, { enough: number; weak: number; more: number }>
}

/** A named group of chats in the sidebar. */
export interface Folder {
  id: string
  name: string
  collapsed?: boolean
  order: number
  /** The Claude Code section it was made from, so importing again adds to it instead of making a second one. */
  source?: string
  /** What every agent in this folder's chats is told, in the user's words, like a project's instructions. */
  instructions?: string
}

export interface Chat {
  id: string
  title: string
  titleLocked?: boolean
  cwd: string
  createdAt: number
  updatedAt: number
  permission: PermissionLevel
  pinned?: boolean
  snippet?: string
  /** Who leads this chat, when it is not the team's usual lead. */
  leadId?: string | null
  /** Set when the lead changed mid-chat. The new lead is caught up with its next message. */
  handoff?: { from: string; reason: 'limit' | 'manual' } | null
  /**
   * Set when the app was closed, or crashed, while this chat's team was working: what was cut
   * short, so it can be picked up again. `told` means the lead has already been told.
   */
  recovery?: { at: number; tasks: string[]; agents: string[]; told?: boolean } | null
  /**
   * Provider-side session ids, so every agent can pick the conversation back up. `fork` means
   * the conversation belongs to something else (Claude Code) and is carried on in a copy.
   */
  sessions: Record<string, { providerSessionId?: string; fork?: boolean }>
  /** The folder it is filed under. Absent or null means none. */
  folderId?: string | null
  /** The chat's own note in the vault, once one has been written, relative to the vault. */
  memoryNote?: string
  /** Agents that were started inside this chat by the lead or by a teammate. */
  agents?: Account[]
  /**
   * Set on a chat brought in from Claude Code. `resumed` means the lead picks up the very same
   * conversation; otherwise it is told what was said, once, with the first message (`told`).
   */
  imported?: { from: 'claude-code'; sessionId: string; resumed: boolean; told?: boolean; at: number }
  /** What the team keeps working towards in this chat until it is met, when one was set. */
  goal?: Goal | null
  /** Messages that repeat by themselves in this chat. */
  loops?: Loop[]
  /**
   * Ultra is on for this chat: every message sent with no other mode goes as 'ultra' (many agents,
   * the strongest models, full effort). It stays on until it is turned off. '/gocrazy' needs it.
   */
  ultra?: boolean
}

// ───────────── goals, loops and ways of working ─────────────

/**
 * How the lead goes about one message.
 * 'chat': the lead decides. 'quick': the lead answers alone, no handoffs. 'plan': a plan first,
 * work starts once the user approves it. 'thorough': the whole team from the start, and a fresh
 * reviewer before the answer. 'council': every model answers on its own and the lead compares
 * them. 'research': angles, sources, and a check of the claims. 'ultra': a staged pipeline of many
 * agents on the strongest models at full effort (scouts, builders, judges, refinement), spending
 * allowance freely. 'gocrazy': ultra at full scale; only allowed while the chat's Ultra is on.
 */
export type WorkMode = 'chat' | 'quick' | 'plan' | 'thorough' | 'council' | 'research' | 'ultra' | 'gocrazy'
export const WORK_MODES: WorkMode[] = ['chat', 'quick', 'plan', 'thorough', 'council', 'research', 'ultra', 'gocrazy']

export type GoalCheck = 'fresh' | 'self'

/**
 * 'active': being worked on. 'paused': waits for the user to resume it. 'met': done, and checked.
 * 'blocked': the lead needs something only the user can give. 'stopped': ended without being met
 * (the user stopped it, or it ran out of rounds or time).
 */
export type GoalStatus = 'active' | 'paused' | 'met' | 'blocked' | 'stopped'

/** Something the team keeps working on until it is done: after each reply the app checks, and sends the lead back if it is not. */
export interface Goal {
  id: string
  /** What is to be achieved, in the user's words. */
  text: string
  /** How to tell it is done, when the user said. */
  doneWhen?: string
  status: GoalStatus
  /** How many times the lead has been sent back to it so far. 0 while the first reply is under way. */
  round: number
  /** After this many rounds the app stops and asks. */
  maxRounds: number
  /** Stop at this time whatever the state. Epoch ms. */
  deadline?: number | null
  check: GoalCheck
  createdAt: number
  endedAt?: number
  /** Why it stands where it stands: the latest verdict, what is missing, or why it stopped. */
  note?: string
  /** One line for each check made so far, oldest first. */
  log: { round: number; ts: number; met: boolean; note: string }[]
  /** A check is being made right now. */
  checking?: boolean
}

export interface GoalInput {
  text: string
  doneWhen?: string
  maxRounds?: number
  /** A time limit, in minutes from now. */
  minutes?: number | null
  check?: GoalCheck
}

/** 'more' gives a goal that ran out of rounds or time another batch and carries on. */
export type GoalAction = 'pause' | 'resume' | 'stop' | 'more'

/** A message that is sent again by itself: every so often, or whenever the agent says the next run is due. */
export interface Loop {
  id: string
  /** What is said to the agent each time. */
  prompt: string
  /** Who it is said to. An account or agent id; normally the lead. */
  to: string
  /** Milliseconds between the start of one run and the next. null: the agent sets the pace itself after each run. */
  every: number | null
  /** 'done' means it ended for good: it met its stop condition, ran out of runs, or the agent ended it. */
  status: 'active' | 'paused' | 'done'
  /** Runs started so far. */
  runs: number
  /** Stop after this many runs. null or absent: no limit. */
  maxRuns?: number | null
  /** Stop once this is true. The agent judges it after each run. */
  until?: string
  /** When the next run is due. Epoch ms. null while paused or done. */
  nextAt: number | null
  lastAt?: number
  /** A line on how the last run went. */
  last?: string
  /** Why it is paused or done, when the app or the agent did that. */
  note?: string
  /** A run is under way right now. */
  running?: boolean
  createdAt: number
}

export interface LoopInput {
  prompt: string
  /** Milliseconds between runs, at least 60000. null or absent: the agent paces itself. */
  every?: number | null
  maxRuns?: number | null
  until?: string
  /** Who runs it. Absent: the chat's lead. */
  to?: string
  /** Run once right away (the default), or wait one interval first. */
  startNow?: boolean
}

export type AgentPhase = 'idle' | 'starting' | 'thinking' | 'responding' | 'tool' | 'waiting' | 'error'

export interface AgentState {
  chatId: string
  accountId: string
  phase: AgentPhase
  /** Short present-tense line, e.g. "Reading src/app.ts". */
  activity?: string
  queued: number
  taskId?: string | null
  model?: string
  turnStartedAt?: number
  error?: string
  /** How full the agent's working memory is, in tokens. */
  context?: { used: number; max: number }
  /** A likely next message, offered in the message box. */
  suggestion?: string
  /** How many steps (tool calls) the reply in progress has taken so far. */
  steps?: number
  /** Why the app chose the model this agent is running, when it chose one. */
  modelWhy?: string
}

export interface Attachment {
  path: string
  name: string
  kind: 'image' | 'file'
}

export interface QuestionSpec {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

interface ItemBase {
  id: string
  ts: number
}

export type Item =
  | (ItemBase & { kind: 'user'; text: string; attachments?: Attachment[]; queued?: boolean })
  | (ItemBase & {
      kind: 'peer'
      from: string
      tag: 'message' | 'task' | 'result' | 'question'
      text: string
      taskId?: string
      title?: string
      status?: TaskStatus
      queued?: boolean
    })
  | (ItemBase & { kind: 'assistant'; text: string; streaming?: boolean })
  | (ItemBase & { kind: 'thinking'; text: string; streaming?: boolean; durationMs?: number })
  | (ItemBase & {
      kind: 'tool'
      name: string
      input?: unknown
      output?: string
      status: 'running' | 'done' | 'error'
      durationMs?: number
      images?: string[]
      parentId?: string
    })
  | (ItemBase & { kind: 'delegate'; taskId: string; to: string; title: string; brief: string })
  /** A new agent this one started in the chat. */
  | (ItemBase & { kind: 'spawn'; agentId: string; name: string; role: string; base: string })
  | (ItemBase & { kind: 'outgoing'; to: string; text: string })
  | (ItemBase & {
      /** A question put to a teammate, with the answer once it comes back. */
      kind: 'ask'
      to: string
      text: string
      status: 'waiting' | 'answered' | 'failed'
      answer?: string
      durationMs?: number
    })
  | (ItemBase & {
      kind: 'permission'
      requestId: string
      toolName: string
      title: string
      detail?: string
      input?: unknown
      canRemember?: boolean
      status: 'pending' | 'allowed' | 'always' | 'denied' | 'expired'
    })
  | (ItemBase & {
      /** An agent needs the user to sign in to a site in its browser, and waits. */
      kind: 'signin'
      requestId: string
      site: string
      url: string
      why?: string
      status: 'pending' | 'done' | 'skipped' | 'expired'
    })
  | (ItemBase & {
      kind: 'question'
      requestId: string
      questions: QuestionSpec[]
      status: 'pending' | 'answered' | 'expired'
      answers?: Record<string, string>
    })
  | (ItemBase & {
      kind: 'notice'
      level: 'info' | 'warn' | 'error'
      text: string
      /** A one-click way out of the problem the notice describes. */
      action?: { kind: 'switch-lead'; to: string; done?: boolean } | { kind: 'resume'; done?: boolean }
    })
  | (ItemBase & {
      /**
       * Something the app did by itself for a goal or a loop: set it, checked it, sent the lead
       * back, ran it again, ended it. Shown as a slim card in the transcript.
       */
      kind: 'auto'
      of: 'goal' | 'loop'
      event: 'set' | 'check' | 'met' | 'blocked' | 'paused' | 'resumed' | 'stopped' | 'run' | 'done'
      /** The goal's or the loop's id. */
      ref: string
      /** One line, e.g. "Goal set" or "Check 2 of 12: not there yet". */
      title: string
      /** The detail: what is still missing, the loop's message, why it ended. */
      text?: string
      /** Which round or run this was, and out of how many when there is a limit. */
      round?: number
      max?: number
    })
  /** Something an agent made or found: a picture, or with `media` set, a sound or a video. */
  | (ItemBase & { kind: 'image'; path: string; caption?: string; media?: 'audio' | 'video' })
  | (ItemBase & {
      /** One thing an agent did in its browser or on the computer. */
      kind: 'screen'
      surface: ScreenKind
      action: string
      /** Past tense, e.g. "Clicked Sign in". */
      label: string
      status: 'running' | 'done' | 'error'
      /** Where it acted, as fractions of the screen's width and height. */
      x?: number
      y?: number
      /** A picture of the screen right after. */
      shot?: string
      url?: string
      error?: string
      durationMs?: number
    })
  | (ItemBase & {
      kind: 'turn'
      status: 'done' | 'interrupted' | 'error'
      durationMs: number
      steps?: number
      /** Tokens the model wrote this turn. */
      tokens?: number
      /** Present when the turn changed files and they can be put back. */
      checkpoint?: string
      /** The model the reply ran on. */
      model?: string
      undone?: boolean
    })

export type ItemKind = Item['kind']

/** 'interrupted' means the app closed while the task was under way; it can be picked up again. */
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface Task {
  id: string
  chatId: string
  title: string
  brief: string
  from: string
  to: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: string
  /** Who had this first, when it was moved to someone else. */
  movedFrom?: string
  /** The model and effort the lead asked for, when it chose them for this task. */
  model?: string
  modelLabel?: string
  effort?: string
  /** Tasks this one was lined up behind. It starts when they are done and is handed their reports. */
  after?: string[]
  /** Those of them that have not finished yet. Empty or absent once the task may start. */
  waitingOn?: string[]
  /** Started again after the agent's process died under it. This happens once. */
  retried?: boolean
  /** The model the task actually ran on. */
  ranOn?: string
  /** What kind of work it is, worked out from its title and brief: research, code, review, writing, media, routine. */
  kind?: string
  /** Set when the app chose the model, not whoever handed the task out, with the reason. */
  modelWhy?: string
  /** Tried again on a stronger model after the cheaper one could not finish it. This happens once. */
  escalated?: boolean
  /** Nobody had allowance left: it starts by itself at this time. */
  parkedUntil?: number
  /** What whoever handed it out thought of the model for this job. */
  rated?: 'enough' | 'too_weak' | 'more_than_needed'
  /**
   * Whoever has this task handed parts of it to agents of their own and is waiting for them.
   * The task stays open until those are back and its owner has had the last word.
   */
  holding?: boolean
}

export interface MemoryNote {
  id: string
  title: string
  body: string
  /** 'you' or an account id. */
  author: string
  createdAt: number
  updatedAt: number
}

export interface AccountCandidate {
  provider: Provider
  configDir: string | null
  suggestedName: string
  signedIn: boolean
  email?: string
  plan?: string
}

/** What a new computer already has, for the first-run screens. */
export interface SetupStatus {
  /** Claude Code can be found (installed, or set in Settings). */
  claude: boolean
  /** The ChatGPT runtime is bundled, so this is normally true. */
  chatgpt: boolean
  obsidian: boolean
  /** Windows only: Git for Windows, which Claude Code uses for its shell. */
  gitBash: boolean
}

export interface LoginProgress {
  accountId: string
  state: 'starting' | 'waiting' | 'success' | 'failed' | 'cancelled'
  url?: string
  message?: string
}

export interface ChatSnapshot {
  chat: Chat
  items: Record<string, Item[]>
  tasks: Task[]
  states: AgentState[]
}

export interface ChangedFile {
  /** Relative to the chat's folder, forward slashes. */
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  added?: number
  removed?: number
}

/** What is different on disk in a chat's folder, when it is a git repository. */
export interface FolderChanges {
  repo: boolean
  branch?: string
  files: ChangedFile[]
}

export interface RewindPreview {
  ok: boolean
  error?: string
  files: string[]
  added: number
  removed: number
}

export interface LibraryImage {
  path: string
  chatId: string
  chatTitle: string
  accountId: string
  ts: number
}

// ───────────── browser and computer ─────────────

export type ScreenKind = 'browser' | 'desktop'

/** A browser an agent is driving, or the computer's own screen while an agent controls it. */
export interface ScreenState {
  chatId: string
  accountId: string
  kind: ScreenKind
  /** True while the agent is in the middle of using it. */
  active: boolean
  width: number
  height: number
  url?: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  /** The latest thing the agent did, for the pointer drawn over the picture. */
  pointer?: { x: number; y: number; action: string; label: string; ts: number }
}

/** One picture of a screen, sent as it changes. */
export interface ScreenFrame {
  /** `${chatId}:${accountId}:${kind}` */
  key: string
  width: number
  height: number
  data: Uint8Array
}

/** What the person does when they take the mouse in an agent's browser. Positions are fractions of the page. */
export type ScreenInput =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clicks?: number; mods?: string[] }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; mods?: string[] }

// ───────────── knowledge vault ─────────────

export interface VaultInfo {
  path: string
  name: string
  notes: number
  /** The vault's own instructions for agents, when it has them (AGENTS.md or CLAUDE.md). */
  guide?: string
}

export interface VaultHit {
  /** Relative to the vault, forward slashes. */
  path: string
  title: string
  folder: string
  type?: string
  status?: string
  updated?: string
  snippet: string
}

export interface VaultNote {
  path: string
  title: string
  content: string
  truncated?: boolean
  /** Notes this one links to, and notes that link here. */
  links: string[]
  backlinks: string[]
  mtime: number
}

// ───────────── bringing chats in from Claude Code ─────────────

/** One conversation found in the Claude desktop app's Code tab. */
export interface ImportSession {
  /** The desktop app's own id for it. */
  id: string
  title: string
  cwd: string
  updatedAt: number
  /** The whole conversation is on disk, so the lead can carry on in it rather than be told about it. */
  resumable: boolean
  /** Already brought in earlier. */
  imported: boolean
}

/** A sidebar section of the Code tab, with the conversations filed under it. */
export interface ImportSection {
  id: string
  name: string
  sessions: ImportSession[]
}

export interface ImportScan {
  /** False when no Claude desktop app data was found on this computer. */
  found: boolean
  sections: ImportSection[]
  /** Conversations that are not in any section. */
  loose: ImportSession[]
}

export interface ImportResult {
  chats: number
  folders: number
  skipped: number
}

export interface SearchHit {
  chatId: string
  title: string
  accountId?: string
  snippet: string
  ts: number
}

export interface Bootstrap {
  settings: Settings
  accounts: Account[]
  statuses: AccountStatus[]
  usage: AccountUsage[]
  chats: Chat[]
  folders: Folder[]
  states: AgentState[]
  memory: MemoryNote[]
  screens: ScreenState[]
  vault: VaultInfo | null
  env: {
    platform: string
    mica: boolean
    home: string
    version: string
    demo: boolean
    /** Whether this build can drive a browser and the computer at all. */
    canBrowse: boolean
    canControl: boolean
  }
}

/** Everything the main process pushes to the window. */
export type HubEvent =
  | { type: 'settings'; settings: Settings }
  | { type: 'accounts'; accounts: Account[] }
  | { type: 'account-status'; status: AccountStatus }
  | { type: 'account-usage'; usage: AccountUsage }
  | { type: 'login'; progress: LoginProgress }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat-removed'; chatId: string }
  | { type: 'folders'; folders: Folder[] }
  | { type: 'agent'; state: AgentState }
  | { type: 'item'; chatId: string; accountId: string; item: Item }
  | { type: 'item-patch'; chatId: string; accountId: string; id: string; patch: Record<string, unknown> }
  | { type: 'item-delta'; chatId: string; accountId: string; id: string; text: string }
  | { type: 'task'; task: Task }
  | { type: 'memory'; notes: MemoryNote[] }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'theme'; dark: boolean }
  | { type: 'focus-chat'; chatId: string; accountId?: string }
  | { type: 'screen'; screen: ScreenState }
  | { type: 'screen-closed'; chatId: string; accountId: string; kind: ScreenKind }
  | { type: 'vault'; vault: VaultInfo | null }
  /** A new version is on its way, or downloaded and ready to install. */
  | { type: 'update'; state: 'downloading' | 'ready'; version: string }
  /** Progress of installing Claude Code from the first-run screen. */
  | { type: 'setup'; stage: 'download' | 'install' | 'done' | 'failed'; pct?: number; message?: string }
  /** Connectors changed in the background (a sign-in renewed or ran out): the window re-reads them. */
  | { type: 'connectors' }
  /** The window was brought up from the tray or the global shortcut. */
  | { type: 'summon'; fresh?: boolean }

export interface SendRequest {
  chatId: string
  to: string
  text: string
  attachments?: Attachment[]
  /** How the lead should go about this message. Absent means 'chat'. */
  mode?: WorkMode
  /**
   * Makes this message the chat's goal: the lead works on it, the app checks after each reply,
   * and sends the lead back until it is met. `goal.text` may be left empty to use `text`.
   */
  goal?: Partial<GoalInput>
  /** Makes this message a loop: it runs now and then again by itself. `loop.prompt` may be left empty to use `text`. */
  loop?: Partial<LoopInput>
}

export type PermissionDecision = 'allow' | 'always' | 'deny'

/** The typed bridge exposed on window.ensemble. */
export interface EnsembleApi {
  bootstrap(): Promise<Bootstrap>
  onEvent(cb: (ev: HubEvent) => void): () => void

  updateSettings(patch: Partial<Settings>): Promise<Settings>

  discoverAccounts(): Promise<AccountCandidate[]>
  setupStatus(): Promise<SetupStatus>
  /** Downloads and installs Claude Code; progress arrives as `setup` events. */
  installClaude(): Promise<boolean>
  addAccount(input: { name: string; provider: Provider; configDir?: string | null; create?: boolean; accent?: AccentKey }): Promise<Account>
  updateAccount(id: string, patch: Partial<Pick<Account, 'name' | 'accent' | 'model' | 'effort' | 'role' | 'enabled'>>): Promise<Account>
  removeAccount(id: string): Promise<void>
  refreshAccounts(id?: string): Promise<void>
  login(id: string): Promise<void>
  submitLoginCode(id: string, code: string): Promise<void>
  cancelLogin(id: string): Promise<void>
  logout(id: string): Promise<void>

  createChat(input: { cwd?: string | null; title?: string; folderId?: string | null }): Promise<Chat>
  openChat(id: string): Promise<ChatSnapshot>
  updateChat(id: string, patch: Partial<Pick<Chat, 'title' | 'cwd' | 'permission' | 'pinned' | 'folderId'>>): Promise<Chat>
  deleteChat(id: string): Promise<void>

  createFolder(name: string): Promise<Folder>
  updateFolder(id: string, patch: Partial<Pick<Folder, 'name' | 'collapsed' | 'order' | 'instructions'>>): Promise<Folder>
  /** Removes the folder. Its chats are kept and go back to the unfiled list. */
  deleteFolder(id: string): Promise<void>

  /** Looks for the Claude desktop app's Code conversations and the sections they are filed under. */
  importScan(): Promise<ImportScan>
  /**
   * Brings the chosen conversations in, each under a folder named after its section. 'continue'
   * has the lead carry on in a copy of the conversation itself; 'summary' tells it what was said.
   */
  importRun(sessionIds: string[], mode?: 'continue' | 'summary'): Promise<ImportResult>

  /** Outside services every agent can use, how to add one, and what other apps on this computer already have. */
  connectors(): Promise<ConnectorView[]>
  connectorsFound(): Promise<FoundConnector[]>
  connectorSave(input: ConnectorInput): Promise<ConnectorView>
  connectorRemove(id: string): Promise<void>
  connectorTest(id: string): Promise<ConnectorTest>
  /** Opens the service's own sign-in page in the browser and resolves once signed in and tried. */
  connectorSignIn(id: string): Promise<ConnectorTest>
  connectorCancelSignIn(): Promise<void>
  connectorSignOut(id: string): Promise<void>

  /** Sites the team's browser is signed in to (it keeps their cookies), and signing out of one. */
  browserSites(): Promise<{ site: string; cookies: number }[]>
  browserForget(site: string): Promise<void>

  /** What the team has learned about its models, and forgetting it. */
  learning(): Promise<ModelRecord[]>
  resetLearning(): Promise<void>

  /** Sends home an agent that was started inside a chat. What it did stays readable. */
  removeAgent(chatId: string, agentId: string): Promise<void>
  searchChats(query: string): Promise<SearchHit[]>
  /** Puts another teammate in charge of a chat and catches them up. `retry` resends your last message to them. */
  setChatLead(id: string, accountId: string, retry?: boolean): Promise<Chat>
  /** Picks up what was cut short when the app closed: interrupted tasks start again and the lead is told. */
  resumeChat(id: string): Promise<void>
  /** Leaves what was cut short as it is. */
  dismissRecovery(id: string): Promise<void>
  exportChat(id: string): Promise<string | null>
  folderChanges(id: string): Promise<FolderChanges>
  fileDiff(id: string, path: string): Promise<string>
  /** Puts files back to how they were before a reply. `apply: false` only previews. */
  rewind(chatId: string, accountId: string, turnId: string, apply: boolean): Promise<RewindPreview>
  listImages(): Promise<LibraryImage[]>

  /** Ask for (or stop asking for) pictures of a screen while it is on show. `full` is every frame; otherwise an occasional one. */
  screenWatch(key: string, on: boolean, full?: boolean): Promise<void>
  /** Says a picture was drawn, so the next one may be sent. Keeps a busy window from being buried in frames. */
  frameSeen(key: string): void
  /** The person's own mouse and keyboard, passed to an agent's browser. */
  screenInput(chatId: string, accountId: string, input: ScreenInput): Promise<void>
  /** 'back', 'forward', 'reload', or an address to open. */
  screenGo(chatId: string, accountId: string, to: string): Promise<void>
  /** Opens a teammate's browser without waiting for them to. */
  screenOpen(chatId: string, accountId: string, url?: string): Promise<void>
  screenClose(chatId: string, accountId: string): Promise<void>
  onFrame(cb: (frame: ScreenFrame) => void): () => void

  /** Makes a new, empty vault for the team in Documents and uses it. */
  createVault(): Promise<VaultInfo | null>
  /** Obsidian vaults found on this computer. */
  vaultList(): Promise<VaultInfo[]>
  vaultSearch(query: string): Promise<VaultHit[]>
  vaultRead(path: string): Promise<VaultNote | null>
  /** Opens a note in Obsidian (or the default app). */
  vaultOpen(path: string): Promise<void>

  send(req: SendRequest): Promise<void>
  stop(chatId: string, accountId?: string): Promise<void>

  /** Sets the chat's goal and puts the lead to work on it. null takes the goal off the chat (it stops if it was running). */
  setGoal(chatId: string, input: GoalInput | null): Promise<Chat>
  goalAction(chatId: string, action: GoalAction): Promise<Chat>
  addLoop(chatId: string, input: LoopInput): Promise<Chat>
  /** Changes a loop. `status` pauses it or sets it going again. */
  updateLoop(chatId: string, loopId: string, patch: Partial<Pick<Loop, 'prompt' | 'every' | 'maxRuns' | 'until'>> & { status?: 'active' | 'paused' }): Promise<Chat>
  removeLoop(chatId: string, loopId: string): Promise<Chat>
  /** Runs a loop right now without waiting for its time. */
  runLoop(chatId: string, loopId: string): Promise<void>
  /**
   * Rewrites a rough message into a clear one (what is wanted, what done looks like, what to
   * watch out for) without changing what it asks for. Returns the text unchanged when it cannot.
   */
  enhance(text: string, chatId?: string | null): Promise<string>
  /** Turns the chat's Ultra on or off. The chat also arrives through the usual `chat` event. */
  setUltra(chatId: string, on: boolean): Promise<Chat>
  respondPermission(requestId: string, decision: PermissionDecision, note?: string): Promise<void>
  respondQuestion(requestId: string, answers: Record<string, string> | null): Promise<void>
  cancelTask(chatId: string, taskId: string): Promise<void>

  saveMemory(note: { id?: string; title: string; body: string }): Promise<MemoryNote>
  deleteMemory(id: string): Promise<void>

  /** Restarts Ensemble on the downloaded version. */
  installUpdate(): Promise<void>
  pickFolder(): Promise<string | null>
  pickFiles(): Promise<Attachment[]>
  /** Saves a pasted picture so it can be attached. */
  saveImage(bytes: ArrayBuffer, mime: string): Promise<Attachment | null>
  openPath(path: string): Promise<void>
  showInFolder(path: string): Promise<void>
  /** Puts a picture on the clipboard. */
  copyImage(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  fileUrl(path: string): string
  pathForFile(file: File): string
}
