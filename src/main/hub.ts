import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { z } from 'zod'
import {
  ACCENTS,
  type Account,
  type AgentState,
  type Attachment,
  type Bootstrap,
  type ChangedFile,
  type Chat,
  type ChatSnapshot,
  type Folder,
  type GoalAction,
  type GoalInput,
  type Loop,
  type LoopInput,
  type FolderChanges,
  type HubEvent,
  type ImportResult,
  type ImportScan,
  type Item,
  type LibraryImage,
  type ModelOption,
  type PermissionDecision,
  type RewindPreview,
  type ScreenFrame,
  type ScreenInput,
  type SearchHit,
  type SendRequest,
  type Settings,
  type Task,
  type TaskStatus,
  type VaultHit,
  type VaultInfo,
  type SetupStatus,
  type VaultNote,
} from '@shared/types'
import { AGENT_MB, AGENTS_PER_CORE, CRAZY_FLOOR, GOCRAZY_NEEDS_ULTRA, isSmallTalk, MAX_DEPTH_GOCRAZY, REGION_TEAM, MAX_DEPTH_ULTRA, MAX_DEPTH_USUAL, SPAWN_CAP_GOCRAZY, SPAWN_CAP_ULTRA, everyLabel, namesLine, parseCommand, span } from '@shared/auto'
import { Autopilot } from './autopilot'
import { Failover } from './failover'
import { describeTool } from '@shared/tools'
import { handoverLine } from '@shared/failover'
import { adviseModel, budgetLine, budgetOf, isTopModel, modelForTier, spendScore, TIER_ORDER, tierOfModel, type Tier } from '@shared/budget'
import { familyOf, kindLabel, kindOf, Learning, type Verdict } from './learning'
import { ConnectorStore, findConnectors, ownConnectors, type Sealer } from './connectors'
import type { ConnectorInput, ConnectorTest, ConnectorView, FoundConnector } from '@shared/connectors'
import { importTranscript, scanClaudeCode, type FoundSession } from './importer'
import { AccountManager } from './accounts'
import { MemoryStore } from './memory'
import { AgentSession, type OpenAsk, type Pending, type RunSpec, type SessionHost, type TurnEnd } from './session'
import { ClaudeRuntime, askClaudeOnce } from './providers/claude'
import { CodexRuntime, askCodexOnce } from './providers/codex'
import { DemoRuntime, demoChanges, demoDiff } from './providers/demo'
import type { AgentRuntime, RuntimeEvent, TeamTool } from './providers/types'
import { ENHANCE_SYSTEM, leadBriefing, memberBriefing, modeNote, modeReminder, crazyFollowUp, TITLE_SYSTEM, type BriefingContext } from './prompts'
import { Hands } from './hands/hands'
import type { HandsDrivers } from './hands/types'
import { Vault, detectVaults } from './vault'
import { findClaude, findCodex } from './locate'
import { NEW_USER, installClaude, setupStatus } from './setup'
import { ToolServer } from './toolserver'
import { debounce, demoTime, exists, readJson, slugify, truncate, uid, writeJson } from './util'

export interface HubHost {
  dataDir: string
  version: string
  demo: boolean
  /** "Try the demo team": the scripted team, set up and ready, with a bar saying it is a demo. */
  trial?: boolean
  mica: boolean
  emit(ev: HubEvent): void
  notify(title: string, body: string, target: { chatId: string; accountId?: string }): void
  isFocused(): boolean
  /** What can touch a browser and the computer on this machine. Absent in terminal tests. */
  hands?: HandsDrivers
  /** A fresh picture of a screen an agent is using. */
  frame?(f: ScreenFrame): void
  /** Encrypts and decrypts connector secrets. Absent in terminal tests. */
  sealer?: Sealer
}

const NEW_TITLE = 'New chat'
/** How long someone who asked a teammate a question waits for the answer. */
const ASK_WAIT_MS = 8 * 60 * 1000
/** How long a report or a note may wait to be read with the reader's next piece of work before they are woken for it. */
const HOLD_MS = 12 * 60 * 1000
/** In Ultra, an agent the lead started that has sat this long with nothing to do is sent home. */
const IDLE_AGENT_MS = 3 * 60 * 1000

/** Something left for an agent to read with its next turn. `user` marks the user's own message. */
interface Waiting {
  text: string
  itemIds: string[]
  user?: boolean
}
/** Past this much conversation, a smaller model would have to cut the conversation down to fit it. */
const LIGHT_LIMIT = 110_000
/** Words that mean "pick up where you were", said to a team that was cut short. */
const CONTINUE = /^\W*(continue|carry on|go on|keep going|resume|proceed|pick (it )?up|go ahead|nastavi)\b/i
/** Signs that an agent's process died, as opposed to the agent failing at its work. */
const DIED = /stopped unexpectedly|process exited|exited with code|terminated|ECONNRESET|EPIPE|spawn /i
/** How far down the team goes: the lead, the agents it works with, and their sub-agents. */
/** Words that mean "everyone" as the receiver of a note. */
const EVERYONE = /^(all|everyone|everybody|team|the team)$/i
/** Names for agents that were started without one. */
const SPARE_NAMES = ['Scout', 'Atlas', 'Nova', 'Juno', 'Orion', 'Vega', 'Lyra', 'Kite', 'Wren', 'Sol', 'Iris', 'Pax']

/** What an agent passes to start another agent in its chat. */
interface SpawnArgs {
  name?: string
  role?: string
  account?: string
  title?: string
  brief?: string
  model?: string
  effort?: string
  after?: string[] | string
}

/** A note on a chat's team board: something every agent in the chat should know. */
interface BoardNote {
  id: string
  title: string
  text: string
  author: string
  ts: number
}

const DEFAULTS: Settings = {
  theme: 'system',
  leadId: null,
  defaultPermission: 'auto',
  defaultCwd: null,
  claudePath: null,
  onboarded: false,
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
  goalRounds: 12,
  goalCheck: 'fresh',
  handover: true,
}

/** How many times one task may move on because its owner ran out of usage. */
const MAX_MOVES = 3

/** A few notes for the scripted demo team to find, so the vault can be shown without touching a real one. */
function demoVault(dir: string): string {
  const root = path.join(dir, 'Demo vault')
  const notes: Record<string, string> = {
    'AGENTS.md': '# Guide for agents\n\nProjects live in `Projects/`, decisions in `Decisions/` (one note each, dated), research in `Knowledge/`. Link notes with their full path.\n',
    'Projects/Storefront.md':
      '---\ntype: project\nstatus: active\nupdated: 2026-11-10\n---\n\n# Storefront\n\nThe web shop. React and Vite, tests with Vitest.\n\n## Decisions\n- [[Decisions/2026-11-02 Three pricing tiers|Three pricing tiers]]\n\n## Open questions\n- Annual discount: 15% or 20%?\n',
    'Decisions/2026-11-02 Three pricing tiers.md':
      '---\ntype: decision\nstatus: accepted\nupdated: 2026-11-02\n---\n\n# Three pricing tiers\n\nStarter, Team and Scale. Annual billing gets a discount; the number is still open. See [[Projects/Storefront|Storefront]].\n',
    'Knowledge/Checkout flows.md':
      '---\ntype: concept\nstatus: evergreen\nupdated: 2026-10-28\n---\n\n# Checkout flows\n\nA hosted checkout page converts better than an embedded form for a first purchase. Webhooks, not redirects, are the source of truth for payment.\n',
  }
  for (const [rel, text] of Object.entries(notes)) {
    const file = path.join(root, rel)
    if (fs.existsSync(file)) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
  }
  return root
}

const esc = (s: string): string => s.replace(/"/g, "'").replace(/[<>]/g, '')

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  })
}

const clipText = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n… the rest is too long to show here` : s)

const PORCELAIN: Record<string, ChangedFile['status']> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', T: 'modified', U: 'modified', '?': 'untracked' }

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export class Hub implements SessionHost {
  settings: Settings
  accounts: AccountManager
  memory: MemoryStore
  learning: Learning
  connectors: ConnectorStore
  chats = new Map<string, Chat>()
  private sessions = new Map<string, AgentSession>()
  private tasks = new Map<string, Task[]>()
  private asks = new Map<string, OpenAsk>()
  private chatter = new Map<string, number[]>()
  /** Who is waiting on whom for an answer, by session key. */
  private asking = new Map<string, string>()
  /** Reports and notes waiting to be read with the reader's next piece of work, by session key. */
  private waiting = new Map<string, Waiting[]>()
  private waitTimers = new Map<string, NodeJS.Timeout>()
  /** Chats whose lead ran out of allowance and was already offered a switch: the lead's id. One offer per dry spell. */
  private dryOffer = new Map<string, string>()
  /** Chats in Ultra due a look for agents that have sat idle. */
  private sweeps = new Map<string, NodeJS.Timeout>()
  /** Tasks stopped by whoever handed them out (not by the user), by chat and task id. */
  private stoppedBy = new Map<string, string>()
  /** Tasks taken back when the user stopped the lead in mid-reply, by `${chatId}:${taskId}`: however they end, the lead is not woken for it. */
  private takenBack = new Set<string>()
  /** A fingerprint of the briefing each agent's running process was given, by session key. */
  private briefs = new Map<string, string>()
  /** Who is in the middle of a reply right now. Kept on disk, so a crash leaves a trace of what was cut short. */
  private running = new Map<string, Set<string>>()
  private saveRunning = debounce(() => writeJson(this.file('running.json'), Object.fromEntries([...this.running].map(([k, v]) => [k, [...v]]))), 250)
  private quiet = new Set<string>()
  /** Chats whose lead is working a message in Ultra or Go crazy right now: their agent cap is raised. */
  private ultraRun = new Map<string, 'ultra' | 'gocrazy'>()
  folders: Folder[] = []
  /** Each chat's team board, read from disk the first time it is needed. */
  private boards = new Map<string, BoardNote[]>()
  /** Accounts whose strongest model hit its own limit, and until when to stay off it. */
  private capped = new Map<string, number>()
  /** Tasks waiting for an account's allowance to refill, by task key. */
  private parked = new Map<string, NodeJS.Timeout>()
  /** Chats whose vault note is due to be brought up to date. */
  private noteTimers = new Map<string, NodeJS.Timeout>()
  private toolServer = new ToolServer()
  /** Goals and loops: what keeps a chat working without the user typing again. */
  readonly auto: Autopilot
  /** Watches each account's usage and moves work on before it runs out, or as soon as it has. */
  readonly failover: Failover
  readonly hands: Hands
  private vault: Vault | null = null
  private saveChats: ReturnType<typeof debounce<[]>>
  private timer: NodeJS.Timeout | null = null
  private renewTimer: ReturnType<typeof setInterval> | null = null

  readonly dataDir: string

  constructor(private host: HubHost) {
    this.dataDir = host.dataDir
    fs.mkdirSync(path.join(this.dataDir, 'chats'), { recursive: true })
    const saved = readJson<Partial<Settings>>(this.file('settings.json'), {})
    this.settings = { ...DEFAULTS, ...saved }
    // First run: if Obsidian has a vault open on this computer, that is the team's library.
    if (!('vaultPath' in saved)) this.settings.vaultPath = host.demo ? (NEW_USER ? null : demoVault(this.dataDir)) : detectVaults()[0]?.path || null
    this.openVault()
    this.hands = new Hands(
      {
        dataDir: this.dataDir,
        settings: () => this.settings,
        updateSettings: (patch) => void this.updateSettings(patch),
        emit: (ev) => this.emit(ev),
        frame: (f) => host.frame?.(f),
        stop: (chatId, accountId) => void this.stop(chatId, accountId),
      },
      host.hands || {},
    )
    this.accounts = new AccountManager({
      dataDir: this.dataDir,
      demo: host.demo,
      emit: (ev) => {
        this.emit(ev)
        // Every change in an account's usage is a chance to move work on before it fails.
        if (ev.type === 'account-usage') this.failover?.observe(ev.usage.accountId)
      },
      claudePath: () => this.settings.claudePath,
      leadId: () => this.settings?.leadId ?? null,
    })
    this.memory = new MemoryStore(this.dataDir, (ev) => this.emit(ev))
    this.learning = new Learning(this.dataDir)
    this.connectors = new ConnectorStore(this.dataDir, host.sealer)
    for (const c of readJson<Chat[]>(this.file('chats.json'), [])) {
      this.chats.set(c.id, c)
      // Agents that were started inside a chat are kept with it; make them findable by id.
      for (const a of c.agents || []) this.accounts.register(a)
    }
    this.folders = readJson<Folder[]>(this.file('folders.json'), []).sort((a, b) => a.order - b.order)
    this.saveChats = debounce(() => writeJson(this.file('chats.json'), [...this.chats.values()]), 400)
    this.auto = new Autopilot({
      demo: host.demo,
      settings: () => this.settings,
      chats: () => this.chats.values(),
      chat: (id) => this.chats.get(id),
      lead: (chat) => this.lead(chat),
      account: (id) => this.accounts.get(id),
      unavailable: (a) => this.unavailable(a),
      session: (chat, a) => this.session(chat, a),
      out: (chat, a) => this.outFrom(chat, a).length,
      changed: (chat) => {
        // A goal that kept Go crazy going and is now over takes it with it.
        this.syncCrazy(chat)
        this.saveChats()
        this.emit({ type: 'chat', chat })
      },
      goalWay: (chat) => this.goalWay(chat),
      preface: (chat, a) => {
        const pre = this.takeWaiting(chat, a)
        return { text: this.catchUp(chat, a) + pre.text, itemIds: pre.itemIds }
      },
      tell: (title, body, chat, accountId) => this.tell(title, body, chat, accountId),
      stop: (chat) => this.stop(chat.id),
      // A wrong verdict costs a whole round of the lead's work, so the check gets a model that can judge.
      judge: (system, prompt, cwd, signal) => this.askLight(system, prompt, { model: 'sonnet', cwd, signal }),
      loopRun: (a, model) => this.loopRun(a, model),
    })
    this.failover = new Failover({
      settings: () => this.settings,
      chats: () => this.chats.values(),
      lead: (chat) => this.lead(chat),
      supply: (id) => this.accounts.supply(id),
      recheck: (id) => this.accounts.recheck(id),
      busy: (chat, a) => !!this.sessions.get(`${chat.id}:${a.id}`)?.busy,
      underWay: (chat, a) => {
        const s = this.sessions.get(`${chat.id}:${a.id}`)
        return this.outFrom(chat, a).length > 0 || (this.waiting.get(`${chat.id}:${a.id}`) || []).length > 0 || (s?.state.queued || 0) > 0 || chat.goal?.status === 'active'
      },
      successor: (chat, lead, strict) => this.successor(chat, lead, strict),
      handOver: (chat, from, to, why, until) => this.handOverDry(chat, from, to, why, until),
      allOut: (chat, lead) => this.allOut(chat, lead),
      coverBack: (chat) => {
        if (!chat.cover) return
        chat.cover.back = true
        this.saveChats()
        this.emit({ type: 'chat', chat })
      },
      wait: (ms) => this.wait(ms),
    })
  }

  /**
   * "Try the demo team": a ready team and a first chat that suggests what the scripted team does
   * well, with no first-run screens. Only ever in demo mode, in its own temp folder.
   */
  private async setUpTrial(): Promise<void> {
    if (this.accounts.accounts.length) return
    for (const c of await this.accounts.discover()) if (c.signedIn) this.accounts.add({ name: c.suggestedName, provider: c.provider, configDir: c.configDir })
    this.updateSettings({ onboarded: true, smartTitles: false })
    const lead = this.lead()
    if (!lead) return
    const cwd = path.join(this.dataDir, 'demo-project')
    fs.mkdirSync(cwd, { recursive: true })
    const chat = this.createChat({ cwd, title: 'Welcome to the demo team' })
    const welcome =
      'This is Ensemble with a scripted demo team: the agents, their work and their answers are played back, nothing is sent anywhere and no account or allowance is used. Everything you see works as it does for real, with your own Claude or ChatGPT accounts.\n\nPick something to watch, or type your own message:\n\n' +
      '```ui\n' +
      JSON.stringify({
        type: 'choices',
        prompt: 'Things the demo team does well',
        options: [
          { label: 'Add a pricing page with a monthly and yearly toggle', detail: 'The lead splits the work across the team, checks it and opens the page' },
          { label: '/goal the pricing page works and its tests pass', detail: 'A goal: the team keeps going until a fresh checker says it is done' },
          { label: '/gocrazy design the landing page', detail: 'Ultra at full scale: scouts, builders with their own critics, judges, and the winner running' },
        ],
      }) +
      '\n```'
    this.session(chat, lead).add({ id: uid('a'), kind: 'assistant', ts: Date.now(), text: welcome })
    this.saveChats()
    this.emit({ type: 'chat', chat })
  }

  async start(): Promise<void> {
    try {
      await this.toolServer.start()
    } catch {
      /* ChatGPT teammates simply go without team tools */
    }
    try {
      this.recover()
    } catch (e) {
      console.error('[recover]', (e as Error).message)
    }
    this.auto.start()
    if (this.host.trial && this.host.demo) await this.setUpTrial()
    void this.accounts.refresh()
    // Keep plan usage fresh without spending any of it.
    this.failover.sweep(this.accounts.accounts.map((a) => a.id))
    this.timer = setInterval(() => {
      for (const a of this.accounts.accounts) {
        const u = this.accounts.usage.get(a.id)
        if (!u || Date.now() - u.updatedAt > 4 * 60 * 1000) void this.accounts.refresh(a.id)
      }
      // Windows refill with nothing reported: look at every account again.
      this.failover.sweep(this.accounts.accounts.map((a) => a.id))
    }, 5 * 60 * 1000)
    // Connector sign-ins are renewed before they run out; agents pick up the new token with their next turn.
    const renewSignIns = (): void =>
      void this.connectors.renewAll().then(
        (changed) => {
          if (changed) this.retool()
          this.emit({ type: 'connectors' })
        },
        () => undefined,
      )
    if (!this.host.demo) {
      setTimeout(renewSignIns, 15_000)
      this.renewTimer = setInterval(renewSignIns, 5 * 60 * 1000)
    }
  }

  private file(name: string): string {
    return path.join(this.dataDir, name)
  }

  emit(ev: HubEvent): void {
    this.host.emit(ev)
  }

  // ----- bootstrap & settings -----

  bootstrap(): Bootstrap {
    return {
      settings: this.settings,
      accounts: this.accounts.accounts,
      statuses: [...this.accounts.statuses.values()],
      usage: [...this.accounts.usage.values()],
      chats: this.chatList(),
      folders: this.folders,
      states: [...this.sessions.values()].map((s) => ({ ...s.state })),
      memory: this.memory.notes,
      screens: this.hands.states(),
      vault: this.vaultInfo(),
      env: {
        platform: process.platform,
        mica: this.host.mica,
        home: os.homedir(),
        version: this.host.version,
        demo: this.host.demo,
        trial: !!this.host.trial,
        canBrowse: this.hands.canBrowse,
        canControl: this.hands.canControl,
      },
    }
  }

  private chatList(): Chat[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const before = this.settings
    const leadChanged = patch.leadId !== undefined && patch.leadId !== before.leadId
    // Who led each chat that follows the usual lead, before the change.
    const ledBy = leadChanged ? new Map([...this.chats.values()].filter((c) => !c.leadId).map((c) => [c.id, this.lead(c)])) : null
    this.settings = { ...before, ...patch }
    if (ledBy) this.handOver(ledBy)
    // On a team with no Claude account, the new lead gets the lead's role (unless the user wrote one).
    if (leadChanged) this.accounts.balanceRoles()
    writeJson(this.file('settings.json'), this.settings)
    this.emit({ type: 'settings', settings: this.settings })
    if (this.settings.vaultPath !== before.vaultPath) {
      this.openVault()
      this.emit({ type: 'vault', vault: this.vaultInfo() })
    }
    // Anything that changes what agents are told or which tools they hold means a fresh start for them.
    const retool = (['memoryEnabled', 'browser', 'computer', 'vaultPath', 'vaultNotes', 'lightTalk', 'smartModels', 'maxAgents', 'maxPerAgent', 'economy', 'recall'] as const).some((k) => this.settings[k] !== before[k])
    if (leadChanged || retool) for (const s of this.sessions.values()) s.recycle()
    return this.settings
  }

  /**
   * A new usual lead takes over every chat that follows it, the same way a lead changed inside one
   * chat does: work already handed out reports to the new lead, and it is told what happened so far.
   */
  private handOver(ledBy: Map<string, Account | null>): void {
    for (const [chatId, prev] of ledBy) {
      const chat = this.chats.get(chatId)
      const next = chat ? this.lead(chat) : null
      if (!chat || !prev || !next || prev.id === next.id) continue
      this.auto.leadChanged(chat, next)
      const old = this.sessions.get(`${chatId}:${prev.id}`)
      for (const t of this.tasksOf(chatId)) {
        if (t.from === prev.id && (t.status === 'running' || t.status === 'queued')) {
          t.from = next.id
          this.commitTask(t)
        }
      }
      const talked = (old?.items.length || 0) > 0 || fs.existsSync(path.join(this.dataDir, 'chats', chatId, `${prev.id}.json`))
      if (talked) {
        chat.handoff = { from: prev.id, reason: 'manual' }
        this.emit({ type: 'chat', chat })
      }
    }
    this.saveChats()
  }

  // ----- the knowledge vault -----

  private openVault(): void {
    const p = this.settings.vaultPath
    const v = p ? new Vault(p) : null
    this.vault?.dispose()
    this.vault = v?.exists ? v : null
    // Read it in the background so the first search does not have to wait.
    void this.vault?.warm().then(() => this.emit({ type: 'vault', vault: this.vaultInfo() }))
  }

  vaultInfo(): VaultInfo | null {
    return this.vault?.exists ? this.vault.info() : null
  }

  vaultList(): VaultInfo[] {
    const found = this.host.demo ? [] : detectVaults()
    const mine = this.vaultInfo()
    if (mine && !found.some((v) => v.path.toLowerCase() === mine.path.toLowerCase())) found.unshift(mine)
    return found
  }

  vaultSearch(query: string): VaultHit[] {
    return this.vault?.search(query, { limit: 20 }) || []
  }

  vaultRead(ref: string): VaultNote | null {
    const rel = this.vault?.resolve(ref)[0]
    return rel && this.vault ? this.vault.read(rel, 1, 120000) : null
  }

  /** Where a note is on disk, when it is inside the vault. */
  vaultPathOf(ref: string): string | null {
    if (!this.vault) return null
    const rel = this.vault.resolve(ref)[0]
    return rel ? this.vault.absolute(rel) : null
  }

  private vaultSkills(): string[] {
    if (!this.vault) return []
    try {
      return fs
        .readdirSync(path.join(this.vault.root, '.claude', 'skills'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 30)
    } catch {
      return []
    }
  }

  /** The team's usual lead, or the lead of one chat when it has its own. */
  lead(chat?: Chat): Account | null {
    const usable = this.accounts.accounts.filter((a) => a.enabled)
    return (
      (chat?.leadId ? usable.find((a) => a.id === chat.leadId) : undefined) ||
      usable.find((a) => a.id === this.settings.leadId) ||
      usable.find((a) => a.provider === 'claude' && a.configDir === null) ||
      usable.find((a) => a.provider === 'claude') ||
      usable[0] ||
      null
    )
  }

  // ----- accounts passthrough that needs hub knowledge -----

  updateAccount(id: string, patch: Parameters<AccountManager['update']>[1]): Account {
    const a = this.accounts.update(id, patch)
    if (patch.model !== undefined || patch.effort !== undefined) {
      for (const s of this.sessions.values()) if (s.account.id === id) s.recycle()
    }
    // Names, roles and who is on the team are part of everyone's briefing.
    if (patch.name !== undefined || patch.role !== undefined || patch.enabled !== undefined) {
      for (const s of this.sessions.values()) s.recycle()
    }
    return a
  }

  async removeAccount(id: string): Promise<void> {
    // Agents that were working on this account's sign-in go with it.
    for (const chat of this.chats.values()) {
      for (const a of chat.agents || []) if (a.spawned && a.spawned.base === id && !a.spawned.gone) await this.removeAgent(chat.id, a.id)
    }
    // Its tasks end now and their reports go back, rather than staying "running" for good.
    const name = this.accounts.get(id)?.name || 'That account'
    for (const chat of this.chats.values()) {
      for (const t of this.tasksOf(chat.id)) {
        if (t.to !== id || (t.status !== 'running' && t.status !== 'queued')) continue
        this.setTask(t, 'failed', `${name} was removed from the team before this finished. Give it to someone else or do it yourself.`)
        this.reportBack(t)
      }
    }
    for (const s of [...this.sessions.values()]) {
      if (s.account.id !== id) continue
      // Settles the reply under way and what was lined up, so loops and those waiting hear that it ended.
      s.end()
      this.sessions.delete(s.key)
      this.toolServer.unregister(s.key)
      this.dropWaiting(s.key)
    }
    this.accounts.remove(id)
    if (this.settings.leadId === id) this.updateSettings({ leadId: null })
  }

  // ----- folders -----

  private saveFolders(): void {
    this.folders.sort((a, b) => a.order - b.order)
    writeJson(this.file('folders.json'), this.folders)
    this.emit({ type: 'folders', folders: this.folders })
  }

  createFolder(name: string, source?: string): Folder {
    const clean = truncate(name.trim().replace(/\s+/g, ' '), 48) || 'New folder'
    const folder: Folder = { id: uid('f'), name: clean, order: this.folders.reduce((m, f) => Math.max(m, f.order), -1) + 1, source }
    this.folders.push(folder)
    this.saveFolders()
    return folder
  }

  updateFolder(id: string, patch: Partial<Pick<Folder, 'name' | 'collapsed' | 'order' | 'instructions'>>): Folder {
    const f = this.folders.find((x) => x.id === id)
    if (!f) throw new Error('That folder no longer exists.')
    const renamed = patch.name !== undefined && !!patch.name.trim() && patch.name.trim() !== f.name
    let retell = renamed && !!f.instructions
    if (patch.instructions !== undefined && patch.instructions.trim() !== (f.instructions || '').trim()) {
      f.instructions = patch.instructions.trim().slice(0, 20000) || undefined
      retell = true
    }
    // What every agent in the folder's chats is told has changed: they pick it up with their next turn.
    if (retell) for (const s of this.sessions.values()) if (s.chat.folderId === id) s.recycle()
    if (patch.name !== undefined && patch.name.trim()) f.name = truncate(patch.name.trim().replace(/\s+/g, ' '), 48)
    if (patch.collapsed !== undefined) f.collapsed = patch.collapsed
    if (patch.order !== undefined) {
      // Moving a folder: it takes the place asked for and the others close up around it.
      const rest = this.folders.filter((x) => x.id !== id)
      rest.splice(Math.max(0, Math.min(rest.length, Math.round(patch.order))), 0, f)
      rest.forEach((x, i) => (x.order = i))
      this.folders = rest
    }
    this.saveFolders()
    return f
  }

  deleteFolder(id: string): void {
    if (!this.folders.some((f) => f.id === id)) return
    this.folders = this.folders.filter((f) => f.id !== id)
    for (const chat of this.chats.values()) {
      if (chat.folderId !== id) continue
      chat.folderId = null
      this.emit({ type: 'chat', chat })
    }
    this.saveChats()
    this.saveFolders()
  }

  // ----- chats -----

  createChat(input: { cwd?: string | null; title?: string; folderId?: string | null }): Chat {
    const now = Date.now()
    let cwd = input.cwd || this.settings.defaultCwd || os.homedir()
    if (!exists(cwd)) cwd = os.homedir()
    const chat: Chat = {
      id: uid('c'),
      title: input.title?.trim() || NEW_TITLE,
      titleLocked: !!input.title?.trim(),
      cwd,
      createdAt: now,
      updatedAt: now,
      permission: this.settings.defaultPermission,
      sessions: {},
      folderId: input.folderId && this.folders.some((f) => f.id === input.folderId) ? input.folderId : null,
    }
    this.chats.set(chat.id, chat)
    this.saveChats()
    this.emit({ type: 'chat', chat })
    return chat
  }

  private need(chatId: string): Chat {
    const chat = this.chats.get(chatId)
    if (!chat) throw new Error('That chat no longer exists.')
    return chat
  }

  openChat(id: string): ChatSnapshot {
    const chat = this.need(id)
    const items: Record<string, Item[]> = {}
    const states: AgentState[] = []
    // Agents that were sent home are included: what they did stays readable.
    for (const a of [...this.accounts.accounts, ...(chat.agents || [])]) {
      const has = this.sessions.has(`${id}:${a.id}`) || exists(path.join(this.dataDir, 'chats', id, `${a.id}.json`))
      if (!has) continue
      const s = this.session(chat, a)
      items[a.id] = s.items
      states.push({ ...s.state })
    }
    return { chat, items, tasks: this.tasksOf(id), states }
  }

  updateChat(id: string, patch: Partial<Pick<Chat, 'title' | 'cwd' | 'permission' | 'pinned' | 'folderId'>>): Chat {
    const chat = this.need(id)
    if (patch.title !== undefined && patch.title.trim()) {
      chat.title = truncate(patch.title.trim(), 80)
      chat.titleLocked = true
    }
    if (patch.pinned !== undefined) chat.pinned = patch.pinned
    if (patch.folderId !== undefined) {
      const next = patch.folderId && this.folders.some((f) => f.id === patch.folderId) ? patch.folderId : null
      const told = (fid: string | null | undefined): boolean => !!this.folders.find((f) => f.id === fid)?.instructions
      // Moving into or out of a folder with instructions changes what the agents here are told.
      if (next !== (chat.folderId || null) && (told(next) || told(chat.folderId))) for (const s of this.sessionsOf(id)) s.recycle()
      chat.folderId = next
    }
    if (patch.cwd !== undefined && patch.cwd !== chat.cwd && exists(patch.cwd)) {
      chat.cwd = patch.cwd
      // A different folder means different project context: start agents fresh there.
      for (const s of this.sessionsOf(id)) s.recycle()
      chat.sessions = {}
    }
    if (patch.permission !== undefined && patch.permission !== chat.permission) {
      chat.permission = patch.permission
      for (const s of this.sessionsOf(id)) void s.setPermission()
    }
    this.saveChats()
    this.emit({ type: 'chat', chat })
    return chat
  }

  async deleteChat(id: string): Promise<void> {
    this.quiet.add(id)
    for (const s of this.sessionsOf(id)) {
      await s.stop()
      s.dispose()
      this.sessions.delete(s.key)
      this.toolServer.unregister(s.key)
      this.dropWaiting(s.key)
    }
    this.quiet.delete(id)
    this.dryOffer.delete(id)
    clearTimeout(this.sweeps.get(id))
    this.sweeps.delete(id)
    this.hands.closeChat(id)
    for (const a of this.chats.get(id)?.agents || []) this.accounts.unregister(a.id)
    const gone = this.chats.get(id)
    if (gone) this.auto.drop(gone)
    this.chats.delete(id)
    this.tasks.delete(id)
    this.boards.delete(id)
    this.saveChats()
    fs.rmSync(path.join(this.dataDir, 'chats', id), { recursive: true, force: true })
    this.emit({ type: 'chat-removed', chatId: id })
  }

  private touch(chat: Chat, snippet?: string): void {
    chat.updatedAt = Date.now()
    if (snippet?.trim()) chat.snippet = truncate(snippet.replace(/\s+/g, ' ').trim(), 140)
    this.saveChats()
    this.emit({ type: 'chat', chat })
  }

  // ----- sessions -----

  private session(chat: Chat, account: Account): AgentSession {
    const key = `${chat.id}:${account.id}`
    let s = this.sessions.get(key)
    if (!s) {
      s = new AgentSession(this, chat, account)
      this.sessions.set(key, s)
    }
    return s
  }

  private sessionsOf(chatId: string): AgentSession[] {
    return [...this.sessions.values()].filter((s) => s.chat.id === chatId)
  }

  /** Everyone who works in a chat: the accounts, then the agents that were started inside it. */
  teamOf(chat: Chat): Account[] {
    return [...this.accounts.accounts.filter((a) => a.enabled), ...(chat.agents || []).filter((a) => !a.spawned?.gone)]
  }

  /** How far from the lead someone is: 0 for the lead, 1 for those it works with, 2 for their sub-agents. */
  private depthOf(chat: Chat, a: Account): number {
    if (a.spawned) return a.spawned.depth
    return this.lead(chat)?.id === a.id ? 0 : 1
  }

  /**
   * How many extra agents a chat may hold. Left to the app, it goes by the allowance there is:
   * more room when accounts have plenty that would otherwise go unused, less when they are short.
   */
  maxAgents(): number {
    const set = this.settings.maxAgents
    if (set >= 0) return set
    let n = 4
    for (const a of this.accounts.accounts) {
      if (!a.enabled || this.accounts.statuses.get(a.id)?.state !== 'ready' || this.accounts.limitedUntil(a.id)) continue
      const pace = budgetOf(this.accounts.usage.get(a.id)).weekly?.pace
      n += pace === 'spend' ? 3 : pace === 'save' ? 0 : 1
    }
    return Math.max(3, Math.min(12, n))
  }

  /** The way the chat's lead is working right now when it is Ultra or Go crazy; null otherwise. */
  private ultraOf(chat: Chat): 'ultra' | 'gocrazy' | null {
    const run = this.ultraRun.get(chat.id)
    const kept = this.goalMode(chat)
    if (run === 'gocrazy' || kept === 'gocrazy') return 'gocrazy'
    return run || kept || chat.ultra ? 'ultra' : null
  }

  /**
   * The way of working an open goal keeps for all its rounds: the mode it was set in, while it is
   * not over (active, paused or waiting on the user). Go crazy holds only while Ultra is on.
   */
  private goalMode(chat: Chat): 'ultra' | 'gocrazy' | null {
    const g = chat.goal
    if (!g || (g.status !== 'active' && g.status !== 'paused' && g.status !== 'blocked')) return null
    if (g.mode === 'gocrazy') return chat.ultra ? 'gocrazy' : null
    return g.mode === 'ultra' ? 'ultra' : null
  }

  /** What the machine has, for the Go crazy cap. Replaced in tests. */
  machine = { free: (): number => os.freemem(), total: (): number => os.totalmem(), cores: (): number => os.availableParallelism?.() || os.cpus().length || 4 }

  /**
   * How many agents this machine can hold in a chat that is going crazy. Every agent is a CLI
   * process of its own: a Claude Code process measured 185 MB on average and up to 560 MB on a long
   * run (2026-11-18, 20 live processes), plus the connector servers it starts, so each is reckoned
   * at AGENT_MB. The agents already running are in what is used, so they count in full; new ones
   * must fit in what is free after a reserve of 15% of the memory (2 GB at least) for everything else.
   */
  memoryCap(chat: Chat): number {
    const live = (chat.agents || []).filter((x) => !x.spawned?.gone).length
    // Accounts with no allowance left carry nobody: with none that can take work, there is no room.
    const able = this.accounts.accounts.some((a) => a.enabled && this.accounts.statuses.get(a.id)?.state === 'ready' && !this.accounts.limitedUntil(a.id))
    if (!able) return live
    const reserve = Math.max(2 * 1024 ** 3, 0.15 * this.machine.total())
    const room = Math.floor(Math.max(0, this.machine.free() - reserve) / (AGENT_MB * 1024 ** 2))
    return live + room
  }

  /** What this machine can carry going crazy, right now: the lower of what memory and the processor cores allow. */
  machineCap(chat: Chat): number {
    return Math.min(this.memoryCap(chat), this.machine.cores() * AGENTS_PER_CORE)
  }

  /**
   * How many extra agents this chat may hold: the usual cap, raised in Ultra, and while it is going
   * crazy as many as this machine can carry right now (worked out again at every spawn), up to a
   * safety stop far above that. The user chose to spend allowance there.
   */
  agentCap(chat: Chat): number {
    const usual = this.maxAgents()
    const ultra = this.ultraOf(chat)
    return ultra === 'gocrazy' ? Math.max(usual, Math.min(SPAWN_CAP_GOCRAZY, this.machineCap(chat))) : ultra ? Math.max(usual, SPAWN_CAP_ULTRA) : usual
  }

  /**
   * How many levels of agents the chat may hold below its lead: 2 as a rule, 3 in Ultra, 4 while
   * going crazy. Agents already there when Ultra is switched off stay; nobody new goes deeper.
   */
  maxDepth(chat: Chat): number {
    const ultra = this.ultraOf(chat)
    return ultra === 'gocrazy' ? MAX_DEPTH_GOCRAZY : ultra ? MAX_DEPTH_ULTRA : MAX_DEPTH_USUAL
  }

  /** Whether `a` may start agents of its own at all in this chat (depth and settings, not room). */
  private maySpawn(chat: Chat, a: Account): boolean {
    return this.agentCap(chat) > 0 && this.depthOf(chat, a) < this.maxDepth(chat)
  }

  /** How many agents `a` may start of its own: the whole cap for a lead in Ultra, a few for everyone else. */
  private perAgent(chat: Chat, a: Account): number {
    const ultra = this.ultraOf(chat)
    const depth = this.depthOf(chat, a)
    if (ultra && depth === 0) return this.agentCap(chat)
    const usual = Math.max(1, this.settings.maxPerAgent || 4)
    // Going crazy, the lead's first level are the leads of regions, each running a team of its own.
    return ultra === 'gocrazy' && depth === 1 ? Math.max(usual, REGION_TEAM) : usual
  }

  /** How many more agents `a` may start in the chat. 0 when it may not start any. */
  private spawnRoom(chat: Chat, a: Account): number {
    if (!this.maySpawn(chat, a)) return 0
    const live = (chat.agents || []).filter((x) => !x.spawned?.gone).length
    return Math.max(0, Math.min(this.agentCap(chat) - live, this.perAgent(chat, a) - this.agentsOf(chat, a).length))
  }

  /**
   * What the lead runs while its chat is in Ultra: the strongest model its account has, at the
   * highest effort that model offers (one notch below the very top in plain Ultra, where the
   * lead mostly directs; the very top when going crazy). A model or effort set by hand stands.
   */
  private ultraLead(chat: Chat, a: Account): RunSpec | null {
    const mode = this.ultraOf(chat)
    if (!mode) return null
    const list = this.choices(a)
    const top = a.model ? list.find((m) => m.value === a.model) : (!this.topOut(a) && modelForTier(list, 'top')) || modelForTier(list, 'strong')
    if (!top) return null
    const efforts = (top.efforts || []).filter((e) => e !== 'ultra')
    const effort = (mode === 'gocrazy' ? ['max', 'xhigh', 'high'] : ['xhigh', 'max', 'high']).find((e) => efforts.includes(e))
    return { model: top.value, effort, why: `${top.label}${effort ? `, ${effort} effort` : ''}. ${mode === 'gocrazy' ? 'Go crazy' : 'Ultra'} runs the lead on its strongest model at full effort` }
  }

  /** Notes how the chat's lead is working, and gives it a fresh start when that changes what it should run. */
  private markUltra(chat: Chat, mode: 'ultra' | 'gocrazy' | null): void {
    const before = this.ultraOf(chat)
    if (mode) this.ultraRun.set(chat.id, mode)
    else this.ultraRun.delete(chat.id)
    const lead = this.lead(chat)
    if (lead && before !== this.ultraOf(chat) && this.sessions.has(`${chat.id}:${lead.id}`)) this.session(chat, lead).recycle()
    this.syncCrazy(chat)
  }

  /**
   * Keeps `chat.crazy` true exactly while the lead works in Go crazy (a run under way, or a goal
   * set in Go crazy that is not over), and tells the window when that changes. When a goal ends and
   * takes Go crazy with it, the lead starts fresh on the model plain Ultra gives it.
   */
  private syncCrazy(chat: Chat): void {
    const on = this.ultraOf(chat) === 'gocrazy'
    if (!!chat.crazy === on) return
    if (on) chat.crazy = true
    else delete chat.crazy
    const lead = this.lead(chat)
    if (lead && this.sessions.has(`${chat.id}:${lead.id}`)) this.session(chat, lead).recycle()
    this.saveChats()
    this.emit({ type: 'chat', chat })
  }

  /** Substantial Go crazy requests whose first reply is still to be looked at, by chat: the message and when it was sent. */
  private floors = new Map<string, { itemId: string; at: number }>()

  /**
   * The lead's first reply to a substantial Go crazy request has ended. When it started fewer
   * agents than CRAZY_FLOOR (or than there is room for), it is sent back once with the room it
   * really has. Once per message; never after Stop, a failed reply, or for a small follow-up.
   */
  private crazyFloor(session: AgentSession, pending: Pending, ev: TurnEnd): void {
    const chat = session.chat
    const f = this.floors.get(chat.id)
    if (!f || this.lead(chat)?.id !== session.account.id || !pending.itemIds.includes(f.itemId)) return
    this.floors.delete(chat.id)
    if (ev.status !== 'done' || this.quiet.has(chat.id) || this.ultraOf(chat) !== 'gocrazy') return
    const started = (chat.agents || []).filter((a) => a.spawned && a.spawned.at >= f.at).length
    const room = this.spawnRoom(chat, session.account)
    const floor = Math.min(CRAZY_FLOOR, started + room)
    if (started >= floor) return
    session.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `Go crazy, but ${started === 1 ? 'only 1 agent was' : `${started} agents were`} started, so ${session.account.name} was asked once to start the regions.` })
    session.enqueue({ kind: 'auto', text: crazyFollowUp({ started, floor, room, depth: this.maxDepth(chat) }), origin: { kind: 'human' }, itemIds: [] })
  }

  /**
   * What goes ahead of each round of a goal that keeps a way of working: a short reminder of the
   * Ultra or Go crazy note the first message carried, with the room and depth in force now.
   */
  goalWay(chat: Chat): string {
    const mode = this.goalMode(chat)
    const lead = this.lead(chat)
    if (!mode || !lead) return ''
    this.syncCrazy(chat)
    return modeReminder(mode, { cap: this.spawnRoom(chat, lead), depth: this.maxDepth(chat), total: this.agentCap(chat) })
  }

  /**
   * The team's models as Ultra needs them: per provider, the accounts that can take work and
   * the strongest and fastest model each offers. Read from what the accounts really report.
   */
  private ultraTeam(chat: Chat): string {
    const lines: string[] = []
    for (const provider of ['claude', 'chatgpt'] as const) {
      const accs = this.teamOf(chat).filter((a) => !a.spawned && a.provider === provider && a.enabled && this.accounts.statuses.get(a.id)?.state === 'ready' && !this.accounts.limitedUntil(a.id))
      if (!accs.length) continue
      const list = this.choices(accs[0])
      const top = modelForTier(list, 'top') || modelForTier(list, 'strong')
      const fast = modelForTier(list, 'light')
      const efforts = (top?.efforts || []).filter((e) => e !== 'ultra')
      const maxEffort = efforts.includes('max') ? 'max' : efforts[efforts.length - 1]
      const kind = provider === 'claude' ? 'Claude' : 'ChatGPT'
      const parts = [top ? `strongest ${top.label} (\`${top.value}\`${maxEffort ? `, effort up to ${maxEffort}` : ''})` : '', fast ? `fastest ${fast.label} (\`${fast.value}\`)` : '']
      lines.push(`- ${accs.length} ${kind} ${accs.length === 1 ? 'account' : 'accounts'} (${accs.map((a) => a.name).join(', ')}): ${parts.filter(Boolean).join('; ') || 'models not known yet, see roster'}`)
    }
    return lines.join('\n')
  }

  /** The instructions of the folder a chat is filed under, when it has some. */
  private projectOf(chat: Chat): { name: string; text: string } | null {
    const f = chat.folderId ? this.folders.find((x) => x.id === chat.folderId) : undefined
    return f?.instructions?.trim() ? { name: f.name, text: f.instructions } : null
  }

  /** What an agent is told about its role, its team and its tools when it starts in a chat. */
  private brief(chat: Chat, account: Account, hasTools: boolean): string {
    const lead = this.lead(chat)
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const teammates = this.teamOf(chat)
      .filter((a) => a.id !== account.id)
      .map((a) => ({
        account: a,
        available: this.accounts.statuses.get(a.id)?.state === 'ready',
        model: this.settingLabel(a),
        by: a.spawned ? name(a.spawned.by) : undefined,
        on: a.spawned ? name(a.spawned.base) : undefined,
        mine: a.spawned?.by === account.id,
      }))
    const vault = this.vault?.exists ? this.vault : null
    const ctx: BriefingContext = {
      self: account,
      lead,
      teammates,
      parent: account.spawned ? { name: name(account.spawned.by), base: name(account.spawned.base) } : null,
      spawn: hasTools && this.maySpawn(chat, account) ? this.agentCap(chat) : 0,
      depth: this.depthOf(chat, account),
      maxDepth: this.maxDepth(chat),
      perAgent: this.perAgent(chat, account),
      smart: this.settings.smartModels,
      connectors: this.connectors.all().filter((c) => c.enabled && (c.accounts === 'all' || c.accounts.includes(this.accounts.baseId(account.id)))).map((c) => ({ slug: c.slug, name: c.name, blurb: c.blurb, tools: c.test?.ok ? c.test.tools.length : undefined })),
      economy: this.settings.smartModels ? this.settings.economy : 'quality',
      project: this.projectOf(chat),
      cwd: chat.cwd,
      memory: this.settings.memoryEnabled ? this.memory.digest() : null,
      hasTools,
      hands: hasTools ? this.hands.abilities() : { browser: false, computer: false },
      lightTalk: this.settings.lightTalk,
      menus: { claude: this.menu('claude'), chatgpt: this.menu('chatgpt') },
      vault: vault
        ? {
            name: vault.name,
            path: vault.root,
            notes: vault.info().notes,
            guide: vault.guide,
            mode: this.settings.vaultNotes,
            projectNote: vault.projectNote(chat.cwd),
            skills: this.vaultSkills(),
            tools: hasTools,
          }
        : null,
    }
    return lead?.id === account.id ? leadBriefing(ctx) : memberBriefing(ctx)
  }

  /** The briefing an account would start with in a chat, for inspection. */
  briefingFor(chatId: string, accountId: string): string {
    const account = this.accounts.get(accountId)
    if (!account) return ''
    return this.brief(this.need(chatId), account, true)
  }

  buildRuntime(session: AgentSession, run?: RunSpec): AgentRuntime {
    const { chat, account } = session
    const tools = this.toolsFor(session)
    const isLead = this.lead(chat)?.id === account.id
    const toolsUrl = account.provider === 'chatgpt' ? this.toolServer.register(session.key, tools) : undefined
    const hasTools = account.provider === 'claude' || !!toolsUrl
    const vault = this.vault?.exists ? this.vault : null
    // Nobody chose a model for this: go by what the account's allowance can afford.
    const smart = run?.model ? null : this.smartRun(chat, account)
    // In Ultra the lead is not held back either: its strongest model, thinking as hard as it can.
    const boost = isLead && !run?.model ? this.ultraLead(chat, account) : null
    session.inform({ modelWhy: run?.why ?? boost?.why ?? smart?.why })
    const kept = chat.sessions[account.id]
    // Connectors go to the account an agent works on; ones that account already has of its own are not given twice.
    const base = this.accounts.get(this.accounts.baseId(account.id)) || account
    const connectors = this.host.demo ? {} : account.provider === 'claude' ? this.connectors.forClaude(base, ownConnectors(base)) : this.connectors.forCodex(base)
    const briefing = this.brief(chat, account, hasTools)
    // A ChatGPT agent is briefed in its first message, so a resumed one is briefed again only when its briefing changed.
    const brief = createHash('sha1').update(briefing).digest('hex').slice(0, 16)
    this.briefs.set(session.key, brief)
    const briefed = kept?.providerSessionId ? kept.brief === brief : undefined
    if (kept?.providerSessionId && !briefed) {
      chat.sessions[account.id] = { ...kept, brief }
      this.saveChats()
    }
    const options = {
      account,
      configDir: account.configDir,
      cwd: chat.cwd,
      permission: chat.permission,
      model: run?.model ?? account.model ?? boost?.model ?? smart?.model,
      effort: run?.effort ?? account.effort ?? boost?.effort ?? smart?.effort,
      defaultModel: this.accounts.statuses.get(account.id)?.models?.find((m) => m.isDefault)?.value || undefined,
      // The vault is somewhere agents may read and write without being in it.
      extraDirs: vault && path.resolve(chat.cwd).toLowerCase() !== vault.root.toLowerCase() ? [vault.root] : [],
      resumeId: kept?.providerSessionId,
      // A conversation brought in from Claude Code is carried on in a copy, so the original is never written to.
      forkSession: !!kept?.fork,
      connectors,
      briefing,
      briefed,
      tools,
      toolsUrl,
      // Only the lead is the one you normally type to next.
      suggestions: this.settings.suggestions && isLead,
      // The scripted team fails a turn on an account with nothing left, as a real one does.
      outUntil: this.host.demo ? () => this.accounts.limitedUntil(account.id) : undefined,
      host: session,
    }
    if (this.host.demo) return new DemoRuntime(options, isLead)
    if (account.provider === 'claude') return new ClaudeRuntime({ ...options, executable: findClaude(this.settings.claudePath) })
    return new CodexRuntime({ ...options, executable: findCodex() })
  }

  onSessionId(session: AgentSession, id: string): void {
    const chat = session.chat
    if (chat.sessions[session.account.id]?.providerSessionId === id) return
    chat.sessions[session.account.id] = { providerSessionId: id, brief: this.briefs.get(session.key) }
    this.saveChats()
  }

  onUsage(accountId: string, usage: Extract<RuntimeEvent, { type: 'usage' }>['usage']): void {
    this.accounts.setUsage(accountId, usage)
  }

  // ----- choosing models from what an account can afford -----

  /** The account's model for a tier, or the nearest one below it that the account has. */
  private modelAt(a: Account, tier: Tier): ModelOption | undefined {
    return modelForTier(this.choices(a), tier)
  }

  /** Which provider a model named in a task belongs to ("luna", "gpt-6-astra", "haiku"); undefined when it does not say. */
  private providerOfModel(model: string | undefined | null): Account['provider'] | undefined {
    const m = (model || '').trim()
    if (/^gpt|^o\d|codex|luna|astra|(^|[^a-z])sol([^a-z]|$)/i.test(m)) return 'chatgpt'
    if (/fable|mythos|opus|sonnet|haiku|claude/i.test(m)) return 'claude'
    return undefined
  }

  private isTop(model: string | undefined | null): boolean {
    return isTopModel(model)
  }

  /** True while an account's strongest model is known to be unavailable: its own allowance is used up. */
  private topOut(a: Account): boolean {
    const until = this.capped.get(this.accounts.baseId(a.id))
    if (until && until > Date.now()) return true
    if (until) this.capped.delete(this.accounts.baseId(a.id))
    return budgetOf(this.accounts.usage.get(a.id)).top?.pace === 'out'
  }

  /**
   * The model and effort an agent should run when nobody chose them: the strongest model
   * while its account has allowance to spare before it refills, a step down when it is
   * running short. null leaves the account on whatever it is set to.
   */
  /**
   * The cheapest tier an agent this far down the team should run by default, or null for no
   * limit. The lead plans and checks, so it is never held back; those it hands work to run a
   * step below the strongest model, and their sub-agents a step further. What the team has
   * learned moves the step up for a tier that keeps falling short, and down for one that is
   * always more than enough.
   */
  private capFor(depth: number, kind?: string): { tier: Tier; learned: -1 | 0 | 1 } | null {
    const e = this.settings.economy
    if (e === 'quality' || depth <= 0) return null
    let i = Math.min(TIER_ORDER.length - 1, depth + (e === 'saver' ? 1 : 0))
    let learned: -1 | 0 | 1 = 0
    if (e === 'auto') {
      learned = this.learning.shift(TIER_ORDER[i], kind)
      i = Math.max(1, Math.min(TIER_ORDER.length - 1, i - learned))
    }
    return { tier: TIER_ORDER[i], learned }
  }

  private smartRun(chat: Chat, a: Account, kind?: string): { model: string; effort?: string; why: string } | null {
    if (!this.settings.smartModels || a.model) return null
    const depth = this.depthOf(chat, a)
    const budget = budgetOf(this.accounts.usage.get(a.id))
    // Claude plans meter their strongest model on its own, so there the allowance says which model
    // an account can afford. A ChatGPT plan has no such meter: going by the week alone would put a
    // lead on the costliest model whenever the week looked ahead, and override the model the
    // account's own settings name. So a ChatGPT account runs what it is set to, and only the
    // step down the team (below) and Ultra change that.
    let advice = a.provider === 'claude' ? adviseModel(budget, depth === 0 ? 'lead' : 'worker') : null
    if (a.provider === 'claude' && this.topOut(a) && (!advice || advice.tier === 'top')) advice = { tier: 'strong', why: `${budget.top?.label || 'The strongest model'} has reached its limit on this account, so the next model down is used` }
    let tier = advice?.tier
    let why = advice?.why
    let effort = advice?.effort
    // In Ultra nobody is stepped down to save allowance: an agent whose model was not named runs the best its account can afford.
    const cap = this.ultraOf(chat) ? null : this.capFor(depth, kind)
    if (cap) {
      const rank = (t: Tier): number => TIER_ORDER.indexOf(t)
      const below = this.settings.economy === 'saver' ? 'run the mid-sized model' : 'run a step below the strongest model'
      const step =
        depth >= 2 ? 'Sub-agents run a cheaper model for the narrower parts they are given, to save allowance' : a.spawned ? `Agents started for a part of the work ${below}, to save allowance` : `Teammates the lead hands work to ${below}, to save allowance`
      const about = kind && kind !== 'other' ? ` on ${kindLabel(kind)}` : ''
      const learnt = cap.learned > 0 ? `; the cheaper model kept falling short${about}, so this step was raised` : cap.learned < 0 ? `; the model above was always more than enough${about}, so a cheaper one is used` : ''
      // Never stronger than the step allows. With nothing else to go on, a step that is cheaper
      // than the usual default is taken too: an account left alone may run something costlier.
      if ((tier && rank(tier) < rank(cap.tier)) || (!tier && rank(cap.tier) >= rank('mid'))) {
        tier = cap.tier
        effort = undefined
        why = `${step}${learnt}`
      }
    }
    if (!tier) return null
    const m = this.modelAt(a, tier)
    if (!m) return null
    const eff = effort && !a.effort && m.efforts?.includes(effort) ? effort : undefined
    return { model: m.value, effort: eff, why: `${m.label}${eff ? `, ${eff} effort` : ''}. ${why}.` }
  }

  /** The account's next model up from the one given, or undefined when it is already at the top it can use. */
  private stronger(a: Account, model: string | undefined | null): ModelOption | undefined {
    const tier = tierOfModel(model)
    if (!tier) return undefined
    for (let i = TIER_ORDER.indexOf(tier) - 1; i >= 0; i--) {
      if (TIER_ORDER[i] === 'top' && this.topOut(a)) continue
      const m = this.choices(a).find((x) => tierOfModel(`${x.value} ${x.label}`) === TIER_ORDER[i] && !/^claude-/.test(x.value))
      if (m) return m
    }
    return undefined
  }

  /**
   * Nobody has allowance left for a task: rather than failing it, it waits and starts by itself
   * when the first account refills, as long as that is within a few hours. False when it cannot wait.
   */
  private park(task: Task, from: Account): boolean {
    const chat = this.chats.get(task.chatId)
    if (!chat) return false
    const times = this.accounts.accounts
      .filter((a) => a.enabled && a.provider === from.provider && this.accounts.statuses.get(a.id)?.state === 'ready')
      .map((a) => this.accounts.limitedUntil(a.id))
      .filter((t): t is number => !!t)
    const until = times.length ? Math.min(...times) : this.accounts.limitedUntil(from.id)
    if (!until || until - Date.now() > 8 * 3600e3) return false
    task.parkedUntil = until
    this.setTask(task, 'queued')
    const key = `${task.chatId}:${task.id}`
    clearTimeout(this.parked.get(key))
    this.parked.set(
      key,
      setTimeout(() => {
        this.parked.delete(key)
        const t = this.findTask(task.chatId, task.id)
        if (!t || t.status !== 'queued' || !t.parkedUntil || !this.chats.has(task.chatId)) return
        t.parkedUntil = undefined
        // Whoever refilled first takes it, the same model where they have it.
        const base = this.accounts.get(this.accounts.baseId(t.to))
        if (base && this.accounts.limitedUntil(base.id)) {
          const next = this.pick(chat, { exclude: [t.from], provider: base.provider })
          if (next && !this.accounts.get(t.to)?.spawned) t.to = next.id
        }
        this.begin(t, 'the usage allowance ran out while this was under way, and it has refilled now. Some of it may already be done: check what exists before redoing anything.')
      }, until - Date.now() + 60_000),
    )
    const assigner = this.accounts.get(task.from)
    if (assigner) {
      this.session(chat, assigner).add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `Nobody has allowance left right now, so "${task.title}" waits and starts by itself at ${clock(until)}.` })
    }
    return true
  }

  /** Whoever handed a task out says whether the model that did it was right for it. */
  private rateWork(chat: Chat, me: Account, args: { id?: string; verdict?: string }): string {
    const t = this.findTask(chat.id, String(args.id || '').trim().toLowerCase())
    if (!t) return `There is no task ${args.id} in this chat.`
    if (t.from !== me.id && this.lead(chat)?.id !== me.id) return `Task ${t.id} was handed out by someone else, so it is theirs to rate.`
    if (t.status !== 'done' && t.status !== 'failed') return `Task ${t.id} has not finished yet. Rate it once its report is in.`
    const verdict = (['enough', 'too_weak', 'more_than_needed'] as const).find((v) => v === args.verdict)
    if (!verdict) return 'The verdict is one of: enough, too_weak, more_than_needed.'
    if (!t.ranOn) return `It is not known which model did ${t.id}, so there is nothing to learn from it.`
    if (t.rated) return `Task ${t.id} was already rated.`
    const family = this.learning.vote(t.ranOn, verdict as Verdict, t.kind)
    t.rated = verdict
    this.commitTask(t)
    const what = verdict === 'enough' ? 'was right for' : verdict === 'too_weak' ? 'fell short on' : 'was more than needed for'
    const to = this.accounts.get(t.to)
    const up = verdict === 'too_weak' && to ? this.stronger(to, t.ranOn) : undefined
    const next = up ? ` To have it redone, hand it out again with model "${up.value}" (${up.label}).` : ''
    return family ? `Noted: ${family} ${what} "${t.title}" (${kindLabel(t.kind)}). The team uses this when it picks models from now on.${next}` : 'Noted.'
  }

  /**
   * A reply ended because a limit was hit. When the account as a whole still has allowance,
   * it was the strongest model's own limit: stay off that model for now and say so.
   * Returns the model to carry on with, or null when there is nothing to step down to.
   */
  private stepDown(session: AgentSession, pending: Pending): string | null {
    const a = session.account
    if (a.provider !== 'claude' || pending.stepped) return null
    const ran = pending.run?.model || session.state.model
    if (!this.isTop(ran)) return null
    const b = budgetOf(this.accounts.usage.get(a.id))
    if (b.weekly?.pace === 'out' || b.session?.pace === 'out') return null
    const next = this.modelAt(a, 'strong')
    if (!next || this.isTop(next.value)) return null
    this.capped.set(this.accounts.baseId(a.id), b.top?.resetsAt && b.top.resetsAt > Date.now() ? b.top.resetsAt : Date.now() + 3 * 3600e3)
    return next.value
  }

  /** The models an account can actually choose between: no "default" entry, no retired generations. */
  private choices(a: Account): ModelOption[] {
    const all = (this.accounts.statuses.get(a.id)?.models || []).filter((m) => m.value && m.value !== 'default')
    const current = all.filter((m) => !/^claude-/.test(m.value) && !/^(older|previous)\b/i.test(m.description || ''))
    return current.length ? current : all
  }

  /** The model an account will run, in plain words, when we know it. */
  private modelLabel(a: Account): string | undefined {
    const models = this.accounts.statuses.get(a.id)?.models
    if (!a.model) return undefined
    return models?.find((m) => m.value === a.model)?.label || a.model
  }

  /** "Sonnet 5.5, high effort": what a teammate runs when a task does not say otherwise. */
  private settingLabel(a: Account): string | undefined {
    const all = this.accounts.statuses.get(a.id)?.models || []
    // With nothing chosen, the account runs whatever its provider calls the default.
    const usual = all.find((m) => m.isDefault)?.label || all.find((m) => m.value === 'default')?.description
    const model = this.modelLabel(a) || usual
    const parts = [model, a.effort ? `${a.effort} effort` : ''].filter(Boolean)
    return parts.length ? parts.join(', ') : undefined
  }

  /** The model menu of one provider, as the provider itself describes it. */
  private menu(provider: Account['provider']): string {
    const a = this.accounts.accounts.find((x) => x.enabled && x.provider === provider && this.choices(x).length > 0)
    if (!a) return ''
    const list = this.choices(a)
    const efforts = (list.find((m) => m.efforts?.length)?.efforts || []).filter((e) => e !== 'ultra')
    const lines = list.map((m) => `  - ${m.value}${m.label.toLowerCase() !== m.value.toLowerCase() ? ` (${m.label})` : ''}${m.description ? `: ${m.description.replace(/\.$/, '')}` : ''}`)
    return `${lines.join('\n')}${efforts.length ? `\n  Effort levels: ${efforts.join(', ')}.` : ''}`
  }

  /** Turns what the lead asked for ("opus", "Sonnet 5.5", "high") into a setting the teammate really has. */
  private runFor(a: Account, model?: string, effort?: string): { run: RunSpec; label?: string } | string {
    const run: RunSpec = {}
    const list = this.choices(a)
    let chosen: ModelOption | undefined
    const m = (model || '').trim()
    if (m && !/^(default|usual|same)$/i.test(m)) {
      const k = m.toLowerCase()
      const squash = (v: string): string => v.toLowerCase().replace(/[\s._-]+/g, '')
      chosen = list.find((x) => x.value.toLowerCase() === k || x.label.toLowerCase() === k) || list.find((x) => squash(x.label) === squash(k) || squash(x.value) === squash(k)) || list.find((x) => squash(x.value).includes(squash(k)) || squash(x.label).includes(squash(k)))
      if (!chosen && list.length) return `${a.name} cannot run "${m}". Their models are: ${list.map((x) => x.value).join(', ')}. Leave model out to use the one they are set to.`
      // The strongest model has an allowance of its own, and this account's is gone.
      if (chosen && this.isTop(`${chosen.value} ${chosen.label}`) && this.topOut(a)) {
        const others = this.accounts.accounts.filter((x) => x.enabled && x.provider === 'claude' && x.id !== a.id && this.accounts.isReady(x.id) && !this.accounts.limitedUntil(x.id) && !this.topOut(x)).map((x) => x.name)
        return `${a.name}'s account has no ${chosen.label} allowance left right now.${others.length ? ` These teammates still have it: ${others.join(', ')}.` : ''} Name another model, or leave model out and the app picks the strongest one ${a.name} can still run.`
      }
      run.model = chosen?.value || m
    }
    const e = (effort || '').trim().toLowerCase()
    if (e && !/^(default|usual|same)$/.test(e)) {
      const current = chosen || list.find((x) => x.value === a.model) || list.find((x) => x.isDefault) || list.find((x) => x.efforts?.length)
      const allowed = current?.efforts || []
      // A known level the model lacks ("max" on a model that stops at "xhigh") runs at the nearest one it has
      // below, rather than refusing the work; only a word that is no level at all is refused.
      const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      const usable = allowed.filter((x) => x !== 'ultra')
      const near = LEVELS.includes(e) ? [...usable].filter((x) => LEVELS.includes(x) && LEVELS.indexOf(x) <= LEVELS.indexOf(e)).sort((x, y) => LEVELS.indexOf(y) - LEVELS.indexOf(x))[0] : undefined
      if (allowed.length && !allowed.includes(e) && !near) return `"${effort}" is not an effort level ${a.name} has. Use one of: ${usable.join(', ')}.`
      run.effort = allowed.length && !allowed.includes(e) ? near : e
    }
    const label = [chosen?.label || (run.model ? run.model : ''), run.effort ? `${run.effort} effort` : ''].filter(Boolean).join(', ')
    return { run, label: label || undefined }
  }

  /** The model and effort a task was given, for its owner's later turns on it; undefined when it named none. */
  private runOfTask(a: Account, task: Task): RunSpec | undefined {
    if (!task.model && !task.effort) return undefined
    const how = this.runFor(a, task.model, task.effort)
    return typeof how === 'string' ? undefined : { ...how.run, why: task.modelWhy }
  }

  /** How much is already running on an account's sign-in: its own work and that of agents started on it. */
  private loadOf(chat: Chat, accountId: string): number {
    let load = 0
    for (const s of this.sessions.values()) {
      if (!s.busy || this.accounts.baseId(s.account.id) !== accountId) continue
      load += s.chat.id === chat.id ? 2 + s.state.queued : 1
    }
    return load
  }

  /**
   * The best account to take work right now: signed in, with allowance left, free before
   * busy, and then whichever has the most allowance that would otherwise go unused (a lot
   * left, and a refill coming soon).
   */
  private pick(chat: Chat, opts: { exclude: string[]; provider?: Account['provider']; wantsTop?: boolean; roomy?: boolean }): Account | null {
    const scored = this.accounts.accounts
      .filter((a) => a.enabled && !opts.exclude.includes(a.id) && (!opts.provider || a.provider === opts.provider))
      .filter((a) => this.accounts.statuses.get(a.id)?.state === 'ready' && !this.accounts.limitedUntil(a.id))
      // roomy: only accounts that are not running low.
      .filter((a) => !opts.roomy || this.accounts.supply(a.id).state === 'ok')
      .map((a) => {
        const noTop = opts.wantsTop && a.provider === 'claude' && this.topOut(a) ? 0.6 : 0
        // An account close to the end of its window takes new work only when nobody fine can.
        const low = this.settings.handover && this.accounts.supply(a.id).state === 'low' ? 40 : 0
        return { a, score: this.loadOf(chat, a.id) * 10 + spendScore(budgetOf(this.accounts.usage.get(a.id))) + noTop + low }
      })
      .sort((x, y) => x.score - y.score)
    return scored[0]?.a || null
  }

  remedyFor(session: AgentSession, pending: Pending, ev: TurnEnd): Extract<Item, { kind: 'notice' }>['action'] {
    void pending
    // The lead ran dry, whatever it was doing: offer the teammate best placed to take over. Once per dry spell.
    // With handover on, there is nothing to offer: it happens by itself.
    if (ev.reason !== 'limit' || this.settings.handover || this.lead(session.chat)?.id !== session.account.id) return undefined
    if (this.dryOffer.get(session.chat.id) === session.account.id) return undefined
    const next = this.successor(session.chat, session.account)
    if (next) this.dryOffer.set(session.chat.id, session.account.id)
    return next ? { kind: 'switch-lead', to: next.id } : undefined
  }

  /**
   * Who is best placed to take over from a lead: signed in and not out; then fine before running
   * low (`strict` allows only fine); then the same provider, an account that can run its strongest
   * model, the most allowance left, and one not already busy with work in this chat.
   */
  private successor(chat: Chat, lead: Account, strict = false): Account | null {
    const open = this.tasksOf(chat.id).filter((t) => t.status === 'running' || t.status === 'queued')
    const scored = this.accounts.accounts
      .filter((a) => a.enabled && a.id !== lead.id && this.accounts.isReady(a.id))
      .map((a) => ({ a, supply: this.accounts.supply(a.id) }))
      .filter(({ supply }) => supply.state !== 'out' && (!strict || supply.state === 'ok'))
      .map(({ a, supply }) => {
        const b = budgetOf(this.accounts.usage.get(a.id))
        const left = Math.min(b.session?.left ?? 1, b.weekly?.left ?? 1)
        const top = this.modelAt(a, 'top')
        const strongest = !top || (a.provider === 'claude' && this.topOut(a)) ? 0.4 : 0
        const score =
          (supply.state === 'low' ? 10 : 0) +
          (a.provider !== lead.provider ? 0.6 : 0) +
          strongest +
          spendScore(b) * 0.5 -
          left +
          (open.some((t) => t.to === a.id) ? 0.8 : 0) +
          (this.sessions.get(`${chat.id}:${a.id}`)?.busy ? 0.5 : 0)
        return { a, score }
      })
      .sort((x, y) => x.score - y.score)
    return scored[0]?.a || null
  }

  /**
   * A lead that ran out (or is about to) hands the chat to `to`, by itself. What was waiting for the
   * old lead and anything queued behind its last reply goes to the new one, which is caught up on
   * the chat first. The chat shows one line for it.
   */
  private handOverDry(chat: Chat, from: Account, to: Account, why: 'out' | 'low', until: number | null): void {
    const old = this.sessions.get(`${chat.id}:${from.id}`)
    // Messages lined up behind the old lead's last reply would run on an account with nothing left.
    const queued = old?.drain() || []
    // Runs to the end at once: the old lead is between replies, so nothing has to be stopped first.
    void this.setChatLead(chat.id, to.id, false, { why, until }).catch(() => undefined)
    if (this.lead(chat)?.id !== to.id) {
      // It did not take: what was drained waits for the old lead after all.
      for (const p of queued) if (p.kind === 'user' || p.kind === 'team') this.hold(chat, from, { text: p.text, itemIds: p.itemIds, user: p.kind === 'user' }, false)
      return
    }
    const target = this.session(chat, to)
    for (const p of queued) {
      for (const id of p.itemIds) old?.patch(id, { queued: false })
      if (old && p.kind === 'user') this.carryAsked(old, target, p.itemIds)
      target.enqueue({ ...p, text: this.catchUp(chat, to) + p.text, itemIds: [], run: undefined })
    }
  }

  /** The user's own messages that a new lead takes over are shown in its transcript too, so the chat reads on. */
  private carryAsked(from: AgentSession, to: AgentSession, itemIds: string[]): void {
    for (const id of itemIds) {
      const it = from.items.find((i) => i.id === id)
      if (it?.kind === 'user') to.add({ ...it, id: uid('u'), ts: Date.now(), queued: false })
    }
  }

  /** Everyone is out of usage: one line in the chat, saying when the work goes on by itself. */
  private allOut(chat: Chat, lead: Account): void {
    let first: { at: number; who: Account } | null = null
    for (const a of this.accounts.accounts) {
      if (!a.enabled || !this.accounts.isReady(a.id)) continue
      const at = this.accounts.supply(a.id).until
      if (at && (!first || at < first.at)) first = { at, who: a }
    }
    const when = first ? ` The work waits and goes on by itself at ${clock(first.at)}, when ${first.who.name} refills.` : ' The work waits until an account refills.'
    this.session(chat, lead).add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'warn', text: `Every account on the team is out of usage right now.${when}` })
  }

  /**
   * Takes back a message the user sent that has not started yet: out of the queue, or out of what
   * waits for a lead with no allowance left. Notes and reports that came along with it wait again.
   */
  dequeue(chatId: string, accountId: string, itemId: string): boolean {
    const chat = this.need(chatId)
    const account = this.accounts.get(accountId)
    if (!account) return false
    const session = this.sessions.get(`${chatId}:${accountId}`)
    if (!session) return false
    const taken = session.dequeueItem(itemId)
    if (taken) {
      // Notes and reports that were to come with it wait for the next thing, as they did before.
      for (const part of taken.back || []) if (part.text.trim()) this.hold(chat, account, { text: part.text, itemIds: part.itemIds })
      return true
    }
    const key = `${chatId}:${accountId}`
    const list = this.waiting.get(key) || []
    const at = list.findIndex((w) => w.user && w.itemIds.includes(itemId))
    if (at < 0) return false
    list.splice(at, 1)
    if (!list.length) this.dropWaiting(key)
    session.patch(itemId, { queued: false, withdrawn: true })
    return true
  }

  /** Reports and notes that were lined up when the agent was stopped: they stay unread for its next turn. */
  keepUnread(session: AgentSession, pending: Pending): void {
    this.hold(session.chat, session.account, { text: pending.text, itemIds: pending.itemIds }, false)
  }

  /**
   * A reply failed. When the app is about to give the same work another go by itself, this
   * says so in a sentence, and the failure is not shown as one.
   */
  retryNote(session: AgentSession, pending: Pending, ev: TurnEnd): string | null {
    if (ev.reason !== 'limit' || !this.chats.has(session.chat.id) || this.quiet.has(session.chat.id)) return null
    const next = this.stepDown(session, pending)
    if (!next) {
      // The work moves on by itself (a new lead, a task moved, an agent moved): that is what the
      // chat says, in one line of its own, rather than an error here.
      if (!this.settings.handover) return null
      const chat = session.chat
      const a = session.account
      if (this.lead(chat)?.id === a.id) return ''
      if (pending.taskId) {
        const t = this.findTask(chat.id, pending.taskId)
        const room = a.spawned ? this.pick(chat, { exclude: [this.accounts.baseId(a.id)] }) : this.pick(chat, { exclude: [a.id, t?.from || ''] })
        if (t && (t.moves || 0) < MAX_MOVES && room) return ''
      }
      return null
    }
    pending.stepTo = next
    const label = this.choices(session.account).find((m) => m.value === next)?.label || next
    return `${session.account.name}'s account has used up its allowance for the strongest model. Carrying on with ${label}.`
  }

  onAttention(session: AgentSession, what: string): void {
    if (this.settings.notifications && !this.host.isFocused()) {
      this.host.notify(what, session.chat.title, { chatId: session.chat.id, accountId: session.account.id })
    }
  }

  registerAsk(requestId: string, ask: OpenAsk): void {
    this.asks.set(requestId, ask)
  }

  dropAsk(requestId: string): void {
    const ask = this.asks.get(requestId)
    if (!ask) return
    this.asks.delete(requestId)
    ask.expire()
  }

  respondPermission(requestId: string, decision: PermissionDecision, note?: string): void {
    const ask = this.asks.get(requestId)
    if (ask?.kind !== 'permission') return
    this.asks.delete(requestId)
    ask.resolve({ decision, note })
  }

  respondQuestion(requestId: string, answers: Record<string, string> | null): void {
    const ask = this.asks.get(requestId)
    if (ask?.kind !== 'question') return
    this.asks.delete(requestId)
    ask.resolve(answers)
  }

  // ----- talking to agents -----

  /**
   * A message for an agent at work reaches the work under way, between its steps (or, where the
   * provider takes no input mid-turn, by stopping at a safe point and carrying on at once with it).
   * Anything else (the agent is idle, a command, a goal, a loop, a way of working, a control's
   * click) goes the usual way through send().
   */
  steer(req: SendRequest): 'steered' | 'sent' {
    const chat = this.need(req.chatId)
    const account = this.accounts.get(req.to)
    const text = req.text.trim()
    const attachments = req.attachments || []
    const plain = !!account && !account.spawned?.gone && (!!text || attachments.length > 0) && !text.startsWith('/') && !req.mode && !req.goal && !req.loop && !req.fromControl
    const session = plain && account ? this.session(chat, account) : null
    if (!session?.busy) {
      this.send(req)
      return 'sent'
    }
    const files = attachments.length ? `\n\nAttached files:\n${attachments.map((a) => `- ${a.path}`).join('\n')}` : ''
    const images = attachments.filter((a) => a.kind === 'image').map((a) => a.path)
    const item: Item = { id: uid('u'), kind: 'user', ts: Date.now(), text, attachments: attachments.length ? attachments : undefined, steered: true }
    if (!session.steer(text + files, images, item.id)) {
      this.send(req)
      return 'sent'
    }
    session.add(item)
    this.touch(chat, text)
    return 'steered'
  }

  send(req: SendRequest): void {
    const chat = this.need(req.chatId)
    const account = this.accounts.get(req.to)
    if (!account) throw new Error('That teammate is no longer on the team.')
    const status = this.accounts.statuses.get(account.id)
    if (status?.state === 'signed-out') throw new Error(`${account.name} is signed out. Sign in from the team panel first.`)
    if (account.spawned?.gone) throw new Error(`${account.name} was sent home and no longer takes messages.`)
    let text = req.text.trim()
    const attachments = req.attachments || []
    if (!text && !attachments.length) return
    // A message from a Live answers control (a choice, a form, a mini app's offer) was written by an
    // agent, which a web page it read could have steered. It is never read as one of the app's
    // commands and carries no way of working, goal or loop: it reaches the agent as plain words.
    // The one exception is the demo team, whose welcome chat offers its commands as choices.
    const control = req.fromControl === true
    const demoCommand = control && !!this.host.trial && this.host.demo ? /^Chose:\s*(\/\S[\s\S]*)$/.exec(text) : null
    if (demoCommand) text = demoCommand[1].trim()
    const words = control && !demoCommand
    let mode = !words && req.mode && req.mode !== 'chat' ? req.mode : undefined
    let goalIn = words ? undefined : req.goal
    let loopIn = words ? undefined : req.loop
    // The app's own commands, typed like any other message.
    const cmd = words ? null : parseCommand(text)
    if (cmd?.kind === 'goal-action') {
      void this.goalAction(chat.id, cmd.action)
      return
    }
    if (cmd?.kind === 'loop-stop') {
      if (!this.auto.stopLoops(chat)) this.emit({ type: 'toast', level: 'info', text: 'No loop is going in this chat.' })
      return
    }
    if (cmd?.kind === 'ultra') {
      const on = cmd.on ?? !chat.ultra
      this.setUltra(chat.id, on)
      this.emit({ type: 'toast', level: 'info', text: on ? 'Ultra is on for this chat: many agents on the strongest models. Uses allowance very fast.' : 'Ultra is off for this chat.' })
      return
    }
    if (cmd?.kind === 'goal') {
      goalIn = { ...goalIn, text: cmd.text }
      text = cmd.text
    } else if (cmd?.kind === 'loop') {
      loopIn = { ...loopIn, prompt: cmd.prompt, every: cmd.every ?? loopIn?.every }
      text = cmd.prompt
    } else if (cmd?.kind === 'mode') {
      mode = cmd.mode === 'chat' ? undefined : cmd.mode
      text = cmd.text
    } else if (!words && /^\/(gocrazy|go-crazy)\s*$/i.test(text) && !attachments.length) {
      this.emit({ type: 'toast', level: 'info', text: chat.ultra ? 'Type /gocrazy and what you want, for example: /gocrazy design the landing page' : GOCRAZY_NEEDS_ULTRA })
      return
    } else if (!words && /^\/(goal|loop)\s*$/i.test(text) && !attachments.length) {
      // The bare command: say where things stand, or how it is used.
      const g = chat.goal
      const loops = this.auto.loopsText(chat)
      const say = /goal/i.test(text)
        ? g
          ? `Goal (${g.status}): ${truncate(g.text, 120)}`
          : 'Type /goal and what done looks like, for example: /goal all tests pass and the build is green'
        : loops.startsWith('No loop')
          ? 'Type /loop, a pace if you want one, and what to do, for example: /loop 10m check whether the deploy is live'
          : loops
      this.emit({ type: 'toast', level: 'info', text: say })
      return
    }
    // Go crazy is Ultra at full scale: it goes only while Ultra is on, or with a message sent in Ultra.
    // In the demo team, Go crazy turns Ultra on by itself: the point is to see it.
    if (mode === 'gocrazy' && !chat.ultra && this.host.trial) {
      this.setUltra(chat.id, true)
      this.emit({ type: 'toast', level: 'info', text: 'Ultra is on for this chat, so Go crazy can run.' })
    }
    if (mode === 'gocrazy' && !chat.ultra && req.mode !== 'ultra') {
      this.emit({ type: 'toast', level: 'info', text: GOCRAZY_NEEDS_ULTRA })
      return
    }
    // While Ultra is on, a message sent with no other way of working goes in Ultra.
    if (!mode && chat.ultra && !loopIn) mode = 'ultra'
    // A goal that runs in Ultra or Go crazy keeps that way of working for what is said while it is open, unless another was chosen.
    const goalWay = !goalIn && !loopIn ? this.goalMode(chat) : null
    if (goalWay && (!mode || mode === 'ultra')) mode = goalWay
    const files = attachments.length ? `\n\nAttached files:\n${attachments.map((a) => `- ${a.path}`).join('\n')}` : ''
    if (loopIn) {
      const prompt = (loopIn.prompt?.trim() || text) + files
      this.auto.addLoop(chat, { ...loopIn, prompt, to: loopIn.to || account.id })
      this.nameChat(chat, text)
      this.touch(chat, text)
      return
    }
    // The lead has run out, or is about to: the best placed teammate takes over first and gets the message.
    if (this.lead(chat)?.id === account.id) {
      const next = this.failover.beforeSend(chat, account)
      if (next && next.id !== account.id) return this.send({ ...req, to: next.id, text, mode, goal: goalIn })
    }
    // A goal is the lead's to carry, whoever the message box happened to point at.
    const goalLead = goalIn ? this.lead(chat) : null
    if (goalLead && goalLead.id !== account.id && this.accounts.statuses.get(goalLead.id)?.state !== 'signed-out') return this.send({ ...req, to: goalLead.id, text, mode, goal: goalIn })

    const session = this.session(chat, account)
    const item: Item = {
      id: uid('u'),
      kind: 'user',
      ts: Date.now(),
      text,
      attachments: attachments.length ? attachments : undefined,
      queued: session.busy,
    }
    let body = text + files
    const images = attachments.filter((a) => a.kind === 'image').map((a) => a.path)
    const cut = chat.recovery
    const toLead = this.lead(chat)?.id === account.id
    // The team was cut short and you say "continue": everything that was under way is picked up.
    if (cut && toLead && text.length < 160 && CONTINUE.test(text)) {
      void this.resumeChat(chat.id, { said: { text: body, images, item } })
      this.touch(chat, text)
      return
    }
    session.add(item)
    // Ultra and Go crazy raise the chat's agent cap for as long as the lead works that way.
    // A quick question in the middle of a run does not cut the room its agents have.
    if (toLead) {
      if (mode === 'ultra' || mode === 'gocrazy') this.markUltra(chat, mode)
      else if (!this.tasksOf(chat.id).some((t) => t.status === 'running' || t.status === 'queued')) this.markUltra(chat, null)
      // A substantial Go crazy request is looked at once the lead's first reply ends: too few agents, and it is asked once more.
      if (mode === 'gocrazy' && !goalIn && !this.goalMode(chat) && !isSmallTalk(text)) this.floors.set(chat.id, { itemId: item.id, at: Date.now() })
      else this.floors.delete(chat.id)
    }
    // How the user wants this one handled comes right before their words.
    if (mode && (toLead || mode === 'quick' || mode === 'plan')) {
      const ultra = mode === 'ultra' || mode === 'gocrazy'
      body =
        modeNote(mode, {
          lead: toLead,
          team: this.teamOf(chat).length > 1,
          spawn: this.spawnRoom(chat, account) > 0,
          cap: ultra ? this.spawnRoom(chat, account) : undefined,
          models: ultra ? this.ultraTeam(chat) : undefined,
          depth: ultra ? this.maxDepth(chat) : undefined,
        }) + body
    }
    // A goal set in Ultra or Go crazy keeps that way of working for every round (Goal.mode).
    if (goalIn && toLead) body = this.auto.setGoal(chat, { ...goalIn, text: goalIn.text?.trim() || text + files, mode: mode === 'ultra' || mode === 'gocrazy' ? mode : undefined }).intro + body
    // A goal that was waiting on the user has its answer now.
    else if (toLead) body = this.auto.userSpoke(chat) + body
    if (cut && toLead && !cut.told) {
      cut.told = true
      this.saveChats()
      body = `${this.recoveryNote(chat, false)}\n\n${body}`
    }
    // A chat brought in from Claude Code as a summary: the lead is told what was said, once.
    const imp = chat.imported
    if (imp && !imp.resumed && !imp.told && toLead) {
      imp.told = true
      this.saveChats()
      body = this.importDigest(session) + body
    }
    // The first thing said in a chat is where earlier work matters most.
    if (toLead && !session.items.some((i) => i.kind === 'user' && i.id !== item.id) && !text.startsWith('/')) body = this.recall(text) + body
    // The lead is known to be out of allowance: the message waits for the refill, or for whoever takes over, instead of failing.
    const dry = toLead && !goalIn ? this.accounts.limitedUntil(account.id) : null
    if (dry) {
      session.patch(item.id, { queued: true })
      this.holdDry(chat, account, { text: body, itemIds: [item.id], user: true }, dry)
      this.nameChat(chat, text)
      this.touch(chat, text)
      return
    }
    const pre = this.takeWaiting(chat, account)
    const leadIn = this.catchUp(chat, account) + pre.text
    session.enqueue({
      kind: 'user',
      text: leadIn + body,
      images,
      origin: { kind: 'human' },
      itemIds: [...pre.itemIds, item.id],
      parts: leadIn ? [{ text: leadIn, itemIds: pre.itemIds }, { text: body, itemIds: [item.id], user: true, images }] : undefined,
    })

    this.nameChat(chat, text)
    this.touch(chat, text)
  }

  /** A new chat is named after the first real thing said in it. */
  private nameChat(chat: Chat, text: string): void {
    const first = chat.title === NEW_TITLE && !chat.titleLocked
    // A typed command says nothing about what the chat is about; wait for a real message.
    if (first && text && !text.startsWith('/')) {
      chat.title = truncate(text.split('\n')[0].replace(/\s+/g, ' '), 46)
      if (this.settings.smartTitles && !this.host.demo) void this.smartTitle(chat, text)
    }
  }

  // ----- goals and loops -----

  /** Why an agent cannot take a turn right now, and when it can again if that is known. */
  private unavailable(a: Account): { why: string; until?: number } | null {
    if (!a.spawned && !a.enabled) return { why: `${a.name} is switched off.` }
    if (this.accounts.statuses.get(a.id)?.state === 'signed-out') return { why: `${a.name} is signed out.` }
    const until = this.accounts.limitedUntil(a.id)
    return until ? { why: `Waiting for ${a.name}'s allowance to refill`, until } : null
  }

  /** News the user should not miss: a notification when the window is not in front, a line in it when it is. */
  private tell(title: string, body: string, chat: Chat, accountId?: string): void {
    if (this.host.isFocused()) this.emit({ type: 'toast', level: 'info', text: body ? `${title}: ${body}` : title })
    else if (this.settings.notifications) this.host.notify(title, body || chat.title, { chatId: chat.id, accountId })
  }

  /**
   * One answer from a model that knows nothing of the chat: a check, a rewrite, a title.
   * `model` is 'sonnet' for something that takes judgment, otherwise the lightest there is.
   * A Claude account answers when the team has one free; otherwise a ChatGPT account does, on
   * the model of the same weight, so a team of ChatGPT accounts alone lacks none of this.
   */
  private async askLight(system: string, prompt: string, o: { model?: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    const ok = (a: Account): boolean => this.accounts.isReady(a.id) && !this.accounts.limitedUntil(a.id)
    const lead = this.lead()
    // Whoever has the most to spare pays for it, so the lead's allowance goes on the work.
    const spare = (provider: Account['provider']): Account | undefined =>
      this.accounts.accounts.filter((a) => a.provider === provider && ok(a) && a.id !== lead?.id).sort((a, b) => spendScore(budgetOf(this.accounts.usage.get(a.id))) - spendScore(budgetOf(this.accounts.usage.get(b.id))))[0]
    const mine = (provider: Account['provider']): Account | undefined => (lead && lead.provider === provider && ok(lead) ? lead : undefined)
    const pick = spare('claude') || mine('claude') || spare('chatgpt') || mine('chatgpt')
    if (!pick) throw new Error('No account is free to ask.')
    const cwd = o.cwd && exists(o.cwd) ? o.cwd : this.dataDir
    if (pick.provider === 'claude') return askClaudeOnce({ configDir: pick.configDir, cwd, executable: findClaude(this.settings.claudePath), system, prompt, model: o.model, timeoutMs: o.timeoutMs, signal: o.signal })
    // Judgment goes to the everyday model (Sol); everything else to the fastest (Luna).
    const model = this.modelAt(pick, o.model === 'sonnet' ? 'strong' : 'light')?.value
    // Without a light model to ask, a title or a rewrite is not worth a turn of the account's main one.
    if (!model && o.model !== 'sonnet') throw new Error('This account has no light model to ask.')
    return askCodexOnce({ configDir: pick.configDir, cwd, executable: findCodex(), system, prompt, model, timeoutMs: o.timeoutMs, signal: o.signal })
  }

  /** A loop's run: the model chosen for the loop, else a mid-sized one (Sonnet, Sol) rather than the agent's strongest. */
  loopRun(a: Account, model?: string | null): RunSpec | undefined {
    if (model) {
      const how = this.runFor(a, model)
      return typeof how === 'string' ? undefined : how.run
    }
    // Someone set this agent's model themselves: that stands.
    if (a.model) return undefined
    const m = this.modelAt(a, a.provider === 'claude' ? 'mid' : 'strong')
    return m ? { model: m.value, why: `${m.label}. A loop's runs use a mid-sized model, to spare the strongest one` } : undefined
  }

  /** Sets the chat's goal and puts the lead to work on it; null takes the goal off the chat. */
  async setGoal(chatId: string, input: GoalInput | null): Promise<Chat> {
    const chat = this.need(chatId)
    if (!input) {
      await this.auto.goalAction(chat, 'clear')
      return chat
    }
    const lead = this.lead(chat)
    if (!lead) throw new Error('Add an account before setting a goal.')
    if (!input.text?.trim()) throw new Error('Say what the goal is.')
    this.send({ chatId, to: lead.id, text: input.text, goal: input })
    return chat
  }

  async goalAction(chatId: string, action: GoalAction | 'clear'): Promise<Chat> {
    const chat = this.need(chatId)
    if (!chat.goal) this.emit({ type: 'toast', level: 'info', text: 'This chat has no goal.' })
    else {
      const kept = chat.goal.mode
      await this.auto.goalAction(chat, action)
      // A goal stopped by hand ends the Ultra or Go crazy run it kept going.
      if ((action === 'stop' || action === 'clear') && (kept === 'ultra' || kept === 'gocrazy')) this.markUltra(chat, null)
    }
    return chat
  }

  /** Turns the chat's Ultra on or off. It stays as set until changed; off also ends a Go crazy run's raised cap. */
  setUltra(chatId: string, on: boolean): Chat {
    const chat = this.need(chatId)
    const before = this.ultraOf(chat)
    if (on) chat.ultra = true
    else {
      delete chat.ultra
      this.ultraRun.delete(chat.id)
    }
    // The lead's model and effort follow: full power in Ultra, the usual choice out of it.
    const lead = this.lead(chat)
    if (lead && before !== this.ultraOf(chat) && this.sessions.has(`${chat.id}:${lead.id}`)) this.session(chat, lead).recycle()
    this.syncCrazy(chat)
    this.saveChats()
    this.emit({ type: 'chat', chat })
    return chat
  }

  addLoop(chatId: string, input: LoopInput): Chat {
    const chat = this.need(chatId)
    this.auto.addLoop(chat, { ...input, prompt: String(input?.prompt || '') })
    this.nameChat(chat, String(input?.prompt || ''))
    this.touch(chat)
    return chat
  }

  updateLoop(chatId: string, loopId: string, patch: Partial<Pick<Loop, 'prompt' | 'every' | 'maxRuns' | 'until'>> & { status?: 'active' | 'paused' }): Chat {
    const chat = this.need(chatId)
    this.auto.updateLoop(chat, String(loopId), patch || {})
    return chat
  }

  removeLoop(chatId: string, loopId: string): Chat {
    const chat = this.need(chatId)
    this.auto.removeLoop(chat, String(loopId))
    return chat
  }

  runLoop(chatId: string, loopId: string): void {
    this.auto.runLoop(this.need(chatId), String(loopId))
  }

  /**
   * Rewrites a rough message into a clear one without changing what it asks for. Comes back
   * unchanged when there is nobody to ask or the answer is not usable.
   */
  async enhance(text: string, chatId?: string | null): Promise<string> {
    const raw = String(text || '').trim()
    if (raw.length < 8 || raw.startsWith('/')) return raw
    if (this.host.demo) {
      await new Promise((r) => setTimeout(r, 700))
      const s = raw.replace(/\s+/g, ' ')
      return `${s[0].toUpperCase()}${s.slice(1).replace(/[.!?]*$/, '')}.\n\nDone when: it works end to end, you have run it and looked at the result yourself, and anything you could not check is listed.`
    }
    const chat = chatId ? this.chats.get(chatId) : undefined
    // What the chat is about helps read a vague message the right way; it is not to be repeated back.
    const about = chat && chat.title !== NEW_TITLE ? `\n\n(Only to help you read it, never to be mentioned: the conversation so far is titled "${chat.title}".)` : ''
    try {
      const out = (await this.askLight(ENHANCE_SYSTEM, `The message to improve:\n<<<\n${truncate(raw, 6000)}\n>>>${about}`, { model: 'sonnet', timeoutMs: 30_000 }))
        .replace(/^<<<\s*|\s*>>>$/g, '')
        .replace(/^["\u201c]|["\u201d]$/g, '')
        .trim()
      // An answer that is empty, or has turned a line into an essay, is not an improvement.
      if (!out || out.length > Math.max(900, raw.length * 4)) return raw
      return out
    } catch {
      return raw
    }
  }

  private async smartTitle(chat: Chat, firstMessage: string): Promise<void> {
    try {
      const raw = await this.askLight(TITLE_SYSTEM, `The conversation starts with this message:\n\n${truncate(firstMessage, 1500)}`, { timeoutMs: 45_000 })
      const title = raw.split('\n')[0].replace(/^["'“”]+|["'“”.]+$/g, '').trim()
      if (!title || title.length > 60 || chat.titleLocked || !this.chats.has(chat.id)) return
      chat.title = title
      this.saveChats()
      this.emit({ type: 'chat', chat })
    } catch {
      /* the first-line title stays */
    }
  }

  async stop(chatId: string, accountId?: string): Promise<void> {
    const targets = this.sessionsOf(chatId).filter((s) => !accountId || s.account.id === accountId)
    if (!accountId) this.quiet.add(chatId)
    // A Go crazy follow-up that was still due is not sent after Stop.
    if (!accountId || this.lead(this.chats.get(chatId))?.id === accountId) this.floors.delete(chatId)
    const stopped = this.chats.get(chatId)
    // The goal is paused here, whatever the lead is doing, and a stop of the whole chat holds its loops too.
    if (stopped) this.auto.userStopped(stopped, accountId)
    // Stopping the lead in the middle of a reply also takes back what that reply set off: the
    // tasks it handed out since it began, and whatever those agents handed on. A swarm left
    // running behind a stopped lead would spend allowance on work nobody is waiting for.
    const lead = stopped ? this.lead(stopped) : null
    const leadSession = lead && accountId === lead.id ? this.sessions.get(`${chatId}:${lead.id}`) : undefined
    const since = leadSession?.busy ? leadSession.state.turnStartedAt : undefined
    if (stopped && lead && since) {
      const open = this.tasksOf(chatId).filter((t) => t.status === 'queued' || t.status === 'running')
      const back = open.filter((t) => t.from === lead.id && t.createdAt >= since - 500)
      for (let grew = true; grew; ) {
        grew = false
        for (const t of open) {
          // A task handed on by someone who is at work on a task being taken back, since they began it.
          // A helper started earlier, for an older task of theirs, is not this reply's doing.
          if (back.includes(t) || !back.some((b) => b.to === t.from && !!b.startedAt && t.createdAt >= b.startedAt)) continue
          back.push(t)
          grew = true
        }
      }
      if (back.length) {
        for (const t of back) this.takenBack.add(`${chatId}:${t.id}`)
        // Tasks lined up behind one of these fall with it; they are part of the same reply.
        for (const t of open) if (!back.includes(t) && t.waitingOn?.some((id) => back.some((b) => b.id === id))) this.takenBack.add(`${chatId}:${t.id}`)
        for (const t of back) {
          // Cancelling one can already have closed another that waited on it.
          if (t.status !== 'queued' && t.status !== 'running') continue
          const to = this.accounts.get(t.to)
          const s = to ? this.sessions.get(`${chatId}:${to.id}`) : undefined
          if (t.status === 'queued') {
            s?.dequeueTask(t.id)
            this.setTask(t, 'cancelled', `Cancelled when you stopped ${lead.name}.`)
          } else if (t.holding || !s || s.currentTaskId !== t.id) {
            t.holding = false
            this.setTask(t, 'cancelled', `Stopped when you stopped ${lead.name}.`)
          } else {
            // Its ending is not news for a lead that was just told to stop: this one task is muted, however long it takes to end.
            this.stoppedBy.set(`${chatId}:${t.id}`, 'you')
            if (!targets.includes(s)) targets.push(s)
          }
        }
        leadSession?.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `Stopped, and took back the ${back.length === 1 ? 'task' : `${back.length} tasks`} this reply had handed out.` })
      }
    }
    try {
      for (const t of this.tasksOf(chatId)) {
        if (accountId && t.to !== accountId) continue
        if (t.status === 'queued') this.setTask(t, 'cancelled', 'Cancelled before it started.')
        // A task whose owner is waiting on agents of their own has no reply in progress to stop, so it is closed here.
        else if (t.status === 'running' && t.holding) {
          t.holding = false
          this.setTask(t, 'cancelled', 'Stopped by the user before it finished.')
        }
      }
      for (const s of targets) this.hands.release(s)
      await Promise.all(targets.map((s) => s.stop()))
    } finally {
      // Turn-end events for interrupted turns arrive asynchronously.
      if (!accountId) setTimeout(() => this.quiet.delete(chatId), 4000)
    }
  }

  // ----- picking up after the app closed in the middle of work -----

  /**
   * Looks for chats whose team was working when the app last closed (cleanly or not) and
   * marks what was cut short, so it can be picked up with one click or by saying "continue".
   */
  private recover(): void {
    const listed = readJson<Record<string, string[]>>(this.file('running.json'), {})
    const ids = new Set(Object.keys(listed))
    const recent = Date.now() - 3 * 86400e3
    const cut = new Map<string, string[]>()
    for (const chat of this.chats.values()) {
      if (chat.updatedAt < recent && !ids.has(chat.id)) continue
      const raw = readJson<Task[]>(path.join(this.dataDir, 'chats', chat.id, 'tasks.json'), [])
      const live = raw.filter((t) => t.status === 'running' || t.status === 'queued').map((t) => t.id)
      if (live.length) {
        ids.add(chat.id)
        cut.set(chat.id, live)
      }
    }
    for (const id of ids) {
      const chat = this.chats.get(id)
      if (!chat) continue
      this.tasksOf(id)
      const sessions = this.openChat(id) && this.sessionsOf(id)
      const agents = sessions.filter((x) => x.unfinished).map((x) => x.account.id)
      const tasks = cut.get(id) || []
      if (!tasks.length && !agents.length) continue
      // A chat that was already waiting to be picked up keeps its one offer.
      const fresh = !chat.recovery
      chat.recovery = { at: chat.updatedAt, tasks: [...new Set([...(chat.recovery?.tasks || []), ...tasks])], agents: [...new Set([...(chat.recovery?.agents || []), ...agents])] }
      const lead = this.lead(chat)
      if (fresh && lead) {
        const n = chat.recovery.tasks.length
        const mid = sessions.filter((x) => x.unfinished?.worked).map((x) => x.account.name)
        const what = [n ? `${n} ${n === 1 ? 'task was' : 'tasks were'} cut short` : '', mid.length ? `${mid.join(' and ')} ${mid.length === 1 ? 'was' : 'were'} in the middle of working` : ''].filter(Boolean).join(', and ')
        this.session(chat, lead).add({
          id: uid('n'),
          kind: 'notice',
          ts: Date.now(),
          level: 'warn',
          text: `Ensemble closed while the team was working here${what ? `: ${what}` : ''}. Nothing is lost. Every conversation and every file is as it was at that moment.`,
          action: { kind: 'resume' },
        })
      }
    }
    writeJson(this.file('running.json'), {})
    this.saveChats()
  }

  /** What the lead is told about an interruption. `restarted` is whether the work has been started again. */
  private recoveryNote(chat: Chat, restarted: boolean, extra: string[] = []): string {
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const when = clock(chat.recovery?.at || chat.updatedAt)
    const cut = this.tasksOf(chat.id).filter((t) => t.status === 'interrupted')
    const lines = [`Ensemble closed unexpectedly at ${when} while the team was working, and has been reopened. Your conversation is intact up to that moment, and so are the files on disk.`]
    if (!restarted && cut.length) {
      lines.push(`Cut short and not started again: ${cut.map((t) => `${t.id} (${name(t.to)}, "${t.title}")`).join(', ')}. If the user wants that work carried on, call resume_work; otherwise leave it.`)
    }
    return `<recovery>\n${[...lines, ...extra].join('\n')}\n</recovery>`
  }

  /**
   * Picks up what was cut short: interrupted tasks go back to the same teammates, anything
   * that reached an agent but was never read is put in front of it again, and the lead is told.
   * `said` is the message the user typed to set this off; `skip` is an agent that is already awake.
   */
  async resumeChat(chatId: string, opts: { said?: { text: string; images: string[]; item: Item }; skip?: string } = {}): Promise<string> {
    const chat = this.need(chatId)
    this.openChat(chatId)
    const lead = this.lead(chat)
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const when = clock(chat.recovery?.at || chat.updatedAt)
    const sessions = this.sessionsOf(chatId)
    const was = new Map(sessions.map((x) => [x.account.id, x.unfinished]))
    for (const x of sessions) {
      for (const it of x.items) if (it.kind === 'notice' && it.action?.kind === 'resume' && !it.action.done) x.patch(it.id, { action: { ...it.action, done: true } })
      if (x.account.id !== opts.skip) x.closeTail()
    }
    chat.recovery = null
    this.saveChats()
    this.emit({ type: 'chat', chat })

    // The tasks that were under way go back to the teammates who had them.
    const cut = this.tasksOf(chatId).filter((t) => t.status === 'interrupted')
    const restarted: Task[] = []
    const stuck: Task[] = []
    for (const t of cut) {
      const to = this.accounts.get(t.to)
      if (!to || !to.enabled || this.accounts.statuses.get(to.id)?.state === 'signed-out' || !this.accounts.get(t.from)) {
        stuck.push(t)
        continue
      }
      t.status = 'queued'
      t.result = undefined
      t.startedAt = undefined
      t.finishedAt = undefined
      restarted.push(t)
    }
    for (const t of restarted) {
      const waits = (t.after || []).filter((id) => this.findTask(chatId, id)?.status !== 'done')
      t.waitingOn = waits.length ? waits : undefined
      this.wordWaits(t)
      if (t.waitingOn) this.commitTask(t)
      else this.begin(t, `you had started this task when the app closed unexpectedly at ${when}. Your conversation so far is intact. Look at what is already done before redoing anything, then finish the task and report as usual.`)
    }

    // Whatever reached an agent and was never read is put in front of it again.
    let leadTold = false
    for (const x of sessions) {
      const u = was.get(x.account.id)
      const isLead = x.account.id === lead?.id
      if (x.account.id === opts.skip) continue
      if (!u && !(isLead && opts.said)) continue
      const parts: string[] = []
      let unanswered = ''
      for (const it of u?.inputs || []) {
        if (it.kind === 'user') unanswered = it.text
        else if (it.kind === 'peer' && it.tag === 'result') parts.push(`<task-result id="${it.taskId || ''}" from="${esc(name(it.from))}" title="${esc(it.title || '')}" status="${it.status || 'done'}">\n${it.text}\n</task-result>`)
        else if (it.kind === 'peer' && it.tag === 'message') parts.push(`<team-message from="${esc(name(it.from))}">\n${it.text}\n</team-message>`)
      }
      // A teammate that was only on a task is picked up through that task.
      if (!isLead && !parts.length && !unanswered) continue
      const extra: string[] = []
      if (u?.worked) extra.push('You were in the middle of your work when it closed. Look at what is already done before redoing anything, then carry on from where you stopped.')
      if (isLead && restarted.length) extra.push(`The tasks that were out have been started again with the same teammates and will report as usual: ${restarted.map((t) => `${t.id} (${name(t.to)}, "${t.title}")`).join(', ')}.`)
      if (isLead && stuck.length) extra.push(`These could not be started again because the teammate is not available: ${stuck.map((t) => `${t.id} (${name(t.to)}, "${t.title}")`).join(', ')}. Hand them to someone else or do them yourself.`)
      if (parts.length) extra.push('What follows reached you just before it closed and you had not read it yet.')
      const said = isLead ? opts.said : undefined
      if (said) x.add(said.item)
      const tail = said ? `\n\n${said.text}` : unanswered ? `\n\nThe user's last message, which you had not answered yet:\n${unanswered}` : ''
      x.enqueue({
        kind: said ? 'user' : 'team',
        text: `${this.recoveryNote(chat, true, extra)}${parts.length ? `\n\n${parts.join('\n\n')}` : ''}${tail}`,
        images: said?.images,
        origin: said ? { kind: 'human' } : { kind: 'peer', name: 'Ensemble' },
        itemIds: said ? [said.item.id] : [],
      })
      if (isLead) leadTold = true
    }
    // The lead was idle when it closed, but you asked it to continue: it still gets your message.
    if (opts.said && lead && !leadTold && lead.id !== opts.skip) {
      const x = this.session(chat, lead)
      x.add(opts.said.item)
      const extra = restarted.length ? [`The tasks that were out have been started again with the same teammates and will report as usual: ${restarted.map((t) => `${t.id} (${name(t.to)}, "${t.title}")`).join(', ')}.`] : []
      x.enqueue({ kind: 'user', text: `${this.recoveryNote(chat, true, extra)}\n\n${opts.said.text}`, images: opts.said.images, origin: { kind: 'human' }, itemIds: [opts.said.item.id] })
    }
    const summary = restarted.length ? `Started again: ${restarted.map((t) => `${t.id} with ${name(t.to)}`).join(', ')}.` : 'There were no interrupted tasks to start again.'
    return stuck.length ? `${summary} Could not restart: ${stuck.map((t) => t.id).join(', ')} (teammate unavailable).` : summary
  }

  /** Leaves what was cut short as it is. */
  dismissRecovery(chatId: string): void {
    const chat = this.need(chatId)
    this.openChat(chatId)
    for (const x of this.sessionsOf(chatId)) {
      for (const it of x.items) if (it.kind === 'notice' && it.action?.kind === 'resume' && !it.action.done) x.patch(it.id, { action: { ...it.action, done: true } })
      x.closeTail()
    }
    chat.recovery = null
    this.saveChats()
    this.emit({ type: 'chat', chat })
  }

  // ----- tasks -----

  tasksOf(chatId: string): Task[] {
    let list = this.tasks.get(chatId)
    if (!list) {
      list = readJson<Task[]>(path.join(this.dataDir, 'chats', chatId, 'tasks.json'), [])
      for (const t of list) {
        if (t.status === 'running' || t.status === 'queued') {
          t.status = 'interrupted'
          t.result = t.result || 'The app closed before this finished. It can be picked up again.'
          t.finishedAt = t.finishedAt || Date.now()
        }
      }
      this.tasks.set(chatId, list)
    }
    return list
  }

  private setTask(task: Task, status: TaskStatus, result?: string): void {
    task.status = status
    if (status !== 'running') task.holding = undefined
    if (status === 'running') task.startedAt = Date.now()
    if (status === 'done' || status === 'failed' || status === 'cancelled') task.finishedAt = Date.now()
    if (result !== undefined) task.result = truncate(result, 20000)
    this.commitTask(task)
    if (status === 'done' || status === 'failed' || status === 'cancelled') this.settle(task)
  }

  /** A task ended: start whatever was lined up behind it, or call that off if it did not succeed. */
  private settle(ended: Task): void {
    for (const t of this.tasksOf(ended.chatId)) {
      if (t.status !== 'queued' || !t.waitingOn?.includes(ended.id)) continue
      if (ended.status === 'done') {
        t.waitingOn = t.waitingOn.filter((id) => id !== ended.id)
        this.wordWaits(t)
        if (t.waitingOn.length) this.commitTask(t)
        else this.begin(t)
      } else {
        this.setTask(t, 'cancelled', `Not started. It was waiting for ${ended.id} ("${ended.title}"), which ${ended.status === 'failed' ? 'did not finish' : 'was stopped'}.`)
        if (!this.quiet.has(ended.chatId)) this.reportBack(t)
      }
    }
  }

  /** Puts a task in front of the teammate it is for, with the reports of anything it waited on. */
  private begin(task: Task, note?: string): void {
    const chat = this.chats.get(task.chatId)
    const from = this.accounts.get(task.from)
    let to = this.accounts.get(task.to)
    if (!chat || !from || !to) return
    // Its owner ran out while it waited (on other tasks, or for a refill): the next best teammate takes it.
    // A started agent moves itself instead, when its turn starts.
    const until = !to.spawned && this.settings.handover ? this.accounts.limitedUntil(to.id) : null
    const next = until && (task.moves || 0) < MAX_MOVES ? this.pick(chat, { exclude: [to.id, task.from], provider: to.provider }) || this.pick(chat, { exclude: [to.id, task.from] }) : null
    if (until && next) {
      task.movedFrom = to.id
      task.moves = (task.moves || 0) + 1
      task.to = next.id
      if (task.model && typeof this.runFor(next, task.model, task.effort) === 'string') task.model = task.modelLabel = task.effort = task.modelWhy = undefined
      const owner = this.session(chat, from)
      const card = owner.items.find((i) => i.kind === 'delegate' && i.taskId === task.id)
      if (card) owner.patch(card.id, { to: next.id })
      owner.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `${to.name} is out of usage until ${clock(until)}, so ${next.name} takes "${task.title}".` })
      to = next
    }
    task.waitingOn = undefined
    task.waitingFor = undefined
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const earlier = (task.after || []).map((id) => this.findTask(chat.id, id)).filter((t): t is Task => !!t)
    const reports = earlier.length
      ? `\n\nReports from the tasks this one was waiting for:\n${earlier.map((d) => `<task-result id="${d.id}" from="${esc(name(d.to))}" title="${esc(d.title)}" status="${d.status}">\n${truncate(d.result || '', 6000)}\n</task-result>`).join('\n')}`
      : ''
    task.kind ||= kindOf(task.title, task.brief)
    // Nobody named a model: the app picks one for this task, by how far down the team it is,
    // what the account can afford, and what has worked before on this kind of work.
    if (!task.model && !to.model && this.settings.smartModels) {
      const smart = this.smartRun(chat, to, task.kind)
      if (smart) {
        task.model = smart.model
        task.modelLabel = this.choices(to).find((m) => m.value === smart.model)?.label || smart.model
        task.modelWhy = smart.why
        if (smart.effort && !task.effort) task.effort = smart.effort
      }
    }
    const how = this.runFor(to, task.model, task.effort)
    const target = this.session(chat, to)
    const run = typeof how === 'string' ? undefined : { ...this.fits(to, target, how.run), why: task.modelWhy }
    this.commitTask(task)
    const item: Item = { id: uid('g'), kind: 'peer', ts: Date.now(), from: from.id, tag: 'task', text: task.brief, taskId: task.id, title: task.title, queued: target.busy }
    target.add(item)
    const pre = this.takeWaiting(chat, to)
    target.enqueue({
      kind: 'task',
      text: `${pre.text}${note ? '' : this.recall(`${task.title} ${task.brief.slice(0, 500)}`, 4)}<task id="${task.id}" from="${esc(from.name)}" title="${esc(task.title)}">\n${task.brief}${reports}${note ? `\n\nNote from the app: ${note}` : ''}\n</task>${this.boardHint(chat)}`,
      origin: { kind: 'peer', name: from.name },
      itemIds: [...pre.itemIds, item.id],
      taskId: task.id,
      run: run && (run.model || run.effort) ? run : undefined,
    })
  }

  // ----- keeping team talk cheap -----

  /** Roughly how much conversation an agent is carrying, in tokens. */
  private weight(session: AgentSession): number {
    let chars = 0
    for (const it of session.items) {
      if ('text' in it && typeof it.text === 'string') chars += it.text.length
      if (it.kind === 'tool') chars += (it.output?.length || 0) + 200
    }
    return Math.max(session.state.context?.used || 0, Math.round(chars / 3.5))
  }

  /** An account's smallest, cheapest model, when it has one that is not already what it runs. */
  private lightModel(a: Account): string | undefined {
    const list = this.choices(a)
    const m = a.provider === 'claude' ? list.find((x) => /haiku/i.test(x.value) || /haiku/i.test(x.label)) : modelForTier(list, 'light')
    return m && m.value !== a.model ? m.value : undefined
  }

  /**
   * Drops a request for the small model when the agent's conversation has outgrown it:
   * the model would have to summarise the conversation to fit, and that loss is permanent.
   */
  private fits(a: Account, session: AgentSession, run: RunSpec): RunSpec {
    const light = this.lightModel(a)
    if (!run.model || !light || run.model !== light || this.weight(session) <= LIGHT_LIMIT) return run
    return { ...run, model: undefined }
  }

  /**
   * Leaves something to be read with the reader's next piece of work instead of waking them for it.
   * Nothing waits for ever: unless `wake` is false, they are woken for it after a while if no work comes along.
   */
  private hold(chat: Chat, account: Account, entry: Waiting, wake = true): void {
    const key = `${chat.id}:${account.id}`
    const list = this.waiting.get(key) || []
    list.push(entry)
    this.waiting.set(key, list)
    if (wake && !this.waitTimers.has(key)) this.wakeIn(chat, account, this.wait(HOLD_MS))
  }

  /** Delivers what is waiting for an agent after `ms`, or once its allowance refills if it has none left by then. */
  private wakeIn(chat: Chat, account: Account, ms: number): void {
    const key = `${chat.id}:${account.id}`
    clearTimeout(this.waitTimers.get(key))
    this.waitTimers.set(
      key,
      setTimeout(
        () => {
          this.waitTimers.delete(key)
          if (!this.chats.has(chat.id) || !this.accounts.get(account.id)) return
          // Waking an agent with no allowance left only turns the reports into an error: wait for the refill.
          const until = this.accounts.limitedUntil(account.id)
          if (until) return this.wakeIn(chat, account, until - Date.now() + 30_000)
          this.deliverWaiting(chat, account)
        },
        Math.max(1000, ms),
      ),
    )
  }

  /** Puts everything that was left for an agent in front of it now, as one turn. */
  private deliverWaiting(chat: Chat, account: Account): void {
    const list = this.takeEntries(chat, account).filter((w) => w.text.trim())
    if (!list.length) return
    const user = list.some((w) => w.user)
    if (this.dryOffer.get(chat.id) === account.id) this.dryOffer.delete(chat.id)
    const parts = list.map((w) => ({ text: w.text, itemIds: w.itemIds, user: w.user }))
    const catchUp = this.catchUp(chat, account)
    if (catchUp) parts.unshift({ text: catchUp.trimEnd(), itemIds: [], user: undefined })
    this.session(chat, account).enqueue({
      kind: user ? 'user' : 'team',
      text: parts.map((x) => x.text).join('\n\n').trimEnd(),
      origin: user ? { kind: 'human' } : { kind: 'peer', name: 'the team' },
      itemIds: list.flatMap((w) => w.itemIds),
      taskId: user ? undefined : this.heldBy(chat, account)?.id,
      parts,
    })
  }

  /**
   * The agent has no allowance left: what reaches it waits for the refill instead of failing, and
   * a lead's chat gets one offer to hand over to someone who has allowance.
   */
  private holdDry(chat: Chat, account: Account, entry: Waiting, until: number | null, decide = true): void {
    this.hold(chat, account, entry, false)
    if (!this.waitTimers.has(`${chat.id}:${account.id}`)) this.wakeIn(chat, account, until ? until - Date.now() + 30_000 : this.wait(HOLD_MS))
    const lead = this.lead(chat)
    if (!decide || lead?.id !== account.id) return
    // The best placed teammate takes over by itself and gets all of it, or the chat is told once that everyone is out.
    if (this.settings.handover) {
      this.failover.considerLead(chat, { hit: true, need: true })
      return
    }
    if (this.dryOffer.get(chat.id) === lead.id) return
    this.dryOffer.set(chat.id, lead.id)
    const next = this.successor(chat, lead)
    const when = until ? `until ${clock(until)}` : 'for now'
    this.session(chat, lead).add({
      id: uid('n'),
      kind: 'notice',
      ts: Date.now(),
      level: 'error',
      text: `${lead.name} has used up its allowance ${when}. Messages and reports for it wait and reach it when it refills${next ? `, or ${next.name} can take over as lead now and get them` : ''}.`,
      action: next ? { kind: 'switch-lead', to: next.id } : undefined,
    })
  }

  /** Takes what was left for an agent to read, as it was left. */
  private takeEntries(chat: Chat, account: Account): Waiting[] {
    const key = `${chat.id}:${account.id}`
    clearTimeout(this.waitTimers.get(key))
    this.waitTimers.delete(key)
    const list = this.waiting.get(key) || []
    this.waiting.delete(key)
    return list
  }

  /** Forgets what was left for an agent that is going away. */
  private dropWaiting(key: string): void {
    clearTimeout(this.waitTimers.get(key))
    this.waitTimers.delete(key)
    this.waiting.delete(key)
  }

  /** Everything that was left for an agent to read, to be put in front of whatever reaches them next. */
  private takeWaiting(chat: Chat, account: Account): { text: string; itemIds: string[] } {
    const list = this.takeEntries(chat, account)
    if (!list.length) return { text: '', itemIds: [] }
    return { text: `${list.map((w) => w.text).join('\n\n')}\n\n`, itemIds: list.flatMap((w) => w.itemIds) }
  }

  /**
   * Who a task waits for, in words the window can show: the agents those tasks went to, never task
   * ids. Kept in step with `waitingOn` and `after`, which stay ids for the engine and the lead.
   */
  private wordWaits(task: Task): void {
    const who = (ids: string[] | undefined): string | undefined => {
      if (!ids?.length) return undefined
      const names = ids.map((id) => {
        const t = this.findTask(task.chatId, id)
        return (t && this.accounts.get(t.to)?.name) || t?.title || 'another task'
      })
      return namesLine(names) || undefined
    }
    task.waitingFor = who(task.waitingOn)
    task.afterFor = who(task.after)
  }

  private commitTask(task: Task): void {
    writeJson(path.join(this.dataDir, 'chats', task.chatId, 'tasks.json'), this.tasksOf(task.chatId))
    this.emit({ type: 'task', task })
  }

  /** Tasks are numbered within their chat (t1, t2, …), so a task is always looked up in its chat. */
  private findTask(chatId: string, taskId: string): Task | undefined {
    return this.tasksOf(chatId).find((x) => x.id === taskId)
  }

  onTurnStart(session: AgentSession, pending: Pending): void {
    const set = this.running.get(session.chat.id) || new Set<string>()
    set.add(session.account.id)
    this.running.set(session.chat.id, set)
    this.saveRunning()
    // An agent started in the chat whose account has run out moves to one with room before this turn
    // runs, whatever brought the turn about, and is told what it had done so far.
    const a = session.account
    if (a.spawned && this.settings.handover && this.accounts.limitedUntil(a.id)) {
      const moved = this.rehome(session.chat, a)
      if (moved) {
        pending.text = `<recovery>\n${this.movedNote(moved)}\n</recovery>\n\n${pending.text}`
        if (pending.run?.model && typeof this.runFor(a, pending.run.model) === 'string') pending.run = undefined
      }
    }
    if (!pending.taskId) return
    const task = this.findTask(session.chat.id, pending.taskId)
    if (!task) return
    if (task.status === 'queued') this.setTask(task, 'running')
    else if (task.holding) {
      // Its owner is back at it, with what their own agents reported.
      task.holding = false
      this.commitTask(task)
    }
  }

  /** The tasks someone handed out that are still under way. */
  private outFrom(chat: Chat, account: Account): Task[] {
    return this.tasksOf(chat.id).filter((t) => t.from === account.id && (t.status === 'running' || t.status === 'queued'))
  }

  /** The task someone is keeping open while agents of their own work on parts of it. */
  private heldBy(chat: Chat, account: Account): Task | undefined {
    return this.tasksOf(chat.id).find((t) => t.to === account.id && t.status === 'running' && t.holding)
  }

  onTurnEnd(session: AgentSession, pending: Pending, ev: TurnEnd): void {
    const chat = session.chat
    this.hands.release(session)
    // ChatGPT accounts do not report their allowance as they work, so ask after each turn.
    if (session.account.provider === 'chatgpt') void this.accounts.refreshUsage(session.account.id)
    const set = this.running.get(chat.id)
    set?.delete(session.account.id)
    if (set && !set.size) this.running.delete(chat.id)
    this.saveRunning()
    // The agent's process died under it, which is not the agent failing: give the same work one more go.
    const died = ev.status === 'error' && ev.reason === 'other' && DIED.test(ev.error || '') && this.chats.has(chat.id) && !this.quiet.has(chat.id)
    if (died && pending.kind !== 'ask') {
      const task = pending.taskId ? this.findTask(chat.id, pending.taskId) : undefined
      if (task && !task.retried && (task.status === 'running' || task.status === 'queued')) {
        task.retried = true
        this.setTask(task, 'queued')
        session.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `${session.account.name}'s process stopped unexpectedly. It was started again and is carrying on with "${task.title}".` })
        this.begin(task, 'your process stopped unexpectedly while you were on this task and was started again. Your conversation is intact. Look at what is already done before redoing anything, then finish the task and report as usual.')
        return
      }
      if (!task && !pending.retried) {
        session.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `${session.account.name}'s process stopped unexpectedly. It was started again and is carrying on.` })
        session.enqueue(
          { ...pending, retried: true, text: `<recovery>\nYour process stopped unexpectedly in the middle of this and was started again. Your conversation is intact. Look at what is already done before redoing anything, then carry on.\n</recovery>\n\n${pending.text}`, itemIds: [] },
          true,
        )
        return
      }
    }
    // The strongest model ran into its own limit while the account still has allowance:
    // the same work carries on one model down instead of failing or changing hands.
    if (pending.stepTo) {
      const next = pending.stepTo
      const task = pending.taskId ? this.findTask(chat.id, pending.taskId) : undefined
      if (task && (task.status === 'running' || task.status === 'queued')) this.setTask(task, 'queued')
      session.recycle()
      session.enqueue(
        {
          ...pending,
          stepTo: undefined,
          stepped: true,
          run: { ...pending.run, model: next },
          text: `<recovery>\nThe model you were running reached its usage limit partway through this, and you were started again on another model. Your conversation is intact. Look at what is already done before redoing anything, then carry on.\n</recovery>\n\n${pending.text}`,
          itemIds: [],
        },
        true,
      )
      return
    }
    // Out of allowance while reading reports or the user's message: what it was given waits for
    // the refill, or for whoever takes over, rather than being lost with the failed reply.
    if (ev.status === 'error' && ev.reason === 'limit' && !pending.taskId && (pending.kind === 'team' || pending.kind === 'user') && this.chats.has(chat.id) && !this.quiet.has(chat.id)) {
      for (const id of pending.itemIds) session.patch(id, { queued: true })
      // Kept piece by piece, so a message among them can still be taken back on its own.
      const pieces = pending.parts?.length ? pending.parts : [{ text: pending.text, itemIds: pending.itemIds, user: pending.kind === 'user' }]
      const until = this.accounts.limitedUntil(session.account.id)
      const kept = pieces.filter((x) => x.text.trim())
      // Everything is held first, then it is decided once whether someone else takes it all.
      kept.forEach((x, i) => this.holdDry(chat, session.account, { text: x.text, itemIds: x.itemIds, user: x.user }, until, i === kept.length - 1))
      // A started agent moves to an account with room and reads it there now, rather than waiting for the refill.
      if (session.account.spawned && this.settings.handover && kept.length) {
        const moved = this.rehome(chat, session.account)
        if (moved) {
          const list = this.waiting.get(session.key) || []
          list.unshift({ text: `<recovery>\n${this.movedNote(moved)}\n</recovery>`, itemIds: [] })
          this.waiting.set(session.key, list)
          this.deliverWaiting(chat, session.account)
        }
      }
    }
    // The lead's reply ended on the limit with nothing to hold (it was answering a question): it still hands over.
    else if (ev.status === 'error' && ev.reason === 'limit' && this.settings.handover && this.lead(chat)?.id === session.account.id) this.failover.considerLead(chat, { hit: true })
    const handed = ev.reason === 'limit' && this.lead(chat)?.id !== session.account.id && chat.cover?.from === session.account.id
    pending.onDone?.(ev)
    if (!this.chats.has(chat.id)) return
    if (pending.taskId) {
      const task = this.findTask(chat.id, pending.taskId)
      if (task && session.state.model) task.ranOn = session.state.model
      if (task && (task.status === 'running' || task.status === 'queued')) {
        // A finished task, or one that failed at its work, says something about the model. A stop or a limit does not.
        if (ev.status === 'done' && !this.outFrom(chat, session.account).length) this.learning.outcome(session.state.model, true)
        else if (ev.status === 'error' && ev.reason === 'other') this.learning.outcome(session.state.model, false)
        if (ev.status === 'done' && this.outFrom(chat, session.account).length) {
          // They handed parts of this to agents of their own and stopped to wait for them. The
          // task is not finished: it stays open, and what they say once those reports are in is the report.
          task.holding = true
          this.commitTask(task)
        } else if (ev.status === 'done') {
          task.holding = false
          this.setTask(task, 'done', ev.resultText.trim() || 'Finished, but left no report.')
          this.reportBack(task)
        } else if (ev.status === 'interrupted') {
          const by = this.stoppedBy.get(`${chat.id}:${task.id}`)
          this.stoppedBy.delete(`${chat.id}:${task.id}`)
          this.setTask(task, 'cancelled', by ? `Stopped by ${by} before it finished.` : 'Stopped by the user before it finished.')
          // Whoever stopped it knows already.
          if (!by && !this.quiet.has(chat.id)) this.reportBack(task)
        } else if (ev.reason === 'limit' && this.moveTask(task, session.account, pending)) {
          // Someone with allowance left has picked it up; the assigner need not be woken.
        } else if (ev.reason === 'other' && task.modelWhy && !task.escalated && this.escalate(task, session)) {
          // The cheaper model the app picked could not finish it: one more go, a step up.
        } else if (ev.reason === 'limit' && this.park(task, session.account)) {
          // It waits for the allowance to refill and starts by itself.
        } else {
          const why =
            ev.reason === 'limit'
              ? `${session.account.name} ran out of usage allowance before finishing, and nobody else was free to take it. Give this to another teammate later or do it yourself.`
              : ev.reason === 'auth'
                ? `${session.account.name} is signed out and could not run this.`
                : ev.error || 'The task ended with an error.'
          this.setTask(task, 'failed', ev.resultText.trim() ? `${why}\n\nPartial output:\n${ev.resultText.trim()}` : why)
          this.reportBack(task)
        }
      }
    }
    if (ev.resultText.trim()) this.touch(chat, ev.resultText)
    else this.touch(chat)

    const lead = this.lead(chat)
    if (ev.status === 'done' && session.account.id === lead?.id) this.noteSoon(chat)
    // A lead close to the end of its window hands over at the end of a reply, while work goes on.
    if (ev.status === 'done' && session.account.id === lead?.id) this.failover.considerLead(chat)
    // In Ultra, agents whose stage is over are sent home once they have sat idle a while.
    if (session.account.id === lead?.id && this.ultraOf(chat)) this.sweepSoon(chat)
    // A run in Ultra or Go crazy is over when the lead has answered and nothing is out or waiting:
    // from then on the chat is back to what it is set to (Ultra if it is switched on, else ordinary).
    // Going crazy, a first reply that started too few agents is sent back once (before the run could end).
    this.crazyFloor(session, pending, ev)
    if (session.account.id === lead?.id && ev.status === 'done' && this.ultraRun.has(chat.id) && !session.busy && !session.state.queued && !this.tasksOf(chat.id).some((t) => t.status === 'running' || t.status === 'queued')) this.markUltra(chat, null)
    // A goal in play, or a loop's run, brings its own news: the check's verdict, the loop ending.
    const ownNews = this.auto.afterTurn(session, pending, ev) || pending.auto?.of === 'loop'
    const worthTelling = !ownNews && !handed && (pending.kind === 'user' || session.account.id === lead?.id)
    if (worthTelling && ev.status !== 'interrupted' && this.settings.notifications && !this.host.isFocused()) {
      this.host.notify(
        ev.status === 'done' ? `${session.account.name} finished` : `${session.account.name} stopped with a problem`,
        truncate((ev.resultText || ev.error || chat.title).replace(/\s+/g, ' '), 160),
        { chatId: chat.id, accountId: session.account.id },
      )
    }
  }

  /** Hands a finished task's report to whoever assigned it, waking them if idle. */
  private reportBack(task: Task): void {
    // Taken back when the user stopped the lead: its ending is not reported.
    if (this.takenBack.delete(`${task.chatId}:${task.id}`)) return
    const chat = this.chats.get(task.chatId)
    const from = this.accounts.get(task.from)
    const to = this.accounts.get(task.to)
    if (!chat || !from || !to || from.id === to.id) return
    const s = this.session(chat, from)
    const result = task.result || ''
    const item: Item = {
      id: uid('g'),
      kind: 'peer',
      ts: Date.now(),
      from: to.id,
      tag: 'result',
      text: result,
      taskId: task.id,
      title: task.title,
      status: task.status,
      queued: s.busy,
    }
    const open = this.tasksOf(chat.id).filter((t) => t.from === from.id && (t.status === 'running' || t.status === 'queued'))
    const block = `<task-result id="${task.id}" from="${esc(to.name)}" title="${esc(task.title)}" status="${task.status}">\n${result}\n</task-result>`
    // No allowance left to read it with: it waits for the refill, or for a new lead.
    const dry = this.accounts.limitedUntil(from.id)
    if (dry) {
      item.queued = true
      s.add(item)
      this.holdDry(chat, from, { text: block, itemIds: [item.id] }, dry)
      return
    }
    // A good report with other work still out needs nothing from the lead yet. Waking it would
    // cost a full reply on its model just to say "noted", so the report waits for the others.
    // A report of trouble is never held back.
    if (this.settings.lightTalk && task.status === 'done' && open.length > 0 && !s.busy) {
      item.queued = true
      s.add(item)
      this.hold(chat, from, { text: block, itemIds: [item.id] })
      return
    }
    s.add(item)
    const pre = this.takeWaiting(chat, from)
    const still = open.length ? `\n\nStill out: ${open.map((t) => `${t.id} with ${this.accounts.get(t.to)?.name || t.to}`).join(', ')}.` : '\n\nNo other tasks are out.'
    // Someone who is not the lead was waiting on this for a task of their own: the turn it wakes them for belongs to that task.
    const held = this.heldBy(chat, from)
    const owed = held && !open.length ? `\n\nEverything you handed out for your own task ${held.id} ("${held.title}") is back. Check it, finish what is left, and write your report: your next message is what goes back to whoever gave you that task.` : ''
    s.enqueue({
      kind: 'team',
      text: `${this.catchUp(chat, from)}${pre.text}${block}${still}${owed}`,
      origin: { kind: 'peer', name: to.name },
      itemIds: [...pre.itemIds, item.id],
      taskId: held?.id,
      // The turn belongs to that task, so it runs on the model and effort the task was given, not on the agent's default.
      run: held ? this.runOfTask(from, held) : undefined,
    })
  }

  /** Tries a task again one model up, after the model the app picked for it failed at it. */
  private escalate(task: Task, session: AgentSession): boolean {
    const up = this.stronger(session.account, task.ranOn || task.model)
    if (!up) return false
    const was = this.choices(session.account).find((m) => m.value === task.model)?.label || familyOf(task.ranOn)?.name || 'The cheaper model'
    task.escalated = true
    task.model = up.value
    task.modelLabel = up.label
    task.modelWhy = `${up.label}. ${was} could not finish this, so it is being tried again one step up`
    task.effort = undefined
    this.setTask(task, 'queued')
    const assigner = this.accounts.get(task.from)
    if (assigner) this.session(session.chat, assigner).add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `${was} could not finish "${task.title}", so ${session.account.name} is trying again on ${up.label}.` })
    this.begin(task, `this was tried on ${was} first, which could not finish it. You are running a stronger model now. Look at what is already done before redoing anything.`)
    return true
  }

  /**
   * Hands a task whose owner ran out of allowance to the next best teammate. With handover on, a
   * task may move up to MAX_MOVES times and to the other provider when its own has nobody, and an
   * agent started in the chat keeps its task and moves to an account with room instead.
   */
  private moveTask(task: Task, from: Account, pending?: Pending): boolean {
    const chat = this.chats.get(task.chatId)
    const assigner = this.accounts.get(task.from)
    if (!chat || !assigner) return false
    const auto = this.settings.handover
    if (auto ? (task.moves || 0) >= MAX_MOVES : !!task.movedFrom) return false
    if (auto && from.spawned) return this.rehomeTask(task, from, pending)
    const next = this.pick(chat, { exclude: [from.id, task.from], provider: from.provider }) || (auto ? this.pick(chat, { exclude: [from.id, task.from] }) : null)
    if (!next) return false
    const memory = this.memoryOf(chat, from, 2500)
    task.movedFrom = from.id
    task.moves = (task.moves || 0) + 1
    task.to = next.id
    task.startedAt = undefined
    // The same model and effort, when the new owner has them.
    const kept = this.runFor(next, task.model, task.effort)
    const run = typeof kept === 'string' ? undefined : kept.run
    if (!run) task.model = task.modelLabel = task.effort = task.modelWhy = undefined
    task.holding = false
    this.setTask(task, 'queued')
    const owner = this.session(chat, assigner)
    const card = owner.items.find((i) => i.kind === 'delegate' && i.taskId === task.id)
    if (card) owner.patch(card.id, { to: next.id })
    owner.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `${from.name} ran out of allowance, so ${next.name} picked up "${task.title}".` })
    const target = this.session(chat, next)
    const item: Item = { id: uid('g'), kind: 'peer', ts: Date.now(), from: assigner.id, tag: 'task', text: task.brief, taskId: task.id, title: task.title, queued: target.busy }
    target.add(item)
    target.enqueue({
      kind: 'task',
      text: `<task id="${task.id}" from="${esc(assigner.name)}" title="${esc(task.title)}">\n${task.brief}\n\nNote from the app: ${from.name} started this task and ran out of usage allowance partway. Some of it may already be done on disk. Check what exists before redoing anything.${memory.replace('What you had done so far', `What ${from.name} had done so far`)}\n</task>`,
      origin: { kind: 'peer', name: assigner.name },
      itemIds: [item.id],
      taskId: task.id,
      run,
    })
    return true
  }

  /**
   * An agent started in the chat whose account ran out: it moves to the account with the most room
   * (the same provider first) for its next turn. A conversation cannot cross accounts, so it starts a
   * fresh one there and is given a short account of what it did so far. Returns null when no account has room.
   */
  private rehome(chat: Chat, agent: Account): { from: Account; to: Account; memory: string } | null {
    const sp = agent.spawned
    if (!sp || sp.gone) return null
    const from = this.accounts.get(sp.base)
    if (!from) return null
    const to = this.pick(chat, { exclude: [from.id], provider: agent.provider }) || this.pick(chat, { exclude: [from.id] })
    if (!to) return null
    const memory = this.memoryOf(chat, agent)
    sp.base = to.id
    agent.provider = to.provider
    agent.configDir = to.configDir
    // The conversation lives with the old account; the next turn starts a new one on the new account.
    delete chat.sessions[agent.id]
    this.sessions.get(`${chat.id}:${agent.id}`)?.recycle()
    this.saveChats()
    this.emit({ type: 'chat', chat })
    const by = this.accounts.get(sp.by)
    if (by) this.session(chat, by).add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `${agent.name} moved from ${from.name}'s account to ${to.name}'s: ${from.name} ran out of usage. It carries on with a summary of its work so far.` })
    return { from, to, memory }
  }

  /** What an agent that moved accounts is told before anything else on its new account. */
  private movedNote(m: { from: Account; to: Account; memory: string }): string {
    return `You were moved from ${m.from.name}'s account to ${m.to.name}'s because ${m.from.name} ran out of usage. Your earlier conversation stayed behind, so this is a fresh one. Files you wrote are still on disk: look at what exists before redoing anything.${m.memory || '\n\n(No record of earlier work in this chat.)'}`
  }

  /** A started agent's task, after its account ran out partway: the agent moves to an account with room and starts the task again there. */
  private rehomeTask(task: Task, agent: Account, pending?: Pending): boolean {
    const chat = this.chats.get(task.chatId)
    if (!chat) return false
    const moved = this.rehome(chat, agent)
    if (!moved) return false
    task.movedFrom = moved.from.id
    task.moves = (task.moves || 0) + 1
    task.holding = false
    // A model the old account had and the new one lacks is dropped; the app picks again.
    if (task.model && typeof this.runFor(agent, task.model, task.effort) === 'string') task.model = task.modelLabel = task.effort = task.modelWhy = undefined
    this.setTask(task, 'queued')
    const reading = pending?.kind === 'team' && pending.text.trim() ? `\n\nWhat you were reading when it stopped:\n${truncate(pending.text.trim(), 6000)}` : ''
    this.begin(task, `${this.movedNote(moved)}${reading}`)
    return true
  }

  /**
   * A short account of an agent's work in this chat so far, from what the app recorded: the tasks
   * it was given, what it did, what it said. Empty when there is nothing.
   */
  private memoryOf(chat: Chat, agent: Account, max = 5000): string {
    const s = this.sessions.get(`${chat.id}:${agent.id}`)
    if (!s) return ''
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const lines: string[] = []
    let did: string[] = []
    const flush = (): void => {
      if (did.length) lines.push(`Steps: ${[...new Set(did)].slice(-12).join('; ')}.`)
      did = []
    }
    for (const it of s.items) {
      if (it.kind === 'tool') {
        if (it.status !== 'done' || it.name.startsWith('mcp__team__')) continue
        const d = describeTool(it.name, it.input)
        did.push(`${d.done}${d.target ? ` ${d.target}` : ''}`)
        continue
      }
      if (it.kind === 'peer' && it.tag === 'task') {
        flush()
        lines.push(`Task from ${name(it.from)}, "${it.title || 'a task'}": ${truncate(it.text.trim(), 600)}`)
      } else if (it.kind === 'peer' && it.tag === 'result') {
        flush()
        lines.push(`Report from ${name(it.from)} on "${it.title || 'a task'}": ${truncate(it.text.trim(), 500)}`)
      } else if (it.kind === 'user' && it.text.trim()) {
        flush()
        lines.push(`The user said: ${truncate(it.text.trim(), 600)}`)
      } else if (it.kind === 'assistant' && it.text.trim()) {
        flush()
        lines.push(`You said: ${truncate(it.text.trim(), 800)}`)
      }
    }
    flush()
    const kept: string[] = []
    let used = 0
    for (let i = lines.length - 1; i >= 0 && used + lines[i].length < max; i--) {
      kept.unshift(lines[i])
      used += lines[i].length
    }
    return kept.length ? `\n\nWhat you had done so far, oldest first:\n${kept.join('\n')}` : ''
  }

  /** The agents someone started in a chat and that are still here. */
  private agentsOf(chat: Chat, by: Account): Account[] {
    return (chat.agents || []).filter((a) => a.spawned?.by === by.id && !a.spawned.gone)
  }

  private assign(chat: Chat, from: Account, args: { to: string; title: string; brief: string; model?: string; effort?: string; after?: string[] | string }): string {
    const brief = (args.brief || '').trim()
    if (!brief) return 'The brief is empty. Describe the work.'
    const asked = (args.to || '').trim()
    const auto = !asked || /^(auto|anyone|any)$/i.test(asked)
    const isLead = this.lead(chat)?.id === from.id
    const mine = this.agentsOf(chat, from)
    let to: Account | null | undefined
    if (auto && !isLead) {
      // Someone who is not the lead hands work to the agents they started themselves.
      if (!mine.length) return 'You have not started any agents of your own yet. Start one with spawn_agent (it can take the task in the same call), or do the work yourself.'
      to = [...mine].sort((a, b) => Number(this.session(chat, a).busy) - Number(this.session(chat, b).busy) || this.session(chat, a).state.queued - this.session(chat, b).state.queued)[0]
    } else if (auto) {
      // A model named for the task decides which kind of teammate can take it.
      const provider = this.providerOfModel(args.model)
      const wantsTop = this.isTop(args.model)
      // An account with room comes first, of either provider, before one that is running low.
      to =
        this.pick(chat, { exclude: [from.id], provider: provider || 'claude', wantsTop, roomy: true }) ||
        (provider ? null : this.pick(chat, { exclude: [from.id], roomy: true })) ||
        this.pick(chat, { exclude: [from.id], provider: provider || 'claude', wantsTop }) ||
        (provider ? null : this.pick(chat, { exclude: [from.id] }))
      if (!to) return this.spawnRoom(chat, from) > 0 ? 'No other account can take work right now. Start an agent for it with spawn_agent (it works on your account), or do it yourself.' : 'Nobody on the team can take work right now (signed out or out of allowance). Do this yourself, or tell the user.'
    } else {
      to = this.accounts.byName(asked, chat.id)
      if (!to || !to.enabled || to.spawned?.gone) return `There is no teammate called "${asked}". Call roster to see who is on the team, or pass "auto".`
      if (to.id === from.id) return 'That is you. Do the work yourself or pick a teammate.'
      if (!isLead && to.spawned?.by !== from.id) {
        return `Tasks from you go to the agents you started yourself${mine.length ? ` (${mine.map((a) => a.name).join(', ')})` : ''}. ${to.name} is not one of them: use message to tell them something, ask to put a question to them, or spawn_agent to start an agent of your own for this.`
      }
      const st = this.accounts.statuses.get(to.id)
      if (st?.state !== 'ready') return `${to.name} is not available right now (${st?.state === 'signed-out' ? 'signed out' : 'not ready'}). Pick someone else or pass "auto".`
      const until = this.accounts.limitedUntil(to.id)
      // A started agent moves to an account with room when its next turn starts; a whole account cannot.
      if (until && !(to.spawned && this.settings.handover && this.pick(chat, { exclude: [this.accounts.baseId(to.id)] }))) return `${to.name} has no usage allowance left until ${clock(until)}. Pick someone else, pass "auto", or do it yourself.`
    }

    const how = this.runFor(to, args.model, args.effort)
    if (typeof how === 'string') return how

    const list = this.tasksOf(chat.id)
    // Tasks this one is lined up behind.
    const after = [...new Set((Array.isArray(args.after) ? args.after : String(args.after || '').split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))]
    for (const id of after) {
      const dep = list.find((t) => t.id === id)
      if (!dep) return `There is no task ${id} in this chat to wait for. task_status lists the tasks.`
      if (dep.status === 'failed' || dep.status === 'cancelled') return `Task ${id} did not finish (${dep.status}), so nothing can be lined up behind it. Hand it out again first, or give this task without waiting for it.`
    }
    const waitingOn = after.filter((id) => list.find((t) => t.id === id)?.status !== 'done')
    const task: Task = {
      id: `t${list.length + 1}`,
      chatId: chat.id,
      title: truncate(args.title.trim() || brief.split('\n')[0], 90),
      brief,
      from: from.id,
      to: to.id,
      status: 'queued',
      createdAt: Date.now(),
      model: how.run.model || undefined,
      modelLabel: how.run.model ? this.choices(to).find((m) => m.value === how.run.model)?.label || how.run.model : undefined,
      effort: how.run.effort || undefined,
      after: after.length ? after : undefined,
      waitingOn: waitingOn.length ? waitingOn : undefined,
    }
    this.wordWaits(task)
    list.push(task)
    this.setTask(task, 'queued')

    this.session(chat, from).add({ id: uid('d'), kind: 'delegate', ts: Date.now(), taskId: task.id, to: to.id, title: task.title, brief })
    const who = `${to.name}${auto ? ' (picked as the freest teammate)' : ''}${how.label ? `, running ${how.label}` : ''}`
    if (waitingOn.length) {
      return `Task ${task.id} is lined up for ${who}. It starts by itself when ${waitingOn.join(' and ')} ${waitingOn.length === 1 ? 'is' : 'are'} done, and their reports go to ${to.name} with the brief. Its own report will reach you as a <task-result> message.`
    }
    const ahead = this.session(chat, to).busy ? ' They are busy, so it starts when their current work ends.' : ''
    this.begin(task)
    return `Task ${task.id} is with ${who}.${ahead} Their report will arrive on its own as a <task-result> message, handed to you once your turn has ended. Do not wait, sleep or poll for it inside this turn: carry on with other work, or end your turn now.`
  }

  // ----- starting agents inside a chat -----

  /**
   * Starts a new agent in the chat on behalf of `by`. The agent is a full teammate with a
   * conversation of its own; it works on an account's sign-in and allowance, and answers to
   * whoever started it. With a brief, it is handed its first task in the same breath.
   */
  private spawn(chat: Chat, by: Account, args: SpawnArgs): string {
    const depth = this.depthOf(chat, by)
    const cap = this.agentCap(chat)
    if (cap <= 0) return 'Starting extra agents is switched off in Settings. Hand the work to a teammate, or do it yourself.'
    const deepest = this.maxDepth(chat)
    if (depth >= deepest) {
      const parent = by.spawned ? this.accounts.get(by.spawned.by)?.name : undefined
      return `You are at the deepest level this chat allows (${deepest} below the lead${deepest > MAX_DEPTH_USUAL ? '' : '; Ultra allows more'}), so you cannot start agents of your own. Do the work yourself, or tell ${parent || 'whoever started you'} in your report what else is needed.`
    }
    const live = (chat.agents || []).filter((a) => !a.spawned?.gone)
    if (live.length >= cap) {
      const idle = live.filter((a) => !this.sessions.get(`${chat.id}:${a.id}`)?.busy).map((a) => a.name)
      return `This chat already has ${live.length} extra agents, which is the limit.${idle.length ? ` These are free and can take more work: ${idle.join(', ')}.` : ''} Give the work to one of them, or send one home with dismiss_agent first.`
    }
    const own = this.agentsOf(chat, by)
    // In Ultra the lead may fill the whole chat's cap; anyone below it starts a few helpers at most.
    const perAgent = this.perAgent(chat, by)
    if (own.length >= perAgent) {
      const idle = own.filter((a) => !this.sessions.get(`${chat.id}:${a.id}`)?.busy).map((a) => a.name)
      return `You already have ${own.length} agents of your own, the most one agent may start.${idle.length ? ` Free right now: ${idle.join(', ')}.` : ''} Give the work to one of them, or send one home with dismiss_agent first.`
    }
    const role = truncate((args.role || '').trim().replace(/\s+/g, ' '), 160)
    if (!role) return 'Say what the agent is for in role, in a few words: it is what the rest of the team knows it by.'

    // Whose sign-in it works on: the account named, or the one with the most allowance to spare.
    const asked = (args.account || '').trim()
    let base: Account | null | undefined
    if (asked && !/^(auto|any|anyone)$/i.test(asked)) {
      const named = this.accounts.byName(asked, chat.id)
      base = named ? this.accounts.get(this.accounts.baseId(named.id)) : undefined
      if (!base || base.spawned || !base.enabled) return `There is no account called "${asked}". Call roster to see the accounts, or leave account out to have the best one picked.`
      if (this.accounts.statuses.get(base.id)?.state !== 'ready') return `${base.name} is not signed in right now. Leave account out to have the best one picked.`
      const until = this.accounts.limitedUntil(base.id)
      if (until) return `${base.name} has no usage allowance left until ${clock(until)}. Leave account out to have the best one picked.`
    } else {
      // A model named by family ("luna", "astra", "haiku") says which provider's account it needs.
      const m = (args.model || '').trim()
      const provider = this.providerOfModel(m)
      // Claude accounts do the building; with none to spare (a ChatGPT-only team), any account will do.
      base =
        this.pick(chat, { exclude: [], provider: provider || 'claude', wantsTop: this.isTop(m), roomy: true }) ||
        (provider ? null : this.pick(chat, { exclude: [], roomy: true })) ||
        this.pick(chat, { exclude: [], provider: provider || 'claude', wantsTop: this.isTop(m) }) ||
        (provider ? null : this.pick(chat, { exclude: [] }))
      if (!base && provider) {
        const has = this.accounts.accounts.some((a) => a.enabled && a.provider === provider)
        return has
          ? `No ${provider === 'claude' ? 'Claude' : 'ChatGPT'} account can take on another agent right now (signed out or out of allowance). Name a model of another provider, or leave model out.`
          : `The team has no ${provider === 'claude' ? 'Claude' : 'ChatGPT'} account, so "${m}" cannot run here. Call roster for the models the team has, or leave model out.`
      }
      if (!base) return 'No account can take on another agent right now (signed out or out of allowance). Do this yourself, or tell the user.'
    }
    const how = this.runFor(base, args.model, args.effort)
    if (typeof how === 'string') return how

    // A name nobody else in the chat has.
    const taken = new Set([...this.accounts.accounts, ...(chat.agents || [])].map((a) => a.name.toLowerCase()))
    let name = truncate((args.name || '').trim().replace(/\s+/g, ' ').replace(/[<>"]/g, ''), 28) || SPARE_NAMES.find((n) => !taken.has(n.toLowerCase())) || 'Agent'
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name.replace(/ \d+$/, '')} ${n}`
    const used = new Set(this.teamOf(chat).map((a) => a.accent))
    const agent: Account = {
      id: `${slugify(name)}-${uid().slice(0, 6)}`,
      name,
      provider: base.provider,
      configDir: base.configDir,
      accent: ACCENTS.find((c) => !used.has(c)) || ACCENTS[(chat.agents || []).length % ACCENTS.length],
      model: null,
      effort: null,
      role,
      enabled: true,
      createdAt: Date.now(),
      spawned: { chatId: chat.id, base: base.id, by: by.id, depth: depth + 1, at: Date.now() },
    }
    chat.agents = [...(chat.agents || []), agent]
    this.accounts.register(agent)
    this.saveChats()
    this.emit({ type: 'chat', chat })
    this.session(chat, by).add({ id: uid('w'), kind: 'spawn', ts: Date.now(), agentId: agent.id, name, role, base: base.id })

    const where = base.id === this.accounts.baseId(by.id) ? 'your own account' : `${base.name}'s account`
    const started = `${name} has joined the chat, working on ${where}.`
    const brief = (args.brief || '').trim()
    if (!brief) return `${started} Hand them work with assign_task (to: "${name}"). They know nothing yet about what you are doing.`
    const handed = this.assign(chat, by, { to: name, title: args.title || role, brief, model: args.model, effort: args.effort, after: args.after })
    return `${started} ${handed}`
  }

  /** A wait in the engine's own time: stretched or squeezed with the demo team's speed in demo mode, unchanged otherwise. */
  wait(ms: number): number {
    return demoTime(ms, this.host.demo)
  }

  /** Looks for idle agents in an Ultra chat after `ms`. */
  private sweepSoon(chat: Chat, ms = this.wait(IDLE_AGENT_MS)): void {
    clearTimeout(this.sweeps.get(chat.id))
    this.sweeps.set(
      chat.id,
      setTimeout(() => {
        this.sweeps.delete(chat.id)
        void this.sweepIdle(chat)
      }, ms),
    )
  }

  /**
   * Sends home the agents in an Ultra chat that have sat idle for a few minutes with nothing handed
   * to them or by them, so they stop holding the agent cap and keeping processes alive.
   */
  async sweepIdle(chat: Chat, idleMs = this.wait(IDLE_AGENT_MS)): Promise<string[]> {
    if (!this.chats.has(chat.id) || !this.ultraOf(chat)) return []
    const open = this.tasksOf(chat.id).filter((t) => t.status === 'running' || t.status === 'queued')
    const now = Date.now()
    const sent: string[] = []
    let soonest = Infinity
    for (const a of [...(chat.agents || [])]) {
      if (!a.spawned || a.spawned.gone) continue
      const s = this.sessions.get(`${chat.id}:${a.id}`)
      if (s?.busy || s?.state.queued || open.some((t) => t.to === a.id || t.from === a.id)) continue
      const idle = now - (s?.idleSince ?? a.spawned.at)
      if (idle < idleMs) {
        soonest = Math.min(soonest, idleMs - idle)
        continue
      }
      await this.removeAgent(chat.id, a.id)
      sent.push(a.name)
    }
    const lead = this.lead(chat)
    if (sent.length && lead) {
      this.session(chat, lead).add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `Sent ${sent.join(', ')} home after a few minutes idle, to make room for more agents.` })
    }
    if (soonest < Infinity) this.sweepSoon(chat, soonest + 1000)
    return sent
  }

  /** Sends an agent that was started inside a chat home. Its work stops; what it did stays readable. */
  async removeAgent(chatId: string, agentId: string, by?: Account): Promise<string> {
    const chat = this.need(chatId)
    const agent = (chat.agents || []).find((a) => a.id === agentId)
    if (!agent?.spawned) return 'There is no such agent in this chat.'
    if (agent.spawned.gone) return `${agent.name} was already sent home.`
    if (by && this.lead(chat)?.id !== by.id && agent.spawned.by !== by.id) return `${agent.name} was started by someone else. Only they or the lead can send it home.`
    // Anyone it started goes first.
    for (const sub of this.agentsOf(chat, agent)) await this.removeAgent(chatId, sub.id)
    const s = this.sessions.get(`${chatId}:${agentId}`)
    for (const t of this.tasksOf(chatId)) {
      if (t.to !== agentId || (t.status !== 'queued' && t.status !== 'running')) continue
      if (t.status === 'queued') s?.dequeueTask(t.id)
      this.setTask(t, 'cancelled', `${agent.name} was sent home before this finished.`)
      if (by?.id !== t.from) this.reportBack(t)
    }
    if (s) {
      this.hands.release(s)
      await s.stop()
      s.recycle()
      this.toolServer.unregister(s.key)
      this.dropWaiting(s.key)
    }
    agent.spawned.gone = true
    this.saveChats()
    this.emit({ type: 'chat', chat })
    return `${agent.name} was sent home.`
  }

  // ----- long memory in the vault -----

  /** The words of a request worth searching for: no filler, the longest and rarest first. */
  private keywords(text: string): string {
    const STOP = new Set(
      'the and for with that this from have will your you are was were can into about what when where which then than them they their there here just make made want need like also please could would should some more most very much many only over such each other those these does done been being its our out get got let use using want how why who all any but not now new one two way look see sure thing things kind really still even good best better'.split(' '),
    )
    const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) || []).filter((w) => !STOP.has(w) && !/^\d+$/.test(w))
    return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 7).join(' ')
  }

  /**
   * Notes in the vault that bear on a request, put in front of the agent before it starts, so
   * what the team learned in earlier chats is there without anyone having to remember to look.
   */
  private recall(text: string, limit = 5): string {
    const v = this.vault?.exists ? this.vault : null
    if (!v || !this.settings.recall) return ''
    const q = this.keywords(text)
    if (!q) return ''
    let hits: VaultHit[] = []
    try {
      hits = v.search(q, { limit })
    } catch {
      return ''
    }
    if (!hits.length) return ''
    return `<recalled from="${esc(v.name)}">\nNotes in the user's vault that may bear on this, found by searching for: ${q}. They are reference material from earlier work. Read the ones that matter with vault_read before relying on them, and ignore the rest.\n${hits.map((h) => `- ${h.path}${h.updated ? ` (updated ${h.updated})` : ''}: ${truncate(h.snippet.replace(/\s+/g, ' '), 220)}`).join('\n')}\n</recalled>\n\n`
  }

  /** Brings a chat's vault note up to date a little after the work goes quiet, so a busy chat is written once, not after every reply. */
  private noteSoon(chat: Chat): void {
    if (!this.settings.chatNotes || !this.vault?.exists || this.host.demo) return
    clearTimeout(this.noteTimers.get(chat.id))
    this.noteTimers.set(
      chat.id,
      setTimeout(() => {
        this.noteTimers.delete(chat.id)
        try {
          this.writeChatNote(chat)
        } catch (e) {
          console.error('[chat note]', (e as Error).message)
        }
      }, 60_000),
    )
  }

  /**
   * A note of what a chat was about, kept in the vault under Ensemble/Chats: what was asked,
   * what came of it, who did what, what was agreed and which files changed. Written from the
   * record, with no model involved, so it costs nothing. Later chats find it through recall.
   */
  private writeChatNote(chat: Chat): void {
    const v = this.vault?.exists ? this.vault : null
    if (!v || !this.chats.has(chat.id)) return
    const lead = this.lead(chat)
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const asked: string[] = []
    let outcome = ''
    let words = 0
    const files = new Set<string>()
    const team = new Set<string>()
    for (const s of this.sessionsOf(chat.id)) {
      for (const it of s.items) {
        if (it.kind === 'assistant') {
          words += it.text.length
          team.add(s.account.name)
          if (s.account.id === lead?.id && it.text.trim()) outcome = it.text.trim()
        } else if (it.kind === 'user' && s.account.id === lead?.id && it.text.trim()) asked.push(truncate(it.text.trim().replace(/\s+/g, ' '), 300))
        else if (it.kind === 'tool' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(it.name)) {
          const p = (it.input as Record<string, unknown> | undefined)?.file_path
          if (typeof p === 'string') files.add(p)
        }
      }
    }
    // Small talk is not worth a note.
    if (!asked.length || words < 600) return
    const tasks = this.tasksOf(chat.id)
    const board = this.boardOf(chat.id)
    const day = new Date(chat.createdAt).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    const folder = chat.folderId ? this.folders.find((f) => f.id === chat.folderId)?.name : undefined
    const safe = chat.title.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Chat'
    const rel = chat.memoryNote || `Ensemble/Chats/${day} ${safe}.md`
    const yaml = (s: string): string => JSON.stringify(s)
    const body = [
      '---',
      'type: chat',
      'source: ensemble',
      `chat: ${chat.id}`,
      folder ? `folder: ${yaml(folder)}` : '',
      `project: ${yaml(path.basename(chat.cwd))}`,
      `team: [${[...team].map(yaml).join(', ')}]`,
      `created: ${day}`,
      `updated: ${today}`,
      '---',
      '',
      `# ${chat.title}`,
      '',
      `Worked in \`${chat.cwd}\`${lead ? `, led by ${lead.name}` : ''}.`,
      '',
      '## What was asked',
      ...asked.slice(-10).map((a) => `- ${a}`),
      '',
      '## Where it ended',
      truncate(outcome, 3000) || '(no answer yet)',
      ...(chat.goal ? ['', '## Goal', `- ${truncate(chat.goal.text.replace(/\s+/g, ' '), 300)}${chat.goal.doneWhen ? ` (done when: ${truncate(chat.goal.doneWhen, 200)})` : ''}`, `- ${chat.goal.status === 'met' ? 'Met' : chat.goal.status === 'stopped' ? 'Stopped before it was met' : chat.goal.status === 'blocked' ? 'Waiting on the user' : chat.goal.status === 'paused' ? 'Paused' : 'Under way'} after ${chat.goal.round + 1} ${chat.goal.round ? 'rounds' : 'round'}${chat.goal.note ? `: ${truncate(chat.goal.note.replace(/\s+/g, ' '), 300)}` : ''}`] : []),
      ...(tasks.length ? ['', '## Work handed out', ...tasks.slice(-30).map((t) => `- ${t.title} (${name(t.to)}${t.ranOn ? `, ${familyOf(t.ranOn)?.name || t.ranOn}` : ''}): ${t.status}`)] : []),
      ...(board.length ? ['', '## Agreed', ...board.map((b) => `- **${b.title}**: ${truncate(b.text.replace(/\s+/g, ' '), 300)}`)] : []),
      ...(files.size ? ['', '## Files changed', ...[...files].slice(-30).map((f) => `- \`${f}\``)] : []),
      '',
    ]
      .filter((l, i, all) => (l !== '' || all[i - 1] !== '') && !(l === '' && all.indexOf('---', 1) > i))
      .join('\n')
    const full = v.absolute(rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const tmp = `${full}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, full)
    v.noted(rel)
    if (chat.memoryNote !== rel) {
      chat.memoryNote = rel
      this.saveChats()
    }
    this.writeTeamMemory()
  }

  /** The team notebook, mirrored into the vault so it is searchable and readable next to everything else. */
  private writeTeamMemory(): void {
    const v = this.vault?.exists ? this.vault : null
    if (!v || !this.settings.chatNotes || !this.memory.notes.length) return
    const name = (id: string): string => (id === 'you' ? 'you' : this.accounts.get(id)?.name || id)
    const body = ['---', 'type: memory', 'source: ensemble', `updated: ${new Date().toISOString().slice(0, 10)}`, '---', '', '# Team memory', '', 'Standing facts the Ensemble team keeps between chats. Edit them in Ensemble (Knowledge); changes here are overwritten.', '', ...this.memory.notes.map((n) => `- **${n.title}**: ${n.body.replace(/\s+/g, ' ')} _(${name(n.author)}, ${new Date(n.updatedAt).toISOString().slice(0, 10)})_`), ''].join('\n')
    const full = v.absolute('Ensemble/Team memory.md')
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body, 'utf8')
    v.noted('Ensemble/Team memory.md')
  }

  setupStatus(): SetupStatus {
    return setupStatus(this.host.demo, this.settings.claudePath)
  }

  /** Installs Claude Code, then re-checks every Claude account, which may have been waiting for it. */
  async installClaude(): Promise<boolean> {
    const ok = await installClaude((ev) => this.emit(ev), this.host.demo, this.settings.claudePath)
    if (ok) void this.accounts.refresh()
    return ok
  }

  /** A fresh vault for the team, for people who do not keep one yet. */
  createVault(): VaultInfo | null {
    // Demo mode never writes into the person's real Documents.
    const parent = this.host.demo ? this.dataDir : path.join(os.homedir(), 'Documents')
    let root = path.join(parent, 'Ensemble Vault')
    for (let n = 2; fs.existsSync(root) && fs.readdirSync(root).length; n++) root = path.join(parent, `Ensemble Vault ${n}`)
    fs.mkdirSync(path.join(root, 'Ensemble', 'Chats'), { recursive: true })
    fs.mkdirSync(path.join(root, 'Projects'), { recursive: true })
    fs.mkdirSync(path.join(root, 'Knowledge'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      '# Guide for agents\n\nThis vault is the long-term memory of an Ensemble team.\n\n- `Projects/`: one note per project: what it is, how it is built and run, decisions and why, open questions.\n- `Knowledge/`: research and facts worth keeping, with sources and dates.\n- `Ensemble/Chats/`: written by the app after each chat. Read them; do not edit them.\n- Extend the note that already covers a topic instead of starting a near-duplicate, and link related notes with [[links]].\n',
      'utf8',
    )
    const start = path.join(root, 'Start here.md')
    if (!fs.existsSync(start)) {
      fs.writeFileSync(
        start,
        "# Start here\n\nThis is your Ensemble team's memory. It is a plain folder of Markdown notes, so you can read and edit it in [Obsidian](https://obsidian.md) (free): choose **Open folder as vault** and pick this folder.\n\n- Before your team starts on a request, Ensemble looks here for notes that matter and hands them to the agents.\n- After each substantial chat, a note about it lands in `Ensemble/Chats/`, so the next chat picks up where the last one ended.\n- Write your own notes in `Projects/` and `Knowledge/`: how you like things done, facts about your work, decisions. Your team reads them.\n",
        'utf8',
      )
    }
    this.updateSettings({ vaultPath: root, vaultNotes: 'auto' })
    return this.vaultInfo()
  }

  // ----- connectors -----

  connectorViews(): ConnectorView[] {
    return this.connectors.views()
  }

  connectorsFound(): FoundConnector[] {
    // A demo never reads the real apps on this computer.
    if (this.host.demo) return []
    const have = new Set(this.connectors.all().map((c) => `${c.slug}|${c.spec.url || c.spec.command || ''}`))
    return findConnectors(this.accounts.accounts).map((f) => ({ ...f, added: have.has(`${f.slug}|${f.spec.url || f.spec.command || ''}`) }))
  }

  /** What every agent is told, and which tools it holds, changes with the connectors: they start fresh with their next turn. */
  private retool(): void {
    for (const s of this.sessions.values()) s.recycle()
  }

  connectorSave(input: ConnectorInput): ConnectorView {
    const c = this.connectors.put(input)
    this.retool()
    return this.connectors.views().find((v) => v.id === c.id) as ConnectorView
  }

  connectorRemove(id: string): void {
    this.connectors.remove(id)
    this.retool()
  }

  /** The service's own sign-in page opens in the browser; once signed in, agents get the connector with their next turn. */
  async connectorSignIn(id: string): Promise<ConnectorTest> {
    const result = await this.connectors.signIn(id)
    this.retool()
    return result
  }

  connectorSignOut(id: string): void {
    this.connectors.signOut(id)
    this.retool()
  }

  // ----- the team board -----

  private boardOf(chatId: string): BoardNote[] {
    let list = this.boards.get(chatId)
    if (!list) {
      list = readJson<BoardNote[]>(path.join(this.dataDir, 'chats', chatId, 'board.json'), [])
      this.boards.set(chatId, list)
    }
    return list
  }

  /** Pins something every agent in the chat should work from. Reusing a title replaces that note. */
  private boardPost(chat: Chat, by: Account, args: { title: string; text: string }): string {
    const title = truncate((args.title || '').trim().replace(/\s+/g, ' '), 80)
    const text = truncate((args.text || '').trim(), 6000)
    if (!title || !text) return 'A board note needs a title and the text to pin.'
    const list = this.boardOf(chat.id)
    const had = list.find((n) => n.title.toLowerCase() === title.toLowerCase())
    if (had) Object.assign(had, { text, author: by.id, ts: Date.now() })
    else list.push({ id: `b${list.length + 1}`, title, text, author: by.id, ts: Date.now() })
    if (list.length > 40) list.splice(0, list.length - 40)
    writeJson(path.join(this.dataDir, 'chats', chat.id, 'board.json'), list)
    return `${had ? 'Updated' : 'Pinned'} "${title}" on the team board. Everyone in this chat sees it with their next task and can read it with board_read.`
  }

  private boardText(chat: Chat): string {
    const list = this.boardOf(chat.id)
    if (!list.length) return 'The team board is empty.'
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    return list.map((n) => `## ${n.title}\n(${name(n.author)}, ${ago(n.ts)})\n${n.text}`).join('\n\n')
  }

  /** What is pinned, in one line, to go with a task so the agent knows to look. */
  private boardHint(chat: Chat): string {
    const list = this.boardOf(chat.id)
    if (!list.length) return ''
    return `\n\nPinned on the team board (read with board_read before you start): ${list.map((n) => `"${n.title}"`).join(', ')}.`
  }

  // ----- chats brought in from Claude Code -----

  /** What was said in a conversation that was brought in as a summary, for the lead's first message in it. */
  private importDigest(session: AgentSession): string {
    const lines: string[] = []
    for (const it of session.items) {
      if (it.kind === 'user' && it.text.trim()) lines.push(`User: ${truncate(it.text.trim(), 1500)}`)
      else if (it.kind === 'assistant' && it.text.trim()) lines.push(`Assistant: ${truncate(it.text.trim(), 2000)}`)
    }
    if (!lines.length) return ''
    // The most recent part matters most when the conversation is long.
    const kept: string[] = []
    let used = 0
    for (let i = lines.length - 1; i >= 0 && used + lines[i].length < 14000; i--) {
      kept.unshift(lines[i])
      used += lines[i].length
    }
    if (kept.length < lines.length) kept.unshift(`(${lines.length - kept.length} earlier entries left out)`)
    return `<imported-conversation from="Claude Code">\nThis chat was brought in from a Claude Code conversation the user had earlier in this folder. You were not in it, so this is what was said, oldest first. File changes made back then are on disk. Carry on from here without asking the user to repeat anything.\n\n${kept.join('\n\n')}\n</imported-conversation>\n\n`
  }

  importScan(): ImportScan {
    if (this.host.demo) return { found: false, sections: [], loose: [] }
    const have = new Set([...this.chats.values()].map((c) => c.imported?.sessionId).filter(Boolean))
    const found = scanClaudeCode()
    const view = (s: FoundSession) => ({ id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt, resumable: !!s.transcript && exists(s.cwd), imported: have.has(s.id) })
    return {
      found: found.found,
      sections: found.sections.map((sec) => ({ id: sec.id, name: sec.name, sessions: sec.sessions.map(view) })),
      loose: found.loose.map(view),
    }
  }

  /**
   * Brings conversations in from the Claude desktop app: each becomes a chat with its history
   * on show, filed under a folder named after its section there. `mode` 'continue' has the
   * lead carry on in a copy of the very conversation; 'summary' tells it what was said instead.
   */
  importRun(ids: string[], mode: 'continue' | 'summary' = 'continue'): ImportResult {
    const want = new Set(ids)
    const have = new Set([...this.chats.values()].map((c) => c.imported?.sessionId).filter(Boolean))
    const found = scanClaudeCode()
    const result: ImportResult = { chats: 0, folders: 0, skipped: 0 }
    const lead = this.lead()
    const bring = (s: FoundSession, folderId: string | null): void => {
      if (!want.has(s.id)) return
      if (have.has(s.id)) {
        result.skipped++
        return
      }
      const now = Date.now()
      const here = exists(s.cwd)
      // The conversation itself lives in one account's folder: whoever holds it carries it on.
      const owner = s.transcript ? this.accounts.accounts.find((a) => a.enabled && a.provider === 'claude' && (a.configDir || this.accounts.defaultDir('claude')).toLowerCase() === s.transcript!.configDir.toLowerCase()) : undefined
      const resumed = mode === 'continue' && here && !!owner && !!s.cliSessionId
      const keeper = resumed ? owner : lead
      const chat: Chat = {
        id: uid('c'),
        title: truncate(s.title || 'Imported chat', 80),
        titleLocked: true,
        cwd: here ? s.cwd : os.homedir(),
        createdAt: s.createdAt || now,
        updatedAt: s.updatedAt || now,
        permission: this.settings.defaultPermission,
        sessions: resumed && owner ? { [owner.id]: { providerSessionId: s.cliSessionId, fork: true } } : {},
        folderId,
        leadId: keeper && keeper.id !== lead?.id ? keeper.id : null,
        imported: { from: 'claude-code', sessionId: s.id, resumed, at: now },
      }
      const items = s.transcript ? importTranscript(s.transcript.file) : []
      const last = [...items].reverse().find((i) => i.kind === 'assistant' || i.kind === 'user')
      if (last && 'text' in last) chat.snippet = truncate(last.text.replace(/\s+/g, ' ').trim(), 140)
      items.push({
        id: uid('n'),
        kind: 'notice',
        ts: chat.updatedAt,
        level: 'info',
        text: resumed
          ? `Brought in from Claude Code. ${keeper?.name || 'The lead'} carries on in a copy of this conversation and remembers all of it. The original in Claude Code is not touched.`
          : `Brought in from Claude Code. ${keeper?.name || 'The lead'} was not in this conversation, so it is told what was said with your first message here.`,
      })
      items.push({ id: uid('e'), kind: 'turn', ts: chat.updatedAt, status: 'done', durationMs: 0 })
      if (keeper) writeJson(path.join(this.dataDir, 'chats', chat.id, `${keeper.id}.json`), items)
      this.chats.set(chat.id, chat)
      have.add(s.id)
      this.emit({ type: 'chat', chat })
      result.chats++
    }
    for (const sec of found.sections) {
      if (!sec.sessions.some((s) => want.has(s.id) && !have.has(s.id))) {
        result.skipped += sec.sessions.filter((s) => want.has(s.id)).length
        continue
      }
      let folder = this.folders.find((f) => f.source === sec.id) || this.folders.find((f) => f.name.toLowerCase() === sec.name.toLowerCase())
      if (!folder) {
        folder = this.createFolder(sec.name, sec.id)
        result.folders++
      }
      for (const s of sec.sessions) bring(s, folder.id)
    }
    for (const s of found.loose) bring(s, null)
    this.saveChats()
    return result
  }

  // ----- changing who leads a chat -----

  /**
   * Text that brings a new lead up to date, given once with whatever reaches
   * them first after the change. Empty when there is nothing to hand over.
   */
  private catchUp(chat: Chat, account: Account): string {
    const h = chat.handoff
    if (!h || this.lead(chat)?.id !== account.id) return ''
    chat.handoff = null
    this.saveChats()
    const from = this.accounts.get(h.from)
    if (!from || from.id === account.id) return ''
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const old = this.session(chat, from)
    const lines: string[] = []
    let reply = ''
    for (const it of old.items) {
      if (it.kind === 'user' && it.text.trim()) lines.push(`User: ${truncate(it.text.trim(), 1500)}`)
      else if (it.kind === 'assistant' && it.text.trim()) reply = it.text.trim()
      else if (it.kind === 'delegate') lines.push(`${from.name} gave ${name(it.to)} the task "${it.title}".`)
      else if (it.kind === 'peer' && it.tag === 'result') lines.push(`${name(it.from)} reported on "${it.title || 'a task'}" (${it.status || 'done'}): ${truncate(it.text.trim(), 700)}`)
      else if (it.kind === 'turn' && reply) {
        lines.push(`${from.name}: ${truncate(reply, 2000)}`)
        reply = ''
      }
    }
    // Keep the most recent part when the chat is long.
    const kept: string[] = []
    let used = 0
    for (let i = lines.length - 1; i >= 0 && used + lines[i].length < 9000; i--) {
      kept.unshift(lines[i])
      used += lines[i].length
    }
    if (kept.length < lines.length) kept.unshift(`(${lines.length - kept.length} earlier entries left out)`)
    const open = this.tasksOf(chat.id).filter((t) => t.status === 'running' || t.status === 'queued')
    const tasks = open.length
      ? `\n\nTasks still out (their reports now come to you):\n${open.map((t) => `- ${t.id} · ${t.status} · ${name(t.to)} · ${t.title}`).join('\n')}`
      : ''
    const why = h.reason === 'limit' ? `${from.name} led it until now and has run out of usage allowance` : `${from.name} led it until now`
    return `<handoff from="${esc(from.name)}">\nYou now lead this chat. ${why}. This is what happened so far, oldest first, so you can carry on without asking the user to repeat anything. File changes already made are on disk in the working folder.\n\n${kept.join('\n\n') || '(nothing was said yet)'}${tasks}\n</handoff>\n\n`
  }

  /**
   * `auto`: the app is doing this by itself because the old lead ran out of usage (or is about to).
   * A goal under way then carries on with the new lead, loops move with it, and the chat gets one
   * handover line instead of the usual notes.
   */
  async setChatLead(id: string, accountId: string, retry = false, auto?: { why: 'out' | 'low'; until: number | null }): Promise<Chat> {
    const chat = this.need(id)
    const next = this.accounts.get(accountId)
    if (!next || !next.enabled) throw new Error('That teammate is not on the team.')
    if (!this.accounts.isReady(next.id)) throw new Error(`${next.name} is not signed in.`)
    const prev = this.lead(chat)
    if (prev?.id === next.id) return chat
    // What was waiting for the old lead (reports, notes, a message it never got to) goes to the new one.
    let moved: Waiting[] = []

    if (prev) {
      // A goal under way waits for the user rather than going on with a lead in the middle of changing,
      // unless the app is the one changing it: then the goal and loops carry on with the new lead.
      this.auto.leadChanged(chat, next, auto ? prev : undefined)
      const old = this.sessions.get(`${id}:${prev.id}`)
      if (old?.busy) await old.stop()
      moved = this.takeEntries(chat, prev)
      for (const w of moved) for (const itemId of w.itemIds) old?.patch(itemId, { queued: false })
      // Offers to switch that were on screen have been taken.
      for (const it of old?.items || []) {
        if (it.kind === 'notice' && it.action && !it.action.done) old?.patch(it.id, { action: { ...it.action, done: true } })
      }
      // Work already handed out reports to whoever leads now.
      for (const t of this.tasksOf(id)) {
        if (t.from === prev.id && (t.status === 'running' || t.status === 'queued')) {
          t.from = next.id
          this.commitTask(t)
        }
      }
      const talked = (old?.items.length || 0) > 0
      chat.handoff = talked ? { from: prev.id, reason: retry || auto ? 'limit' : 'manual' } : null
    }
    chat.leadId = next.id === this.lead()?.id ? null : next.id
    this.dryOffer.delete(id)
    const row = auto && prev ? uid('n') : null
    chat.cover = row && prev && auto ? { from: prev.id, to: next.id, at: Date.now(), why: auto.why, until: auto.until, itemId: row } : null
    // Roles and tools differ between lead and teammate, so everyone restarts in their new one.
    for (const s of this.sessionsOf(id)) s.recycle()
    this.saveChats()
    this.emit({ type: 'chat', chat })

    const s = this.session(chat, next)
    if (row && prev && auto) {
      s.add({ id: row, kind: 'notice', ts: Date.now(), level: 'info', text: handoverLine(next.name, prev.name, auto.why, auto.until, clock), handover: { from: prev.id, to: next.id, why: auto.why, until: auto.until } })
    } else s.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: prev ? `${next.name} now leads this chat, taking over from ${prev.name}.` : `${next.name} now leads this chat.` })
    if (moved.length) {
      const user = moved.some((w) => w.user)
      const n = moved.reduce((k, w) => k + Math.max(1, w.itemIds.length), 0)
      const was = auto && prev ? this.sessions.get(`${id}:${prev.id}`) : undefined
      if (was) for (const w of moved) if (w.user) this.carryAsked(was, s, w.itemIds)
      if (!auto) s.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: `Passed on what was waiting for ${prev?.name || 'the old lead'}: ${n} ${n === 1 ? 'message or report' : 'messages and reports'}.` })
      s.enqueue({
        kind: user ? 'user' : 'team',
        text: `${this.catchUp(chat, next)}${moved.map((w) => w.text).join('\n\n')}`,
        origin: user ? { kind: 'human' } : { kind: 'peer', name: prev?.name || 'the team' },
        itemIds: [],
      })
    } else if (retry && prev) {
      const text = this.sessions.get(`${id}:${prev.id}`)?.lastUserText()
      if (text) this.send({ chatId: id, to: next.id, text })
    }
    return chat
  }

  rewind(chatId: string, accountId: string, turnId: string, apply: boolean): Promise<RewindPreview> {
    const chat = this.need(chatId)
    const account = this.accounts.get(accountId)
    if (!account) throw new Error('That teammate is no longer on the team.')
    return this.session(chat, account).rewind(turnId, apply)
  }

  private deliver(chat: Chat, from: Account, args: { to: string; text: string }): string {
    // A note for everyone goes to each teammate in the chat who is signed in.
    if (EVERYONE.test((args.to || '').trim())) {
      const all = this.teamOf(chat).filter((a) => a.id !== from.id && this.accounts.statuses.get(a.id)?.state === 'ready')
      if (!all.length) return 'Nobody else is in this chat.'
      const sent = all.filter((a) => /^(Delivered|Left)/.test(this.deliver(chat, from, { to: a.id, text: args.text }))).map((a) => a.name)
      return sent.length ? `Sent to ${sent.join(', ')}. Something the whole team must keep working from is better pinned with board_post, where it stays.` : 'The note could not be delivered to anyone right now.'
    }
    const to = this.accounts.byName(args.to, chat.id)
    if (!to || !to.enabled || to.spawned?.gone) return `There is no teammate called "${args.to}". Call roster to see who is on the team.`
    if (to.id === from.id) return 'That is you.'
    if (this.accounts.statuses.get(to.id)?.state !== 'ready') return `${to.name} is not available right now.`
    const text = args.text.trim()
    if (!text) return 'The message is empty.'

    // Two agents politely replying to each other forever would burn through
    // both allowances, so chatter per chat is capped.
    const now = Date.now()
    const recent = (this.chatter.get(chat.id) || []).filter((t) => now - t < 10 * 60 * 1000)
    if (recent.length >= 30) return 'The team has exchanged a lot of messages in the last few minutes. Hold this one and get on with the work.'
    recent.push(now)
    this.chatter.set(chat.id, recent)

    this.session(chat, from).add({ id: uid('o'), kind: 'outgoing', ts: now, to: to.id, text })
    const target = this.session(chat, to)
    const item: Item = { id: uid('g'), kind: 'peer', ts: now, from: from.id, tag: 'message', text, queued: target.busy }
    const dry = this.accounts.limitedUntil(to.id)
    if (dry) {
      item.queued = true
      target.add(item)
      this.holdDry(chat, to, { text: `<team-message from="${esc(from.name)}">\n${text}\n</team-message>`, itemIds: [item.id] }, dry)
      return `Left for ${to.name}, who has no usage allowance left until ${clock(dry)}. They read it then${this.lead(chat)?.id === to.id ? ', or whoever takes over as lead reads it' : ''}.`
    }
    if (this.settings.lightTalk && !target.busy) {
      // Reading a note is not work. It waits for whatever reaches them next rather than costing a reply of its own.
      item.queued = true
      target.add(item)
      this.hold(chat, to, { text: `<team-message from="${esc(from.name)}">\n${text}\n</team-message>`, itemIds: [item.id] })
      return `Left for ${to.name}. They are not in the middle of anything, so they will read it with the next thing that reaches them.`
    }
    target.add(item)
    target.enqueue({
      kind: 'team',
      text: `<team-message from="${esc(from.name)}">\n${text}\n</team-message>`,
      origin: { kind: 'peer', name: from.name },
      itemIds: [item.id],
    })
    return `Delivered to ${to.name}.${target.busy ? ' They will read it when their current work ends.' : ''}`
  }

  /** Puts a question to a teammate and waits for their answer, which comes back as the tool's result. */
  private consult(chat: Chat, from: Account, args: { to: string; question: string; depth?: string }): Promise<string> | string {
    const to = this.accounts.byName(args.to || '', chat.id)
    if (!to || !to.enabled || to.spawned?.gone) return `There is no teammate called "${args.to}". Call roster to see who is on the team.`
    if (to.id === from.id) return 'That is you.'
    if (this.accounts.statuses.get(to.id)?.state !== 'ready') return `${to.name} is not available right now.`
    const until = this.accounts.limitedUntil(to.id)
    if (until) return `${to.name} has no usage allowance left until ${clock(until)}. Ask someone else, or decide it yourself and say what you assumed.`
    const text = (args.question || '').trim()
    if (!text) return 'The question is empty.'
    const me = `${chat.id}:${from.id}`
    const them = `${chat.id}:${to.id}`
    // No circles: if they are waiting on you (directly or through others), asking them back leaves everyone waiting.
    for (let k: string | undefined = them, hops = 0; k && hops < 8; k = this.asking.get(k), hops++) {
      if (k === me) return `${to.name} is waiting on an answer from you right now, so asking them back would leave you both waiting. Answer them first, or decide this yourself.`
    }
    const now = Date.now()
    const recent = (this.chatter.get(chat.id) || []).filter((t) => now - t < 10 * 60 * 1000)
    if (recent.length >= 30) return 'The team has exchanged a lot of messages in the last few minutes. Decide this one yourself and say what you assumed.'
    recent.push(now)
    this.chatter.set(chat.id, recent)

    const asker = this.session(chat, from)
    const target = this.session(chat, to)
    const card: Item = { id: uid('k'), kind: 'ask', ts: now, to: to.id, text, status: 'waiting' }
    asker.add(card)
    asker.note(`Waiting for ${to.name}'s answer`)
    const item: Item = { id: uid('g'), kind: 'peer', ts: now, from: from.id, tag: 'question', text, queued: target.busy }
    target.add(item)
    this.asking.set(me, them)
    // A quick question does not need the teammate's heaviest model. A careful one does.
    const light = this.settings.lightTalk && args.depth !== 'careful' ? this.lightModel(to) : undefined
    const run = light ? this.fits(to, target, { model: light }) : undefined
    const pre = this.takeWaiting(chat, to)
    return new Promise<string>((resolve) => {
      let settled = false
      const finish = (answer: string, ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.asking.get(me) === them) this.asking.delete(me)
        asker.patch(card.id, { status: ok ? 'answered' : 'failed', answer: truncate(answer, 12000), durationMs: Date.now() - now })
        resolve(ok ? `<answer from="${esc(to.name)}">\n${answer}\n</answer>` : answer)
      }
      const timer = setTimeout(() => finish(`${to.name} has not answered after ${Math.round(ASK_WAIT_MS / 60000)} minutes and may be deep in other work. Carry on with your best judgment and say what you assumed.`, false), this.wait(ASK_WAIT_MS))
      target.enqueue(
        {
          kind: 'ask',
          text: `${pre.text}<question from="${esc(from.name)}">\n${text}\n</question>\n\n${from.name} has paused their work to wait for your answer. Answer directly and briefly, from what you know or can check quickly: your reply goes back to them exactly as you write it. This is a question, not a task, so do not start other work for it.`,
          origin: { kind: 'peer', name: from.name },
          itemIds: [...pre.itemIds, item.id],
          run: run?.model ? run : undefined,
          onDone: (ev) =>
            ev.status === 'done' && ev.resultText.trim()
              ? finish(ev.resultText.trim(), true)
              : finish(`${to.name} could not answer${ev.reason === 'limit' ? ' (out of allowance)' : ev.status === 'interrupted' ? ' (they were stopped)' : ''}. Carry on with your best judgment and say what you assumed.`, false),
        },
        // A question goes ahead of work that has not started: someone is standing still for it.
        true,
      )
    })
  }

  async cancelTask(chatId: string, taskId: string, byUser = true, by?: Account): Promise<string> {
    const task = this.findTask(chatId, taskId)
    if (!task) return `There is no task ${taskId}.`
    // Someone who is not the lead stops only what they handed out themselves.
    if (by && task.from !== by.id && this.lead(this.chats.get(chatId))?.id !== by.id) return `Task ${taskId} was handed out by someone else, so it is theirs to stop.`
    if (task.status !== 'queued' && task.status !== 'running') return `Task ${taskId} already ${task.status === 'done' ? 'finished' : 'ended'}.`
    const chat = this.chats.get(task.chatId)
    const to = this.accounts.get(task.to)
    if (!chat || !to) return 'That task can no longer be reached.'
    const s = this.session(chat, to)
    if (task.status === 'queued' && s.dequeueTask(taskId)) {
      this.setTask(task, 'cancelled', byUser ? 'Cancelled by the user before it started.' : 'Cancelled before it started.')
      if (byUser) this.reportBack(task)
      return `Task ${taskId} was cancelled before it started.`
    }
    if (s.currentTaskId === taskId) {
      // Only this task is muted, not the whole chat: other tasks' news still gets through.
      if (!byUser) this.stoppedBy.set(`${chat.id}:${taskId}`, this.accounts.get(task.from)?.name || by?.name || 'the lead')
      await s.stop()
      return `Task ${taskId} is being stopped.`
    }
    this.setTask(task, 'cancelled')
    return `Task ${taskId} was cancelled.`
  }

  private rosterText(chat: Chat, me: Account): string {
    const lead = this.lead(chat)
    const name = (id: string): string => this.accounts.get(id)?.name || 'a teammate'
    const accounts: string[] = []
    const agents: string[] = []
    for (const a of this.teamOf(chat)) {
      if (a.id === me.id) continue
      const st = this.accounts.statuses.get(a.id)
      const model = this.settingLabel(a)
      const smart = this.smartRun(chat, a)
      const runs = model ? `, set to ${model}` : smart ? `, runs ${smart.model} unless a task says otherwise` : ''
      const kind = (a.provider === 'claude' ? 'Claude Code agent' : 'ChatGPT agent, can generate images') + runs
      const role = (a.id === lead?.id ? ', team lead' : '') + (a.role?.trim() ? `; ${a.spawned ? 'for' : 'best at'}: ${a.role.trim()}` : '')
      const origin = a.spawned ? `; started by ${a.spawned.by === me.id ? 'you' : name(a.spawned.by)}, on ${name(a.spawned.base)}'s account` : ''
      let status: string
      if (st?.state !== 'ready') status = st?.state === 'signed-out' ? 'signed out, unavailable' : 'unavailable'
      else {
        const until = this.accounts.limitedUntil(a.id)
        const s = this.sessions.get(`${chat.id}:${a.id}`)
        const task = s?.currentTaskId ? this.findTask(chat.id, s.currentTaskId) : undefined
        if (until) status = `out of allowance until ${clock(until)}`
        else if (task) status = `working on "${task.title}"${s && s.state.queued ? `, ${s.state.queued} more queued` : ''}`
        else if (s?.busy) status = 'busy'
        else status = 'free'
        // An agent started in the chat draws on its account's allowance, which is listed with the account.
        if (!a.spawned) {
          const budget = budgetLine(budgetOf(this.accounts.usage.get(a.id)))
          if (budget) status += ` · ${budget}`
          if (!until && this.accounts.supply(a.id).state === 'low') status += ' · close to its usage limit: give it only small work, the app moves work off it when it runs out'
        }
      }
      ;(a.spawned ? agents : accounts).push(`- ${a.name} (${kind}${role}${origin}): ${status}`)
    }
    const own = budgetLine(budgetOf(this.accounts.usage.get(me.id)))
    const self = `You are ${me.name}${me.id === lead?.id ? ', the team lead' : me.spawned ? `, started by ${name(me.spawned.by)}` : ''}.${own ? ` ${me.spawned ? `${name(me.spawned.base)}'s account, which you work on, has` : 'Your account has'} ${own}.` : ''}`
    if (!accounts.length && !agents.length) return `${self}\n\nNobody else is on the team yet.`
    const room = this.spawnRoom(chat, me)
    const spawn = this.maySpawn(chat, me) ? `\n\nYou can start ${room} more ${room === 1 ? 'agent' : 'agents'} in this chat with spawn_agent.` : ''
    const learnt = this.depthOf(chat, me) < this.maxDepth(chat) ? this.learning.summary() : ''
    const lessons = learnt ? `\n\nWhat the team has learned about its models so far (from finished tasks and from rate_work):\n${learnt}` : ''
    const menus = this.depthOf(chat, me) < this.maxDepth(chat) ? [this.menu('claude') && `A Claude teammate can run:\n${this.menu('claude')}`, this.menu('chatgpt') && `A ChatGPT teammate can run:\n${this.menu('chatgpt')}`].filter(Boolean).join('\n') : ''
    return `${self}\n\nTeammates:\n${accounts.join('\n') || '(none)'}${agents.length ? `\n\nAgents started in this chat:\n${agents.join('\n')}` : ''}${spawn}${lessons}${menus ? `\n\n${menus}` : ''}`
  }

  private taskStatusText(chat: Chat, id?: string, by?: Account): string {
    const name = (aid: string): string => this.accounts.get(aid)?.name || aid
    // The lead sees every task in the chat; anyone else sees the ones they handed out.
    const all = by && this.lead(chat)?.id !== by.id ? this.tasksOf(chat.id).filter((t) => t.from === by.id) : this.tasksOf(chat.id)
    const list = all.filter((t) => !id || t.id === id)
    if (!list.length) return id ? `There is no task ${id}${by && all.length !== this.tasksOf(chat.id).length ? ' among the ones you handed out' : ''}.` : by && this.lead(chat)?.id !== by.id ? 'You have not handed out any tasks in this chat.' : 'No tasks have been handed out in this chat.'
    return list
      .map((t) => {
        const head = `${t.id} · ${t.status}${t.waitingOn?.length ? ` (waiting for ${t.waitingOn.join(', ')})` : ''} · ${name(t.to)} · ${t.title}`
        return id && t.result ? `${head}\n\n${t.result}` : head
      })
      .join('\n')
  }

  private toolsFor(session: AgentSession): TeamTool[] {
    const { chat, account: me } = session
    const isLead = this.lead(chat)?.id === me.id
    const canSpawn = this.maySpawn(chat, me)
    const tools: TeamTool[] = [
      {
        name: 'roster',
        description:
          'See who is in this chat right now: the teammates and any agents that were started here, what each is for, whether they are free or busy, which model each runs, and how much usage allowance each account has left for this session, for the week and for its strongest model, with how soon each refills.',
        schema: {},
        run: async () => this.rosterText(chat, me),
      },
      {
        name: 'message',
        description:
          'Pass a teammate a piece of information they need. It is a note, not a request for work: no report comes back, and they read it when their current work ends. Anyone in the chat can be written to, whoever started them. To get work done and a report returned, hand out a task instead.',
        schema: { to: z.string().describe(`The teammate's name, as shown in the roster, or "all" for everyone in the chat`), text: z.string().describe('The note, written so it makes sense without this conversation') },
        run: async (a) => this.deliver(chat, me, a as { to: string; text: string }),
      },
      {
        name: 'board_post',
        description:
          "Pin something on this chat's team board that everyone working here has to keep to: an interface or data shape two parts share, a name, a port, who owns which files, a decision and its reason. Every agent is pointed at the board with each task, so this is how parallel work stays consistent. Reusing a title replaces that note. Keep it to what others must know; a note for one teammate goes in a message.",
        schema: { title: z.string().describe('A short label, for example "API contract" or "File ownership"'), text: z.string().describe('What to pin, complete enough to work from') },
        run: async (a) => this.boardPost(chat, me, a as { title: string; text: string }),
      },
      {
        name: 'board_read',
        description: "Read this chat's team board: what the team has pinned as agreed (interfaces, names, file ownership, decisions). Read it before starting a task that touches something shared.",
        schema: {},
        run: async () => this.boardText(chat),
      },
      {
        name: 'ask',
        description:
          "Put a question to a teammate and get their answer back as the result of this call, without ending your turn. Use it for something they know or can judge and you need now: a second opinion on an approach, a fact about the part they built, a choice only they can make. They answer when their current step ends, so it can take a few minutes; if they cannot answer you are told, and carry on with your best judgment. It costs their allowance, so ask what you really need. For work to be done, use a task instead.",
        schema: {
          to: z.string().describe("The teammate's name, as shown in the roster"),
          question: z.string().describe('The question, with enough context that it can be answered without seeing your conversation'),
          depth: z
            .enum(['quick', 'careful'])
            .optional()
            .describe('quick (the default): a fact or a yes-or-no, answered on their lightest model to save allowance. careful: an answer that needs their full judgment, such as an opinion on a design or a subtle bug, answered on the model they normally run'),
        },
        run: async (a) => this.consult(chat, me, a as { to: string; question: string; depth?: string }),
      },
    ]
    if (canSpawn) {
      const who = isLead ? 'you' : 'you, as one of your own sub-agents'
      // Levels that remain below whoever this agent starts.
      const below = Math.max(0, this.maxDepth(chat) - this.depthOf(chat, me) - 1)
      tools.push(
        {
          name: 'spawn_agent',
          description: `Start a new agent in this chat: a full agent with a conversation and tools of its own that answers to ${who}. Use it when the work needs more hands than the team has, or a specialist that keeps its context across several tasks (a researcher on one angle, a tester, a reviewer, the owner of one part of a build). It works on one of the team's accounts and uses that account's allowance; leave account out and the one with the most allowance to spare is picked. Pass brief to hand it its first task in the same call. ${below > 0 ? `The agents you start can start helpers of their own (${below === 1 ? 'one more level' : `${below} more levels`} below them).` : 'The agents you start cannot start agents of their own, so brief them fully.'}${isLead ? '' : ' Your sub-agents report to you, and you report to whoever gave you your task.'} Everyone in the chat can message and ask everyone else. Up to ${this.agentCap(chat)} extra agents can be in a chat at once (more while it is in Ultra), so reuse one that is free before starting another.`,
          schema: {
            name: z.string().optional().describe('A short name the team will call it by, for example "Scout" or "Tester". Leave out to have one picked'),
            role: z.string().describe('What it is for, in a few words. The whole team sees this, for example "researches competitor pricing" or "owns the API tests"'),
            account: z.string().optional().describe('Which account it works on, by name from the roster. Leave out to use the account with the most allowance to spare'),
            title: z.string().optional().describe('A few words naming its first task. The user sees it'),
            brief: z
              .string()
              .optional()
              .describe(
                'Its first task. Everything it needs, since it starts knowing nothing: the goal and what it is for, what finished looks like, the files or paths involved and which it may change, constraints and what is already known, how to check the result, and what to report back (for research, also which sources count and how recent, and a link and a date with every claim). Leave out to start it without work',
              ),
            model: z.string().optional().describe('Which model does the first task (for example fable, opus, sonnet, haiku). Leave out and the app picks the strongest one the account can afford'),
            effort: z.string().optional().describe('How hard the model should think on the first task: low, medium, high, xhigh or max. Leave out for the usual setting'),
            after: z.array(z.string()).optional().describe('Ids of tasks that must finish before its first task starts, for example ["t1"]'),
          },
          run: async (a) => this.spawn(chat, me, a as SpawnArgs),
        },
        {
          name: 'dismiss_agent',
          description: 'Send home an agent that was started in this chat and is no longer needed. Its work stops and it takes no more; what it did stays on record. Any sub-agents it started go with it.',
          schema: { name: z.string().describe("The agent's name, as shown in the roster") },
          run: async (a) => {
            const agent = this.accounts.byName(String(a.name || ''), chat.id)
            if (!agent?.spawned) return `No agent called "${String(a.name || '')}" was started in this chat. Teammates that are accounts cannot be sent home.`
            return this.removeAgent(chat.id, agent.id, me)
          },
        },
      )
    }
    if (!isLead && canSpawn) {
      // Someone the lead works with runs a small team of their own: the agents they started.
      tools.push(
        {
          name: 'assign_task',
          description:
            'Hand a piece of work to an agent you started and get its report back later. It returns at once: the agent works in the background, and its final message reaches you as a <task-result> that wakes you, so there is nothing to wait for or poll. Use it for parts of your own task that are separable and worth a brief. You stay answerable for the whole of your task: check what comes back before you report.',
          schema: {
            to: z.string().describe('The name of an agent you started, or "auto" for whichever of them is free'),
            title: z.string().describe('A few words naming the task. The user sees it.'),
            brief: z.string().describe('Everything the agent needs, since it cannot see your conversation: the goal, what finished looks like, the files involved and which it may change, constraints, how to check the result, and what to report back (for research, also which sources count and how recent, and a link and a date with every claim)'),
            model: z.string().optional().describe('Which model does this task. Leave out and the app picks the strongest one the account can afford'),
            effort: z.string().optional().describe('How hard the model should think: low, medium, high, xhigh or max. Leave out for the usual setting'),
            after: z.array(z.string()).optional().describe('Ids of your tasks that must finish first, for example ["t3"]. This one then starts by itself and is handed their reports'),
          },
          run: async (a) => this.assign(chat, me, a as { to: string; title: string; brief: string; model?: string; effort?: string; after?: string[] | string }),
        },
        {
          name: 'cancel_task',
          description: 'Stop a task you handed out that is no longer needed, whether it is still queued or already running.',
          schema: { id: z.string().describe('The task id, for example t4') },
          run: async (a) => this.cancelTask(chat.id, String(a.id), false, me),
        },
        {
          name: 'task_status',
          description: 'List the tasks you handed out and where each stands. Pass an id to read that report again. Reports reach you by themselves, so use this to make sure nothing is still out before you report, not to wait.',
          schema: { id: z.string().optional().describe('A task id to read in full') },
          run: async (a) => this.taskStatusText(chat, a.id ? String(a.id) : undefined, me),
        },
      )
    }
    if (isLead || canSpawn) {
      tools.push({
        name: 'rate_work',
        description:
          "Once you have checked a task's report, say in one call whether the model that did it was right for the job. This is how the team learns where a cheaper model is good enough and where a stronger one is needed, and it saves allowance on every task after. Skip it for trivial tasks.",
        schema: {
          id: z.string().describe('The task id, for example t3'),
          verdict: z.enum(['enough', 'too_weak', 'more_than_needed']).describe('enough: the right model. too_weak: it fell short and a stronger model would have done better. more_than_needed: a cheaper model would have done as well'),
        },
        run: async (a) => this.rateWork(chat, me, a as { id?: string; verdict?: string }),
      })
    }
    if (isLead) {
      tools.push(
        {
          name: 'assign_task',
          description:
            "Hand a piece of work to a teammate and get their report back later. It returns at once: the teammate works in the background on their own account, and their final message reaches you as a <task-result> that wakes you, so there is nothing to wait for or poll. A handoff costs the teammate's allowance and a brief from you, so use it for work that is separable and worth a brief (parts that can run side by side, an independent review, images), not for something you could finish in a few steps yourself.",
          schema: {
            to: z.string().describe(`A teammate's or agent's name from the roster, or "auto" to give it to the free Claude teammate with the most allowance to spare`),
            title: z.string().describe('A few words naming the task. The user sees it.'),
            brief: z
              .string()
              .describe(
                'Everything the teammate needs, since they cannot see this conversation: the goal and what it is for, what finished looks like, the files or paths involved and which they may change, constraints and what is already known, how to check the result, and what to report back (for research, also which sources count and how recent, and a link and a date with every claim)',
              ),
            model: z
              .string()
              .optional()
              .describe(
                this.settings.smartModels
                  ? "Which of the teammate's models does this task, by its short name in the roster (for example fable, opus, sonnet, haiku). Leave out and the app picks the strongest one their account can afford right now"
                  : "Which of the teammate's models does this task, by its short name in the roster (for example opus, sonnet, haiku). Leave out to use the model they are set to",
              ),
            effort: z.string().optional().describe('How hard the model should think on this task: low, medium, high, xhigh or max. Leave out for their usual setting'),
            after: z
              .array(z.string())
              .optional()
              .describe('Ids of tasks that must finish first, for example ["t1", "t2"]. This task then starts by itself when they are done and is handed their reports, so a review or an integration step can be lined up now instead of after you wake up'),
          },
          run: async (a) => this.assign(chat, me, a as { to: string; title: string; brief: string; model?: string; effort?: string; after?: string[] | string }),
        },
        {
          name: 'resume_work',
          description: 'Start again the tasks that were cut short when the app closed. Each goes back to the teammate who had it, with its conversation intact, and reports as usual. Use it when a <recovery> note lists interrupted tasks and the user wants that work carried on.',
          schema: {},
          run: async () => this.resumeChat(chat.id, { skip: me.id }),
        },
        {
          name: 'cancel_task',
          description: 'Stop a task you handed out that is no longer needed, whether it is still queued or already running.',
          schema: { id: z.string().describe('The task id, for example t2') },
          run: async (a) => this.cancelTask(chat.id, String(a.id), false),
        },
        {
          name: 'task_status',
          description:
            "List the tasks handed out in this chat and where each stands. Pass an id to read that task's full report again. Reports are delivered to you automatically, so use this to make sure nothing is still out before a final answer, not to wait for one.",
          schema: { id: z.string().optional().describe('A task id to read in full') },
          run: async (a) => this.taskStatusText(chat, a.id ? String(a.id) : undefined),
        },
      )
    }
    if (isLead) {
      tools.push(
        {
          name: 'goal_report',
          description:
            'Say where the chat\'s goal stands, while a goal is set (a <goal> block started it). "met": you believe it is done; give the evidence (what you ran or looked at and what it showed). "blocked": the only thing in the way is something the user alone can give or decide; say exactly what you need. The app checks when your reply ends and either closes the goal, waits for the user, or sends you back with what is missing.',
          schema: {
            state: z.enum(['met', 'blocked', 'working']).describe('met, blocked, or working (still on it)'),
            note: z.string().describe('For met: the evidence. For blocked: exactly what you need from the user. One to four sentences'),
          },
          run: async (a) => this.auto.report(chat, me, a as { state?: string; note?: string }),
        },
        {
          name: 'goal_set',
          description:
            'Make something the goal of this chat when the user asks, in their own words, for work to be kept at until it is done ("do not stop until the tests pass", "keep going until it is perfect"). From then on the app checks after each of your replies whether it is met and sends you back if it is not. Setting it replaces a goal that is already there. Do not set one for an ordinary request.',
          schema: {
            goal: z.string().describe("What is to be achieved, in the user's terms"),
            done_when: z.string().optional().describe('How to tell it is done, when the user said or it follows plainly from the goal'),
            max_rounds: z.number().optional().describe("How many times you may be sent back before the app stops and asks. Leave out for the usual number, which is also the most you can set: more is the user's call"),
            minutes: z.number().optional().describe('A time limit in minutes, when the user gave one'),
          },
          run: async (a) => {
            const text = String(a.goal || '').trim()
            if (!text) return 'Say what the goal is.'
            const { goal } = this.auto.setGoal(chat, { text, doneWhen: a.done_when ? String(a.done_when) : undefined, maxRounds: typeof a.max_rounds === 'number' ? a.max_rounds : undefined, minutes: typeof a.minutes === 'number' ? a.minutes : undefined, mode: this.ultraRun.get(chat.id) }, true)
            return `The goal is set (up to ${goal.maxRounds} rounds). Tell the user in a line, then work on it now and keep going until it is done. End each reply with what is done, the evidence, and what is left of the goal (say 'nothing' when it is done); call goal_report with "met" and the evidence when it is, or with "blocked" if only the user can unblock it.`
          },
        },
        {
          name: 'loop_start',
          description:
            'Start a loop when the user asks for something to be done again and again ("check the deploy every ten minutes", "watch for replies and tell me", "each morning summarise..."): the message is sent to you again by itself, at a fixed pace or whenever you say the next run is due, until its stop condition is met. Do the first run yourself in this reply; the loop takes over from the second. Loops run while Ensemble is open.',
          schema: {
            prompt: z.string().describe('What to do on each run, written so it makes sense on its own every time'),
            every_minutes: z.number().optional().describe('Minutes between runs (at least 5). Leave out to set the pace yourself after each run with loop_update'),
            until: z.string().optional().describe('The condition that ends the loop, when there is one, for example "the deploy is live"'),
            max_runs: z.number().optional().describe('Stop after this many runs. Leave out for 20'),
          },
          run: async (a) => {
            const prompt = String(a.prompt || '').trim()
            if (!prompt) return 'Say what the loop should do each time.'
            try {
              const loop = this.auto.addLoop(chat, { prompt, every: typeof a.every_minutes === 'number' && a.every_minutes > 0 ? a.every_minutes * 60_000 : null, until: a.until ? String(a.until) : undefined, maxRuns: typeof a.max_runs === 'number' ? a.max_runs : null, to: me.id }, false, true)
              return `Loop ${loop.id} is going (${everyLabel(loop.every)}); its next run is in ${span((loop.nextAt || Date.now()) - Date.now())}. Tell the user in a line what will happen and how to stop it (the loop bar above the message box, or /loop stop).`
            } catch (e) {
              return (e as Error).message
            }
          },
        },
        {
          name: 'notify_user',
          description:
            'Get the user\'s attention right now with a short notice: a desktop notification when Ensemble is in the background, a line in the window when it is in front. For news they are waiting on (what a loop was watching for has happened, long work is finished or stuck), not for routine progress.',
          schema: { title: z.string().describe('A few words'), text: z.string().describe('One sentence with the news') },
          run: async (a) => {
            this.tell(truncate(String(a.title || 'News from the team'), 60), truncate(String(a.text || ''), 200), chat, me.id)
            return 'The user has been told.'
          },
        },
      )
    }
    tools.push({
      name: 'loop_update',
      description:
        'For a loop (a message that reaches you again by itself in a <loop> block): say when the next run is due with next_in_minutes, or end the loop with stop when its condition is met or it no longer serves its purpose. Called with neither, it lists the loops in this chat.',
      schema: {
        id: z.string().optional().describe('The loop id from the <loop> block. Leave out during a run to mean that loop'),
        next_in_minutes: z.number().optional().describe('Minutes until the next run, 1 to 1440'),
        stop: z.boolean().optional().describe('true to end the loop'),
        reason: z.string().optional().describe('Why it ends, in a sentence. The user sees it'),
      },
      run: async (a) => (a.stop || a.next_in_minutes !== undefined ? this.auto.loopUpdate(chat, me, a as { id?: string; next_in_minutes?: number; stop?: boolean; reason?: string }) : this.auto.loopsText(chat)),
    })
    if (this.settings.memoryEnabled) {
      tools.push(
        {
          name: 'memory_save',
          description:
            "Save one fact to the team's shared memory so it is known in future chats: a preference the user stated, a project convention, a decision and its reason. Reusing an existing title updates that note instead of adding a second one.",
          schema: { title: z.string().describe('A short label for the fact'), body: z.string().describe('The fact itself, in a sentence or two') },
          run: async (a) => {
            const n = this.memory.save({ title: String(a.title), body: String(a.body) }, me.id)
            return `Saved as "${n.title}" (${n.id}).`
          },
        },
        {
          name: 'memory_search',
          description: "Search the team's shared memory.",
          schema: { query: z.string() },
          run: async (a) => {
            const hits = this.memory.search(String(a.query))
            return hits.length ? hits.map((n) => `${n.id} · ${n.title}\n${n.body}`).join('\n\n') : 'Nothing in memory matches that.'
          },
        },
        {
          name: 'memory_delete',
          description: 'Remove a note from shared memory when it is wrong or out of date.',
          schema: { id: z.string().describe('The note id from memory_search') },
          run: async (a) => (this.memory.delete(String(a.id)) ? 'Removed.' : 'No note has that id.'),
        },
        {
          name: 'chat_history_search',
          description: 'Search earlier chats the user had with the team, for when they refer to past work or decisions.',
          schema: { query: z.string() },
          run: async (a) => {
            const hits = (await this.search(String(a.query), chat.id)).slice(0, 8)
            if (!hits.length) return 'No earlier chat mentions that.'
            return hits.map((h) => `"${h.title}" (${ago(h.ts)}): ${h.snippet}`).join('\n\n')
          },
        },
      )
    }
    const vault = this.vault?.exists ? this.vault : null
    if (vault) {
      tools.push(
        {
          name: 'vault_search',
          description: `Search ${vault.name}, the user's knowledge vault, for notes on a topic. Returns the best matches with their paths and a line of context. Look here before researching or building something: the answer, or an earlier decision, may already be written down.`,
          schema: {
            query: z.string().describe('Words to look for'),
            folder: z.string().optional().describe('Search only under this folder of the vault, for example Projects'),
            limit: z.number().optional().describe('How many notes to return (default 8)'),
          },
          run: async (a) => {
            const hits = vault.search(String(a.query || ''), { folder: a.folder ? String(a.folder) : undefined, limit: typeof a.limit === 'number' ? a.limit : 8 })
            if (!hits.length) return 'No note in the vault matches that. Try other words, or fewer.'
            return hits.map((h) => `${h.path}${[h.type, h.status, h.updated && `updated ${h.updated}`].filter(Boolean).length ? ` (${[h.type, h.status, h.updated && `updated ${h.updated}`].filter(Boolean).join(', ')})` : ''}\n  ${h.snippet}`).join('\n\n')
          },
        },
        {
          name: 'vault_read',
          description: 'Read one note from the vault, by its path or its title. It also lists the notes this one links to and the notes that link to it, which is how to find related knowledge.',
          schema: {
            note: z.string().describe('A path such as "Projects/My app.md", or a note title'),
            from_line: z.number().optional().describe('Carry on reading a long note from this line'),
          },
          run: async (a) => {
            const found = vault.resolve(String(a.note || ''))
            if (!found.length) return `No note is called "${String(a.note)}". Use vault_search to find it.`
            if (found.length > 1) return `Several notes could be meant by that. Read one by its path:\n${found.map((f) => `- ${f}`).join('\n')}`
            const n = vault.read(found[0], typeof a.from_line === 'number' ? a.from_line : 1)
            if (!n) return 'That note could not be read.'
            const links = n.links.length ? `\nLinks to: ${n.links.join(' · ')}` : ''
            const back = n.backlinks.length ? `\nLinked from: ${n.backlinks.join(' · ')}` : ''
            return `<note path="${n.path}">\n${n.content.trimEnd()}\n</note>${links}${back}`
          },
        },
        {
          name: 'vault_save',
          description:
            'Write to the vault: create a new note, add to the end of an existing one, or add under one of its headings. The write is safe even while the note is open in Obsidian. Search first, so that what you write extends the note that already covers the topic instead of starting a near-duplicate. To change or remove existing text, read the note and edit that file directly.',
          schema: {
            path: z.string().describe('Where the note lives in the vault, for example "Decisions/2026-11-14 Use SQLite.md"'),
            content: z.string().describe("The Markdown to write. For a new note, the whole note including any properties block the vault's notes carry"),
            mode: z.enum(['create', 'append', 'section']).describe('create: a new note. append: add to the end. section: add under the heading named in heading (made if missing)'),
            heading: z.string().optional().describe('For section: the heading to add under'),
          },
          run: async (a) => {
            const mode = a.mode === 'append' || a.mode === 'section' ? a.mode : 'create'
            const r = vault.save({ path: String(a.path || ''), content: String(a.content || ''), mode, heading: a.heading ? String(a.heading) : undefined })
            const guide = vault.guide ? ` If ${vault.guide} asks for a link from an index or a line in a log after a change like this, do that too.` : ''
            return `${r.created ? 'Created' : 'Updated'} ${r.path}.${guide}`
          },
        },
      )
    }
    tools.push(...this.hands.toolsFor(session))
    return tools
  }

  // ----- screens the person is watching -----

  screenWatch(key: string, on: boolean, full = false): void {
    this.hands.watch(key, on, full)
  }

  screenInput(chatId: string, accountId: string, input: ScreenInput): void {
    this.hands.input(chatId, accountId, input)
  }

  screenGo(chatId: string, accountId: string, to: string): Promise<void> {
    return this.hands.go(chatId, accountId, to)
  }

  screenOpen(chatId: string, accountId: string, url?: string): Promise<void> {
    this.need(chatId)
    return this.hands.open(chatId, accountId, url)
  }

  screenClose(chatId: string, accountId: string): void {
    this.hands.close(chatId, accountId)
  }

  // ----- what changed on disk -----

  async folderChanges(chatId: string): Promise<FolderChanges> {
    const chat = this.need(chatId)
    if (this.host.demo) return demoChanges(this.tasksOf(chatId).filter((t) => t.status === 'done').length)
    const root = (await git(chat.cwd, ['rev-parse', '--show-toplevel']))?.trim()
    if (!root) return { repo: false, files: [] }
    const [branch, status, tracked] = await Promise.all([
      git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).then((b) => b?.trim() || git(root, ['rev-parse', '--short', 'HEAD']).then((h) => h?.trim())),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(root, ['diff', '--numstat', '-z', 'HEAD']).then((d) => d ?? git(root, ['diff', '--numstat', '-z'])),
    ])
    const counts = new Map<string, { added: number; removed: number }>()
    for (const row of (tracked || '').split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row)
      if (m) counts.set(m[3], { added: Number(m[1]) || 0, removed: Number(m[2]) || 0 })
    }
    const files: ChangedFile[] = []
    const parts = (status || '').split('\0')
    for (let i = 0; i < parts.length && files.length < 400; i++) {
      const row = parts[i]
      if (row.length < 4) continue
      const code = row[0] !== ' ' && row[0] !== '?' ? row[0] : row[1]
      const p = row.slice(3)
      // A rename is followed by the old name as its own entry.
      if (row[0] === 'R' || row[0] === 'C') i++
      const file: ChangedFile = { path: p, status: PORCELAIN[code] || 'modified', ...counts.get(p) }
      // Git does not count lines for files it is not tracking yet.
      if (file.status === 'untracked' && files.length < 60) {
        try {
          const full = path.join(root, p)
          if (fs.statSync(full).size < 300_000) {
            const text = fs.readFileSync(full, 'utf8')
            if (!text.includes('\0')) file.added = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
          }
        } catch {
          /* unreadable: list it without a count */
        }
      }
      files.push(file)
    }
    return { repo: true, branch: branch || undefined, files }
  }

  async fileDiff(chatId: string, rel: string): Promise<string> {
    const chat = this.need(chatId)
    if (this.host.demo) return demoDiff(rel)
    const root = (await git(chat.cwd, ['rev-parse', '--show-toplevel']))?.trim()
    if (!root) return ''
    const full = path.resolve(root, rel)
    if (path.relative(root, full).startsWith('..') || path.isAbsolute(path.relative(root, full))) return ''
    const diff = (await git(root, ['diff', 'HEAD', '--', rel])) ?? (await git(root, ['diff', '--', rel])) ?? ''
    if (diff.trim()) return clipText(diff, 400_000)
    // Not tracked yet: show the whole file as added.
    try {
      const st = fs.statSync(full)
      if (!st.isFile() || st.size > 400_000) return ''
      const text = fs.readFileSync(full, 'utf8')
      if (text.includes('\0')) return ''
      const lines = text.split(/\r?\n/)
      return `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`
    } catch {
      return ''
    }
  }

  // ----- library, export, attachments -----

  /** Every picture the team has made, newest first. */
  async listImages(): Promise<LibraryImage[]> {
    const out: LibraryImage[] = []
    for (const chat of this.chats.values()) {
      const dir = path.join(this.dataDir, 'chats', chat.id)
      let files: string[] = []
      try {
        files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'tasks.json')
      } catch {
        continue
      }
      for (const f of files) {
        const accountId = f.replace(/\.json$/, '')
        const live = this.sessions.get(`${chat.id}:${accountId}`)
        const items = live ? live.items : await this.readTranscript(path.join(dir, f))
        for (const it of items) {
          if (it.kind === 'image' && !it.media && exists(it.path)) out.push({ path: it.path, chatId: chat.id, chatTitle: chat.title, accountId, ts: it.ts })
        }
      }
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 400)
  }

  /** A pasted picture has no file of its own yet, so it is kept here. */
  saveImage(bytes: ArrayBuffer, mime: string): Attachment | null {
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mime]
    if (!ext || bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) return null
    const dir = path.join(this.dataDir, 'pasted')
    fs.mkdirSync(dir, { recursive: true })
    const name = `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${uid().slice(0, 4)}.${ext}`
    const file = path.join(dir, name)
    fs.writeFileSync(file, Buffer.from(bytes))
    return { path: file, name, kind: 'image' }
  }

  /** The chat as a document: what you asked, what the lead answered, what was handed out. */
  chatMarkdown(chatId: string): string {
    const chat = this.need(chatId)
    const name = (id: string): string => this.accounts.get(id)?.name || 'A teammate'
    const lead = this.lead(chat)
    const out: string[] = [`# ${chat.title}`, '', `${new Date(chat.createdAt).toLocaleString()} · ${chat.cwd}`, '']
    const snap = this.openChat(chatId)
    const order = [...(lead ? [lead.id] : []), ...Object.keys(snap.items).filter((id) => id !== lead?.id)]
    for (const id of order) {
      const items = snap.items[id]
      if (!items?.length) continue
      if (order.length > 1) out.push(`## ${name(id)}${id === lead?.id ? ' (lead)' : ''}`, '')
      for (const it of items) {
        if (it.kind === 'user' && it.text.trim()) out.push(`**You:** ${it.text.trim()}`, '')
        else if (it.kind === 'assistant' && it.text.trim()) out.push(it.text.trim(), '')
        else if (it.kind === 'delegate') out.push(`> Handed to ${name(it.to)}: **${it.title}**`, '')
        else if (it.kind === 'auto') out.push(`> ${it.title}${it.text ? `: ${it.text.replace(/\s+/g, ' ')}` : ''}`, '')
        else if (it.kind === 'peer') {
          const head = it.tag === 'task' ? `Task from ${name(it.from)}: ${it.title || ''}` : it.tag === 'result' ? `${name(it.from)} reported on "${it.title || 'a task'}"` : `Note from ${name(it.from)}`
          out.push(`> **${head}**`, ...it.text.trim().split('\n').map((l) => `> ${l}`), '')
        } else if (it.kind === 'image') out.push(`![image](${it.path.replace(/\\/g, '/')})`, '')
        else if (it.kind === 'turn') out.push('---', '')
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n')
  }

  // ----- search -----

  /** What search and the picture library read of transcripts that are not open (words and pictures only), for the most recent files. */
  private transcriptCache = new Map<string, { mtime: number; items: Item[] }>()

  private async readTranscript(file: string): Promise<Item[]> {
    try {
      const mtime = (await fs.promises.stat(file)).mtimeMs
      const hit = this.transcriptCache.get(file)
      if (hit && hit.mtime === mtime) {
        this.transcriptCache.delete(file)
        this.transcriptCache.set(file, hit)
        return hit.items
      }
      const all = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Item[]
      const items = Array.isArray(all) ? all.filter((it) => it.kind === 'user' || it.kind === 'assistant' || it.kind === 'image') : []
      this.transcriptCache.set(file, { mtime, items })
      while (this.transcriptCache.size > 200) this.transcriptCache.delete(this.transcriptCache.keys().next().value as string)
      return items
    } catch {
      return []
    }
  }

  /**
   * Looks through every chat's words. Files are read without blocking, and the work pauses between
   * chats, so agents keep streaming while a search runs.
   */
  async search(query: string, excludeChatId?: string): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    const hits: (SearchHit & { score: number })[] = []
    let n = 0
    for (const chat of [...this.chats.values()]) {
      if (chat.id === excludeChatId) continue
      if (++n % 4 === 0) await new Promise((r) => setImmediate(r))
      const title = chat.title.toLowerCase()
      if (terms.every((t) => title.includes(t))) {
        hits.push({ chatId: chat.id, title: chat.title, snippet: chat.snippet || '', ts: chat.updatedAt, score: 10 })
      }
      const dir = path.join(this.dataDir, 'chats', chat.id)
      let files: string[] = []
      try {
        files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'tasks.json')
      } catch {
        continue
      }
      let found = 0
      for (const f of files) {
        const accountId = f.replace(/\.json$/, '')
        const live = this.sessions.get(`${chat.id}:${accountId}`)
        const items = live ? live.items : await this.readTranscript(path.join(dir, f))
        for (const it of items) {
          if (found >= 3) break
          if (it.kind !== 'user' && it.kind !== 'assistant') continue
          const lower = it.text.toLowerCase()
          if (!terms.every((t) => lower.includes(t))) continue
          const at = Math.max(0, lower.indexOf(terms[0]) - 60)
          const snippet = (at > 0 ? '…' : '') + it.text.slice(at, at + 200).replace(/\s+/g, ' ').trim() + (it.text.length > at + 200 ? '…' : '')
          hits.push({ chatId: chat.id, title: chat.title, accountId, snippet, ts: it.ts, score: it.kind === 'user' ? 3 : 2 })
          found++
        }
      }
    }
    return hits
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .slice(0, 40)
      .map(({ score: _score, ...h }) => h)
  }

  async dispose(): Promise<void> {
    this.auto.dispose()
    this.failover.dispose()
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.connectors.cancelSignIn()
    if (this.timer) clearInterval(this.timer)
    for (const t of this.waitTimers.values()) clearTimeout(t)
    for (const t of this.parked.values()) clearTimeout(t)
    for (const t of this.sweeps.values()) clearTimeout(t)
    // Notes that were due are written now rather than lost.
    for (const [id, t] of this.noteTimers) {
      clearTimeout(t)
      const c = this.chats.get(id)
      if (c) {
        try {
          this.writeChatNote(c)
        } catch {
          /* the app is closing */
        }
      }
    }
    this.waitTimers.clear()
    this.saveRunning.flush()
    this.saveChats.flush()
    for (const s of this.sessions.values()) s.dispose()
    this.hands.dispose()
    this.vault?.dispose()
    this.accounts.dispose()
    this.toolServer.stop()
  }
}
