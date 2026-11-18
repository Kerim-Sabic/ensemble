import { memo, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowUpRight, Check, CircleDashed, CornerDownRight, FolderOpen, ListChecks, Maximize2, Pause, Play, Repeat, ShieldQuestion, Sparkles, Square, SquarePen, Target } from 'lucide-react'
import { countdown, goalLine, goalOpen, liveLoops, loopLine } from '@shared/auto'
import type { Account, AgentState, Chat, Item, Task } from '@shared/types'
import { adviseModel, budgetOf, hoursLabel, modelForTier, type WindowBudget } from '@shared/budget'
import { agentKey, isBusy, leadOf, teamOf, useAccounts, useStore, type Step } from '@/store'
import { accentVars, api, cn, duration, folderLabel, prettyModel, relative } from '@/lib/util'
import { compactNumber, planFrom } from '@/lib/derive'
import { Button, IconButton, Tip } from './ui'
import { Orb, OrbStack, PaceChip } from './Orb'
import { useElapsed } from './chat/Cards'
import { useNow } from './auto/shared'
import { plain } from './auto/plain'
import { NeuralNetwork, cardHeight, useNeural } from './ultra/neural/Neural'
import { Bench, NeuralNumbers, openNetwork } from './ultra/neural/NetworkView'
import { UltraGlyph, UltraWord } from './ultra/Ultra'
import { groupAgents, type AgentGroup } from './ultra/groups'

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
      className="flex min-w-0 flex-col rounded-[14px] bg-surface px-3.5 py-3 text-left shadow-card transition-shadow hover:shadow-float"
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
        {busy && !waiting && elapsed >= 1000 && <span className="tabular shrink-0 text-[10.5px] text-ink-4">{duration(elapsed)}</span>}
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

const MAX_CARDS = 8

/** Several agents of one kind at work, as one card: their faces, how many, and what each is doing. */
function GroupCard({ chatId, group, onOpen }: { chatId: string; group: AgentGroup; onOpen(accountId: string): void }) {
  const lines = useStore((s) => group.members.map((a) => s.agents[agentKey(chatId, a.id)]?.activity || 'Working').join('\n'))
  const acts = lines.split('\n')
  const shown = group.members.slice(0, 4)
  return (
    <div className="flex min-w-0 flex-col rounded-[13px] bg-surface-2 px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
      <div className="flex w-full items-center gap-2">
        <OrbStack accounts={group.members.map((a) => ({ ...a, live: false }))} size={18} max={4} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{group.label}</span>
        <span className="tabular shrink-0 text-[11px] text-ink-3">{group.members.length} working</span>
      </div>
      <ul className="mt-1.5 space-y-px">
        {shown.map((a, i) => (
          <li key={a.id}>
            <button onClick={() => onOpen(a.id)} className="flex w-full items-center gap-1.5 rounded-[6px] text-left text-[11.5px] leading-[18px] hover:bg-hover">
              <Orb account={a} size={11} />
              <span className="w-[60px] shrink-0 truncate font-medium text-ink-2">{a.name}</span>
              <span className="shimmer-text min-w-0 flex-1 truncate">{acts[i]}</span>
            </button>
          </li>
        ))}
      </ul>
      {group.members.length > shown.length && <div className="mt-1 text-[11px] text-ink-4">and {group.members.length - shown.length} more</div>}
    </div>
  )
}

/** The team of one chat as a small network, with its numbers and a way into the full view. */
function NetworkCard({ chatId, ultra, onOpen }: { chatId: string; ultra: boolean; onOpen(id: string): void }) {
  const { net } = useNeural(chatId)
  return (
    <div className={cn('group/net relative mt-3 overflow-hidden rounded-[13px] bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]', ultra && 'ux-ultra-frame')}>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <NeuralNumbers chatId={chatId} className="flex-1 text-[11.5px]" />
        <button
          onClick={() => openNetwork(chatId)}
          className="flex h-6 shrink-0 items-center gap-1 rounded-[7px] px-2 text-[11.5px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <Maximize2 className="size-3" /> Open network
        </button>
      </div>
      <NeuralNetwork chatId={chatId} variant="card" height={cardHeight(net)} bg={ultra ? 'var(--surface)' : 'var(--surface-2)'} onOpen={onOpen} />
      <Bench chatId={chatId} onOpen={onOpen} className="px-3 pb-2" />
    </div>
  )
}

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
  // Three or more of a kind at work share one card; past eight cards the rest wait behind a button.
  const [all, setAll] = useState(false)
  const cards = useMemo(() => {
    const { groups } = groupAgents(working, new Set(lead ? [lead] : []))
    const big = groups.filter((g) => g.members.length >= 3)
    const firstOf = new Map(big.map((g) => [g.members[0].id, g]))
    const inBig = new Set(big.flatMap((g) => g.members.map((a) => a.id)))
    const out: { a: Account; group?: AgentGroup }[] = []
    for (const a of working) {
      const g = firstOf.get(a.id)
      if (g) out.push({ a, group: g })
      else if (!inBig.has(a.id)) out.push({ a })
    }
    return out
  }, [working, lead])

  const go = (accountId?: string, view: 'chat' | 'flow' = 'chat'): void => {
    void openChat(chat.id, accountId).then(() => setView(view))
  }

  return (
    <section className="flex min-w-0 flex-col rounded-[18px] bg-surface p-3.5 shadow-card">
      <header className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button onClick={() => go()} className="block min-w-0 truncate text-left text-[14px] font-semibold tracking-[-0.01em] hover:underline">
              {chat.title}
            </button>
            {chat.ultra && (
              <span className="ux-ultra-pill flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px]">
                <UltraGlyph size={11} />
                <UltraWord />
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <FolderOpen className="size-3 shrink-0" />
            <span className="truncate">
              {folder ? `${folder} · ` : ''}
              {folderLabel(chat.cwd, home)}
            </span>
            {working.length > 0 && started > 0 && elapsed >= 1000 && <span className="tabular shrink-0 text-ink-4">· {duration(elapsed)}</span>}
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

      {(chat.ultra || tasks.length > 0 || (chat.agents?.length ?? 0) > 0) && (
        // The team as a network: who works with whom, and the work under way between them.
        <NetworkCard chatId={chat.id} ultra={!!chat.ultra} onOpen={(id) => go(id)} />
      )}

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
        {cards.slice(0, all ? cards.length : MAX_CARDS).map((c) =>
          c.group ? (
            <GroupCard key={c.group.key} chatId={chat.id} group={c.group} onOpen={(id) => go(id)} />
          ) : (
            <AgentCard key={c.a.id} chatId={chat.id} account={c.a} lead={c.a.id === lead} by={c.a.spawned ? byId.get(c.a.spawned.by) : undefined} onOpen={(id) => go(id)} />
          ),
        )}
        {cards.length > MAX_CARDS && (
          <button
            onClick={() => setAll((x) => !x)}
            className="flex min-h-[44px] items-center justify-center rounded-[13px] text-[12px] font-medium text-ink-3 shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:bg-hover hover:text-ink"
          >
            {all ? 'Show fewer' : `${cards.length - MAX_CARDS} more at work`}
          </button>
        )}
        {!working.length && (
          <button onClick={() => go()} className="flex items-center gap-2 rounded-[11px] px-2.5 py-2 text-left text-[12px] text-ink-3 shadow-[inset_0_0_0_1px_var(--line)] hover:bg-hover hover:text-ink">
            <span className="min-w-0 flex-1 truncate">{chat.snippet ? plain(chat.snippet) : 'Nobody is working here right now.'}</span>
            <span className="tabular shrink-0 text-[11px] text-ink-4">{relative(chat.updatedAt)}</span>
          </button>
        )}
      </div>
    </section>
  )
}

/** One chat that is working towards a goal or running loops by itself, with a quick pause. */
function AutopilotRow({ chat, now }: { chat: Chat; now: number }) {
  const openChat = useStore((s) => s.openChat)
  const setView = useStore((s) => s.setView)
  const run = useStore((s) => s.run)
  const [busy, setBusy] = useState(false)
  const goal = goalOpen(chat.goal) ? chat.goal : null
  const loops = liveLoops(chat.loops)
  // Paused means nothing here would go on by itself; one click starts it all again.
  const running = (goal && goal.status === 'active') || loops.some((l) => l.status === 'active')
  const toggle = async (): Promise<void> => {
    setBusy(true)
    const jobs: Promise<unknown>[] = []
    if (goal && running && goal.status === 'active') jobs.push(api.goalAction(chat.id, 'pause'))
    if (goal && !running && (goal.status === 'paused' || goal.status === 'blocked')) jobs.push(api.goalAction(chat.id, 'resume'))
    for (const l of loops) {
      if (running && l.status === 'active') jobs.push(api.updateLoop(chat.id, l.id, { status: 'paused' }))
      if (!running && l.status === 'paused') jobs.push(api.updateLoop(chat.id, l.id, { status: 'active' }))
    }
    await run(Promise.all(jobs))
    setBusy(false)
  }
  const first = loops[0]
  const next = loops
    .filter((l) => l.status === 'active' && l.nextAt)
    .map((l) => l.nextAt as number)
    .sort((a, b) => a - b)[0]
  const blocked = goal?.status === 'blocked'
  const Icon = goal ? Target : Repeat
  // A chat is often named after its goal or loop: then the title already says it.
  const same = (t: string): boolean => t.trim().toLowerCase() === chat.title.trim().toLowerCase()
  return (
    <div className={cn('group/ap flex items-center gap-3 py-2.5 pr-2.5 pl-3.5 transition-colors hover:bg-hover', blocked && 'bg-warn-soft')}>
      <Icon className={cn('size-4 shrink-0', blocked ? 'text-warn' : running ? 'text-ink' : 'text-ink-3', goal?.checking && 'animate-pulse-soft')} strokeWidth={2} />
      <button onClick={() => void openChat(chat.id).then(() => setView('chat'))} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{chat.title}</span>
          <ArrowUpRight className="size-3 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/ap:opacity-100" />
        </span>
        <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
          {goal ? (
            <>
              {!same(goal.text) && (
                <>
                  <span className="min-w-0 truncate text-ink-2">{goal.text}</span>
                  <span className="shrink-0">·</span>
                </>
              )}
              <span className={cn('tabular shrink-0', blocked ? 'font-medium text-warn' : goal.checking && 'shimmer-text')}>{goalLine(goal)}</span>
              {loops.length > 0 && (
                <span className="tabular shrink-0">
                  · {loops.length === 1 ? '1 loop' : `${loops.length} loops`}
                  {next ? `, next in ${countdown(next, now)}` : ''}
                </span>
              )}
            </>
          ) : first ? (
            <>
              {(loops.length > 1 || !same(first.prompt)) && (
                <>
                  <span className="min-w-0 truncate text-ink-2">{loops.length > 1 ? `${loops.length} loops: ${first.prompt}` : first.prompt}</span>
                  <span className="shrink-0">·</span>
                </>
              )}
              <span className="tabular shrink-0">{loops.length > 1 ? (next ? `Next run in ${countdown(next, now)}` : loopLine(first, now)) : loopLine(first, now)}</span>
            </>
          ) : null}
        </span>
      </button>
      <IconButton label={running ? 'Pause everything that runs by itself here' : blocked ? 'Carry on: send the lead back to it' : 'Resume'} side="left" disabled={busy || (!running && !(goal?.status === 'paused' || blocked || loops.some((l) => l.status === 'paused')))} onClick={() => void toggle()}>
        {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </IconButton>
    </div>
  )
}

/** Chats that carry on by themselves: an open goal, or loops that are not over. Hidden when there are none. */
function Autopilot({ chats }: { chats: Chat[] }) {
  const list = useMemo(() => chats.filter((c) => goalOpen(c.goal) || liveLoops(c.loops).length > 0), [chats])
  const ticking = list.some((c) => liveLoops(c.loops).some((l) => l.status === 'active' && !!l.nextAt))
  const now = useNow(ticking)
  if (!list.length) return null
  return (
    <>
      <div className="mt-6 mb-2 flex items-center gap-2 text-[12px] font-medium text-ink-3">
        <Repeat className="size-3.5" strokeWidth={1.9} /> On autopilot
        <span className="tabular font-normal text-ink-4">{list.length}</span>
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-[14px] bg-surface shadow-card">
        {list.map((c) => (
          <AutopilotRow key={c.id} chat={c} now={now} />
        ))}
      </div>
    </>
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

        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-2.5">
          {team.map((a) => (
            <AllowanceCard key={a.id} account={a} lead={a.id === leadId} />
          ))}
        </div>

        <Autopilot chats={chats} />

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
