import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { LOOKS_SECRET, toSlug, type Connector, type ConnectorInput, type ConnectorSpec, type ConnectorTest, type ConnectorView, type FoundConnector } from '@shared/connectors'
import type { Account } from '@shared/types'
import { readJson, uid, writeJson } from './util'

// The connectors the team uses: kept in Ensemble's data folder with their secrets encrypted,
// handed to every agent when it starts, and tested on request. Connectors already set up in
// Claude Code, Codex or the Claude desktop app can be brought in from their own settings.

export interface Sealer {
  seal(plain: string): string
  open(sealed: string): string
}

/** Kept as-is where no encryption is available (terminal tests). Marked so a real seal is never mistaken for it. */
const PLAIN: Sealer = { seal: (s) => `plain:${s}`, open: (s) => (s.startsWith('plain:') ? s.slice(6) : s) }

/** Windows starts npx and friends through cmd, the way Claude Code itself expects. */
const SHIMS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'uvx', 'uv'])
function launch(spec: ConnectorSpec): { command: string; args: string[] } {
  const cmd = spec.command || ''
  const args = spec.args || []
  if (process.platform === 'win32' && SHIMS.has(cmd.toLowerCase())) return { command: 'cmd', args: ['/c', cmd, ...args] }
  return { command: cmd, args }
}

export class ConnectorStore {
  private file: string
  private list: Connector[]

  constructor(
    dataDir: string,
    private sealer: Sealer = PLAIN,
  ) {
    this.file = path.join(dataDir, 'connectors.json')
    this.list = readJson<Connector[]>(this.file, [])
  }

  private persist(): void {
    writeJson(this.file, this.list)
  }

  all(): Connector[] {
    return this.list
  }

  /** What the window may see: secret values left out. */
  views(): ConnectorView[] {
    return this.list.map((c) => {
      const saved: Record<string, boolean> = {}
      const hide = (m?: Record<string, string>): Record<string, string> | undefined => {
        if (!m) return undefined
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(m)) {
          if (c.secrets.includes(k)) {
            saved[k] = !!v
            out[k] = ''
          } else out[k] = v
        }
        return out
      }
      return { ...c, spec: { ...c.spec, env: hide(c.spec.env), headers: hide(c.spec.headers) }, saved }
    })
  }

  /** The spec with its secrets readable, for running it. */
  private open(c: Connector): ConnectorSpec {
    const show = (m?: Record<string, string>): Record<string, string> | undefined => {
      if (!m) return undefined
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(m)) {
        try {
          out[k] = c.secrets.includes(k) && v ? this.sealer.open(v) : v
        } catch {
          out[k] = ''
        }
      }
      return out
    }
    return { ...c.spec, env: show(c.spec.env), headers: show(c.spec.headers) }
  }

  put(input: ConnectorInput): Connector {
    const had = input.id ? this.list.find((c) => c.id === input.id) : undefined
    const name = input.name.trim() || had?.name || 'Connector'
    let slug = toSlug(input.slug || had?.slug || name)
    // The team's own tools already go by "team".
    if (slug === 'team') slug = 'team_connector'
    for (let n = 2; this.list.some((c) => c.slug === slug && c.id !== had?.id); n++) slug = `${toSlug(input.slug || name)}_${n}`
    const secrets = [...new Set([...(input.secrets || []), ...Object.keys({ ...input.spec.env, ...input.spec.headers }).filter((k) => LOOKS_SECRET.test(k))])]
    // A secret sent back empty keeps what was saved; one with a value is sealed.
    const seal = (m: Record<string, string> | undefined, old: Record<string, string> | undefined): Record<string, string> | undefined => {
      if (!m) return undefined
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(m)) {
        const key = k.trim()
        if (!key) continue
        if (secrets.includes(key)) out[key] = v ? this.sealer.seal(v) : old?.[key] || ''
        else out[key] = v
      }
      return Object.keys(out).length ? out : undefined
    }
    const spec: ConnectorSpec = {
      kind: input.spec.kind,
      command: input.spec.kind === 'stdio' ? input.spec.command?.trim() : undefined,
      args: input.spec.kind === 'stdio' ? (input.spec.args || []).filter((a) => a !== '') : undefined,
      env: seal(input.spec.env, had?.spec.env),
      url: input.spec.kind !== 'stdio' ? input.spec.url?.trim() : undefined,
      headers: input.spec.kind !== 'stdio' ? seal(input.spec.headers, had?.spec.headers) : undefined,
    }
    const c: Connector = {
      id: had?.id || uid('k'),
      name,
      slug,
      blurb: input.blurb ?? had?.blurb,
      spec,
      secrets,
      enabled: input.enabled ?? had?.enabled ?? true,
      accounts: input.accounts ?? had?.accounts ?? 'all',
      source: input.source,
      catalogId: input.catalogId ?? had?.catalogId,
      // A changed connection has not been tried yet.
      test: had && JSON.stringify(had.spec) === JSON.stringify(spec) ? had.test : undefined,
      createdAt: had?.createdAt || Date.now(),
    }
    this.list = had ? this.list.map((x) => (x.id === c.id ? c : x)) : [...this.list, c]
    this.persist()
    return c
  }

  remove(id: string): void {
    this.list = this.list.filter((c) => c.id !== id)
    this.persist()
  }

  setTest(id: string, test: ConnectorTest): void {
    const c = this.list.find((x) => x.id === id)
    if (!c) return
    c.test = test
    this.persist()
  }

  /** The connectors one account's agents get, by slug, in the shape Claude Code takes. `skip` are names the account already has. */
  forClaude(account: Account, skip: Set<string> = new Set()): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const c of this.list) {
      if (!c.enabled || skip.has(c.slug) || (c.accounts !== 'all' && !c.accounts.includes(account.id))) continue
      const s = this.open(c)
      if (s.kind === 'stdio') {
        const l = launch(s)
        out[c.slug] = { type: 'stdio', command: l.command, args: l.args, ...(s.env ? { env: s.env } : {}) }
      } else out[c.slug] = { type: s.kind, url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
    }
    return out
  }

  /** The same for a ChatGPT account, in the shape of Codex's settings. */
  forCodex(account: Account, skip: Set<string> = new Set()): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const c of this.list) {
      if (!c.enabled || skip.has(c.slug) || (c.accounts !== 'all' && !c.accounts.includes(account.id))) continue
      const s = this.open(c)
      if (s.kind === 'stdio') {
        const l = launch(s)
        out[c.slug] = { command: l.command, args: l.args, ...(s.env ? { env: s.env } : {}), startup_timeout_sec: 60, tool_timeout_sec: 300 }
      } else out[c.slug] = { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}), tool_timeout_sec: 300 }
    }
    return out
  }

  /** Connects, lists the tools, and disconnects. A first run of an npx connector downloads it, so it gets a while. */
  async test(id: string): Promise<ConnectorTest> {
    const c = this.list.find((x) => x.id === id)
    if (!c) return { ok: false, tools: [], error: 'That connector no longer exists.', at: Date.now() }
    const s = this.open(c)
    const client = new Client({ name: 'ensemble', version: '1.0.0' })
    let result: ConnectorTest
    try {
      const transport =
        s.kind === 'stdio'
          ? new StdioClientTransport({ ...launch(s), env: { ...getDefaultEnvironment(), ...process.env, ...(s.env || {}) } as Record<string, string>, stderr: 'ignore' })
          : s.kind === 'sse'
            ? new SSEClientTransport(new URL(s.url || ''), { requestInit: { headers: s.headers || {} } })
            : new StreamableHTTPClientTransport(new URL(s.url || ''), { requestInit: { headers: s.headers || {} } })
      const work = (async () => {
        await client.connect(transport)
        const { tools } = await client.listTools()
        return tools.map((t) => t.name)
      })()
      const tools = await Promise.race([work, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('It did not answer within 90 seconds.')), 90_000))])
      result = { ok: true, tools, at: Date.now() }
    } catch (e) {
      const msg = (e as Error).message || String(e)
      result = {
        ok: false,
        tools: [],
        at: Date.now(),
        error: /401|403|unauthori[sz]ed|forbidden/i.test(msg)
          ? 'The service refused the key, or needs a sign-in. Check the token and its permissions.'
          : /ENOENT|not recognized|cannot find/i.test(msg)
            ? `${s.command} is not installed on this computer.${s.command === 'uvx' ? ' Install uv from astral.sh/uv.' : s.command === 'npx' ? ' Install Node.js from nodejs.org.' : ''}`
            : msg.slice(0, 300),
      }
    } finally {
      await client.close().catch(() => undefined)
    }
    this.setTest(id, result)
    return result
  }
}

// ───────────── what other apps on this computer already have ─────────────

function fromJson(name: string, v: Record<string, unknown>): ConnectorSpec | null {
  if (typeof v.command === 'string') return { kind: 'stdio', command: v.command, args: Array.isArray(v.args) ? v.args.map(String) : undefined, env: (v.env as Record<string, string>) || undefined }
  if (typeof v.url === 'string') return { kind: v.type === 'sse' ? 'sse' : 'http', url: v.url, headers: (v.headers as Record<string, string>) || undefined }
  void name
  return null
}

/** Just enough TOML for the `[mcp_servers.name]` tables of a Codex config. */
function codexServers(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  let cur: Record<string, unknown> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line) continue
    const head = /^\[(.+)\]$/.exec(line)
    if (head) {
      const parts = head[1].split('.').map((p) => p.trim().replace(/^"|"$/g, ''))
      if (parts[0] !== 'mcp_servers' || parts.length < 2) {
        cur = null
        continue
      }
      const server = (out[parts[1]] ||= {})
      cur = parts.length === 2 ? server : ((server[parts[2]] as Record<string, unknown>) ||= {})
      continue
    }
    const kv = /^([\w"-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv || !cur) continue
    const key = kv[1].replace(/^"|"$/g, '')
    const val = kv[2].trim()
    try {
      cur[key] = val.startsWith('[') || val.startsWith('"') || /^(true|false|-?\d+(\.\d+)?)$/.test(val) ? JSON.parse(val.replace(/'/g, '"')) : val
    } catch {
      cur[key] = val.replace(/^['"]|['"]$/g, '')
    }
  }
  return out
}

/** Connectors set up in Claude Code (each account), the Claude desktop app and Codex. */
export function findConnectors(accounts: Account[]): FoundConnector[] {
  const home = os.homedir()
  const out: FoundConnector[] = []
  const add = (source: FoundConnector['source'], where: string, name: string, spec: ConnectorSpec | null): void => {
    if (!spec || name === 'team') return
    const key = `${source}:${where}:${name}`
    if (out.some((f) => f.key === key)) return
    out.push({ key, name, slug: toSlug(name), source, where, spec, mayNeedSignIn: spec.kind !== 'stdio' && !Object.keys(spec.headers || {}).length && !/[?&](key|token|api)/i.test(spec.url || '') })
  }
  for (const a of accounts.filter((x) => x.provider === 'claude')) {
    const file = a.configDir ? path.join(a.configDir, '.claude.json') : path.join(home, '.claude.json')
    const j = readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(file, {})
    for (const [n, v] of Object.entries(j.mcpServers || {})) add('claude-code', `Claude Code (${a.name})`, n, fromJson(n, v))
  }
  const desktop: string[] = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    try {
      for (const d of fs.readdirSync(path.join(local, 'Claude-Data'))) desktop.push(path.join(local, 'Claude-Data', d, 'claude_desktop_config.json'))
    } catch {
      /* not installed */
    }
  }
  if (process.env.APPDATA) desktop.push(path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'))
  desktop.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
  for (const f of desktop) {
    const j = readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(f, {})
    for (const [n, v] of Object.entries(j.mcpServers || {})) add('desktop', 'Claude desktop app', n, fromJson(n, v))
  }
  for (const a of accounts.filter((x) => x.provider === 'chatgpt')) {
    const file = path.join(a.configDir || path.join(home, '.codex'), 'config.toml')
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const [n, v] of Object.entries(codexServers(text))) {
      const spec: ConnectorSpec | null =
        typeof v.command === 'string'
          ? { kind: 'stdio', command: v.command, args: Array.isArray(v.args) ? v.args.map(String) : undefined, env: (v.env as Record<string, string>) || undefined }
          : typeof v.url === 'string'
            ? { kind: 'http', url: v.url, headers: (v.http_headers as Record<string, string>) || undefined }
            : null
      add('codex', `Codex (${a.name})`, n, spec)
    }
  }
  return out
}

/** The connector names an account already has in its own Claude Code settings, so they are not given twice. */
export function ownConnectors(account: Account): Set<string> {
  if (account.provider !== 'claude') return new Set()
  const file = account.configDir ? path.join(account.configDir, '.claude.json') : path.join(os.homedir(), '.claude.json')
  return new Set(Object.keys(readJson<{ mcpServers?: Record<string, unknown> }>(file, {}).mcpServers || {}).map(toSlug))
}
