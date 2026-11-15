import type { CSSProperties } from 'react'
import type { Account, AgentPhase, UsageWindow } from '@shared/types'
import { paceWord, type Budget, type Pace } from '@shared/budget'
import { accentVars, cn } from '@/lib/util'

/**
 * An agent's face: a small glass sphere in the agent's colour. It gains a
 * turning rim while the agent is working and a badge when it needs you.
 */
export function Orb({
  account,
  size = 22,
  live,
  phase,
  off,
  className,
  style,
}: {
  account: Pick<Account, 'accent'> | undefined
  size?: number
  live?: boolean
  phase?: AgentPhase
  off?: boolean
  className?: string
  style?: CSSProperties
}) {
  const working = live ?? (!!phase && phase !== 'idle' && phase !== 'error' && phase !== 'waiting')
  return (
    <span
      className={cn('orb inline-block', className)}
      data-live={working ? 'true' : undefined}
      data-off={off ? 'true' : undefined}
      style={{ width: size, height: size, fontSize: size, ...accentVars(account?.accent), ...style }}
    >
      {phase === 'waiting' && <Badge className="bg-warn" pulse />}
      {phase === 'error' && <Badge className="bg-bad" />}
    </span>
  )
}

function Badge({ className, pulse }: { className: string; pulse?: boolean }) {
  return (
    <span
      className={cn(
        'absolute -right-[12%] -bottom-[12%] z-10 size-[38%] min-h-[7px] min-w-[7px] rounded-full shadow-[0_0_0_1.5px_var(--surface)]',
        pulse && 'animate-pulse-soft',
        className,
      )}
    />
  )
}

/** Overlapping orbs for a group of teammates. */
export function OrbStack({ accounts, size = 16, max = 4 }: { accounts: (Pick<Account, 'accent' | 'id'> & { live?: boolean })[]; size?: number; max?: number }) {
  const shown = accounts.slice(0, max)
  return (
    <span className="inline-flex items-center">
      {shown.map((a, i) => (
        <Orb key={a.id} account={a} size={size} live={a.live} style={{ marginLeft: i ? -size * 0.28 : 0, zIndex: shown.length - i }} />
      ))}
    </span>
  )
}

/** A thin ring showing how much of an allowance window is used. */
export function UsageRing({ window: w, size = 18, stroke = 2.25 }: { window?: UsageWindow; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const u = w ? Math.min(1, Math.max(0, w.utilization)) : 0
  const color = !w ? 'var(--ink-4)' : u >= 0.9 ? 'var(--bad)' : u >= 0.7 ? 'var(--warn)' : 'var(--ink-2)'
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-2)" strokeWidth={stroke} />
      {w && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(u, 0.02))}
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.22,1,0.36,1), stroke 0.3s' }}
        />
      )}
    </svg>
  )
}

/**
 * A small fuel gauge for an account: how much of the current allowance window
 * is left. It empties as the account works and turns amber, then red.
 */
export function UsageMeter({ window: w, className }: { window?: UsageWindow; className?: string }) {
  const used = w ? Math.min(1, Math.max(0, w.utilization)) : 0
  const left = 1 - used
  const tone = !w ? 'bg-ink-4' : left <= 0.1 ? 'bg-bad' : left <= 0.3 ? 'bg-warn' : 'bg-ok'
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5', className)}>
      <span className="tabular w-[30px] text-right text-[10.5px] text-ink-3">{w ? `${Math.round(left * 100)}%` : ''}</span>
      <span className="block h-[5px] w-[22px] overflow-hidden rounded-full bg-line-2">
        <span className={cn('block h-full rounded-full transition-[width] duration-700 ease-out', tone)} style={{ width: `${Math.max(left * 100, w ? 6 : 0)}%` }} />
      </span>
    </span>
  )
}

const PACE_TONE: Record<Pace, string> = { spend: 'bg-ok', steady: 'bg-ink-3', save: 'bg-warn', out: 'bg-bad' }

/**
 * An account's allowance at a glance: what is left of the session as a number, and three
 * short bars for the session, the week and the strongest model's own allowance. A bar is
 * green when there is more left than the time to its refill calls for, amber when it is
 * being used up too fast, red when it is gone.
 */
export function BudgetMeter({ budget, className }: { budget: Budget; className?: string }) {
  const rows = [budget.session, budget.weekly, budget.top]
  const lead = budget.session || budget.weekly
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5', className)}>
      <span className="tabular w-[30px] text-right text-[10.5px] text-ink-3">{lead ? `${Math.round(lead.left * 100)}%` : ''}</span>
      <span className="flex w-[22px] flex-col gap-[2px]">
        {rows.map((w, i) => (
          <span key={i} className="block h-[3px] overflow-hidden rounded-full bg-line-2">
            {w && <span className={cn('block h-full rounded-full transition-[width] duration-700 ease-out', PACE_TONE[w.pace])} style={{ width: `${Math.max(w.left * 100, w.pace === 'out' ? 100 : 8)}%` }} />}
          </span>
        ))}
      </span>
    </span>
  )
}

/** A word on how an allowance is doing against the time it has to last. */
export function PaceChip({ pace }: { pace: Pace }) {
  const tone = pace === 'spend' ? 'bg-ok-soft text-ok' : pace === 'save' ? 'bg-warn-soft text-warn' : pace === 'out' ? 'bg-bad-soft text-bad' : 'bg-hover text-ink-3'
  return <span className={cn('rounded-full px-1.5 py-px text-[10.5px] font-medium whitespace-nowrap', tone)}>{paceWord(pace)}</span>
}

export function UsageBar({ window: w, label, sub, pace }: { window?: UsageWindow; label: string; sub?: string; pace?: Pace }) {
  // Shown as what is left, like the gauge in the sidebar.
  const left = w ? 1 - Math.min(1, Math.max(0, w.utilization)) : 0
  const color = left <= 0.1 ? 'bg-bad' : left <= 0.3 ? 'bg-warn' : 'bg-ok'
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="flex min-w-0 items-baseline gap-1.5 font-medium text-ink">
          <span className="truncate">{label}</span>
          {w && pace && <PaceChip pace={pace} />}
        </span>
        <span className="tabular shrink-0 text-ink-3">{w ? `${Math.round(left * 100)}% left${sub ? ` · ${sub}` : ''}` : 'No data yet'}</span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-full bg-line">
        <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', color)} style={{ width: `${Math.max(left * 100, w ? 1.5 : 0)}%` }} />
      </div>
    </div>
  )
}
