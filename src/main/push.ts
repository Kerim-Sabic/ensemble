// Notifications to paired phones, sent by this computer straight to the phone's push service
// (Apple's, for an iPhone), outbound only. Standard Web Push, built on node:crypto with no package:
//   RFC 8291 (message encryption: ECDH P-256 + HKDF-SHA-256 + AES-128-GCM, "aes128gcm" coding, RFC 8188)
//   RFC 8292 (VAPID: an ES256-signed token naming this sender, with its public key)
// The push service sees only that a notification goes to that phone, never what it says.
// What a notification says is kept short and free of private detail: no chat titles, no content.
import path from 'node:path'
import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { readJson, writeJson } from './util'

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export type PushKind = 'needs' | 'goals' | 'found'
export const PUSH_KINDS: PushKind[] = ['needs', 'goals', 'found']

const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url')

function rawPoint(pub: KeyObject): Buffer {
  const j = pub.export({ format: 'jwk' }) as { x: string; y: string }
  return Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)])
}
const pointKey = (raw: Buffer): KeyObject => {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not a P-256 public key')
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' })
}

/** A subscription the phone sent: an https endpoint, a P-256 key and a 16-byte secret. Anything else is refused. */
/** Apple (Safari, iOS Home Screen apps), Google (Chrome, Android, Edge on Android), Mozilla, Microsoft (Edge on Windows). */
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/]

export function validSubscription(v: unknown): PushSubscription | null {
  const s = v as PushSubscription
  if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return null
  let u: URL
  try {
    u = new URL(s.endpoint)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || s.endpoint.length > 1000) return null
  // Only the push services browsers really use: a phone cannot make this computer send requests anywhere else.
  if (u.username || u.password || (u.port && u.port !== '443') || !PUSH_HOSTS.some((h) => h.test(u.hostname))) return null
  try {
    pointKey(unb64u(s.keys.p256dh))
  } catch {
    return null
  }
  if (unb64u(s.keys.auth).length !== 16) return null
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }
}

/**
 * RFC 8291: the payload encrypted for one subscription, as the request body ("aes128gcm" content
 * coding, one record). `fixed` is for checks only (a known salt and sender key).
 */
export function encryptPayload(sub: PushSubscription, payload: Buffer, fixed?: { salt: Buffer; key: KeyObject }): Buffer {
  const uaPub = unb64u(sub.keys.p256dh)
  const auth = unb64u(sub.keys.auth)
  const as = fixed?.key ? { privateKey: fixed.key, publicKey: createPublicKey(fixed.key) } : generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const asPub = rawPoint(as.publicKey)
  const shared = diffieHellman({ privateKey: as.privateKey, publicKey: pointKey(uaPub) })
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPub, asPub])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32))
  const salt = fixed?.salt || randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))
  // One record: the payload, then the delimiter 0x02 that marks the last record (no padding).
  const c = createCipheriv('aes-128-gcm', cek, nonce)
  const ct = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(asPub.length, 20)
  return Buffer.concat([header, asPub, ct])
}

/** RFC 8292: the Authorization header for one push service, signed with this computer's VAPID key. */
export function vapidAuth(endpoint: string, key: { priv: KeyObject; pub: string }, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: key.priv, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${key.pub}`
}

export interface PushTarget {
  id: string
  push?: PushSubscription
}

/**
 * Sends what needs telling to every phone that turned notifications on, a few seconds after the
 * first event of a burst, as one notification per kind ("3 things need your answer").
 */
export class Pusher {
  private store: { priv: string; pub: string; kinds: Record<PushKind, boolean> } | null = null
  private key: KeyObject | null = null
  private due = new Map<PushKind, number>()
  private timer: NodeJS.Timeout | null = null
  /** For checks: what was sent, and to which endpoint. */
  sent: { endpoint: string; kind: PushKind; status: number }[] = []

  constructor(
    private o: {
      dataDir: string
      /** Seals the sending key at rest (Windows credential encryption in the app). */
      sealer?: { seal(s: string): string; open(s: string): string }
      /** True while the person is at the computer (the window is in front): nothing is sent then. */
      quiet?: () => boolean
      /** The phones that may get a notification now. */
      targets(): PushTarget[]
      /** A subscription the push service says is gone: the phone's notifications are switched off. */
      expired(deviceId: string): void
      /** Who sends (the relay address when there is one): push services want a contact URL. */
      subject(): string
      fetch?: typeof fetch
      groupMs?: number
    },
  ) {}

  private data(): { priv: string; pub: string; kinds: Record<PushKind, boolean> } {
    if (this.store) return this.store
    const file = path.join(this.o.dataDir, 'push.json')
    const raw = readJson<{ priv?: string; pub?: string; kinds?: Partial<Record<PushKind, boolean>> }>(file, {})
    let priv = ''
    try {
      priv = raw.priv ? (this.o.sealer ? this.o.sealer.open(raw.priv) : raw.priv) : ''
      this.key = createPrivateKey(priv)
    } catch {
      // None yet, or sealed for another Windows user: a new key (phones turn notifications on again).
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      priv = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
      this.key = pair.privateKey
    }
    const kinds = { needs: raw.kinds?.needs !== false, goals: raw.kinds?.goals !== false, found: raw.kinds?.found !== false }
    this.store = { priv, pub: b64u(rawPoint(createPublicKey(this.key))), kinds }
    this.write()
    return this.store
  }

  /** The sending key is sealed on disk (Windows credential encryption in the app). */
  private write(): void {
    const d = this.store
    if (!d) return
    writeJson(path.join(this.o.dataDir, 'push.json'), { ...d, priv: this.o.sealer ? this.o.sealer.seal(d.priv) : d.priv })
  }

  /** The public VAPID key the phone subscribes with. */
  get publicKey(): string {
    return this.data().pub
  }

  get kinds(): Record<PushKind, boolean> {
    return { ...this.data().kinds }
  }

  setKinds(patch: Partial<Record<PushKind, boolean>>): Record<PushKind, boolean> {
    const d = this.data()
    for (const k of PUSH_KINDS) if (typeof patch[k] === 'boolean') d.kinds[k] = patch[k] as boolean
    this.write()
    return this.kinds
  }

  /** Something of this kind happened: it goes out with whatever else of its kind comes in the next few seconds. */
  note(kind: PushKind): void {
    if (!this.data().kinds[kind]) return
    // At the computer, the window shows it: the phone stays quiet.
    if (this.o.quiet?.()) return
    if (!this.o.targets().some((t) => t.push)) return
    this.due.set(kind, (this.due.get(kind) || 0) + 1)
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), this.o.groupMs ?? 8_000)
    this.timer.unref?.()
  }

  /** The words: short, and nothing that names a chat or quotes it. */
  static words(kind: PushKind, n: number): { title: string; body: string } {
    if (kind === 'needs') return { title: 'Ensemble needs you', body: n === 1 ? 'Something is waiting for your answer.' : `${n} things are waiting for your answer.` }
    if (kind === 'goals') return { title: 'Ensemble', body: n === 1 ? 'A goal has finished.' : `${n} goals have finished.` }
    return { title: 'Ensemble', body: n === 1 ? 'A watch found something.' : `Watches found ${n} things.` }
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const due = [...this.due]
    this.due.clear()
    // Came back to the computer while the burst was gathering: nothing goes to the phone.
    if (this.o.quiet?.()) return
    for (const [kind, n] of due) {
      const msg = Buffer.from(JSON.stringify({ ...Pusher.words(kind, n), kind, tag: kind }))
      for (const t of this.o.targets()) if (t.push) await this.send(t, kind, msg)
    }
  }

  private async send(t: PushTarget, kind: PushKind, msg: Buffer): Promise<void> {
    const sub = t.push as PushSubscription
    const d = this.data()
    let status = 0
    try {
      const res = await (this.o.fetch || fetch)(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuth(sub.endpoint, { priv: this.key as KeyObject, pub: d.pub }, this.o.subject()),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: kind === 'needs' ? '3600' : '86400',
          Urgency: kind === 'needs' ? 'high' : 'normal',
          Topic: kind,
        },
        body: encryptPayload(sub, msg),
        // A push service has no reason to send this elsewhere: a redirect is an error, not followed.
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      status = res.status
    } catch {
      status = 0
    }
    this.sent.push({ endpoint: sub.endpoint, kind, status })
    if (this.sent.length > 50) this.sent.shift()
    if (status === 404 || status === 410) this.o.expired(t.id)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
