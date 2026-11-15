// Connectors: outside services (GitHub, a database, a search engine, a folder) that every
// agent on the team can use, through the Model Context Protocol. Shared by the main process,
// which runs them, and the window, which sets them up.

/** How a connector is reached: a program run on this computer, or an address on the web. */
export interface ConnectorSpec {
  kind: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface ConnectorTest {
  ok: boolean
  /** The tools it offers, by name. */
  tools: string[]
  error?: string
  at: number
}

export type ConnectorSource = 'catalog' | 'claude-code' | 'codex' | 'desktop' | 'custom'

export interface Connector {
  id: string
  /** What people call it. */
  name: string
  /** The short name its tools go by: mcp__<slug>__<tool>. */
  slug: string
  blurb?: string
  spec: ConnectorSpec
  /** Which values in env and headers are secrets. They are kept encrypted and never sent to the window. */
  secrets: string[]
  enabled: boolean
  /** Which accounts' agents get it. 'all' includes accounts added later. */
  accounts: 'all' | string[]
  source: ConnectorSource
  catalogId?: string
  test?: ConnectorTest
  createdAt: number
}

/** What the window sees of a connector: everything but the secret values, which show as saved or not. */
export interface ConnectorView extends Omit<Connector, 'spec'> {
  spec: ConnectorSpec
  /** For each secret: whether a value is saved. */
  saved: Record<string, boolean>
}

/** A connector found in another app's settings on this computer, ready to bring in. */
export interface FoundConnector {
  key: string
  name: string
  slug: string
  source: Exclude<ConnectorSource, 'catalog' | 'custom'>
  /** Where it was found, in words: "Claude Code (Main)". */
  where: string
  spec: ConnectorSpec
  /** Present when it is already set up in Ensemble. */
  added?: boolean
  /** A web address with no key, which usually means the service wants a sign-in Ensemble cannot do for it. */
  mayNeedSignIn?: boolean
}

export interface ConnectorInput {
  id?: string
  name: string
  slug?: string
  blurb?: string
  spec: ConnectorSpec
  /** A secret left empty keeps the value already saved. */
  secrets?: string[]
  enabled?: boolean
  accounts?: 'all' | string[]
  source: ConnectorSource
  catalogId?: string
}

// ───────────── the catalog ─────────────

export interface CatalogField {
  key: string
  label: string
  placeholder?: string
  help?: string
  secret?: boolean
  /** A folder chosen with the folder picker. */
  folder?: boolean
  optional?: boolean
  /** Where to get the value. */
  link?: string
}

export interface CatalogEntry {
  id: string
  name: string
  slug: string
  blurb: string
  /** A word for the tile. */
  group: 'Code' | 'Web' | 'Data' | 'Files' | 'Media' | 'Thinking'
  /** What it needs on this computer to run. */
  needs?: 'node' | 'uv'
  fields: CatalogField[]
  /** The connection, with {{field}} where a field's value goes. */
  spec: ConnectorSpec
  docs?: string
}

/**
 * A short list of well-known connectors that need only a key, a folder, or nothing. Services
 * that can only be reached with a browser sign-in (Notion, Slack, Linear) are left out until
 * the app can do that sign-in itself; they can still be added by hand with a token.
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    slug: 'github',
    blurb: 'Repositories, issues, pull requests and code search',
    group: 'Code',
    fields: [{ key: 'token', label: 'Personal access token', secret: true, placeholder: 'github_pat_…', link: 'https://github.com/settings/personal-access-tokens', help: 'A fine-grained token with access to the repositories the team should see.' }],
    spec: { kind: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {{token}}' } },
    docs: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'context7',
    name: 'Context7',
    slug: 'context7',
    blurb: 'Up-to-date documentation for libraries and frameworks',
    group: 'Code',
    fields: [{ key: 'key', label: 'API key', secret: true, optional: true, help: 'Optional. Works without one, with lower limits.', link: 'https://context7.com/dashboard' }],
    spec: { kind: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: '{{key}}' } },
    docs: 'https://github.com/upstash/context7',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    slug: 'supabase',
    blurb: 'Databases, tables, migrations and edge functions',
    group: 'Data',
    needs: 'node',
    fields: [{ key: 'token', label: 'Access token', secret: true, placeholder: 'sbp_…', link: 'https://supabase.com/dashboard/account/tokens' }],
    spec: { kind: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'], env: { SUPABASE_ACCESS_TOKEN: '{{token}}' } },
    docs: 'https://github.com/supabase-community/supabase-mcp',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    slug: 'stripe',
    blurb: 'Customers, products, prices and payments',
    group: 'Data',
    needs: 'node',
    fields: [{ key: 'key', label: 'Secret key', secret: true, placeholder: 'sk_test_… or rk_…', link: 'https://dashboard.stripe.com/apikeys', help: 'A test key or a restricted key is safest.' }],
    spec: { kind: 'stdio', command: 'npx', args: ['-y', '@stripe/mcp', '--tools=all'], env: { STRIPE_SECRET_KEY: '{{key}}' } },
    docs: 'https://github.com/stripe/agent-toolkit',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    slug: 'brave',
    blurb: 'Web, news and image search',
    group: 'Web',
    needs: 'node',
    fields: [{ key: 'key', label: 'API key', secret: true, link: 'https://brave.com/search/api/' }],
    spec: { kind: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: '{{key}}' } },
    docs: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    slug: 'playwright',
    blurb: 'A scriptable browser for testing sites the team builds',
    group: 'Web',
    needs: 'node',
    fields: [],
    spec: { kind: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare docs',
    slug: 'cloudflare_docs',
    blurb: 'Search the Cloudflare documentation',
    group: 'Web',
    fields: [],
    spec: { kind: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' },
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    slug: 'huggingface',
    blurb: 'Models, datasets, papers and Spaces',
    group: 'Data',
    fields: [{ key: 'token', label: 'Access token', secret: true, optional: true, link: 'https://huggingface.co/settings/tokens', help: 'Optional, for private models and higher limits.' }],
    spec: { kind: 'http', url: 'https://huggingface.co/mcp', headers: { Authorization: 'Bearer {{token}}' } },
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    slug: 'elevenlabs',
    blurb: 'Voices, speech and sound effects',
    group: 'Media',
    needs: 'uv',
    fields: [{ key: 'key', label: 'API key', secret: true, link: 'https://elevenlabs.io/app/settings/api-keys' }],
    spec: { kind: 'stdio', command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: '{{key}}' } },
    docs: 'https://github.com/elevenlabs/elevenlabs-mcp',
  },
  {
    id: 'filesystem',
    name: 'A folder',
    slug: 'folder',
    blurb: 'Read and write files in one folder outside the project',
    group: 'Files',
    needs: 'node',
    fields: [{ key: 'path', label: 'Folder', folder: true }],
    spec: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{{path}}'] },
  },
  {
    id: 'memory',
    name: 'Knowledge graph',
    slug: 'graph',
    blurb: 'A memory of people, things and how they relate',
    group: 'Thinking',
    needs: 'node',
    fields: [],
    spec: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  {
    id: 'sequential-thinking',
    name: 'Step-by-step thinking',
    slug: 'thinking',
    blurb: 'Structured reasoning for hard problems',
    group: 'Thinking',
    needs: 'node',
    fields: [],
    spec: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  },
]

/** Puts field values into a catalog spec. A header or variable whose field was left empty is dropped. */
export function fillSpec(spec: ConnectorSpec, values: Record<string, string>): ConnectorSpec {
  const fill = (s: string): string => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '')
  const map = (m?: Record<string, string>): Record<string, string> | undefined => {
    if (!m) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(m)) {
      const empty = /\{\{(\w+)\}\}/.test(v) && !(v.match(/\{\{(\w+)\}\}/g) || []).some((t) => values[t.slice(2, -2)])
      if (!empty) out[k] = fill(v)
    }
    return Object.keys(out).length ? out : undefined
  }
  return { kind: spec.kind, command: spec.command, args: spec.args?.map(fill), env: map(spec.env), url: spec.url && fill(spec.url), headers: map(spec.headers) }
}

/** The env and header names that hold a catalog entry's secret fields. */
export function secretKeys(entry: CatalogEntry): string[] {
  const secret = new Set(entry.fields.filter((f) => f.secret).map((f) => f.key))
  const out: string[] = []
  for (const m of [entry.spec.env, entry.spec.headers]) for (const [k, v] of Object.entries(m || {})) if ([...v.matchAll(/\{\{(\w+)\}\}/g)].some((x) => secret.has(x[1]))) out.push(k)
  return out
}

/** A name its tools can go by: letters, digits and underscores. */
export const toSlug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'connector'

/** Names that look like they hold a secret, for connectors brought in from elsewhere. */
export const LOOKS_SECRET = /key|token|secret|password|pass|auth|cookie|credential/i
