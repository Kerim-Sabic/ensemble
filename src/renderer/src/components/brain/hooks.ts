// What the brain view is drawn from, beyond the network itself: whether it is up at all, the
// messages agents send each other directly, the rubric chart if the lead drew one, and the one
// line that says what is happening right now. Everything is read from data the app already has.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Chat, Goal, Item, WorkMode } from '@shared/types'
import { parseBlockCached, type ChartBlock } from '@shared/iui'
import { agentKey, isBusy, leadOf, useStore } from '@/store'

/** Fields the engine is adding (Chat.crazy, Goal.mode); read loosely until they land everywhere. */
type BrainGoal = Goal & { mode?: WorkMode }
type BrainChat = Chat & { crazy?: boolean; goal?: BrainGoal | null }

const LIVE = new Set(['active', 'paused', 'blocked'])
/** Goals this window has seen in the brain view: it stays up between rounds, even if the lead pauses between them. */
const held = new Set<string>()
/** Finished goals whose outcome the user has put away. */
const dismissed = new Set<string>()
/** How long the outcome of a finished goal stays up when nobody puts it away. */
const LINGER = 10 * 60_000

export interface BrainMode {
  /** The brain view is up. */
  on: boolean
  /** It shows how a goal ended (met or stopped) rather than a goal at work. */
  ended: boolean
  goal: BrainGoal | null
  dismiss(): void
}

/**
 * The brain view is up while a chat runs Ultra, goes crazy and works towards a goal, and stays
 * up to show how the goal ended until the user puts it away, sends something new, or ten minutes pass.
 */
export function useBrainMode(chatId: string | null | undefined): BrainMode {
  const chat = useStore((s) => (chatId ? (s.chats.find((c) => c.id === chatId) as BrainChat | undefined) : undefined))
  const leadId = useStore((s) => (chatId ? leadOf(s, chatId)?.id : undefined))
  // When the user last wrote to the lead: a new message after the end puts the outcome away.
  const lastAsk = useStore((s) => {
    if (!chatId || !leadId) return 0
    const items = s.items[agentKey(chatId, leadId)]
    if (!items) return 0
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].ts
    return 0
  })
  const [, bump] = useState(0)
  const goal = chat?.goal || null
  const ultra = !!chat?.ultra
  const live = !!goal && ultra && LIVE.has(goal.status) && (!!chat?.crazy || goal.mode === 'gocrazy' || held.has(goal.id))
  useEffect(() => {
    if (live && goal) held.add(goal.id)
  }, [live, goal])
  const ended =
    !!goal &&
    ultra &&
    !live &&
    (goal.status === 'met' || goal.status === 'stopped') &&
    (held.has(goal.id) || goal.mode === 'gocrazy') &&
    !dismissed.has(goal.id) &&
    !!goal.endedAt &&
    Date.now() - goal.endedAt < LINGER &&
    !(lastAsk > goal.endedAt)
  return {
    on: live || ended,
    ended,
    goal,
    dismiss: () => {
      if (goal) dismissed.add(goal.id)
      bump((n) => n + 1)
    },
  }
}

// ───────────── messages between agents ─────────────

export interface Lateral {
  from: string
  to: string
  ts: number
}

const peerCache = new WeakMap<Item[], string[]>()
/** "from@ts" for each message another agent sent into this conversation, and "@to@ts" for each question it put out. */
function peersIn(items: Item[]): string[] {
  let out = peerCache.get(items)
  if (out) return out
  out = []
  for (const it of items) {
    if (it.kind === 'peer' && it.tag === 'message') out.push(`${it.from}@${it.ts}`)
    else if (it.kind === 'ask') out.push(`>${it.to}@${it.ts}`)
  }
  peerCache.set(items, out)
  return out
}

/** Messages and questions agents of this chat sent each other directly, oldest first. */
export function useLaterals(chatId: string, ids: string[]): Lateral[] {
  const key = ids.join('|')
  const sig = useStore((s) => {
    const bits: string[] = []
    for (const id of key.split('|')) {
      const items = s.items[agentKey(chatId, id)]
      if (!items) continue
      for (const p of peersIn(items)) bits.push(p.startsWith('>') ? `${id}${p}` : `${p.replace('@', `>${id}@`)}`)
    }
    return bits.join('|')
  })
  return useMemo(() => {
    if (!sig) return []
    const out: Lateral[] = []
    for (const b of sig.split('|')) {
      const m = /^(.+?)>(.+?)@(\d+)$/.exec(b)
      if (m) out.push({ from: m[1], to: m[2], ts: Number(m[3]) })
    }
    return out.sort((a, b) => a.ts - b.ts)
  }, [sig])
}

// ───────────── the rubric, when the lead charts it ─────────────

const FENCE = /```ui[^\n]*\n([\s\S]*?)```/g
const RUBRIC = /rubric|score/i
const chartCache = new WeakMap<Item[], ChartBlock | null>()

/** The last chart of rubric scores the lead drew in its replies, or null. Never made up. */
export function useRubricChart(chatId: string, leadId: string | undefined): ChartBlock | null {
  return useStore((s) => {
    if (!leadId) return null
    const items = s.items[agentKey(chatId, leadId)]
    if (!items) return null
    const hit = chartCache.get(items)
    if (hit !== undefined) return hit
    let found: ChartBlock | null = null
    for (let i = items.length - 1; i >= 0 && !found; i--) {
      const it = items[i]
      if (it.kind !== 'assistant' || it.streaming || !it.text.includes('```ui')) continue
      const blocks = [...it.text.matchAll(FENCE)].map((m) => parseBlockCached(m[1])).reverse()
      for (const p of blocks) {
        if (!p.ok || p.block.type !== 'chart') continue
        const b = p.block
        const named = RUBRIC.test(b.title || '') || b.series.some((x) => RUBRIC.test(x.name))
        if (named && (b.kind === 'line' || b.kind === 'area' || b.kind === 'bar') && b.x.length >= 1) {
          found = b
          break
        }
      }
    }
    chartCache.set(items, found)
    return found
  })
}

// ───────────── what is happening right now ─────────────

export interface Now {
  who: Account
  text: string
}

/**
 * The agent whose work changed most recently and what it is doing, in its own words. The line
 * changes at most every couple of seconds, so it can be read while forty agents work.
 */
export function useActivity(chatId: string, team: Account[], hold = 2400): { now: Now | null; busy: number } {
  const sig = useStore((s) =>
    team
      .map((a) => {
        const st = s.agents[agentKey(chatId, a.id)]
        return isBusy(st) ? `${a.id}\t${st?.phase === 'waiting' ? 'Needs your OK' : st?.activity || ''}` : ''
      })
      .filter(Boolean)
      .join('\n'),
  )
  const seen = useRef(new Map<string, { text: string; at: number }>())
  const [shown, setShown] = useState<Now | null>(null)
  const lastSwap = useRef(0)
  const byId = useMemo(() => new Map(team.map((a) => [a.id, a])), [team])
  const busyList = useMemo(
    () =>
      sig
        ? sig.split('\n').map((l) => {
            const [id, text] = l.split('\t')
            return { id, text }
          })
        : [],
    [sig],
  )
  useEffect(() => {
    const now = Date.now()
    const live = new Set(busyList.map((b) => b.id))
    for (const id of [...seen.current.keys()]) if (!live.has(id)) seen.current.delete(id)
    for (const b of busyList) {
      const was = seen.current.get(b.id)
      if (!was || was.text !== b.text) seen.current.set(b.id, { text: b.text, at: now })
    }
    const pick = (): Now | null => {
      let best: { id: string; text: string; at: number } | null = null
      for (const [id, v] of seen.current) if (v.text && (!best || v.at > best.at)) best = { id, ...v }
      const who = best ? byId.get(best.id) : undefined
      return who && best ? { who, text: best.text } : null
    }
    // Nothing on the line yet: say it at once. Otherwise give the last words time to be read.
    const wait = shown ? hold - (now - lastSwap.current) : 0
    if (wait <= 0) {
      lastSwap.current = now
      setShown(pick())
      return
    }
    const t = setTimeout(() => {
      lastSwap.current = Date.now()
      setShown(pick())
    }, wait)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyList, byId, hold])
  return { now: shown, busy: busyList.length }
}
