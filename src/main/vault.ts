import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { VaultHit, VaultInfo, VaultNote } from '@shared/types'
import { readJson } from './util'

// The knowledge vault: a folder of Markdown notes (an Obsidian vault, usually)
// that the team reads before it works and writes what it learns into. Nothing
// here is Obsidian-specific beyond understanding [[links]] and frontmatter.

interface Entry {
  rel: string
  abs: string
  mtime: number
  title: string
  /** Lowercased text of the note, frontmatter included. */
  lower: string
  /** Where the body starts in the original text. */
  bodyAt: number
  text: string
  type?: string
  status?: string
  updated?: string
  aliases: string[]
  headings: string[]
  /** Lowercased link targets, without extension. */
  links: Set<string>
}

const MAX_INDEXED = 600_000
const SKIP_DIR = /^(\.|node_modules$)/
const GUIDES = ['AGENTS.md', 'CLAUDE.md']

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
const noExt = (p: string): string => p.replace(/\.md$/i, '')
const baseOf = (p: string): string => noExt(p.slice(p.lastIndexOf('/') + 1))

function frontmatter(text: string): { fields: Record<string, string | string[]>; end: number } {
  const fields: Record<string, string | string[]> = {}
  if (!text.startsWith('---')) return { fields, end: 0 }
  const close = text.indexOf('\n---', 3)
  if (close < 0) return { fields, end: 0 }
  let key = ''
  for (const raw of text.slice(3, close).split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item && key) {
      const list = Array.isArray(fields[key]) ? (fields[key] as string[]) : []
      list.push(item[1].trim().replace(/^["']|["']$/g, ''))
      fields[key] = list
      continue
    }
    const kv = /^([A-Za-z_][\w -]*):\s*(.*)$/.exec(raw)
    if (!kv) continue
    key = kv[1].trim().toLowerCase()
    const v = kv[2].trim()
    if (!v) fields[key] = []
    else if (v.startsWith('[') && v.endsWith(']')) fields[key] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    else fields[key] = v.replace(/^["']|["']$/g, '')
  }
  const after = text.indexOf('\n', close + 1)
  return { fields, end: after < 0 ? text.length : after + 1 }
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined
const many = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : [])

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\\?\|[^\]]*)?\]\]/g

function count(hay: string, needle: string, cap: number): number {
  let n = 0
  let at = 0
  while (n < cap) {
    at = hay.indexOf(needle, at)
    if (at < 0) break
    n++
    at += needle.length
  }
  return n
}

export class Vault {
  readonly root: string
  private entries = new Map<string, Entry>()
  private scannedAt = 0
  private watcher: fs.FSWatcher | null = null
  /** Notes the system says changed since the index was last brought up to date. */
  private changed = new Set<string>()
  /** A folder was renamed, moved or removed: individual changes no longer tell the whole story. */
  private reshaped = false
  private rereading = false

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  get name(): string {
    return path.basename(this.root)
  }

  get exists(): boolean {
    try {
      return fs.statSync(this.root).isDirectory()
    } catch {
      return false
    }
  }

  /** The vault's own instructions for agents, when it has them. */
  get guide(): string | undefined {
    return GUIDES.find((g) => fs.existsSync(path.join(this.root, g)))
  }

  info(): VaultInfo {
    // Counting files is quick; reading them all is left to warm() or the first search.
    return { path: this.root, name: this.name, notes: this.warmed ? this.entries.size : this.files().length, guide: this.guide }
  }

  private warmed = false

  /** Every note in the vault, as paths relative to its root. Reads folder listings only. */
  private files(): string[] {
    const out: string[] = []
    const walk = (dir: string, rel: string, depth: number): void => {
      let list: fs.Dirent[]
      try {
        list = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const d of list) {
        const r = rel ? `${rel}/${d.name}` : d.name
        if (d.isDirectory()) {
          if (!SKIP_DIR.test(d.name) && depth < 12) walk(path.join(dir, d.name), r, depth + 1)
        } else if (d.isFile() && /\.md$/i.test(d.name)) out.push(r)
      }
    }
    walk(this.root, '', 0)
    return out
  }

  /** Reads the whole vault into the index a little at a time, so nothing else has to wait for it. */
  async warm(): Promise<void> {
    if (this.rereading) return
    this.rereading = true
    try {
      this.follow()
      const all = this.files()
      const seen = new Set(all)
      for (let i = 0; i < all.length; i += 30) {
        for (const r of all.slice(i, i + 30)) this.index(r)
        await new Promise((r) => setImmediate(r))
      }
      for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k)
      this.warmed = true
      this.scannedAt = Date.now()
    } finally {
      this.rereading = false
    }
  }

  /** Has the system tell us which notes change, so nobody has to go and look at all of them. */
  private follow(): void {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, name) => {
        if (!name) return
        const rel = norm(String(name))
        if (rel.split('/').some((seg) => SKIP_DIR.test(seg))) return
        if (/\.md$/i.test(rel)) this.changed.add(rel)
        // Anything without an extension is most likely a folder being renamed, moved or removed.
        else if (!/\.[a-z0-9]{1,8}$/i.test(rel)) this.reshaped = true
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      this.watcher = null
    }
  }

  /** Ensemble wrote this note itself: index it now rather than wait to hear of it. */
  noted(rel: string): void {
    this.changed.add(norm(rel))
    this.scannedAt = 0
    if (this.warmed && this.watcher) return
    this.index(norm(rel))
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /** Brings the index up to date. Only notes that changed are read again. */
  private scan(force = false): void {
    if (this.warmed && this.watcher && !force) {
      for (const rel of this.changed) this.index(rel)
      this.changed.clear()
      // A reshuffle of folders is sorted out in the background; until then the index is slightly behind.
      if (this.reshaped) {
        this.reshaped = false
        void this.warm()
      }
      return
    }
    // Without a watcher, look at everything, but not more than every so often.
    if (!force && Date.now() - this.scannedAt < 15000) return
    this.scannedAt = Date.now()
    const seen = new Set(this.files())
    for (const r of seen) this.index(r)
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k)
    this.warmed = true
  }

  private index(rel: string): void {
    const abs = path.join(this.root, rel)
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      this.entries.delete(rel)
      return
    }
    const had = this.entries.get(rel)
    if (had && had.mtime === st.mtimeMs) return
    let text = ''
    try {
      text = st.size > MAX_INDEXED ? fs.readFileSync(abs, 'utf8').slice(0, MAX_INDEXED) : fs.readFileSync(abs, 'utf8')
    } catch {
      return
    }
    text = text.replace(/^﻿/, '')
    const fm = frontmatter(text)
    const headings: string[] = []
    for (const m of text.slice(fm.end).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) headings.push(m[1].toLowerCase())
    const links = new Set<string>()
    for (const m of text.matchAll(LINK)) links.add(noExt(norm(m[1].trim())).toLowerCase())
    this.entries.set(rel, {
      rel,
      abs,
      mtime: st.mtimeMs,
      title: one(fm.fields.title) || baseOf(rel),
      lower: text.toLowerCase(),
      bodyAt: fm.end,
      text,
      type: one(fm.fields.type),
      status: one(fm.fields.status),
      updated: one(fm.fields.updated),
      aliases: many(fm.fields.aliases).map((a) => a.toLowerCase()),
      headings,
      links,
    })
  }

  private hit(e: Entry, terms: string[]): VaultHit {
    const body = e.text.slice(e.bodyAt)
    const lower = e.lower.slice(e.bodyAt)
    let at = -1
    for (const t of terms) {
      at = lower.indexOf(t)
      if (at >= 0) break
    }
    const from = Math.max(0, at < 0 ? 0 : at - 90)
    const plain = body
      .slice(from, from + 320)
      .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\\?\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => alias || target.split('/').pop() || target)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(#{1,6}|>|[-*+])\s+/gm, '')
      .replace(/\[![a-z]+\][+-]?/gi, '')
      .replace(/[*_`]{1,3}/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const snippet = (from > 0 ? '…' : '') + plain.slice(0, 220) + (body.length > from + 220 ? '…' : '')
    const slash = e.rel.lastIndexOf('/')
    return { path: e.rel, title: e.title, folder: slash < 0 ? '' : e.rel.slice(0, slash), type: e.type, status: e.status, updated: e.updated, snippet }
  }

  search(query: string, opts: { folder?: string; limit?: number } = {}): VaultHit[] {
    this.scan()
    const q = query.toLowerCase().trim()
    const terms = q.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, '')).filter((t) => t.length > 1 || /\d/.test(t))
    const folder = opts.folder ? norm(opts.folder).toLowerCase() : ''
    // Nothing to look for: show what changed most recently instead.
    if (!terms.length) {
      return [...this.entries.values()]
        .filter((e) => !folder || e.rel.toLowerCase().startsWith(`${folder}/`))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, Math.max(1, Math.min(opts.limit ?? 8, 25)))
        .map((e) => this.hit(e, []))
    }
    const scored: { e: Entry; score: number; all: boolean }[] = []
    for (const e of this.entries.values()) {
      const relLower = e.rel.toLowerCase()
      if (folder && !relLower.startsWith(`${folder}/`)) continue
      const title = e.title.toLowerCase()
      let score = 0
      let all = true
      for (const t of terms) {
        let s = 0
        if (title.includes(t)) s += 12
        if (e.aliases.some((a) => a.includes(t))) s += 9
        if (e.headings.some((h) => h.includes(t))) s += 5
        if (relLower.includes(t)) s += 3
        s += count(e.lower, t, 8)
        if (!s) all = false
        score += s
      }
      if (!score) continue
      if (title === q || e.aliases.includes(q)) score += 20
      else if (terms.length > 1 && e.lower.includes(q)) score += 6
      scored.push({ e, score, all })
    }
    // Notes that mention every word come first; if none do, any word will do.
    const strict = scored.filter((x) => x.all)
    const pool = strict.length ? strict : scored
    return pool
      .sort((a, b) => b.score - a.score || b.e.mtime - a.e.mtime)
      .slice(0, Math.max(1, Math.min(opts.limit ?? 8, 25)))
      .map((x) => this.hit(x.e, terms))
  }

  /** Turns a path, a title or a [[link]] into the notes it could mean. */
  resolve(ref: string): string[] {
    this.scan()
    let r = ref.trim().replace(/^\[\[|\]\]$/g, '')
    r = r.split('|')[0].split('#')[0].trim()
    if (path.isAbsolute(r)) {
      const relative = path.relative(this.root, r)
      if (relative.startsWith('..') || path.isAbsolute(relative)) return []
      r = relative
    }
    r = noExt(norm(r)).toLowerCase()
    if (!r) return []
    const exact = [...this.entries.keys()].filter((k) => noExt(k).toLowerCase() === r)
    if (exact.length) return exact
    const base = r.slice(r.lastIndexOf('/') + 1)
    const byName = [...this.entries.values()].filter((e) => baseOf(e.rel).toLowerCase() === base || e.aliases.includes(base)).map((e) => e.rel)
    if (byName.length) return byName
    return [...this.entries.values()]
      .filter((e) => e.title.toLowerCase().includes(base))
      .sort((a, b) => a.title.length - b.title.length)
      .slice(0, 6)
      .map((e) => e.rel)
  }

  read(rel: string, fromLine = 1, maxChars = 24000): VaultNote | null {
    this.scan()
    this.index(rel)
    const e = this.entries.get(rel)
    if (!e) return null
    let text: string
    try {
      text = fs.readFileSync(e.abs, 'utf8').replace(/^﻿/, '')
    } catch {
      return null
    }
    const lines = text.split(/\r?\n/)
    const start = Math.max(0, Math.min(lines.length, fromLine - 1))
    let out = ''
    let i = start
    for (; i < lines.length && out.length + lines[i].length < maxChars; i++) out += `${lines[i]}\n`
    const truncated = i < lines.length
    if (truncated) out += `\n… ${lines.length - i} more lines. Read on from line ${i + 1}.`
    const self = noExt(rel).toLowerCase()
    const base = baseOf(rel).toLowerCase()
    const backlinks: string[] = []
    for (const other of this.entries.values()) {
      if (other.rel === rel) continue
      if (other.links.has(self) || other.links.has(base)) backlinks.push(other.rel)
      if (backlinks.length >= 40) break
    }
    return { path: rel, title: e.title, content: out, truncated, links: [...e.links].slice(0, 40), backlinks, mtime: e.mtime }
  }

  /** The note about a working folder's project, when the vault has one. */
  projectNote(cwd: string): string | null {
    this.scan()
    const name = path.basename(cwd).toLowerCase().replace(/[-_]+/g, ' ')
    if (!name || name.length < 3) return null
    const hits = [...this.entries.values()].filter((e) => baseOf(e.rel).toLowerCase().replace(/[-_]+/g, ' ') === name || e.aliases.includes(name))
    if (!hits.length) return null
    return (hits.find((e) => /^projects?\//i.test(e.rel)) || hits[0]).rel
  }

  /** Where a relative note path lands on disk, or an error for paths the team must not write. */
  private target(input: string): { rel: string; abs: string } {
    let r = input.trim()
    if (path.isAbsolute(r)) {
      const relative = path.relative(this.root, r)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('That path is outside the vault.')
      r = relative
    }
    r = norm(r)
    if (!r || r.split('/').some((seg) => seg === '..' || seg === '')) throw new Error('Give a path inside the vault, such as "Projects/My app.md".')
    if (r.split('/').some((seg) => seg.startsWith('.'))) throw new Error("Folders that start with a dot hold the vault's own settings and are not for notes.")
    if (/[<>:"|?*]/.test(r)) throw new Error('That name has characters Windows does not allow in file names.')
    if (!/\.md$/i.test(r)) r += '.md'
    return { rel: r, abs: path.join(this.root, r) }
  }

  private write(abs: string, text: string): void {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    // Obsidian may have the note open: write beside it and swap, so it never sees half a file.
    const tmp = `${abs}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, abs)
  }

  save(input: { path: string; content: string; mode: 'create' | 'append' | 'section'; heading?: string }): { path: string; created: boolean } {
    const { rel, abs } = this.target(input.path)
    const content = input.content.replace(/\r\n/g, '\n').trim()
    if (!content) throw new Error('There is nothing to write.')
    const exists = fs.existsSync(abs)
    if (input.mode === 'create') {
      if (exists) throw new Error(`${rel} already exists. Read it, then add to it with mode "append" or "section", or edit it directly.`)
      this.write(abs, `${content}\n`)
      this.scannedAt = 0
      this.changed.add(rel)
      return { path: rel, created: true }
    }
    if (!exists) throw new Error(`${rel} does not exist yet. Use mode "create", and search first in case the note lives under another name.`)
    let text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)
    if (input.mode === 'section') {
      const want = (input.heading || '').replace(/^#+\s*/, '').trim().toLowerCase()
      if (!want) throw new Error('Say which heading the text goes under.')
      const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').replace(/\s*#*\s*$/, '').toLowerCase() === want)
      if (at < 0) {
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
        lines.push('', `## ${(input.heading || '').replace(/^#+\s*/, '').trim()}`, '', ...content.split('\n'), '')
      } else {
        const level = /^#+/.exec(lines[at])?.[0].length || 2
        let end = lines.length
        for (let i = at + 1; i < lines.length; i++) {
          const m = /^(#{1,6})\s/.exec(lines[i])
          if (m && m[1].length <= level) {
            end = i
            break
          }
        }
        while (end > at + 1 && !lines[end - 1].trim()) end--
        lines.splice(end, 0, ...(end > at + 1 ? [''] : []), ...content.split('\n'), '')
      }
    } else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
      lines.push('', ...content.split('\n'), '')
    }
    // A note that tracks when it last changed is kept honest.
    if (lines[0] === '---') {
      const close = lines.indexOf('---', 1)
      for (let i = 1; i < close; i++) {
        if (/^updated:\s*\d{4}-\d{2}-\d{2}\s*$/.test(lines[i])) lines[i] = `updated: ${new Date().toLocaleDateString('sv-SE')}`
      }
    }
    text = lines.join(eol)
    this.write(abs, text)
    this.scannedAt = 0
    this.changed.add(rel)
    return { path: rel, created: false }
  }

  absolute(rel: string): string {
    return path.join(this.root, norm(rel))
  }
}

/** Obsidian keeps a list of the vaults it has opened; the open one comes first. */
export function detectVaults(): VaultInfo[] {
  const files = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'obsidian', 'obsidian.json') : '',
    path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
    path.join(os.homedir(), '.config', 'obsidian', 'obsidian.json'),
  ].filter(Boolean)
  const out: (VaultInfo & { open: boolean; ts: number })[] = []
  for (const f of files) {
    const cfg = readJson<{ vaults?: Record<string, { path?: string; ts?: number; open?: boolean }> }>(f, {})
    for (const v of Object.values(cfg.vaults || {})) {
      if (!v.path || out.some((o) => o.path.toLowerCase() === v.path?.toLowerCase())) continue
      const vault = new Vault(v.path)
      if (!vault.exists) continue
      out.push({ path: vault.root, name: vault.name, notes: 0, guide: vault.guide, open: !!v.open, ts: v.ts || 0 })
    }
  }
  return out.sort((a, b) => Number(b.open) - Number(a.open) || b.ts - a.ts).map(({ open: _open, ts: _ts, ...v }) => v)
}
