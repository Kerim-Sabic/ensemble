// The relay as a Cloudflare Worker with one Durable Object per room. Same protocol and limits as
// the local Node relay: both run core.ts. See README.md for what it can and cannot see, and how to
// put it on your own Cloudflare account (free plan).
//
// Hibernation: the room's sockets are accepted with ctx.acceptWebSocket, so a room whose computer
// is connected but quiet costs (almost) nothing; each socket's state travels in its attachment.
import { DurableObject } from 'cloudflare:workers'
import page from '../resources/remote/index.html'
import tunnelJs from '../resources/remote/tunnel.js'
import swJs from '../resources/remote/sw.js'
import icon from '../resources/remote/icon.png'
import { RELAY_INFO, RELAY_LIMITS, ROOM_ID, newMeta, onClose, onMessage, onOpen, pageCsp, type Conn, type ConnMeta, type Role, type RoomHost } from './core'

interface Env {
  ROOMS: DurableObjectNamespace
}

// The few Cloudflare types used here, so this file reads on its own (wrangler brings the real ones).
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } }
type DurableObjectNamespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
type Ctx = {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): WebSocket[]
  storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; setAlarm(at: number): Promise<void> }
}
type Hib = WebSocket & { serializeAttachment(v: unknown): void; deserializeAttachment(): unknown }

const sha256Hex = async (text: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256B64 = async (text: string): Promise<string> => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))))

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }
let csp: string | null = null

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const m = /^\/room\/([^/]+)\/(pc|phone)$/.exec(url.pathname)
    if (m) {
      if (!ROOM_ID.test(m[1]) || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Bad request', { status: 400, headers: SEC })
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req)
    }
    if (req.method !== 'GET') return new Response(null, { status: 405, headers: SEC })
    if (url.pathname === '/relay.json') return Response.json(RELAY_INFO, { headers: SEC })
    if (url.pathname === '/' || url.pathname === '/index.html') {
      csp ??= pageCsp(await Promise.all([...String(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(async (x) => `'sha256-${await sha256B64(x[1])}'`)))
      return new Response(page, { headers: { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY' } })
    }
    if (url.pathname === '/tunnel.js') return new Response(tunnelJs, { headers: { ...SEC, 'Content-Type': 'text/javascript; charset=utf-8' } })
    if (url.pathname === '/sw.js') return new Response(swJs, { headers: { ...SEC, 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' } })
    if (url.pathname === '/icon.png' || url.pathname === '/apple-touch-icon.png') return new Response(icon, { headers: { ...SEC, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
    if (url.pathname === '/manifest.webmanifest') {
      return Response.json({ name: 'Ensemble', short_name: 'Ensemble', display: 'standalone', start_url: '/', scope: '/', background_color: '#141413', theme_color: '#141413', icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }] }, { headers: { ...SEC, 'Content-Type': 'application/manifest+json' } })
    }
    return new Response('Not found', { status: 404, headers: SEC })
  },
}

/** One room: a computer and its phones. Keeps only the SHA-256 of the computer's room secret. */
export class Room extends DurableObject {
  declare ctx: Ctx

  private conn(ws: WebSocket, known?: ConnMeta): Conn {
    const h = ws as Hib
    const quiet = (f: () => void): void => {
      try {
        f()
      } catch {
        /* the socket closed meanwhile */
      }
    }
    return { meta: known || (h.deserializeAttachment() as ConnMeta), send: (t) => quiet(() => ws.send(t)), close: (code, why) => quiet(() => ws.close(code, why)) }
  }

  /** `gone`: a socket whose close is being handled. It may still be listed, and must not count as connected. */
  private host(gone?: WebSocket): RoomHost {
    return {
      conns: () =>
        this.ctx
          .getWebSockets()
          .filter((ws) => ws !== gone)
          .map((ws) => this.conn(ws)),
      storedHash: async () => (await this.ctx.storage.get<string>('hash')) ?? null,
      storeHash: (h) => this.ctx.storage.put('hash', h),
      sha256Hex,
      saved: () => {},
    }
  }

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).pathname.endsWith('/pc') ? 'pc' : ('phone' as Role)
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1] as Hib
    this.ctx.acceptWebSocket(server, [role])
    const meta = newMeta(role, crypto.randomUUID().replace(/-/g, '').slice(0, 12))
    server.serializeAttachment(meta)
    // A computer that does not claim its room in time is closed by the alarm.
    if (role === 'pc') await this.ctx.storage.setAlarm(Date.now() + RELAY_LIMITS.claimMs)
    onOpen(this.host(), this.conn(server, meta))
    // What onOpen decided (a refusal) stays with the socket.
    server.serializeAttachment(meta)
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return ws.close(1003, 'text only')
    const conn = this.conn(ws)
    const host = this.host()
    host.saved = () => (ws as Hib).serializeAttachment(conn.meta)
    await onMessage(host, conn, message)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    onClose(this.host(ws), this.conn(ws))
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    onClose(this.host(ws), this.conn(ws))
  }

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets('pc')) {
      const m = (ws as Hib).deserializeAttachment() as ConnMeta
      if (!m.claimed) ws.close(4001, 'claim first')
    }
  }
}
