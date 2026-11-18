// How the Team view reads a crowd: the lead on top, the other accounts, then the agents the
// lead started in groups (Scouts, Builders, Judges...), and right after any agent that started
// helpers of its own, a group of those helpers. Inside a group the ones that need you come
// first, then the busy ones; the finished ones fold away at the end.

import type { Account, AgentState, Task } from '@shared/types'
import { groupAgents } from '../ultra/groups'

export type Status = 'needs' | 'working' | 'problem' | 'queued' | 'free' | 'done' | 'gone' | 'off'

export const RANK: Record<Status, number> = { needs: 0, problem: 1, working: 2, queued: 3, free: 4, off: 5, done: 6, gone: 7 }

/** Finished: folded away at the end of its group. */
export const isFinished = (s: Status): boolean => s === 'done' || s === 'gone'

export const LABEL: Record<Status, string> = {
  needs: 'Needs you',
  working: 'Working',
  problem: 'Problem',
  queued: 'Queued',
  free: 'Free',
  off: 'Signed out',
  done: 'Done',
  gone: 'Sent home',
}

/** The task an agent is on, or else the last one it was given. */
export function taskOf(a: Account, st: AgentState | undefined, tasks: Task[]): Task | undefined {
  if (st?.taskId) {
    const t = tasks.find((x) => x.id === st.taskId)
    if (t) return t
  }
  let last: Task | undefined
  for (const t of tasks) if (t.to === a.id && (!last || t.createdAt >= last.createdAt)) last = t
  return last
}

export function statusOf(a: Account, st: AgentState | undefined, task: Task | undefined, signedOut: boolean): Status {
  if (a.spawned?.gone) return 'gone'
  if (signedOut) return 'off'
  if (st?.phase === 'waiting') return 'needs'
  if (st && st.phase !== 'idle' && st.phase !== 'error') return 'working'
  if (st?.phase === 'error') return 'problem'
  if (task?.status === 'running') return 'working'
  if (task?.status === 'queued') return 'queued'
  if (task?.status === 'failed' || task?.status === 'interrupted') return 'problem'
  // The accounts are never "done": they stay on the team.
  if (task?.status === 'done' && a.spawned) return 'done'
  return 'free'
}

/** Names in a short phrase: "Scout 1", "Scout 1 and Scout 2", "Scout 1, Scout 2 and Judge", or "5 agents". */
export function nameList(names: string[]): string {
  const n = [...new Set(names.filter(Boolean))]
  if (n.length <= 1) return n[0] || ''
  if (n.length > 3) return `${n.length} agents`
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

/**
 * Who a task waits for (`which` 'waiting'), or was lined up after (`which` 'after'), in plain words.
 * The engine says it itself (waitingFor, afterFor); for a task from before it did, the names come
 * from whoever those tasks went to. Never a task id: when nobody can be named, it is empty.
 */
export function waitsFor(task: Task | undefined, which: 'waiting' | 'after', tasks: Task[], nameOf: (id: string) => string | undefined): string {
  if (!task) return ''
  const ids = which === 'waiting' ? task.waitingOn : task.after
  if (!ids?.length) return ''
  const said = which === 'waiting' ? task.waitingFor : task.afterFor
  if (said) return said
  return nameList(ids.map((id) => tasks.find((t) => t.id === id)).map((t) => (t ? nameOf(t.to) || '' : '')))
}

export interface Section {
  key: string
  label: string
  /** For a group of helpers: who started them. */
  parent?: Account
  members: Account[]
}

/**
 * Splits everyone but the lead into sections, in reading order. `statusFor` gives each
 * member's status, which only orders the members inside a section.
 */
export function sections(team: Account[], leadId: string | undefined, statusFor: (a: Account) => Status): Section[] {
  const ids = new Set(team.map((a) => a.id))
  const others = team.filter((a) => a.id !== leadId)
  const accounts = others.filter((a) => !a.spawned)
  // Started by the lead, or by someone no longer on the team: these belong to the lead's crowd.
  const top = others.filter((a) => a.spawned && (a.spawned.by === leadId || !ids.has(a.spawned.by)))
  const helpers = others.filter((a) => a.spawned && a.spawned.by !== leadId && ids.has(a.spawned.by))

  const order = new Map(team.map((a, i) => [a.id, i]))
  const sort = (list: Account[]): Account[] => [...list].sort((x, y) => RANK[statusFor(x)] - RANK[statusFor(y)] || (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0))

  const out: Section[] = []
  if (accounts.length) out.push({ key: 'accounts', label: 'Teammates', members: sort(accounts) })
  const { singles, groups } = groupAgents(top)
  // Groups and the leftover agents keep the order they joined in, which is the order of the work.
  const blocks: { at: number; s: Section }[] = groups.map((g) => ({ at: order.get(g.members[0].id) ?? 0, s: { key: g.key, label: g.label, members: sort(g.members) } }))
  if (singles.length) blocks.push({ at: order.get(singles[0].id) ?? 0, s: { key: 'agents', label: groups.length ? 'Other agents' : 'Agents', members: sort(singles) } })
  blocks.sort((x, y) => x.at - y.at)
  out.push(...blocks.map((b) => b.s))

  // Groups with something going on come before groups where nothing is (keeping their order otherwise).
  const active = (sec: Section): boolean => sec.members.some((m) => RANK[statusFor(m)] <= RANK.queued)
  const ranked = out.map((sec, i) => ({ sec, i })).sort((x, y) => Number(active(y.sec)) - Number(active(x.sec)) || x.i - y.i)
  out.splice(0, out.length, ...ranked.map((r) => r.sec))

  // Each set of helpers goes right after the section of whoever started them (and after any helpers placed there before).
  const byParent = new Map<string, Account[]>()
  for (const h of helpers) byParent.set(h.spawned!.by, [...(byParent.get(h.spawned!.by) || []), h])
  let left = [...byParent.keys()]
  for (let guard = 0; left.length && guard < 6; guard++) {
    const next: string[] = []
    for (const pid of left) {
      const at = out.findIndex((s) => s.members.some((m) => m.id === pid))
      if (at < 0) {
        next.push(pid)
        continue
      }
      let i = at + 1
      while (i < out.length && out[i].parent) i++
      const parent = team.find((a) => a.id === pid)!
      out.splice(i, 0, { key: `by:${pid}`, label: `Started by ${parent.name}`, parent, members: sort(byParent.get(pid)!) })
    }
    if (next.length === left.length) break
    left = next
  }
  // Anyone whose starter is somehow not placed still gets a place.
  for (const pid of left) {
    const parent = team.find((a) => a.id === pid)
    out.push({ key: `by:${pid}`, label: `Started by ${parent?.name || 'a teammate'}`, parent, members: sort(byParent.get(pid)!) })
  }
  return out
}

/**
 * Columns for a section: never more than fit, and spread so the rows are as even as they can be
 * (8 cards in room for 5 make two rows of 4, not 5 and 3).
 */
export function columnsFor(count: number, fit: number): number {
  if (count <= 0) return 1
  const rows = Math.ceil(count / Math.max(1, fit))
  return Math.min(fit, Math.ceil(count / rows))
}
