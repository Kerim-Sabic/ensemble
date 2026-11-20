// Phone from anywhere (Developer): the relay run locally in Node, the phone's own tunnel client
// (resources/remote/tunnel.js, the file the phone page loads), and Ensemble's end of the tunnel,
// spoken to the way an iPhone would. Then attacked: what the relay sees, changed, replayed and
// injected frames, a stranger in the room, a guessed code, a removed phone, floods.
import http from 'node:http'
import path from 'node:path'
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, verify } from 'node:crypto'
import type { Ctx } from './ctx'
import { startRelay } from '../../relay/node'
import { RELAY_LIMITS } from '../../relay/core'
import { RelayLink, relayAddress } from '../../src/main/relay'
import { Pusher, encryptPayload, vapidAuth, validSubscription, type PushSubscription } from '../../src/main/push'
import { Tailscale, parseStatus, type Runner } from '../../src/main/tailscale'
import type { RemoteServer } from '../../src/main/remote'
import type { InboxItem } from '../../src/shared/watches'
import type { PermissionDecision } from '../../src/shared/types'
import '../../resources/remote/tunnel.js'

interface Tunnel {
  deviceId: string | null
  request(method: string, path: string, body?: unknown, opts?: { rid?: string; timeoutMs?: number }): Promise<{ status: number; json: any }> // eslint-disable-line @typescript-eslint/no-explicit-any
  stream(path: string, onLine: (line: string) => void): { close(): void }
  wake(): void
  close(): void
}
interface TunnelApi {
  createIdentity(): Promise<{ privateKey: CryptoKey; pub: string }>
  open(o: Record<string, unknown>): Tunnel
  readLink(hash: string): { room: string; pcPub: string; code: string } | null
}
const T = (globalThis as unknown as { EnsembleTunnel: TunnelApi }).EnsembleTunnel

const b64u = (b: Buffer): string => b.toString('base64url')

export default async function (c: Ctx): Promise<void> {
  const { check, same, pause } = c
  const settle = async (what: string, test: () => boolean, ms = 8000): Promise<void> => {
    const end = Date.now() + ms
    while (!test()) {
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
      await pause(20)
    }
  }

  // ───────────── pure parts first: addresses, push, Tailscale ─────────────
  same('a relay address must be https (http only to this computer)', [relayAddress('https://relay.example.workers.dev/'), relayAddress('http://example.com'), relayAddress('http://127.0.0.1:8787'), relayAddress('https://u:p@x.dev'), relayAddress('ftp://x'), relayAddress('')], ['https://relay.example.workers.dev', null, 'http://127.0.0.1:8787', null, null, null])

  // Push: a test subscription (what an iPhone's push service hands the page), decrypted here independently (RFC 8291 receiver side).
  const ua = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const uaJwk = ua.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const uaRaw = Buffer.concat([Buffer.from([4]), Buffer.from(uaJwk.x, 'base64url'), Buffer.from(uaJwk.y, 'base64url')])
  const auth = randomBytes(16)
  const sub: PushSubscription = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH6vk1', keys: { p256dh: b64u(uaRaw), auth: b64u(auth) } }
  const decrypt = (body: Buffer): string => {
    const salt = body.subarray(0, 16)
    const idlen = body[20]
    const asRaw = body.subarray(21, 21 + idlen)
    const ct = body.subarray(21 + idlen)
    const asPub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(asRaw.subarray(1, 33)), y: b64u(asRaw.subarray(33)) }, format: 'jwk' })
    const shared = diffieHellman({ privateKey: ua.privateKey, publicKey: asPub })
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaRaw, asRaw]), 32))
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
    const d = createDecipheriv('aes-128-gcm', cek, nonce)
    d.setAuthTag(ct.subarray(ct.length - 16))
    const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
    if (pt[pt.length - 1] !== 2) throw new Error('no last-record delimiter')
    return pt.subarray(0, pt.length - 1).toString('utf8')
  }
  same('push: the payload decrypts with the subscription\'s own keys (RFC 8291, aes128gcm)', decrypt(encryptPayload(sub, Buffer.from('{"title":"Ensemble"}'))), '{"title":"Ensemble"}')
  const vk = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const vj = vk.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const vpub = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(vj.x, 'base64url'), Buffer.from(vj.y, 'base64url')]))
  const header = vapidAuth(sub.endpoint, { priv: vk.privateKey, pub: vpub }, 'https://relay.example.workers.dev')
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
  const claims = m ? JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')) : {}
  const vOk = !!m && verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: vk.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))
  check('push: the VAPID header verifies with the public key it names, for that push service, for at most a day (RFC 8292)', vOk && m?.[4] === vpub && claims.aud === 'https://web.push.apple.com' && claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400 && /^https:/.test(claims.sub), header.slice(0, 60))
  same('push: only an https endpoint with a real P-256 key and a 16-byte secret is taken', [!!validSubscription(sub), validSubscription({ ...sub, endpoint: 'http://x.test/a' }), validSubscription({ ...sub, keys: { ...sub.keys, p256dh: 'AAAA' } }), validSubscription({ ...sub, keys: { ...sub.keys, auth: b64u(randomBytes(8)) } })], [true, null, null, null])
  // Found in the attack review: any https address was taken, so a phone could make the computer send requests anywhere.
  same(
    'push: a notification only ever goes to a browser push service, never to a host a phone names',
    ['https://web.push.apple.com/a', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://intranet.example/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.evil.example/a', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x'].map((endpoint) => !!validSubscription({ ...sub, endpoint })),
    [true, true, true, true, false, false, false, false, false],
  )
  {
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = []
    const fake = (async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
      sent.push({ url, headers: init.headers, body: Buffer.from(init.body) })
      return { status: 201 }
    }) as unknown as typeof fetch
    const dir = path.join(c.dataDir, '..', `reach-push-${process.pid}`)
    const pusher = new Pusher({ dataDir: dir, targets: () => [{ id: 'd1', push: sub }], expired: () => {}, subject: () => 'https://relay.example.workers.dev', fetch: fake, groupMs: 30 })
    pusher.note('needs')
    pusher.note('needs')
    pusher.note('needs')
    await settle('the grouped notification', () => sent.length > 0, 3000)
    await pause(60)
    const words = JSON.parse(decrypt(sent[0].body))
    check('push: a burst goes as one notification, short and with nothing private in it', sent.length === 1 && words.body === '3 things are waiting for your answer.' && sent[0].headers['Content-Encoding'] === 'aes128gcm' && /^vapid t=/.test(sent[0].headers.Authorization) && sent[0].headers.TTL === '3600', JSON.stringify(words))
    pusher.setKinds({ found: false })
    pusher.note('found')
    await pause(80)
    check('push: a kind switched off in Settings sends nothing', sent.length === 1)
    pusher.dispose()
  }

  // Keys at rest: sealed by the app's sealer (Windows credential encryption), never written in the clear.
  {
    const fs = await import('node:fs')
    const sealer = { seal: (s: string) => `sealed:${Buffer.from(s).toString('base64')}`, open: (s: string) => (s.startsWith('sealed:') ? Buffer.from(s.slice(7), 'base64').toString() : s) }
    const dir = path.join(c.dataDir, '..', `reach-seal-${process.pid}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const host = { dataDir: dir, tunnelPair: () => ({ error: 'no' }), tunnelDevice: () => null, tunnelCall: async () => ({ s: 404, b: null }), tunnelStream: () => ({ s: 404, b: null }) }
    const pub1 = new RelayLink(host, { sealer }).status().pub
    const relayFile = fs.readFileSync(path.join(dir, 'relay.json'), 'utf8')
    const pub2 = new RelayLink(host, { sealer }).status().pub
    const pusher1 = new Pusher({ dataDir: dir, sealer, targets: () => [], expired: () => {}, subject: () => 'https://x.dev' })
    const vapid1 = pusher1.publicKey
    const pushFile = fs.readFileSync(path.join(dir, 'push.json'), 'utf8')
    const vapid2 = new Pusher({ dataDir: dir, sealer, targets: () => [], expired: () => {}, subject: () => 'https://x.dev' }).publicKey
    const ts = new Tailscale({ run: null, dir, sealer })
    fs.mkdirSync(path.dirname(ts.keyFile), { recursive: true })
    fs.writeFileSync(ts.keyFile, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n')
    const opened = ts.readKey()?.toString()
    check('keys at rest are sealed: the relay key and room secret, the notification key, the HTTPS key; and they read back the same', !relayFile.includes('BEGIN') && /"key": ?"sealed:/.test(relayFile) && /"secret": ?"sealed:/.test(relayFile) && pub1 === pub2 && !pushFile.includes('BEGIN') && vapid1 === vapid2 && !fs.existsSync(ts.keyFile) && fs.readFileSync(ts.sealedKeyFile, 'utf8').startsWith('sealed:') && !!opened?.includes('BEGIN PRIVATE KEY'))
    // At the computer (the window in front), the phone gets nothing.
    let sentQuiet = 0
    const quietFetch = (async () => {
      sentQuiet++
      return { status: 201 }
    }) as unknown as typeof fetch
    let atDesk = true
    const q = new Pusher({ dataDir: dir, targets: () => [{ id: 'd', push: sub }], expired: () => {}, subject: () => 'https://x.dev', fetch: quietFetch, groupMs: 20, quiet: () => atDesk })
    q.note('needs')
    await pause(80)
    atDesk = false
    q.note('needs')
    await settle('a notification once away from the computer', () => sentQuiet === 1, 3000)
    check('no notification while the person is at the computer; one once they are away', sentQuiet === 1)
    q.dispose()
  }

  // Tailscale: recorded answers of `tailscale status --json`.
  const running = { BackendState: 'Running', Self: { DNSName: 'kerim-pc.tail1234.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::1', '100.101.102.103'], Online: true }, CertDomains: ['kerim-pc.tail1234.ts.net'] }
  same('Tailscale installed and connected: name, address first, HTTPS ready', parseStatus(running), { running: true, state: 'Running', dnsName: 'kerim-pc.tail1234.ts.net', ips: ['100.101.102.103', 'fd7a:115c:a1e0::1'], certDomains: ['kerim-pc.tail1234.ts.net'] })
  same('Tailscale installed and off, or signed out', [parseStatus({ BackendState: 'Stopped', Self: { DNSName: '' }, CertDomains: null }).running, parseStatus({ BackendState: 'NeedsLogin' }).running, parseStatus('nonsense').running], [false, false, false])
  {
    const absent = new Tailscale({ run: null, dir: c.dataDir })
    const st = await absent.status()
    check('Tailscale absent: said plainly, and nothing is run', !st.installed && !st.running && absent.calls.length === 0)
  }

  // ───────────── the relay, the computer and a phone ─────────────
  const seen: { from: string; text: string }[] = []
  let alter: ((from: string, text: string) => string | null) | null = null
  const relay = await startRelay({
    tap: (from, _conn, text) => {
      seen.push({ from, text })
      return alter ? alter(from, text) : text
    },
  })
  const made = await c.freshHub('reach')
  const h = made.hub
  const remote: RemoteServer = h.remote
  // Tailscale is not asked on this computer during checks: a recorder stands in for the program.
  const tsCalls: string[][] = []
  const runner: Runner = async (args) => {
    tsCalls.push(args)
    return args[0] === 'status' ? { code: 0, stdout: JSON.stringify(running), stderr: '' } : { code: 1, stdout: '', stderr: 'not in checks' }
  }
  ;(remote as unknown as { _tailscale: Tailscale })._tailscale = new Tailscale({ run: runner, dir: made.dataDir })
  const phones: Tunnel[] = []
  try {
    remote.bind = '127.0.0.1'
    remote.wantPort = -1
    h.updateSettings({ remote: true })
    await settle('the phone server', () => remote.listening)
    await pause(200)
    check('with no relay address, nothing goes out: no connection at all', remote.relay.connects === 0 && relay.pcConnects() === 0)
    await remote.setReach({ relayUrl: relay.url, relayOn: false })
    await pause(300)
    check('with an address but switched off, still no connection', remote.relay.connects === 0 && relay.pcConnects() === 0)
    const reach0 = await remote.setReach({ relayOn: true })
    await settle('the computer to join its room', () => remote.relay.connected)
    check('switched on: one outbound connection to its room, claimed', relay.pcConnects() === 1 && reach0.relay.on && reach0.relay.url === relay.url)
    check('reading where it stands never runs `tailscale cert`', !tsCalls.some((a) => a[0] === 'cert') && tsCalls.every((a) => a[0] === 'status'))

    // Pairing from the QR code shown on the computer.
    const code = (remote.pair().pairing?.code || '').replace('-', '')
    const reach1 = await remote.reach()
    const link = T.readLink((reach1.relay.link || '').split('#')[1] || '')
    check('the pairing QR carries the relay page and, after #, the room, the computer\'s key and the code', !!link && link.code === code && (reach1.relay.link || '').startsWith(`${relay.url}/#r=`))
    if (!link) throw new Error('no pairing link')
    const identity = await T.createIdentity()
    let paired: { id: string; name: string } | null = null
    const states: string[] = []
    let bye = 0
    const phone = T.open({ relay: relay.url, room: link.room, pcPub: link.pcPub, identity, pair: { code: link.code, name: 'iPhone 17' }, onState: (s: string) => states.push(s), onPaired: (d: { id: string; name: string }) => (paired = d), onBye: () => bye++ })
    phones.push(phone)
    await settle('the phone to pair through the relay', () => !!paired)
    const dev = remote.info().devices.find((d) => d.id === paired?.id)
    check('paired through the relay: the device is listed as such', !!dev && dev.name === 'iPhone 17' && dev.via === 'relay')
    check('the private half of the phone\'s key cannot be read out', (identity.privateKey as CryptoKey).extractable === false)

    // The phone API through the tunnel: the same answers as on Wi-Fi.
    const chat = h.createChat({ cwd: c.work })
    const lead = h.lead()!
    const state = await phone.request('GET', '/api/state')
    check('through the tunnel, the phone lists the chats', state.status === 200 && state.json.chats.some((x: { id: string }) => x.id === chat.id))
    let live = ''
    const stream = phone.stream(`/api/events?chat=${chat.id}`, (line) => (live += line))
    await settle('the stream to open', () => live.includes(': connected'))
    const sent = await phone.request('POST', `/api/chat/${chat.id}/send`, { text: 'Summarise the plan' })
    const idle = (): boolean => {
      const s = h.openChat(chat.id).states.find((x) => x.accountId === lead.id)
      return !!s && s.phase === 'idle' && !s.queued
    }
    const rows = () => h.openChat(chat.id).items[lead.id] || []
    await settle('the reply', () => idle() && rows().some((i) => i.kind === 'assistant'), 60_000)
    await pause(200)
    check('a prompt sent through the tunnel reaches the lead, and the reply streams back', sent.status === 200 && rows().some((i) => i.kind === 'user' && i.text === 'Summarise the plan') && /"k":"assistant"/.test(live), live.slice(0, 120))

    // An approval answered through the tunnel.
    const sessions = (h as unknown as { sessions: Map<string, { askPermission(a: { toolName: string; title: string; detail?: string; input: unknown; canRemember: boolean; signal: AbortSignal }): Promise<{ decision: PermissionDecision }> }> }).sessions
    let decided: PermissionDecision | '' = ''
    void sessions.get(`${chat.id}:${lead.id}`)?.askPermission({ toolName: 'Bash', title: '', detail: 'npm test', input: { command: 'npm test' }, canRemember: true, signal: new AbortController().signal }).then((r) => (decided = r.decision))
    await pause(100)
    const waiting = await phone.request('GET', `/api/chat/${chat.id}`)
    const card = waiting.json.rows.find((r: { k: string; st: string }) => r.k === 'approval' && r.st === 'pending')
    const answered = await phone.request('POST', `/api/chat/${chat.id}/answer`, { requestId: card?.requestId, allow: true })
    await settle('the approval', () => decided !== '', 3000)
    check('an approval is answered through the tunnel: allowed once', answered.status === 200 && decided === 'allow')

    // The same prompt sent again under the same request id (a phone that lost the answer) is done once.
    const before = rows().filter((i) => i.kind === 'user').length
    const r1 = await phone.request('POST', `/api/chat/${chat.id}/send`, { text: 'Once only, please' }, { rid: 'retry-0123456789' })
    const r2 = await phone.request('POST', `/api/chat/${chat.id}/send`, { text: 'Once only, please' }, { rid: 'retry-0123456789' })
    await pause(100)
    check('a request sent twice under the same id is done once, and both get the answer', r1.status === 200 && r2.status === 200 && rows().filter((i) => i.kind === 'user').length === before + 1)

    // Signal lost mid-request: the answer never arrives, the phone reconnects and sends it again; it is done once.
    await settle('the lead to be idle', idle, 60_000)
    const before2 = rows().filter((i) => i.kind === 'user').length
    alter = (from, text) => {
      if (from !== 'pc') return text
      alter = null
      // The answer is lost on the way, and so is the phone's connection.
      setTimeout(() => relay.dropPhones(), 10)
      return null
    }
    const lost = await phone.request('POST', `/api/chat/${chat.id}/send`, { text: 'Sent on a train' }, { timeoutMs: 20_000 })
    await pause(200)
    check('lost signal mid-request: the phone reconnects, sends it again, gets the answer, and it is done once', lost.status === 200 && rows().filter((i) => i.kind === 'user' && i.text === 'Sent on a train').length === 1 && rows().filter((i) => i.kind === 'user').length === before2 + 1)

    // Stop through the tunnel.
    await settle('the lead to be idle', idle, 60_000)
    await phone.request('POST', `/api/chat/${chat.id}/send`, { text: 'Add a pricing page' })
    await settle('the lead to work', () => !idle(), 10_000)
    const stopped = await phone.request('POST', `/api/chat/${chat.id}/stop`, {})
    await settle('the team to stop', idle, 20_000)
    check('stop through the tunnel stops the turn', stopped.status === 200 && rows().some((i) => i.kind === 'turn' && i.status === 'interrupted'))
    stream.close()

    // The inbox through the tunnel: the watches engine's own (hub.watches), with one item put in it here.
    const engine = (h as unknown as { watches?: { inbox(): InboxItem[]; mark(id: string, p: { done?: boolean }): InboxItem[] } }).watches
    const items: InboxItem[] = [{ id: 'i1', kind: 'needs-you', title: 'Run the deploy check?', body: 'A watch wants to run one command.', at: Date.now(), read: false, done: false }]
    if (engine) {
      const realInbox = engine.inbox.bind(engine)
      const realMark = engine.mark.bind(engine)
      engine.inbox = () => [...items, ...realInbox()]
      engine.mark = (id, p) => {
        const it = items.find((x) => x.id === id)
        if (it) {
          if (p.done) it.done = true
          return [...items, ...realInbox()]
        }
        return realMark(id, p)
      }
    }
    const st2 = await phone.request('GET', '/api/state')
    const ib = await phone.request('GET', '/api/inbox')
    const marked = await phone.request('POST', '/api/inbox/i1', { done: true })
    check('the inbox through the tunnel comes from the watches engine: read, and marked done', !!engine && st2.json.inbox === true && ib.status === 200 && ib.json.ready === true && ib.json.items.some((x: InboxItem) => x.id === 'i1') && marked.status === 200 && items[0].done === true, `engine ${!!engine}, ready ${ib.json?.ready}`)

    // ───── attacks ─────
    const plain = ['Summarise the plan', 'Once only, please', 'Sent on a train', 'iPhone 17', code, 'npm test', 'Run the deploy check']
    const all = seen.map((x) => x.text).join('\n')
    same('the relay saw none of the plaintext: prompts, replies, the code, the device name, approvals', plain.filter((p) => all.includes(p)), [])
    check('after the handshake, every frame the relay passed was sealed', seen.filter((x) => !x.text.startsWith('e.') && !/^\{"k":/.test(x.text)).length === 0, String(seen.find((x) => !x.text.startsWith('e.') && !/^\{"k":/.test(x.text))?.text).slice(0, 60))

    // A frame changed in transit.
    const rejected0 = remote.relay.rejected
    alter = (from, text) => {
      if (from !== 'phone' || !text.startsWith('e.')) return text
      alter = null
      const i = 10
      return text.slice(0, i) + (text[i] === 'A' ? 'B' : 'A') + text.slice(i + 1)
    }
    const changed = await phone.request('GET', '/api/state', undefined, { timeoutMs: 15_000 })
    check('a frame changed in transit is rejected; the session ends and a fresh one carries the request', remote.relay.rejected === rejected0 + 1 && changed.status === 200)

    // A frame replayed in transit (an earlier one sent in place of the next).
    let last = ''
    const rejected1 = remote.relay.rejected
    await phone.request('GET', '/api/state')
    alter = (from, text) => {
      if (from !== 'phone' || !text.startsWith('e.')) return text
      if (!last) {
        last = text
        return text
      }
      alter = null
      return last
    }
    await phone.request('GET', '/api/state', undefined, { timeoutMs: 15_000 })
    await phone.request('GET', '/api/state', undefined, { timeoutMs: 15_000 })
    check('a replayed frame is rejected', remote.relay.rejected === rejected1 + 1)

    // A stranger who knows the room and even the device id (both visible to the relay), but not the keys.
    const rejected2 = remote.relay.rejected
    const stranger = T.open({ relay: relay.url, room: link.room, pcPub: link.pcPub, identity: await T.createIdentity(), deviceId: paired?.id })
    phones.push(stranger)
    let got: unknown = null
    void stranger.request('GET', '/api/state', undefined, { timeoutMs: 3000 }).then((r) => (got = r), () => (got = 'nothing'))
    await settle('the stranger to give up', () => got !== null, 6000)
    stranger.close()
    check('a second client that knows the room and the device id but not the keys gets nothing', got === 'nothing' && remote.relay.rejected > rejected2)

    // Guessing the pairing code: five wrong tries end it.
    ;(remote as unknown as { hits: Map<string, number[]> }).hits.clear()
    const target = (remote.pair().pairing?.code || '').replace('-', '')
    const tries: string[] = []
    for (let i = 0; i < 5; i++) {
      const g = T.open({ relay: relay.url, room: link.room, pcPub: link.pcPub, identity: await T.createIdentity(), pair: { code: `ZZZZZZZ${i + 2}`, name: 'Guess' }, onState: (s: string, why?: string) => s === 'refused' && tries.push(why || '') })
      phones.push(g)
      await settle('a guess to be refused', () => tries.length === i + 1, 5000)
      g.close()
    }
    ;(remote as unknown as { hits: Map<string, number[]> }).hits.clear()
    let right = ''
    const late = T.open({ relay: relay.url, room: link.room, pcPub: link.pcPub, identity: await T.createIdentity(), pair: { code: target, name: 'Late' }, onState: (s: string, why?: string) => s === 'refused' && (right = why || 'refused') })
    phones.push(late)
    await settle('the right code, too late', () => !!right, 5000)
    late.close()
    check('five wrong codes through the relay end pairing: the right one is refused after them', tries.length === 5 && /no longer valid/.test(right) && remote.info().pairing === null && remote.info().devices.length === 1, right)

    // Flooding the relay.
    const raw = (send: (ws: WebSocket) => void): Promise<number> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${relay.url.replace('http', 'ws')}/room/${link.room}/phone`)
        const t = setTimeout(() => resolve(0), 5000)
        ws.onopen = () => send(ws)
        ws.onclose = (ev) => {
          clearTimeout(t)
          resolve(ev.code)
        }
      })
    const big = await raw((ws) => ws.send(JSON.stringify({ t: 'd', d: 'x'.repeat(RELAY_LIMITS.frame + 10) })))
    const flood = await raw((ws) => {
      for (let i = 0; i < RELAY_LIMITS.phoneBurst + 40; i++) ws.send(JSON.stringify({ t: 'd', d: 'e.AAAA' }))
    })
    same('the relay refuses an oversized frame and a flood of frames', [big, flood], [4013, 4029])

    // Removing the phone on the computer cuts it at once.
    const t0 = Date.now()
    remote.remove(paired!.id)
    await settle('the removed phone to be told', () => bye > 0, 1000)
    check('a removed phone is cut within a second, through the relay', bye === 1 && Date.now() - t0 < 1000, `${Date.now() - t0} ms`)

    // Found in the attack review. "Unknown" is said in the clear, so anyone on the path could write it:
    // the phone stops and says so, but does not throw its pairing away on that word alone.
    const after: string[] = []
    const ghost = T.open({ relay: relay.url, room: link.room, pcPub: link.pcPub, identity, deviceId: paired!.id, onState: (st: string) => after.push(st), onBye: () => bye++ })
    phones.push(ghost)
    await settle('the removed phone to hear it is not known', () => after.includes('unknown'), 5000)
    ghost.close()
    check('a phone told "unknown" in the clear stops, and keeps its pairing', after.includes('unknown') && bye === 1, `${after.join(',')} bye ${bye}`)

    // A relay cannot make the computer hold sessions without end, or swallow frames of any size.
    const link2 = remote.relay as unknown as { sessions: Map<string, unknown>; onRelay(text: string): void }
    const held = link2.sessions.size
    for (let i = 0; i < 200; i++) link2.onRelay(JSON.stringify({ t: 'open', c: `flood-${i}` }))
    check('the computer keeps state for at most 16 phone connections, whatever the relay says', link2.sessions.size <= 16 && link2.sessions.size >= held, `${link2.sessions.size}`)
    for (let i = 0; i < 200; i++) link2.onRelay(JSON.stringify({ t: 'gone', c: `flood-${i}` }))


    // HTTPS on the Tailscale name: only from the user's own action.
    await remote.setReach({ https: true })
    check('turning HTTPS on does not run `tailscale cert` by itself', !tsCalls.some((a) => a[0] === 'cert'))
    const asked = await remote.tailscaleCert()
    check('the user\'s "Get the HTTPS certificate" runs it once, for this machine\'s name, and says when it fails', tsCalls.filter((a) => a[0] === 'cert').length === 1 && tsCalls.find((a) => a[0] === 'cert')?.slice(-1)[0] === 'kerim-pc.tail1234.ts.net' && !!asked.certError)

    // Off: the relay connection ends, and nothing reconnects.
    await remote.setReach({ relayOn: false })
    const n = relay.pcConnects()
    await pause(1500)
    check('switched off: disconnected, and no new connection is made', !remote.relay.connected && relay.pcConnects() === n)
  } finally {
    for (const p of phones) p.close()
    h.updateSettings({ remote: false })
    await h.dispose()
    await relay.close()
  }
  void http
}
