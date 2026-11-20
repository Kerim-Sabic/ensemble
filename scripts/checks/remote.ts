import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import type { Ctx } from './ctx'
import { Hub } from '../../src/main/hub'
import { REMOTE_LIMITS, localPeer, type RemoteServer } from '../../src/main/remote'
import { writeJson } from '../../src/main/util'
import type { Chat, PermissionDecision } from '../../src/shared/types'

// Phone and remote: the server is started on 127.0.0.1 with a free port against the demo hub, and
// spoken to the way a phone would, over plain HTTP.

interface Reply {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  text: string
  headers: http.IncomingHttpHeaders
}

function call(port: number, method: string, path: string, o: { token?: string; body?: unknown; raw?: string; type?: string; host?: string; origin?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: o.host || `127.0.0.1:${port}`,
          ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
          ...(data !== undefined ? { 'Content-Type': o.type || 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(o.origin ? { Origin: o.origin } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try {
            json = JSON.parse(text)
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode || 0, json, text, headers: res.headers })
        })
      },
    )
    req.on('error', reject)
    if (data !== undefined) req.write(data)
    req.end()
  })
}

/** A live stream, the way the phone page keeps one: everything it received, and whether it was closed. */
function listen(port: number, token: string, chat?: string): { text: () => string; closed: () => boolean; status: () => number; why: () => string; end: () => void } {
  let text = ''
  let closed = false
  let status = 0
  let error = ''
  const req = http.get({ host: '127.0.0.1', port, path: `/api/events${chat ? `?chat=${chat}` : ''}`, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } }, (res) => {
    status = res.statusCode || 0
    res.on('data', (c: Buffer) => (text += c.toString('utf8')))
    res.on('close', () => (closed = true))
  })
  req.on('error', (e: NodeJS.ErrnoException) => {
    closed = true
    error = e.code || e.message
  })
  // What it got, for a failure message: the status, the error, the first words.
  const why = (): string => `status ${status}${error ? `, error ${error}` : ''}${closed ? ', closed' : ''}${text ? `, got ${JSON.stringify(text.slice(0, 80))}` : ''}`
  return { text: () => text, closed: () => closed, status: () => status, why, end: () => req.destroy() }
}

/** The server's own bookkeeping, for checks that must reach past the wire (expiry, rate counters, live streams). */
interface Inside {
  pairing: { code: string; expiresAt: number; misses: number } | null
  hits: Map<string, number[]>
  streams: Map<unknown, { device: string }>
}
const inside = (r: RemoteServer): Inside => r as unknown as Inside


export default async function (c: Ctx): Promise<void> {
  const { hub, check, same, pause } = c
  // The harness's `until` looks again only when the hub says something; what happens on the wire is polled.
  const settle = async (what: string, test: () => boolean, ms = 5000, seen?: () => string): Promise<void> => {
    const end = Date.now() + ms
    while (!test()) {
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}${seen ? ` (${seen()})` : ''}`)
      await pause(20)
    }
  }
  const remote = hub.remote
  // Pairs one more device with a fresh code (the pairing rate counters are cleared first: they are checked on their own).
  const pairOne = async (port: number, name: string): Promise<{ token: string; id: string }> => {
    inside(remote).hits.clear()
    const code = remote.pair().pairing?.code || ''
    const r = await call(port, 'POST', '/api/pair', { body: { code, name } })
    return { token: r.json?.token || '', id: r.json?.device?.id || '' }
  }

  // Off until switched on: nothing listens.
  check('phone and remote is off by default', hub.bootstrap().settings.remote === false && !remote.listening && remote.info().port === null && !remote.info().on)
  check('and gives no pairing code while off', remote.pair().pairing === null)

  // Stay off the network in checks: this computer only, any free port.
  remote.bind = '127.0.0.1'
  remote.wantPort = -1
  hub.updateSettings({ remote: true })
  await settle('the server to listen', () => remote.listening)
  const port = remote.info().port as number
  check('turned on in settings, it listens', port > 0 && remote.info().addresses.length === 1)

  // An unpaired client gets the page and nothing else.
  const page = await call(port, 'GET', '/')
  // Scripts: the page's own inline one by its hash, and its own files (tunnel.js, sw.js); nothing inline besides, nothing from elsewhere.
  const pageCsp = String(page.headers['content-security-policy'])
  check('an unpaired phone gets the pairing page, with a strict content policy', page.status === 200 && /<title>Ensemble<\/title>/.test(page.text) && /script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/.test(pageCsp) && !/unsafe-inline[^;]*;\s*style-src/.test(pageCsp) && /connect-src 'self'/.test(pageCsp) && !('access-control-allow-origin' in page.headers), pageCsp)
  same('and nothing of the chats without a credential', [(await call(port, 'GET', '/api/state')).status, (await call(port, 'GET', '/api/events')).status, (await call(port, 'GET', '/api/state', { token: 'x'.repeat(43) })).status], [401, 401, 401])
  same('a request for another host name or from another page is refused', [(await call(port, 'GET', '/', { host: `evil.example:${port}` })).status, (await call(port, 'GET', '/', { origin: 'http://evil.example' })).status, (await call(port, 'POST', '/api/pair', { body: { code: 'x' }, origin: 'http://evil.example' })).status], [421, 403, 403])
  same('there is no way to settings, accounts or permission levels', [(await call(port, 'POST', '/api/settings', { body: { remote: false } })).status, (await call(port, 'GET', '/api/accounts')).status], [401, 401])

  // Pairing: the one-time code works once and only once.
  const code = remote.pair().pairing?.code || ''
  check('a pairing code is eight characters, good for a few minutes', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) && (remote.info().pairing?.expiresAt || 0) > Date.now() + 60_000)
  const wrong = await call(port, 'POST', '/api/pair', { body: { code: 'AAAA-AAAA', name: 'Stranger' } })
  check('a wrong code is refused', wrong.status === 403 && !wrong.json?.token)
  const paired = await call(port, 'POST', '/api/pair', { body: { code: code.toLowerCase(), name: 'iPhone 17' } })
  const token: string = paired.json?.token || ''
  check('the right code pairs the phone and gives it a credential of its own', paired.status === 200 && token.length >= 40 && paired.json.device.name === 'iPhone 17')
  check('the same code never works twice', (await call(port, 'POST', '/api/pair', { body: { code, name: 'Again' } })).status === 403)
  const dev = remote.info().devices
  check('the device is listed with its name and when it was last seen', dev.length === 1 && dev[0].name === 'iPhone 17' && Date.now() - dev[0].lastSeen < 5000)
  check('the credential itself is not kept on disk, only its fingerprint', !JSON.stringify(remote.info()).includes(token))
  let limited = 0
  for (let i = 0; i < REMOTE_LIMITS.pairPerMinute + 1; i++) if ((await call(port, 'POST', '/api/pair', { body: { code: 'BBBB-BBBB' } })).status === 429) limited++
  check('pairing attempts are rate limited', limited >= 1, String(limited))
  // A code that ran out of time is refused even when it is right, and is gone.
  inside(remote).hits.clear()
  const late = remote.pair().pairing?.code || ''
  const held = inside(remote).pairing
  if (held) held.expiresAt = Date.now() - 1
  const tooLate = await call(port, 'POST', '/api/pair', { body: { code: late, name: 'Late' } })
  check('a code that ran out of time no longer pairs, even when it is right', tooLate.status === 403 && /no longer valid/.test(tooLate.json?.error || '') && remote.info().pairing === null)
  // Five wrong tries end a code, so it cannot be guessed at leisure.
  inside(remote).hits.clear()
  const target = remote.pair().pairing?.code || ''
  const misses: number[] = []
  for (let i = 0; i < REMOTE_LIMITS.codeMisses; i++) misses.push((await call(port, 'POST', '/api/pair', { body: { code: `ZZZZ-ZZZ${i + 2}` } })).status)
  inside(remote).hits.clear()
  const afterMisses = await call(port, 'POST', '/api/pair', { body: { code: target, name: 'Guesser' } })
  check(`${REMOTE_LIMITS.codeMisses} wrong tries end the code: the right one is refused after them`, misses.every((x) => x === 403) && afterMisses.status === 403 && remote.info().pairing === null && remote.info().devices.length === 1, `${misses.join(',')} then ${afterMisses.status}`)
  inside(remote).hits.clear()

  // A paired phone: the chats, a message that reaches the lead, live updates of the reply.
  const chat: Chat = hub.createChat({ cwd: c.work })
  const state = await call(port, 'GET', '/api/state', { token })
  check('a paired phone lists the chats', state.status === 200 && Array.isArray(state.json.chats) && state.json.chats.some((x: { id: string }) => x.id === chat.id) && state.json.folders.length >= 1)
  const live = listen(port, token, chat.id)
  await settle('the live stream to open', () => live.status() === 200, 8000, live.why)
  const sent = await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: 'Summarise the plan' } })
  check('a message from the phone reaches the lead', sent.status === 200 && sent.json.how === 'sent' && c.rows(chat).some((i) => i.kind === 'user' && i.text === 'Summarise the plan'))
  await settle('the reply to finish', () => c.idle(chat) && c.rows(chat).some((i) => i.kind === 'assistant'), 60_000)
  await pause(150)
  check('the phone receives the reply live', /"t":"row"/.test(live.text()) && /"k":"assistant"/.test(live.text()) && /"t":"chat"/.test(live.text()), live.text().slice(0, 200))
  const detail = await call(port, 'GET', `/api/chat/${chat.id}`, { token })
  check('and reads the chat: its own message and the lead\'s reply', detail.status === 200 && detail.json.rows.some((r: { k: string; text: string }) => r.k === 'user' && r.text === 'Summarise the plan') && detail.json.rows.some((r: { k: string; text: string }) => r.k === 'assistant' && r.text.length > 0) && detail.json.lead.id === c.leadId)

  // A typed command stays plain words from a phone: it cannot switch Ultra on.
  await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: '/ultra on' } })
  check('a command typed on the phone changes nothing about how the team works', !chat.ultra && !chat.goal && !(chat.loops || []).length)
  await settle('the lead to be idle', () => c.idle(chat), 60_000)

  // Even paired, the phone reaches nothing but its short list.
  same('a paired phone has no way to settings, accounts, permission levels, connectors or computer control', [
    (await call(port, 'GET', '/api/settings', { token })).status,
    (await call(port, 'POST', '/api/settings', { token, body: { remote: false } })).status,
    (await call(port, 'GET', '/api/accounts', { token })).status,
    (await call(port, 'POST', '/api/permission', { token, body: { level: 'auto' } })).status,
    (await call(port, 'GET', '/api/connectors', { token })).status,
    (await call(port, 'POST', '/api/computer', { token, body: {} })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/permission`, { token, body: { level: 'auto' } })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/mode`, { token, body: { mode: 'ultra' } })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/goal`, { token, body: { text: 'x' } })).status,
  ], [404, 404, 404, 404, 404, 404, 404, 404, 404])
  const permissionBefore = chat.permission
  const extras = await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: 'Note the deadline is Friday', mode: 'gocrazy', goal: { text: 'ship it' }, loop: { every: 60_000 }, to: 'someone-else', permission: 'auto', fromControl: false } })
  check('what else a phone puts in a message is ignored: no mode, goal, loop, other agent or permission level', extras.status === 200 && !chat.ultra && !chat.goal && !(chat.loops || []).length && chat.permission === permissionBefore && c.rows(chat).some((i) => i.kind === 'user' && i.text === 'Note the deadline is Friday'))
  await settle('the lead to be idle', () => c.idle(chat), 60_000)

  // An approval: allow or deny, from the phone.
  const sessions = (hub as unknown as { sessions: Map<string, { askPermission(a: { toolName: string; title: string; detail?: string; input: unknown; canRemember: boolean; signal: AbortSignal }): Promise<{ decision: PermissionDecision }> }> }).sessions
  const session = sessions.get(`${chat.id}:${c.leadId}`)
  let decided: PermissionDecision | '' = ''
  void session?.askPermission({ toolName: 'Bash', title: '', detail: 'npm test', input: { command: 'npm test' }, canRemember: true, signal: new AbortController().signal }).then((r) => (decided = r.decision))
  await pause(100)
  const waiting = await call(port, 'GET', `/api/chat/${chat.id}`, { token })
  const card = waiting.json.rows.find((r: { k: string; st: string }) => r.k === 'approval' && r.st === 'pending')
  check('an approval shows up on the phone as a card', !!card && waiting.json.chat.needs === 1 && /"k":"approval"/.test(live.text()))
  same('"always" cannot be given from a phone, and a made-up request is refused', [(await call(port, 'POST', `/api/chat/${chat.id}/answer`, { token, body: { requestId: card?.requestId, decision: 'always' } })).status, (await call(port, 'POST', `/api/chat/${chat.id}/answer`, { token, body: { requestId: 'p-nope', allow: true } })).status], [400, 409])
  const allowed = await call(port, 'POST', `/api/chat/${chat.id}/answer`, { token, body: { requestId: card?.requestId, allow: true } })
  await settle('the approval to be taken', () => decided !== '', 3000)
  check('the phone answers the approval: allowed once', allowed.status === 200 && decided === 'allow', String(decided))

  // A question card, answered from the phone.
  hub.send({ chatId: chat.id, to: c.leadId, text: 'Add a pricing page', mode: 'plan' })
  await settle('the plan question to be asked', () => c.rows(chat).some((i) => i.kind === 'question' && i.status === 'pending'), 60_000)
  const asked = await call(port, 'GET', `/api/chat/${chat.id}`, { token })
  const q = asked.json.rows.find((r: { k: string; st: string }) => r.k === 'question' && r.st === 'pending')
  const answered = await call(port, 'POST', `/api/chat/${chat.id}/answer`, { token, body: { requestId: q?.requestId, answers: { [q?.questions?.[0]?.question]: 'Leave it' } } })
  await settle('the lead to take the answer', () => c.idle(chat), 60_000)
  check('the phone answers a question', answered.status === 200 && c.rows(chat).some((i) => i.kind === 'question' && i.status === 'answered'))

  // Stop, from the phone.
  await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: 'Add a pricing page' } })
  await settle('the lead to be working', () => !c.idle(chat), 10_000)
  const working = await call(port, 'GET', '/api/state', { token })
  check('the list says the chat is at work', working.json.chats.find((x: { id: string }) => x.id === chat.id)?.working === true)
  const steered = await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: 'Keep the annual discount at 20%' } })
  check('a message to a lead at work steers it', steered.status === 200 && (steered.json.how === 'steered' || steered.json.how === 'sent'), JSON.stringify(steered.json))
  const stopped = await call(port, 'POST', `/api/chat/${chat.id}/stop`, { token, body: {} })
  await settle('the team to stop', () => c.idle(chat), 20_000)
  check('stop from the phone stops the turn', stopped.status === 200 && c.rows(chat).some((i) => i.kind === 'turn' && i.status === 'interrupted'))

  // A new chat only where chats already are.
  const folders: { key: string; label: string }[] = (await call(port, 'GET', '/api/state', { token })).json.folders
  const before = hub.chats.size
  same('a new chat cannot be started in a folder of the phone\'s choosing', [(await call(port, 'POST', '/api/chats', { token, body: { folder: 'C:\\Windows', text: 'hi' } })).status, hub.chats.size], [400, before])
  const mineKey = folders.find((f) => f.label === c.work.split(/[\\/]/).pop())?.key || folders[0].key
  const made = await call(port, 'POST', '/api/chats', { token, body: { folder: mineKey, text: 'Summarise the plan' } })
  const fresh = hub.chats.get(made.json?.chat?.id)
  check('a new chat starts in a folder that already has chats', made.status === 200 && !!fresh && [...hub.chats.values()].some((x) => x.id !== fresh.id && x.cwd === fresh.cwd) && c.rows(fresh).some((i) => i.kind === 'user'))
  if (fresh) await settle('the new chat to settle', () => c.idle(fresh), 60_000)
  same('resume is refused where nothing was cut short', (await call(port, 'POST', `/api/chat/${chat.id}/resume`, { token, body: {} })).status, 409)

  // Bounds: size, shape, kind.
  const big = 'x'.repeat(REMOTE_LIMITS.body + 10)
  same('oversized and malformed requests are refused', [
    (await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: big } })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: 'y'.repeat(REMOTE_LIMITS.text + 1) } })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, raw: '{"text": ' })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, raw: '["a"]' })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, raw: 'text=hi', type: 'application/x-www-form-urlencoded' })).status,
    (await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, body: { text: '   ' } })).status,
    (await call(port, 'GET', `/api/${'a'.repeat(2100)}`, { token })).status,
    (await call(port, 'DELETE', `/api/chat/${chat.id}`, { token })).status,
  ], [413, 413, 400, 400, 415, 400, 414, 405])
  // A refusal sent while the body is still arriving reaches the sender: the rest is read and thrown
  // away first. (Before, the connection was closed with data unread, the system reset it, and the
  // sender lost the answer: a phone would have said "connection lost" instead of "too large".)
  const refusals: string[] = []
  for (const size of [70_000, 300_000]) {
    for (let i = 0; i < 3; i++) {
      try {
        refusals.push(String((await call(port, 'POST', `/api/chat/${chat.id}/send`, { raw: 'x'.repeat(size) })).status))
      } catch (e) {
        refusals.push((e as NodeJS.ErrnoException).code || 'error')
      }
    }
  }
  same('a refused request whose body is still arriving gets its answer, not a cut connection', refusals, ['401', '401', '401', '401', '401', '401'])
  let bigCut = ''
  try {
    bigCut = String((await call(port, 'POST', `/api/chat/${chat.id}/send`, { token, raw: 'x'.repeat(REMOTE_LIMITS.drain + 1024) })).status)
  } catch (e) {
    bigCut = (e as NodeJS.ErrnoException).code || 'error'
  }
  check(`a body larger than ${REMOTE_LIMITS.drain / 1024 / 1024} MB is cut without being read`, bigCut === 'ECONNRESET' || bigCut === 'EPIPE' || bigCut === 'ECONNABORTED', bigCut)

  // Requests a minute, per device.
  const myId = remote.info().devices[0]?.id || ''
  inside(remote).hits.set(`dev:${myId}`, Array.from({ length: REMOTE_LIMITS.perMinute }, () => Date.now()))
  const flooded = await call(port, 'GET', '/api/state', { token })
  check(`a device is held to ${REMOTE_LIMITS.perMinute} requests a minute`, flooded.status === 429 && flooded.headers['retry-after'] === '30')
  inside(remote).hits.delete(`dev:${myId}`)
  // A phone that slept leaves its stream behind without a word: one more stream takes the place of its oldest.
  const extra = [listen(port, token), listen(port, token), listen(port, token)]
  await settle('the new streams to open', () => extra.every((s) => s.status() === 200), 8000, () => extra.map((s) => s.why()).join(' | '))
  await settle('the oldest stream to make room', () => live.closed(), 3000, live.why)
  const mine = (): number => [...inside(remote).streams.values()].filter((s) => s.device === myId).length
  check('live streams per device are bounded: one more takes the place of the oldest, never refused', mine() === REMOTE_LIMITS.streamsPerDevice && live.closed() && extra.every((s) => s.status() === 200 && !s.closed()), `${mine()} open; ${extra.map((s) => s.why()).join(' | ')}`)
  // In all, across devices, the limit is a refusal.
  const others: { token: string; id: string }[] = []
  while (remote.info().devices.length * REMOTE_LIMITS.streamsPerDevice <= REMOTE_LIMITS.streams) others.push(await pairOne(port, `Tablet ${others.length + 1}`))
  const crowd = others.flatMap((d) => Array.from({ length: REMOTE_LIMITS.streamsPerDevice }, () => listen(port, d.token)))
  await settle('the crowd of streams to be answered', () => crowd.every((s) => s.status() !== 0 || s.closed()), 8000)
  const openNow = crowd.filter((s) => s.status() === 200 && !s.closed()).length + extra.length
  check(`live streams in all are bounded (${REMOTE_LIMITS.streams})`, openNow === REMOTE_LIMITS.streams && crowd.some((s) => s.status() === 429), `${openNow} open, ${crowd.map((s) => s.status()).join(',')}`)
  for (const s of crowd) s.end()
  for (const d of others) remote.remove(d.id)
  // Connections in all: past the limit, a new one is closed at once.
  const sockets: net.Socket[] = []
  let cut = 0
  for (let i = 0; i < REMOTE_LIMITS.connections + 12; i++) {
    const so = net.connect(port, '127.0.0.1')
    so.on('error', () => {})
    so.on('close', () => cut++)
    sockets.push(so)
  }
  // Under load the refusals can take a moment to arrive.
  for (let i = 0; i < 60 && cut < 12; i++) await pause(50)
  check(`connections in all are bounded (${REMOTE_LIMITS.connections})`, cut >= 12 && sockets.length - cut <= REMOTE_LIMITS.connections, `${sockets.length - cut} held open, ${cut} cut`)
  for (const so of sockets) so.destroy()
  await pause(100)

  // Other parts of the app can add routes, with the server's authentication or their own.
  remote.route('/rooms/', (r) => r.json(200, { rest: r.rest, device: r.device?.name || null }), { auth: 'own' })
  remote.route('/mine/', (r) => r.json(200, { device: r.device?.name || null }))
  const own = await call(port, 'GET', '/rooms/join')
  same('a route with its own authentication is reached without a device credential, one without is not', [own.status, own.json?.rest, (await call(port, 'GET', '/mine/x')).status, (await call(port, 'GET', '/mine/x', { token })).json?.device, (await call(port, 'GET', '/rooms/join', { host: `evil.example:${port}` })).status], [200, 'join', 401, 'iPhone 17', 421])

  // Removing the device ends its access at once, its open stream too.
  remote.remove(dev[0].id)
  await settle('the removed phone\'s streams to close', () => extra.every((s) => s.closed()), 3000, () => extra.map((s) => s.why()).join(' | '))
  check('a removed device is cut off at once: its streams are closed and its credential refused', extra.every((s) => s.closed() && /event: bye/.test(s.text())) && (await call(port, 'GET', '/api/state', { token })).status === 401 && remote.info().devices.length === 0)

  // Only the local network gets through, whatever the firewall allows.
  const nets = { wifi: [{ address: '203.0.113.20', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }] } as unknown as Parameters<typeof localPeer>[1]
  same('local network only: this computer, home and office ranges, Tailscale, link-local and its own subnet in; the internet out', [
    ['127.0.0.1', '::ffff:192.168.1.7', '10.2.3.4', '172.20.0.9', '100.101.102.103', '169.254.10.1', '203.0.113.77', '::1', 'fd7a:115c:a1e0::1', 'fe80::1'].every((ip) => localPeer(ip, nets)),
    ['8.8.8.8', '203.0.114.5', '172.32.0.1', '100.128.0.1', '192.169.0.1', '2001:4860::8888', '', 'not an address', '999.1.1.1'].some((ip) => localPeer(ip, nets)),
    localPeer(undefined, nets),
  ], [true, false, false])

  // Work cut short when Ensemble on the computer closed is picked up from the phone.
  {
    const made = await c.freshHub('remote-resume')
    let h: Hub = made.hub
    const cutChat = h.createChat({ cwd: c.work })
    h.send({ chatId: cutChat.id, to: h.lead()!.id, text: 'Add a pricing page' })
    await pause(300)
    const task = { id: `t${h.tasksOf(cutChat.id).length + 1}`, chatId: cutChat.id, title: 'Out when it closed', brief: 'Write the pricing page copy.', from: h.lead()!.id, to: h.lead()!.id, status: 'running' as const, createdAt: Date.now() }
    h.tasksOf(cutChat.id).push(task)
    writeJson(path.join(made.dataDir, 'chats', cutChat.id, 'tasks.json'), h.tasksOf(cutChat.id))
    await h.dispose()
    h = new Hub({ dataDir: made.dataDir, version: 'test', demo: true, mica: false, isFocused: () => false, notify: () => {}, emit: () => {} })
    await h.start()
    await h.accounts.refresh()
    try {
      h.remote.bind = '127.0.0.1'
      h.remote.wantPort = -1
      h.updateSettings({ remote: true })
      await settle('the second server to listen', () => h.remote.listening)
      const p2 = h.remote.info().port as number
      const code2 = h.remote.pair().pairing?.code || ''
      const t2: string = (await call(p2, 'POST', '/api/pair', { body: { code: code2, name: 'iPhone 17' } })).json?.token || ''
      const listed = (await call(p2, 'GET', '/api/state', { token: t2 })).json?.chats?.find((x: { id: string }) => x.id === cutChat.id)
      check('the phone shows a chat that was cut short as such', !!h.chats.get(cutChat.id)?.recovery && listed?.cut === true)
      const resumed = await call(p2, 'POST', `/api/chat/${cutChat.id}/resume`, { token: t2, body: {} })
      const lead2 = h.lead()!.id
      await settle('the cut work to be picked up', () => !h.chats.get(cutChat.id)?.recovery && h.tasksOf(cutChat.id).find((t) => t.id === task.id)?.status !== 'interrupted', 10_000)
      const leadRows = h.openChat(cutChat.id).items[lead2] || []
      check('pick it up from the phone: the work cut short starts again, and the "Continue" offer is spent', resumed.status === 200 && !h.chats.get(cutChat.id)?.recovery && ['queued', 'running', 'done'].includes(h.tasksOf(cutChat.id).find((t) => t.id === task.id)?.status || '') && leadRows.some((i) => i.kind === 'notice' && i.action?.kind === 'resume' && i.action.done === true), `${resumed.status} ${JSON.stringify(resumed.json)}`)
      same('and a second "pick it up" is refused: nothing is cut short any more', (await call(p2, 'POST', `/api/chat/${cutChat.id}/resume`, { token: t2, body: {} })).status, 409)
      for (let i = 0; i < 400 && h.openChat(cutChat.id).states.some((x) => x.phase !== 'idle' && x.phase !== 'error'); i++) await pause(50)
    } finally {
      await h.stop(cutChat.id).catch(() => {})
      await h.dispose()
    }
  }

  // Off again: nothing listens.
  hub.updateSettings({ remote: false })
  await pause(100)
  let refused = false
  try {
    await call(port, 'GET', '/')
  } catch {
    refused = true
  }
  check('switched off, nothing listens any more', !remote.listening && refused)
}
