import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleAlert, Hourglass, LayoutGrid, ListChecks, MessageCircleQuestion, PanelRightClose, PanelRightOpen, Play, Reply, Square, StickyNote, UserPlus, Waypoints, Workflow, Network } from 'lucide-react'
import type { Account, AgentState, Item, Task } from '@shared/types'
import { agentKey, leadOf, useStore, useTeam } from '@/store'
import { accentVars, cn, duration, runLabel } from '@/lib/util'
import { YOU, gapLabel, layoutTimeline, teamBeats, turnSpans, type Beat, type BeatKind, type Span } from '@/lib/teamflow'
import { Button, Segmented, Tip } from './ui'
import { Orb } from './Orb'
import { TeamMap, type Packet } from './TeamMap'
import { TeamBoard } from './team/TeamBoard'
import { useMeasured } from './ultra/fit'
import { Markdown } from './Markdown'
import { NetworkView, takeNetworkWish } from './ultra/neural/NetworkView'

const EMPTY: Item[] = []

type FlowMode = 'groups' | 'map' | 'network'
const NO_TASKS: Task[] = []

const WORD: Record<BeatKind, string> = {
  said: 'asked',
  reply: 'answered',
  task: 'handed a task to',
  report: 'reported back to',
  note: 'passed a note to',
  question: 'asked',
  answer: 'answered',
  joined: 'started a new agent,',
}


function KindIcon({ kind, className }: { kind: BeatKind; className?: string }) {
  const p = { className, strokeWidth: 1.9 }
  if (kind === 'joined') return <UserPlus {...p} />
  if (kind === 'task') return <ListChecks {...p} />
  if (kind === 'report') return <Check {...p} strokeWidth={2.5} />
  if (kind === 'note') return <StickyNote {...p} />
  if (kind === 'question') return <MessageCircleQuestion {...p} />
  if (kind === 'answer' || kind === 'reply') return <Reply {...p} />
  return <ArrowRight {...p} />
}

/** The chat's transcripts, tasks and states, re-read only when something that matters to this view changed. */
function useFlow(chatId: string) {
  const team = useTeam(true)
  const leadId = useStore((s) => leadOf(s)?.id)
  const tasks = useStore((s) => s.tasks[chatId] ?? NO_TASKS)
  const sig = useStore((s) =>
    team
      .map((a) => {
        const items = s.items[agentKey(chatId, a.id)]
        if (!items?.length) return '0'
        // An answer arrives by changing an earlier row, so count those as well as the rows themselves.
        let answered = 0
        for (let i = items.length - 1, n = 0; i >= 0 && n < 300; i--, n++) if (items[i].kind === 'ask' && (items[i] as { status?: string }).status !== 'waiting') answered++
        return `${items.length}:${items[items.length - 1].id}:${answered}`
      })
      .join('|'),
  )
  const live = useStore((s) => team.map((a) => `${s.agents[agentKey(chatId, a.id)]?.phase || ''}:${s.agents[agentKey(chatId, a.id)]?.turnStartedAt || 0}`).join('|'))
  const byAccount = useMemo(() => {
    const st = useStore.getState()
    const out: Record<string, Item[]> = {}
    for (const a of team) out[a.id] = st.items[agentKey(chatId, a.id)] || EMPTY
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, chatId, team])
  const beats = useMemo(() => teamBeats(byAccount, leadId), [byAccount, leadId])
  return { team, leadId, tasks, byAccount, beats, live }
}

// ───────────── who worked when ─────────────

function Lanes({ team, spans, now, folded }: { team: Account[]; spans: Span[]; now: number; folded?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null)
  // Next to the board, which already shows each agent's time, it starts folded.
  const [open, setOpen] = useRemembered(folded ? 'ensemble.flow.lanes.groups' : 'ensemble.flow.lanes', !folded)
  const [room, setRoom] = useState(600)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const fit = (): void => setRoom(el.clientWidth)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const tl = useMemo(() => layoutTimeline(spans, room), [spans, room])
  // Keep the newest work in sight.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [tl?.width, spans.length])

  const rows = team.filter((a) => spans.some((s) => s.accountId === a.id))
  if (!tl || !rows.length) return null
  const worked = spans.reduce((ms, s) => ms + (s.end - s.start), 0)
  return (
    <div className="shrink-0 border-t border-line bg-surface/70">
      <button onClick={() => setOpen(!open)} className="flex h-9 w-full items-center gap-3 px-4 text-left text-[12px] hover:bg-hover/60">
        <ChevronDown className={cn('-ml-1 size-3.5 shrink-0 text-ink-4 transition-transform duration-200', !open && '-rotate-90')} />
        <span className="font-medium text-ink-2">Who worked when</span>
        <span className="text-ink-3">
          {duration(worked)} of work in all{tl.peak > 1 ? ` · up to ${tl.peak} at the same time` : ''}
        </span>
      </button>
      <div className={cn('flex max-h-[min(22vh,168px)] overflow-y-auto pb-3 [scrollbar-width:thin]', !open && 'hidden')}>
        <div className="w-[132px] shrink-0 space-y-1 pl-4">
          {rows.map((a) => (
            <div key={a.id} className="flex h-6 items-center gap-2 text-[12px]">
              <Orb account={a} size={14} />
              <span className="truncate">{a.name}</span>
            </div>
          ))}
        </div>
        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]">
          <div className="relative space-y-1" style={{ width: tl.width > room ? tl.width : '100%' }}>
            {tl.breaks.map((b, i) => (
              <Tip key={i} label={`Nobody was working for ${gapLabel(b.gap)}`} side="top">
                <span className="absolute top-0 bottom-0 z-[1] w-px border-l border-dashed border-line-2" style={{ left: b.x }} />
              </Tip>
            ))}
            {rows.map((a) => (
              <div key={a.id} className="relative h-6 rounded-[6px] bg-hover/60" style={accentVars(a.accent)}>
                {spans
                  .filter((s) => s.accountId === a.id)
                  .map((s) => {
                    const left = tl.x(s.start)
                    const width = Math.max(5, tl.x(s.live ? now : s.end) - left)
                    return (
                      <Tip key={s.id} label={`${s.label} · ${duration((s.live ? now : s.end) - s.start)}`} side="top">
                        <span
                          className={cn(
                            'absolute top-[3px] bottom-[3px] rounded-[5px] transition-[width] duration-700 ease-linear',
                            s.kind === 'task' ? 'bg-[var(--a2)]' : s.kind === 'you' ? 'bg-[color-mix(in_oklab,var(--a2)_62%,transparent)]' : 'bg-[color-mix(in_oklab,var(--a2)_34%,transparent)]',
                            s.live && 'animate-pulse-soft',
                          )}
                          style={{ left, width }}
                        />
                      </Tip>
                    )
                  })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────────── what they said to each other ─────────────

function Who({ id, accounts }: { id: string; accounts: Account[] }) {
  if (id === YOU) return <span className="font-medium">You</span>
  const a = accounts.find((x) => x.id === id)
  return (
    <span className="inline-flex items-center gap-1.5 font-medium">
      <Orb account={a} size={13} /> {a?.name || 'A teammate'}
    </span>
  )
}

const BeatRow = memo(function BeatRow({ beat, accounts, task, lit, onOpen }: { beat: Beat; accounts: Account[]; task: Task | undefined; lit: boolean; onOpen(home: string): void }) {
  const [open, setOpen] = useState(false)
  const sender = accounts.find((a) => a.id === beat.from)
  const failed = beat.kind === 'report' && beat.status && beat.status !== 'done'
  const long = beat.text.length > 150 || beat.text.includes('\n')
  return (
    <div
      data-beat={beat.id}
      style={accentVars(sender?.accent)}
      className={cn('group/b relative rounded-[12px] px-3 py-2.5 transition-colors duration-300', lit ? 'bg-[var(--a-soft)] shadow-[inset_0_0_0_1px_var(--a-line)]' : 'hover:bg-hover')}
    >
      <div className="flex items-center gap-1.5 text-[12.5px]">
        <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-full', beat.from === YOU ? 'bg-hover text-ink-2' : 'bg-[var(--a-soft)] text-[var(--a2)]', failed && 'bg-bad-soft text-bad')}>
          {failed ? <CircleAlert className="size-3" /> : beat.open ? <Hourglass className="size-2.5" /> : <KindIcon kind={beat.kind} className="size-3" />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Who id={beat.from} accounts={accounts} /> <span className="text-ink-3">{WORD[beat.kind]}</span> <Who id={beat.to} accounts={accounts} />
        </span>
        <span className="tabular shrink-0 text-[10.5px] text-ink-4">{new Date(beat.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <Tip label="Open in the chat" side="left">
          <button onClick={() => onOpen(beat.home)} aria-label="Open in the chat" className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-4 opacity-0 transition-opacity group-hover/b:opacity-100 hover:bg-active hover:text-ink">
            <ArrowUpRight className="size-3" />
          </button>
        </Tip>
      </div>
      {(beat.title || (task && runLabel(task)) || task?.waitingOn?.length) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[24px] text-[12.5px]">
          {beat.title && <span className="font-medium">{beat.title}</span>}
          {beat.kind === 'task' && task && runLabel(task) && <span className="text-[11px] text-ink-3">{runLabel(task)}</span>}
          {beat.kind === 'task' && task?.after?.length ? <span className="text-[11px] text-ink-3">{task.waitingOn?.length ? (task.waitingFor ? `waiting for ${task.waitingFor}` : 'waiting') : task.afterFor ? `after ${task.afterFor}` : 'lined up'}</span> : null}
        </div>
      )}
      <button onClick={() => long && setOpen((o) => !o)} className={cn('mt-0.5 block w-full pl-[24px] text-left', long ? 'cursor-pointer' : 'cursor-default')}>
        {open ? (
          <Markdown text={beat.text} compact className="!text-ink-2" />
        ) : (
          <span className="line-clamp-2 text-[12.5px] leading-snug [overflow-wrap:anywhere] text-ink-2">{beat.text.replace(/\s+/g, ' ').replace(/[*_`#]+/g, '').slice(0, 260)}</span>
        )}
      </button>
      {beat.open && <div className="mt-1 pl-[24px] text-[11.5px] text-ink-3">Waiting for the answer…</div>}
    </div>
  )
})

type Filter = 'all' | 'work' | 'talk'

/** A yes-or-no that is remembered between visits, such as whether a panel is open. */
function useRemembered(key: string, start: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s === null ? start : s === '1'
    } catch {
      return start
    }
  })
  const set = useCallback(
    (next: boolean) => {
      setV(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        /* forgotten next time */
      }
    },
    [key],
  )
  return [v, set]
}

/** Work changing hands, as opposed to talk: a task, its report, or a new agent being started. */
const isWork = (b: Beat): boolean => b.kind === 'task' || b.kind === 'report' || b.kind === 'joined'

function Feed({ beats, tasks, accounts, lit, replaying, onReplay, onHide, over }: { beats: Beat[]; tasks: Task[]; accounts: Account[]; lit: string | null; replaying: boolean; onReplay(): void; onHide(): void; over?: boolean }) {
  const [filter, setFilter] = useState<Filter>('all')
  const setFocus = useStore((s) => s.setFocus)
  const setView = useStore((s) => s.setView)
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const shown = useMemo(() => (filter === 'all' ? beats : beats.filter((b) => isWork(b) === (filter === 'work'))), [beats, filter])

  useEffect(() => {
    const el = list.current
    if (el && stick.current && !replaying) el.scrollTop = el.scrollHeight
  }, [shown.length, replaying])
  // During a replay, follow whichever exchange is travelling across the map.
  useEffect(() => {
    if (lit) list.current?.querySelector(`[data-beat="${lit}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [lit])

  const open = useCallback(
    (home: string) => {
      setFocus(home)
      setView('chat')
    },
    [setFocus, setView],
  )
  const work = beats.filter(isWork).length

  return (
    <aside className={cn('flex shrink-0 flex-col bg-surface', over ? 'absolute top-0 right-0 bottom-0 z-40 w-[min(380px,92%)] animate-fade-in shadow-pop' : 'w-[336px] border-l border-line xl:w-[404px]')}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2.5 pl-4">
        <Tip label="Hide, to give the map more room" side="bottom">
          <button aria-label="Hide the conversation" onClick={onHide} className="-ml-1.5 flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-3 hover:bg-hover hover:text-ink">
            <PanelRightClose className="size-[15px]" />
          </button>
        </Tip>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">Between them</span>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', badge: beats.length || undefined },
            { value: 'work', label: 'Handoffs', badge: work || undefined },
            { value: 'talk', label: 'Talk', badge: beats.length - work || undefined },
          ]}
        />
      </div>
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2"
      >
        {shown.map((b) => (
          <BeatRow key={b.id} beat={b} accounts={accounts} task={b.taskId ? tasks.find((t) => t.id === b.taskId) : undefined} lit={lit === b.id} onOpen={open} />
        ))}
        {!shown.length && <p className="px-3 pt-4 text-[12.5px] leading-relaxed text-ink-3">{beats.length ? 'Nothing of that kind yet.' : 'Every message, task, question and report that passes between you and the team is listed here as it happens.'}</p>}
      </div>
      <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line px-3">
        <Button size="sm" onClick={onReplay} disabled={!beats.length}>
          {replaying ? <Square className="size-2.5 fill-current" strokeWidth={0} /> : <Play className="size-3 fill-current" strokeWidth={0} />}
          {replaying ? 'Stop' : 'Replay from the start'}
        </Button>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3">{replaying ? 'Watch the map.' : 'Plays every exchange across the map, in order.'}</span>
      </div>
    </aside>
  )
}

/** How the team is working together: who is talking to whom, what passed between them, and who worked when. */
export function TeamFlow() {
  const chatId = useStore((s) => s.chatId) || ''
  const { team, leadId, tasks, byAccount, beats, live } = useFlow(chatId)
  const [packets, setPackets] = useState<Packet[]>([])
  const [lit, setLit] = useState<string | null>(null)
  const [replaying, setReplaying] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [feed, setFeed] = useRemembered('ensemble.flow.feed', true)
  const [mapMode, setMapMode] = useRemembered('ensemble.flow.map', false)
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === chatId)?.ultra)
  // A chat in Ultra opens on the network; so does one sent here from the Ultra strip or mission
  // control. Picking another view sticks for that chat until you leave it.
  const [picked, setPicked] = useState<{ chat: string; mode: FlowMode } | null>(() => (takeNetworkWish(chatId) ? { chat: chatId, mode: 'network' } : null))
  useEffect(() => {
    if (takeNetworkWish(chatId)) setPicked({ chat: chatId, mode: 'network' })
  }, [chatId])
  const mode: FlowMode = picked?.chat === chatId ? picked.mode : ultra ? 'network' : mapMode ? 'map' : 'groups'
  const setMode = (m: FlowMode): void => {
    setPicked({ chat: chatId, mode: m })
    if (m !== 'network') setMapMode(m === 'map')
  }
  // With little room the conversation slides over the team instead of squeezing it.
  const [frame, frameW] = useMeasured<HTMLDivElement>()
  const narrow = frameW > 0 && frameW < 940
  const [overlay, setOverlay] = useState(false)
  const setFocus = useStore((s) => s.setFocus)
  const setView = useStore((s) => s.setView)
  const openAgent = useCallback(
    (id: string) => {
      setFocus(id)
      setView('chat')
    },
    [setFocus, setView],
  )

  // Whoever something was just handed to lights up for a moment on the board.
  const pinged = useMemo(() => new Set(packets.map((p) => p.to)), [packets])

  const launch = useCallback((b: Beat) => {
    const id = `${b.id}:${Math.random().toString(36).slice(2, 7)}`
    setPackets((p) => [...p.slice(-10), { id, from: b.from, to: b.to, kind: b.kind }])
    timers.current.push(setTimeout(() => setPackets((p) => p.filter((x) => x.id !== id)), 1500))
  }, [])

  // Anything that arrives while you are watching travels across the map. What was already there does not.
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(beats.map((b) => b.id))
      return
    }
    for (const b of beats) {
      if (seen.current.has(b.id)) continue
      seen.current.add(b.id)
      if (!replaying) launch(b)
    }
  }, [beats, launch, replaying])

  useEffect(() => {
    seen.current = null
    setPackets([])
    setLit(null)
    setReplaying(false)
  }, [chatId])

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t)
    },
    [],
  )

  // The bar of a turn in progress grows while you look at it.
  const anyLive = live.split('|').some((x) => x && !x.startsWith('idle') && !x.startsWith('error') && !x.startsWith(':'))
  useEffect(() => {
    if (!anyLive) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [anyLive])

  const spans = useMemo(() => {
    const st = useStore.getState()
    const states: Record<string, AgentState | undefined> = {}
    for (const a of team) states[a.id] = st.agents[agentKey(chatId, a.id)]
    return turnSpans(byAccount, states, now)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byAccount, live, chatId, team, anyLive ? now : 0])

  const replay = (): void => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
    setPackets([])
    if (replaying) {
      setReplaying(false)
      setLit(null)
      return
    }
    setReplaying(true)
    // Quick enough to watch a whole chat, slow enough to follow each step.
    const step = Math.max(380, Math.min(900, 22000 / Math.max(1, beats.length)))
    beats.forEach((b, i) => {
      timers.current.push(
        setTimeout(() => {
          setLit(b.id)
          launch(b)
        }, i * step),
      )
    })
    timers.current.push(
      setTimeout(
        () => {
          setReplaying(false)
          setLit(null)
        },
        beats.length * step + 900,
      ),
    )
  }

  if (!chatId) return null
  if (!team.length) return null

  const beside = feed && !narrow
  const feedOpen = narrow ? overlay : feed
  const toggleFeed = (): void => (narrow ? setOverlay(!overlay) : setFeed(!feed))

  return (
    <div ref={frame} className="relative flex h-full min-h-0 bg-surface-2">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 px-5">
          <Segmented<FlowMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'groups', label: <><LayoutGrid className="size-3.5" /> Groups</> },
              { value: 'map', label: <><Workflow className="size-3.5" /> Map</> },
              { value: 'network', label: <><Network className="size-3.5" /> Network</> },
            ]}
          />
          <span className="min-w-0 flex-1" />
          {!beside && (
            <button
              onClick={toggleFeed}
              className={cn('flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12.5px] font-medium transition-colors', feedOpen ? 'bg-active text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink')}
            >
              <PanelRightOpen className="size-[15px]" /> Between them
              {beats.length > 0 && <span className="tabular rounded-full bg-active px-1.5 text-[10.5px] leading-[15px]">{beats.length}</span>}
            </button>
          )}
        </div>
        {mode === 'network' ? (
          <NetworkView chatId={chatId} onOpen={openAgent} />
        ) : mode === 'map' ? (
          <div className="relative flex min-h-0 flex-1 flex-col border-t border-line">
            {beats.length === 0 && (
              <div className="pointer-events-none absolute top-4 left-0 z-20 flex w-full justify-center px-8">
                <div className="flex max-w-[460px] items-start gap-2.5 rounded-[14px] bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-ink-2 shadow-card">
                  <Waypoints className="mt-0.5 size-4 shrink-0 text-ink-3" strokeWidth={1.75} />
                  This is the team for this chat. Ask the lead for something, and you will see each task, question and report travel between them here.
                </div>
              </div>
            )}
            <TeamMap chatId={chatId} team={team} leadId={leadId} beats={beats} tasks={tasks} packets={packets} onOpen={openAgent} />
          </div>
        ) : (
          <TeamBoard chatId={chatId} team={team} leadId={leadId} tasks={tasks} pinged={pinged} onOpen={openAgent} />
        )}
        {mode !== 'network' && <Lanes key={mode} team={team} spans={spans} now={now} folded={mode === 'groups'} />}
      </div>
      {beside && <Feed beats={beats} tasks={tasks} accounts={team} lit={lit} replaying={replaying} onReplay={replay} onHide={() => setFeed(false)} />}
      {narrow && overlay && <Feed over beats={beats} tasks={tasks} accounts={team} lit={lit} replaying={replaying} onReplay={replay} onHide={() => setOverlay(false)} />}
    </div>
  )
}
