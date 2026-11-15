import { clsx, type ClassValue } from 'clsx'
import type { CSSProperties } from 'react'
import type { AccentKey, EnsembleApi, PermissionLevel } from '@shared/types'
import { ACCENT } from '@shared/accents'

declare global {
  interface Window {
    ensemble: EnsembleApi
  }
}

export const api = window.ensemble

export const cn = (...v: ClassValue[]): string => clsx(v)

export { ACCENT }

export function accentVars(key: AccentKey | undefined): CSSProperties {
  const a = ACCENT[key || 'slate']
  return {
    ['--a1' as string]: a.from,
    ['--a2' as string]: a.to,
    ['--a-soft' as string]: `color-mix(in oklab, ${a.to} 9%, transparent)`,
    ['--a-line' as string]: `color-mix(in oklab, ${a.to} 28%, transparent)`,
  }
}

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** A short, friendly name for a working folder. */
export function folderLabel(p: string, home: string): string {
  const norm = (s: string): string => s.replace(/[\\/]+$/, '').toLowerCase()
  return home && norm(p) === norm(home) ? 'Home folder' : baseName(p)
}

export function tildify(p: string, home: string): string {
  return home && p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length).replace(/\\/g, '/') : p
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function until(ts: number): string {
  const ms = ts - Date.now()
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${Math.max(1, m)} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function relative(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function dayBucket(ts: number): string {
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= startToday) return 'Today'
  if (ts >= startToday - 86400000) return 'Yesterday'
  if (ts >= startToday - 7 * 86400000) return 'Previous 7 days'
  if (ts >= startToday - 30 * 86400000) return 'Previous 30 days'
  return 'Older'
}

export const PERMISSIONS: { value: PermissionLevel; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Agents check with you before changing files or running commands.' },
  { value: 'edits', label: 'Edit freely', hint: 'File edits go ahead. Commands still need your OK.' },
  { value: 'auto', label: 'Auto', hint: 'Safe actions go ahead. Risky ones are checked with you.' },
  { value: 'full', label: 'Full access', hint: 'Nothing is checked with you. Use only in folders you can afford to lose.' },
]

export const permissionLabel = (p: PermissionLevel): string => PERMISSIONS.find((x) => x.value === p)?.label || p

export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** A web address as people say it: the site, without the scheme or "www". */
export function siteOf(url?: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || 'Local file')
    if (u.protocol === 'about:') return ''
    return u.host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }

/** "Opus 5.5 · High": the model and effort a task was given, when the lead chose them. */
export function runLabel(t: { modelLabel?: string; model?: string; effort?: string }): string {
  return [t.modelLabel || t.model, t.effort ? `${EFFORT_LABEL[t.effort] || t.effort} effort` : ''].filter(Boolean).join(' · ')
}

export function prettyModel(id?: string | null): string {
  if (!id) return ''
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? '.' + m[3] : ''}`
  return id.replace(/^gpt-/, 'GPT-')
}
