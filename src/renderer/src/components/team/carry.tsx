// What each account's sign-in carries in a chat: the agents started there that run on it, and how
// many of them are at work. With several accounts, this is how the window shows that the whole team
// is working, not only the lead. Also: why an account is getting no new work, in plain words.

import { useMemo } from 'react'
import type { Account } from '@shared/types'
import { supplyNow, supplyWords } from '@shared/failover'
import { agentKey, isBusy, useStore } from '@/store'
import { accentVars, cn } from '@/lib/util'
import { Tip } from '../ui'
import { Orb } from '../Orb'

export interface Carry {
  /** Agents of this chat running on this sign-in, sent-home ones left out. */
  agents: number
  /** Of those, how many are at work now. */
  working: number
}

const NONE: Carry = { agents: 0, working: 0 }
const NO_AGENTS: Account[] = []

/** Per account id, what its sign-in carries in this chat. Redraws only when a count changes. */
export function useCarried(chatId: string | null | undefined): Map<string, Carry> {
  const sig = useStore((s) => {
    if (!chatId) return ''
    const agents = s.chats.find((c) => c.id === chatId)?.agents ?? NO_AGENTS
    const m = new Map<string, Carry>()
    for (const a of agents) {
      if (!a.spawned || a.spawned.gone) continue
      const c = m.get(a.spawned.base) || { agents: 0, working: 0 }
      c.agents++
      if (isBusy(s.agents[agentKey(chatId, a.id)])) c.working++
      m.set(a.spawned.base, c)
    }
    return [...m].map(([id, c]) => `${id}:${c.agents}:${c.working}`).join('|')
  })
  return useMemo(() => {
    const m = new Map<string, Carry>()
    for (const part of sig ? sig.split('|') : []) {
      const [id, n, w] = part.split(':')
      m.set(id, { agents: Number(n), working: Number(w) })
    }
    return m
  }, [sig])
}

export const carryOf = (m: Map<string, Carry>, id: string): Carry => m.get(id) || NONE

/** "5 agents on this account · 3 working", "1 agent on this account". */
export function carryLine(c: Carry): string {
  const n = `${c.agents} ${c.agents === 1 ? 'agent' : 'agents'} on this account`
  return c.working ? `${n} · ${c.working} working` : n
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Why an account is not getting new work, or empty when it can take work. `long` is for a card:
 * "Signed out", "Out of usage until 01:47", "Nearly out of usage, used last until 01:47" (it takes new work only when no other account can). `short`
 * is for a chip: "Signed out", "Out until 01:47", "Running low".
 */
export function useWhyIdle(accountId: string): { long: string; short: string; tone: 'warn' | 'bad' | '' } {
  const signedOut = useStore((s) => s.statuses[accountId]?.state === 'signed-out')
  const sig = useStore((s) => {
    const sup = supplyNow(s.usage[accountId])
    return `${sup.state}:${sup.until || ''}`
  })
  return useMemo(() => {
    if (signedOut) return { long: 'Signed out', short: 'Signed out', tone: 'warn' }
    const [state, until] = sig.split(':')
    const at = until ? Number(until) : null
    if (state === 'out') return { long: at ? `Out of usage until ${clock(at)}` : 'Out of usage', short: supplyWords({ state: 'out', until: at }, clock), tone: 'bad' }
    if (state === 'low') return { long: at ? `Nearly out of usage, used last until ${clock(at)}` : 'Nearly out of usage, used last for now', short: 'Running low', tone: 'warn' }
    return { long: '', short: '', tone: '' }
  }, [signedOut, sig])
}

/** One account in the strip: its face, name, what its sign-in carries now, and any usage trouble. */
function Chip({ chatId, account, carry, lead }: { chatId: string; account: Account; carry: Carry; lead: boolean }) {
  const own = useStore((s) => isBusy(s.agents[agentKey(chatId, account.id)]))
  const why = useWhyIdle(account.id)
  const busy = carry.working > 0 || own
  const tip = [
    `${account.name}${lead ? ', the lead' : ''}`,
    carry.agents ? carryLine(carry) : own ? 'Working on its own task' : 'No agents on this account yet',
    why.long,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <Tip label={<span className="whitespace-pre-line">{tip}</span>} side="bottom">
      <span
        style={accentVars(account.accent)}
        className={cn(
          'flex h-8 max-w-full min-w-0 shrink-0 items-center gap-2 rounded-full pr-3 pl-1.5 text-[12px] whitespace-nowrap shadow-[inset_0_0_0_1px_var(--line)]',
          busy ? 'bg-surface' : 'bg-transparent',
        )}
      >
        <Orb account={account} size={20} live={busy} off={why.short === 'Signed out'} />
        <span className="shrink-0 font-medium">{account.name}</span>
        <span className="tabular shrink-0 text-ink-3">
          {carry.agents ? (
            <>
              {carry.agents}
              {carry.working ? <span className="text-ink-2"> · {carry.working} working</span> : null}
            </>
          ) : own ? (
            <span className="text-ink-2">working</span>
          ) : (
            '0'
          )}
        </span>
        {why.short && <span className={cn('shrink-0 text-[11.5px] font-medium', why.tone === 'bad' ? 'text-bad' : 'text-warn')}>{why.short}</span>}
      </span>
    </Tip>
  )
}

/**
 * At the top of the Team tab once agents have been started (or in Ultra): one chip per account,
 * so it reads at a glance that every account is carrying its share.
 */
export function AccountsStrip({ chatId, team, leadId }: { chatId: string; team: Account[]; leadId?: string }) {
  const carried = useCarried(chatId)
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === chatId)?.ultra)
  const accounts = team.filter((a) => !a.spawned)
  const started = team.some((a) => !!a.spawned)
  if (!accounts.length || (!started && !ultra)) return null
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 px-5 pb-2.5" aria-label="What each account carries">
      <span className="shrink-0 text-[11.5px] font-medium text-ink-3">Accounts</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {accounts.map((a) => (
          <Chip key={a.id} chatId={chatId} account={a} carry={carryOf(carried, a.id)} lead={a.id === leadId} />
        ))}
      </div>
    </div>
  )
}
