// Shared projects, the engine side. See src/shared/rooms.ts for what a shared project is.
//
// There is no server of ours. The person who shares is the host: their "Phone and remote" server
// carries the traffic under /rooms/, and the join code carries where to find it and a secret.
//   - Joining: the request is sealed (AES-256-GCM) with a key made from the code's secret, which is
//     never sent. Only someone holding the code can make a join the host can open. The answer, sealed
//     the same way, hands the new member a credential of its own.
//   - After that every request and answer is sealed with a key made from that member's credential, so
//     the host knows who is calling, can cut one member off without touching the others, and what
//     crosses the network cannot be read or changed on the way, even over plain Wi-Fi.
//   - A member asks the host for what is new and hands over its own writes in one call ("sync"),
//     which the host holds open for a few seconds when there is nothing new. Writes made while the
//     host cannot be reached wait in an outbox and go out on reconnect.
// Nothing that arrives from the other side is ever more than text: notes for the shared memory and
// messages that reach the lead wrapped as another person's words (wrapIncoming in shared/rooms.ts).
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Account, Chat } from '@shared/types'
import { ROOM_LIMITS, cleanName, cleanText, makeJoinCode, readJoinCode, searchNotes, wrapIncoming, wrapNotes, type ChatShared, type RoomInfo, type RoomMessage, type RoomNote, type RoomPerson } from '@shared/rooms'
import type { RemoteCall, RemoteServer } from './remote'
import type { TeamTool } from './providers/types'
import { readJson, uid, writeJson } from './util'

/** What the shared projects need from the hub. */
export interface RoomsHost {
  dataDir: string
  remote: RemoteServer
  /** Switches "Phone and remote" on (and remembers it). True when the server is listening afterwards. */
  remoteOn(): Promise<boolean>
  hasChat(chatId: string): boolean
  /** A new chat for a project that was joined. */
  sharedChat(name: string): Chat
  /** Marks a chat as shared (or no longer), for the window. */
  markShared(chatId: string, shared: ChatShared | null): void
  /** A row in the chat's lead transcript; with `text`, that text also reaches the lead between turns. */
  deliver(chatId: string, row: string, text?: string, from?: string): void
}

interface Member {
  id: string
  name: string
  credential: string
  joinedAt: number
  lastSeen: number
}
type RoomEvent = { seq: number; at: number } & ({ kind: 'note'; note: RoomNote } | { kind: 'message'; message: RoomMessage } | { kind: 'people' })
interface Hosted {
  id: string
  chatId: string
  name: string
  me: string
  secret: string
  createdAt: number
  members: Member[]
  notes: RoomNote[]
  log: RoomEvent[]
  seq: number
}
type Op = { id: string; at: number } & ({ kind: 'note'; title: string; body: string; agent?: string } | { kind: 'message'; text: string; agent?: string } | { kind: 'leave' })
interface Joined {
  id: string
  chatId: string
  name: string
  me: string
  addresses: string[]
  memberId: string
  credential: string
  cursor: number
  notes: RoomNote[]
  people: RoomPerson[]
  outbox: Op[]
  state: RoomInfo['state']
  detail?: string
  /** Message ids already shown, so one that arrives twice is shown once. */
  seen: string[]
}
interface Stored {
  hosted: Hosted[]
  joined: Joined[]
}

// ----- sealing -----

const keyOf = (secret: string, projectId: string): Buffer => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(projectId, 'utf8'), 'ensemble-shared-project-v1', 32))
interface Sealed {
  n: string
  c: string
}
export function seal(key: Buffer, data: unknown): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { n: iv.toString('base64url'), c: body.toString('base64url') }
}
/** Opens what was sealed with the same key. Null when it was sealed with another key or changed on the way. */
export function unseal<T>(key: Buffer, s: unknown): T | null {
  try {
    const { n, c } = s as Sealed
    if (typeof n !== 'string' || typeof c !== 'string') return null
    const iv = Buffer.from(n, 'base64url')
    const body = Buffer.from(c, 'base64url')
    if (iv.length !== 12 || body.length < 17) return null
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAuthTag(body.subarray(body.length - 16))
    return JSON.parse(Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString('utf8')) as T
  } catch {
    return null
  }
}

/** A plain refusal a member's app can read without a key (it carries nothing but the reason). */
class Refuse extends Error {
  constructor(
    readonly status: number,
    readonly reason: 'gone' | 'ended' | 'removed' | 'refused' | 'full' | 'busy',
  ) {
    super(reason)
  }
}

const within = (list: number[], max: number, ms: number): boolean => {
  const now = Date.now()
  while (list.length && now - list[0] > ms) list.shift()
  if (list.length >= max) return false
  list.push(now)
  return true
}

export class Rooms {
  /** Timing, replaceable in checks: how long the host holds a sync open, and how a member retries. */
  tuning = { waitMs: 8_000, retryMs: 2_000, maxRetryMs: 15_000, timeoutMs: 10_000 }
  private data: Stored = { hosted: [], joined: [] }
  private saveTimer: NodeJS.Timeout | null = null
  private started = false
  private disposed = false
  /** host: sync calls held open, by project. */
  private waiters = new Map<string, Set<{ member: string; done: (r: 'news' | 'removed' | 'ended') => void }>>()
  /** host: request ids seen lately, by member, so a recorded request cannot be played again. */
  private replays = new Map<string, Map<string, number>>()
  /** How often each side wrote lately: by project and person. */
  private rates = new Map<string, number[]>()
  /** member: the loop of each joined project, and a one-off push under way. */
  private loops = new Map<string, { stop: () => void; kick: () => void }>()

  constructor(private host: RoomsHost) {}

  private file(): string {
    return path.join(this.host.dataDir, 'rooms.json')
  }

  /** Reads what was shared and joined before, answers on the remote server, and reconnects. */
  start(): void {
    if (this.started) return
    this.started = true
    const raw = readJson<Partial<Stored>>(this.file(), {})
    this.data = { hosted: Array.isArray(raw.hosted) ? raw.hosted.filter((r) => r && typeof r.id === 'string') : [], joined: Array.isArray(raw.joined) ? raw.joined.filter((r) => r && typeof r.id === 'string') : [] }
    this.host.remote.route('/rooms/', (call) => this.serve(call), { auth: 'own' })
    for (const r of this.data.hosted) this.mark(r.chatId)
    for (const r of this.data.joined) {
      if (r.state === 'connected' || r.state === 'connecting') r.state = 'offline'
      this.mark(r.chatId)
      if (this.live(r)) this.run(r)
    }
    // A project that is being shared needs the server. Sharing switched "Phone and remote" on and the app
    // remembers that, so it comes back on with the app; when the user has switched it off since, that stands,
    // and the share dialog says nobody can reach this computer.
  }

  dispose(): void {
    this.disposed = true
    for (const l of this.loops.values()) l.stop()
    this.loops.clear()
    for (const set of this.waiters.values()) for (const w of [...set]) w.done('ended')
    this.waiters.clear()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.started) writeJson(this.file(), this.data)
  }

  private save(now = false): void {
    if (this.disposed) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (now) writeJson(this.file(), this.data)
    else {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null
        writeJson(this.file(), this.data)
      }, 200)
      this.saveTimer.unref?.()
    }
  }

  private live(r: Joined): boolean {
    return r.state !== 'removed' && r.state !== 'ended' && r.state !== 'left'
  }

  // ----- what the window and the agents see -----

  private hostedOf(chatId: string): Hosted | undefined {
    return this.data.hosted.find((r) => r.chatId === chatId)
  }
  private joinedOf(chatId: string): Joined | undefined {
    return this.data.joined.find((r) => r.chatId === chatId)
  }

  /** Whether a chat is in a shared project that is still going. */
  shared(chatId: string): { name: string; people: string[] } | null {
    const h = this.hostedOf(chatId)
    if (h) return { name: h.name, people: h.members.map((m) => m.name) }
    const j = this.joinedOf(chatId)
    if (j && this.live(j)) return { name: j.name, people: j.people.filter((p) => !p.me).map((p) => p.name) }
    return null
  }

  private online(at: number): boolean {
    return Date.now() - at < Math.max(60_000, this.tuning.waitMs * 3)
  }

  private peopleOf(h: Hosted, me?: string): RoomPerson[] {
    return [
      { id: 'host', name: h.me, host: true, me: !me, joinedAt: h.createdAt, online: true },
      ...h.members.map((m) => ({ id: m.id, name: m.name, me: m.id === me, joinedAt: m.joinedAt, online: this.online(m.lastSeen) })),
    ]
  }

  private codeOf(h: Hosted): string {
    const info = this.host.remote.info()
    const a = info.addresses.map((x) => x.url.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    return makeJoinCode({ p: h.id, n: h.name, a: a.length ? a : [`127.0.0.1:${info.port || 0}`], s: h.secret })
  }

  info(chatId: string): RoomInfo | null {
    const h = this.hostedOf(chatId)
    if (h) {
      const remote = this.host.remote.info()
      return {
        projectId: h.id,
        chatId,
        name: h.name,
        role: 'host',
        state: remote.listening ? 'connected' : 'offline',
        detail: remote.listening ? undefined : remote.error || '"Phone and remote" is switched off, so nobody can reach this computer.',
        code: remote.listening ? this.codeOf(h) : undefined,
        addresses: remote.addresses,
        people: this.peopleOf(h),
        notes: [...h.notes].sort((a, b) => b.at - a.at),
        waiting: 0,
      }
    }
    const j = this.joinedOf(chatId)
    if (!j) return null
    const pending: RoomNote[] = j.outbox.flatMap((o) => (o.kind === 'note' ? [{ id: o.id, title: o.title, body: o.body, by: j.me, agent: o.agent, at: o.at, pending: true }] : []))
    return {
      projectId: j.id,
      chatId,
      name: j.name,
      role: 'member',
      state: j.state,
      detail: j.detail,
      people: j.people,
      notes: [...pending, ...j.notes].sort((a, b) => b.at - a.at),
      waiting: j.outbox.length,
    }
  }

  list(): RoomInfo[] {
    return [...this.data.hosted.map((r) => r.chatId), ...this.data.joined.map((r) => r.chatId)].map((id) => this.info(id)).filter((x): x is RoomInfo => !!x)
  }

  private mark(chatId: string): void {
    if (!this.host.hasChat(chatId)) return
    const i = this.info(chatId)
    const gone = !i || i.state === 'removed' || i.state === 'ended' || i.state === 'left'
    this.host.markShared(chatId, gone || !i ? null : { projectId: i.projectId, role: i.role, name: i.name, people: i.people.filter((p) => !p.me).map((p) => p.name), connected: i.state === 'connected' })
  }

  // ----- sharing (host) -----

  /** Shares a chat's project. Switches "Phone and remote" on when it is off. Sharing the same chat again gives the same project. */
  async share(chatId: string, myName: string, projectName?: string): Promise<RoomInfo> {
    if (!this.host.hasChat(chatId)) throw new Error('That chat is gone.')
    if (this.joinedOf(chatId) && this.live(this.joinedOf(chatId)!)) throw new Error('This chat belongs to a project someone else shares. Only they can invite people.')
    if (!(await this.host.remoteOn())) throw new Error(this.host.remote.info().error || 'The server other computers reach could not be started.')
    let h = this.hostedOf(chatId)
    if (!h) {
      if (this.data.hosted.length >= ROOM_LIMITS.hosted) throw new Error(`You are sharing ${ROOM_LIMITS.hosted} projects already. Stop sharing one first.`)
      h = { id: uid('p') + randomBytes(4).toString('hex'), chatId, name: cleanName(projectName || '', 80) || 'Shared project', me: cleanName(myName, ROOM_LIMITS.name) || os.userInfo().username || 'Host', secret: randomBytes(32).toString('base64url'), createdAt: Date.now(), members: [], notes: [], log: [], seq: 0 }
      this.data.hosted.push(h)
      this.host.deliver(chatId, `This project is now shared as "${h.name}". Anyone you give the join code to can join with their own Ensemble; both teams then share the project memory and can message each other.`)
    } else if (myName.trim()) h.me = cleanName(myName, ROOM_LIMITS.name) || h.me
    this.save(true)
    this.mark(chatId)
    return this.info(chatId)!
  }

  /** Ends one member's access at once: its credential stops working, a call it has open is closed, and the join code changes. */
  removeMember(chatId: string, memberId: string): RoomInfo | null {
    const h = this.hostedOf(chatId)
    if (!h) return this.info(chatId)
    const m = h.members.find((x) => x.id === memberId)
    if (!m) return this.info(chatId)
    h.members = h.members.filter((x) => x.id !== memberId)
    // The code they joined with must not let them straight back in.
    h.secret = randomBytes(32).toString('base64url')
    this.replays.delete(`${h.id}:${memberId}`)
    for (const w of [...(this.waiters.get(h.id) || [])]) if (w.member === memberId) w.done('removed')
    this.event(h, { kind: 'people' })
    this.host.deliver(chatId, `${m.name} was removed from the shared project. The join code changed; the old one no longer works.`)
    this.save(true)
    this.mark(chatId)
    return this.info(chatId)
  }

  /** Stops sharing: every member is cut off at once. The notes stay with the chat's owner. */
  stop(chatId: string): void {
    const h = this.hostedOf(chatId)
    if (!h) return
    this.data.hosted = this.data.hosted.filter((r) => r !== h)
    for (const w of [...(this.waiters.get(h.id) || [])]) w.done('ended')
    this.waiters.delete(h.id)
    this.host.deliver(chatId, `Sharing of "${h.name}" was stopped. Nobody else can reach it any more.`)
    this.save(true)
    this.mark(chatId)
  }

  private event(h: Hosted, e: { kind: 'note'; note: RoomNote } | { kind: 'message'; message: RoomMessage } | { kind: 'people' }): void {
    h.log.push({ ...e, seq: ++h.seq, at: Date.now() } as RoomEvent)
    if (h.log.length > ROOM_LIMITS.log) h.log.splice(0, h.log.length - ROOM_LIMITS.log)
    for (const w of [...(this.waiters.get(h.id) || [])]) w.done('news')
    this.save()
  }

  private addNoteHost(h: Hosted, n: { id?: string; title: string; body: string; by: string; agent?: string; at?: number }): RoomNote | string {
    const title = cleanName(n.title, ROOM_LIMITS.noteTitle)
    const body = cleanText(n.body, ROOM_LIMITS.noteBody)
    if (!title || !body) return 'A note needs a title and a body.'
    if (n.id && h.notes.some((x) => x.id === n.id)) return h.notes.find((x) => x.id === n.id)!
    // The same title again updates that note: the memory stays one note per topic.
    const same = h.notes.find((x) => x.title.toLowerCase() === title.toLowerCase())
    if (!same && h.notes.length >= ROOM_LIMITS.notes) return `The shared memory is full (${ROOM_LIMITS.notes} notes). Reuse a title to update a note instead of adding one.`
    const note: RoomNote = { id: same?.id || n.id || uid('n'), title, body, by: cleanName(n.by, ROOM_LIMITS.name), agent: n.agent ? cleanName(n.agent, ROOM_LIMITS.name) : undefined, at: Date.now() }
    if (same) h.notes[h.notes.indexOf(same)] = note
    else h.notes.push(note)
    this.event(h, { kind: 'note', note })
    return note
  }

  // ----- the host's side of the wire -----

  private async serve(call: RemoteCall): Promise<void> {
    const m = /^([A-Za-z0-9_-]{8,40})\/(join|sync)$/.exec(call.rest)
    if (!m || call.req.method !== 'POST') return call.json(404, { error: 'gone' })
    const h = this.data.hosted.find((r) => r.id === m[1])
    try {
      // A project that is not shared from here (any more) says so and nothing else.
      if (!h) throw new Refuse(410, 'ended')
      const body = await call.body()
      if (m[2] === 'join') return call.json(200, this.admit(h, body))
      const out = await this.sync(h, body, call)
      if (out) call.json(200, out)
    } catch (e) {
      if (e instanceof Refuse) return call.json(e.status, { error: e.reason })
      throw e
    }
  }

  private admit(h: Hosted, body: Record<string, unknown>): Sealed {
    const key = keyOf(h.secret, h.id)
    const ask = unseal<{ name?: string; ts?: number; id?: string }>(key, body)
    // Sealed with anything but this project's current secret: not invited (or the code is an old one).
    if (!ask || typeof ask.ts !== 'number' || Math.abs(Date.now() - ask.ts) > ROOM_LIMITS.skewMs) throw new Refuse(403, 'refused')
    const seen = this.replays.get(`${h.id}:join`) || new Map<string, number>()
    this.replays.set(`${h.id}:join`, seen)
    const id = String(ask.id || '')
    if (!id || seen.has(id)) throw new Refuse(403, 'refused')
    seen.set(id, Date.now())
    if (seen.size > 200) for (const [k, at] of seen) if (Date.now() - at > ROOM_LIMITS.skewMs * 2) seen.delete(k)
    if (h.members.length >= ROOM_LIMITS.members) throw new Refuse(409, 'full')
    const base = cleanName(String(ask.name || ''), ROOM_LIMITS.name) || 'Guest'
    // Two people with one name would be told apart by nothing: the second gets a number.
    let name = base
    for (let n = 2; [h.me, ...h.members.map((x) => x.name)].some((x) => x.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`
    const member: Member = { id: uid('m'), name, credential: randomBytes(32).toString('base64url'), joinedAt: Date.now(), lastSeen: Date.now() }
    h.members.push(member)
    this.event(h, { kind: 'people' })
    this.host.deliver(h.chatId, `${member.name} joined the shared project.`)
    this.save(true)
    this.mark(h.chatId)
    return seal(key, { member: member.id, credential: member.credential, name: h.name, host: h.me, as: member.name })
  }

  private async sync(h: Hosted, body: Record<string, unknown>, call: RemoteCall): Promise<Sealed | null> {
    const member = h.members.find((x) => x.id === String(body.m || ''))
    // Unknown here: removed, or never a member. Either way there is nothing for them.
    if (!member) throw new Refuse(403, 'removed')
    const key = keyOf(member.credential, h.id)
    const ask = unseal<{ ts?: number; id?: string; cursor?: number; wait?: number; ops?: Op[] }>(key, body)
    if (!ask || typeof ask.ts !== 'number' || Math.abs(Date.now() - ask.ts) > ROOM_LIMITS.skewMs) throw new Refuse(403, 'removed')
    const seen = this.replays.get(`${h.id}:${member.id}`) || new Map<string, number>()
    this.replays.set(`${h.id}:${member.id}`, seen)
    const rid = String(ask.id || '')
    if (!rid || seen.has(rid)) throw new Refuse(403, 'refused')
    seen.set(rid, Date.now())
    if (seen.size > 400) for (const [k, at] of seen) if (Date.now() - at > ROOM_LIMITS.skewMs * 2) seen.delete(k)
    member.lastSeen = Date.now()

    // What the member wrote, first. Each write is acknowledged by its id, refused ones with why.
    const acks: { id: string; error?: string }[] = []
    for (const op of (Array.isArray(ask.ops) ? ask.ops : []).slice(0, ROOM_LIMITS.batch)) {
      if (!op || typeof op.id !== 'string') continue
      if (op.kind === 'leave') {
        h.members = h.members.filter((x) => x.id !== member.id)
        this.event(h, { kind: 'people' })
        this.host.deliver(h.chatId, `${member.name} left the shared project.`)
        this.save(true)
        this.mark(h.chatId)
        return seal(key, { left: true, acks: [{ id: op.id }] })
      }
      if (op.kind === 'note') {
        if (!within(this.rate(h.id, member.id, 'n'), ROOM_LIMITS.notesPerMinute, 60_000)) acks.push({ id: op.id, error: 'Too many notes in a minute. Try again shortly.' })
        else {
          const r = this.addNoteHost(h, { id: op.id, title: String(op.title || ''), body: String(op.body || ''), by: member.name, agent: op.agent ? String(op.agent) : undefined })
          acks.push(typeof r === 'string' ? { id: op.id, error: r } : { id: op.id })
        }
      } else if (op.kind === 'message') {
        const text = cleanText(String(op.text || ''), ROOM_LIMITS.message)
        if (!text) acks.push({ id: op.id, error: 'The message was empty.' })
        else if (h.log.some((e) => e.kind === 'message' && e.message.id === op.id)) acks.push({ id: op.id })
        else if (!within(this.rate(h.id, member.id, 'm'), ROOM_LIMITS.messagesPerMinute, 60_000)) acks.push({ id: op.id, error: `Too many messages in a minute (${ROOM_LIMITS.messagesPerMinute} at most). It was not sent.` })
        else {
          const message: RoomMessage = { id: op.id, from: member.name, fromId: member.id, agent: op.agent ? cleanName(String(op.agent), ROOM_LIMITS.name) : undefined, text, at: Date.now() }
          this.event(h, { kind: 'message', message })
          this.incoming(h.chatId, h.name, message)
          acks.push({ id: op.id })
        }
      }
    }

    // A member that just joined asks from -1: it gets the notes as they stand, and none of the messages from before its time.
    const cursor = Number(ask.cursor) || 0
    const news = (): RoomEvent[] => h.log.filter((e) => e.seq > cursor && !(e.kind === 'message' && e.message.fromId === member.id))
    // Nothing new: the call is held open for a while, so news arrives the moment there is any.
    const wait = Math.max(0, Math.min(Number(ask.wait) || 0, this.tuning.waitMs))
    if (!acks.length && wait > 0 && !news().length && cursor >= 0 && cursor <= h.seq) {
      const why = await new Promise<'news' | 'removed' | 'ended' | 'time'>((resolve) => {
        const set = this.waiters.get(h.id) || new Set()
        this.waiters.set(h.id, set)
        const w = {
          member: member.id,
          done: (r: 'news' | 'removed' | 'ended' | 'time'): void => {
            clearTimeout(timer)
            set.delete(w)
            call.res.off('close', gone)
            resolve(r)
          },
        }
        const timer = setTimeout(() => w.done('time'), wait)
        const gone = (): void => w.done('time')
        call.res.once('close', gone)
        set.add(w)
      })
      if (why === 'removed' || !h.members.includes(member)) throw new Refuse(403, 'removed')
      if (why === 'ended' || !this.data.hosted.includes(h)) throw new Refuse(410, 'ended')
      if (call.res.destroyed) return null
    }
    member.lastSeen = Date.now()
    // Too far behind for the log (or ahead of it: the host started over): a full copy.
    const reset = cursor < 0 || cursor > h.seq || (cursor < h.seq && (!h.log.length || cursor < h.log[0].seq - 1))
    const fresh = reset ? [] : news()
    const events = fresh.slice(0, ROOM_LIMITS.events)
    // Up to date after this answer, unless more is waiting than one answer carries.
    const last = !reset && fresh.length > events.length ? events[events.length - 1].seq : h.seq
    return seal(key, {
      cursor: last,
      reset,
      name: h.name,
      people: this.peopleOf(h, member.id),
      notes: reset ? h.notes : events.flatMap((e) => (e.kind === 'note' ? [e.note] : [])),
      messages: events.flatMap((e) => (e.kind === 'message' ? [e.message] : [])),
      acks,
    })
  }

  private rate(project: string, who: string, what: string): number[] {
    const k = `${project}:${who}:${what}`
    const list = this.rates.get(k) || []
    this.rates.set(k, list)
    return list
  }

  /** A message from another person's team reaches this computer's chat: a row the user sees, and the wrapped text for the lead. */
  private incoming(chatId: string, project: string, m: RoomMessage): void {
    if (!this.host.hasChat(chatId)) return
    const text = cleanText(m.text, ROOM_LIMITS.message)
    this.host.deliver(chatId, `Message from ${m.from}'s team${m.agent ? ` (${m.agent})` : ''}: ${text}`, wrapIncoming({ project, from: m.from, agent: m.agent, text }), `${m.from}'s team`)
  }

  // ----- joining (member) -----

  private async post(address: string, pathName: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
    const [, hostName, port] = /^(.*):(\d+)$/.exec(address) || []
    const text = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = http.request({ host: hostName.replace(/^\[|\]$/g, ''), port: Number(port), path: pathName, method: 'POST', agent: false, timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          // An answer is a batch of notes and messages: anything far larger is not ours.
          if (size > 8 * 1024 * 1024) req.destroy(new Error('too large'))
          else chunks.push(c)
        })
        res.on('end', () => {
          try {
            const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            resolve({ status: res.statusCode || 0, data: v && typeof v === 'object' ? (v as Record<string, unknown>) : {} })
          } catch {
            resolve({ status: res.statusCode || 0, data: {} })
          }
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', reject)
      req.end(text)
    })
  }

  /** Joins a shared project with its code. The app connects to the host's computer and makes a chat for the project. */
  async join(codeText: string, myName: string): Promise<RoomInfo> {
    const read = readJoinCode(codeText)
    if (!read.ok) throw new Error(read.reason)
    const code = read.code
    if (this.data.hosted.some((r) => r.id === code.p)) throw new Error('That is a project you share from this computer yourself.')
    const before = this.data.joined.find((r) => r.id === code.p)
    if (before && this.live(before)) throw new Error('You are in this project already.')
    if (this.data.joined.filter((r) => this.live(r)).length >= ROOM_LIMITS.joined) throw new Error(`You are in ${ROOM_LIMITS.joined} shared projects already. Leave one first.`)
    const key = keyOf(code.s, code.p)
    let last = 'The other computer could not be reached. It must be on, with Ensemble open and the project still shared, and on the same network as this one (or a private network such as Tailscale).'
    for (const address of code.a) {
      let r: { status: number; data: Record<string, unknown> }
      try {
        r = await this.post(address, `/rooms/${code.p}/join`, seal(key, { name: cleanName(myName, ROOM_LIMITS.name) || os.userInfo().username || 'Guest', ts: Date.now(), id: uid('j') }), Math.min(this.tuning.timeoutMs, 6_000))
      } catch {
        continue
      }
      if (r.status === 403) throw new Error('That code is no longer valid. Ask for the current one.')
      if (r.status === 410 || r.status === 404) throw new Error('That project is not being shared any more.')
      if (r.status === 409) throw new Error('That project is full. Its owner has to remove someone first.')
      if (r.status === 429) throw new Error('The other computer is busy. Try again in a minute.')
      const got = r.status === 200 ? unseal<{ member: string; credential: string; name: string; host: string; as: string }>(key, r.data) : null
      if (!got || typeof got.member !== 'string' || typeof got.credential !== 'string') {
        last = 'Something answered at that address, but it is not the shared project. Check the code.'
        continue
      }
      if (before) this.data.joined = this.data.joined.filter((x) => x !== before)
      const name = cleanName(String(got.name || code.n), 80) || 'Shared project'
      const chat = before && this.host.hasChat(before.chatId) ? before.chatId : this.host.sharedChat(name).id
      const j: Joined = { id: code.p, chatId: chat, name, me: cleanName(String(got.as || myName), ROOM_LIMITS.name) || 'Guest', addresses: [address, ...code.a.filter((a) => a !== address)], memberId: got.member, credential: got.credential, cursor: -1, notes: [], people: [{ id: 'host', name: cleanName(String(got.host || ''), ROOM_LIMITS.name) || 'Host', host: true, joinedAt: Date.now(), online: true }], outbox: [], state: 'connecting', seen: [] }
      this.data.joined.push(j)
      this.save(true)
      this.host.deliver(chat, `You joined the shared project "${name}", shared by ${j.people[0].name}. Both teams share the project memory and can message each other. What arrives from the other side is shown here.`)
      this.mark(chat)
      this.run(j)
      return this.info(chat)!
    }
    throw new Error(last)
  }

  /** Leaves a project that was joined. The host is told when it can be reached; either way this computer stops. */
  async leave(chatId: string): Promise<void> {
    const j = this.joinedOf(chatId)
    if (!j) return
    if (this.live(j)) {
      j.outbox = [{ id: uid('o'), at: Date.now(), kind: 'leave' }]
      try {
        await this.once(j, 0)
      } catch {
        /* not reachable: the host sees this member go quiet, and can remove it */
      }
    }
    this.loops.get(j.id)?.stop()
    this.loops.delete(j.id)
    j.state = 'left'
    j.outbox = []
    this.save(true)
    this.host.deliver(chatId, `You left the shared project "${j.name}". The notes you had stay readable here.`)
    this.mark(chatId)
  }

  /** One sync with the host: hands over what is waiting, takes in what is new. Throws when the host cannot be reached. */
  private async once(j: Joined, wait: number): Promise<void> {
    const key = keyOf(j.credential, j.id)
    // As many waiting writes as fit one request.
    const ops: Op[] = []
    let bytes = 0
    for (const op of j.outbox) {
      const size = Buffer.byteLength(JSON.stringify(op))
      if (ops.length && (ops.length >= ROOM_LIMITS.batch || bytes + size > 30_000)) break
      ops.push(op)
      bytes += size
    }
    let r: { status: number; data: Record<string, unknown> } | null = null
    let failure: unknown
    for (const address of [...j.addresses]) {
      try {
        r = await this.post(address, `/rooms/${j.id}/sync`, { m: j.memberId, ...seal(key, { ts: Date.now(), id: uid('r'), cursor: j.cursor, wait, ops }) }, wait + this.tuning.timeoutMs)
        // The address that answered is tried first next time.
        if (j.addresses[0] !== address) j.addresses = [address, ...j.addresses.filter((a) => a !== address)]
        break
      } catch (e) {
        failure = e
      }
    }
    if (!r) throw failure instanceof Error ? failure : new Error('unreachable')
    if (r.status === 403 && r.data.error === 'removed') return this.over(j, 'removed')
    if (r.status === 410 || r.status === 404) return this.over(j, 'ended')
    if (r.status === 429) throw Object.assign(new Error('busy'), { busy: true })
    const got = r.status === 200 ? unseal<{ left?: boolean; cursor: number; reset?: boolean; name?: string; people?: RoomPerson[]; notes?: RoomNote[]; messages?: RoomMessage[]; acks?: { id: string; error?: string }[] }>(key, r.data) : null
    if (!got) throw new Error('unreadable')
    if (got.left) return
    for (const a of Array.isArray(got.acks) ? got.acks : []) {
      const op = j.outbox.find((o) => o.id === a.id)
      j.outbox = j.outbox.filter((o) => o.id !== a.id)
      if (a.error && op) this.host.deliver(j.chatId, `The shared project did not take ${op.kind === 'note' ? `the note "${op.title}"` : 'a message'}: ${cleanText(String(a.error), 300)}`)
    }
    if (typeof got.name === 'string') j.name = cleanName(got.name, 80) || j.name
    if (Array.isArray(got.people)) j.people = got.people.slice(0, ROOM_LIMITS.members + 1).map((p) => ({ id: String(p.id), name: cleanName(String(p.name), ROOM_LIMITS.name), host: !!p.host, me: !!p.me, joinedAt: Number(p.joinedAt) || 0, online: !!p.online }))
    const notes = (Array.isArray(got.notes) ? got.notes : []).slice(0, ROOM_LIMITS.notes).map((n) => ({ id: String(n.id), title: cleanName(String(n.title), ROOM_LIMITS.noteTitle), body: cleanText(String(n.body), ROOM_LIMITS.noteBody), by: cleanName(String(n.by), ROOM_LIMITS.name), agent: n.agent ? cleanName(String(n.agent), ROOM_LIMITS.name) : undefined, at: Number(n.at) || Date.now() }))
    if (got.reset) j.notes = notes
    else for (const n of notes) j.notes = [...j.notes.filter((x) => x.id !== n.id), n]
    for (const m of (Array.isArray(got.messages) ? got.messages : []).slice(0, ROOM_LIMITS.events)) {
      const id = String(m.id)
      if (j.seen.includes(id)) continue
      j.seen.push(id)
      if (j.seen.length > 300) j.seen.splice(0, j.seen.length - 300)
      this.incoming(j.chatId, j.name, { id, from: cleanName(String(m.from), ROOM_LIMITS.name) || 'Someone', fromId: String(m.fromId), agent: m.agent ? cleanName(String(m.agent), ROOM_LIMITS.name) : undefined, text: String(m.text || ''), at: Number(m.at) || Date.now() })
    }
    if (Number.isFinite(got.cursor)) j.cursor = got.reset ? got.cursor : Math.max(j.cursor, got.cursor)
    const was = j.state
    j.state = 'connected'
    j.detail = undefined
    this.save()
    if (was !== 'connected' || got.people) this.mark(j.chatId)
  }

  private over(j: Joined, how: 'removed' | 'ended'): void {
    if (!this.live(j)) return
    j.state = how
    j.detail = undefined
    j.outbox = []
    this.loops.get(j.id)?.stop()
    this.loops.delete(j.id)
    this.save(true)
    this.host.deliver(j.chatId, how === 'removed' ? `You were removed from the shared project "${j.name}". Nothing more is sent or received. The notes you had stay readable here.` : `"${j.name}" is no longer shared. Nothing more is sent or received. The notes you had stay readable here.`)
    this.mark(j.chatId)
  }

  /** Keeps one joined project in step with its host: asks, waits, asks again; quietly retries when the host is away. */
  private run(j: Joined): void {
    if (this.loops.has(j.id) || this.disposed) return
    let stopped = false
    let delay = this.tuning.retryMs
    let sleeping: (() => void) | null = null
    let pushing = false
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const t = setTimeout(done, ms)
        t.unref?.()
        function done(): void {
          clearTimeout(t)
          sleeping = null
          resolve()
        }
        sleeping = done
      })
    const fail = (e: unknown): void => {
      if (!this.live(j)) return
      const busy = !!(e as { busy?: boolean }).busy
      if (j.state !== 'offline' && !busy) {
        j.state = 'offline'
        j.detail = "The other computer cannot be reached right now. Ensemble keeps trying; what you write is sent when it is back."
        this.save()
        this.mark(j.chatId)
      }
    }
    const loop = async (): Promise<void> => {
      while (!stopped && !this.disposed && this.live(j)) {
        try {
          // With writes waiting, they go at once; otherwise the host holds the call until there is news.
          await this.once(j, j.outbox.length || j.state !== 'connected' ? 0 : this.tuning.waitMs)
          delay = this.tuning.retryMs
          if (j.outbox.length) continue
        } catch (e) {
          fail(e)
          await sleep((e as { busy?: boolean }).busy ? Math.max(delay, 5_000) : delay)
          delay = Math.min(this.tuning.maxRetryMs, Math.round(delay * 1.7))
        }
      }
    }
    this.loops.set(j.id, {
      stop: () => {
        stopped = true
        sleeping?.()
      },
      // Something was written: it goes out now, beside the call that is being held open.
      kick: () => {
        if (sleeping) return sleeping()
        if (pushing || stopped) return
        pushing = true
        void this.once(j, 0)
          .catch(fail)
          .finally(() => (pushing = false))
      },
    })
    void loop()
  }

  // ----- writes from this computer (the window, and the agents' tools) -----

  /** Saves a note to the shared memory. Returns a line saying what happened. */
  addNote(chatId: string, n: { title: string; body: string; agent?: string }): string {
    const title = cleanName(n.title, ROOM_LIMITS.noteTitle)
    const body = cleanText(n.body, ROOM_LIMITS.noteBody)
    if (!title || !body) return 'A note needs a title and a body.'
    if (String(n.body).trim().length > ROOM_LIMITS.noteBody) return `That note is too long (${ROOM_LIMITS.noteBody} characters at most). Shorten it or split it.`
    const h = this.hostedOf(chatId)
    if (h) {
      if (!within(this.rate(h.id, 'host', 'n'), ROOM_LIMITS.notesPerMinute, 60_000)) return 'Too many notes in a minute. Try again shortly.'
      const r = this.addNoteHost(h, { title, body, by: h.me, agent: n.agent })
      return typeof r === 'string' ? r : `Saved to the shared memory of "${h.name}" as "${r.title}".`
    }
    const j = this.joinedOf(chatId)
    if (!j || !this.live(j)) return 'This chat is not in a shared project.'
    if (j.outbox.length >= ROOM_LIMITS.outbox) return `Too much is waiting to be sent (${ROOM_LIMITS.outbox} writes) while the other computer cannot be reached. Try again once it is back.`
    if (!within(this.rate(j.id, 'me', 'n'), ROOM_LIMITS.notesPerMinute, 60_000)) return 'Too many notes in a minute. Try again shortly.'
    j.outbox.push({ id: uid('n'), at: Date.now(), kind: 'note', title, body, agent: n.agent })
    this.save()
    this.loops.get(j.id)?.kick()
    return j.state === 'connected' ? `Saved to the shared memory of "${j.name}" as "${title}".` : `Kept as "${title}". The other computer cannot be reached right now, so it is sent to the shared memory when the connection is back.`
  }

  /** Sends a message to the other team (every other person's lead in the project). */
  sendMessage(chatId: string, text: string, agent?: string): string {
    const clean = cleanText(text, ROOM_LIMITS.message)
    if (!clean) return 'The message is empty.'
    if (String(text).trim().length > ROOM_LIMITS.message) return `That message is too long (${ROOM_LIMITS.message} characters at most). Shorten it, or save the detail as a note and point to it.`
    const h = this.hostedOf(chatId)
    if (h) {
      if (!h.members.length) return 'Nobody has joined this project yet, so there is nobody to send it to.'
      if (!within(this.rate(h.id, 'host', 'm'), ROOM_LIMITS.messagesPerMinute, 60_000)) return `Too many messages in a minute (${ROOM_LIMITS.messagesPerMinute} at most). It was not sent.`
      this.event(h, { kind: 'message', message: { id: uid('g'), from: h.me, fromId: 'host', agent, text: clean, at: Date.now() } })
      this.host.deliver(chatId, `Sent to ${h.members.map((m) => m.name).join(', ')}${agent ? ` by ${agent}` : ''}: ${clean}`)
      return `Sent to ${h.members.map((m) => `${m.name}'s team`).join(', ')}. A reply, if any, arrives on its own as a shared-project message; do not wait for it inside this turn.`
    }
    const j = this.joinedOf(chatId)
    if (!j || !this.live(j)) return 'This chat is not in a shared project.'
    if (j.outbox.length >= ROOM_LIMITS.outbox) return `Too much is waiting to be sent (${ROOM_LIMITS.outbox} writes) while the other computer cannot be reached. It was not sent.`
    if (!within(this.rate(j.id, 'me', 'm'), ROOM_LIMITS.messagesPerMinute, 60_000)) return `Too many messages in a minute (${ROOM_LIMITS.messagesPerMinute} at most). It was not sent.`
    j.outbox.push({ id: uid('g'), at: Date.now(), kind: 'message', text: clean, agent })
    this.save()
    const others = j.people.filter((p) => !p.me).map((p) => p.name)
    this.host.deliver(chatId, `${j.state === 'connected' ? 'Sent' : 'Waiting to be sent'} to ${others.join(', ') || 'the other team'}${agent ? ` by ${agent}` : ''}: ${clean}`)
    this.loops.get(j.id)?.kick()
    return j.state === 'connected' ? `Sent to ${others.map((n) => `${n}'s team`).join(', ') || 'the other team'}. A reply, if any, arrives on its own as a shared-project message; do not wait for it inside this turn.` : 'The other computer cannot be reached right now. The message is kept and sent when the connection is back.'
  }

  search(chatId: string, query: string): string {
    const i = this.info(chatId)
    if (!i) return 'This chat is not in a shared project.'
    return wrapNotes(i.name, searchNotes(i.notes, query))
  }

  people(chatId: string): string {
    const i = this.info(chatId)
    if (!i) return 'This chat is not in a shared project.'
    const lines = i.people.map((p) => `- ${p.name}${p.host ? ' (shares the project)' : ''}${p.me ? ' (your user)' : ''}: ${p.me || p.online ? 'connected' : 'not connected right now'}`)
    return `Shared project "${i.name}"${i.role === 'member' && i.state !== 'connected' ? ' (this computer is not connected to it right now)' : ''}. Each person has a team of their own on their own computer:\n${lines.join('\n')}\n${i.notes.length} ${i.notes.length === 1 ? 'note' : 'notes'} in the shared memory.`
  }

  /** The tools an agent has while its chat is in a shared project. None otherwise. */
  tools(chat: Chat, me: Account): TeamTool[] {
    if (!this.shared(chat.id)) return []
    return [
      {
        name: 'shared_memory_search',
        description: "Search the notes both teams keep for this shared project (decisions, interfaces, who owns what, findings). Look here before deciding something the other person's team may already have settled. With no query it lists the newest notes.",
        schema: { query: z.string().optional().describe('Words to look for') },
        run: async (a) => this.search(chat.id, String(a.query || '')),
      },
      {
        name: 'shared_memory_save',
        description: `Save a note to the shared project memory, where the other person's team reads it too. One topic per note; reusing a title updates that note. For decisions and why, interfaces both sides build against, who owns which part, findings with their source. Never secrets, keys, passwords or private data: it leaves this computer. At most ${ROOM_LIMITS.noteBody} characters.`,
        schema: { title: z.string().describe('A short label for the topic'), body: z.string().describe('The note itself') },
        run: async (a) => this.addNote(chat.id, { title: String(a.title || ''), body: String(a.body || ''), agent: me.name }),
      },
      {
        name: 'shared_project_people',
        description: 'List who is in this shared project and whether each is connected right now.',
        schema: {},
        run: async () => this.people(chat.id),
      },
      {
        name: 'shared_project_message',
        description: `Send a message to the other person's team in this shared project. It reaches their lead between turns, as a teammate's note would, and their user sees it. Use it to ask, to tell them what you changed that they build on, or to answer them. It returns at once; a reply arrives later by itself. Write it to stand on its own. At most ${ROOM_LIMITS.message} characters, a few a minute.`,
        schema: { text: z.string().describe('The message, complete enough to act on without seeing your conversation') },
        run: async (a) => this.sendMessage(chat.id, String(a.text || ''), me.name),
      },
    ]
  }

  /** A chat was deleted: what it shared ends with it, and what it had joined is left. */
  forget(chatId: string): void {
    if (this.hostedOf(chatId)) this.stop(chatId)
    const j = this.joinedOf(chatId)
    if (j) {
      this.loops.get(j.id)?.stop()
      this.loops.delete(j.id)
      this.data.joined = this.data.joined.filter((r) => r !== j)
      this.save(true)
    }
  }
}
