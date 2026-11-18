// The strip above the message box that shows what this chat is doing by itself: its goal, how
// far it has come and what is still missing, and the loops that send a message again on their
// own. Everything here can be paused, stopped or changed with one click.

import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Clock, Pause, Pencil, Play, Plus, Repeat, Square, StepForward, Target, X } from 'lucide-react'
import type { Chat, Goal, Loop } from '@shared/types'
import { countdown, everyLabel, goalLine, loopLine } from '@shared/auto'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Button, IconButton, Tip } from '../ui'
import { LoopEditor } from '../auto/LoopEditor'
import { MetMark, RoundMeter, goalDoneLine, useNow } from '../auto/shared'

const EASE = [0.22, 1, 0.36, 1] as const

/** Opens and closes its content by height, smoothly. */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: EASE }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const Dot = () => <span className="text-ink-4">·</span>

// ───────────── the goal ─────────────

function GoalRow({ chatId, goal, now }: { chatId: string; goal: Goal; now: number }) {
  const run = useStore((s) => s.run)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = (p: Promise<unknown>): void => {
    setBusy(true)
    void run(p).then(() => setBusy(false))
  }
  const st = goal.status
  const live = st === 'active' || st === 'paused' || st === 'blocked'
  const left = live && goal.deadline ? countdown(goal.deadline, now) : ''
  const checking = st === 'active' && !!goal.checking

  const status =
    st === 'met' ? (
      <span className="font-medium text-ok">{goalDoneLine(goal)}</span>
    ) : st === 'blocked' ? (
      <span className="font-medium text-warn">Needs you</span>
    ) : checking ? (
      <span className="shimmer-text font-medium">{goalLine(goal)}</span>
    ) : (
      <span className={cn(st === 'paused' || st === 'stopped' ? 'text-ink-3' : 'text-ink-2')}>{goalLine(goal)}</span>
    )

  // The second line: what is still missing, or how it will be judged before the first check.
  const sub = goal.note || (goal.doneWhen ? `Done when ${goal.doneWhen.replace(/^done when\s+/i, '')}` : st === 'active' && !goal.log.length ? 'It is checked after every reply until it is done' : '')

  return (
    <div className={cn('transition-colors duration-300', st === 'blocked' && 'bg-warn-soft', st === 'met' && 'bg-ok-soft')}>
      <div className="flex items-center gap-2.5 py-2 pr-1.5 pl-3">
        <Tip label={st === 'met' ? 'Goal met' : 'Goal: the team keeps working until this is done'} side="top">
          <span className="flex size-5 shrink-0 items-center justify-center">
            {st === 'met' ? (
              <MetMark goal={goal} size={16} />
            ) : (
              <Target className={cn('size-4', st === 'blocked' ? 'text-warn' : st === 'active' ? 'text-ink' : 'text-ink-3', checking && 'animate-pulse-soft')} strokeWidth={2} />
            )}
          </span>
        </Tip>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5 text-[13px] leading-[18px]">
            <button onClick={() => setOpen((o) => !o)} className={cn('min-w-0 flex-1 truncate text-left font-medium', st === 'stopped' && 'text-ink-2')}>
              {goal.text}
            </button>
            {st !== 'met' && st !== 'stopped' && <RoundMeter goal={goal} className="max-[1000px]:hidden" />}
            <span className="tabular shrink-0 text-[12px]">{status}</span>
          </div>
          {(sub || left || goal.log.length > 0) && (
            <div className="mt-px flex min-w-0 items-center gap-1.5 text-[11.5px] leading-[16px] text-ink-3">
              {sub && <span className={cn('min-w-0 truncate', st === 'blocked' && 'text-ink-2')}>{sub}</span>}
              {left && (
                <>
                  {sub && <Dot />}
                  <span className="tabular flex shrink-0 items-center gap-1">
                    <Clock className="size-3" />
                    {left === 'now' ? 'Time is up' : `${left} left`}
                  </span>
                </>
              )}
              {goal.log.length > 0 && (
                <>
                  {(sub || left) && <Dot />}
                  <button onClick={() => setOpen((o) => !o)} className="shrink-0 font-medium text-ink-3 hover:text-ink">
                    {open ? 'Hide checks' : goal.log.length === 1 ? '1 check' : `${goal.log.length} checks`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {st === 'stopped' &&
            // Out of rounds: another batch. Stopped by hand with rounds to spare: carry on where it was.
            (goal.round + 1 >= goal.maxRounds ? (
              <Button size="sm" variant="soft" disabled={busy} onClick={() => act(api.goalAction(chatId, 'more'))}>
                <Plus className="size-3.5" /> Give it more rounds
              </Button>
            ) : (
              <Button size="sm" variant="soft" disabled={busy} onClick={() => act(api.goalAction(chatId, 'resume'))}>
                <Play className="size-3" /> Pick it up again
              </Button>
            ))}
          {(st === 'paused' || st === 'blocked') && (
            <IconButton label={st === 'blocked' ? 'Carry on: send the lead back to it' : 'Resume'} side="top" disabled={busy} onClick={() => act(api.goalAction(chatId, 'resume'))}>
              <Play className="size-3.5" />
            </IconButton>
          )}
          {st === 'active' && (
            <IconButton label="Pause" side="top" disabled={busy} onClick={() => act(api.goalAction(chatId, 'pause'))}>
              <Pause className="size-3.5" />
            </IconButton>
          )}
          {live && (
            <IconButton label="Stop working on this goal" side="top" disabled={busy} onClick={() => act(api.goalAction(chatId, 'stop'))}>
              <Square className="size-3 fill-current" strokeWidth={0} />
            </IconButton>
          )}
          {!live && (
            <IconButton label="Take the goal off" side="top" disabled={busy} onClick={() => act(api.setGoal(chatId, null))}>
              <X className="size-3.5" />
            </IconButton>
          )}
          <IconButton label={open ? 'Less' : 'More about this goal'} side="top" onClick={() => setOpen((o) => !o)}>
            <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
          </IconButton>
        </div>
      </div>
      <Fold open={open}>
        <div className="selectable space-y-2 pr-4 pb-3 pl-[42px] text-[12.5px] leading-[1.5]">
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{goal.text}</div>
          {goal.doneWhen && (
            <div className="text-ink-2">
              <span className="font-medium text-ink-3">Done when </span>
              {goal.doneWhen.replace(/^done when\s+/i, '')}
            </div>
          )}
          <div className="tabular text-[11.5px] text-ink-3">
            Set at {new Date(goal.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {goal.maxRounds} rounds at most · {goal.check === 'fresh' ? 'a fresh checker decides when it is met' : "the lead's own word decides when it is met"}
          </div>
          {goal.log.length > 0 && (
            <ol className="space-y-1 border-l border-line-2 pl-3">
              {goal.log.map((l, i) => (
                <li key={`${l.round}-${i}`} className="text-[12px] leading-snug">
                  <span className={cn('font-medium', l.met ? 'text-ok' : 'text-ink-2')}>
                    Round {l.round + 1}: {l.met ? 'met' : 'not yet'}
                  </span>
                  <span className="tabular text-ink-4"> · {new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {l.note && <div className="text-ink-2">{l.note}</div>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Fold>
    </div>
  )
}

// ───────────── loops ─────────────

function LoopRow({ chatId, loop, now }: { chatId: string; loop: Loop; now: number }) {
  const run = useStore((s) => s.run)
  const [busy, setBusy] = useState(false)
  const act = (p: Promise<unknown>): void => {
    setBusy(true)
    void run(p).then(() => setBusy(false))
  }
  const paused = loop.status === 'paused'
  const line = loopLine(loop, now)
  const bits = [
    cap(everyLabel(loop.every)),
    loop.maxRuns ? `${loop.runs} of ${loop.maxRuns} runs` : loop.runs === 1 ? '1 run so far' : `${loop.runs} runs so far`,
    loop.until ? `until ${loop.until}` : '',
  ].filter(Boolean)
  const last = paused && loop.note ? loop.note : loop.last
  return (
    <div className="flex items-center gap-2.5 py-2 pr-1.5 pl-3">
      <Tip label={`Loop: sent again ${everyLabel(loop.every)}`} side="top">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Repeat className={cn('size-4', paused ? 'text-ink-3' : 'text-ink', loop.running && 'animate-pulse-soft')} strokeWidth={2} />
        </span>
      </Tip>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2.5 text-[13px] leading-[18px]">
          <Tip label={loop.prompt} side="top">
            <span className={cn('min-w-0 flex-1 truncate font-medium', paused && 'text-ink-2')}>{loop.prompt}</span>
          </Tip>
          <span className={cn('tabular shrink-0 text-[12px]', loop.running ? 'shimmer-text font-medium' : paused ? 'text-ink-3' : 'text-ink-2')}>{line}</span>
        </div>
        <div className="mt-px flex min-w-0 items-center gap-1.5 text-[11.5px] leading-[16px] text-ink-3">
          <span className="shrink-0">{bits[0]}</span>
          {bits.slice(1).map((b) => (
            <span key={b} className="flex min-w-0 shrink items-center gap-1.5">
              <Dot />
              <span className="truncate">{b}</span>
            </span>
          ))}
          {last && (
            <span className="flex min-w-0 flex-[2] items-center gap-1.5">
              <Dot />
              <span className="truncate text-ink-2">
                {paused && loop.note ? '' : 'Last: '}
                {last}
              </span>
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Run now" side="top" disabled={busy || loop.running} onClick={() => act(api.runLoop(chatId, loop.id))}>
          <StepForward className="size-3.5" />
        </IconButton>
        <IconButton label={paused ? 'Resume' : 'Pause'} side="top" disabled={busy} onClick={() => act(api.updateLoop(chatId, loop.id, { status: paused ? 'active' : 'paused' }))}>
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </IconButton>
        <LoopEditor chatId={chatId} loop={loop}>
          <span className="inline-flex">
            <IconButton label="Edit" side="top">
              <Pencil className="size-3.5" />
            </IconButton>
          </span>
        </LoopEditor>
        <IconButton label="Remove this loop" side="top" disabled={busy} onClick={() => act(api.removeLoop(chatId, loop.id))}>
          <X className="size-3.5" />
        </IconButton>
      </div>
    </div>
  )
}

/** More than two loops fold into one line that says when the next one runs. */
function LoopGroup({ chatId, loops, now }: { chatId: string; loops: Loop[]; now: number }) {
  const [open, setOpen] = useState(false)
  if (loops.length <= 2) {
    return (
      <>
        {loops.map((l) => (
          <LoopRow key={l.id} chatId={chatId} loop={l} now={now} />
        ))}
      </>
    )
  }
  const running = loops.filter((l) => l.running).length
  const active = loops.filter((l) => l.status === 'active')
  const next = active.map((l) => l.nextAt).filter((t): t is number => !!t).sort((a, b) => a - b)[0]
  const summary = running ? `${running} running now` : next ? (next <= now ? 'A run is due' : `Next run in ${countdown(next, now)}`) : active.length ? `${active.length} at their own pace` : 'All paused'
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 py-2 pr-3 pl-3 text-left transition-colors hover:bg-hover">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Repeat className="size-4 text-ink" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {loops.length} loops
          <span className="font-normal text-ink-3"> · {active.length === loops.length ? 'all running' : `${active.length} running, ${loops.length - active.length} paused`}</span>
        </span>
        <span className={cn('tabular shrink-0 text-[12px]', running ? 'shimmer-text font-medium' : 'text-ink-2')}>{summary}</span>
        <ChevronDown className={cn('size-3.5 shrink-0 text-ink-3 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      <Fold open={open}>
        <div className="divide-y divide-line border-t border-line">
          {loops.map((l) => (
            <LoopRow key={l.id} chatId={chatId} loop={l} now={now} />
          ))}
        </div>
      </Fold>
    </div>
  )
}

// ───────────── the strip ─────────────

const NO_LOOPS: Loop[] = []

/** Shown above the message box while the chat has a goal (until it is taken off) or loops that are not over. */
export function AutoBar({ chatId }: { chatId: string }) {
  const chat = useStore((s): Chat | undefined => s.chats.find((c) => c.id === chatId))
  const goal = chat?.goal || null
  const all = chat?.loops ?? NO_LOOPS
  const loops = all.filter((l) => l.status !== 'done')
  const show = !!goal || loops.length > 0
  // The clock ticks only while something on screen counts down.
  const ticking = loops.some((l) => l.status === 'active' && !!l.nextAt) || (!!goal?.deadline && (goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked'))
  const now = useNow(show && ticking)

  return (
    <div className="mx-auto w-full max-w-[780px] px-7">
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            key="auto"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            // A little room on every side, so the clip does not cut the card's edge and shadow.
            className="-mx-1.5 -mt-1.5 overflow-hidden px-1.5 pt-1.5"
          >
            <div className="mb-2 max-h-[34vh] divide-y divide-line overflow-y-auto rounded-[14px] bg-surface shadow-card [scrollbar-width:thin]" data-auto-bar>
              {goal && <GoalRow key={goal.id} chatId={chatId} goal={goal} now={now} />}
              {loops.length > 0 && <LoopGroup chatId={chatId} loops={loops} now={now} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
