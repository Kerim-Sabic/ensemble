import { memo, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowUpRight, Check, CircleDashed, CornerDownRight, FolderOpen, ListChecks, ShieldQuestion, Sparkles, Square, SquarePen } from 'lucide-react'
import type { Account, AgentState, Chat, Item, Task } from '@shared/types'
import { adviseModel, budgetOf, hoursLabel, modelForTier, type WindowBudget } from '@shared/budget'
import { agentKey, isBusy, leadOf, teamOf, useAccounts, useStore, type Step } from '@/store'
import { accentVars, api, cn, duration, folderLabel, prettyModel, relative } from '@/lib/util'
import { compactNumber, planFrom } from '@/lib/derive'
import { Button, Tip } from './ui'
import { Orb, PaceChip } from './Orb'
import { useElapsed } from './chat/Cards'

const EMPTY: Item[] = []
const NO_TASKS: Task[] = []
const NO_STEPS: Step[] = []

/** How one account's allowance stands, and what the app is running on it because of that. */
function AllowanceCard({ account, lead }: { account: Account; lead: boolean }) {
  const usage = useStore((s) => s.usage[account.id])
  const status = useStore((s) => s.statuses[account.id])
  const smart = useStore((s) => s.settings.smartModels)
  const setModal = useStore((s) => s.setModal)
  // Everything running on this account's sign-in, in any chat.
  const working = useStore((s) => Object.values(s.agents).filter((a) => isBusy(a) && (a.accountId === account.id || s.members[a.accountId]?.spawned?.base === account.id)).length)
  const budget = useMemo(() => budgetOf(usage), [usage])
  const advice = smart && account.provider === 'claude' && !account.model ? adviseModel(budget, lead ? 'lead' : 'worker') : null
  const out = status?.state === 'signed-out'
  const bar = (label: string, w: WindowBudget | undefined) => (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-ink-3">{label}</span>
        <span className="tabular shrink-0 text-ink-2">{w ? `${Math.round(w.left * 100)}%${w.hours !== null ? ` · ${hoursLabel(w.hours)}` : ''}` : '–'}</span>
      </div>
      <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-line">
        {w && (
          <div
            className={cn('h-full rounded-full transition-[width] duration-700 ease-out', w.pace === 'spend' ? 'bg-ok' : w.pace === 'save' ? 'bg-warn' : w.pace === 'out' ? 'bg-bad' : 'bg-ink-3')}
            style={{ width: `${Math.max(w.left * 100, 2)}%` }}
          />
        )}
      </div>
    </div>
  )
  // The model that advice comes to on this account, by name.
  const tier = advice ? modelForTier(status?.models || [], advice.tier)?.label || (advice.tier === 'top' ? budget.top?.label || 'its strongest model' : advice.tier === 'strong' ? 'the next model down' : 'its everyday model') : null
  return (
    <button
      onClick={() => setModal({ kind: 'account', id: account.id })}
      style={accentVars(account.accent)}
      className="flex w-[232px] shrink-0 flex-col rounded-[14px] bg-surface px-3.5 py-3 text-left shadow-card transition-shadow hover:shadow-float"
    >
      <div className="flex items-center gap-2">
        <Orb account={account} size={20} live={working > 0} off={out} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{account.name}</span>
        {lead && <span className="text-[10.5px] text-ink-3">Lead</span>}
        {working > 0 && <span className="tabular rounded-full bg-[var(--a-soft)] px-1.5 py-px text-[10.5px] font-medium text-[var(--a2)]">{working} working</span>}
      </div>
      {out ? (
        <div className="mt-3 text-[12px] text-warn">Signed out</div>
      ) : (
        <>
          <div className="mt-2.5 space-y-2">
            {bar('This session', budget.session)}
            {bar('This week', budget.weekly)}
            {budget.top && bar(`${budget.top.label} this week`, budget.top)}
          </div>
          <div className="mt-2.5 flex min-h-[18px] items-center gap-1.5 text-[11px]">
            {budget.weekly && <PaceChip pace={budget.top && budget.top.pace !== 'steady' ? budget.top.pace : budget.weekly.pace} />}
            {tier ? (
              <Tip side="bottom" label={`${advice?.why}.`}>
                <span className="flex min-w-0 items-center gap-1 text-ink-3">
                  <Sparkles className="size-3 shrink-0" strokeWidth={1.9} />
                  <span className="truncate">
                    Runs {tier}
                    {advice?.effort ? ', high effort' : ''}
                  </span>
                </span>
              </Tip>
            ) : account.model ? (
              <span className="truncate text-ink-3">Set to {status?.models?.find((m) => m.value === account.model)?.label || account.model}</span>
            ) : null}
          </div>
        </>
      )}
    </button>
  )
}

/** One agent at work: what it is doing now, the last few things it did, and what it was asked. */
const AgentCard = memo(function AgentCard({ chatId, account, lead, by, onOpen }: { chatId: string; account: Account; lead: boolean; by?: Account; onOpen(accountId: string): void }) {
  const k = agentKey(chatId, account.id)
  const st = useStore((s): AgentState | undefined => s.agents[k])
  const trail = useStore((s) => s.trail[k] ?? NO_STEPS)
  const task = useStore((s) => (st?.taskId ? (s.tasks[chatId] ?? NO_TASKS).find((t) => t.id === st.taskId) : undefined))
  const busy = isBusy(st)
  const waiting = st?.phase === 'waiting'
  const elapsed = useElapsed(busy ? st?.turnStartedAt : undefined)
  const earlier = trail.slice(0, -1).slice(-3)
  return (
    <button
      onClick={() => onOpen(account.id)}
      style={accentVars(account.accent)}
      className={cn(
        'group/a flex min-w-0 flex-col rounded-[13px] bg-surface-2 px-3 py-2.5 text-left transition-shadow',
        busy ? 'shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--a2)_38%,var(--line))]' : 'shadow-[inset_0_0_0_1px_var(--line)]',
        waiting && 'bg-warn-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_35%,transparent)]',
      )}
    >
      <div className="flex w-full items-center gap-2">
        <Orb account={account} size={account.spawned ? 18 : 22} phase={st?.phase} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[12.5px] font-semibold">{account.name}</span>
            {lead && <span className="text-[10.5px] text-ink-3">Lead</span>}
            {by && (
              <span className="flex min-w-0 items-center gap-0.5 text-[10.5px] text-ink-4">
                <CornerDownRight className="size-2.5 shrink-0" />
                <span className="truncate">{by.name}</span>
              </span>
            )}
          </span>
        </span>
        {busy && !waiting && <span className="tabular shrink-0 text-[10.5px] text-ink-4">{duration(elapsed)}</span>}
        <ArrowUpRight className="size-3 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/a:opacity-100" />
      </div>
      {(task || account.spawned) && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <ListChecks className="size-3 shrink-0 text-ink-4" strokeWidth={1.9} />
          <span className="truncate">{task ? task.title : account.role}</span>
        </div>
      )}
      <div className="mt-1.5 min-h-[17px] text-[12px] leading-[17px]">
        {waiting ? (
          <span className="flex items-center gap-1 font-medium text-warn">
            <ShieldQuestion className="size-3.5" /> {st?.activity || 'Needs your OK'}
          </span>
        ) : busy ? (
          <span className="shimmer-text block truncate">{st?.activity || 'Working'}</span>
        ) : st?.phase === 'error' ? (
          <span className="text-bad">Stopped with a problem</span>
        ) : (
          <span className="text-ink-4">Free</span>
        )}
      </div>
      {busy && earlier.length > 0 && (
        <ol className="mt-1 space-y-px border-l border-line-2 pl-2">
          {earlier.map((s, i) => (
            <li key={`${s.ts}-${i}`} className="flex items-center gap-1.5 text-[11px] leading-[16px] text-ink-3">
              <Check className="size-2.5 shrink-0 text-ink-4" strokeWidth={3} />
              <span className="truncate">{s.text}</span>
            </li>
          ))}
        </ol>
      )}
      {busy && (
        <div className="mt-2 flex items-center gap-2 text-[10.5px] text-ink-4">
          <span className="min-w-0 flex-1 truncate">{prettyModel(st?.model) || (account.provider === 'chatgpt' ? 'ChatGPT' : '')}</span>
          {!!st?.steps && (
            <span className="tabular shrink-0">
              {st.steps} {st.steps === 1 ? 'step' : 'steps'}
            </span>
          )}
          {st?.context && <span className="tabular shrink-0">{compactNumber(st.context.used)} in memory</span>}
        </div>
      )}
    </button>
  )
})

/** A chat the team is working in: its plan, and everyone who is busy there. */
function ChatCard({ chat, accounts, leadId }: { chat: Chat; accounts: Account[]; leadId: string | undefined }) {
  const openChat = useStore((s) => s.openChat)
  const setView = useStore((s) => s.setView)
  const ensureLoaded = useStore((s) => s.ensureLoaded)
  const home = useStore((s) => s.env.home)
  const folder = useStore((s) => s.folders.find((f) => f.id === chat.folderId)?.name)
  const lead = chat.leadId || leadId
  const team = useMemo(() => teamOf(accounts, lead, chat.agents), [accounts, lead, chat.agents])
  // Who is busy here, as a string, so the card redraws when that changes and not on every word.
  const sig = useStore((s) => team.map((a) => (isBusy(s.agents[agentKey(chat.id, a.id)]) ? a.id : '')).join('|'))
  const tasks = useStore((s) => s.tasks[chat.id] ?? NO_TASKS)
  const leadItems = useStore((s) => (lead ? s.items[agentKey(chat.id, lead)] : undefined) ?? EMPTY)
  // When the longest-running reply here began; 0 when nobody is at work.
  const started = useStore((s) => {
    let first = 0
    for (const a of team) {
      const st = s.agents[agentKey(chat.id, a.id)]
      if (isBusy(st) && st?.turnStartedAt && (!first || st.turnStartedAt < first)) first = st.turnStartedAt
    }
    return first
  })
  const elapsed = useElapsed(started || undefined)

  // The plan and the tasks live in the chat's own records: read them without opening the chat.
  useEffect(() => {
    void ensureLoaded(chat.id).catch(() => undefined)
  }, [chat.id, ensureLoaded])

  const working = useMemo(() => {
    const on = new Set(sig.split('|').filter(Boolean))
    return team.filter((a) => on.has(a.id))
  }, [sig, team])
  const plan = useMemo(() => planFrom(leadItems), [leadItems])
  const done = plan.filter((p) => p.status === 'completed').length
  const current = plan.find((p) => p.status === 'in_progress')
  const open = tasks.filter((t) => t.status === 'running' || t.status === 'queued')
  const finished = tasks.filter((t) => t.status === 'done').length
  const byId = useMemo(() => new Map(team.map((a) => [a.id, a])), [team])

  const go = (accountId?: string, view: 'chat' | 'flow' = 'chat'): void => {
    void openChat(chat.id, accountId).then(() => setView(view))
  }

  return (
    <section className="flex min-w-0 flex-col rounded-[18px] bg-surface p-3.5 shadow-card">
      <header className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <button onClick={() => go()} className="block max-w-full truncate text-left text-[14px] font-semibold tracking-[-0.01em] hover:underline">
            {chat.title}
          </button>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <FolderOpen className="size-3 shrink-0" />
            <span className="truncate">
              {folder ? `${folder} · ` : ''}
              {folderLabel(chat.cwd, home)}
            </span>
            {working.length > 0 && <span className="tabular shrink-0 text-ink-4">· {duration(elapsed)}</span>}
          </div>
        </div>
        <Tip label="See the team map for this chat" side="top">
          <button onClick={() => go(undefined, 'flow')} className="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
            Team map
          </button>
        </Tip>
        {working.length > 0 && (
          <Tip label="Stop everyone in this chat" side="top">
            <button onClick={() => void api.stop(chat.id)} aria-label="Stop everyone in this chat" className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-3 hover:bg-hover hover:text-ink">
              <Square className="size-2.5 fill-current" strokeWidth={0} />
            </button>
          </Tip>
        )}
      </header>

      {plan.length > 0 && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
            <span className={cn('min-w-0 truncate', current ? 'text-ink-2' : 'text-ink-3')}>{current ? current.active || current.text : done === plan.length ? 'Plan finished' : 'Plan'}</span>
            <span className="tabular shrink-0 text-ink-3">
              {done} of {plan.length}
            </span>
          </div>
          <div className="mt-1.5 flex gap-[3px]">
            {plan.map((p, i) => (
              <span key={i} className={cn('h-[5px] flex-1 rounded-full', p.status === 'completed' ? 'bg-ok' : p.status === 'in_progress' ? 'animate-pulse-soft bg-ink-2' : 'bg-line-2')} />
            ))}
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
          {open.length > 0 && (
            <span className="flex items-center gap-1">
              <CircleDashed className="size-3" /> {open.length} {open.length === 1 ? 'task' : 'tasks'} out
            </span>
          )}
          {finished > 0 && (
            <span className="flex items-center gap-1">
              <Check className="size-3 text-ok" strokeWidth={2.75} /> {finished} done
            </span>
          )}
        </div>
      )}

      <div className={cn('mt-3 grid gap-2', working.length > 1 ? 'grid-cols-[repeat(auto-fill,minmax(210px,1fr))]' : 'grid-cols-1')}>
        {working.map((a) => (
          <AgentCard key={a.id} chatId={chat.id} account={a} lead={a.id === lead} by={a.spawned ? byId.get(a.spawned.by) : undefined} onOpen={(id) => go(id)} />
        ))}
        {!working.length && (
          <button onClick={() => go()} className="flex items-center gap-2 rounded-[11px] px-2.5 py-2 text-left text-[12px] text-ink-3 shadow-[inset_0_0_0_1px_var(--line)] hover:bg-hover hover:text-ink">
            <span className="min-w-0 flex-1 truncate">{chat.snippet || 'Nobody is working here right now.'}</span>
            <span className="tabular shrink-0 text-[11px] text-ink-4">{relative(chat.updatedAt)}</span>
          </button>
        )}
      </div>
    </section>
  )
}

/** Mission control: every chat the team is working in right now, and how each account's allowance stands. */
export function NowView() {
  const chats = useStore((s) => s.chats)
  const accounts = useStore((s) => s.accounts)
  const team = useAccounts()
  const leadId = useStore((s) => leadOf(s, null, true)?.id)
  const newChat = useStore((s) => s.newChat)
  // Which chats have anyone at work, as a string: the page redraws when that set changes.
  const liveSig = useStore((s) => {
    const ids = new Set<string>()
    for (const a of Object.values(s.agents)) if (isBusy(a)) ids.add(a.chatId)
    return [...ids].sort().join('|')
  })
  const counts = useStore((s) => {
    let working = 0
    let waiting = 0
    for (const a of Object.values(s.agents)) {
      if (!isBusy(a)) continue
      working++
      if (a.phase === 'waiting') waiting++
    }
    return `${working}:${waiting}`
  })
  const [working, waiting] = counts.split(':').map(Number)
  // A chat stays on the board for a while after it goes quiet, so a finished one does not vanish from under you.
  const [seen, setSeen] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!liveSig) return
    const now = Date.now()
    setSeen((s) => ({ ...s, ...Object.fromEntries(liveSig.split('|').map((id) => [id, now])) }))
  }, [liveSig])

  const { live, recent } = useMemo(() => {
    const on = new Set(liveSig.split('|').filter(Boolean))
    const live = chats.filter((c) => on.has(c.id))
    const recent = chats.filter((c) => !on.has(c.id) && (seen[c.id] || Date.now() - c.updatedAt < 45 * 60 * 1000)).slice(0, 6)
    return { live, recent }
  }, [chats, liveSig, seen])

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="mx-auto w-full max-w-[1240px] px-6 pt-6 pb-10">
        <div className="flex items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.025em]">{working ? `${working} ${working === 1 ? 'agent is' : 'agents are'} working` : 'Nobody is working right now'}</h1>
            <p className="mt-1 text-[13px] text-ink-2">
              {working
                ? `Across ${live.length} ${live.length === 1 ? 'chat' : 'chats'}${waiting ? `. ${waiting} ${waiting === 1 ? 'is' : 'are'} waiting for your OK` : ''}. Every chat runs on its own, so you can start another while these carry on.`
                : 'Start a chat and it shows up here. Several chats can run at the same time, each with its own team.'}
            </p>
          </div>
          <Button variant="primary" onClick={() => newChat()}>
            <SquarePen className="size-3.5" /> New chat
          </Button>
        </div>

        <div className="mt-5 flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {team.map((a) => (
            <AllowanceCard key={a.id} account={a} lead={a.id === leadId} />
          ))}
        </div>

        {live.length > 0 && (
          <div className={cn('mt-6 grid gap-3', live.length > 1 ? 'xl:grid-cols-2' : 'grid-cols-1')}>
            {live.map((c) => (
              <ChatCard key={c.id} chat={c} accounts={accounts} leadId={leadId} />
            ))}
          </div>
        )}

        {recent.length > 0 && (
          <>
            <div className="mt-7 mb-2 flex items-center gap-2 text-[12px] font-medium text-ink-3">
              <Activity className="size-3.5" strokeWidth={1.9} /> Recently
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {recent.map((c) => (
                <ChatCard key={c.id} chat={c} accounts={accounts} leadId={leadId} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
