// The guard, engine side: what a run nobody is watching is held to, enforced here and not asked of
// the model. See src/shared/guard.ts for the rule itself.
//
// Four things live here:
//   1. The gate (UnattendedGate): which account an unattended run may use, under daily caps and a
//      keep-free line, so such runs never use up what the user needs for their own chats.
//   2. The run's state, per chat: whether it has read untrusted content, whether it holds private
//      data, whether it was stopped. It only ever gets stricter, and it survives a restart.
//   3. The check every tool call of an unattended run passes: Claude's through a pre-tool hook, the
//      team's own tools through a wrapper, the scripted demo's through the same call. Codex cannot
//      ask before a tool runs, so there the provider's own sandbox does the holding (see codex.ts).
//   4. Approvals bound to one exact call. An ask does not hold the turn open: the call is refused,
//      the agent ends its turn, and when the user says yes that one call (same tool, same input)
//      may be made once before the approval lapses.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Chat, Item } from '@shared/types'
import type { UnattendedCaps, UnattendedGate } from '@shared/watches'
import { APPROVAL_MS, FOLDER_SOURCE, MAX_ASKS_PER_RUN, MAX_OPEN_ASKS, PAGE_GRANT, canonical, cleanCaps, dayOf, decide, grantLine, pickAccount, riskLines, sortTool, type PickAccount, type RunState, type Sorted, type Verdict, type Where } from '@shared/guard'
import type { TeamTool, ToolGate, ToolOutput } from './providers/types'
import { readJson, uid, writeJson } from './util'
import { appendChained } from './trace'

export type { ToolGate }

/** Whose shell is held by a sandbox that has been seen to hold: Codex's own, on every system. Claude's has not been run for real yet, so it gets none. */
export const shellSandboxed = (provider: string | undefined): boolean => provider === 'chatgpt'

export interface Approval {
  requestId: string
  itemId: string
  chatId: string
  agentId: string
  tool: string
  /** SHA-256 over the tool and its input. The one call this approval covers. */
  digest: string
  summary: string
  /** A web request: what using this approval lets the run read from then on (a host, or web search). */
  grant?: string
  dest?: string
  risk: string[]
  createdAt: number
  expiresAt: number
  status: 'pending' | 'allowed' | 'denied' | 'expired' | 'revoked' | 'used'
  usedAt?: number
}

interface Run extends RunState {
  stopped?: boolean
  /** Approvals asked for since the run last began. */
  asks: number
}

interface Stored {
  day: string
  runs: number
  byAccount: Record<string, number>
  chats: Record<string, Run>
  approvals: Approval[]
}

/** What the guard needs of the hub. */
export interface GuardHost {
  dataDir: string
  caps(): Partial<UnattendedCaps> | undefined
  accounts(): PickAccount[]
  chat(chatId: string): Chat | undefined
  /** Folders that hold sign-ins and keys besides the usual ones: the accounts' config folders. */
  secrets(): string[]
  /** Whether an agent's provider keeps its shell inside a sandbox of its own. */
  sandboxed(chatId: string, agentId: string): boolean
  addItem(chatId: string, agentId: string, item: Item): void
  patchItem(chatId: string, agentId: string, itemId: string, patch: Record<string, unknown>): void
  /** Words that reach an agent between turns and start its next one. */
  wake(chatId: string, agentId: string, text: string): void
  /** The user should look: an approval is waiting. */
  attention(chatId: string, agentId: string, what: string): void
  /** A line for the chat's execution trace. */
  trace(chatId: string, rec: Record<string, unknown>): void
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export class Guard implements UnattendedGate {
  /** The time, replaceable in checks (midnight, a lapsed approval). */
  now: () => number = () => Date.now()
  /** How long an approval stands. Replaceable in checks. */
  approvalMs = APPROVAL_MS
  /** Told of every approval as it is asked for, answered, lapses or is taken back. The inbox listens here. */
  onApproval: ((a: Approval, what: 'asked' | 'allowed' | 'denied' | 'expired' | 'revoked') => void) | null = null
  private data: Stored = { day: '', runs: 0, byAccount: {}, chats: {}, approvals: [] }
  /** Runs that were picked and are not yet recorded, by account: when each was picked. */
  private reserved = new Map<string, number[]>()
  private timers = new Map<string, NodeJS.Timeout>()
  private started = false
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private host: GuardHost) {}

  private file(name = 'guard.json'): string {
    return path.join(this.host.dataDir, name)
  }

  start(): void {
    if (this.started) return
    this.started = true
    const raw = readJson<Partial<Stored>>(this.file(), {})
    this.data = {
      day: typeof raw.day === 'string' ? raw.day : '',
      runs: Number(raw.runs) || 0,
      byAccount: raw.byAccount && typeof raw.byAccount === 'object' ? raw.byAccount : {},
      chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {},
      approvals: Array.isArray(raw.approvals) ? raw.approvals.filter((a) => a && typeof a.requestId === 'string') : [],
    }
    this.roll()
    for (const a of this.data.approvals) if (a.status === 'pending' || a.status === 'allowed') this.arm(a)
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.started) writeJson(this.file(), this.data)
  }

  private save(now = false): void {
    if (!this.started) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (now) return void writeJson(this.file(), this.data)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      writeJson(this.file(), this.data)
    }, 150)
    this.saveTimer.unref?.()
  }

  // ----- 1. the gate -----

  caps(): UnattendedCaps {
    return cleanCaps(this.host.caps())
  }

  /** A new local day starts the counters again. */
  private roll(): void {
    const day = dayOf(this.now())
    if (this.data.day === day) return
    this.data.day = day
    this.data.runs = 0
    this.data.byAccount = {}
    this.reserved.clear()
    this.save()
  }

  /** Runs counted against today: the finished ones and those picked and still under way. */
  private used(): { runs: number; byAccount: Record<string, number> } {
    this.roll()
    const cutoff = this.now() - 2 * 60 * 60 * 1000
    const byAccount = { ...this.data.byAccount }
    let open = 0
    for (const [id, list] of this.reserved) {
      const live = list.filter((t) => t > cutoff)
      if (live.length) this.reserved.set(id, live)
      else this.reserved.delete(id)
      byAccount[id] = (byAccount[id] || 0) + live.length
      open += live.length
    }
    return { runs: this.data.runs + open, byAccount }
  }

  pick(prefer?: 'auto' | string): { accountId: string | null; why?: string } {
    const r = pickAccount(this.host.accounts(), prefer, this.used(), this.caps())
    if (r.accountId) this.reserved.set(r.accountId, [...(this.reserved.get(r.accountId) || []), this.now()])
    // A refusal is part of the record: why unattended work did not run.
    else this.log({ t: 'cap', ts: this.now(), prefer: prefer || 'auto', why: r.why })
    return r
  }

  record(accountId: string, used: { ms: number; turns: number; tokens?: number }): void {
    this.roll()
    const list = this.reserved.get(accountId) || []
    list.shift()
    if (list.length) this.reserved.set(accountId, list)
    else this.reserved.delete(accountId)
    this.data.runs++
    this.data.byAccount[accountId] = (this.data.byAccount[accountId] || 0) + 1
    this.log({ t: 'run', ts: this.now(), account: accountId, ms: Math.round(used.ms) || 0, turns: used.turns || 0, tokens: used.tokens })
    this.save(true)
  }

  today(): { runs: number; byAccount: Record<string, number>; caps: UnattendedCaps } {
    return { ...this.used(), caps: this.caps() }
  }

  /** The guard's own record, for what belongs to no chat (cap refusals, finished runs). Chained like the trace. */
  private log(rec: Record<string, unknown>): void {
    try {
      appendChained(this.file('guard.jsonl'), rec)
    } catch {
      /* the record is best effort; the decision stands either way */
    }
  }

  // ----- 2. the run's state -----

  /** Whether a chat is a run nobody is watching. Today: a chat a watch started. (Goals and loops that run while the user is away can be added here.) */
  unattended(chat: Chat | undefined | null): boolean {
    return !!chat && !!(chat as Chat & { watchId?: string }).watchId
  }

  private run(chatId: string): Run {
    let r = this.data.chats[chatId]
    if (!r) {
      r = { untrusted: [], private: false, asks: 0 }
      this.data.chats[chatId] = r
    }
    if (!Array.isArray(r.untrusted)) r.untrusted = []
    return r
  }

  state(chatId: string): RunState & { stopped: boolean } {
    const r = this.data.chats[chatId]
    return { untrusted: [...(r?.untrusted || [])], private: !!r?.private, grants: [...(r?.grants || [])], stopped: !!r?.stopped }
  }

  /**
   * The engine is about to send a run its prompt. A Stop from an earlier run is over, and so is
   * what the user let an earlier run read on the web; what the chat has read is not forgotten.
   * Every unattended run starts out as one that has read untrusted content: `untrusted` names what
   * its prompt was made from (a page, an issue, a changed file a watch looked at), and without one
   * it is FOLDER_SOURCE. So it reaches the web only where the user lets it.
   */
  begin(chatId: string, from: { untrusted?: string } = {}): void {
    const r = this.run(chatId)
    r.stopped = false
    r.asks = 0
    r.grants = []
    if (this.unattended(this.host.chat(chatId))) this.mark(chatId, { cls: 'untrusted', summary: '', untrusted: from.untrusted || FOLDER_SOURCE })
    this.save(true)
  }

  /** The user wrote to the chat themselves: a stopped run may go on. */
  userSpoke(chatId: string): void {
    const r = this.data.chats[chatId]
    if (!r?.stopped) return
    r.stopped = false
    this.save(true)
  }

  /** Whether a stopped unattended run should take nothing more. */
  halted(chatId: string): boolean {
    return !!this.data.chats[chatId]?.stopped && this.unattended(this.host.chat(chatId))
  }

  /** Stop: the run takes nothing more, and approvals it had open or unused are taken back. */
  halt(chatId: string): void {
    const chat = this.host.chat(chatId)
    if (!this.unattended(chat)) return
    this.run(chatId).stopped = true
    for (const a of this.data.approvals) {
      if (a.chatId !== chatId || (a.status !== 'pending' && a.status !== 'allowed')) continue
      this.settle(a, 'revoked')
    }
    this.host.trace(chatId, { t: 'guard', ts: this.now(), v: 'stopped', why: 'The user stopped this run. Open approvals were taken back.' })
    this.save(true)
  }

  forget(chatId: string): void {
    delete this.data.chats[chatId]
    for (const a of this.data.approvals) if (a.chatId === chatId) this.disarm(a.requestId)
    this.data.approvals = this.data.approvals.filter((a) => a.chatId !== chatId)
    this.save()
  }

  /**
   * The app itself put notes from the vault into an unattended run's prompt (recall). They are the
   * user's own and may hold text other people wrote, so the run is marked as if it had read them.
   */
  recalled(chatId: string): void {
    if (!this.unattended(this.host.chat(chatId))) return
    this.mark(chatId, { cls: 'private', summary: '', private: true, untrusted: 'the vault' })
  }

  private mark(chatId: string, s: Sorted): void {
    const r = this.run(chatId)
    let changed = false
    if (s.untrusted && !r.untrusted.includes(s.untrusted)) {
      // The first few sources are kept for the approval card; that it happened is what counts.
      if (r.untrusted.length < 8) r.untrusted.push(s.untrusted)
      else if (!r.untrusted.includes('more')) r.untrusted.push('more')
      changed = true
      if (r.untrusted.length === 1) this.host.trace(chatId, { t: 'guard', ts: this.now(), v: 'marked', c: 'untrusted', why: `The run may have read text other people wrote: ${s.untrusted}` })
    }
    if (s.private && !r.private) {
      r.private = true
      changed = true
      this.host.trace(chatId, { t: 'guard', ts: this.now(), v: 'marked', c: 'private', why: 'The run read private data.' })
    }
    if (changed) this.save()
  }

  /**
   * What a provider reported an agent doing, for runs whose tools the guard cannot check before
   * they run (Codex). Only marks the run; decides nothing.
   */
  observe(chatId: string, agentId: string, tool: string, input: unknown): void {
    const chat = this.host.chat(chatId)
    if (!this.unattended(chat) || /^mcp__team__/.test(tool)) return
    const s = sortTool(tool, this.real(input, chat!.cwd), this.where(chat!, agentId))
    if (s.untrusted || s.private) this.mark(chatId, s)
  }

  // ----- 3. the check -----

  private where(chat: Chat, agentId: string): Where {
    return { cwd: chat.cwd, home: os.homedir(), secrets: [this.host.dataDir, ...this.host.secrets()], sandboxedShell: this.host.sandboxed(chat.id, agentId), windows: process.platform === 'win32' }
  }

  /** A file tool's path as it really is on disk: a link inside the folder that points outside it counts as outside. */
  private real(input: unknown, cwd: string): unknown {
    if (!input || typeof input !== 'object') return input
    const i = { ...(input as Record<string, unknown>) }
    for (const k of ['file_path', 'path', 'notebook_path', 'filePath']) {
      const v = i[k]
      if (typeof v !== 'string' || !v) continue
      let p = path.resolve(cwd, v)
      const tail: string[] = []
      // The file may not exist yet: resolve its nearest folder that does.
      for (let n = 0; n < 64; n++) {
        try {
          p = fs.realpathSync.native(p)
          break
        } catch {
          const up = path.dirname(p)
          if (up === p) break
          tail.unshift(path.basename(p))
          p = up
        }
      }
      i[k] = path.join(p, ...tail)
    }
    return i
  }

  /** The gate a provider gets for an agent in an unattended chat; undefined for every other chat, where nothing changes. */
  gateFor(chatId: string, agentId: string, opts: { network?: boolean } = {}): ToolGate | undefined {
    if (!this.unattended(this.host.chat(chatId))) return undefined
    return { check: (tool, input) => this.check(chatId, agentId, tool, input), shell: this.host.sandboxed(chatId, agentId), network: !!opts.network }
  }

  /** Decides one tool call of an unattended run before it runs. Fails closed: an error here is a refusal. */
  async check(chatId: string, agentId: string, tool: string, input: unknown): Promise<{ allow: boolean; message?: string }> {
    try {
      return this.decideCall(chatId, agentId, tool, input)
    } catch (e) {
      this.host.trace(chatId, { t: 'guard', ts: this.now(), agent: agentId, tool, v: 'denied', why: `The guard failed on this call and refused it: ${(e as Error).message}` })
      return { allow: false, message: 'This call could not be checked, so it was not made. Carry on without it and say so in your report.' }
    }
  }

  private decideCall(chatId: string, agentId: string, tool: string, input: unknown): { allow: boolean; message?: string } {
    const chat = this.host.chat(chatId)
    if (!chat || !this.unattended(chat)) return { allow: true }
    const run = this.run(chatId)
    const note = (v: 'allowed' | 'asked' | 'denied', c: string, why: string, extra: Record<string, unknown> = {}): void => this.host.trace(chatId, { t: 'guard', ts: this.now(), agent: agentId, tool, c, v, why: why || undefined, ...extra })
    if (run.stopped) {
      note('denied', 'stopped', 'The run was stopped by the user.')
      return { allow: false, message: 'This run was stopped by the user. Do nothing more and end your turn.' }
    }
    // A run nobody called begin() for (or one from before this rule) starts untrusted all the same.
    if (!run.untrusted.length) this.mark(chatId, { cls: 'untrusted', summary: '', untrusted: FOLDER_SOURCE })
    const s = sortTool(tool, this.real(input, chat.cwd), this.where(chat, agentId))
    const d = decide(s, run, this.where(chat, agentId))
    if (d.verdict === 'allow') {
      // Marked before the content arrives: from here on the run is one that has read it.
      this.mark(chatId, s)
      note('allowed', s.cls, '')
      return { allow: true }
    }
    if (d.verdict === 'refuse') {
      note('denied', s.cls, d.why)
      return { allow: false, message: d.why }
    }
    // It needs the user's OK. One approval covers one exact call.
    const digest = sha(`${tool}\n${canonical(input)}`)
    this.sweep()
    const known = this.data.approvals.filter((a) => a.chatId === chatId && a.digest === digest).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (known?.status === 'allowed') {
      known.status = 'used'
      known.usedAt = this.now()
      this.disarm(known.requestId)
      // A yes to a web request is a yes to that host (or to web search) for the rest of the run.
      if (known.grant) {
        const g = new Set([...(run.grants || []), known.grant, ...(tool === 'mcp__team__browser' ? [PAGE_GRANT] : [])])
        run.grants = [...g].slice(-40)
        note('allowed', s.cls, `From here on this run may reach: ${known.grant}.`, { approval: known.requestId })
      }
      this.mark(chatId, s)
      note('allowed', s.cls, 'The user approved exactly this call.', { approval: known.requestId })
      this.save(true)
      return { allow: true }
    }
    if (known?.status === 'pending') {
      note('denied', s.cls, 'Still waiting for the user.', { approval: known.requestId })
      return { allow: false, message: `This is still waiting for the user's OK (asked at ${clock(known.createdAt)}). It was not done. Do not try it another way: finish what you can without it and end your turn.` }
    }
    if (known?.status === 'denied') {
      note('denied', s.cls, 'The user said no to exactly this.', { approval: known.requestId })
      return { allow: false, message: 'The user said no to exactly this. It was not done. Do not try it another way.' }
    }
    const open = this.data.approvals.filter((a) => a.chatId === chatId && a.status === 'pending').length
    if (open >= MAX_OPEN_ASKS || run.asks >= MAX_ASKS_PER_RUN) {
      note('denied', s.cls, 'Too many approvals asked for in this run.')
      return { allow: false, message: 'This run has asked for too many approvals, so this was refused without asking. Finish what you can and put the rest in your report.' }
    }
    const state: RunState = { untrusted: [...run.untrusted], private: run.private }
    const lets = grantLine(s, state)
    const a: Approval = { requestId: uid('p'), itemId: uid('q'), chatId, agentId, tool, digest, summary: s.summary, dest: s.dest, grant: lets ? s.web : undefined, risk: [d.why, ...(lets ? [lets] : []), ...riskLines(state)], createdAt: this.now(), expiresAt: this.now() + this.approvalMs, status: 'pending' }
    run.asks++
    this.data.approvals.push(a)
    this.host.addItem(chatId, agentId, { id: a.itemId, kind: 'permission', ts: a.createdAt, requestId: a.requestId, toolName: tool, title: a.summary, detail: a.risk.join(' '), input: this.trim(input), canRemember: false, status: 'pending', unattended: true, expiresAt: a.expiresAt, risk: a.risk } as Item)
    this.host.attention(chatId, agentId, `Needs your OK: ${a.summary}`)
    this.arm(a)
    note('asked', s.cls, d.why, { approval: a.requestId, digest: digest.slice(0, 16), summary: a.summary, expires: a.expiresAt })
    this.onApproval?.(a, 'asked')
    this.save(true)
    return {
      allow: false,
      message: `This needs the user's OK, and nobody is watching this run, so it was not done. The request is in front of them now: "${a.summary}". Do not try it another way. Finish what you can without it, say in your reply what is waiting, and end your turn. If they approve you will be told, and may then make exactly this call once.`,
    }
  }

  private trim(input: unknown): unknown {
    try {
      const s = JSON.stringify(input)
      if (s === undefined || s.length <= 12_000) return input
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}\n… ${v.length - 2000} more characters` : v
      return out
    } catch {
      return undefined
    }
  }

  /**
   * The team's own tools for an agent in an unattended chat, each behind the check. For any other
   * chat the tools come back as they are.
   */
  wrap(chatId: string, agentId: string, tools: TeamTool[]): TeamTool[] {
    if (!this.unattended(this.host.chat(chatId))) return tools
    return tools.map((t) => ({
      ...t,
      run: async (args: Record<string, unknown>): Promise<string | ToolOutput> => {
        const r = await this.check(chatId, agentId, `mcp__team__${t.name}`, args)
        if (!r.allow) return { text: r.message || 'Not allowed in a run nobody is watching.', isError: true }
        return t.run(args)
      },
    }))
  }

  // ----- 4. approvals -----

  pending(): Approval[] {
    this.sweep()
    return this.data.approvals.filter((a) => a.status === 'pending').map((a) => ({ ...a }))
  }

  private arm(a: Approval): void {
    this.disarm(a.requestId)
    const t = setTimeout(() => this.sweep(), Math.max(0, Math.min(a.expiresAt - this.now(), 2 ** 31 - 1)) + 25)
    t.unref?.()
    this.timers.set(a.requestId, t)
  }
  private disarm(requestId: string): void {
    const t = this.timers.get(requestId)
    if (t) clearTimeout(t)
    this.timers.delete(requestId)
  }

  /** Approvals past their time lapse: the request is closed, and the run is told once. */
  private sweep(): void {
    const now = this.now()
    for (const a of this.data.approvals) {
      if ((a.status !== 'pending' && a.status !== 'allowed') || a.expiresAt > now) continue
      const answered = a.status === 'allowed'
      this.settle(a, 'expired')
      const stopped = !!this.data.chats[a.chatId]?.stopped
      if (!stopped) this.host.wake(a.chatId, a.agentId, `<approval status="lapsed">\nNobody ${answered ? 'used' : 'answered'} this in time, so it lapsed and was not done: ${a.summary}. Treat it as declined. Do not try it another way; say so in your report.\n</approval>`)
    }
    // Old, settled approvals are not kept for ever.
    const keep = now - 7 * 86400e3
    this.data.approvals = this.data.approvals.filter((a) => a.status === 'pending' || a.status === 'allowed' || a.createdAt > keep)
  }

  private settle(a: Approval, to: 'allowed' | 'denied' | 'expired' | 'revoked'): void {
    a.status = to
    if (to !== 'allowed') this.disarm(a.requestId)
    this.host.patchItem(a.chatId, a.agentId, a.itemId, { status: to === 'allowed' ? 'allowed' : to === 'denied' ? 'denied' : 'expired' })
    this.host.trace(a.chatId, { t: 'guard', ts: this.now(), agent: a.agentId, tool: a.tool, v: to, approval: a.requestId, why: a.summary })
    this.onApproval?.(a, to)
    this.save(true)
  }

  /**
   * The user's answer to an approval of the guard's. True when the request was one of ours (the
   * hub then looks no further). "Always" is not offered for unattended runs: it counts as this once.
   */
  answer(requestId: string, decision: 'allow' | 'always' | 'deny', note?: string): boolean {
    const a = this.data.approvals.find((x) => x.requestId === requestId)
    if (!a) return false
    this.sweep()
    if (a.status !== 'pending') return true
    const stopped = !!this.data.chats[a.chatId]?.stopped
    if (decision === 'deny') {
      this.settle(a, 'denied')
      if (!stopped) this.host.wake(a.chatId, a.agentId, `<approval status="declined">\nThe user said no: ${a.summary}.${note ? ` They added: ${note}` : ''} It was not done. Do not try it another way. Carry on without it, or finish your report.\n</approval>`)
      return true
    }
    this.settle(a, 'allowed')
    if (!stopped) this.host.wake(a.chatId, a.agentId, `<approval status="approved">\nThe user approved: ${a.summary}. Make exactly that call now, with exactly the same input as before. The approval covers that one call, once, until ${clock(a.expiresAt)}; anything different will be asked again.\n</approval>`)
    return true
  }
}
