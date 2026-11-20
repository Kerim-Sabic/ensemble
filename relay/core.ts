// The relay's whole logic, shared by the Cloudflare Worker (worker.ts) and the local Node relay
// (node.ts) so both speak exactly the same protocol.
//
// The relay is a dumb pipe between one computer and its paired phones. It never sees content: every
// frame between a phone and the computer is end-to-end encrypted before it gets here (the phone's
// tunnel.js and Ensemble's src/main/relay.ts), and the relay only moves opaque text along.
//
// What it keeps: per room, the SHA-256 of the computer's room secret (so only that computer can
// take the room again after a reconnect). Nothing else is stored: no frames, no keys, no sign-ins.
//
// Protocol (JSON text messages over WebSocket):
//   computer -> relay   {t:'claim', s:<room secret, base64url>}   first message, within CLAIM_MS
//                       {t:'to', c:<phone connection id>, d:<opaque>}
//                       {t:'kick', c}
//   relay -> computer   {t:'ok'}  {t:'open', c}  {t:'from', c, d}  {t:'gone', c}
//   phone -> relay      {t:'d', d:<opaque>}
//   relay -> phone      {t:'d', d}  {t:'offline'} (then closed: the computer is not connected)

export const RELAY_LIMITS = {
  /** One frame, in characters (the opaque payload is base64, so about 190 KB of data). */
  frame: 256 * 1024,
  /** Phones connected to one room at once. */
  phones: 8,
  /** Frames a phone may send per second, sustained, and as a burst. */
  phoneRate: 40,
  phoneBurst: 80,
  /** Frames the computer may send per second (it streams replies to several phones), and as a burst. */
  pcRate: 400,
  pcBurst: 800,
  /** How long a computer has to claim its room after connecting. */
  claimMs: 5_000,
} as const

/** A room id: 16 random bytes, base64url (22 characters). Anything else is refused before a room is touched. */
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/

export type Role = 'pc' | 'phone'

/** What the relay remembers about one connection (kept with the socket; the Worker serialises it). */
export interface ConnMeta {
  role: Role
  /** The phone connection's id, made by the relay; the computer addresses phones by it. */
  cid: string
  /** For the computer: whether it has proved the room is its own. */
  claimed: boolean
  /** Token bucket. */
  tokens: number
  at: number
  /** Refused when it connected (no computer in the room, or the room is full): the close code. Nothing from it is passed on. */
  refused?: number
}

export interface Conn {
  meta: ConnMeta
  send(text: string): void
  close(code: number, reason: string): void
}

export interface RoomHost {
  /** Every open connection of this room. */
  conns(): Conn[]
  /** The stored SHA-256 (hex) of the room secret, or null for a room never claimed. */
  storedHash(): Promise<string | null>
  storeHash(hash: string): Promise<void>
  /** Called when a connection's meta changed (the Worker serialises it with the socket). */
  saved?(conn: Conn): void
  sha256Hex(text: string): Promise<string>
  /** For checks: every frame as the relay sees it, and a chance to alter it in transit. */
  tap?(from: Role, conn: Conn, text: string): string | null | undefined
  now?(): number
}

export function newMeta(role: Role, cid: string, now = Date.now()): ConnMeta {
  return { role, cid, claimed: false, tokens: role === 'pc' ? RELAY_LIMITS.pcBurst : RELAY_LIMITS.phoneBurst, at: now }
}

/** One more frame from this connection: false when it is over its rate. */
function spend(m: ConnMeta, now: number): boolean {
  const rate = m.role === 'pc' ? RELAY_LIMITS.pcRate : RELAY_LIMITS.phoneRate
  const burst = m.role === 'pc' ? RELAY_LIMITS.pcBurst : RELAY_LIMITS.phoneBurst
  m.tokens = Math.min(burst, m.tokens + ((now - m.at) / 1000) * rate)
  m.at = now
  if (m.tokens < 1) return false
  m.tokens -= 1
  return true
}

const pcOf = (host: RoomHost): Conn | undefined => host.conns().find((c) => c.meta.role === 'pc' && c.meta.claimed)
const phoneOf = (host: RoomHost, cid: string): Conn | undefined => host.conns().find((c) => c.meta.role === 'phone' && c.meta.cid === cid && !c.meta.refused)

/** A connection has opened. A phone with no computer behind it is told so and closed. */
export function onOpen(host: RoomHost, conn: Conn): void {
  if (conn.meta.role === 'pc') return
  const pc = pcOf(host)
  // By id, not by object: the Worker hands out a new wrapper for a socket every time it lists them.
  const phones = host.conns().filter((c) => c.meta.role === 'phone' && c.meta.cid !== conn.meta.cid).length
  if (!pc) {
    conn.meta.refused = 4004
    conn.send(JSON.stringify({ t: 'offline' }))
    conn.close(4004, 'computer offline')
    return
  }
  if (phones >= RELAY_LIMITS.phones) {
    conn.meta.refused = 4029
    conn.close(4029, 'too many phones')
    return
  }
  pc.send(JSON.stringify({ t: 'open', c: conn.meta.cid }))
}

export async function onMessage(host: RoomHost, conn: Conn, raw: string): Promise<void> {
  const now = host.now?.() ?? Date.now()
  if (typeof raw !== 'string' || raw.length > RELAY_LIMITS.frame) return conn.close(4013, 'frame too large')
  const ok = spend(conn.meta, now)
  host.saved?.(conn)
  if (!ok) return conn.close(4029, 'too many frames')
  let m: { t?: unknown; s?: unknown; c?: unknown; d?: unknown }
  try {
    m = JSON.parse(raw)
  } catch {
    return conn.close(4000, 'not json')
  }
  if (!m || typeof m !== 'object') return conn.close(4000, 'not an object')

  if (conn.meta.role === 'pc') {
    if (!conn.meta.claimed) {
      if (m.t !== 'claim' || typeof m.s !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(m.s)) return conn.close(4001, 'claim first')
      const hash = await host.sha256Hex(m.s)
      const stored = await host.storedHash()
      if (stored && stored !== hash) return conn.close(4003, 'not this room')
      if (!stored) await host.storeHash(hash)
      // A computer that reconnects takes over from its old connection.
      for (const c of host.conns()) if (c.meta.cid !== conn.meta.cid && c.meta.role === 'pc') c.close(4009, 'replaced')
      conn.meta.claimed = true
      host.saved?.(conn)
      conn.send(JSON.stringify({ t: 'ok' }))
      // Phones that were waiting are introduced (not the ones that were refused: those connect again).
      for (const c of host.conns()) if (c.meta.role === 'phone' && !c.meta.refused) conn.send(JSON.stringify({ t: 'open', c: c.meta.cid }))
      return
    }
    if (m.t === 'to' && typeof m.c === 'string' && typeof m.d === 'string') {
      const phone = phoneOf(host, m.c)
      if (!phone) return conn.send(JSON.stringify({ t: 'gone', c: m.c }))
      const out = host.tap ? host.tap('pc', conn, m.d) : m.d
      if (out == null) return
      phone.send(JSON.stringify({ t: 'd', d: out }))
      return
    }
    if (m.t === 'kick' && typeof m.c === 'string') {
      phoneOf(host, m.c)?.close(4010, 'closed by the computer')
      return
    }
    return conn.close(4000, 'unknown message')
  }

  // A phone that was refused when it connected stays refused: it has to connect again.
  if (conn.meta.refused) return conn.close(conn.meta.refused, 'refused')
  // A phone: data only, passed to the computer as it is.
  if (m.t !== 'd' || typeof m.d !== 'string') return conn.close(4000, 'unknown message')
  const pc = pcOf(host)
  if (!pc) {
    conn.send(JSON.stringify({ t: 'offline' }))
    return conn.close(4004, 'computer offline')
  }
  const out = host.tap ? host.tap('phone', conn, m.d) : m.d
  if (out == null) return
  pc.send(JSON.stringify({ t: 'from', c: conn.meta.cid, d: out }))
}

export function onClose(host: RoomHost, conn: Conn): void {
  if (conn.meta.role === 'phone') {
    pcOf(host)?.send(JSON.stringify({ t: 'gone', c: conn.meta.cid }))
    return
  }
  // The computer went away: its phones are told, so they can wait and try again.
  if (conn.meta.claimed && !pcOf(host)) {
    for (const c of host.conns()) {
      if (c.meta.role !== 'phone') continue
      c.send(JSON.stringify({ t: 'offline' }))
      c.close(4004, 'computer offline')
    }
  }
}

/** What the relay answers at /relay.json: that it is a relay, and its limits. No room, no state. */
export const RELAY_INFO = { relay: true, protocol: 1, limits: RELAY_LIMITS }

/** The content policy for the phone page the relay serves. */
export function pageCsp(scriptHashes: string[]): string {
  return `default-src 'none'; script-src 'self' ${scriptHashes.join(' ')}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
}
