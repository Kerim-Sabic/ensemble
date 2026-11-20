// Looks at folders for the first-run screen: a folder's top-level names and whether it is a git
// repository, the app's own folder for a first task when none was chosen, and recent projects that
// Claude Code or Codex already worked in. Read only (apart from making the app's own folder), and
// only a little of each, so it is quick on any computer.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appFolder, pathKey, unsafeFolder, type FirstFolders, type FolderProbe, type RecentProject } from '@shared/firstrun'

const MAX = 400

export async function folderProbe(dir: string | null | undefined): Promise<FolderProbe> {
  const p = dir ? path.resolve(String(dir)) : ''
  const name = p ? path.basename(p) || p : ''
  if (!p) return { path: '', name: '', entries: [], git: false, missing: true }
  try {
    const list = await fs.promises.readdir(p, { withFileTypes: true })
    const entries = list.slice(0, MAX).map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
    return { path: p, name, entries, git: list.some((d) => d.name === '.git') }
  } catch {
    return { path: p, name, entries: [], git: false, missing: true }
  }
}

/** A small file in the app's own folder, so a folder of the same name the person made is never taken over. */
const MARK = '.ensemble-folder'

const isEmptyOrOurs = (dir: string): boolean => {
  try {
    const names = fs.readdirSync(dir)
    return names.length === 0 || names.includes(MARK)
  } catch {
    return false
  }
}

/** Where the app's own folder is, or will be: "Ensemble" in Documents, or "Ensemble 2" when that name is someone else's. */
export function appFolderPath(home: string, documents: string): string {
  const first = appFolder(home, documents)
  for (let n = 1; n < 50; n++) {
    const dir = n === 1 ? first : `${first} ${n}`
    if (!fs.existsSync(dir) || isEmptyOrOurs(dir)) return dir
  }
  return first
}

/** Makes the app's own folder (at the first task, not before) and returns it. */
export function makeAppFolder(home: string, documents: string): string {
  const dir = appFolderPath(home, documents)
  fs.mkdirSync(dir, { recursive: true })
  const mark = path.join(dir, MARK)
  if (!fs.existsSync(mark)) fs.writeFileSync(mark, 'Made by Ensemble for work that does not belong to a project.\n', 'utf8')
  return dir
}

/** The first few KB of a file: enough for the header line of a session log. */
async function head(file: string, bytes = 65536): Promise<string> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

const mtime = async (p: string): Promise<number> => (await fs.promises.stat(p).catch(() => null))?.mtimeMs || 0

/** Folders Claude Code worked in, from its own list (~/.claude.json), each dated by its session folder. */
async function claudeFolders(home: string): Promise<{ path: string; at: number }[]> {
  const file = path.join(home, '.claude.json')
  const size = (await fs.promises.stat(file).catch(() => null))?.size || 0
  if (!size || size > 30 * 1024 * 1024) return []
  let projects: Record<string, unknown> = {}
  try {
    projects = (JSON.parse(await fs.promises.readFile(file, 'utf8')) as { projects?: Record<string, unknown> }).projects || {}
  } catch {
    return []
  }
  const out: { path: string; at: number }[] = []
  for (const p of Object.keys(projects).slice(0, 300)) {
    // Claude Code keeps each folder's sessions under ~/.claude/projects, named after the path.
    const at = await mtime(path.join(home, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-')))
    out.push({ path: path.resolve(p), at })
  }
  return out
}

/** Folders Codex worked in, from the header line of its newest session logs (~/.codex/sessions/yyyy/mm/dd). */
async function codexFolders(home: string): Promise<{ path: string; at: number }[]> {
  const root = path.join(home, '.codex', 'sessions')
  const files: string[] = []
  const down = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= 40) return
    const names = (await fs.promises.readdir(dir).catch(() => [] as string[])).sort().reverse()
    for (const n of names) {
      if (files.length >= 40) return
      if (depth < 3) await down(path.join(dir, n), depth + 1)
      else if (n.endsWith('.jsonl')) files.push(path.join(dir, n))
    }
  }
  await down(root, 0)
  const out: { path: string; at: number }[] = []
  for (const f of files) {
    try {
      const line = (await head(f)).split('\n')[0]
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line)
      if (m) out.push({ path: path.resolve(JSON.parse(`"${m[1]}"`) as string), at: await mtime(f) })
    } catch {
      /* an unreadable log is skipped */
    }
  }
  return out
}

/**
 * Up to four git projects this person worked on lately with Claude Code or Codex, newest first.
 * Never the home folder, a personal folder itself, a drive root, a worktree or anything in temp.
 */
export async function recentProjects(home: string, limit = 4, skipUnder: string = os.tmpdir()): Promise<RecentProject[]> {
  const found = [...(await claudeFolders(home).catch(() => [])), ...(await codexFolders(home).catch(() => []))]
  const best = new Map<string, { path: string; at: number }>()
  for (const f of found) {
    const k = pathKey(f.path)
    const had = best.get(k)
    if (!had || f.at > had.at) best.set(k, f)
  }
  const tmp = skipUnder ? pathKey(skipUnder) : ''
  const out: RecentProject[] = []
  const sorted = [...best.values()].sort((a, b) => b.at - a.at)
  for (const f of sorted.slice(0, 60)) {
    if (out.length >= limit) break
    const k = pathKey(f.path)
    if (unsafeFolder(f.path, home) || (tmp && (k === tmp || k.startsWith(`${tmp}/`)))) continue
    // A real repository: its .git is a folder. A worktree's or a submodule's is a file, and those are
    // mostly short-lived copies made by agents.
    if (!(await fs.promises.stat(path.join(f.path, '.git')).catch(() => null))?.isDirectory()) continue
    out.push({ path: f.path, name: path.basename(f.path), at: f.at || (await mtime(path.join(f.path, '.git'))) })
  }
  return out
}

/** Everything the first-run screen needs to offer a folder. Writes nothing. */
export async function firstFolders(home: string, documents: string): Promise<FirstFolders> {
  return { app: appFolderPath(home, documents), recent: await recentProjects(home).catch(() => []) }
}
