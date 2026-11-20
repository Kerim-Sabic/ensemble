import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toolContent, type TeamTool } from './providers/types'

/** The limits the tool server holds every request to. All can be set for a check; the defaults are what the app runs with. */
export interface ToolServerLimits {
  /** The largest request body, in bytes. A tool call is a brief or a message: 2 MB is far above any real one. */
  maxBody: number
  /** How long the headers may take to arrive. */
  headersMs: number
  /** How long the whole request (headers and body) may take to arrive. */
  requestMs: number
  /** How long an idle kept-alive connection is held open. */
  keepAliveMs: number
  /** Requests under way at once on one agent's address. Refused with 429 beyond that, not queued. */
  perAgent: number
  /** Requests under way at once on the whole server. Refused with 429 beyond that, not queued. */
  overall: number
  /** How long one tool may run. Asking a teammate or waiting for a person can take many minutes, so this is generous. */
  toolMs: number
  /** How many calls one request may carry as a batch. */
  maxBatch: number
}

export const TOOL_SERVER_LIMITS: ToolServerLimits = {
  maxBody: 2 * 1024 * 1024,
  headersMs: 10_000,
  requestMs: 30_000,
  keepAliveMs: 5_000,
  perAgent: 8,
  overall: 256,
  toolMs: 30 * 60 * 1000,
  maxBatch: 20,
}

type Json = Record<string, unknown>
const rpcError = (code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })

/** Whether a parsed body is a JSON-RPC 2.0 message (a call, a notification or a response), or a small batch of them. */
export function validRpc(body: unknown, maxBatch = TOOL_SERVER_LIMITS.maxBatch): boolean {
  const one = (m: unknown): boolean => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false
    const o = m as Json
    if (o.jsonrpc !== '2.0') return false
    if ('id' in o && o.id !== null && typeof o.id !== 'string' && typeof o.id !== 'number') return false
    if (typeof o.method === 'string') return o.method.length > 0 && o.method.length <= 200 && (o.params === undefined || (typeof o.params === 'object' && o.params !== null))
    return 'id' in o && ('result' in o || (typeof o.error === 'object' && o.error !== null))
  }
  return Array.isArray(body) ? body.length > 0 && body.length <= maxBatch && body.every(one) : one(body)
}

/**
 * Serves the team tools over local HTTP for agents that cannot take in-process
 * tools (ChatGPT). Bound to 127.0.0.1; each agent gets its own unguessable path.
 *
 * It answers only what such an agent sends: a JSON-RPC POST, of bounded size, arriving in
 * bounded time, addressed to this machine by name (a page in a browser that points a name of
 * its own at 127.0.0.1 is refused, as is anything carrying a browser's Origin), and only so
 * many at once. What goes wrong inside is never described in a reply.
 */
export class ToolServer {
  private server: http.Server | null = null
  private port = 0
  private routes = new Map<string, TeamTool[]>()
  private tokens = new Map<string, string>()
  private limits: ToolServerLimits
  /** Requests under way: on the whole server, and per agent address. */
  private active = 0
  private perToken = new Map<string, number>()

  constructor(limits: Partial<ToolServerLimits> = {}) {
    this.limits = { ...TOOL_SERVER_LIMITS, ...limits }
  }

  async start(): Promise<void> {
    // How often the server looks for senders that are over their time: often enough for the limits to mean what they say.
    const every = Math.max(50, Math.min(5_000, Math.floor(Math.min(this.limits.headersMs, this.limits.requestMs) / 2)))
    const server = http.createServer({ connectionsCheckingInterval: every }, (req, res) => void this.handle(req, res))
    // Slow or stuck senders are cut off; a tool that runs long is not (the limits below are about receiving).
    server.headersTimeout = this.limits.headersMs
    server.requestTimeout = this.limits.requestMs
    server.keepAliveTimeout = this.limits.keepAliveMs
    server.maxHeadersCount = 64
    server.timeout = 0
    server.on('clientError', (e, socket) => {
      // Node's own time limit reports here too, and can fire a moment before the timer in body():
      // a sender that is too slow gets 408 whichever of the two notices first.
      const late = (e as NodeJS.ErrnoException).code === 'ERR_HTTP_REQUEST_TIMEOUT'
      if (socket.writable) socket.end(`HTTP/1.1 ${late ? '408 Request Timeout' : '400 Bad Request'}\r\nconnection: close\r\n\r\n`)
      else socket.destroy()
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
  }

  /** Returns the URL an agent should be pointed at. Stable per key. */
  register(key: string, tools: TeamTool[]): string | undefined {
    if (!this.port) return undefined
    let token = this.tokens.get(key)
    if (!token) this.tokens.set(key, (token = randomUUID()))
    this.routes.set(token, tools)
    return `http://127.0.0.1:${this.port}/mcp/${token}`
  }

  /** Forgets an agent's tools once it is gone, so its address stops answering. */
  unregister(key: string): void {
    const token = this.tokens.get(key)
    if (!token) return
    this.tokens.delete(key)
    this.routes.delete(token)
  }

  /** Reads the body, up to the size limit and within the time limit. */
  private body(req: http.IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; status: 408 | 413 | 400 }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const finish = (r: { ok: true; text: string } | { ok: false; status: 408 | 413 | 400 }): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        req.off('data', onData)
        resolve(r)
      }
      const timer = setTimeout(() => finish({ ok: false, status: 408 }), this.limits.requestMs)
      const onData = (c: Buffer): void => {
        size += c.length
        if (size > this.limits.maxBody) finish({ ok: false, status: 413 })
        else chunks.push(c)
      }
      req.on('data', onData)
      req.once('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
      req.once('error', () => finish({ ok: false, status: 400 }))
      req.once('aborted', () => finish({ ok: false, status: 400 }))
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Refuses, says why in one generic line, and stops reading whatever is still on its way.
    const refuse = (status: number, code: number, message: string, headers: Record<string, string> = {}): void => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers }).end(rpcError(code, message), () => {
        if (!req.complete) req.destroy()
      })
    }
    // Addressed to this machine by its own name and our port, and not from a page in a browser.
    const host = String(req.headers.host || '').toLowerCase()
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return refuse(403, -32000, 'Forbidden')
    if (req.headers.origin !== undefined) return refuse(403, -32000, 'Forbidden')
    const m = /^\/mcp\/([\w-]+)\/?(?:\?.*)?$/.exec(req.url || '')
    const token = m ? m[1] : ''
    const tools = token ? this.routes.get(token) : undefined
    if (!tools) {
      res.writeHead(404, { connection: 'close' }).end(() => {
        if (!req.complete) req.destroy()
      })
      return
    }
    if (req.method !== 'POST') return refuse(405, -32000, 'Method not allowed', { allow: 'POST' })
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return refuse(415, -32000, 'Unsupported media type')
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > this.limits.maxBody) return refuse(413, -32000, 'Request too large')
    // Only so many at once: refused at once rather than queued, so a stuck caller cannot pile work up.
    const mine = this.perToken.get(token) || 0
    if (this.active >= this.limits.overall || mine >= this.limits.perAgent) return refuse(429, -32000, 'Too many requests', { 'retry-after': '1' })
    this.active++
    this.perToken.set(token, mine + 1)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.active--
      const n = (this.perToken.get(token) || 1) - 1
      if (n > 0) this.perToken.set(token, n)
      else this.perToken.delete(token)
    }
    res.once('close', release)
    try {
      const got = await this.body(req)
      if (!got.ok) return refuse(got.status, -32000, got.status === 413 ? 'Request too large' : got.status === 408 ? 'Request timed out' : 'Bad request')
      let body: unknown
      try {
        body = JSON.parse(got.text)
      } catch {
        return refuse(400, -32700, 'Parse error')
      }
      // The shape is checked before anything is built for the request.
      if (!validRpc(body, this.limits.maxBatch)) return refuse(400, -32600, 'Invalid request')
      const mcp = new McpServer({ name: 'team', version: '1.0.0' })
      for (const t of tools) {
        mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: Record<string, unknown>) => {
          let timer: NodeJS.Timeout | undefined
          try {
            const late = new Promise<never>((_r, reject) => {
              timer = setTimeout(() => reject(new Error(`this took longer than ${Math.round(this.limits.toolMs / 60000)} minutes and was given up on`)), this.limits.toolMs)
              timer.unref?.()
            })
            return toolContent(await Promise.race([t.run(args || {}), late]))
          } catch (e) {
            // A tool's own refusal is its answer to the agent that called it.
            return { content: [{ type: 'text' as const, text: `Failed: ${(e as Error).message}` }], isError: true }
          } finally {
            clearTimeout(timer)
          }
        })
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      // What went wrong stays in the app's own log.
      console.error('[tool server]', (e as Error).message)
      if (!res.headersSent) refuse(500, -32603, 'Internal error')
      else res.destroy()
    } finally {
      if (res.writableEnded || res.destroyed) release()
    }
  }

  stop(): void {
    this.server?.close()
    this.server?.closeAllConnections?.()
    this.server = null
  }
}
