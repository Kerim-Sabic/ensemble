import { memo, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Ban, Check, ChevronDown, CircleCheck, Hand, Repeat, Square, Target, CircleAlert, Clock, CornerDownRight, FileText, FolderOpen, Gauge, Hourglass, Info, MessageCircleQuestion, MousePointerClick, Pause, Play, RotateCcw, Globe, KeyRound, ShieldCheck, ShieldQuestion, Undo2, UserPlus, X } from 'lucide-react'
import { compactNumber } from '@/lib/derive'
import type { Account, AgentState, Item, Task } from '@shared/types'
import { describeTool, mediaPathsIn } from '@shared/tools'
import { MediaStrip, MediaView } from '../Media'
import { viewFrom } from '../Viewer'
import { agentKey, useStore } from '@/store'
import { accentVars, api, baseName, cn, duration, runLabel } from '@/lib/util'
import { Button, Spinner, Tip, inputClass } from '../ui'
import { Orb, OrbStack } from '../Orb'
import { CopyButton, EditButton } from './MessageActions'
import { seedComposer } from './Composer'
import { describe } from '../ultra/groups'
import { FanMark, StateDot } from '../ultra/neural/Marks'
import { Markdown } from '../Markdown'

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>

const useAccountOf = (id: string): Account | undefined => useStore((s) => s.members[id])

/** Ticks once a second while `since` is set. */
export function useElapsed(since?: number): number {
  const [, force] = useState(0)
  useEffect(() => {
    if (!since) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [since])
  return since ? Date.now() - since : 0
}

function Clamp({ text, lines = 5, compact, replyTo }: { text: string; lines?: number; compact?: boolean; replyTo?: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > lines * 90 || text.split('\n').length > lines
  return (
    <div>
      <div className={cn(!open && long && 'relative overflow-hidden')} style={!open && long ? { maxHeight: `${lines * 1.6}em` } : undefined}>
        <Markdown text={text} compact={compact} replyTo={replyTo} />
        {!open && long && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--clamp-bg,var(--surface))] to-transparent" />}
      </div>
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-1 text-[12px] font-medium text-ink-3 hover:text-ink">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

// ───────────── you ─────────────

export const UserBubble = memo(function UserBubble({ item, chatId, accountId }: { item: Of<'user'>; chatId?: string; accountId?: string }) {
  const [taking, setTaking] = useState(false)
  // A message still waiting its turn can be taken back, or taken back into the box to change.
  const takeBack = async (edit: boolean): Promise<void> => {
    if (!chatId || !accountId) return
    setTaking(true)
    const got = await useStore.getState().dequeue(chatId, accountId, item.id)
    setTaking(false)
    if (got && edit) seedComposer(got.text)
  }
  return (
    <div className="flex animate-rise flex-col items-end py-2">
      {item.attachments && item.attachments.length > 0 && (
        <div className="mb-1.5 flex max-w-[82%] flex-wrap justify-end gap-1.5">
          {item.attachments.map((a) =>
            a.kind === 'image' ? (
              <img key={a.path} src={api.fileUrl(a.path)} alt={a.name} data-view-path={a.path} onClick={(e) => viewFrom(e.currentTarget, a.path)} className="h-20 cursor-zoom-in rounded-[10px] object-cover shadow-card" />
            ) : (
              <button key={a.path} onClick={() => void api.showInFolder(a.path)} className="flex h-7 items-center gap-1.5 rounded-[8px] bg-surface-2 px-2 text-[12px] text-ink-2 shadow-card hover:text-ink">
                <FileText className="size-3.5" />
                {a.name}
              </button>
            ),
          )}
        </div>
      )}
      {item.text && (
        <div className="group/u relative max-w-[82%]">
          {/* Beside the bubble, on hover: they take no room, so nothing moves. */}
          <div className="pointer-events-none absolute right-full bottom-0.5 flex gap-0.5 pr-1 opacity-0 transition-opacity duration-150 group-hover/u:pointer-events-auto group-hover/u:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
            <CopyButton text={item.text} />
            {/* A queued message is changed with "Edit" under it, which also takes it out of the queue. */}
            {!item.queued && <EditButton text={item.text} />}
          </div>
          <div className="selectable rounded-[18px] rounded-br-[6px] bg-surface-2 px-4 py-2.5 text-[14.5px] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere] shadow-[inset_0_0_0_1px_var(--line)]">
            {item.text}
          </div>
        </div>
      )}
      {item.queued && (
        <div className="mt-1 flex items-center gap-1 text-[11.5px] text-ink-3">
          <Clock className="size-3" /> Waiting for the current reply to finish
          {chatId && accountId && (
            <>
              <span className="text-ink-4">·</span>
              <button disabled={taking} onClick={() => void takeBack(true)} className="font-medium text-ink-2 hover:text-ink disabled:opacity-40">
                Edit
              </button>
              <span className="text-ink-4">·</span>
              <button disabled={taking} onClick={() => void takeBack(false)} className="font-medium text-ink-2 hover:text-ink disabled:opacity-40">
                Take back
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
})

// ───────────── goals and loops ─────────────

type AutoEvent = Of<'auto'>['event']

/** Icon, colour and the word for the detail, per goal or loop event. */
function autoLook(item: Of<'auto'>): { icon: typeof Target; tone: string; box: string; more: string; slim?: boolean } {
  const plain = 'bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]'
  const e: AutoEvent = item.event
  if (item.of === 'loop') {
    if (e === 'run' || e === 'set') return { icon: Repeat, tone: 'text-ink', box: plain, more: 'The message' }
    if (e === 'done') return { icon: Repeat, tone: 'text-ink-3', box: '', more: 'Why it ended', slim: true }
  }
  switch (e) {
    case 'set':
      return { icon: Target, tone: 'text-ink', box: plain, more: 'The goal' }
    case 'check':
      return { icon: RotateCcw, tone: 'text-ink-2', box: plain, more: 'What is missing' }
    case 'met':
      return { icon: CircleCheck, tone: 'text-ok', box: 'bg-ok-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ok)_25%,transparent)]', more: 'How it was checked' }
    case 'blocked':
      return { icon: Hand, tone: 'text-warn', box: 'bg-warn-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_28%,transparent)]', more: 'What it needs' }
    case 'paused':
      return { icon: Pause, tone: 'text-ink-3', box: '', more: 'Why', slim: true }
    case 'resumed':
      return { icon: Play, tone: 'text-ink-3', box: '', more: 'Why', slim: true }
    case 'stopped':
      return { icon: Square, tone: 'text-ink-3', box: '', more: 'Why', slim: true }
    default:
      return { icon: item.of === 'loop' ? Repeat : Target, tone: 'text-ink-3', box: '', more: 'More', slim: true }
  }
}

/** Something the app did by itself for a goal or a loop: a slim row, with the detail one click away. */
export const AutoRow = memo(function AutoRow({ item }: { item: Of<'auto'> }) {
  const look = autoLook(item)
  // What is missing, and why it is blocked, are worth seeing without a click.
  const [open, setOpen] = useState(item.event === 'blocked')
  const text = item.text?.trim() || ''
  const Icon = look.icon
  const time = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const title = item.title || (item.of === 'goal' ? 'Goal' : 'Loop')

  if (look.slim) {
    return (
      <div className="my-1.5 flex animate-rise items-start gap-2 text-[12.5px] text-ink-3">
        <Icon className={cn('mt-[2.5px] size-3.5 shrink-0', look.tone)} strokeWidth={2} fill={item.event === 'stopped' ? 'currentColor' : 'none'} />
        <span className="min-w-0 flex-1 leading-snug">
          <span className="font-medium text-ink-2">{title}</span>
          {text && <span className="selectable"> · {text}</span>}
        </span>
        <span className="tabular shrink-0 text-[11px] text-ink-4">{time}</span>
      </div>
    )
  }

  const met = item.event === 'met'
  return (
    <div className="my-2.5 animate-rise">
      <div className={cn('rounded-[12px] px-3 py-2', look.box)}>
        <button
          onClick={() => text && setOpen((o) => !o)}
          className={cn('flex w-full min-w-0 items-center gap-2 text-left text-[12.5px]', !text && 'cursor-default')}
        >
          <Icon className={cn('size-[15px] shrink-0', look.tone)} strokeWidth={2} />
          <span className={cn('min-w-0 truncate font-semibold', met ? 'text-ok' : item.event === 'blocked' ? 'text-warn' : 'text-ink')}>{title}</span>
          {text && !open ? <span className="min-w-0 flex-1 basis-0 truncate text-ink-2">{text}</span> : <span className="flex-1" />}
          <span className="tabular shrink-0 text-[11px] text-ink-4">{time}</span>
          {text && <ChevronDown className={cn('size-3.5 shrink-0 text-ink-3 transition-transform duration-200', open && 'rotate-180')} />}
        </button>
        {text && open && (
          <div className="mt-1 animate-fade-in pl-[23px]">
            <div className="mb-0.5 text-[11px] font-medium text-ink-3">{look.more}</div>
            <div className="selectable text-[13px] leading-[1.5] whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{text}</div>
          </div>
        )}
      </div>
    </div>
  )
})

// ───────────── from a teammate ─────────────

export const PeerCard = memo(function PeerCard({ item, onOpen }: { item: Of<'peer'>; onOpen(accountId: string): void }) {
  const from = useAccountOf(item.from)
  const name = from?.name || 'A teammate'
  const verb =
    item.tag === 'task'
      ? 'handed over a task'
      : item.tag === 'result'
        ? item.status === 'done'
          ? 'reported back'
          : item.status === 'cancelled'
            ? 'was stopped'
            : 'ran into a problem'
        : item.tag === 'question'
          ? 'is waiting on an answer to this'
          : 'sent a note'
  return (
    <div className="animate-rise py-2" style={accentVars(from?.accent)}>
      <div
        className="rounded-[14px] bg-[var(--a-soft)] px-4 py-3 shadow-[inset_0_0_0_1px_var(--a-line)]"
        style={{ ['--clamp-bg' as string]: 'color-mix(in oklab, var(--a2) 9%, var(--surface))' }}
      >
        <div className="mb-1.5 flex items-center gap-2 text-[12.5px]">
          <button onClick={() => from && onOpen(from.id)} className="flex shrink-0 items-center gap-2 font-semibold hover:underline">
            <Orb account={from} size={16} />
            {name}
          </button>
          <span className="min-w-0 flex-1 truncate text-ink-2">
            {verb}
            {item.title && <span className="font-medium text-ink"> · {item.title}</span>}
          </span>
          {item.tag === 'result' && item.status === 'done' && <Check className="size-3.5 shrink-0 text-ok" strokeWidth={2.5} />}
          {item.tag === 'result' && item.status === 'failed' && <CircleAlert className="size-3.5 shrink-0 text-bad" />}
          {item.queued && (
            <Tip label="It is read as soon as the current step ends" side="top">
              <span className="shrink-0 text-[11.5px] text-ink-3">{item.tag === 'result' ? 'not read yet' : 'read next'}</span>
            </Tip>
          )}
        </div>
        <Clamp text={item.text} lines={item.tag === 'result' ? 7 : 4} compact replyTo={item.from} />
      </div>
    </div>
  )
})

// ───────────── handing work off ─────────────

const STATUS: Record<Task['status'], string> = { queued: 'Queued', running: 'Working', done: 'Done', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Cut short' }

/** "Waits for t1 and t2" while a task is lined up behind others. */
export const waitingLabel = (t: { waitingOn?: string[]; waitingFor?: string; holding?: boolean; status?: string; parkedUntil?: number } | undefined): string =>
  t?.waitingOn?.length
    ? // Who it waits for, by name; never the task ids the engine keeps.
      `Waits for ${t.waitingFor || (t.waitingOn.length === 1 ? 'another task' : `${t.waitingOn.length} other tasks`)}`
    : t?.parkedUntil && t.status === 'queued'
      ? `Waits for allowance · ${new Date(t.parkedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : t?.holding && t.status === 'running'
        ? 'Waiting on its agents'
        : ''

export const DelegateCard = memo(function DelegateCard({
  item,
  chatId,
  onOpen,
}: {
  item: Of<'delegate'>
  chatId: string
  onOpen(accountId: string): void
}) {
  const to = useAccountOf(item.to)
  const task = useStore((s) => s.tasks[chatId]?.find((t) => t.id === item.taskId))
  const agent = useStore((s): AgentState | undefined => s.agents[agentKey(chatId, item.to)])
  const status = task?.status || 'queued'
  const working = status === 'running'
  const elapsed = useElapsed(working ? task?.startedAt : undefined)
  const took = task?.startedAt && task.finishedAt ? task.finishedAt - task.startedAt : 0
  return (
    <button
      onClick={() => to && onOpen(to.id)}
      style={accentVars(to?.accent)}
      className="group/d flex min-w-0 animate-rise flex-col rounded-[14px] bg-surface px-3.5 py-3 text-left shadow-card transition-shadow duration-200 hover:shadow-float"
    >
      <div className="flex w-full items-center gap-2">
        <Orb account={to} size={18} live={working} />
        <span className="truncate text-[12.5px] font-semibold">{to?.name || 'Teammate'}</span>
        <span className="flex-1" />
        <span
          className={cn(
            'tabular flex items-center gap-1.5 text-[11.5px] font-medium',
            status === 'done' ? 'text-ok' : status === 'failed' ? 'text-bad' : status === 'cancelled' ? 'text-ink-3' : status === 'interrupted' ? 'text-warn' : 'text-ink-2',
          )}
        >
          {status === 'done' && <Check className="size-3" strokeWidth={2.75} />}
          {status === 'failed' && <CircleAlert className="size-3" />}
          {status === 'cancelled' && <Ban className="size-3" />}
          {status === 'interrupted' && <Pause className="size-3" />}
          {waitingLabel(task) || STATUS[status]}
          {working && elapsed >= 1000 && <span className="text-ink-3">{duration(elapsed)}</span>}
          {status === 'done' && took > 0 && <span className="font-normal text-ink-3">{duration(took)}</span>}
        </span>
      </div>
      <div className="mt-2 line-clamp-2 text-[13.5px] leading-snug font-medium">{item.title}</div>
      <div className="mt-1.5 flex h-[18px] w-full items-center text-[12px]">
        {working ? (
          <span className="shimmer-text truncate">{agent?.activity || 'Working'}</span>
        ) : task && runLabel(task) ? (
          // The lead picked a model or an effort for this task; say which.
          <span className="flex min-w-0 items-center gap-1.5 text-ink-3">
            <Gauge className="size-3 shrink-0" strokeWidth={1.9} />
            <span className="truncate">{runLabel(task)}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-ink-3 opacity-0 transition-opacity group-hover/d:opacity-100">
            Open <ArrowUpRight className="size-3" />
          </span>
        )}
      </div>
    </button>
  )
})

const NO_TASKS: Task[] = []
const NO_PEOPLE: Account[] = []
const ORDER: Record<Task['status'], number> = { running: 0, queued: 1, interrupted: 2, failed: 3, done: 4, cancelled: 5 }

/** Many tasks handed out at once: one card that says to whom, with how far they have got. Opens to one line per task. */
export const DelegateGroup = memo(function DelegateGroup({ items, chatId, onOpen }: { items: Of<'delegate'>[]; chatId: string; onOpen(accountId: string): void }) {
  const [open, setOpen] = useState(false)
  const tasks = useStore((s) => s.tasks[chatId] ?? NO_TASKS)
  const members = useStore((s) => s.members)
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === chatId)?.ultra)
  const from = useStore((s) => (items[0] ? s.members[(s.tasks[chatId] ?? NO_TASKS).find((t) => t.id === items[0].taskId)?.from || ''] : undefined))
  const rows = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    return items
      .map((d) => ({ d, t: byId.get(d.taskId), to: members[d.to] }))
      .sort((a, b) => ORDER[a.t?.status || 'queued'] - ORDER[b.t?.status || 'queued'])
  }, [items, tasks, members])
  const people = useMemo(() => {
    const seen = new Set<string>()
    const out: Account[] = []
    for (const d of items) {
      const a = members[d.to]
      if (a && !seen.has(a.id)) {
        seen.add(a.id)
        out.push(a)
      }
    }
    return out.length ? out : NO_PEOPLE
  }, [items, members])
  const count = (st: Task['status']): number => rows.filter((r) => (r.t?.status || 'queued') === st).length
  const parts = [
    { n: count('running'), text: 'working', tone: 'font-medium text-ink-2' },
    { n: count('queued'), text: 'waiting', tone: '' },
    { n: count('done'), text: 'done', tone: 'text-ok' },
    { n: count('failed'), text: 'failed', tone: 'text-bad' },
  ].filter((x) => x.n > 0)
  return (
    <div className={cn('my-3 animate-rise overflow-hidden rounded-[14px]', ultra ? 'ux-ultra-frame' : 'bg-surface shadow-card')}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-hover">
        {ultra ? (
          // In Ultra, a stage reads as a piece of the network: one agent fanning work out.
          <FanMark from={from} to={rows.map((r) => r.to).filter((a): a is Account => !!a)} states={rows.map((r) => r.t?.status)} />
        ) : (
          <OrbStack accounts={people.map((a) => ({ ...a, live: false }))} size={20} max={4} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">
            Handed out {items.length} tasks to {describe(people)}
          </span>
          <span className="tabular mt-0.5 block truncate text-[12px] text-ink-3">
            {parts.map((x, i) => (
              <span key={x.text} className={x.tone}>
                {i > 0 && <span className="font-normal text-ink-4"> · </span>}
                {x.n} {x.text}
              </span>
            ))}
          </span>
        </span>
        {/* One mark per task: how far the whole batch has got, at a glance. */}
        <span className="flex max-w-[28%] shrink-0 flex-wrap items-center justify-end gap-[3px]" aria-hidden>
          {rows.map(({ d, t, to }) =>
            ultra ? (
              <StateDot key={d.id} status={t?.status} account={to} size={9} />
            ) : (
              <span
                key={d.id}
                className={cn(
                  'size-[6px] rounded-full',
                  t?.status === 'done' ? 'bg-ok' : t?.status === 'running' ? 'animate-pulse-soft bg-ink-2' : t?.status === 'failed' ? 'bg-bad' : 'bg-line-2',
                )}
              />
            ),
          )}
        </span>
        <ChevronDown className={cn('size-3.5 shrink-0 text-ink-3 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="animate-fade-in border-t border-line px-1.5 py-1.5">
          {rows.map(({ d, t, to }) => {
            const st = t?.status || 'queued'
            return (
              <button
                key={d.id}
                onClick={() => to && onOpen(to.id)}
                style={accentVars(to?.accent)}
                className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover"
              >
                {ultra ? <StateDot status={st} account={to} size={14} /> : <Orb account={to} size={15} live={st === 'running'} />}
                <span className="w-[92px] shrink-0 truncate font-medium">{to?.name || 'Teammate'}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{d.title}</span>
                <span
                  className={cn(
                    'tabular shrink-0 text-[11.5px]',
                    st === 'done' ? 'text-ok' : st === 'failed' ? 'text-bad' : st === 'running' ? 'font-medium text-ink-2' : 'text-ink-3',
                  )}
                >
                  {waitingLabel(t) || STATUS[st]}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})

/** Several agents joining at once: one line with their faces, opening to who they are. */
export const SpawnGroup = memo(function SpawnGroup({ items, onOpen }: { items: Of<'spawn'>[]; onOpen(accountId: string): void }) {
  const [open, setOpen] = useState(false)
  const members = useStore((s) => s.members)
  const people = useMemo(() => items.map((i) => members[i.agentId]).filter((a): a is Account => !!a), [items, members])
  return (
    <div className="my-2.5 animate-rise overflow-hidden rounded-[14px] bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-hover">
        <OrbStack accounts={people.map((a) => ({ ...a, live: false }))} size={20} max={5} />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-semibold">{items.length} agents joined the chat</span>
          <span className="text-ink-3"> · {describe(people)}</span>
        </span>
        <UserPlus className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.75} />
        <ChevronDown className={cn('size-3.5 shrink-0 text-ink-3 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="animate-fade-in border-t border-line px-1.5 py-1.5">
          {items.map((i) => {
            const a = members[i.agentId]
            return (
              <button
                key={i.id}
                onClick={() => a && !a.spawned?.gone && onOpen(a.id)}
                style={accentVars(a?.accent)}
                className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover"
              >
                <Orb account={a} size={15} off={!!a?.spawned?.gone} />
                <span className="w-[92px] shrink-0 truncate font-medium">{a?.name || i.name}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{i.role}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})

/** A question this teammate put to another, with the answer once it is back. */
export const AskCard = memo(function AskCard({ item, onOpen }: { item: Of<'ask'>; onOpen(accountId: string): void }) {
  const to = useAccountOf(item.to)
  const waiting = item.status === 'waiting'
  const elapsed = useElapsed(waiting ? item.ts : undefined)
  return (
    <div className="my-2.5 animate-rise" style={accentVars(to?.accent)}>
      <div className="flex items-start gap-2 text-[13px]">
        <MessageCircleQuestion className="mt-[3px] size-[15px] shrink-0 text-ink-3" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <span className="text-ink-2">Asked </span>
          <button onClick={() => to && onOpen(to.id)} className="inline-flex items-center gap-1.5 align-middle font-medium text-ink hover:underline">
            <Orb account={to} size={13} live={waiting} /> {to?.name || 'a teammate'}
          </button>
          <span className="selectable ml-1.5 text-ink-2">{item.text}</span>
        </div>
        {waiting ? (
          <span className="tabular flex shrink-0 items-center gap-1 text-[11.5px] text-ink-3">
            <Hourglass className="size-3" /> {elapsed > 3000 ? duration(elapsed) : 'waiting'}
          </span>
        ) : (
          item.durationMs !== undefined && item.durationMs > 1500 && <span className="tabular shrink-0 text-[11.5px] text-ink-4">{duration(item.durationMs)}</span>
        )}
      </div>
      {!waiting && item.answer && (
        <div
          className={cn('mt-1.5 ml-[23px] rounded-[12px] px-3.5 py-2.5', item.status === 'answered' ? 'bg-[var(--a-soft)] shadow-[inset_0_0_0_1px_var(--a-line)]' : 'bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]')}
          style={{ ['--clamp-bg' as string]: item.status === 'answered' ? 'color-mix(in oklab, var(--a2) 9%, var(--surface))' : 'var(--surface-2)' }}
        >
          {item.status === 'answered' ? <Clamp text={item.answer} lines={6} compact replyTo={item.to} /> : <span className="text-[12.5px] text-ink-3">{item.answer}</span>}
        </div>
      )}
    </div>
  )
})

/** A new agent this one started in the chat. Opens the agent's own conversation. */
export const SpawnCard = memo(function SpawnCard({ item, onOpen }: { item: Of<'spawn'>; onOpen(accountId: string): void }) {
  const agent = useAccountOf(item.agentId)
  const base = useAccountOf(item.base)
  const gone = !!agent?.spawned?.gone
  return (
    <div className="my-2.5 animate-rise" style={accentVars(agent?.accent)}>
      <button
        onClick={() => agent && !gone && onOpen(agent.id)}
        className="group/s flex w-full items-center gap-3 rounded-[14px] bg-[var(--a-soft)] px-3.5 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--a-line)] transition-shadow duration-200 hover:shadow-[inset_0_0_0_1px_var(--a2)]"
      >
        <Orb account={agent} size={26} off={gone} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-[13px]">
            <span className="font-semibold">{agent?.name || item.name}</span>
            <span className="text-ink-3">{gone ? 'was sent home' : 'joined the chat'}</span>
          </span>
          <span className="block truncate text-[12px] text-ink-2">{item.role}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-3">
          <UserPlus className="size-3.5" strokeWidth={1.75} />
          New agent{base ? ` on ${base.name}` : ''}
        </span>
      </button>
    </div>
  )
})

export const OutgoingRow = memo(function OutgoingRow({ item, onOpen }: { item: Of<'outgoing'>; onOpen(accountId: string): void }) {
  const to = useAccountOf(item.to)
  return (
    <div className="my-1.5 flex animate-rise items-start gap-2 text-[13px] text-ink-2">
      <CornerDownRight className="mt-[3px] size-[15px] shrink-0 text-ink-3" strokeWidth={1.75} />
      <div className="min-w-0">
        <button onClick={() => to && onOpen(to.id)} className="inline-flex items-center gap-1.5 align-middle font-medium text-ink hover:underline">
          <Orb account={to} size={13} /> {to?.name || 'teammate'}
        </button>
        <span className="selectable ml-1.5">{item.text}</span>
      </div>
    </div>
  )
})

// ───────────── asking you ─────────────

export const PermissionCard = memo(function PermissionCard({ item }: { item: Of<'permission'> }) {
  const [busy, setBusy] = useState(false)
  const s = describeTool(item.toolName, item.input)
  const input = (item.input && typeof item.input === 'object' ? item.input : {}) as Record<string, unknown>
  const command = typeof input.command === 'string' ? input.command : ''
  const file = typeof input.file_path === 'string' ? input.file_path : ''
  const plan = typeof input.plan === 'string' ? input.plan : ''
  // Letting a teammate take the mouse is a bigger yes than one command, and is worded that way.
  const hands = item.toolName === 'mcp__team__computer'
  const answer = (d: 'allow' | 'always' | 'deny'): void => {
    setBusy(true)
    void api.respondPermission(item.requestId, d)
  }

  if (item.status !== 'pending') {
    // Once allowed, the action's own row tells the story. Only a "no" needs a trace.
    if (item.status === 'allowed' || item.status === 'expired') return null
    const always = item.status === 'always'
    const what = hands ? 'control of this computer' : `${s.doing}${s.target ? ` ${s.target}` : ''}`
    return (
      <div className="my-1.5 flex items-center gap-2 text-[13px] text-ink-2">
        {always ? <Check className="size-[15px] shrink-0 text-ok" strokeWidth={2.25} /> : <X className="size-[15px] shrink-0 text-ink-3" strokeWidth={2.25} />}
        <span className="min-w-0 truncate">
          {always ? 'You chose to always allow this' : 'You declined'}
          <span className="ml-1.5 text-ink-3">{what}</span>
        </span>
      </div>
    )
  }

  return (
    <div className="my-3 animate-rise rounded-[14px] bg-warn-soft p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_30%,transparent)]">
      <div className="flex items-start gap-2.5">
        {hands ? <MousePointerClick className="mt-px size-[18px] shrink-0 text-warn" strokeWidth={1.9} /> : <ShieldQuestion className="mt-px size-[18px] shrink-0 text-warn" strokeWidth={1.9} />}
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] leading-snug font-semibold">{item.title}</div>
          {item.detail && <div className="mt-0.5 text-[12.5px] text-ink-2">{item.detail}</div>}
          {(command || file) && (
            <pre className="selectable mt-2.5 max-h-40 overflow-auto rounded-[9px] bg-surface px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-ink shadow-[inset_0_0_0_1px_var(--line)]">
              {command || file}
            </pre>
          )}
          {plan && (
            <div className="mt-2.5 max-h-72 overflow-auto rounded-[9px] bg-surface px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
              <Markdown text={plan} compact />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => answer('allow')}>
              {hands ? 'Allow in this chat' : 'Allow'}
            </Button>
            {item.canRemember && (
              <Button size="sm" disabled={busy} onClick={() => answer('always')}>
                {hands ? 'Always allow' : 'Always allow this'}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => answer('deny')}>
              Don't allow
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
})

/** An agent needs you signed in to a site in its browser. One click puts you there with the mouse. */
export const SignInCard = memo(function SignInCard({ item, chatId, accountId }: { item: Of<'signin'>; chatId: string; accountId: string }) {
  const account = useAccountOf(accountId)
  const watch = useStore((s) => s.watch)
  if (item.status !== 'pending') {
    return (
      <div className="my-1.5 flex items-center gap-2 text-[12.5px] text-ink-3">
        <KeyRound className="size-[15px] shrink-0" strokeWidth={1.75} />
        {item.status === 'done' ? `You signed in to ${item.site}` : item.status === 'skipped' ? `You skipped signing in to ${item.site}` : `The request to sign in to ${item.site} ended`}
      </div>
    )
  }
  return (
    <div className="my-3 animate-rise rounded-[14px] bg-surface p-4 shadow-float" style={accentVars(account?.accent)}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-[var(--a-soft)] text-[var(--a2)] shadow-[inset_0_0_0_1px_var(--a-line)]">
          <KeyRound className="size-[18px]" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">
            {account?.name} needs you to sign in to {item.site}
          </div>
          {item.why && <div className="selectable mt-0.5 text-[12.5px] leading-snug text-ink-2">{item.why}</div>}
          <div className="mt-1 text-[12px] text-ink-3">It is waiting. Sign in in its browser: your password goes straight to the site, never to the agent. The team keeps the sign-in for next time.</div>
        </div>
      </div>
      <div className="mt-3.5 flex flex-wrap items-center gap-2 pl-12">
        <Button variant="primary" size="sm" onClick={() => watch(`${chatId}:${accountId}:browser`, null, true)}>
          <Globe className="size-3.5" /> Open the browser and sign in
        </Button>
        <Button size="sm" onClick={() => void api.respondQuestion(item.requestId, { signedIn: 'yes' })}>
          <Check className="size-3.5" /> I have signed in
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void api.respondQuestion(item.requestId, null)}>
          Skip
        </Button>
      </div>
    </div>
  )
})

export const QuestionCard = memo(function QuestionCard({ item, accountId }: { item: Of<'question'>; accountId: string }) {
  const account = useAccountOf(accountId)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  if (item.status !== 'pending') {
    return (
      <div className="my-2 rounded-[12px] bg-surface-2 px-3.5 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--line)]">
        {item.status === 'answered' && item.answers ? (
          Object.entries(item.answers).map(([q, a]) => (
            <div key={q} className="py-0.5">
              <span className="text-ink-3">{q}</span> <span className="ml-1 font-medium">{a}</span>
            </div>
          ))
        ) : (
          <span className="text-ink-3">Question skipped</span>
        )}
      </div>
    )
  }

  const toggle = (q: string, label: string, multi?: boolean): void =>
    setPicked((p) => {
      const cur = p[q] || []
      return { ...p, [q]: multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] }
    })
  const answers = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const q of item.questions) {
      const parts = [...(picked[q.question] || [])]
      if (other[q.question]?.trim()) parts.push(other[q.question].trim())
      out[q.question] = parts.join(', ')
    }
    return out
  }
  const ready = item.questions.every((q) => (picked[q.question]?.length || 0) > 0 || !!other[q.question]?.trim())
  // An option that names a picture, a sound or a video gets it right there, to look at or play.
  const media = (o: { label: string; description?: string }): string[] => mediaPathsIn(`${o.label}\n${o.description || ''}`)
  // The path itself need not be read out once its file is on show.
  const quiet = (text: string, paths: string[]): string => paths.reduce((t, p) => t.replace(p, baseName(p)), text)

  return (
    <div className="my-3 animate-rise rounded-[14px] bg-surface p-4 shadow-float" style={accentVars(account?.accent)}>
      <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold">
        <Orb account={account} size={16} /> {account?.name} has a question
      </div>
      <div className="space-y-4">
        {item.questions.map((q) => (
          <div key={q.question}>
            <div className="mb-2 text-[13.5px] font-medium">{q.question}</div>
            {mediaPathsIn(q.question).length > 0 && <MediaStrip paths={mediaPathsIn(q.question)} className="mb-2" />}
            <div className="space-y-1.5">
              {q.options.map((o) => {
                const on = (picked[q.question] || []).includes(o.label)
                return (
                  <button
                    key={o.label}
                    onClick={() => toggle(q.question, o.label, q.multiSelect)}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-[10px] px-3 py-2 text-left transition-all',
                      on ? 'bg-[var(--a-soft)] shadow-[inset_0_0_0_1.5px_var(--a2)]' : 'shadow-[inset_0_0_0_1px_var(--line)] hover:bg-hover',
                    )}
                  >
                    <span className={cn('mt-[3px] flex size-3.5 shrink-0 items-center justify-center border', q.multiSelect ? 'rounded-[4px]' : 'rounded-full', on ? 'border-[var(--a2)] bg-[var(--a2)]' : 'border-ink-4')}>
                      {on && <Check className="size-2.5 text-white" strokeWidth={3.5} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">{o.label}</span>
                      {o.description && <span className="block text-[12px] leading-snug [overflow-wrap:anywhere] text-ink-3">{quiet(o.description, media(o))}</span>}
                      {media(o).length > 0 && (
                        <span className="mt-2 flex flex-wrap gap-2">
                          {media(o).map((p) => (
                            <MediaView key={p} path={p} compact label={o.label} />
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
              <input
                className={cn(inputClass, 'h-8')}
                placeholder="Something else…"
                value={other[q.question] || ''}
                onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" size="sm" disabled={!ready} onClick={() => void api.respondQuestion(item.requestId, answers())}>
          Send answer
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void api.respondQuestion(item.requestId, null)}>
          Skip
        </Button>
      </div>
    </div>
  )
})

// ───────────── small rows ─────────────

/**
 * The message a failed reply was answering, when it is still the latest one: what "Try again"
 * sends once more. Nothing when a newer message has been sent since, or the agent is busy again.
 */
function useRetry(item: { id: string }, chatId: string, accountId?: string): Of<'user'> | undefined {
  return useStore((s) => {
    if (!accountId) return undefined
    const k = agentKey(chatId, accountId)
    const st = s.agents[k]
    if (st && st.phase !== 'idle' && st.phase !== 'error') return undefined
    const list = s.items[k]
    if (!list) return undefined
    const at = list.findIndex((i) => i.id === item.id)
    if (at < 0) return undefined
    for (let i = list.length - 1; i > at; i--) if (list[i].kind === 'user') return undefined
    for (let i = at - 1; i >= 0; i--) {
      const it = list[i]
      if (it.kind === 'user') return it.text.trim() || it.attachments?.length ? it : undefined
    }
    return undefined
  })
}

export const NoticeRow = memo(function NoticeRow({ item, chatId, accountId }: { item: Of<'notice'>; chatId: string; accountId?: string }) {
  const next = useAccountOf(item.action?.kind === 'switch-lead' ? item.action.to : '')
  const run = useStore((s) => s.run)
  const send = useStore((s) => s.send)
  const retry = useRetry(item, chatId, item.level === 'error' ? accountId : undefined)
  const setFocus = useStore((s) => s.setFocus)
  const [busy, setBusy] = useState(false)
  if (item.action?.kind === 'resume') {
    // The app closed in the middle of work. One click puts everyone back on what they were doing.
    const open = !item.action.done
    return (
      <div
        className={cn(
          'my-3 animate-rise rounded-[14px] px-4 py-3.5 text-[13px]',
          open ? 'bg-warn-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_28%,transparent)]' : 'bg-surface-2',
        )}
      >
        <div className="flex items-start gap-2.5">
          <RotateCcw className={cn('mt-px size-4 shrink-0', open ? 'text-warn' : 'text-ink-3')} strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <div className={cn('font-semibold', !open && 'text-ink-2')}>{open ? 'Pick up where the team left off' : 'Picked up after the app closed'}</div>
            <div className="selectable mt-0.5 leading-snug text-ink-2">{item.text}</div>
          </div>
        </div>
        {open && (
          <div className="mt-3 flex flex-wrap items-center gap-2 pl-[26px]">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void run(api.resumeChat(chatId)).then(() => setBusy(false))
              }}
            >
              <Play className="size-3" fill="currentColor" /> Continue where they left off
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(api.dismissRecovery(chatId))}>
              Leave it
            </Button>
            <span className="text-[12px] text-ink-3">Or just type “continue”.</span>
          </div>
        )}
      </div>
    )
  }
  if (item.level === 'error') {
    const offer = item.action?.kind === 'switch-lead' && !item.action.done && next
    return (
      <div className="my-2 animate-rise rounded-[12px] bg-bad-soft px-3.5 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--bad)_25%,transparent)]">
        <div className="flex items-start gap-2.5">
          <CircleAlert className="mt-px size-4 shrink-0 text-bad" />
          <span className="selectable leading-snug">{item.text}</span>
        </div>
        {!offer && retry && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[26px]">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void send(retry.text, retry.attachments, accountId).finally(() => setBusy(false))
              }}
            >
              <RotateCcw className="size-3" /> Try again
            </Button>
            <span className="text-[12px] text-ink-2">Sends your last message again.</span>
          </div>
        )}
        {offer && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[26px]">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                // The new lead is caught up on the chat and gets your last message again.
                void run(api.setChatLead(chatId, next.id, true)).then((c) => {
                  setBusy(false)
                  if (c) setFocus(next.id)
                })
              }}
            >
              <Orb account={next} size={14} /> Continue with {next.name}
            </Button>
            <span className="text-[12px] text-ink-2">{next.name} takes over as lead, caught up on this chat.</span>
          </div>
        )}
      </div>
    )
  }
  const Icon = item.level === 'warn' ? AlertTriangle : Info
  return (
    <div className="my-1.5 flex items-start gap-2 text-[12.5px] text-ink-3">
      <Icon className={cn('mt-px size-[15px] shrink-0', item.level === 'warn' && 'text-warn')} strokeWidth={1.75} />
      <span className="selectable">{item.text}</span>
    </div>
  )
})

export const ImageCard = memo(function ImageCard({ item }: { item: Of<'image'> }) {
  if (item.media) {
    return (
      <div className="my-2.5 animate-rise">
        <MediaView path={item.path} />
      </div>
    )
  }
  return <PictureCard item={item} />
})

const PictureCard = memo(function PictureCard({ item }: { item: Of<'image'> }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <div className="group/img relative my-3 inline-block animate-rise overflow-hidden rounded-[14px] shadow-float">
      <img
        src={api.fileUrl(item.path)}
        alt={item.caption || baseName(item.path)}
        data-view-path={item.path}
        onError={() => setFailed(true)}
        onClick={(e) => viewFrom(e.currentTarget, item.path)}
        className="block max-h-[340px] max-w-full cursor-zoom-in object-contain"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/55 to-transparent px-3 pt-8 pb-2.5 text-[12px] text-white opacity-0 transition-opacity group-hover/img:opacity-100">
        <span className="min-w-0 flex-1 truncate">{baseName(item.path)}</span>
        <button onClick={() => void api.showInFolder(item.path)} className="pointer-events-auto flex items-center gap-1.5 rounded-[7px] bg-white/20 px-2 py-1 backdrop-blur-sm hover:bg-white/30">
          <FolderOpen className="size-3" /> Show in folder
        </button>
      </div>
    </div>
  )
})

/** Asks what an undo would touch, then offers it. */
function UndoButton({ item, chatId, accountId }: { item: Of<'turn'>; chatId: string; accountId: string }) {
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const p = await api.rewind(chatId, accountId, item.id, false)
      if (!p.ok) {
        toast(p.error || 'Those changes can no longer be undone.', 'warn')
        return
      }
      if (!p.files.length) {
        toast('The files already match how they were before this reply.')
        return
      }
      const names = p.files.slice(0, 6).map((f) => baseName(f))
      const more = p.files.length > names.length ? ` and ${p.files.length - names.length} more` : ''
      setModal({
        kind: 'confirm',
        title: p.files.length === 1 ? 'Put this file back?' : `Put ${p.files.length} files back?`,
        body: `${names.join(', ')}${more} will go back to how ${p.files.length === 1 ? 'it was' : 'they were'} before this reply. Changes made after it are undone too. The conversation itself stays.`,
        action: 'Undo changes',
        run: () =>
          void api.rewind(chatId, accountId, item.id, true).then(
            (r) => !r.ok && toast(r.error || 'The changes could not be undone.', 'error'),
            () => toast('The changes could not be undone.', 'error'),
          ),
      })
    } catch {
      toast('Those changes can no longer be undone.', 'warn')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button onClick={() => void start()} disabled={busy} className="flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 font-medium text-ink-3 opacity-0 transition-opacity group-hover/turn:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100">
      <Undo2 className="size-3" /> Undo file changes
    </button>
  )
}

/** What the lead is asked when you want its last answer checked by someone who did not write it. */
const CHECK =
  'Have your last answer checked by someone who has not seen your reasoning: start a fresh agent (or give it to a free teammate) to verify its claims against their sources, run whatever can be run, and look for what is missing or wrong. Then tell me what holds up and what does not, and fix what is wrong.'

/** Offers an independent check of the lead's latest answer, the thing a single chat with one model cannot give you. */
function CheckButton({ chatId, accountId }: { chatId: string; accountId: string }) {
  const send = useStore((s) => s.send)
  const [sent, setSent] = useState(false)
  return (
    <button
      disabled={sent}
      onClick={() => {
        setSent(true)
        void send(CHECK, undefined, accountId)
      }}
      title={chatId ? 'A fresh agent checks the answer, without seeing how it was reached' : undefined}
      className="flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 font-medium text-ink-3 opacity-0 transition-opacity group-hover/turn:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 disabled:opacity-60"
    >
      <ShieldCheck className="size-3" /> {sent ? 'Checking…' : 'Have it checked'}
    </button>
  )
}

export const TurnFooter = memo(function TurnFooter({ item, chatId, accountId }: { item: Of<'turn'>; chatId: string; accountId: string }) {
  // Offered under the lead's latest finished reply, when there is anyone to do the checking.
  const canCheck = useStore((s) => {
    if (item.status !== 'done' || item.durationMs < 1500) return false
    const lead = s.chats.find((c) => c.id === chatId)?.leadId || s.settings.leadId
    const isLead = accountId === lead || (!lead && s.accounts.find((a) => a.enabled)?.id === accountId)
    if (!isLead || (s.settings.maxAgents === 0 && s.accounts.filter((a) => a.enabled).length < 2)) return false
    const list = s.items[agentKey(chatId, accountId)]
    return !!list && [...list].reverse().find((i) => i.kind === 'turn')?.id === item.id
  })
  if (item.status === 'error') return <div className="h-2" />
  const parts: string[] = []
  if (item.status === 'interrupted') parts.push('Stopped')
  else if (item.durationMs >= 1500) parts.push(`Worked for ${duration(item.durationMs)}`)
  // A token count on its own under a one-line reply is noise.
  if (parts.length && item.tokens && item.tokens >= 500) parts.push(`${compactNumber(item.tokens)} tokens`)
  if (item.undone) parts.push('file changes undone')
  const canUndo = !!item.checkpoint && !item.undone
  if (!parts.length && !canUndo && !canCheck) return <div className="h-3" />
  return (
    <div className="group/turn tabular mt-1 mb-3 flex min-h-[20px] items-center gap-2 text-[11.5px] text-ink-4">
      <span>{parts.join(' · ')}</span>
      {canUndo && <UndoButton item={item} chatId={chatId} accountId={accountId} />}
      {canCheck && <CheckButton chatId={chatId} accountId={accountId} />}
    </div>
  )
})

export function WorkingLine({ account, state }: { account: Account | undefined; state: AgentState }) {
  const elapsed = useElapsed(state.turnStartedAt)
  return (
    <div className="flex animate-fade-in items-center gap-2.5 py-2 text-[13px]">
      <Orb account={account} size={16} live />
      <span className="shimmer-text font-medium">{state.activity || 'Working'}</span>
      {elapsed > 4000 && <span className="tabular text-[12px] text-ink-4">{duration(elapsed)}</span>}
      {state.queued > 0 && <span className="text-[12px] text-ink-4">· {state.queued} waiting</span>}
      {state.phase === 'starting' && <Spinner className="size-3" />}
    </div>
  )
}
