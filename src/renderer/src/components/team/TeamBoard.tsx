import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { HoverCard } from 'radix-ui'
import { Check, ChevronDown, CornerDownRight, Minus } from 'lucide-react'
import type { Account, AgentState, Task } from '@shared/types'
import { agentKey, useStore } from '@/store'
import { accentVars, cn, duration, prettyModel } from '@/lib/util'
import { Orb, OrbStack } from '../Orb'
import { LABEL, RANK, columnsFor, isFinished, sections, statusOf, taskOf, waitsFor, type Section, type Status } from './model'

// The team at a glance: the lead, then everyone else in tidy groups of cards that are all the
// same size. Cards glide to their new place when someone joins, finishes or goes home.

const GAP = 10
const MIN_CARD = 220
const CARD_H = 86
const EFFORT: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

// Moves are quick and short, so a busy board never shows a card on its way somewhere. When a lot
// changes at once (more than MANY cards in new places), when the board has only just opened, or
// when its width changed, everything goes straight to its place instead: a jump reads better than
// a crowd of cards crossing each other.
const glide = { type: 'tween', duration: 0.18, ease: [0.22, 1, 0.36, 1] } as const
const still = { duration: 0 } as const
const MANY = 10
/** Whether the change being drawn now may move things smoothly. */
const Smooth = createContext(false)

const cardMotion = {
  hidden: (ok: boolean) => (ok ? { opacity: 0, scale: 0.96, y: 4 } : { opacity: 1, scale: 1, y: 0 }),
  shown: (ok: boolean) => ({ opacity: 1, scale: 1, y: 0, transition: ok ? glide : still }),
  gone: (ok: boolean) => ({ opacity: 0, scale: 0.96, transition: ok ? { duration: 0.12 } : still }),
}

/** Seconds since `since`, ticking by itself so only this bit of text redraws. */
function Elapsed({ since, className }: { since: number; className?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className={cn('tabular', className)}>{duration(Date.now() - since)}</span>
}

export function StatusMark({ status, className }: { status: Status; className?: string }) {
  if (status === 'done') return <Check className={cn('size-3 text-ok', className)} strokeWidth={2.6} />
  if (status === 'gone') return <Minus className={cn('size-3 text-ink-4', className)} strokeWidth={2.4} />
  return (
    <span
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        status === 'working' && 'animate-pulse-soft bg-link',
        status === 'needs' && 'bg-warn shadow-[0_0_0_3px_var(--warn-soft)]',
        status === 'problem' && 'bg-bad',
        status === 'queued' && 'shadow-[inset_0_0_0_1.5px_var(--ink-4)]',
        (status === 'free' || status === 'off') && 'bg-ink-4/60',
        className,
      )}
    />
  )
}

function Pill({ status }: { status: Status }) {
  return (
    <span
      className={cn(
        'flex h-[20px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium',
        status === 'needs' ? 'bg-warn-soft text-warn' : status === 'problem' ? 'bg-bad-soft text-bad' : status === 'working' ? 'bg-[color-mix(in_oklab,var(--link)_11%,transparent)] text-link' : 'text-ink-3',
      )}
    >
      <StatusMark status={status} />
      {LABEL[status]}
    </span>
  )
}

/** Who a task waits for and was lined up after, in names, worked out once per change. */
function useWaits(chatId: string, task: Task | undefined): { waiting: string; after: string } {
  const waiting = useStore((s) => waitsFor(task, 'waiting', s.tasks[chatId] || [], (id) => s.members[id]?.name))
  const after = useStore((s) => waitsFor(task, 'after', s.tasks[chatId] || [], (id) => s.members[id]?.name))
  return { waiting, after }
}

/** What a card says on its second line. */
function doing(status: Status, st: AgentState | undefined, task: Task | undefined, account: Account, waiting = ''): ReactNode {
  if (status === 'off') return <span className="text-warn">Sign in to bring it back</span>
  if (status === 'needs') return <span className="font-medium text-warn">{st?.activity || 'Needs your OK'}</span>
  if (status === 'working') return <span className="shimmer-text">{st?.activity || task?.title || 'Working'}</span>
  if (status === 'problem') return <span className="text-bad">{st?.error || (task ? `${task.title}: did not finish` : 'Stopped with a problem')}</span>
  if (status === 'queued') return <span className="text-ink-2">{waiting ? `Waiting for ${waiting}` : task?.title || 'Queued'}</span>
  if (task) return <span className="text-ink-3">{task.title}</span>
  return <span className="text-ink-3">{account.role?.trim() || 'Free'}</span>
}

function useModel(account: Account, st: AgentState | undefined, task: Task | undefined): string {
  const status = useStore((s) => s.statuses[account.id] || (account.spawned ? s.statuses[account.spawned.base] : undefined))
  const label = task?.modelLabel || prettyModel(st?.model || task?.ranOn || task?.model || account.model) || status?.models?.find((m) => m.isDefault)?.label || (account.provider === 'chatgpt' ? 'ChatGPT' : 'Claude')
  const effort = task?.effort || account.effort
  return effort && EFFORT[effort] ? `${label} · ${EFFORT[effort]}` : label
}

/** Everything about an agent that does not fit on its card, shown when you rest on it. */
function Details({ chatId, account, status, st, task, model, lead }: { chatId: string; account: Account; status: Status; st: AgentState | undefined; task: Task | undefined; model: string; lead: boolean }) {
  const waits = useWaits(chatId, task)
  const by = useStore((s) => (account.spawned ? s.members[account.spawned.by]?.name : undefined))
  const base = useStore((s) => (account.spawned ? s.members[account.spawned.base]?.name : undefined))
  const row = (k: string, v: ReactNode): ReactNode =>
    v ? (
      <div className="flex gap-3 text-[12px] leading-[17px]">
        <span className="w-[68px] shrink-0 text-ink-3">{k}</span>
        <span className="min-w-0 flex-1 text-ink-2">{v}</span>
      </div>
    ) : null
  return (
    <div className="w-[300px] space-y-2.5" style={accentVars(account.accent)}>
      <div className="flex items-center gap-2.5">
        <Orb account={account} size={28} phase={st?.phase} off={status === 'off' || status === 'gone'} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">
            {account.name} {lead && <span className="text-[11px] font-normal text-ink-3">Lead</span>}
          </div>
          <div className="truncate text-[11.5px] text-ink-3">{account.role?.trim() || (account.spawned ? 'Agent' : 'Teammate')}</div>
        </div>
        <Pill status={status} />
      </div>
      <div className="space-y-1.5">
        {row('Now', status === 'working' || status === 'needs' ? st?.activity || 'Working' : null)}
        {row('Task', task?.title)}
        {task?.brief && task.brief !== task.title && row('Brief', <span className="line-clamp-4">{task.brief}</span>)}
        {row('Waiting for', task?.status === 'queued' ? waits.waiting : null)}
        {row('Lined up after', !waits.waiting ? waits.after : null)}
        {row('Model', model)}
        {row('Started by', account.spawned ? `${by || 'a teammate'}, on ${base || 'an'} account` : null)}
        {row('Why', st?.modelWhy || task?.modelWhy)}
        {row('Problem', status === 'problem' ? st?.error || 'It stopped before it finished.' : null)}
        {row('Took', task?.startedAt && task.finishedAt ? duration(task.finishedAt - task.startedAt) : null)}
      </div>
      <div className="border-t border-line pt-2 text-[11px] text-ink-4">Click to open its chat</div>
    </div>
  )
}

function Hover({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <HoverCard.Root openDelay={480} closeDelay={80}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content side="bottom" align="start" sideOffset={8} collisionPadding={12} className="z-[70] animate-fade-in rounded-[14px] bg-surface p-3.5 shadow-pop">
          {content}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}

const AgentCard = memo(function AgentCard({ chatId, account, status, pinged, onOpen }: { chatId: string; account: Account; status: Status; pinged: boolean; onOpen(id: string): void }) {
  const st = useStore((s): AgentState | undefined => s.agents[agentKey(chatId, account.id)])
  const task = useStore((s) => taskOf(account, st, s.tasks[chatId] || []))
  const helpers = useStore((s) => (s.chats.find((c) => c.id === chatId)?.agents || []).filter((a) => a.spawned?.by === account.id && !a.spawned.gone).length)
  const model = useModel(account, st, task)
  const { waiting } = useWaits(chatId, task)
  const finished = isFinished(status)
  const since = status === 'working' || status === 'needs' ? st?.turnStartedAt || task?.startedAt : undefined
  return (
    <Hover content={<Details chatId={chatId} account={account} status={status} st={st} task={task} model={model} lead={false} />}>
      <button
        data-agent-card={account.id}
        onClick={() => onOpen(account.id)}
        style={{ height: CARD_H, ...accentVars(account.accent) }}
        className={cn(
          'group/c relative flex w-full flex-col rounded-[14px] bg-surface px-3.5 pt-3 pb-2.5 text-left shadow-card transition-[box-shadow,opacity] duration-300 hover:shadow-float focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--link)]',
          status === 'needs' && 'shadow-[0_0_0_1px_color-mix(in_oklab,var(--warn)_45%,transparent),var(--shadow-card)]',
          pinged && 'shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--a2)_70%,transparent),0_10px_30px_-14px_color-mix(in_oklab,var(--a2)_70%,transparent)]',
          finished && 'opacity-60 hover:opacity-100',
        )}
      >
        <span className="flex w-full items-center gap-2.5">
          <Orb account={account} size={24} phase={st?.phase} off={status === 'off' || status === 'gone'} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{account.name}</span>
          <Pill status={status} />
        </span>
        <span className="mt-1.5 block w-full truncate text-[12.5px] leading-[17px]">{doing(status, st, task, account, waiting)}</span>
        <span className="mt-auto flex w-full items-center gap-2 text-[11px] text-ink-4">
          <span className="min-w-0 flex-1 truncate">{model}</span>
          {helpers > 0 && (
            <span className="shrink-0 text-ink-3">
              {helpers} {helpers === 1 ? 'helper' : 'helpers'}
            </span>
          )}
          {since ? <Elapsed since={since} className="shrink-0 text-ink-3" /> : status === 'done' && task?.startedAt && task.finishedAt ? <span className="tabular shrink-0">{duration(task.finishedAt - task.startedAt)}</span> : null}
        </span>
      </button>
    </Hover>
  )
})

function Lead({ chatId, account, counts, total, onOpen }: { chatId: string; account: Account; counts: Record<Status, number>; total: number; onOpen(id: string): void }) {
  const st = useStore((s): AgentState | undefined => s.agents[agentKey(chatId, account.id)])
  const out = useStore((s) => s.statuses[account.id]?.state === 'signed-out')
  const task = useStore((s) => (st?.taskId ? s.tasks[chatId]?.find((t) => t.id === st.taskId) : undefined))
  const model = useModel(account, st, task)
  const status: Status = out ? 'off' : st?.phase === 'waiting' ? 'needs' : st && st.phase !== 'idle' && st.phase !== 'error' ? 'working' : st?.phase === 'error' ? 'problem' : 'free'
  const stats = (
    [
      ['working', 'Working'],
      ['needs', 'Need you'],
      ['problem', 'Problems'],
      ['queued', 'Queued'],
      ['done', 'Done'],
    ] as const
  ).filter(([k]) => counts[k] > 0 || k === 'working')
  const bar = (['done', 'working', 'needs', 'problem', 'queued'] as const).map((k) => [k, counts[k]] as const).filter(([, n]) => n > 0)
  return (
    <Hover content={<Details chatId={chatId} account={account} status={status} st={st} task={task} model={model} lead />}>
      <button
        data-agent-card={account.id}
        onClick={() => onOpen(account.id)}
        style={accentVars(account.accent)}
        className="flex w-full flex-col gap-3 rounded-[18px] bg-surface p-4 text-left shadow-card transition-shadow duration-200 hover:shadow-float"
      >
        <span className="flex w-full flex-wrap items-center gap-x-6 gap-y-3">
          <span className="flex min-w-[220px] flex-1 items-center gap-3.5">
            <Orb account={account} size={40} phase={st?.phase} off={out} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{account.name}</span>
                <span className="text-[11.5px] text-ink-3">Lead</span>
                <span className="truncate text-[11.5px] text-ink-4">{model}</span>
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-[13px]">
                <span className="min-w-0 truncate">{doing(status, st, task, account)}</span>
                {status === 'working' && st?.turnStartedAt && <Elapsed since={st.turnStartedAt} className="shrink-0 text-[12px] text-ink-3" />}
              </span>
            </span>
          </span>
          {total > 0 && (
            <span className="flex shrink-0 items-center gap-5">
              {stats.map(([k, label]) => (
                <span key={k} className="flex flex-col items-start">
                  <span className={cn('tabular text-[18px] leading-[22px] font-semibold tracking-[-0.01em]', k === 'needs' ? 'text-warn' : k === 'problem' ? 'text-bad' : k === 'done' || k === 'queued' ? 'text-ink-2' : 'text-ink')}>{counts[k]}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
                    <StatusMark status={k} className={k === 'done' ? 'size-2.5' : 'size-[6px]'} /> {label}
                  </span>
                </span>
              ))}
            </span>
          )}
        </span>
        {total > 0 && (
          <span className="flex h-[5px] w-full overflow-hidden rounded-full bg-hover" aria-label={`${counts.done} of ${total} agents done`}>
            {bar.map(([k, n]) => (
              <span
                key={k}
                className={cn('h-full transition-[width] duration-500 ease-out', k === 'done' ? 'bg-ok/70' : k === 'working' ? 'bg-link/70' : k === 'needs' ? 'bg-warn' : k === 'problem' ? 'bg-bad' : 'bg-ink-4/35')}
                style={{ width: `${(n / total) * 100}%` }}
              />
            ))}
          </span>
        )}
      </button>
    </Hover>
  )
}

/** The cards a section shows, in order: the ones still at it, then the finished ones when it is open. */
function shownOf(section: Section, statusOfId: Map<string, Status>, open: boolean): { live: Account[]; done: Account[]; shown: Account[] } {
  const live = section.members.filter((m) => !isFinished(statusOfId.get(m.id) || 'free'))
  const done = section.members.filter((m) => isFinished(statusOfId.get(m.id) || 'free'))
  return { live, done, shown: open ? [...live, ...done] : live }
}

function SectionView({ chatId, section, statusOfId, fit, cardW, open, setOpen, pinged, onOpen }: { chatId: string; section: Section; statusOfId: Map<string, Status>; fit: number; cardW: number; open: boolean; setOpen(v: boolean): void; pinged: Set<string>; onOpen(id: string): void }) {
  const ok = useContext(Smooth)
  const { live, done, shown } = shownOf(section, statusOfId, open)
  const cols = columnsFor(shown.length, fit)
  const n = (k: Status): number => section.members.filter((m) => statusOfId.get(m.id) === k).length
  const summary = (
    [
      ['needs', 'need you'],
      ['working', 'working'],
      ['problem', 'with a problem'],
      ['queued', 'queued'],
    ] as const
  )
    .map(([k, w]) => [k, n(k), w] as const)
    .filter(([, c]) => c > 0)
  return (
    <section className={cn(section.parent && 'pl-5')}>
      <div className="flex h-8 items-center gap-2 pr-1">
        {section.parent && (
          <>
            <CornerDownRight className="-ml-5 size-3.5 shrink-0 text-ink-4" strokeWidth={1.9} />
            <Orb account={section.parent} size={14} />
          </>
        )}
        <h3 className="truncate text-[13px] font-semibold text-ink">{section.label}</h3>
        <span className="tabular text-[12px] text-ink-4">{section.members.length}</span>
        <span className="min-w-0 flex-1" />
        <span className="flex min-w-0 items-center gap-3 overflow-hidden text-[11.5px] whitespace-nowrap text-ink-3">
          {summary.map(([k, c, w]) => (
            <span key={k} className="flex items-center gap-1.5">
              <StatusMark status={k} className="size-[6px]" />
              <span className="tabular">{c}</span> {w}
            </span>
          ))}
          {done.length > 0 && (
            <span className="flex items-center gap-1.5">
              <StatusMark status="done" className="size-2.5" />
              <span className="tabular">{done.length}</span> finished
            </span>
          )}
        </span>
      </div>
      {shown.length > 0 && (
        // Relative, so a card on its way out is lifted out of the grid right where it was.
        <div className="relative mt-1.5 grid" style={{ gap: GAP, gridTemplateColumns: `repeat(${cols}, ${cardW}px)` }}>
          <AnimatePresence initial={false} mode="popLayout" custom={ok}>
            {shown.map((m) => (
              <motion.div key={m.id} layout="position" transition={ok ? glide : still} custom={ok} variants={cardMotion} initial="hidden" animate="shown" exit="gone">
                <AgentCard chatId={chatId} account={m} status={statusOfId.get(m.id) || 'free'} pinged={pinged.has(m.id)} onOpen={onOpen} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
      {done.length > 0 && (
        <motion.button
          layout="position"
          transition={ok ? glide : still}
          onClick={() => setOpen(!open)}
          className="mt-2 flex h-7 items-center gap-2 rounded-[8px] pr-2.5 pl-1.5 text-[12px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <ChevronDown className={cn('size-3.5 transition-transform duration-200', !open && '-rotate-90')} />
          {!open && <OrbStack accounts={done} size={14} max={5} />}
          {open ? 'Hide the finished ones' : live.length ? `${done.length} finished` : `All ${done.length} finished`}
        </motion.button>
      )}
    </section>
  )
}

/** A section's place on the board. It fades in once when it first appears, and never fades out. */
function Place({ children }: { children: ReactNode }) {
  const ok = useContext(Smooth)
  return (
    <motion.div layout="position" transition={ok ? glide : still} initial={ok ? { opacity: 0 } : false} animate={{ opacity: 1 }}>
      {children}
    </motion.div>
  )
}

/** States and tasks boiled down to one status per agent, recomputed only when one of them changes. */
function useStatuses(chatId: string, team: Account[], tasks: Task[]): Map<string, Status> {
  const sig = useStore((s) =>
    team.map((a) => {
      const st = s.agents[agentKey(chatId, a.id)]
      return `${st?.phase || ''}:${st?.taskId || ''}:${s.statuses[a.id]?.state === 'signed-out' ? 1 : 0}:${a.spawned?.gone ? 1 : 0}`
    }).join('|'),
  )
  const taskSig = tasks.map((t) => `${t.id}:${t.status}`).join('|')
  return useMemo(() => {
    const s = useStore.getState()
    const m = new Map<string, Status>()
    for (const a of team) {
      const st = s.agents[agentKey(chatId, a.id)]
      m.set(a.id, statusOf(a, st, taskOf(a, st, tasks), s.statuses[a.id]?.state === 'signed-out'))
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, taskSig, team, chatId])
}

export function TeamBoard({ chatId, team, leadId, tasks, pinged, onOpen }: { chatId: string; team: Account[]; leadId: string | undefined; tasks: Task[]; pinged: Set<string>; onOpen(id: string): void }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => setWidth(el.clientWidth)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const statusOfId = useStatuses(chatId, team, tasks)
  const lead = team.find((a) => a.id === leadId) || team[0]
  const list = useMemo(() => sections(team, lead?.id, (a) => statusOfId.get(a.id) || 'free'), [team, lead?.id, statusOfId])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => setOpen({}), [chatId])

  const counts = useMemo(() => {
    const c = Object.fromEntries(Object.keys(RANK).map((k) => [k, 0])) as Record<Status, number>
    for (const a of team) if (a.spawned) c[statusOfId.get(a.id) || 'free']++
    c.done += c.gone
    return c
  }, [team, statusOfId])
  const spawned = team.filter((a) => a.spawned).length

  // One card width for the whole board, so every card is the same size.
  // The scroller has 20 px of padding on each side.
  const inner = Math.min(width - 40, 1240)
  const fit = Math.max(1, Math.floor((inner + GAP) / (MIN_CARD + GAP)))
  const cardW = Math.floor((inner - (fit - 1) * GAP) / fit)
  const fitOf = (s: Section): number => (s.parent ? Math.max(1, Math.floor((inner - 20 + GAP) / (cardW + GAP))) : fit)

  // Where every card is now: its group, the group's place on the board, the group's columns, and
  // its place in the group. Any of those changing moves the card on screen.
  const places = useMemo(() => {
    const m = new Map<string, string>()
    list.forEach((s, at) => {
      const { shown } = shownOf(s, statusOfId, !!open[s.key])
      const cols = columnsFor(shown.length, fitOf(s))
      shown.forEach((a, i) => m.set(a.id, `${at}|${s.key}|${cols}|${i}`))
    })
    return m
    // fitOf only changes with the width, which is compared on its own below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, statusOfId, open])
  const order = list.map((s) => s.key)
  const [born] = useState(() => performance.now())
  const last = useRef<{ chatId: string; width: number; places: Map<string, string>; order: string[]; epoch: number } | null>(null)
  const was = last.current
  let moved = 0
  if (was) {
    for (const [id, p] of places) if (was.places.get(id) !== p) moved++
    for (const id of was.places.keys()) if (!places.has(id)) moved++
  }
  // Groups changing places with each other would slide across one another: they jump instead.
  const kept = order.filter((k) => was?.order.includes(k))
  const reordered = !!was && kept.join() !== was.order.filter((k) => order.includes(k)).join()
  const smooth = !!was && was.chatId === chatId && was.width === width && !reordered && moved <= MANY && performance.now() - born > 600
  // A change that is not smooth draws the groups afresh, each card straight in its new place. Turning
  // the moves off for one change is not enough: the next small change would then glide every card
  // from where it was before the big one.
  const epoch = smooth ? (was?.epoch ?? 0) : (was?.epoch ?? 0) + 1
  useLayoutEffect(() => {
    last.current = { chatId, width, places, order, epoch }
  })

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-10 [scrollbar-gutter:stable]">
      {width > 0 && lead && (
        <div className="mx-auto space-y-6" style={{ width: inner }}>
          <Lead chatId={chatId} account={lead} counts={counts} total={spawned} onOpen={onOpen} />
          <Smooth.Provider value={smooth}>
            <LayoutGroup id={`team-${chatId}`} key={epoch}>
              {list.map((s) => (
                <Place key={s.key}>
                  <SectionView
                    chatId={chatId}
                    section={s}
                    statusOfId={statusOfId}
                    fit={fitOf(s)}
                    cardW={cardW}
                    open={!!open[s.key]}
                    setOpen={(v) => setOpen((o) => ({ ...o, [s.key]: v }))}
                    pinged={pinged}
                    onOpen={onOpen}
                  />
                </Place>
              ))}
            </LayoutGroup>
          </Smooth.Provider>
          {!list.length && <p className="px-1 text-[12.5px] leading-relaxed text-ink-3">When the lead brings in teammates or starts agents of its own, they appear here in groups, with what each is doing right now.</p>}
        </div>
      )}
    </div>
  )
}
