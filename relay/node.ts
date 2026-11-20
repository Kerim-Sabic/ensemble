// The relay, run locally in Node: the same protocol as the Cloudflare Worker (core.ts), for tests
// and for trying it out on one's own machine. It is not part of the app.
//   node out/test/relay.mjs [port]      (or import { startRelay } in a check)
//
// A small WebSocket server of its own (RFC 6455: handshake, unfragmented text frames, ping, close)
// so the relay needs no package. The Worker uses Cloudflare's own WebSockets instead.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { RELAY_INFO, RELAY_LIMITS, ROOM_ID, newMeta, onClose, onMessage, onOpen, pageCsp, type Conn, type Role, type RoomHost } from './core'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** One server-side WebSocket over a raw socket. Text frames only; a frame over the limit closes it. */
class Socket {
  private buf = Buffer.alloc(0)
  private closed = false
  onText: (text: string) => void = () => {}
  onClose: () => void = () => {}

  constructor(private sock: Duplex) {
    sock.on('data', (chunk: Buffer) => this.read(chunk))
    sock.on('close', () => this.finish())
    sock.on('error', () => this.finish())
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }

  private read(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      if (this.buf.length < 2) return
      const b0 = this.buf[0]
      const b1 = this.buf[1]
      const fin = (b0 & 0x80) !== 0
      const op = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let at = 2
      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        const big = this.buf.readBigUInt64BE(2)
        if (big > BigInt(RELAY_LIMITS.frame * 2)) return this.close(1009, 'frame too large')
        len = Number(big)
        at = 10
      }
      // Frames from a client are always masked; a larger frame than any message may be is never buffered.
      if (!masked) return this.close(1002, 'unmasked frame')
      if (len > RELAY_LIMITS.frame * 2) return this.close(1009, 'frame too large')
      if (this.buf.length < at + 4 + len) return
      const mask = this.buf.subarray(at, at + 4)
      const data = Buffer.from(this.buf.subarray(at + 4, at + 4 + len))
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]
      this.buf = this.buf.subarray(at + 4 + len)
      if (!fin || op === 0) return this.close(1003, 'fragmented frames are not supported')
      if (op === 0x8) return this.close(1000, '')
      if (op === 0x9) {
        this.frame(0xa, data)
        continue
      }
      if (op === 0xa) continue
      if (op !== 0x1) return this.close(1003, 'text only')
      this.onText(data.toString('utf8'))
    }
  }

  private frame(op: number, data: Buffer): void {
    if (this.closed) return
    const head = data.length < 126 ? Buffer.from([0x80 | op, data.length]) : data.length < 65536 ? Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 0xff]) : (() => {
      const h = Buffer.alloc(10)
      h[0] = 0x80 | op
      h[1] = 127
      h.writeBigUInt64BE(BigInt(data.length), 2)
      return h
    })()
    this.sock.write(Buffer.concat([head, data]))
  }

  send(text: string): void {
    this.frame(0x1, Buffer.from(text, 'utf8'))
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    const r = Buffer.from(reason.slice(0, 100), 'utf8')
    const body = Buffer.alloc(2 + r.length)
    body.writeUInt16BE(code, 0)
    r.copy(body, 2)
    this.frame(0x8, body)
    this.sock.end()
    this.finish()
  }
}

export interface RelayOptions {
  port?: number
  host?: string
  /** Where the phone page is (resources/remote). */
  pageDir?: string
  /** For checks: sees every opaque frame, and may alter (return a new string) or drop (return null) it. */
  tap?: RoomHost['tap']
}

export interface Relay {
  port: number
  url: string
  /** How many times a computer has connected (a check that nothing connects when it should not). */
  pcConnects(): number
  rooms(): number
  /** For checks: drops every phone's connection, as a phone that lost its signal would. */
  dropPhones(): void
  close(): Promise<void>
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }

export function startRelay(o: RelayOptions = {}): Promise<Relay> {
  const pageDir = o.pageDir || path.join(process.cwd(), 'resources', 'remote')
  const rooms = new Map<string, { hash: string | null; conns: Set<Conn> }>()
  let pcConnects = 0
  const room = (id: string): { hash: string | null; conns: Set<Conn> } => {
    let r = rooms.get(id)
    if (!r) rooms.set(id, (r = { hash: null, conns: new Set() }))
    return r
  }
  const hostOf = (id: string): RoomHost => {
    const r = room(id)
    return {
      conns: () => [...r.conns],
      storedHash: async () => r.hash,
      storeHash: async (h) => void (r.hash = h),
      sha256Hex: async (t) => createHash('sha256').update(t).digest('hex'),
      tap: o.tap,
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://relay')
    const sec = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }
    if (url.pathname === '/relay.json') {
      res.writeHead(200, { ...sec, 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(RELAY_INFO))
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const allowed = ['index.html', 'tunnel.js', 'sw.js', 'icon.png', 'manifest.webmanifest']
    const file = allowed.includes(name) ? path.join(pageDir, name) : ''
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, sec)
      return res.end()
    }
    const body = fs.readFileSync(file)
    const headers: Record<string, string> = { ...sec, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }
    if (name === 'index.html') {
      const hashes = [...body.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
      headers['Content-Security-Policy'] = pageCsp(hashes)
    }
    res.writeHead(200, headers)
    res.end(body)
  })

  server.on('upgrade', (req, sock: Duplex) => {
    const url = new URL(req.url || '/', 'http://relay')
    const m = /^\/room\/([^/]+)\/(pc|phone)$/.exec(url.pathname)
    const key = String(req.headers['sec-websocket-key'] || '')
    if (!m || !ROOM_ID.test(m[1]) || !/^[A-Za-z0-9+/]{22}==$/.test(key) || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      sock.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const role = m[2] as Role
    const id = m[1]
    const r = room(id)
    const host = hostOf(id)
    const ws = new Socket(sock)
    const conn: Conn = { meta: newMeta(role, randomBytes(9).toString('base64url')), send: (t) => ws.send(t), close: (c, why) => ws.close(c, why) }
    r.conns.add(conn)
    if (role === 'pc') {
      pcConnects++
      const t = setTimeout(() => {
        if (!conn.meta.claimed) conn.close(4001, 'claim first')
      }, RELAY_LIMITS.claimMs)
      t.unref()
    }
    // One message at a time per connection, in order: a claim must land before what follows it.
    let line = Promise.resolve()
    ws.onText = (text) => {
      line = line.then(() => onMessage(host, conn, text)).catch(() => conn.close(1011, 'error'))
    }
    ws.onClose = () => {
      r.conns.delete(conn)
      onClose(host, conn)
      if (!r.conns.size && !r.hash) rooms.delete(id)
    }
    onOpen(host, conn)
  })

  return new Promise((resolve) => {
    server.listen(o.port ?? 0, o.host || '127.0.0.1', () => {
      const a = server.address()
      const port = typeof a === 'object' && a ? a.port : 0
      resolve({
        port,
        url: `http://${o.host || '127.0.0.1'}:${port}`,
        pcConnects: () => pcConnects,
        rooms: () => rooms.size,
        dropPhones: () => {
          for (const r of rooms.values()) for (const c of r.conns) if (c.meta.role === 'phone') c.close(1001, 'gone')
        },
        close: () =>
          new Promise<void>((done) => {
            for (const r of rooms.values()) for (const c of r.conns) c.close(1001, 'relay closing')
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

// Run on its own: `node relay.mjs 8787`.
if (process.argv[1] && /relay\.(mjs|js|ts)$/.test(process.argv[1])) {
  void startRelay({ port: Number(process.argv[2]) || 8787 }).then((r) => console.log(`relay on ${r.url}`))
}
