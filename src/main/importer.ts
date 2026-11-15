import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Item } from '@shared/types'
import { readJson, uid } from './util'

// Finds the conversations of the Claude desktop app's Code tab and the sidebar
// sections they are filed under, and turns one into the rows of a chat here.
// Everything is read-only: nothing in the desktop app's folders is ever written.

export interface FoundSession {
  /** The desktop app's id for the conversation ("local_…"). */
  id: string
  /** Claude Code's own id, which names the file the conversation is kept in. */
  cliSessionId?: string
  title: string
  /** The folder the conversation ran in. */
  cwd: string
  createdAt: number
  updatedAt: number
  /** The conversation on disk, and the account folder it is in. Absent when it could not be found. */
  transcript?: { file: string; configDir: string }
}

export interface FoundSection {
  id: string
  name: string
  sessions: FoundSession[]
}

export interface Found {
  found: boolean
  sections: FoundSection[]
  loose: FoundSession[]
}

interface SessionFile {
  sessionId?: string
  cliSessionId?: string
  cwd?: string
  originCwd?: string
  title?: string
  createdAt?: number
  lastActivityAt?: number
  isArchived?: boolean
}

interface GroupScope {
  groups?: { id: string; name: string; mode?: string }[]
  assignments?: Record<string, string>
}

/** Where the desktop app keeps its data on this computer, newest layout first. */
function appRoots(): string[] {
  const out: string[] = []
  const add = (dir: string): void => {
    try {
      if (fs.statSync(path.join(dir, 'claude-code-sessions')).isDirectory()) out.push(dir)
    } catch {
      /* not there */
    }
  }
  const local = process.env.LOCALAPPDATA
  if (local) {
    try {
      for (const d of fs.readdirSync(path.join(local, 'Claude-Data'), { withFileTypes: true })) if (d.isDirectory()) add(path.join(local, 'Claude-Data', d.name))
    } catch {
      /* no such folder on this computer */
    }
  }
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'Claude'))
  add(path.join(os.homedir(), 'Library', 'Application Support', 'Claude'))
  add(path.join(os.homedir(), '.config', 'Claude'))
  return out
}

/** Claude Code names a conversation's folder after the folder it ran in, with everything but letters and digits as dashes. */
const slug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** Every account folder on this computer that has Claude Code conversations in it. */
function configDirs(): string[] {
  const home = os.homedir()
  const out: string[] = []
  try {
    for (const n of fs.readdirSync(home)) {
      if (!/^\.claude(-[\w.-]+)?$/.test(n)) continue
      const dir = path.join(home, n)
      if (fs.existsSync(path.join(dir, 'projects'))) out.push(dir)
    }
  } catch {
    /* unreadable home */
  }
  // The account Claude Code itself uses comes first.
  return out.sort((a, b) => Number(path.basename(b) === '.claude') - Number(path.basename(a) === '.claude'))
}

function allFiles(dir: string, depth: number, out: string[] = []): string[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0) allFiles(full, depth - 1, out)
    } else if (/^local_[\w-]+\.json$/.test(e.name)) out.push(full)
  }
  return out
}

export function scanClaudeCode(): Found {
  const roots = appRoots()
  if (!roots.length) return { found: false, sections: [], loose: [] }
  const dirs = configDirs()
  const sections = new Map<string, FoundSection>()
  const order: string[] = []
  const loose: FoundSession[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    const prefs = readJson<{ preferences?: { epitaxyPrefs?: Record<string, Record<string, GroupScope> | undefined> } }>(path.join(root, 'claude_desktop_config.json'), {})
    const scopes = prefs.preferences?.epitaxyPrefs?.['dframe-group-scopes'] || {}
    const groupOf = new Map<string, string>()
    for (const scope of Object.values(scopes)) {
      for (const g of scope?.groups || []) {
        if (!g?.id || !g.name || sections.has(g.id)) continue
        sections.set(g.id, { id: g.id, name: g.name, sessions: [] })
        order.push(g.id)
      }
      for (const [key, groupId] of Object.entries(scope?.assignments || {})) groupOf.set(key.replace(/^[a-z]+:/, ''), groupId)
    }

    for (const file of allFiles(path.join(root, 'claude-code-sessions'), 3)) {
      const s = readJson<SessionFile>(file, {})
      if (!s.sessionId || s.isArchived || seen.has(s.sessionId)) continue
      seen.add(s.sessionId)
      const places = [s.cwd, s.originCwd].filter((p): p is string => !!p)
      let transcript: FoundSession['transcript']
      let cwd = places[0] || os.homedir()
      // The conversation is resumable from the folder its file is filed under, so that is the folder to work in.
      find: for (const configDir of dirs) {
        for (const p of places) {
          const f = path.join(configDir, 'projects', slug(p), `${s.cliSessionId}.jsonl`)
          if (s.cliSessionId && fs.existsSync(f)) {
            transcript = { file: f, configDir }
            cwd = p
            break find
          }
        }
      }
      const session: FoundSession = {
        id: s.sessionId,
        cliSessionId: s.cliSessionId,
        title: (s.title || '').trim() || path.basename(cwd) || 'Untitled',
        cwd,
        createdAt: s.createdAt || 0,
        updatedAt: s.lastActivityAt || s.createdAt || 0,
        transcript,
      }
      const section = sections.get(groupOf.get(s.sessionId) || '')
      if (section) section.sessions.push(session)
      else loose.push(session)
    }
  }
  const recent = (a: FoundSession, b: FoundSession): number => b.updatedAt - a.updatedAt
  return {
    found: true,
    sections: order.map((id) => sections.get(id) as FoundSection).map((sec) => ({ ...sec, sessions: sec.sessions.sort(recent) })),
    loose: loose.sort(recent),
  }
}

// ───────────── turning a conversation into chat rows ─────────────

/** Conversation files run to hundreds of megabytes; the recent end is what a chat needs. */
const TAIL_BYTES = 28 * 1024 * 1024
/** Lines that are not part of the conversation (request records) can be enormous. They are skipped unread. */
const MAX_LINE = 400_000
const MAX_ROWS = 360

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Reads a file's lines from near the end, without holding the whole file in memory. */
function tailLines(file: string, each: (line: string) => void): void {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    let pos = Math.max(0, size - TAIL_BYTES)
    // Starting in the middle of a line: that first piece is thrown away.
    let skipFirst = pos > 0
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let carry: Buffer[] = []
    let carried = 0
    let dropping = false
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      pos += n
      let from = 0
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 10) continue
        if (!dropping && !skipFirst) {
          const piece = buf.subarray(from, i)
          each((carried ? Buffer.concat([...carry, piece]) : piece).toString('utf8'))
        }
        skipFirst = false
        dropping = false
        carry = []
        carried = 0
        from = i + 1
      }
      if (from < n && !dropping) {
        // The line carries on into the next read. One that is already too long is let go.
        if (carried + (n - from) > MAX_LINE) {
          dropping = true
          carry = []
          carried = 0
        } else {
          carry.push(Buffer.from(buf.subarray(from, n)))
          carried += n - from
        }
      }
    }
    if (carried && !dropping && !skipFirst) each(Buffer.concat(carry).toString('utf8'))
  } finally {
    fs.closeSync(fd)
  }
}

/** Things the app writes into a conversation for the model, which the person never typed. */
const NOT_SAID = /^\s*(<(system-reminder|command-name|command-message|local-command-stdout|local-command-caveat|task-notification|ci-monitor-event|side-sessions-event|user-prompt-submit-hook)\b|Caveat: |\[Request interrupted)/

function clean(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>|<\/pasted_content[^>]*>/g, '')
    .trim()
}

function smallInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v.length > 400 ? `${v.slice(0, 400)}…` : v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (k === 'todos' && Array.isArray(v)) out[k] = v
  }
  return out
}

/** The recent part of a Claude Code conversation as chat rows: what was said, and the steps taken in between. */
export function importTranscript(file: string): Item[] {
  let rows: Item[] = []
  try {
    tailLines(file, (line) => {
      // Cheap test first: most lines are records of requests, not conversation.
      if (line.length > MAX_LINE || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) return
      let e: { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } }
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta) return
      const ts = Date.parse(e.timestamp || '') || Date.now()
      const content = e.message?.content
      if (e.type === 'user') {
        const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Record<string, unknown>[]).filter((b) => b.type === 'text').map((b) => str(b.text)).join('\n') : ''
        if (!text.trim() || NOT_SAID.test(text)) return
        const said = clean(text)
        if (said) rows.push({ id: uid('u'), kind: 'user', ts, text: said.length > 12000 ? `${said.slice(0, 12000)}…` : said })
        return
      }
      if (!Array.isArray(content)) return
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === 'text' && str(b.text).trim()) {
          const text = str(b.text).trim()
          rows.push({ id: uid('a'), kind: 'assistant', ts, text: text.length > 20000 ? `${text.slice(0, 20000)}…` : text })
        } else if (b.type === 'tool_use' && str(b.name)) {
          rows.push({ id: uid('t'), kind: 'tool', ts, name: str(b.name), input: smallInput(b.input), status: 'done' })
        }
      }
      if (rows.length > MAX_ROWS * 2) rows = rows.slice(-MAX_ROWS)
    })
  } catch {
    /* an unreadable conversation comes in as a chat with no history */
  }
  rows = rows.slice(-MAX_ROWS)
  // Begin at something the person said, so the first thing on screen makes sense.
  const first = rows.findIndex((r) => r.kind === 'user')
  return first > 0 ? rows.slice(first) : rows
}
