// "From anywhere", way 2: the computer's end of the end-to-end encrypted tunnel to paired phones,
// through a relay the user runs on their own Cloudflare account (relay/ in the repository).
//
// Off, and with no address, until the user enters one and turns it on: there is no built-in relay.
// Then the computer keeps ONE outbound WebSocket to its room (no port is opened on this computer),
// with backoff, and stops the moment it is turned off.
//
// The relay only ever sees opaque text. Each phone has its own P-256 key pair (private half kept on
// the phone, not extractable); this computer has one too (relay.json). Every connection makes fresh
// ephemeral keys on both sides; the session keys are HKDF-SHA-256 over
// ECDH(phone, computer) || ECDH(phone ephemeral, computer ephemeral), salted with the hash of the
// handshake, one AES-256-GCM key per direction, with a counter nonce that must go up by exactly one.
// So the relay cannot read, change, replay, drop-and-continue or inject a frame, and cannot pair a
// phone: pairing proves the one-time code from this computer's screen inside the encrypted channel.
// The phone's side is resources/remote/tunnel.js; the two must stay in step.
import path from 'node:path'
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import { readJson, writeJson } from './util'

/** What the phone server offers the tunnel. Every call ends in the same handlers and limits as on Wi-Fi. */
export interface TunnelHost {
  dataDir: string
  /** Checks a one-time pairing code (the same code, tries and expiry as on Wi-Fi) and adds the phone. */
  tunnelPair(code: string, name: string, pub: string): { device: { id: string; name: string } } | { error: string }
  /** A paired device, by id, with the public key it paired with. */
  tunnelDevice(id: string): { id: string; pub?: string } | null
  /** One API call from a paired device. */
  tunnelCall(deviceId: string, req: { m: string; p: string; b?: unknown; rid?: string }): Promise<{ s: number; b: unknown }>
  /** The live stream for a paired device: `send` gets the same text blocks /api/events writes. */
  tunnelStream(deviceId: string, path: string, send: (line: string) => void, end: () => void): { close(): void } | { s: number; b: unknown }
}

interface Stored {
  url: string
  on: boolean
  room: string
  secret: string
  /** This computer's identity: PKCS#8 PEM of its P-256 private key, and the raw public key (base64url). */
  key: string
  pub: string
}

/** A frame's plaintext above this many characters goes in pieces, each under the relay's frame limit. */
const PIECE = 120_000
/** What this computer takes from the relay: a frame's size, and how many phone connections it keeps state for. */
const MAX_RELAY_FRAME = 600_000
const MAX_SESSIONS = 16

/** The relay address the user may enter: https, or http only to this computer (for trying it locally). */
export function relayAddress(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, '')
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.username || u.password || u.search || u.hash) return null
  if (u.protocol === 'https:') return `${u.origin}${u.pathname === '/' ? '' : u.pathname}`
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return `${u.origin}${u.pathname === '/' ? '' : u.pathname}`
  return null
}

const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url')

/** A raw uncompressed P-256 point (65 bytes) as a key; throws when it is not a point on the curve. */
export function rawPublicKey(b64: string): KeyObject {
  const raw = unb64u(b64)
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not a P-256 public key')
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' })
}

function rawOf(pub: KeyObject): string {
  const j = pub.export({ format: 'jwk' }) as { x: string; y: string }
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)]))
}

/** The handshake's salt and the two directional keys; the same as deriveKeys in tunnel.js. */
export function deriveKeys(ikm: Buffer, transcript: string): { salt: Buffer; p2c: Buffer; c2p: Buffer } {
  const salt = createHash('sha256').update(transcript, 'utf8').digest()
  const key = (info: string): Buffer => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32))
  return { salt, p2c: key('ensemble p2c'), c2p: key('ensemble c2p') }
}

const nonceOf = (dir: number, n: number): Buffer => {
  const iv = Buffer.alloc(12)
  iv.writeUInt32BE(dir, 0)
  iv.writeBigUInt64BE(BigInt(n), 4)
  return iv
}

interface Session {
  cid: string
  kind: 'pair' | 'resume' | null
  keys: { salt: Buffer; p2c: Buffer; c2p: Buffer } | null
  in: number
  out: number
  /** The paired device this session speaks for, once its first frame has proved it. */
  device: string | null
  streams: Map<string, { close(): void }>
  pieces: number
  /** The phone's long-term key this session is keyed to (the stored one, for a paired phone), and its device id. */
  sp: string
  dev: string
}

export interface RelayStatus {
  url: string
  on: boolean
  connected: boolean
  error?: string
  room: string
  pub: string
}

export class RelayLink {
  private ws: WebSocket | null = null
  private timer: NodeJS.Timeout | null = null
  private retry = 0
  private sessions = new Map<string, Session>()
  private store: Stored | null = null
  private private: KeyObject | null = null
  private error: string | undefined
  private live = false
  /** Outbound connections tried, for the checks: none at all while it is off or has no address. */
  connects = 0
  /** Sessions ended because a frame did not decrypt or broke the protocol (changed, replayed, injected). */
  rejected = 0

  constructor(
    private host: TunnelHost,
    private opts: { WebSocket?: typeof WebSocket; sealer?: { seal(s: string): string; open(s: string): string } } = {},
  ) {}

  private file(): string {
    return path.join(this.host.dataDir, 'relay.json')
  }

  /** This computer's private key and the room secret are sealed on disk (Windows credential encryption in the app). */
  private atRest(v: string): string {
    return this.opts.sealer ? this.opts.sealer.seal(v) : v
  }

  private fromRest(v: unknown): string {
    if (typeof v !== 'string' || !v) return ''
    try {
      return this.opts.sealer ? this.opts.sealer.open(v) : v
    } catch {
      // Sealed for another Windows user, or damaged: a new key and room are made (phones pair again).
      return ''
    }
  }

  private write(d: Stored): void {
    writeJson(this.file(), { ...d, key: this.atRest(d.key), secret: this.atRest(d.secret) })
  }

  /** The stored settings; the room and this computer's keys are made the first time. */
  private data(): Stored {
    if (this.store) return this.store
    const raw = readJson<Partial<Stored>>(this.file(), {})
    let key = this.fromRest(raw.key)
    const secret = this.fromRest(raw.secret)
    let pub = typeof raw.pub === 'string' ? raw.pub : ''
    try {
      if (!key) throw new Error('none')
      this.private = createPrivateKey(key)
      pub = rawOf(createPublicKey(this.private))
    } catch {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      key = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
      this.private = pair.privateKey
      pub = rawOf(pair.publicKey)
    }
    this.store = {
      url: typeof raw.url === 'string' ? raw.url : '',
      on: raw.on === true,
      room: typeof raw.room === 'string' && /^[A-Za-z0-9_-]{22}$/.test(raw.room) ? raw.room : b64u(randomBytes(16)),
      secret: secret.length >= 32 ? secret : b64u(randomBytes(32)),
      key,
      pub,
    }
    this.write(this.store)
    return this.store
  }

  status(): RelayStatus {
    const d = this.data()
    return { url: d.url, on: d.on, connected: this.live, error: this.error, room: d.room, pub: d.pub }
  }

  get connected(): boolean {
    return this.live
  }

  /** The link the pairing QR carries: the relay's page, and (after #, never sent to any server) the room, this computer's key and the code. */
  link(code: string | null): string | null {
    const d = this.data()
    if (!d.on || !d.url || !code) return null
    return `${d.url}/#r=${d.room}&k=${d.pub}&c=${code.replace(/[^A-Z0-9]/gi, '')}`
  }

  /** Changes the address or the switch, saves, and connects or disconnects to match. */
  set(patch: { url?: string; on?: boolean }): RelayStatus {
    const d = this.data()
    if (patch.url !== undefined) {
      const url = patch.url.trim() ? relayAddress(patch.url) : ''
      if (url === null) {
        this.error = 'Enter the relay address, starting with https://.'
        return this.status()
      }
      if (url !== d.url) {
        d.url = url
        // A new relay is a new room: whatever the old relay saw of this one is of no use to it.
        d.room = b64u(randomBytes(16))
        d.secret = b64u(randomBytes(32))
      }
    }
    if (patch.on !== undefined) d.on = patch.on
    this.error = undefined
    this.write(d)
    this.stop()
    this.start()
    return this.status()
  }

  /** Connects when it is on and has an address; otherwise does nothing at all. */
  start(): void {
    const d = this.data()
    if (!d.on || !d.url || this.ws || this.timer) return
    this.connect()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.retry = 0
    const ws = this.ws
    this.ws = null
    this.live = false
    for (const s of this.sessions.values()) this.end(s)
    this.sessions.clear()
    try {
      ws?.close()
    } catch {
      /* already closed */
    }
  }

  dispose(): void {
    this.stop()
  }

  /** A paired phone was removed: its sessions are told and cut at once. */
  cut(deviceId: string): void {
    for (const s of [...this.sessions.values()]) {
      if (s.device !== deviceId) continue
      this.seal(s, { t: 'bye' })
      this.kick(s)
    }
  }

  private connect(): void {
    const d = this.data()
    if (!d.on || !d.url) return
    const WS = this.opts.WebSocket || globalThis.WebSocket
    const url = `${d.url.replace(/^http/, 'ws')}/room/${d.room}/pc`
    this.connects++
    let ws: WebSocket
    try {
      ws = new WS(url)
    } catch (e) {
      this.error = (e as Error).message
      return this.later()
    }
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ t: 'claim', s: d.secret }))
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data)
      // The relay's own limit is 256 KB a frame; one that sends more is not keeping to the protocol.
      if (text.length > MAX_RELAY_FRAME) return
      this.onRelay(text)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.live = false
      for (const s of this.sessions.values()) this.end(s)
      this.sessions.clear()
      if (ev.code === 4003) this.error = 'The relay knows this room as someone else’s. Turn it off and on again to make a new room.'
      else if (!this.error) this.error = 'Not connected to the relay.'
      this.later()
    }
    ws.onerror = () => {
      this.error = 'The relay could not be reached.'
    }
  }

  /** Tries again after a while: 1 s, then doubling to a minute, with some spread. */
  private later(): void {
    const d = this.data()
    if (!d.on || !d.url || this.timer) return
    const ms = Math.min(60_000, 1000 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, ms)
    this.timer.unref?.()
  }

  private relaySend(obj: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(obj))
    } catch {
      /* the close handler deals with it */
    }
  }

  private kick(s: Session): void {
    this.end(s)
    this.sessions.delete(s.cid)
    this.relaySend({ t: 'kick', c: s.cid })
  }

  private end(s: Session): void {
    for (const st of s.streams.values()) st.close()
    s.streams.clear()
  }

  private onRelay(text: string): void {
    let m: { t?: string; c?: string; d?: string }
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (m.t === 'ok') {
      this.live = true
      this.retry = 0
      this.error = undefined
      return
    }
    if (typeof m.c !== 'string') return
    if (m.t === 'open') {
      // The relay admits 8 phones a room. More "phones" than that is a relay (or someone on it) making the computer hold sessions.
      if (this.sessions.size >= MAX_SESSIONS || m.c.length > 64) return this.relaySend({ t: 'kick', c: m.c.slice(0, 64) })
      this.sessions.set(m.c, { cid: m.c, kind: null, keys: null, in: 0, out: 0, device: null, streams: new Map(), pieces: 0, sp: '', dev: '' })
      return
    }
    if (m.t === 'gone') {
      const s = this.sessions.get(m.c)
      if (s) this.end(s)
      this.sessions.delete(m.c)
      return
    }
    if (m.t === 'from' && typeof m.d === 'string') {
      const s = this.sessions.get(m.c)
      if (s) void this.onFrame(s, m.d)
    }
  }

  /** Something in a session broke the protocol: it ends, and the phone starts a fresh one. */
  private reject(s: Session): void {
    this.rejected++
    this.kick(s)
  }

  private seal(s: Session, obj: Record<string, unknown>): void {
    if (!s.keys) return
    const json = JSON.stringify(obj)
    // Large answers (a long chat) go in pieces, each sealed on its own, in order.
    const parts = json.length <= PIECE ? [json] : (() => {
      const id = `f${++s.pieces}`
      const n = Math.ceil(json.length / PIECE)
      return Array.from({ length: n }, (_, i) => JSON.stringify({ t: 'frag', id, i, n, s: json.slice(i * PIECE, (i + 1) * PIECE) }))
    })()
    for (const part of parts) {
      const c = createCipheriv('aes-256-gcm', s.keys.c2p, nonceOf(2, s.out++))
      c.setAAD(s.keys.salt)
      const ct = Buffer.concat([c.update(part, 'utf8'), c.final(), c.getAuthTag()])
      this.relaySend({ t: 'to', c: s.cid, d: `e.${b64u(ct)}` })
    }
  }

  private open(s: Session, d: string): Record<string, unknown> {
    if (!s.keys || !d.startsWith('e.')) throw new Error('not sealed')
    const raw = unb64u(d.slice(2))
    if (raw.length < 17) throw new Error('short')
    const dc = createDecipheriv('aes-256-gcm', s.keys.p2c, nonceOf(1, s.in))
    dc.setAAD(s.keys.salt)
    dc.setAuthTag(raw.subarray(raw.length - 16))
    const pt = Buffer.concat([dc.update(raw.subarray(0, raw.length - 16)), dc.final()])
    s.in++
    const v = JSON.parse(pt.toString('utf8'))
    if (!v || typeof v !== 'object') throw new Error('not an object')
    return v
  }

  private async onFrame(s: Session, d: string): Promise<void> {
    if (!s.keys) return this.handshake(s, d)
    let f: Record<string, unknown>
    try {
      f = this.open(s, d)
    } catch {
      return this.reject(s)
    }
    // The first frame of a session proves it: the pairing code, or a hello under a paired phone's keys.
    if (!s.device) {
      if (s.kind === 'pair' && f.t === 'pair') {
        const r = this.host.tunnelPair(String(f.code || ''), String(f.name || ''), s.sp)
        if ('error' in r) {
          this.seal(s, { t: 'refused', error: r.error })
          return this.kick(s)
        }
        s.device = r.device.id
        return this.seal(s, { t: 'paired', device: r.device })
      }
      if (s.kind === 'resume' && f.t === 'hello') {
        s.device = s.dev || null
        if (!s.device || !this.host.tunnelDevice(s.device)) return this.reject(s)
        return this.seal(s, { t: 'ready' })
      }
      return this.reject(s)
    }
    const device = s.device
    if (!this.host.tunnelDevice(device)) {
      this.seal(s, { t: 'bye' })
      return this.kick(s)
    }
    const id = typeof f.id === 'string' ? f.id.slice(0, 40) : ''
    if (f.t === 'req' && id) {
      const r = await this.host.tunnelCall(device, { m: String(f.m || 'GET'), p: String(f.p || ''), b: f.b, rid: typeof f.rid === 'string' ? f.rid : undefined })
      if (this.sessions.get(s.cid) === s) this.seal(s, { t: 'res', id, s: r.s, b: r.b })
      return
    }
    if (f.t === 'sub' && id) {
      s.streams.get(id)?.close()
      const r = this.host.tunnelStream(
        device,
        String(f.p || ''),
        (line) => this.seal(s, { t: 'ev', id, line }),
        () => s.streams.delete(id),
      )
      if ('close' in r) s.streams.set(id, r)
      else this.seal(s, { t: 'res', id, s: r.s, b: r.b })
      return
    }
    if (f.t === 'unsub' && id) {
      s.streams.get(id)?.close()
      s.streams.delete(id)
      return
    }
    return this.reject(s)
  }

  /** The phone's hello, in the clear (only public keys and a nonce): the answer, and the session keys. */
  private handshake(s: Session, d: string): void {
    let h: { k?: string; sp?: string; ep?: string; n?: string; dev?: string }
    try {
      if (d.length > 2000) throw new Error('long')
      h = JSON.parse(d)
    } catch {
      return this.reject(s)
    }
    if ((h.k !== 'pair' && h.k !== 'resume') || typeof h.ep !== 'string' || typeof h.n !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(h.n) || typeof h.sp !== 'string') return this.reject(s)
    let sp = h.sp
    let dev = ''
    if (h.k === 'resume') {
      dev = String(h.dev || '')
      const known = this.host.tunnelDevice(dev)
      // The key the phone paired with, never the one this hello claims.
      if (!known?.pub) {
        this.relaySend({ t: 'to', c: s.cid, d: JSON.stringify({ k: 'unknown' }) })
        this.sessions.delete(s.cid)
        this.relaySend({ t: 'kick', c: s.cid })
        return
      }
      sp = known.pub
    }
    let phoneStatic: KeyObject
    let phoneEph: KeyObject
    try {
      phoneStatic = rawPublicKey(sp)
      phoneEph = rawPublicKey(h.ep)
    } catch {
      return this.reject(s)
    }
    const d0 = this.data()
    const eph = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const ephPub = rawOf(eph.publicKey)
    const nonce = b64u(randomBytes(16))
    const ikm = Buffer.concat([diffieHellman({ privateKey: this.private as KeyObject, publicKey: phoneStatic }), diffieHellman({ privateKey: eph.privateKey, publicKey: phoneEph })])
    const transcript = ['ensemble-tunnel-1', h.k, h.k === 'pair' ? h.sp : sp, h.ep, h.n, d0.pub, ephPub, nonce, dev].join('|')
    s.kind = h.k
    s.keys = deriveKeys(ikm, transcript)
    s.sp = sp
    s.dev = dev
    this.relaySend({ t: 'to', c: s.cid, d: JSON.stringify({ k: 'hi', ep: ephPub, n: nonce }) })
  }
}
