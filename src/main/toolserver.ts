import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toolContent, type TeamTool } from './providers/types'

/**
 * Serves the team tools over local HTTP for agents that cannot take in-process
 * tools (ChatGPT). Bound to 127.0.0.1; each agent gets its own unguessable path.
 */
export class ToolServer {
  private server: http.Server | null = null
  private port = 0
  private routes = new Map<string, TeamTool[]>()
  private tokens = new Map<string, string>()

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = this.server.address()
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

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const m = /^\/mcp\/([\w-]+)/.exec(req.url || '')
    const tools = m ? this.routes.get(m[1]) : undefined
    if (!tools) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }))
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const mcp = new McpServer({ name: 'team', version: '1.0.0' })
      for (const t of tools) {
        mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: Record<string, unknown>) => {
          try {
            return toolContent(await t.run(args || {}))
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `Failed: ${(e as Error).message}` }], isError: true }
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
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null }))
      }
    }
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }
}
