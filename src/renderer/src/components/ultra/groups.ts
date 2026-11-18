// Many agents read as a few groups: agents that share a base name ("Scout", "Scout 2", ...)
// or a role are one group, so a chat with twenty-five agents still reads at a glance.

import type { Account } from '@shared/types'

/**
 * "Scout 12" -> "Scout"; "Builder A" -> "Builder"; "Builder A 2" -> "Builder". A trailing number
 * goes first, then a trailing single letter. A name with neither stays as it is.
 */
export function baseName(name: string): string {
  let n = name.trim()
  const num = /^(.*?\S)\s+\d+$/.exec(n)
  if (num) n = num[1]
  const letter = /^(.*?\S)\s+[A-Z]$/.exec(n)
  if (letter) n = letter[1]
  return n
}

/** "Scout" -> "Scouts", "Proxy" -> "Proxies", "Analysis" -> "Analyses". */
export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies'
  if (/is$/i.test(word)) return word.slice(0, -2) + 'es'
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  return word + 's'
}

export interface AgentGroup {
  key: string
  /** "Scouts", or the shared role. */
  label: string
  /** "scout", for sentences: "9 scouts". */
  noun: string
  members: Account[]
}

export interface Grouped {
  /** The accounts on the team and anyone who has no group of their own, in team order. */
  singles: Account[]
  /** Two or more agents that belong together, in the order the first of each appears. */
  groups: AgentGroup[]
}

/**
 * Splits a team into groups. Only agents started in the chat are grouped; the accounts themselves
 * are always shown one by one. `keep` lists ids that must stay on their own (such as the lead).
 */
export function groupAgents(team: Account[], keep: Set<string> = new Set()): Grouped {
  const byName = new Map<string, Account[]>()
  for (const a of team) {
    if (!a.spawned || keep.has(a.id)) continue
    const k = baseName(a.name).toLowerCase()
    byName.set(k, [...(byName.get(k) || []), a])
  }
  const grouped = new Set<string>()
  const groups: AgentGroup[] = []
  for (const [k, list] of byName) {
    if (list.length < 2) continue
    const word = baseName(list[0].name)
    groups.push({ key: `n:${k}`, label: plural(word), noun: word.toLowerCase(), members: list })
    for (const a of list) grouped.add(a.id)
  }
  // Whoever is left may still share a role with others.
  const byRole = new Map<string, Account[]>()
  for (const a of team) {
    if (!a.spawned || keep.has(a.id) || grouped.has(a.id) || !a.role?.trim()) continue
    const k = a.role.trim().toLowerCase()
    byRole.set(k, [...(byRole.get(k) || []), a])
  }
  for (const [k, list] of byRole) {
    if (list.length < 2) continue
    groups.push({ key: `r:${k}`, label: list[0].role!.trim(), noun: 'agent', members: list })
    for (const a of list) grouped.add(a.id)
  }
  // Groups appear where their first member stood in the team.
  const at = new Map(team.map((a, i) => [a.id, i]))
  groups.sort((x, y) => (at.get(x.members[0].id) ?? 0) - (at.get(y.members[0].id) ?? 0))
  return { singles: team.filter((a) => !grouped.has(a.id)), groups }
}

/** "9 scouts and 3 builders", "Claude 3, Hello and 4 scouts". */
export function describe(people: Account[]): string {
  const { singles, groups } = groupAgents(people)
  const bits = [...singles.map((a) => a.name), ...groups.map((g) => (g.noun === 'agent' ? `${g.members.length} agents` : `${g.members.length} ${plural(g.noun)}`))]
  if (bits.length <= 1) return bits[0] || 'the team'
  return `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`
}
