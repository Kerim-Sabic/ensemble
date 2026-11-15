// Things the screen works out from what the agents did: the lead's plan, and
// which files each teammate touched.

import type { Item, ScreenKind } from '@shared/types'

export interface PlanStep {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-tense wording for the step while it is under way. */
  active?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const STATUS = new Set(['pending', 'in_progress', 'completed'])
const status = (v: unknown): PlanStep['status'] => (STATUS.has(str(v)) ? (v as PlanStep['status']) : 'pending')

/**
 * The checklist an agent is keeping, read from its plan tools. Agents either
 * rewrite the whole list each time or add and tick off steps one by one.
 */
export function planFrom(items: Item[]): PlanStep[] {
  let list: PlanStep[] = []
  let byId = new Map<string, PlanStep>()
  let seq = 0
  let lastAt = -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'tool') continue
    const inp = (it.input && typeof it.input === 'object' ? it.input : {}) as Record<string, unknown>
    if ((it.name === 'TodoWrite' || it.name === 'Todo') && Array.isArray(inp.todos)) {
      list = (inp.todos as Record<string, unknown>[]).map((t) => ({ text: str(t.content), status: status(t.status), active: str(t.activeForm) || undefined })).filter((t) => t.text)
      byId = new Map()
      lastAt = i
    } else if (it.name === 'TaskCreate' && str(inp.subject)) {
      const id = /#(\d+)/.exec(it.output || '')?.[1] || String(++seq)
      const step: PlanStep = { text: str(inp.subject), status: 'pending', active: str(inp.activeForm) || undefined }
      byId.set(id, step)
      list = [...list, step]
      lastAt = i
    } else if (it.name === 'TaskUpdate' && str(inp.taskId)) {
      const step = byId.get(str(inp.taskId))
      if (!step) continue
      if (inp.status === 'deleted') list = list.filter((x) => x !== step)
      else if (inp.status) step.status = status(inp.status)
      if (str(inp.subject)) step.text = str(inp.subject)
      lastAt = i
    }
  }
  // A finished plan from an earlier request is history, not the plan.
  if (list.length && list.every((s) => s.status === 'completed')) {
    for (let i = lastAt + 1; i < items.length; i++) if (items[i].kind === 'user') return []
  }
  return list
}

export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Absolute paths of the files an agent created or edited, most recent last. */
export function touchedFiles(items: Item[]): { path: string; ts: number }[] {
  const out = new Map<string, { path: string; ts: number }>()
  for (const it of items) {
    if (it.kind !== 'tool' || it.status === 'error') continue
    const inp = (it.input && typeof it.input === 'object' ? it.input : {}) as Record<string, unknown>
    const paths: string[] = []
    if (it.name === 'Edit' || it.name === 'Write' || it.name === 'MultiEdit' || it.name === 'NotebookEdit') {
      const p = str(inp.file_path) || str(inp.notebook_path)
      if (p) paths.push(p)
    } else if (it.name === 'FileChange' && Array.isArray(inp.changes)) {
      for (const c of inp.changes as Record<string, unknown>[]) if (str(c.path)) paths.push(str(c.path))
    }
    for (const p of paths) {
      const k = normPath(p)
      out.delete(k)
      out.set(k, { path: p, ts: it.ts })
    }
  }
  return [...out.values()]
}

/** Whether a path an agent used and a path git reported are the same file. */
export function samePath(absolute: string, relative: string): boolean {
  const a = normPath(absolute)
  const r = normPath(relative)
  return a === r || a.endsWith(`/${r}`)
}

export function splitPath(p: string): { dir: string; name: string } {
  const clean = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = clean.lastIndexOf('/')
  return i < 0 ? { dir: '', name: clean } : { dir: clean.slice(0, i), name: clean.slice(i + 1) }
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export type ScreenItem = Extract<Item, { kind: 'screen' }>

/** Everything an agent did in its browser or on the computer in a chat, oldest first. */
export function screenSteps(items: Item[], surface: ScreenKind): ScreenItem[] {
  const out: ScreenItem[] = []
  for (const it of items) if (it.kind === 'screen' && it.surface === surface) out.push(it)
  return out
}

export interface NoteTouch {
  /** Relative to the vault, forward slashes. */
  path: string
  how: 'read' | 'wrote'
  ts: number
}

/** The vault notes an agent read or wrote, most recent last. A note that was written stays marked as written. */
export function vaultTouches(items: Item[], vaultPath: string): NoteTouch[] {
  const base = normPath(vaultPath)
  const out = new Map<string, NoteTouch>()
  const add = (raw: string, how: NoteTouch['how'], ts: number): void => {
    let p = raw.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim().replace(/\\/g, '/')
    if (!p) return
    const lower = p.toLowerCase()
    if (/^([a-z]:)?\//.test(lower)) {
      if (!lower.startsWith(`${base}/`)) return
      p = p.slice(base.length + 1)
    }
    if (p.split('/').some((seg) => seg.startsWith('.'))) return
    if (!/\.md$/i.test(p)) {
      // Something that is not a note (an image, a canvas) is not listed; a bare title is.
      if (/\.[a-z0-9]{1,5}$/i.test(p)) return
      p += '.md'
    }
    const k = p.toLowerCase()
    const had = out.get(k)
    out.delete(k)
    out.set(k, { path: p, how: had?.how === 'wrote' ? 'wrote' : how, ts })
  }
  for (const it of items) {
    if (it.kind !== 'tool' || it.status === 'error') continue
    const inp = (it.input && typeof it.input === 'object' ? it.input : {}) as Record<string, unknown>
    if (it.name === 'mcp__team__vault_save') add(str(inp.path), 'wrote', it.ts)
    else if (it.name === 'mcp__team__vault_read') add(str(inp.note), 'read', it.ts)
    else if (it.name === 'Edit' || it.name === 'Write' || it.name === 'MultiEdit') add(str(inp.file_path), 'wrote', it.ts)
    else if (it.name === 'Read') add(str(inp.file_path), 'read', it.ts)
    else if (it.name === 'FileChange' && Array.isArray(inp.changes)) for (const c of inp.changes as Record<string, unknown>[]) add(str(c.path), 'wrote', it.ts)
  }
  return [...out.values()]
}
