import path from 'node:path'
import type { ModelRecord } from '@shared/types'
import { TIER_ORDER, type Tier } from '@shared/budget'
import { readJson, writeJson } from './util'

// What the team has learned about its models: how often each finished the tasks it was
// given, and what whoever handed the task out thought of the result. The cascade of models
// (strongest for the lead, cheaper further down) leans on it: a model that keeps falling
// short is no longer handed that kind of work, and one that is always more than enough is
// replaced by a cheaper one.

/** Model families by the words in their names, with the tier each one belongs to. */
const FAMILIES: { name: string; match: RegExp; tier: Tier }[] = [
  { name: 'Fable', match: /fable/i, tier: 'top' },
  { name: 'Mythos', match: /mythos/i, tier: 'top' },
  { name: 'Astra', match: /astra/i, tier: 'top' },
  { name: 'Opus', match: /opus/i, tier: 'strong' },
  { name: 'Sol', match: /(^|[^a-z])sol([^a-z]|$)/i, tier: 'strong' },
  { name: 'Sonnet', match: /sonnet/i, tier: 'mid' },
  { name: 'Haiku', match: /haiku/i, tier: 'light' },
  { name: 'Luna', match: /luna/i, tier: 'light' },
]

export const familyOf = (model: string | undefined | null): { name: string; tier: Tier } | null => (model ? FAMILIES.find((f) => f.match.test(model)) || null : null)

export type Verdict = 'enough' | 'too_weak' | 'more_than_needed'

/** Kinds of work, told apart by the words a task is described with. The first that matches wins. */
const KINDS: { kind: string; label: string; match: RegExp }[] = [
  // A plain chore says so with its first word, whatever it is done to: "Rename the image files" is routine, not media.
  { kind: 'routine', label: 'routine jobs', match: /^\s*(rename|move|extract|list|format|convert|collect|sort|count|download|copy|clean up|tidy)\b/i },
  { kind: 'review', label: 'reviews and checks', match: /\b(review|audit|verify|check(ing)?|critique|second opinion|qa)\b/i },
  { kind: 'media', label: 'images, sound and video', match: /\b(image|illustration|picture|photo|logo|icon|svg|draw|voice|audio|sound|music|video|clip|render)\b/i },
  { kind: 'research', label: 'research', match: /\b(research|find out|look up|investigate|compare|survey|sources?|market|competitor)\b/i },
  { kind: 'code', label: 'code', match: /\b(build|implement|fix|bug|refactor|code|endpoint|api|component|page|function|test(s)?|migrat\w*|deploy|script)\b/i },
  { kind: 'writing', label: 'writing', match: /\b(write|draft|summar\w*|translate|copy|chapter|article|post|email|docs?|readme|report)\b/i },
]

/** What kind of work a task is: its title says it best, and the start of its brief settles the rest. */
export function kindOf(title: string, brief = ''): string {
  const pick = (t: string): string | undefined => KINDS.find((k) => k.match.test(t))?.kind
  // A brief's first word is not a chore's first word, so the brief is only read for its subject.
  return pick(title) || pick(` ${brief.slice(0, 400)}`) || 'other'
}

export const kindLabel = (kind: string | undefined): string => KINDS.find((k) => k.kind === kind)?.label || 'other work'

export class Learning {
  private file: string
  private data: Record<string, ModelRecord>

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'learning.json')
    this.data = readJson<Record<string, ModelRecord>>(this.file, {})
  }

  private rec(model: string | undefined | null): ModelRecord | null {
    const f = familyOf(model)
    if (!f) return null
    return (this.data[f.name] ||= { family: f.name, tier: f.tier, done: 0, failed: 0, enough: 0, weak: 0, more: 0, updatedAt: 0 })
  }

  private save(): void {
    writeJson(this.file, this.data)
  }

  /** A task ended. Only real outcomes count: a stop by the user or a usage limit says nothing about the model. */
  outcome(model: string | undefined | null, ok: boolean): void {
    const r = this.rec(model)
    if (!r) return
    if (ok) r.done++
    else r.failed++
    r.updatedAt = Date.now()
    this.save()
  }

  /** Whoever handed a task out said whether the model was right for it. */
  vote(model: string | undefined | null, verdict: Verdict, kind?: string): string | null {
    const r = this.rec(model)
    if (!r) return null
    if (verdict === 'enough') r.enough++
    else if (verdict === 'too_weak') r.weak++
    else r.more++
    if (kind) {
      const k = ((r.kinds ||= {})[kind] ||= { enough: 0, weak: 0, more: 0 })
      if (verdict === 'enough') k.enough++
      else if (verdict === 'too_weak') k.weak++
      else k.more++
    }
    r.updatedAt = Date.now()
    this.save()
    return r.family
  }

  list(): ModelRecord[] {
    return Object.values(this.data).sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
  }

  reset(): void {
    this.data = {}
    this.save()
  }

  /**
   * Which way experience says to move from a tier: 1 means use a stronger model than the
   * plan says (this one keeps falling short), -1 a cheaper one (it is always more than enough).
   */
  shift(tier: Tier, kind?: string): -1 | 0 | 1 {
    const rs = Object.values(this.data).filter((r) => r.tier === tier)
    // Experience with this kind of work comes first, once there is enough of it.
    if (kind) {
      const k = (key: 'enough' | 'weak' | 'more'): number => rs.reduce((n, r) => n + (r.kinds?.[kind]?.[key] || 0), 0)
      const votes = k('enough') + k('weak') + k('more')
      if (votes >= 3) {
        if (k('weak') / votes >= 0.34) return 1
        if (votes >= 4 && k('more') / votes >= 0.5 && k('weak') === 0) return -1
        return 0
      }
    }
    const sum = (k: 'done' | 'failed' | 'enough' | 'weak' | 'more'): number => rs.reduce((n, r) => n + r[k], 0)
    const votes = sum('enough') + sum('weak') + sum('more')
    const runs = sum('done') + sum('failed')
    if ((votes >= 3 && sum('weak') / votes >= 0.34) || (runs >= 5 && sum('failed') / runs >= 0.3)) return 1
    if (votes >= 4 && sum('more') / votes >= 0.5 && sum('weak') === 0) return -1
    return 0
  }

  /** One line per model, for the agents that choose models: what has worked so far. */
  summary(): string {
    const lines = this.list()
      .filter((r) => r.done + r.failed + r.enough + r.weak + r.more > 0)
      .map((r) => {
        const verdicts = [r.enough && `${r.enough} enough`, r.weak && `${r.weak} too weak`, r.more && `${r.more} more than needed`].filter(Boolean).join(', ')
        const byKind = Object.entries(r.kinds || {})
          .map(([k, v]) => {
            const n = v.enough + v.weak + v.more
            if (n < 2) return ''
            return v.weak / n >= 0.34 ? `too weak for ${kindLabel(k)}` : v.more / n >= 0.5 ? `more than needed for ${kindLabel(k)}` : v.enough / n >= 0.6 ? `right for ${kindLabel(k)}` : ''
          })
          .filter(Boolean)
        return `- ${r.family}: finished ${r.done} of ${r.done + r.failed} tasks${verdicts ? `; rated ${verdicts}` : ''}${byKind.length ? ` (${byKind.join('; ')})` : ''}`
      })
    return lines.join('\n')
  }
}
