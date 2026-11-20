// Phone and remote: a small web server inside the app, so the person can follow their team and
// answer it from a phone. It is off until switched on in Settings, listens on the local network
// only (no cloud relay, nothing opened to the internet), and gives a paired device a short list of
// things it may do: read chats, send a message, stop, answer an approval or a question, pick up
// work that was cut short, and start a chat in a folder that already has chats. Permission levels,
// accounts, settings, connectors and computer control cannot be reached from here at all.
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Account, AgentState, Bootstrap, Chat, ChatSnapshot, HubEvent, Item, PermissionDecision, RemoteDevice, RemoteInfo, SendRequest } from '@shared/types'
import { goalLine } from '@shared/auto'
import { toolLine } from '@shared/tools'
import { readJson, uid, writeJson } from './util'
import { RelayLink, type TunnelHost } from './relay'
import { Pusher, validSubscription, type PushKind, type PushSubscription } from './push'
import { Tailscale } from './tailscale'
import type { InboxItem } from '@shared/watches'
import type { RemoteReach, RemoteReachPatch } from '@shared/types'
import type { Sealer } from './connectors'

/** Everything of the hub that can be reached from a phone. Nothing outside this list is callable. */
export interface RemoteHub {
  dataDir: string
  chats: Map<string, Chat>
  /** Read only: used for the agents' states (who is working). */
  bootstrap(): Bootstrap
  /** Read only. */
  lead(chat?: Chat): Account | null
  /** Read only. */
  openChat(id: string): ChatSnapshot
  steer(req: SendRequest): 'steered' | 'sent'
  stop(chatId: string, accountId?: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision, note?: string): void
  respondQuestion(requestId: string, answers: Record<string, string> | null): void
  resumeChat(chatId: string): Promise<string>
  createChat(input: { cwd?: string | null; folderId?: string | null }): Chat
  /** The inbox (src/main/watches.ts): what needs the user and what watches found, newest first. */
  watches?: { inbox(): InboxItem[]; mark(id: string, patch: { read?: boolean; done?: boolean }): InboxItem[] }
  /** The same, as plain hub methods (kept for a hub that offers them that way). */
  inbox?(): Promise<InboxItem[]> | InboxItem[]
  markInbox?(id: string, patch: { read?: boolean; done?: boolean }): Promise<InboxItem[]> | InboxItem[]
}

/** The limits a remote client is held to. One place, so they can be read and checked. */
export const REMOTE_LIMITS = {
  /** A request's body, in bytes. */
  body: 64 * 1024,
  /**
   * A refused request whose body is still arriving: how much of the rest is read and thrown away,
   * and for how long, before the answer goes out. Past either, the connection is cut without one.
   */
  drain: 1024 * 1024,
  drainMs: 3_000,
  /** A message typed on the phone, in characters. */
  text: 20_000,
  /** How long a request may take to arrive, and to be answered. */
  headersMs: 8_000,
  requestMs: 15_000,
  /** Connections open at once, and live streams (per device and in all). */
  connections: 48,
  streamsPerDevice: 3,
  streams: 12,
  /** Requests a paired device may make in a minute. */
  perMinute: 240,
  /** Pairing: how long a code works, wrong tries before it dies, and tries per address and in all. */
  codeMs: 5 * 60_000,
  codeMisses: 5,
  pairPerMinute: 5,
  pairPerTenMinutes: 20,
  /** Devices that can be paired at once. */
  devices: 8,
  /** Rows of a chat sent to the phone. */
  rows: 300,
  /** Request ids remembered per device, and for how long: a POST sent again (a phone that lost signal) is answered, not done twice. */
  replays: 200,
  replayMs: 15 * 60_000,
} as const

const DEFAULT_PORT = 47600

/** What the demo's Tailscale says: connected, HTTPS not yet enabled. Never runs anything. */
const demoTailscale = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  args[0] === 'status'
    ? { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'studio-pc.tail4f2a9.ts.net.', TailscaleIPs: ['100.86.41.17'], Online: true }, CertDomains: ['studio-pc.tail4f2a9.ts.net'] }), stderr: '' }
    : { code: 1, stdout: '', stderr: 'Not in the demo.' }

/** The phone page as an app on the Home Screen. */
const MANIFEST = {
  name: 'Ensemble',
  short_name: 'Ensemble',
  display: 'standalone',
  start_url: '/',
  scope: '/',
  background_color: '#141413',
  theme_color: '#141413',
  icons: [
    { src: '/icon.png', sizes: '180x180', type: 'image/png' },
    { src: '/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  ],
}

/** "From anywhere" as the settings show it (the type lives in shared/types.ts). */
export type { RemoteReach } from '@shared/types'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface StoredDevice extends RemoteDevice {
  /** SHA-256 of the device's credential. The credential itself is never kept. A phone paired through the relay has none: this is the hash of its public key. */
  hash: string
  /** A phone paired through the relay: its P-256 public key (raw, base64url). */
  pub?: string
  /** Where its notifications go, when the phone turned them on. */
  push?: PushSubscription
}

/** A live stream to one device, over Wi-Fi (an HTTP response) or through the relay. */
interface Sink {
  device: string
  chat: string | null
  ping: NodeJS.Timeout | null
  send(line: string): void
  end(): void
}

/** One piece of a chat as the phone shows it. Short keys: it travels over Wi-Fi a lot. */
export interface RemoteRow {
  id: string
  /** user, assistant, step (one line), approval, question, notice */
  k: 'user' | 'assistant' | 'step' | 'approval' | 'question' | 'notice'
  ts: number
  text?: string
  /** Whose row it is, when it is not the lead's. */
  who?: string
  /** streaming, queued, running, done, error, pending, allowed, denied, answered, expired, info, warn */
  st?: string
  requestId?: string
  detail?: string
  /** An approval asked by the guard in a run nobody is watching: when it lapses, and why it asks (a line each). */
  exp?: number
  risk?: string[]
  questions?: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[]
}

export interface RemoteChat {
  id: string
  title: string
  updatedAt: number
  snippet: string
  folder: string
  working: boolean
  /** What the lead is doing right now, in a few words. */
  line: string
  /** Approvals and questions waiting for an answer. */
  needs: number
  /** Work was cut short and can be picked up. */
  cut: boolean
  goal: { text: string; line: string; status: string } | null
}

/** What a route added by another part of the app gets. */
export interface RemoteCall {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  /** The path after the route's prefix. */
  rest: string
  /** The paired device, for routes that use the server's own authentication; null on routes that bring their own. */
  device: RemoteDevice | null
  /** Reads the request's JSON body, within the size and time limits. */
  body(): Promise<Record<string, unknown>>
  json(status: number, data: unknown): void
}
export type RemoteRoute = (call: RemoteCall) => Promise<void> | void

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** An IPv4 address as a number, or null. */
const v4 = (ip: string): number | null => {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim())
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}
const inRange = (ip: number, base: string, bits: number): boolean => {
  const b = v4(base) as number
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0)
}

/**
 * Whether a connection comes from the local network: this computer, the private ranges a home or
 * office network hands out, Tailscale and similar private networks (100.64.0.0/10), link-local, or
 * the same subnet as one of this computer's own network cards (a campus network can use public
 * addresses for its own devices). Anything else is the wider internet and is cut before a byte is read,
 * whatever the firewall allows. `nets` is os.networkInterfaces(), passed in so it can be checked.
 */
export function localPeer(ip: string | undefined, nets: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): boolean {
  if (!ip) return false
  const a = v4(ip)
  if (a === null) {
    const x = ip.trim().toLowerCase()
    // IPv6 (only when the server is bound to it): loopback, link-local, unique local (Tailscale's are fd7a:...).
    return x === '::1' || /^fe[89ab][0-9a-f]:/.test(x) || /^f[cd][0-9a-f]{2}:/.test(x)
  }
  if (inRange(a, '127.0.0.0', 8) || inRange(a, '10.0.0.0', 8) || inRange(a, '172.16.0.0', 12) || inRange(a, '192.168.0.0', 16) || inRange(a, '100.64.0.0', 10) || inRange(a, '169.254.0.0', 16)) return true
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || !n.netmask) continue
      const mine = v4(n.address)
      const mask = v4(n.netmask)
      // A mask wider than /16 is not one network's own subnet.
      if (mine === null || mask === null || mask < 0xffff0000) continue
      if (((a & mask) >>> 0) === ((mine & mask) >>> 0)) return true
    }
  }
  return false
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
/** Interactive blocks are for the computer's window; the phone shows where they were. */
const plain = (text: string): string => text.replace(/```(?:ui|app)[^\n]*\n[\s\S]*?(?:```|$)/g, '[A live block: open the chat on your computer to use it]')

export class RemoteServer {
  /** Where the server listens. Tests and demos set ENSEMBLE_REMOTE_BIND=127.0.0.1 to stay off the network. */
  bind = process.env.ENSEMBLE_REMOTE_BIND || '0.0.0.0'
  /** 0 picks the remembered port, or the usual one. Tests ask for a free one with -1. */
  wantPort = 0
  private server: http.Server | null = null
  private port = 0
  private error: string | undefined
  private on = false
  private store: { port: number; devices: StoredDevice[]; https?: boolean } | null = null
  private pairing: { code: string; expiresAt: number; misses: number } | null = null
  private streams = new Map<object, Sink>()
  /** POSTs already done, by device and request id: the answer, so a repeat gets it again instead of acting twice. */
  private replays = new Map<string, { at: number; reply: Promise<{ status: number; data: unknown }> }>()
  /** The HTTPS server for the Tailscale name, when the user turned it on and the certificate is there. */
  private tls: https.Server | null = null
  private tlsPort = 0
  private renewTimer: NodeJS.Timeout | null = null
  /** Each chat's goal status as last seen, so a goal that ends is told once. */
  private goals = new Map<string, string>()
  /** Inbox items already notified. */
  private told = new Set<string>()
  /** "From anywhere": the relay link, notifications, and Tailscale; made on first use (the hub has its data folder by then). */
  private _relay: RelayLink | null = null
  private _pusher: Pusher | null = null
  private _tailscale: Tailscale | null = null

  /** Seals keys at rest (Windows credential encryption in the app; as they are in checks). */
  private sealer: Sealer = { seal: (s) => s, open: (s) => s }
  /** Whether the person is at the computer (the window is in front): then no notification goes to the phone. */
  private focused: () => boolean = () => false

  /** What the hub gives the phone server: its sealer, and whether the window is in front. */
  useHost(o: { sealer?: Sealer; focused?: () => boolean }): void {
    if (o.sealer) this.sealer = o.sealer
    if (o.focused) this.focused = o.focused
  }

  get relay(): RelayLink {
    return (this._relay ??= new RelayLink(this.tunnelHost(), { sealer: this.sealer }))
  }

  get pusher(): Pusher {
    return (this._pusher ??= new Pusher({
      dataDir: this.hub.dataDir,
      sealer: this.sealer,
      quiet: () => this.focused(),
      targets: () => this.devices().filter((d) => d.push).map((d) => ({ id: d.id, push: d.push })),
      expired: (id) => {
        const d = this.devices().find((x) => x.id === id)
        if (d) delete d.push
        this.save(true)
      },
      subject: () => this.relay.status().url || 'https://github.com/Kerim-Sabic/ensemble',
    }))
  }

  get tailscale(): Tailscale {
    // The demo (screenshots, the trial) shows a made-up network, never this computer's real one.
    const demo = process.env.ENSEMBLE_DEMO === '1'
    return (this._tailscale ??= new Tailscale({ dir: this.hub.dataDir, sealer: this.sealer, ...(demo ? { run: demoTailscale } : {}) }))
  }
  private hits = new Map<string, number[]>()
  private routes: { prefix: string; auth: 'device' | 'own'; handle: RemoteRoute }[] = []
  /** Who is doing what, by chat and agent, kept from the hub's own events. */
  private states = new Map<string, Map<string, AgentState>>()
  /** Approvals and questions still open, by chat: the item ids. */
  private open = new Map<string, Set<string>>()
  private page: { html: string; csp: string; mtime: number } | null = null
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private hub: RemoteHub) {}

  /** Whether anything can reach the phone API now: the Wi-Fi server, or the relay. */
  private get reachable(): boolean {
    return this.listening || this.relay.connected
  }

  // ----- what the app's own window sees -----

  get listening(): boolean {
    return !!this.server?.listening
  }

  get address(): { port: number } | null {
    return this.listening ? { port: this.port } : null
  }

  info(): RemoteInfo {
    const p = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : null
    if (!p) this.pairing = null
    return {
      on: this.on,
      listening: this.listening,
      port: this.listening ? this.port : null,
      error: this.error,
      addresses: this.listening ? this.addresses() : [],
      devices: this.devices().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, online: [...this.streams.values()].some((s) => s.device === d.id), via: d.pub ? 'relay' : 'wifi', notifications: !!d.push })),
      pairing: p ? { code: `${p.code.slice(0, 4)}-${p.code.slice(4)}`, expiresAt: p.expiresAt } : null,
    }
  }

  /** Turns the server on or off. Off closes every connection at once. */
  async setOn(on: boolean): Promise<RemoteInfo> {
    this.on = on
    if (!on) {
      this.close()
      this._relay?.stop()
      return this.info()
    }
    // The relay connects only when the user entered its address and turned it on; otherwise nothing goes out.
    this.relay.start()
    if (this.listening) return this.info()
    this.error = undefined
    const stored = this.data()
    const first = this.wantPort > 0 ? this.wantPort : this.wantPort < 0 ? 0 : stored.port || DEFAULT_PORT
    try {
      await this.listen(first)
    } catch (e) {
      // The usual port is taken by something else: any free one will do, and it is remembered.
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && first !== 0) {
        try {
          await this.listen(0)
        } catch (e2) {
          this.error = (e2 as Error).message
        }
      } else this.error = (e as Error).message
    }
    if (this.listening && this.wantPort >= 0 && stored.port !== this.port) {
      stored.port = this.port
      this.save()
    }
    if (this.listening) {
      this.seed()
      await this.startTls()
    }
    return this.info()
  }

  /** A fresh one-time code. The one before it stops working. */
  pair(): RemoteInfo {
    if (!this.on || (!this.listening && !this.relay.status().on)) return this.info()
    const bytes = randomBytes(8)
    let code = ''
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
    this.pairing = { code, expiresAt: Date.now() + REMOTE_LIMITS.codeMs, misses: 0 }
    return this.info()
  }

  /** Ends a device's access at once: its credential stops working and its open stream is closed. */
  remove(deviceId: string): RemoteInfo {
    const data = this.data()
    data.devices = data.devices.filter((d) => d.id !== deviceId)
    this.save(true)
    for (const [key, s] of [...this.streams]) {
      if (s.device !== deviceId) continue
      try {
        s.send('event: bye\ndata: {}\n\n')
      } catch {
        /* already gone */
      }
      this.drop(key, true)
    }
    for (const k of [...this.replays.keys()]) if (k.startsWith(`${deviceId}:`)) this.replays.delete(k)
    // Through the relay: its sessions are told and cut at once.
    this.relay.cut(deviceId)
    return this.info()
  }

  /**
   * Adds routes of another part of the app under a path prefix (for example '/rooms/').
   * auth 'device' (the default): only a paired device gets through, as for the phone's own routes.
   * auth 'own': the route checks who is calling by itself (a join code, say); the server still
   * applies its Host and origin checks, the size and time limits, and a rate limit per address.
   */
  route(prefix: string, handle: RemoteRoute, opts: { auth?: 'device' | 'own' } = {}): void {
    const clean = `/${prefix.replace(/^\/+|\/+$/g, '')}/`
    if (clean === '/api/' || clean === '//') throw new Error('That prefix is taken.')
    this.routes = this.routes.filter((r) => r.prefix !== clean)
    this.routes.push({ prefix: clean, auth: opts.auth || 'device', handle })
  }

  dispose(): void {
    this.close()
    this._relay?.dispose()
    this._pusher?.dispose()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.store) this.save(true)
  }

  // ----- storage -----

  private file(): string {
    return path.join(this.hub.dataDir, 'remote.json')
  }

  private data(): { port: number; devices: StoredDevice[]; https?: boolean } {
    if (!this.store) {
      const raw = readJson<{ port?: number; devices?: StoredDevice[]; https?: boolean }>(this.file(), {})
      this.store = { port: Number(raw.port) || 0, devices: Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.hash === 'string' && typeof d.id === 'string') : [], https: raw.https === true }
    }
    return this.store
  }

  private devices(): StoredDevice[] {
    return this.data().devices
  }

  private save(now = false): void {
    if (now) {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = null
      writeJson(this.file(), this.data())
      return
    }
    // "Last seen" changes with every request: written at most every half minute.
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      writeJson(this.file(), this.data())
    }, 30_000)
  }

  // ----- the server -----

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Senders that are slow or stuck are looked for every two seconds, so the time limits mean what they say.
      const server = http.createServer({ connectionsCheckingInterval: 2_000 }, (req, res) => void this.handle(req, res, false))
      // From outside the local network: cut before a byte is read (see localPeer).
      server.on('connection', (socket) => {
        if (!localPeer(socket.remoteAddress)) socket.destroy()
      })
      server.on('clientError', (_e, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
        else socket.destroy()
      })
      server.headersTimeout = REMOTE_LIMITS.headersMs
      server.requestTimeout = REMOTE_LIMITS.requestMs
      server.keepAliveTimeout = 5_000
      server.maxConnections = REMOTE_LIMITS.connections
      server.maxHeadersCount = 60
      server.once('error', reject)
      server.listen(port, this.bind, () => {
        server.off('error', reject)
        server.on('error', () => {})
        const a = server.address()
        this.port = typeof a === 'object' && a ? a.port : 0
        this.server = server
        resolve()
      })
    })
  }

  private close(): void {
    for (const key of [...this.streams.keys()]) this.drop(key, true)
    this.stopTls()
    this.pairing = null
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    server.close()
    server.closeAllConnections()
  }

  /** The addresses a phone can use to reach this computer. */
  private addresses(): RemoteInfo['addresses'] {
    const out: RemoteInfo['addresses'] = []
    if (this.bind === '127.0.0.1') return [{ url: `http://127.0.0.1:${this.port}`, label: 'This computer only', kind: 'this' }]
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
        const [x, y] = a.address.split('.').map(Number)
        // 100.64.0.0/10 is what Tailscale and similar private networks hand out.
        const priv = x === 100 && y >= 64 && y <= 127
        out.push({ url: `http://${a.address}:${this.port}`, label: priv ? 'Private network (Tailscale)' : 'Same Wi-Fi or local network', kind: priv ? 'private' : 'wifi' })
      }
    }
    return out.sort((a, b) => Number(a.kind === 'private') - Number(b.kind === 'private'))
  }

  /** The names this server answers to. Anything else in the Host header is a page from elsewhere pointed at us. */
  private knownHost(host: string): boolean {
    const m = /^(\[[0-9a-f:]+\]|[^:]+)(?::(\d+))?$/i.exec(host.trim().toLowerCase())
    if (!m || Number(m[2] || 80) !== this.port) return false
    const name = m[1]
    if (name === 'localhost' || name === '127.0.0.1') return true
    const mine = os.hostname().toLowerCase()
    if (name === mine || name === `${mine}.local` || name.endsWith('.ts.net')) return true
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.address.toLowerCase() === name) return true
    return false
  }

  private tooMany(key: string, max: number, windowMs: number): boolean {
    const now = Date.now()
    const list = (this.hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= max) {
      this.hits.set(key, list)
      return true
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 2000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < 600_000)) this.hits.delete(k)
    return false
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...extra }
  }

  private json(res: http.ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
    if (res.headersSent || res.writableEnded) return
    const body = JSON.stringify(data)
    res.writeHead(status, this.headers({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), ...extra }))
    res.end(body)
  }

  private body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return reject(new Refused(415, 'Send JSON.'))
      if (Number(req.headers['content-length'] || 0) > REMOTE_LIMITS.body) return reject(new Refused(413, 'That is too large.'))
      const chunks: Buffer[] = []
      let size = 0
      const timer = setTimeout(() => {
        reject(new Refused(408, 'The request took too long.'))
        req.destroy()
      }, REMOTE_LIMITS.requestMs)
      req.on('data', (c: Buffer) => {
        size += c.length
        // Too large: nothing more is kept. What is still coming is read and thrown away before the
        // answer goes out (see drain), so the sender gets the answer instead of a cut connection.
        if (size > REMOTE_LIMITS.body) {
          clearTimeout(timer)
          chunks.length = 0
          reject(new Refused(413, 'That is too large.'))
          return
        }
        chunks.push(c)
      })
      req.on('error', () => {
        clearTimeout(timer)
        reject(new Refused(400, 'The request was cut off.'))
      })
      req.on('end', () => {
        clearTimeout(timer)
        if (size > REMOTE_LIMITS.body) return
        try {
          const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
          resolve(v as Record<string, unknown>)
        } catch {
          reject(new Refused(400, 'That is not valid JSON.'))
        }
      })
    })
  }

  /** The paired device a request comes from, or null. */
  private deviceOf(req: http.IncomingMessage): StoredDevice | null {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization || ''))
    if (!m) return null
    const hash = sha(m[1])
    return this.devices().find((d) => same(d.hash, hash)) || null
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, secure = false): Promise<void> {
    try {
      const method = req.method || 'GET'
      const raw = req.url || '/'
      if (raw.length > 2000) throw new Refused(414, 'That address is too long.')
      // A page from somewhere else must not be able to talk to this server through the user's browser.
      if (!this.knownHost(String(req.headers.host || ''))) throw new Refused(421, 'Wrong address.')
      const origin = req.headers.origin
      if (origin && origin !== `${secure ? 'https' : 'http'}://${String(req.headers.host)}`) throw new Refused(403, 'Not from this page.')
      const site = req.headers['sec-fetch-site']
      if (site && site !== 'same-origin' && site !== 'none') throw new Refused(403, 'Not from this page.')
      if (method !== 'GET' && method !== 'POST') throw new Refused(405, 'Not supported.')
      const url = new URL(raw, `http://${String(req.headers.host)}`)
      const p = url.pathname
      const ip = req.socket.remoteAddress || '?'

      // The page itself, its icon and its title for the home screen: all an unpaired client ever gets.
      if (method === 'GET' && (p === '/' || p === '/index.html')) return this.sendPage(res)
      if (method === 'GET' && (p === '/icon.png' || p === '/apple-touch-icon.png' || p === '/apple-touch-icon-precomposed.png')) return this.sendIcon(res)
      if (method === 'GET' && p === '/manifest.webmanifest') return this.json(res, 200, MANIFEST, { 'Content-Type': 'application/manifest+json' })
      if (method === 'GET' && (p === '/tunnel.js' || p === '/sw.js')) return this.sendScript(res, p.slice(1))
      if (method === 'GET' && p === '/favicon.ico') {
        res.writeHead(204, this.headers())
        res.end()
        return
      }

      if (p === '/api/pair') {
        if (method !== 'POST') throw new Refused(405, 'Not supported.')
        return await this.doPair(req, res, ip)
      }

      // Routes other parts of the app added.
      const extra = this.routes.find((r) => p.startsWith(r.prefix))
      if (extra) {
        let device: StoredDevice | null = null
        if (extra.auth === 'device') {
          device = this.deviceOf(req)
          if (!device) throw new Refused(401, 'This device is not paired.')
          if (this.tooMany(`dev:${device.id}`, REMOTE_LIMITS.perMinute, 60_000)) throw new Refused(429, 'Too many requests. Wait a moment.')
          this.seen(device)
        } else if (this.tooMany(`own:${ip}`, 60, 60_000)) throw new Refused(429, 'Too many requests. Wait a moment.')
        await extra.handle({ req, res, url, rest: p.slice(extra.prefix.length), device: device ? { id: device.id, name: device.name, createdAt: device.createdAt, lastSeen: device.lastSeen } : null, body: () => this.body(req), json: (status, data) => this.json(res, status, data) })
        if (!res.headersSent) this.json(res, 404, { error: 'Not found.' })
        return
      }

      if (!p.startsWith('/api/')) throw new Refused(404, 'Not found.')
      const device = this.deviceOf(req)
      if (!device) throw new Refused(401, 'This device is not paired.')
      const rid = String(req.headers['x-request-id'] || '')
      const out = await this.serve(device, method, p.slice(4), url.searchParams, () => this.body(req), /^[A-Za-z0-9_-]{8,64}$/.test(rid) ? rid : undefined)
      if ('stream' in out) return this.stream(res, device, out.stream)
      this.json(res, out.status, out.data)
    } catch (e) {
      // A refused request whose body is still on its way: the rest is read and thrown away first,
      // within a bound, and only then does the answer go out and the connection close. Closing
      // while the sender is still sending resets the connection, and the sender then loses the
      // answer it had not read yet: a phone would say "connection lost" instead of "too large".
      if (!req.complete && !req.destroyed && !(await this.drain(req))) return
      if (e instanceof Refused) this.json(res, e.status, { error: e.message }, { Connection: 'close', ...(e.status === 429 ? { 'Retry-After': '30' } : {}) })
      else this.json(res, 409, { error: clip((e as Error).message || 'That did not work.', 300) })
    }
  }

  /**
   * Reads what is left of a request's body and throws it away. True once it has all arrived;
   * false when it went past REMOTE_LIMITS.drain bytes or drainMs, or broke off: the connection
   * is then cut without an answer.
   */
  private drain(req: http.IncomingMessage): Promise<boolean> {
    return new Promise((resolve) => {
      // Says up front that it is larger than will ever be read: cut at once.
      if (Number(req.headers['content-length'] || 0) > REMOTE_LIMITS.drain) {
        req.socket?.destroy()
        return resolve(false)
      }
      let left = REMOTE_LIMITS.drain
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onBroken)
        req.off('close', onClose)
        if (!ok) req.socket?.destroy()
        resolve(ok)
      }
      const onData = (c: Buffer): void => {
        if ((left -= c.length) < 0) done(false)
      }
      const onEnd = (): void => done(true)
      const onBroken = (): void => done(false)
      const onClose = (): void => done(req.complete)
      const timer = setTimeout(() => done(false), REMOTE_LIMITS.drainMs)
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onBroken)
      req.on('close', onClose)
      req.resume()
    })
  }

  private seen(device: StoredDevice): void {
    device.lastSeen = Date.now()
    this.save()
  }

  private async doPair(req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void> {
    if (this.tooMany(`pair:${ip}`, REMOTE_LIMITS.pairPerMinute, 60_000) || this.tooMany('pair:*', REMOTE_LIMITS.pairPerTenMinutes, 600_000)) throw new Refused(429, 'Too many tries. Wait a minute, then ask for a new code.')
    const body = await this.body(req)
    this.checkCode(String(body.code || ''))
    const token = randomBytes(32).toString('base64url')
    const device = this.addDevice(String(body.name || ''), { hash: sha(token) })
    this.json(res, 200, { token, device: { id: device.id, name: device.name } })
  }

  /** The one-time pairing code, wherever it was typed: wrong five times, or out of time, and it is gone. Throws when it is not right. */
  private checkCode(raw: string): void {
    const given = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    const p = this.pairing
    if (!p || p.expiresAt < Date.now()) {
      this.pairing = null
      throw new Refused(403, 'That code is no longer valid. Ask for a new one in Ensemble on your computer.')
    }
    if (!given || !same(sha(given), sha(p.code))) {
      // A handful of wrong tries ends the code, so it cannot be guessed at leisure.
      if (++p.misses >= REMOTE_LIMITS.codeMisses) this.pairing = null
      throw new Refused(403, 'That code is not right.')
    }
    // It worked once: it never works again.
    this.pairing = null
  }

  private addDevice(rawName: string, how: { hash: string; pub?: string }): StoredDevice {
    const data = this.data()
    if (data.devices.length >= REMOTE_LIMITS.devices) throw new Refused(409, 'Too many devices are paired. Remove one in Ensemble on your computer first.')
    const now = Date.now()
    const name = clip(rawName.replace(/[\u0000-\u001f<>]/g, '').trim() || 'Phone', 40)
    const device: StoredDevice = { id: uid('d'), name, createdAt: now, lastSeen: now, hash: how.hash, ...(how.pub ? { pub: how.pub } : {}) }
    data.devices.push(device)
    this.save(true)
    return device
  }

  /**
   * One call of the phone API from a paired device, whatever carried it (Wi-Fi or the relay): the
   * same rate limit, the same handlers, and a POST with a request id seen before gets the answer it
   * got then instead of being done again.
   */
  private async serve(device: StoredDevice, method: string, p: string, query: URLSearchParams, body: () => Promise<Record<string, unknown>>, rid?: string): Promise<{ status: number; data: unknown } | { stream: string | null }> {
    if (this.tooMany(`dev:${device.id}`, REMOTE_LIMITS.perMinute, 60_000)) throw new Refused(429, 'Too many requests. Wait a moment.')
    this.seen(device)
    if (!rid || method === 'GET') return this.api(method, p, query, body, device)
    const key = `${device.id}:${rid}`
    const now = Date.now()
    const hit = this.replays.get(key)
    if (hit && now - hit.at < REMOTE_LIMITS.replayMs) return hit.reply
    const reply = this.api(method, p, query, body, device) as Promise<{ status: number; data: unknown }>
    this.replays.set(key, { at: now, reply })
    // Only an answer that came is kept: a refusal (too many requests, say) may be tried again.
    reply.catch(() => this.replays.delete(key))
    if (this.replays.size > REMOTE_LIMITS.replays * REMOTE_LIMITS.devices) {
      for (const [k, v] of this.replays) if (now - v.at > REMOTE_LIMITS.replayMs) this.replays.delete(k)
      while (this.replays.size > REMOTE_LIMITS.replays * REMOTE_LIMITS.devices) this.replays.delete(this.replays.keys().next().value as string)
    }
    return reply
  }

  /** What the relay link may call: pairing, a device, an API call and the live stream. Nothing else. */
  private tunnelHost(): TunnelHost {
    const answer = (e: unknown): { s: number; b: unknown } => (e instanceof Refused ? { s: e.status, b: { error: e.message } } : { s: 409, b: { error: clip((e as Error).message || 'That did not work.', 300) } })
    return {
      dataDir: this.hub.dataDir,
      tunnelPair: (code, name, pub) => {
        if (!this.on) return { error: 'Phone and remote is off on the computer.' }
        if (this.tooMany('pair:relay', REMOTE_LIMITS.pairPerMinute, 60_000) || this.tooMany('pair:*', REMOTE_LIMITS.pairPerTenMinutes, 600_000)) return { error: 'Too many tries. Wait a minute, then ask for a new code.' }
        try {
          this.checkCode(code)
          const d = this.addDevice(name, { hash: sha(`pub:${pub}`), pub })
          return { device: { id: d.id, name: d.name } }
        } catch (e) {
          return { error: (e as Error).message }
        }
      },
      tunnelDevice: (id) => {
        if (!this.on) return null
        const d = this.devices().find((x) => x.id === id)
        return d ? { id: d.id, pub: d.pub } : null
      },
      tunnelCall: async (id, req) => {
        const d = this.devices().find((x) => x.id === id)
        if (!d || !this.on) return { s: 401, b: { error: 'This device is not paired.' } }
        try {
          const url = new URL(req.p, 'http://tunnel')
          if (!url.pathname.startsWith('/api/') || req.p.length > 2000) throw new Refused(404, 'Not found.')
          const method = req.m === 'POST' ? 'POST' : req.m === 'GET' ? 'GET' : ''
          if (!method) throw new Refused(405, 'Not supported.')
          const body = async (): Promise<Record<string, unknown>> => {
            const b = req.b
            if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Refused(400, 'That is not valid JSON.')
            if (JSON.stringify(b).length > REMOTE_LIMITS.body) throw new Refused(413, 'That is too large.')
            return b as Record<string, unknown>
          }
          const out = await this.serve(d, method, url.pathname.slice(4), url.searchParams, body, req.rid && /^[A-Za-z0-9_-]{8,64}$/.test(req.rid) ? req.rid : undefined)
          if ('stream' in out) return { s: 400, b: { error: 'Open the live stream with sub.' } }
          return { s: out.status, b: out.data }
        } catch (e) {
          return answer(e)
        }
      },
      tunnelStream: (id, p, send, end) => {
        const d = this.devices().find((x) => x.id === id)
        if (!d || !this.on) return { s: 401, b: { error: 'This device is not paired.' } }
        try {
          const url = new URL(p, 'http://tunnel')
          if (url.pathname !== '/api/events') throw new Refused(404, 'Not found.')
          if (this.tooMany(`dev:${d.id}`, REMOTE_LIMITS.perMinute, 60_000)) throw new Refused(429, 'Too many requests. Wait a moment.')
          this.seen(d)
          const key = {}
          this.attach(key, d, url.searchParams.get('chat'), send, end)
          return { close: () => this.drop(key, false) }
        } catch (e) {
          return answer(e)
        }
      },
    }
  }

  // ----- what a paired device may do -----

  private async api(method: string, p: string, query: URLSearchParams, readBody: () => Promise<Record<string, unknown>>, device: StoredDevice): Promise<{ status: number; data: unknown } | { stream: string | null }> {
    const ok = (data: unknown): { status: number; data: unknown } => ({ status: 200, data })
    const get = method === 'GET'
    if (get && p === '/state') {
      return ok({ device: { id: device.id, name: device.name }, chats: this.chatList(), folders: this.folders().map((f) => ({ key: f.key, label: f.label })), push: { key: this.pusher.publicKey, on: !!device.push, kinds: this.pusher.kinds }, inbox: !!this.inboxApi() })
    }
    if (get && p === '/events') return { stream: query.get('chat') }
    // The inbox: what needs the user first, then what watches found.
    if (get && p === '/inbox') {
      const box = this.inboxApi()
      if (!box) return ok({ items: [], ready: false })
      return ok({ items: await box.list(), ready: true })
    }
    const ib = /^\/inbox\/([\w-]{1,60})$/.exec(p)
    if (!get && ib) {
      const box = this.inboxApi()
      if (!box) throw new Refused(404, 'Not found.')
      const body = await readBody()
      const patch: { read?: boolean; done?: boolean } = {}
      if (typeof body.read === 'boolean') patch.read = body.read
      if (typeof body.done === 'boolean') patch.done = body.done
      return ok({ items: await box.mark(ib[1], patch) })
    }
    // Notifications: this phone's subscription (made on the phone, after a tap), or none.
    if (!get && p === '/push') {
      const body = await readBody()
      if (body.off === true) delete device.push
      else {
        const sub = validSubscription(body.subscription)
        if (!sub) throw new Refused(400, 'That is not a push subscription.')
        device.push = sub
      }
      this.save(true)
      return ok({ ok: true, on: !!device.push })
    }
    if (!get && p === '/chats') {
      const body = await readBody()
      const folder = this.folders().find((f) => f.key === String(body.folder || ''))
      if (!folder) throw new Refused(400, 'Pick one of the folders that already has chats.')
      const text = this.textOf(body)
      const lead = this.hub.lead()
      if (!lead) throw new Refused(409, 'No account is set up on the computer yet.')
      const chat = this.hub.createChat({ cwd: folder.cwd })
      this.say(chat, text)
      return ok({ chat: this.summary(chat) })
    }
    const m = /^\/chat\/([\w-]{1,40})(?:\/(send|stop|resume|answer))?$/.exec(p)
    if (!m) throw new Refused(404, 'Not found.')
    const chat = this.hub.chats.get(m[1])
    if (!chat) throw new Refused(404, 'That chat no longer exists.')
    const action = m[2]
    if (get && !action) return ok(this.detail(chat))
    if (get || !action) throw new Refused(405, 'Not supported.')
    const body = await readBody()
    if (action === 'send') {
      const how = this.say(chat, this.textOf(body))
      return ok({ ok: true, how })
    }
    if (action === 'stop') {
      await this.hub.stop(chat.id)
      return ok({ ok: true })
    }
    if (action === 'resume') {
      if (!chat.recovery) throw new Refused(409, 'Nothing was cut short in this chat.')
      const said = await this.hub.resumeChat(chat.id)
      return ok({ ok: true, said: clip(String(said || ''), 400) })
    }
    // An approval or a question: only one that is really waiting in this chat, and never "always".
    const requestId = String(body.requestId || '')
    const item = this.asksOf(chat).find((a) => a.item.requestId === requestId)?.item
    if (!item) throw new Refused(409, 'That is no longer waiting for an answer.')
    if (item.kind === 'permission') {
      if (typeof body.allow !== 'boolean') throw new Refused(400, 'Say allow or deny.')
      this.hub.respondPermission(requestId, body.allow ? 'allow' : 'deny')
      return ok({ ok: true })
    }
    if (body.dismiss === true) {
      this.hub.respondQuestion(requestId, null)
      return ok({ ok: true })
    }
    const given = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? (body.answers as Record<string, unknown>) : null
    const answers: Record<string, string> = {}
    for (const q of item.questions) {
      const v = given?.[q.question]
      if (typeof v !== 'string' || !v.trim()) throw new Refused(400, 'Answer every question.')
      answers[q.question] = clip(v.trim(), 2000)
    }
    this.hub.respondQuestion(requestId, answers)
    return ok({ ok: true })
  }

  /** The inbox, wherever the hub keeps it, or null when it has none. */
  private inboxApi(): { list(): Promise<InboxItem[]>; mark(id: string, patch: { read?: boolean; done?: boolean }): Promise<InboxItem[]> } | null {
    const w = this.hub.watches
    if (w && typeof w.inbox === 'function' && typeof w.mark === 'function') return { list: async () => w.inbox(), mark: async (id, p) => w.mark(id, p) }
    const h = this.hub
    if (typeof h.inbox === 'function' && typeof h.markInbox === 'function') return { list: async () => (h.inbox as () => Promise<InboxItem[]> | InboxItem[])(), mark: async (id, p) => (h.markInbox as (i: string, q: typeof p) => Promise<InboxItem[]> | InboxItem[])(id, p) }
    return null
  }

  private textOf(body: Record<string, unknown>): string {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new Refused(400, 'The message is empty.')
    if (text.length > REMOTE_LIMITS.text) throw new Refused(413, 'That message is too long.')
    return text
  }

  /** A message from the phone to the chat's lead. It steers a lead that is working, as the window does. */
  private say(chat: Chat, text: string): 'steered' | 'sent' {
    const lead = this.hub.lead(chat)
    if (!lead) throw new Refused(409, 'This chat has no lead.')
    // Typed commands (/ultra, /goal, /loop) change how the team works: those stay on the computer.
    // A message that starts with a slash is passed on as plain words.
    return this.hub.steer({ chatId: chat.id, to: lead.id, text, ...(text.startsWith('/') ? { fromControl: true } : {}) })
  }

  /** Folders that already have chats: the only places a new chat can be started from a phone. */
  private folders(): { key: string; label: string; cwd: string }[] {
    const seen = new Map<string, { key: string; label: string; cwd: string }>()
    for (const c of [...this.hub.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const k = c.cwd.toLowerCase()
      if (!seen.has(k) && seen.size < 12) seen.set(k, { key: sha(k).slice(0, 12), label: path.basename(c.cwd) || c.cwd, cwd: c.cwd })
    }
    return [...seen.values()]
  }

  private stateOf(chatId: string): Map<string, AgentState> {
    let m = this.states.get(chatId)
    if (!m) this.states.set(chatId, (m = new Map()))
    return m
  }

  /** What is true right now, read once when the server starts; the hub's events keep it current. */
  private seed(): void {
    this.states.clear()
    this.open.clear()
    for (const s of this.hub.bootstrap().states) this.stateOf(s.chatId).set(s.accountId, s)
    // Someone is waiting on the person: find the cards that are open.
    for (const [chatId, m] of this.states) {
      if (![...m.values()].some((s) => s.phase === 'waiting')) continue
      const chat = this.hub.chats.get(chatId)
      if (chat) this.open.set(chatId, new Set(this.asksOf(chat).map((a) => a.item.id)))
    }
  }

  private asksOf(chat: Chat): { who: string; item: Extract<Item, { kind: 'permission' | 'question' }> }[] {
    const out: { who: string; item: Extract<Item, { kind: 'permission' | 'question' }> }[] = []
    let snap: ChatSnapshot
    try {
      snap = this.hub.openChat(chat.id)
    } catch {
      return out
    }
    for (const [who, items] of Object.entries(snap.items)) {
      for (const it of items) if ((it.kind === 'permission' || it.kind === 'question') && it.status === 'pending') out.push({ who, item: it })
    }
    return out
  }

  private summary(chat: Chat): RemoteChat {
    const lead = this.hub.lead(chat)
    const states = [...this.stateOf(chat.id).values()]
    const busy = states.filter((s) => s.phase !== 'idle' && s.phase !== 'error')
    const mine = lead ? states.find((s) => s.accountId === lead.id) : undefined
    const others = busy.filter((s) => s.accountId !== lead?.id).length
    const line = !busy.length
      ? ''
      : mine && mine.phase !== 'idle' && mine.phase !== 'error'
        ? `${lead?.name || 'The lead'}: ${mine.activity || 'working'}${others ? ` · ${others} more at work` : ''}`
        : `${others} at work`
    const g = chat.goal
    return {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      snippet: clip(chat.snippet || '', 140),
      folder: path.basename(chat.cwd) || chat.cwd,
      working: busy.length > 0,
      line: clip(line, 120),
      needs: this.open.get(chat.id)?.size || 0,
      cut: !!chat.recovery,
      goal: g ? { text: clip(g.text, 200), line: goalLine(g), status: g.status } : null,
    }
  }

  private chatList(): RemoteChat[] {
    return [...this.hub.chats.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 60)
      .map((c) => this.summary(c))
  }

  /** One transcript row as the phone shows it, or null for what it leaves out (thinking, bookkeeping). */
  private row(it: Item, who?: string): RemoteRow | null {
    const base = { id: it.id, ts: it.ts, ...(who ? { who } : {}) }
    switch (it.kind) {
      case 'user':
        return it.withdrawn ? null : { ...base, k: 'user', text: clip(it.text, REMOTE_LIMITS.text), st: it.queued ? 'queued' : undefined }
      case 'assistant':
        return { ...base, k: 'assistant', text: clip(plain(it.text), 30_000), st: it.streaming ? 'streaming' : undefined }
      case 'tool':
        return it.parentId ? null : { ...base, k: 'step', text: clip(toolLine(it.name, it.input, it.status === 'running'), 160), st: it.status }
      case 'delegate':
        return { ...base, k: 'step', text: clip(`Handed "${it.title}" to ${this.nameOf(it.to)}`, 160), st: 'done' }
      case 'peer':
        return it.tag === 'result' ? { ...base, k: 'step', text: clip(`${this.nameOf(it.from)} reported: ${it.title || 'a task'}`, 160), st: it.status === 'failed' ? 'error' : 'done' } : null
      case 'image':
        return { ...base, k: 'step', text: `Made ${it.media === 'audio' ? 'a sound file' : it.media === 'video' ? 'a video' : 'a picture'}: ${path.basename(it.path)}`, st: 'done' }
      case 'notice':
        return { ...base, k: 'notice', text: clip(it.text, 600), st: it.level }
      case 'auto':
        return { ...base, k: 'notice', text: clip(it.text ? `${it.title}. ${it.text}` : it.title, 600), st: 'info' }
      case 'permission':
        return {
          ...base,
          k: 'approval',
          text: clip(it.title, 300),
          detail: it.detail ? clip(it.detail, 600) : undefined,
          requestId: it.requestId,
          st: it.status === 'always' ? 'allowed' : it.status,
          ...(it.unattended && typeof it.expiresAt === 'number' ? { exp: it.expiresAt } : {}),
          ...(it.unattended && Array.isArray(it.risk) && it.risk.length ? { risk: it.risk.slice(0, 6).map((r) => clip(String(r), 200)) } : {}),
        }
      case 'question':
        return { ...base, k: 'question', requestId: it.requestId, st: it.status, questions: it.questions.slice(0, 6).map((q) => ({ question: clip(q.question, 400), header: q.header, multiSelect: q.multiSelect, options: (q.options || []).slice(0, 8).map((o) => ({ label: clip(o.label, 120), description: o.description ? clip(o.description, 240) : undefined })) })) }
      case 'signin':
        return { ...base, k: 'notice', text: `Needs you at the computer: sign in to ${it.site}.`, st: it.status === 'pending' ? 'warn' : 'info' }
      default:
        return null
    }
  }

  private names: { at: number; map: Map<string, string> } | null = null
  private nameOf(id: string): string {
    // Looked up for many rows in a row: the list is kept for a couple of seconds.
    if (!this.names || Date.now() - this.names.at > 2_000) {
      const map = new Map<string, string>()
      for (const a of this.hub.bootstrap().accounts) map.set(a.id, a.name)
      for (const c of this.hub.chats.values()) for (const a of c.agents || []) map.set(a.id, a.name)
      this.names = { at: Date.now(), map }
    }
    return this.names.map.get(id) || 'a teammate'
  }

  private detail(chat: Chat): { chat: RemoteChat; lead: { id: string; name: string } | null; rows: RemoteRow[]; more: boolean } {
    const lead = this.hub.lead(chat)
    const snap = this.hub.openChat(chat.id)
    const rows: RemoteRow[] = []
    for (const it of (lead && snap.items[lead.id]) || []) {
      const r = this.row(it)
      if (r) rows.push(r)
    }
    // Cards from teammates: an approval or a question can come from anyone on the team.
    const open = new Set<string>()
    for (const [who, items] of Object.entries(snap.items)) {
      for (const it of items) {
        if ((it.kind !== 'permission' && it.kind !== 'question') || it.status !== 'pending') continue
        open.add(it.id)
        if (who === lead?.id) continue
        const r = this.row(it, this.nameOf(who))
        if (r) rows.push(r)
      }
    }
    this.open.set(chat.id, open)
    for (const s of snap.states) this.stateOf(chat.id).set(s.accountId, s)
    rows.sort((a, b) => a.ts - b.ts)
    const more = rows.length > REMOTE_LIMITS.rows
    return { chat: this.summary(chat), lead: lead ? { id: lead.id, name: lead.name } : null, rows: more ? rows.slice(-REMOTE_LIMITS.rows) : rows, more }
  }

  // ----- live updates -----

  /** A live stream over Wi-Fi: an event-stream response. */
  private stream(res: http.ServerResponse, device: StoredDevice, chat: string | null): void {
    this.room(device)
    // A dead connection is noticed within about half a minute, not when the system gives up on it.
    res.socket?.setKeepAlive(true, 10_000)
    res.writeHead(200, this.headers({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }))
    this.attach(res, device, chat, (line) => res.write(line), () => {
      res.end()
      res.socket?.destroy()
    })
    res.on('close', () => this.drop(res, false))
  }

  /**
   * Room for one more stream of this device. A phone that went to sleep drops its stream without a
   * word, and the server only notices later. So a device that opens one stream more than it may hold
   * gets it in place of its oldest, instead of being refused for minutes. The limit for all devices
   * together stays a refusal.
   */
  private room(device: StoredDevice): void {
    const mine = [...this.streams.entries()].filter(([, s]) => s.device === device.id)
    if (mine.length >= REMOTE_LIMITS.streamsPerDevice) {
      for (const [old] of mine.slice(0, mine.length - REMOTE_LIMITS.streamsPerDevice + 1)) this.drop(old, true)
    } else if (this.streams.size >= REMOTE_LIMITS.streams) throw new Refused(429, 'Too many live connections. Close another tab first.')
  }

  /** A stream, whatever carries it: the same lines, pings and limits. */
  private attach(key: object, device: StoredDevice, chat: string | null, send: (line: string) => void, end: () => void): void {
    if (!(key instanceof http.ServerResponse)) this.room(device)
    send(': connected\n\n')
    const ping = setInterval(() => {
      try {
        send(': ping\n\n')
      } catch {
        this.drop(key, true)
      }
    }, 20_000)
    this.streams.set(key, { device: device.id, chat: chat && this.hub.chats.has(chat) ? chat : null, ping, send, end })
  }

  private drop(key: object, end: boolean): void {
    const s = this.streams.get(key)
    if (s?.ping) clearInterval(s.ping)
    this.streams.delete(key)
    if (!end || !s) return
    try {
      s.end()
    } catch {
      /* already gone */
    }
  }

  private push(chatId: string | null, data: Record<string, unknown>): void {
    const line = `data: ${JSON.stringify(data)}\n\n`
    for (const [key, s] of this.streams) {
      if (chatId && s.chat !== chatId) continue
      try {
        s.send(line)
      } catch {
        this.drop(key, true)
      }
    }
  }

  /** Every event of the hub passes here. What a phone may see of it is sent on; the rest stops here. */
  onEvent(ev: HubEvent): void {
    if (!this.on) return
    // The inbox (watches engine): the phone's list, and a notification for what is new.
    const loose = ev as unknown as { type: string; items?: InboxItem[] }
    if (loose.type === 'inbox' && Array.isArray(loose.items)) {
      for (const it of loose.items) {
        if (it.done || it.read || this.told.has(it.id)) continue
        this.told.add(it.id)
        this.pusher.note(it.kind === 'found' ? 'found' : 'needs')
      }
      if (this.told.size > 2000) this.told = new Set([...this.told].slice(-1000))
      if (this.reachable) this.push(null, { t: 'inbox', items: loose.items.filter((i) => !i.done).slice(0, 100) })
      return
    }
    if (ev.type === 'chat') this.goalNews(ev.chat)
    if (ev.type === 'item' && (ev.item.kind === 'permission' || ev.item.kind === 'question') && ev.item.status === 'pending') this.pusher.note('needs')
    if (!this.reachable) return
    switch (ev.type) {
      case 'agent': {
        const before = this.hub.chats.get(ev.state.chatId)
        this.stateOf(ev.state.chatId).set(ev.state.accountId, ev.state)
        if (before && this.streams.size) this.push(null, { t: 'chat', chat: this.summary(before) })
        return
      }
      case 'chat':
        if (this.streams.size) this.push(null, { t: 'chat', chat: this.summary(ev.chat) })
        return
      case 'chat-removed':
        this.states.delete(ev.chatId)
        this.open.delete(ev.chatId)
        this.push(null, { t: 'gone', chatId: ev.chatId })
        return
      case 'item': {
        const chat = this.hub.chats.get(ev.chatId)
        if (!chat) return
        const it = ev.item
        const ask = (it.kind === 'permission' || it.kind === 'question') && it.status === 'pending'
        const lead = this.hub.lead(chat)?.id === ev.accountId
        if (ask) {
          const set = this.open.get(ev.chatId) || new Set<string>()
          set.add(it.id)
          this.open.set(ev.chatId, set)
          this.push(null, { t: 'chat', chat: this.summary(chat) })
        }
        if (!lead && !ask) return
        const r = this.row(it, lead ? undefined : this.nameOf(ev.accountId))
        if (r) this.push(ev.chatId, { t: 'row', chatId: ev.chatId, row: r })
        return
      }
      case 'item-patch': {
        const chat = this.hub.chats.get(ev.chatId)
        if (!chat) return
        const set = this.open.get(ev.chatId)
        const ask = !!set?.has(ev.id)
        if (ask && typeof ev.patch.status === 'string' && ev.patch.status !== 'pending') {
          set?.delete(ev.id)
          this.push(null, { t: 'chat', chat: this.summary(chat) })
        }
        if (!ask && this.hub.lead(chat)?.id !== ev.accountId) return
        const patch: Record<string, unknown> = {}
        if (typeof ev.patch.text === 'string') patch.text = clip(plain(ev.patch.text), 30_000)
        if ('streaming' in ev.patch) patch.st = ev.patch.streaming ? 'streaming' : ''
        if ('queued' in ev.patch) patch.st = ev.patch.queued ? 'queued' : ''
        if (typeof ev.patch.status === 'string') patch.st = ev.patch.status === 'always' ? 'allowed' : ev.patch.status
        if (ev.patch.withdrawn) patch.gone = true
        if (Object.keys(patch).length) this.push(ev.chatId, { t: 'patch', chatId: ev.chatId, id: ev.id, patch })
        return
      }
      case 'item-delta': {
        if (!this.streams.size) return
        const chat = this.hub.chats.get(ev.chatId)
        if (chat && this.hub.lead(chat)?.id === ev.accountId) this.push(ev.chatId, { t: 'delta', chatId: ev.chatId, id: ev.id, text: ev.text })
        return
      }
      default:
        return
    }
  }

  /** A goal that has just finished (met, stopped, or blocked on the user) is told once. */
  private goalNews(chat: Chat): void {
    const st = chat.goal?.status || ''
    const before = this.goals.get(chat.id)
    this.goals.set(chat.id, st)
    if (before === undefined || before === st) return
    if (st === 'met' || st === 'stopped') this.pusher.note('goals')
    else if (st === 'blocked') this.pusher.note('needs')
  }

  // ----- from anywhere: what the settings show and change -----

  /** Where "From anywhere" stands: Tailscale on this computer, HTTPS for its name, the relay, notifications. */
  async reach(): Promise<RemoteReach> {
    const ts = await this.tailscale.status()
    const cert = this.tailscale.certInfo()
    const rel = this.relay.status()
    const code = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing.code : null
    const ip = ts.ips.find((x) => x.includes('.'))
    return {
      tailscale: {
        installed: ts.installed,
        running: ts.running,
        name: ts.dnsName || null,
        url: ts.running && ip && this.listening ? `http://${ip}:${this.port}` : null,
        httpsReady: !!ts.dnsName && ts.certDomains.includes(ts.dnsName),
      },
      https: { on: !!this.data().https, cert: cert ? { name: cert.name, expires: cert.expires } : null, url: this.tls && cert ? `https://${cert.name}:${this.tlsPort}` : null },
      relay: { url: rel.url, on: rel.on, connected: rel.connected, error: rel.error || null, link: this.relay.link(code) },
      push: { ...this.pusher.kinds, phones: this.devices().filter((d) => d.push).length },
    }
  }

  async setReach(patch: RemoteReachPatch): Promise<RemoteReach> {
    if (patch.relayUrl !== undefined || patch.relayOn !== undefined) {
      this.relay.set({ url: typeof patch.relayUrl === 'string' ? patch.relayUrl : undefined, on: typeof patch.relayOn === 'boolean' ? patch.relayOn : undefined })
      // The relay connects only while Phone and remote itself is on.
      if (!this.on) this.relay.stop()
    }
    if (patch.push && typeof patch.push === 'object') this.pusher.setKinds(patch.push)
    if (typeof patch.https === 'boolean') {
      this.data().https = patch.https
      this.save(true)
      if (patch.https) await this.startTls()
      else this.stopTls()
    }
    return this.reach()
  }

  /** The user pressed "Get the HTTPS certificate": runs `tailscale cert` for this machine's name, now. */
  async tailscaleCert(): Promise<RemoteReach> {
    const r = await this.tailscale.cert()
    if (r.ok) {
      this.data().https = true
      this.save(true)
      this.stopTls()
      await this.startTls()
    }
    return { ...(await this.reach()), ...(r.ok ? {} : { certError: r.error }) }
  }

  /** HTTPS on the Tailscale name: only with a certificate the user asked for, and only while turned on. */
  private async startTls(): Promise<void> {
    if (this.tls || !this.listening || !this.data().https) return
    const cert = this.tailscale.certInfo()
    if (!cert) return
    // The certificate's private key is kept sealed on disk and opened only into memory.
    const key = this.tailscale.readKey()
    let crt: Buffer
    try {
      crt = fs.readFileSync(this.tailscale.certFile)
    } catch {
      return
    }
    if (!key) return
    await new Promise<void>((resolve) => {
      const server = https.createServer({ key, cert: crt, connectionsCheckingInterval: 2_000 } as https.ServerOptions, (req, res) => void this.handle(req, res, true))
      // Before the TLS handshake: from outside the local network or the private network, cut at once.
      server.on('connection', (socket: import('node:net').Socket) => {
        if (!localPeer(socket.remoteAddress)) socket.destroy()
      })
      server.headersTimeout = REMOTE_LIMITS.headersMs
      server.requestTimeout = REMOTE_LIMITS.requestMs
      server.maxConnections = REMOTE_LIMITS.connections
      server.once('error', () => resolve())
      server.listen(this.port + 1, this.bind, () => {
        const a = server.address()
        this.tlsPort = typeof a === 'object' && a ? a.port : 0
        this.tls = server
        resolve()
      })
    })
    // Renewed before the 90 days run out (Tailscale's certificates are short-lived), once a day, only while HTTPS is on.
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => void this.renew(), 24 * 3600e3)
      this.renewTimer.unref?.()
    }
  }

  private async renew(): Promise<void> {
    const cert = this.tailscale.certInfo()
    if (!this.data().https || !cert || cert.expires - Date.now() > 30 * 86400e3) return
    const r = await this.tailscale.cert()
    if (r.ok) {
      this.stopTls()
      await this.startTls()
    }
  }

  private stopTls(): void {
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.renewTimer = null
    const t = this.tls
    this.tls = null
    this.tlsPort = 0
    if (!t) return
    t.close()
    t.closeAllConnections()
  }

  // ----- the page -----

  private find(name: string): string | null {
    const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const places = [res ? path.join(res, 'remote', name) : '', path.join(process.cwd(), 'resources', 'remote', name)].filter(Boolean)
    return places.find((p) => fs.existsSync(p)) || null
  }

  private sendPage(res: http.ServerResponse): void {
    const file = this.find('index.html')
    if (!file) throw new Refused(500, 'The phone page is missing from this build.')
    const mtime = fs.statSync(file).mtimeMs
    if (!this.page || this.page.mtime !== mtime) {
      const html = fs.readFileSync(file, 'utf8')
      // The page is one file with its script inside; only that exact script may run.
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
      const csp = `default-src 'none'; script-src 'self' ${scripts.join(' ')}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      this.page = { html, csp, mtime }
    }
    const body = Buffer.from(this.page.html, 'utf8')
    res.writeHead(200, this.headers({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length), 'Content-Security-Policy': this.page.csp }))
    res.end(body)
  }

  /** The tunnel client and the service worker (notifications), from the same folder as the page. */
  private sendScript(res: http.ServerResponse, name: string): void {
    const file = this.find(name)
    if (!file) throw new Refused(404, 'Not found.')
    const body = fs.readFileSync(file)
    res.writeHead(200, this.headers({ 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': String(body.length), ...(name === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) }))
    res.end(body)
  }

  private sendIcon(res: http.ServerResponse): void {
    const file = this.find('icon.png')
    if (!file) throw new Refused(404, 'Not found.')
    const body = fs.readFileSync(file)
    res.writeHead(200, this.headers({ 'Content-Type': 'image/png', 'Content-Length': String(body.length), 'Cache-Control': 'public, max-age=86400' }))
    res.end(body)
  }
}
