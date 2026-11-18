// Small pieces the goal and loop surfaces share: a clock that ticks only while needed, the
// round dots, and the one-time mark a goal gets when it is met.

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import type { Goal } from '@shared/types'
import { span } from '@shared/auto'
import { cn } from '@/lib/util'

/** The time now, refreshed every second while `on`. Nothing runs while it is off. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** Rounds started so far, the one under way included. */
export const roundsOf = (g: Goal): number => Math.min(g.round + 1, Math.max(g.maxRounds, 1))

/** "Done after 3 rounds · 14 min", or the plain status for anything else. */
export function goalDoneLine(g: Goal): string {
  const n = g.round + 1
  const took = g.endedAt ? ` · ${span(g.endedAt - g.createdAt)}` : ''
  return `Done after ${n} ${n === 1 ? 'round' : 'rounds'}${took}`
}

/**
 * How far a goal has come, as one dot per round. Past ten rounds the dots would crowd the line,
 * so it becomes a thin bar instead.
 */
export function RoundMeter({ goal, className }: { goal: Goal; className?: string }) {
  const max = Math.max(goal.maxRounds, 1)
  const done = goal.status === 'met'
  const at = roundsOf(goal)
  const live = goal.status === 'active'
  const tone = done ? 'bg-ok' : goal.status === 'blocked' ? 'bg-warn' : 'bg-ink-2'
  if (max <= 12) {
    return (
      <span className={cn('flex shrink-0 items-center gap-[3px]', className)} aria-hidden>
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            className={cn(
              'size-[5px] rounded-full transition-colors duration-300',
              i < at - 1 || (done && i < at) ? tone : i === at - 1 ? cn(tone, live && 'animate-pulse-soft') : 'bg-line-2',
            )}
          />
        ))}
      </span>
    )
  }
  return (
    <span className={cn('block h-[4px] w-14 shrink-0 overflow-hidden rounded-full bg-line-2', className)} aria-hidden>
      <span className={cn('block h-full rounded-full transition-[width] duration-500 ease-out', tone)} style={{ width: `${Math.max((at / max) * 100, 4)}%` }} />
    </span>
  )
}

/**
 * The check a met goal gets. It springs in, and a ring goes out from it once, only when the goal
 * was met a moment ago: opening an old chat does not replay it.
 */
export function MetMark({ goal, size = 16 }: { goal: Goal; size?: number }) {
  const fresh = !!goal.endedAt && Date.now() - goal.endedAt < 15_000
  return (
    <span className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {fresh && (
        <motion.span
          className="absolute inset-0 rounded-full border-[1.5px] border-ok"
          initial={{ scale: 0.6, opacity: 0.7 }}
          animate={{ scale: 2.1, opacity: 0 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
        />
      )}
      <motion.span
        className="flex size-full items-center justify-center rounded-full bg-ok text-white dark:text-[#10261a]"
        initial={fresh ? { scale: 0.3, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 520, damping: 22 }}
      >
        <Check style={{ width: size * 0.62, height: size * 0.62 }} strokeWidth={3.2} />
      </motion.span>
    </span>
  )
}
