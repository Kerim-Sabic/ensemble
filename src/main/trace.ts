// Writes a chat's execution trace (chats/<id>/trace.jsonl) from what the hub already knows: every
// event the window is told, and each turn as it starts. Nothing here may slow a turn or fail one:
// writes are queued per chat, errors are swallowed and counted, and text is clipped and cleaned of
// anything that looks like a secret before it reaches the disk.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Account, Chat, HubEvent, Item, Task } from '@shared/types'
import { commandOf, evidenceOf, inputLine, pathsOf, redact, replySpan, runOf, runSummary, urlOf, NO_EVIDENCE, type Evidence, type EvidenceRef, type TraceRecord } from '@shared/trace'

/** A trace file is started afresh past this size; the one before it is kept, so a chat holds at most twice this. */
export const TRACE_MAX_BYTES = 4 * 1024 * 1024
/**
 * How many full files a chat keeps besides the one being written (trace.1.jsonl is the newest of
 * them): 4 MB each, so 20 MB in all, which holds the start of all but the very largest runs.
 */
export const TRACE_KEEP_FILES = 4
/** Files larger than this are not hashed. */
const HASH_MAX_BYTES = 4 * 1024 * 1024

/** What the tracer asks the hub for. */
export interface TraceHost {
  dataDir: string
  chat(id: string): Chat | undefined
  /** An account, or an agent started in a chat, by id. */
  who(id: string): Account | undefined
  /** The rows of one agent in a chat, to find what it said last. */
  items(chatId: string, accountId: string): Item[]
  tasks(chatId: string): Task[]
}

export interface TurnStart {
  chatId: string
  agent: Account
  depth: number
  kind: Extract<TraceRecord, { t: 'turn-start' }>['kind']
  taskId?: string
  model?: string | null
  effort?: string | null
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ----- the chain -----
// Every record carries `h`: a hash over the link of the record before it and its own text. Change,
// remove, add or reorder a line and the links stop adding up from that line on, which `verifyTrace`
// reports. It shows that a trace was edited; it does not stop someone who can write the file from
// rewriting all of it, or from cutting records off its end (there is no key, and nothing is kept
// anywhere else).

const LINK = /,"h":"([0-9a-f]{32})"\}$/
const sha32 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32)

/** A record's line with its link to the one before it. */
function link(body: string, tip: string): string {
  return `${body.slice(0, -1)},"h":"${sha32(`${tip}\n${body}`)}"}`
}

/** What the next record is chained to: this line's link, or for a line written before there were links, a hash of it. */
function tipOf(line: string): string {
  return LINK.exec(line)?.[1] ?? sha32(line)
}

/** The last line of a file. `open` when the file does not end with a line break (a write cut short). */
function lastLine(file: string): { line: string; open: boolean } | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    if (!size) return null
    for (let span = 64 * 1024; ; span *= 8) {
      const from = Math.max(0, size - span)
      const buf = Buffer.alloc(size - from)
      fs.readSync(fd, buf, 0, buf.length, from)
      const text = buf.toString('utf8')
      const open = !text.endsWith('\n')
      const body = open ? text : text.slice(0, -1)
      const at = body.lastIndexOf('\n')
      if (at >= 0 || from === 0) return { line: body.slice(at + 1), open }
    }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

const fileTips = new Map<string, string>()

/** Appends one chained record to a file of its own (the guard's record of what belongs to no chat). */
export function appendChained(file: string, rec: Record<string, unknown>): void {
  let tip = fileTips.get(file)
  let glue = ''
  if (tip === undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const end = lastLine(file)
    tip = end ? tipOf(end.line) : ''
    if (end?.open) glue = '\n'
  }
  const line = link(JSON.stringify(rec), tip)
  try {
    fs.appendFileSync(file, `${glue}${line}\n`)
    fileTips.set(file, tipOf(line))
  } catch (e) {
    fileTips.delete(file)
    throw e
  }
}

export interface ChainReport {
  /** False when a link does not add up. */
  ok: boolean
  /** Records read, and how many of them carry a link. */
  records: number
  linked: number
  /** The first record that does not fit: its file and line (counted from 1). */
  file?: string
  line?: number
  why?: string
}

/**
 * Checks the chain over one file or several in the order they were written (oldest first). Files
 * that are not there are passed over. `whole` says the first file is where the record began, so
 * its first record must be the start of the chain; without it the start is taken on trust (older
 * records may have been rotated away). Records written before there were links are counted, not
 * failed: a linked record after them still vouches for the text before it.
 */
export function verifyTrace(files: string | string[], opts: { whole?: boolean } = {}): ChainReport {
  let tip: string | null = opts.whole ? '' : null
  let records = 0
  let linked = 0
  for (const file of Array.isArray(files) ? files : [files]) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      records++
      const m = LINK.exec(line)
      if (!m) {
        if (linked) {
          // After the chain began every record is linked, bar a last line cut short by a crash.
          const last = lines.slice(i + 1).every((l) => !l)
          if (!last) return { ok: false, records, linked, file, line: i + 1, why: 'This record has no link, though the records around it do: it was added or changed after it was written.' }
        }
        tip = sha32(line)
        continue
      }
      linked++
      const body = `${line.slice(0, m.index)}}`
      if (tip !== null && m[1] !== sha32(`${tip}\n${body}`)) {
        return { ok: false, records, linked, file, line: i + 1, why: 'This record does not fit the one before it: it was changed, or records before it were removed, added or reordered.' }
      }
      tip = m[1]
    }
  }
  return { ok: true, records, linked }
}

export class Tracer {
  /** One line of writes per chat, so records land in the order they happened. */
  private lines = new Map<string, Promise<void>>()
  private sizes = new Map<string, number>()
  /** The link of the last record written for each chat: the next one is chained to it. */
  private tips = new Map<string, string>()
  /** Steps under way: what they were called with, until they end. */
  private open = new Map<string, { chatId: string; agent: string; name: string; input: unknown; ts: number }>()
  /** The last status written for each task, so only changes are written. */
  private taskSeen = new Map<string, string>()
  /** Writes that failed, for the checks and the log. Tracing never throws. */
  failures = 0
  /** Set in checks to make every write fail. */
  breakWrites = false

  constructor(
    private host: TraceHost,
    /** The size a trace file may reach before it is started afresh. Smaller in checks. */
    private maxBytes = TRACE_MAX_BYTES,
  ) {}

  /** The file being written, or (`old`: 1 = the newest kept, up to TRACE_KEEP_FILES; true means 1) a kept older one. */
  file(chatId: string, old: boolean | number = false): string {
    const n = old === true ? 1 : old || 0
    return path.join(this.host.dataDir, 'chats', chatId, n ? `trace.${n}.jsonl` : 'trace.jsonl')
  }

  /** A decision of the guard about an unattended run: what was allowed, asked, refused, approved or stopped. */
  guard(chatId: string, rec: Omit<Extract<TraceRecord, { t: 'guard' }>, 't'>): void {
    try {
      this.write(chatId, { ...rec, t: 'guard', why: rec.why ? clip(redact(rec.why), 400) : undefined, summary: rec.summary ? clip(redact(rec.summary), 300) : undefined })
    } catch {
      this.failures++
    }
  }

  /** Whether a chat's trace is still what was written: every record is linked to the one before it. */
  async verify(chatId: string): Promise<ChainReport> {
    await this.flush(chatId)
    return verifyTrace([...Array.from({ length: TRACE_KEEP_FILES }, (_, i) => this.file(chatId, TRACE_KEEP_FILES - i)), this.file(chatId)], { whole: !fs.existsSync(this.file(chatId, TRACE_KEEP_FILES)) })
  }

  private write(chatId: string, rec: TraceRecord): void {
    let body: string
    try {
      body = JSON.stringify(rec)
    } catch {
      this.failures++
      return
    }
    const prev = this.lines.get(chatId) || Promise.resolve()
    const next = prev
      .then(async () => {
        if (this.breakWrites) throw new Error('trace writes are switched off')
        const file = this.file(chatId)
        let size = this.sizes.get(chatId)
        let tip = this.tips.get(chatId)
        let glue = ''
        if (size === undefined || tip === undefined) {
          await fs.promises.mkdir(path.dirname(file), { recursive: true })
          size = await fs.promises.stat(file).then(
            (s) => s.size,
            () => 0,
          )
          // Where the chain stands: the last record on disk, in this file or the one kept before it.
          const here = lastLine(file)
          const end = here ?? lastLine(this.file(chatId, 1))
          tip = end ? tipOf(end.line) : ''
          // A line cut short by a crash stays a line of its own.
          if (here?.open) glue = '\n'
        }
        const linked = link(body, tip)
        if (size + linked.length + 1 > this.maxBytes) glue = ''
        const line = `${glue}${linked}\n`
        this.tips.set(chatId, tipOf(linked))
        if (size + line.length > this.maxBytes) {
          // The full file joins the kept ones (newest as trace.1); only the oldest beyond TRACE_KEEP_FILES goes.
          await fs.promises.rm(this.file(chatId, TRACE_KEEP_FILES), { force: true }).catch(() => undefined)
          for (let n = TRACE_KEEP_FILES - 1; n >= 1; n--) await fs.promises.rename(this.file(chatId, n), this.file(chatId, n + 1)).catch(() => undefined)
          await fs.promises.rename(file, this.file(chatId, 1)).catch(() => fs.promises.rm(file, { force: true }))
          size = 0
        }
        await fs.promises.appendFile(file, line)
        this.sizes.set(chatId, size + Buffer.byteLength(line))
      })
      .catch((e) => {
        // The record did not land: the chain is read from the disk again before the next one.
        this.tips.delete(chatId)
        this.failures++
        if (this.failures <= 3) console.error('[trace]', (e as Error).message)
      })
    this.lines.set(chatId, next)
  }

  /** Everything queued for a chat (or every chat) is on disk. For closing the app, and for checks. */
  async flush(chatId?: string): Promise<void> {
    if (chatId) await this.lines.get(chatId)
    else await Promise.all([...this.lines.values()])
  }

  forget(chatId: string): void {
    this.lines.delete(chatId)
    this.sizes.delete(chatId)
    this.tips.delete(chatId)
    for (const [id, o] of this.open) if (o.chatId === chatId) this.open.delete(id)
    for (const k of this.taskSeen.keys()) if (k.startsWith(`${chatId}\u0000`)) this.taskSeen.delete(k)
  }

  // ----- what the hub tells -----

  turnStart(t: TurnStart): void {
    try {
      const chat = this.host.chat(t.chatId)
      if (!chat) return
      const a = t.agent
      this.write(t.chatId, {
        t: 'turn-start',
        ts: Date.now(),
        agent: a.id,
        name: a.name,
        by: a.spawned?.by,
        depth: t.depth,
        kind: t.kind,
        task: t.taskId,
        model: t.model || a.model || undefined,
        effort: t.effort || a.effort || undefined,
        permission: chat.permission,
        session: chat.sessions?.[a.id]?.providerSessionId,
        provider: a.provider,
      })
    } catch {
      this.failures++
    }
  }

  /** Every event the hub sends the window passes through here; most are not the trace's business. */
  hubEvent(ev: HubEvent): void {
    try {
      if (ev.type === 'item') this.item(ev.chatId, ev.accountId, ev.item)
      else if (ev.type === 'item-patch') this.patch(ev.chatId, ev.accountId, ev.id, ev.patch)
      else if (ev.type === 'task') this.task(ev.task)
      else if (ev.type === 'chat-removed') this.forget(ev.chatId)
    } catch {
      this.failures++
    }
  }

  private item(chatId: string, agent: string, it: Item): void {
    switch (it.kind) {
      case 'tool':
        if (it.status === 'running') this.open.set(it.id, { chatId, agent, name: it.name, input: it.input, ts: it.ts })
        else this.tool(chatId, agent, it.id, it.name, it.input, it.status === 'done', it.durationMs, it.output, it.ts)
        return
      case 'turn': {
        // What it said last, from the rows of this reply.
        const rows = this.host.items(chatId, agent)
        let said = ''
        // A turn that ended with an error: the line the app showed the person about it.
        let error = ''
        for (let i = rows.length - 1; i >= 0 && i >= rows.length - 60; i--) {
          const r = rows[i]
          if (r.kind === 'turn' && r.id !== it.id) break
          if (it.status === 'error' && !error && r.kind === 'notice' && r.level === 'error') error = r.text
          if (r.kind === 'assistant' && r.text.trim() && !said) said = r.text
          if (said && (error || it.status !== 'error')) break
        }
        this.write(chatId, { t: 'turn-end', ts: Date.now(), agent, item: it.id, status: it.status, ms: it.durationMs, steps: it.steps, tokens: it.tokens, model: it.model, said: said ? clip(redact(said), 1600) : undefined, error: error ? clip(redact(error), 300) : undefined })
        return
      }
      case 'auto':
        this.write(chatId, { t: 'auto', ts: it.ts, agent, of: it.of, event: it.event, title: clip(it.title, 200), text: it.text ? clip(redact(it.text), 600) : undefined, round: it.round, max: it.max })
        return
      case 'image':
        this.write(chatId, { t: 'made', ts: it.ts, agent, path: it.path, media: it.media })
        return
      case 'permission':
        this.write(chatId, { t: 'ask', ts: it.ts, agent, what: 'permission', title: clip(redact(`${it.title}${it.detail ? `: ${it.detail}` : ''}`), 300) })
        return
    }
  }

  private patch(chatId: string, agent: string, id: string, patch: Record<string, unknown>): void {
    if (patch.input !== undefined) {
      const o = this.open.get(id)
      if (o) o.input = patch.input
    }
    const status = patch.status
    if (status === 'done' || status === 'error') {
      const o = this.open.get(id)
      if (o) {
        this.open.delete(id)
        this.tool(chatId, agent, id, o.name, o.input, status === 'done', typeof patch.durationMs === 'number' ? patch.durationMs : undefined, typeof patch.output === 'string' ? patch.output : undefined, o.ts)
      }
    } else if (status === 'allowed' || status === 'always' || status === 'denied' || status === 'expired') {
      this.write(chatId, { t: 'ask', ts: Date.now(), agent, what: 'permission', title: id, answer: String(status) })
    }
  }

  private tool(chatId: string, agent: string, id: string, name: string, input: unknown, ok: boolean, ms: number | undefined, output: string | undefined, ts: number): void {
    const command = commandOf(name, input)
    const paths = pathsOf(name, input)
    const what = command ? runOf(command) : null
    const rec: Extract<TraceRecord, { t: 'tool' }> = { t: 'tool', ts: ts + (ms || 0), agent, id, name, input: inputLine(name, input), ok, ms }
    if (command) rec.command = command
    if (paths.length) {
      rec.paths = paths
      if (ok) rec.hashes = paths.map((p) => this.hash(chatId, p))
    }
    if (what) rec.run = { what, passed: ok, summary: output ? runSummary(output) : undefined }
    const url = urlOf(name, input)
    if (url) rec.url = url
    if (!ok && output) rec.tail = clip(redact(output.slice(-600)).replace(/\s+/g, ' ').trim(), 400)
    this.write(chatId, rec)
  }

  /** A short hash of a file as it stands now. null when it is not there, too large or cannot be read. */
  private hash(chatId: string, p: string): string | null {
    try {
      const cwd = this.host.chat(chatId)?.cwd || ''
      const full = path.isAbsolute(p) ? p : path.resolve(cwd, p)
      const st = fs.statSync(full)
      if (!st.isFile() || st.size > HASH_MAX_BYTES) return null
      return createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)
    } catch {
      return null
    }
  }

  private task(t: Task): void {
    const key = `${t.status}|${(t.waitingOn || []).join(',')}|${t.to}|${t.ranOn || ''}|${t.result ? t.result.length : 0}`
    // Task ids start again at t1 in every chat: the chat is part of what identifies one.
    const seen = `${t.chatId}\u0000${t.id}`
    if (this.taskSeen.get(seen) === key) return
    this.taskSeen.set(seen, key)
    // A task its owner started for part of its own work: the owner's own task is the parent.
    const parent = this.host.tasks(t.chatId).find((x) => x.to === t.from && x.id !== t.id && (x.status === 'running' || x.status === 'queued'))?.id
    // A finished task keeps what its owner reported: a reviewer's findings are evidence of their own.
    const result = (t.status === 'done' || t.status === 'failed') && t.result ? clip(redact(t.result), 1600) : undefined
    this.write(t.chatId, { t: 'task', ts: Date.now(), id: t.id, from: t.from, to: t.to, title: clip(t.title, 200), status: t.status, waitingOn: t.waitingOn?.length ? t.waitingOn : undefined, model: t.ranOn || t.model, effort: t.effort, retried: t.retried || undefined, parent, result })
  }

  // ----- reading it back -----

  /** A chat's records, oldest first, with the kept older file in front. Damaged lines are skipped. */
  async read(chatId: string, q: { agent?: string; since?: number; until?: number; limit?: number } = {}): Promise<TraceRecord[]> {
    await this.flush(chatId)
    const out: TraceRecord[] = []
    // The kept older files first, oldest first, then the one being written.
    const files = [...Array.from({ length: TRACE_KEEP_FILES }, (_, i) => this.file(chatId, TRACE_KEEP_FILES - i)), this.file(chatId)]
    for (const f of files) {
      let text = ''
      try {
        text = await fs.promises.readFile(f, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const r = JSON.parse(line) as TraceRecord
          if (q.since && r.ts < q.since) continue
          if (q.until && r.ts > q.until) continue
          if (q.agent && 'agent' in r && r.agent !== q.agent) continue
          out.push(r)
        } catch {
          /* a line cut short by a crash */
        }
      }
    }
    return q.limit && out.length > q.limit ? out.slice(-q.limit) : out
  }

  /** An agent and whoever it started (and they started) in a stretch of the trace. */
  private family(recs: TraceRecord[], owner: string, from: number, to: number): Set<string> {
    const agents = new Set<string>([owner])
    for (let grew = true; grew; ) {
      grew = false
      for (const r of recs) {
        if (r.t === 'turn-start' && r.by && agents.has(r.by) && !agents.has(r.agent) && r.ts >= from && r.ts <= to) {
          agents.add(r.agent)
          grew = true
        }
      }
    }
    return agents
  }

  /** What changed, what ran, what passed and what is still uncertain, for a reply, a task or the chat's goal. */
  async evidence(chatId: string, ref: EvidenceRef): Promise<Evidence> {
    const recs = await this.read(chatId)
    if (!recs.length) return NO_EVIDENCE
    const nameOf = (id: string): string => this.host.who(id)?.name || id
    if (ref.kind === 'turn') {
      const span = replySpan(recs, ref.accountId, ref.itemId)
      if (!span) return NO_EVIDENCE
      // What follows a lead's reply until the lead's next turn belongs to it: the work it handed
      // out, the goal's check that judges it, and a Stop that cut that work short. A teammate's
      // reply ends where it ends, apart from a goal's check.
      const at = recs.findIndex((r) => r.t === 'turn-end' && r.agent === ref.accountId && r.item === ref.itemId)
      let next = -1
      for (let i = at + 1; i < recs.length; i++) {
        const r = recs[i]
        if (r.t === 'turn-start' && r.agent === ref.accountId) {
          next = i
          break
        }
        if (span.own && r.t === 'auto' && r.of === 'goal' && (r.event === 'met' || r.event === 'check')) {
          span.to = r.ts
          break
        }
      }
      if (!span.own) span.to = next >= 0 ? recs[next].ts - 1 : Math.max(span.to, recs[recs.length - 1].ts)
      // The lead's reply stands for the whole team's work; a teammate's stands for its own and its helpers'.
      return evidenceOf(recs, span.from, span.to, nameOf, span.own ? this.family(recs, ref.accountId, span.from, span.to) : undefined, { reply: ref.itemId })
    }
    if (ref.kind === 'task') {
      const mine = recs.filter((r) => r.t === 'task' && r.id === ref.taskId) as Extract<TraceRecord, { t: 'task' }>[]
      if (!mine.length) return NO_EVIDENCE
      // The turn that works on it starts a moment before the task is marked as running.
      const began = recs.find((r) => r.t === 'turn-start' && r.task === ref.taskId)?.ts
      const start = Math.min(began ?? Infinity, mine.find((r) => r.status === 'running')?.ts ?? mine[0].ts)
      const end = [...mine].reverse().find((r) => r.status === 'done' || r.status === 'failed' || r.status === 'cancelled' || r.status === 'interrupted')?.ts ?? Date.now()
      // The owner, and whoever it started while the task ran.
      return evidenceOf(recs, start, end, nameOf, this.family(recs, mine[mine.length - 1].to, start, end))
    }
    // The goal: from the last time one was set.
    let from = 0
    for (const r of recs) if (r.t === 'auto' && r.of === 'goal' && r.event === 'set') from = r.ts
    if (!from) return NO_EVIDENCE
    const over = recs.find((r) => r.t === 'auto' && r.of === 'goal' && r.ts > from && (r.event === 'met' || r.event === 'stopped'))
    return evidenceOf(recs, from, over ? over.ts : Date.now(), nameOf)
  }
}
