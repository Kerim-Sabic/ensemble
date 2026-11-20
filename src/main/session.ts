import path from 'node:path'
import type { Account, AgentState, Chat, HubEvent, Item, PermissionDecision, PermissionLevel, QuestionSpec, RewindPreview } from '@shared/types'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { describeTool, HIDDEN_TEAM_TOOLS, isHandsTool, mediaKind, mediaPathsIn, MEDIA_EXT, toolLine } from '@shared/tools'
import { readJson, Saver, uid } from './util'
import type { AgentRuntime, PermissionAsk, RuntimeEvent, RuntimeHost, TurnInput } from './providers/types'

/** A turn waiting to run (or running). */
export interface Pending {
  /**
   * 'ask' is a teammate's question: someone is waiting on the answer. 'auto' is something the
   * app sends by itself on the user's standing instruction: the next round of a goal, a loop's run.
   */
  kind: 'user' | 'task' | 'team' | 'ask' | 'auto'
  /** For an 'auto' turn that belongs to a loop: which one. */
  auto?: { of: 'goal' | 'loop'; ref: string }
  /** What the model reads. */
  text: string
  images?: string[]
  origin: TurnInput['origin']
  /** Transcript rows shown as "queued" until this starts. */
  itemIds: string[]
  taskId?: string
  /** The model and effort this turn should run at, when someone chose them for it. */
  run?: RunSpec
  /** Told how the turn ended, or that it never ran. */
  onDone?(ev: TurnEnd): void
  /** Run again once already, after the agent's process died under it. */
  retried?: boolean
  /**
   * What the turn is made of, when it bundles several things: notes and reports that were waiting,
   * and the user's own messages. A message the user takes back is removed on its own.
   */
  parts?: TurnPart[]
  /** Run again once already on a lesser model, after the strongest one hit its limit. */
  stepped?: boolean
  /** The model the hub is about to give this another go on. */
  stepTo?: string
}

/** One piece of a turn that bundles several. `user` marks the user's own message. */
export interface TurnPart {
  text: string
  itemIds: string[]
  user?: boolean
  images?: string[]
}

export interface RunSpec {
  model?: string | null
  effort?: string | null
  /** Why the app chose this model, when it did. Shown to the person; not part of what the agent runs on. */
  why?: string
}

const specKey = (r?: RunSpec): string => `${r?.model || ''}|${r?.effort || ''}`

export type TurnEnd = Extract<RuntimeEvent, { type: 'turn-end' }>

export interface SessionHost {
  dataDir: string
  emit(ev: HubEvent): void
  buildRuntime(session: AgentSession, run?: RunSpec): AgentRuntime
  onTurnStart(session: AgentSession, pending: Pending): void
  onTurnEnd(session: AgentSession, pending: Pending, ev: TurnEnd): void
  onSessionId(session: AgentSession, id: string): void
  onUsage(accountId: string, usage: Extract<RuntimeEvent, { type: 'usage' }>['usage']): void
  /** A one-click way out of a failed turn, when there is one. */
  remedyFor(session: AgentSession, pending: Pending, ev: TurnEnd): Extract<Item, { kind: 'notice' }>['action']
  /**
   * What to say instead of an error when the app is about to give the same work another go.
   * An empty string: the app is moving the work on and says so elsewhere, so no row here.
   */
  retryNote(session: AgentSession, pending: Pending, ev: TurnEnd): string | null
  onAttention(session: AgentSession, what: string): void
  registerAsk(requestId: string, ask: OpenAsk): void
  dropAsk(requestId: string): void
  /** Reports and notes that were waiting when the agent was stopped: kept unread for its next turn, not lost. */
  keepUnread(session: AgentSession, pending: Pending): void
  /** True for an unattended run the user stopped (src/main/guard.ts): it is handed nothing but the user's own words. */
  halted?(session: AgentSession): boolean
}

/** A question to the person that is still on screen. `expire` settles it as dismissed. */
export type OpenAsk = { session: AgentSession; itemId: string; expire(): void } & (
  | { kind: 'permission'; resolve(r: { decision: PermissionDecision; note?: string }): void }
  | { kind: 'question'; resolve(r: Record<string, string> | null): void }
)

/**
 * How long an agent's own program (Claude Code or Codex, with the connector servers it started)
 * stays open after its last turn. Closed after that and opened again on the next turn, which
 * resumes the same conversation. A Claude Code process holds 250 to 380 MB here (census of the
 * installed app, 2026-11-20) and takes about 3 s to start (claude --version, 2.6 to 3.5 s), so a
 * team that waits holds memory only for those at work. Checks set it shorter.
 */
export const IDLE = { closeMs: 4 * 60 * 1000 }
/** How often a transcript that is changing is written while its agent works (each write is the whole file); a reply's end is written at once. */
export const SAVE_GAP_MS = 10_000
/** Kinds of row saved at once, when they are added and when they change (an approval answered, a question settled). */
export const SAVE_NOW_KINDS: ReadonlySet<string> = new Set(['user', 'permission', 'question', 'signin', 'auto', 'notice'])
/**
 * Rows that arrive in dozens in a big team (reports, handoffs, agents started, notes, questions to a
 * teammate) are saved within SAVE_SOON_MS instead: each is also kept elsewhere that is saved sooner
 * (the task list, the chat's agents, the goal), so a crash in that second loses a row, not the work.
 */
export const SAVE_SOON_KINDS: ReadonlySet<string> = new Set(['peer', 'ask', 'delegate', 'spawn', 'outgoing'])
export const SAVE_SOON_MS = 2500
const MAX_INPUT_JSON = 12000

function trimInput(input: unknown): unknown {
  if (input === undefined) return undefined
  try {
    const s = JSON.stringify(input)
    if (s.length <= MAX_INPUT_JSON) return input
    // Keep the shape readable but drop the bulk (file contents, long patches).
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}\n… ${v.length - 2000} more characters` : v
    }
    return out
  } catch {
    return undefined
  }
}

export class AgentSession implements RuntimeHost {
  items: Item[] = []
  state: AgentState
  private queue: Pending[] = []
  private current: Pending | null = null
  private runtime: AgentRuntime | null = null
  private file: string
  private saver: Saver
  /** Rows by id. Transcripts run to thousands of rows and every streamed word looks one up. */
  private byId = new Map<string, Item>()
  /**
   * Set when the app last closed in the middle of this agent's work: whether it had started,
   * and what had been said to it that it never answered.
   */
  unfinished: { worked: boolean; inputs: Item[] } | null = null
  private deltas = new Map<string, string>()
  private deltaTimer: NodeJS.Timeout | null = null
  private started = new Map<string, number>()
  private hidden = new Set<string>()
  private idleTimer: NodeJS.Timeout | null = null
  private openAsks = new Set<string>()
  /** Media already put on show, by path and when it was written, so a file is shown once per version. */
  private shown = new Set<string>()
  /** What those files hold, so one picture saved in two places (the generator's folder and the project) is shown once. */
  private shownContent = new Set<string>()

  /** True the first time a media file's content is seen in this session; false for a second copy of the same thing. */
  private fresh(p: string): boolean {
    try {
      const st = fs.statSync(p)
      const fd = fs.openSync(p, 'r')
      const head = Buffer.alloc(Math.min(st.size, 65536))
      fs.readSync(fd, head, 0, head.length, 0)
      fs.closeSync(fd)
      const key = `${st.size}:${createHash('sha1').update(head).digest('hex')}`
      if (this.shownContent.has(key)) return false
      this.shownContent.add(key)
      return true
    } catch {
      // Not readable just now: show it rather than lose it.
      return true
    }
  }
  /** The process no longer matches the team (new role, model or lead): replace it before the next turn. */
  private stale = false
  /** The model and effort the running process was started with. */
  private spec = specKey()
  /** The permission level the running process was started with, or null when none is running. */
  private builtAt: PermissionLevel | null = null
  /** Ended for good (its account or chat is gone): nothing more starts here. */
  private ended = false
  /** When the agent last finished a reply (or was set up), for sending idle agents home. */
  idleSince = Date.now()

  constructor(
    private host: SessionHost,
    readonly chat: Chat,
    readonly account: Account,
  ) {
    this.file = path.join(host.dataDir, 'chats', chat.id, `${account.id}.json`)
    this.items = readJson<Item[]>(this.file, [])
    // Anything that was mid-flight when the app last closed is over now.
    for (const it of this.items) {
      if ('streaming' in it && it.streaming) it.streaming = false
      if ('queued' in it && it.queued) it.queued = false
      if (it.kind === 'tool' && it.status === 'running') it.status = 'done'
      if ((it.kind === 'permission' || it.kind === 'question' || it.kind === 'signin') && it.status === 'pending') it.status = 'expired'
      if (it.kind === 'ask' && it.status === 'waiting') {
        it.status = 'failed'
        it.answer = 'The app closed before the answer came.'
      }
      if (it.kind === 'screen' && it.status === 'running') it.status = 'error'
      this.byId.set(it.id, it)
    }
    // Every reply ends with a closing row. Anything after the last one was cut short.
    let last = -1
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === 'turn') {
        last = i
        break
      }
    }
    const tail = this.items.slice(last + 1)
    const worked = tail.some((i) => i.kind === 'assistant' || i.kind === 'thinking' || i.kind === 'tool' || i.kind === 'screen' || i.kind === 'delegate' || i.kind === 'ask' || i.kind === 'outgoing')
    const inputs = tail.filter((i) => i.kind === 'user' || i.kind === 'peer')
    if (worked || inputs.length) this.unfinished = { worked, inputs }
    this.state = { chatId: chat.id, accountId: account.id, phase: 'idle', queued: 0 }
    this.saver = new Saver(this.file, () => this.items, SAVE_GAP_MS)
  }

  /**
   * Streamed text and tool rows are saved at most every SAVE_GAP_MS. Rows that record a decision or
   * something somebody is waiting on are saved at once (SAVE_NOW_KINDS): the person's own words,
   * a teammate's task, report, question or note, a request for permission and its answer, a question
   * to the person and its answer, a goal or loop row, an agent started. What a crash can lose is
   * then streamed text and tool rows only.
   */
  private persist(kind?: string, quiet = false): void {
    if (kind && !quiet && SAVE_NOW_KINDS.has(kind)) this.saver.now()
    else if (kind && !quiet && SAVE_SOON_KINDS.has(kind)) this.saver.soon(SAVE_SOON_MS)
    else this.saver.touch()
  }

  /** Draws a line under work that was cut short, once it has been dealt with. */
  closeTail(): void {
    if (!this.unfinished) return
    this.unfinished = null
    this.add({ id: uid('e'), kind: 'turn', ts: Date.now(), status: 'interrupted', durationMs: 0 })
  }

  /** Puts everything on disk right now. For the moment before the app closes. */
  flush(): void {
    this.flushDeltas()
    this.saver.flushSync()
  }

  get key(): string {
    return `${this.chat.id}:${this.account.id}`
  }

  get busy(): boolean {
    return this.current !== null
  }

  get currentTaskId(): string | undefined {
    return this.current?.taskId
  }

  // ----- transcript -----

  add(item: Item): void {
    this.items.push(item)
    this.byId.set(item.id, item)
    this.host.emit({ type: 'item', chatId: this.chat.id, accountId: this.account.id, item })
    this.persist(item.kind)
  }

  patch(id: string, patch: Record<string, unknown>): void {
    const it = this.byId.get(id)
    if (!it) return
    Object.assign(it, patch)
    this.host.emit({ type: 'item-patch', chatId: this.chat.id, accountId: this.account.id, id, patch })
    // 'queued' flips when a queued message starts: not worth a whole-file write of its own.
    this.persist(it.kind, Object.keys(patch).every((k) => k === 'queued'))
  }

  private delta(id: string, text: string): void {
    const it = this.byId.get(id)
    if (!it || !('text' in it)) return
    it.text += text
    this.deltas.set(id, (this.deltas.get(id) || '') + text)
    // Twelve updates a second reads as smooth typing and leaves the window time for everything else.
    if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), 85)
    this.persist()
  }

  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = null
    for (const [id, text] of this.deltas) {
      this.host.emit({ type: 'item-delta', chatId: this.chat.id, accountId: this.account.id, id, text })
    }
    this.deltas.clear()
  }

  private setState(patch: Partial<AgentState>): void {
    Object.assign(this.state, patch, { queued: this.queue.length, taskId: this.current?.taskId ?? null })
    this.host.emit({ type: 'agent', state: { ...this.state } })
  }

  // ----- turns -----

  enqueue(p: Pending, front = false): void {
    // A run nobody is watching that the user stopped takes nothing more until they speak to it again.
    if (p.kind !== 'user' && this.host.halted?.(this)) {
      if (p.kind === 'team') this.host.keepUnread(this, p)
      else {
        for (const id of p.itemIds) this.patch(id, { queued: false })
        p.onDone?.({ type: 'turn-end', status: 'interrupted', resultText: '', durationMs: 0 })
      }
      return
    }
    if (front) this.queue.unshift(p)
    else this.queue.push(p)
    this.setState({})
    this.pump()
  }

  /**
   * Takes a message of the user's out of the queue before it starts. Returns what was taken, so
   * whatever came along with it can be put back; null when it already started or is not there.
   */
  dequeueItem(itemId: string): { back?: TurnPart[] } | null {
    const i = this.queue.findIndex((q) => (q.kind === 'user' || q.kind === 'team') && q.itemIds.includes(itemId))
    if (i < 0) return null
    const p = this.queue[i]
    const parts: TurnPart[] = p.parts?.length ? p.parts : [{ text: p.text, itemIds: p.itemIds, user: p.kind === 'user', images: p.images }]
    const mine = parts.find((x) => x.itemIds.includes(itemId))
    // Only the user's own words can be taken back, not a teammate's note that rides with them.
    if (!mine?.user) return null
    const rest = parts.filter((x) => x !== mine)
    this.queue.splice(i, 1)
    this.patch(itemId, { queued: false, withdrawn: true })
    let back: TurnPart[] | undefined
    if (rest.some((x) => x.user)) {
      // Other messages of the user's are in the same turn: it keeps its place without this one.
      this.queue.splice(i, 0, { ...p, parts: rest, text: rest.map((x) => x.text).join('\n\n'), itemIds: rest.flatMap((x) => x.itemIds), images: rest.flatMap((x) => x.images || []) })
    } else if (rest.length) back = rest
    this.setState({})
    return { back }
  }

  /** Removes a not-yet-started task from the queue. */
  dequeueTask(taskId: string): boolean {
    const i = this.queue.findIndex((q) => q.taskId === taskId)
    if (i < 0) return false
    const [p] = this.queue.splice(i, 1)
    for (const id of p.itemIds) this.patch(id, { queued: false })
    this.setState({})
    return true
  }

  private pump(): void {
    if (this.ended || this.current || !this.queue.length) return
    const next = this.queue.shift() as Pending
    // Several teammate notes waiting at once are read together in one turn.
    if (next.kind === 'team') {
      while (this.queue[0]?.kind === 'team') {
        const more = this.queue.shift() as Pending
        if (next.parts || more.parts) next.parts = [...(next.parts || [{ text: next.text, itemIds: [...next.itemIds] }]), ...(more.parts || [{ text: more.text, itemIds: more.itemIds }])]
        next.text += `\n\n${more.text}`
        next.itemIds.push(...more.itemIds)
      }
    }
    for (const id of next.itemIds) this.patch(id, { queued: false })
    this.current = next
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.setState({ phase: 'thinking', activity: 'Thinking', turnStartedAt: Date.now(), error: undefined, suggestion: undefined, steps: 0 })
    this.host.onTurnStart(this, next)
    try {
      // A task can ask for its own model and effort; the conversation carries over.
      if (this.stale || (this.runtime && this.spec !== specKey(next.run))) {
        this.stale = false
        this.runtime?.dispose()
        this.runtime = null
      }
      if (!this.runtime) {
        this.setState({ phase: 'starting', activity: 'Waking up' })
        this.runtime = this.host.buildRuntime(this, next.run)
        this.spec = specKey(next.run)
        this.builtAt = this.chat.permission
      }
      this.runtime.send({ text: next.text, images: next.images, origin: next.origin })
    } catch (e) {
      this.emit({ type: 'turn-end', status: 'error', resultText: '', durationMs: 0, reason: 'other', error: (e as Error).message })
    }
  }

  /**
   * Words from the person for the turn under way. The runtime takes them into the turn itself;
   * they also join the turn's own text, so a retry of the turn carries them. False when no turn is
   * running or the runtime cannot take words mid-turn: the caller lines them up instead.
   */
  steer(text: string, images: string[] | undefined, itemId: string): boolean {
    const cur = this.current
    if (this.ended || !cur || !this.runtime?.steer) return false
    const words = `(Sent while you were working. Take it into account now; if it changes what you should do, change course.)\n\n${text}`
    if (!this.runtime.steer({ text: words, images, origin: { kind: 'human' } })) return false
    cur.itemIds.push(itemId)
    cur.text += `\n\n${words}`
    if (images?.length) cur.images = [...(cur.images || []), ...images]
    if (cur.parts) cur.parts.push({ text: words, itemIds: [itemId], user: true, images })
    return true
  }

  /** A line under the agent's name while it waits on something that is not its own work. */
  note(activity: string): void {
    if (this.current) this.setState({ phase: 'tool', activity })
  }

  /** Something about this agent that the hub worked out, such as why it runs the model it runs. */
  inform(patch: Pick<AgentState, 'modelWhy'>): void {
    if (this.state.modelWhy !== patch.modelWhy) this.setState(patch)
  }

  /**
   * Stops the reply under way and what is lined up behind it. Reports and notes from the team
   * that were waiting are not thrown away: they stay unread and come with the agent's next turn.
   */
  /** Takes everything lined up behind the current turn out of the queue, unstarted, for someone else to run. */
  drain(): Pending[] {
    const out = this.queue
    this.queue = []
    if (out.length) this.setState({})
    return out
  }

  async stop(): Promise<void> {
    const queue = this.queue
    this.queue = []
    for (const p of queue) {
      if (p.kind === 'team') {
        this.host.keepUnread(this, p)
        continue
      }
      for (const id of p.itemIds) this.patch(id, { queued: false })
      // Whoever was waiting on this turn learns that it is not going to happen.
      p.onDone?.({ type: 'turn-end', status: 'interrupted', resultText: '', durationMs: 0 })
    }
    this.setState({})
    for (const id of [...this.openAsks]) this.host.dropAsk(id)
    if (this.current && this.runtime) await this.runtime.interrupt()
  }

  /**
   * Passes a new permission level to the running process. The process applies what it can at
   * once; one that is in the middle of a reply is also replaced once that reply ends, so the
   * next turn runs at the new level for certain and never keeps a level the user lowered.
   */
  async setPermission(): Promise<void> {
    if (this.current && this.runtime && this.builtAt !== this.chat.permission) this.stale = true
    await this.runtime?.setPermission(this.chat.permission)
  }

  /** The permission level of the running process, or null when none is running. */
  get runsAt(): PermissionLevel | null {
    return this.runtime ? this.builtAt : null
  }

  /** Drop the process so the next turn starts fresh (new model, new role). */
  recycle(): void {
    if (this.current) {
      this.stale = true
      return
    }
    this.stale = false
    this.runtime?.dispose()
    this.runtime = null
    this.builtAt = null
  }

  /** The last thing the person typed here, for carrying over to another teammate. */
  lastUserText(): string {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (it.kind === 'user' && it.text.trim()) return it.text
    }
    return ''
  }

  /** Puts files back to how they were before the reply a turn row belongs to. */
  async rewind(turnId: string, apply: boolean): Promise<RewindPreview> {
    const no = (error: string): RewindPreview => ({ ok: false, error, files: [], added: 0, removed: 0 })
    const turn = this.byId.get(turnId)
    if (turn?.kind !== 'turn' || !turn.checkpoint) return no('There is nothing to undo for that reply.')
    if (this.current) return no(`Wait for ${this.account.name} to finish first.`)
    if (this.stale) this.recycle()
    if (!this.runtime) {
      this.runtime = this.host.buildRuntime(this)
      this.spec = specKey()
      this.builtAt = this.chat.permission
    }
    if (!this.runtime.rewind) return no(`${this.account.name} cannot undo file changes.`)
    // The provider only lists the files when asked for a preview, so look first.
    const before = apply ? await this.runtime.rewind(turn.checkpoint, false) : null
    const r = await this.runtime.rewind(turn.checkpoint, apply)
    if (apply && r.ok && before?.ok && !r.files.length) r.files = before.files
    if (apply && r.ok) {
      // Everything after this point was built on the files being as they were.
      const at = this.items.indexOf(turn)
      for (const it of this.items.slice(at)) if (it.kind === 'turn' && it.checkpoint) this.patch(it.id, { undone: true })
      const n = r.files.length
      this.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: n ? `Put ${n} ${n === 1 ? 'file' : 'files'} back to how ${n === 1 ? 'it was' : 'they were'} before that reply.` : 'Files are back to how they were before that reply.' })
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.recycle(), IDLE.closeMs)
    return r
  }

  dispose(): void {
    this.flush()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.runtime?.dispose()
    this.runtime = null
    this.builtAt = null
  }

  /**
   * Ends this agent for good, when its account or its chat goes. Unlike closing the app, nothing
   * is left to pick up later: the reply under way and everything lined up behind it are settled
   * as stopped, so tasks report back and loops do not wait for a run that will never end.
   */
  end(): void {
    if (this.ended) return
    this.ended = true
    const queue = this.queue
    this.queue = []
    for (const id of [...this.openAsks]) this.host.dropAsk(id)
    // The process goes first, so nothing it says afterwards lands on a settled turn.
    this.runtime?.dispose()
    this.runtime = null
    const stopped: TurnEnd = { type: 'turn-end', status: 'interrupted', resultText: '', durationMs: 0 }
    if (this.current) this.emit({ ...stopped, durationMs: Date.now() - (this.state.turnStartedAt || Date.now()) })
    for (const p of queue) {
      for (const id of p.itemIds) this.patch(id, { queued: false })
      this.host.onTurnEnd(this, p, stopped)
    }
    this.dispose()
  }

  // ----- RuntimeHost -----

  emit(ev: RuntimeEvent): void {
    switch (ev.type) {
      case 'session':
        this.host.onSessionId(this, ev.sessionId)
        if (ev.model) this.setState({ model: ev.model })
        return

      case 'status':
        this.setState({ activity: ev.text })
        return

      case 'text-start':
        this.add({ id: ev.id, kind: 'assistant', ts: Date.now(), text: '', streaming: true })
        this.setState({ phase: 'responding', activity: 'Writing' })
        return

      case 'text-delta':
        this.delta(ev.id, ev.text)
        return

      case 'text-end':
        this.flushDeltas()
        this.patch(ev.id, { text: ev.text, streaming: false })
        return

      case 'thinking-start':
        this.started.set(ev.id, Date.now())
        this.add({ id: ev.id, kind: 'thinking', ts: Date.now(), text: '', streaming: true })
        this.setState({ phase: 'thinking', activity: 'Thinking' })
        return

      case 'thinking-delta':
        this.delta(ev.id, ev.text)
        return

      case 'thinking-end': {
        this.flushDeltas()
        const t0 = this.started.get(ev.id)
        const patch: Record<string, unknown> = { streaming: false }
        if (t0) patch.durationMs = Date.now() - t0
        if (ev.text) patch.text = ev.text
        this.patch(ev.id, patch)
        return
      }

      case 'tool-start': {
        // These show up as their own cards (a handoff, a step on a screen), not as a tool row.
        if (HIDDEN_TEAM_TOOLS.has(ev.name) || isHandsTool(ev.name)) {
          this.hidden.add(ev.id)
          this.setState({ phase: 'tool', activity: toolLine(ev.name, ev.input), steps: (this.state.steps || 0) + 1 })
          return
        }
        this.started.set(ev.id, Date.now())
        this.add({ id: ev.id, kind: 'tool', ts: Date.now(), name: ev.name, input: trimInput(ev.input), status: 'running', parentId: ev.parentId })
        if (!ev.parentId) this.setState({ phase: 'tool', activity: toolLine(ev.name, ev.input), steps: (this.state.steps || 0) + 1 })
        return
      }

      case 'tool-input': {
        if (this.hidden.has(ev.id)) return
        const it = this.byId.get(ev.id)
        if (it?.kind !== 'tool') return
        this.patch(ev.id, { input: trimInput(ev.input) })
        if (!it.parentId && it.status === 'running') this.setState({ activity: toolLine(it.name, ev.input) })
        return
      }

      case 'tool-end': {
        if (this.hidden.delete(ev.id)) {
          this.setState({ phase: 'thinking', activity: 'Thinking' })
          return
        }
        const t0 = this.started.get(ev.id)
        this.started.delete(ev.id)
        const it = this.byId.get(ev.id)
        this.patch(ev.id, { status: ev.isError ? 'error' : 'done', output: ev.output, durationMs: t0 ? Date.now() - t0 : undefined })
        if (!ev.isError && it?.kind === 'tool') this.showMade(it.name, it.input, ev.output)
        if (it?.kind === 'tool' && !it.parentId) this.setState({ phase: 'thinking', activity: 'Thinking' })
        return
      }

      case 'image':
        if (this.fresh(ev.path)) this.add({ id: uid('i'), kind: 'image', ts: Date.now(), path: ev.path })
        return

      case 'usage':
        this.host.onUsage(this.account.id, ev.usage)
        return

      case 'notice':
        this.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: ev.level, text: ev.text })
        return

      case 'context':
        this.setState({ context: { used: ev.used, max: ev.max } })
        return

      case 'suggestion':
        if (!this.current) this.setState({ suggestion: ev.text })
        return

      case 'turn-end': {
        this.flushDeltas()
        const pending = this.current
        for (const it of this.items) {
          if ('streaming' in it && it.streaming) this.patch(it.id, { streaming: false })
          if (it.kind === 'tool' && it.status === 'running') this.patch(it.id, { status: ev.status === 'done' ? 'done' : 'error' })
        }
        // Empty replies happen (a turn that only used tools); don't leave blank rows.
        if (this.items.some((it) => it.kind === 'assistant' && !it.text.trim())) {
          this.items = this.items.filter((it) => {
            const blank = it.kind === 'assistant' && !it.text.trim()
            if (blank) this.byId.delete(it.id)
            return !blank
          })
        }
        for (const id of [...this.openAsks]) this.host.dropAsk(id)
        this.hidden.clear()
        this.started.clear()
        // A failure the app is about to put right by itself is told as what it is doing about it.
        const retry = ev.status === 'error' && pending ? this.host.retryNote(this, pending, ev) : null
        if (retry) {
          this.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'info', text: retry })
        } else if (ev.status === 'error' && retry === null) {
          const action = pending ? this.host.remedyFor(this, pending, ev) : undefined
          this.add({ id: uid('n'), kind: 'notice', ts: Date.now(), level: 'error', text: this.explain(ev), action })
        }
        const failed = ev.status === 'error' && retry === null
        // The tool steps counted during the turn, kept before the state below forgets them.
        ev.tools = this.state.steps || 0
        this.add({ id: uid('e'), kind: 'turn', ts: Date.now(), status: retry !== null ? 'interrupted' : ev.status, durationMs: ev.durationMs, steps: ev.steps, tokens: ev.tokens, checkpoint: ev.checkpoint, model: this.state.model })
        // A finished reply is the moment to be fully on disk.
        this.unfinished = null
        this.saver.now()
        this.current = null
        this.setState({
          phase: failed ? 'error' : 'idle',
          activity: undefined,
          turnStartedAt: undefined,
          steps: undefined,
          error: failed ? this.explain(ev) : undefined,
        })
        this.idleSince = Date.now()
        if (pending) this.host.onTurnEnd(this, pending, ev)
        if (this.stale) this.recycle()
        if (this.idleTimer) clearTimeout(this.idleTimer)
        if (!this.ended) this.idleTimer = setTimeout(() => this.recycle(), IDLE.closeMs)
        this.pump()
        return
      }

      case 'exit':
        this.runtime?.dispose()
        this.runtime = null
        return
    }
  }

  /**
   * Pictures, sound and video a step just made, put in the chat as they appear, so the person
   * sees how the work is going without opening folders. Only files written during this reply
   * count: something that was merely read is not news.
   */
  private showMade(tool: string, input: unknown, output: string): void {
    const since = (this.state.turnStartedAt || Date.now()) - 3000
    const found: string[] = []
    const add = (p: string): void => {
      const full = path.isAbsolute(p) ? p : path.resolve(this.chat.cwd, p)
      if (MEDIA_EXT.test(full) && !found.includes(full)) found.push(full)
    }
    const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    for (const k of ['file_path', 'path', 'output_path', 'output', 'out', 'filename', 'output_file', 'save_path', 'image_path', 'audio_path', 'video_path']) {
      const v = inp[k]
      if (typeof v === 'string' && v.length < 400) add(v)
    }
    if (Array.isArray(inp.changes)) for (const c of inp.changes as Record<string, unknown>[]) if (typeof c.path === 'string') add(c.path)
    // A command names what it writes, often relative to the working folder.
    if (typeof inp.command === 'string') for (const m of inp.command.matchAll(/[^\s"'`|;&<>]+\.(?:png|jpe?g|gif|webp|svg|mp3|wav|ogg|m4a|aac|flac|opus|mp4|webm|mov)\b/gi)) add(m[0])
    for (const p of mediaPathsIn(output || '')) add(p)
    if (!found.length) return
    // When one picture is named twice (a generator's own folder and a copy in the project), the
    // copy is the one wanted: it goes first, so the content check drops the generator's.
    found.sort((a, b) => Number(/[\\/]generated_images[\\/]/i.test(a)) - Number(/[\\/]generated_images[\\/]/i.test(b)))
    let n = 0
    for (const p of found) {
      if (n >= 8) break
      try {
        const st = fs.statSync(p)
        if (!st.isFile() || st.size === 0 || st.mtimeMs < since) continue
        const key = `${p.toLowerCase()}|${Math.round(st.mtimeMs)}`
        if (this.shown.has(key)) continue
        this.shown.add(key)
        if (!this.fresh(p)) continue
        const k = mediaKind(p)
        this.add({ id: uid('i'), kind: 'image', ts: Date.now(), path: p, media: k === 'audio' || k === 'video' ? k : undefined })
        n++
      } catch {
        /* not there (yet), or not a file */
      }
    }
    void tool
  }

  private explain(ev: TurnEnd): string {
    if (ev.reason === 'limit') return `${this.account.name} has used up its allowance for now. It will be available again when the limit resets.`
    if (ev.reason === 'auth') return `${this.account.name} is signed out. Sign in again from the team panel, then resend.`
    return ev.error || 'Something went wrong and the reply stopped.'
  }

  /** A plain sentence for the approval card: who wants to do what. */
  private askTitle(ask: PermissionAsk): string {
    const who = this.account.name
    if (ask.title) return ask.title.replace(/^Claude\b/, who)
    if (ask.toolName === 'ExitPlanMode') return `${who} has a plan ready for you to approve`
    const s = describeTool(ask.toolName, ask.input)
    switch (s.icon) {
      case 'terminal':
        return `${who} wants to run a command`
      case 'edit':
        return `${who} wants to edit ${s.target || 'a file'}`
      case 'write':
        return `${who} wants to create ${s.target || 'a file'}`
      case 'read':
        return `${who} wants to read ${s.target || 'a file'}`
      case 'web':
        return `${who} wants to go online${s.target ? `: ${s.target}` : ''}`
      case 'plug':
        return `${who} wants to use ${s.target}`
      default:
        return `${who} wants to use ${ask.toolName}`
    }
  }

  askPermission(ask: PermissionAsk): Promise<{ decision: PermissionDecision; note?: string }> {
    const requestId = uid('p')
    const itemId = uid('q')
    this.add({
      id: itemId,
      kind: 'permission',
      ts: Date.now(),
      requestId,
      toolName: ask.toolName,
      title: this.askTitle(ask),
      detail: ask.detail,
      input: trimInput(ask.input),
      canRemember: ask.canRemember,
      status: 'pending',
    })
    const before = { phase: this.state.phase, activity: this.state.activity }
    this.setState({ phase: 'waiting', activity: 'Waiting for your OK' })
    this.host.onAttention(this, `${this.account.name} needs your OK`)
    this.openAsks.add(requestId)
    return new Promise((resolve) => {
      const done = (r: { decision: PermissionDecision; note?: string }, status: string): void => {
        if (!this.openAsks.delete(requestId)) return
        this.patch(itemId, { status })
        if (this.current) this.setState(before)
        resolve(r)
      }
      this.host.registerAsk(requestId, {
        kind: 'permission',
        session: this,
        itemId,
        resolve: (r) => done(r, r.decision === 'deny' ? 'denied' : r.decision === 'always' ? 'always' : 'allowed'),
        expire: () => done({ decision: 'deny' }, 'expired'),
      })
      ask.signal.addEventListener('abort', () => this.host.dropAsk(requestId))
    })
  }

  /**
   * Puts a card in front of the user asking them to sign in to a site in this agent's browser,
   * and waits until they say they have, or skip it. Resolves true when they signed in.
   */
  askSignIn(site: string, url: string, why: string): Promise<boolean> {
    const requestId = uid('p')
    const itemId = uid('q')
    this.add({ id: itemId, kind: 'signin', ts: Date.now(), requestId, site, url, why: why || undefined, status: 'pending' })
    const before = { phase: this.state.phase, activity: this.state.activity }
    this.setState({ phase: 'waiting', activity: `Waiting for you to sign in to ${site}` })
    this.host.onAttention(this, `${this.account.name} needs you to sign in to ${site}`)
    this.openAsks.add(requestId)
    return new Promise((resolve) => {
      const done = (ok: boolean, status: 'done' | 'skipped' | 'expired'): void => {
        if (!this.openAsks.delete(requestId)) return
        this.patch(itemId, { status })
        if (this.current) this.setState(before)
        resolve(ok)
      }
      this.host.registerAsk(requestId, {
        kind: 'question',
        session: this,
        itemId,
        resolve: (answers) => done(!!answers, answers ? 'done' : 'skipped'),
        expire: () => done(false, 'expired'),
      })
    })
  }

  askQuestion(questions: QuestionSpec[], signal: AbortSignal): Promise<Record<string, string> | null> {
    const requestId = uid('p')
    const itemId = uid('q')
    this.add({ id: itemId, kind: 'question', ts: Date.now(), requestId, questions, status: 'pending' })
    const before = { phase: this.state.phase, activity: this.state.activity }
    this.setState({ phase: 'waiting', activity: 'Waiting for your answer' })
    this.host.onAttention(this, `${this.account.name} has a question`)
    this.openAsks.add(requestId)
    return new Promise((resolve) => {
      const done = (answers: Record<string, string> | null, status: string): void => {
        if (!this.openAsks.delete(requestId)) return
        this.patch(itemId, answers ? { status, answers } : { status })
        if (this.current) this.setState(before)
        resolve(answers)
      }
      this.host.registerAsk(requestId, {
        kind: 'question',
        session: this,
        itemId,
        resolve: (answers) => done(answers, answers ? 'answered' : 'expired'),
        expire: () => done(null, 'expired'),
      })
      signal.addEventListener('abort', () => this.host.dropAsk(requestId))
    })
  }
}
