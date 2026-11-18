// Small marks in the network's own language, for places outside the network that talk about the
// same team: a fan (one agent handing work to several), and a neuron dot for one task's state.

import { useId } from 'react'
import type { Account, Task } from '@shared/types'
import { ACCENT, cn } from '@/lib/util'
import { useDark } from './Neural'

/** One agent on the left handing work to several on the right, as the network draws it. */
export function FanMark({ from, to, states, className }: { from?: Account; to: Account[]; states?: (Task['status'] | undefined)[]; className?: string }) {
  const dark = useDark()
  const id = `fan${useId().replace(/:/g, '')}`
  const shown = to.slice(0, 7)
  const W = 58
  const H = 32
  const sx = 6
  const sy = H / 2
  const tx = W - 6
  const step = shown.length > 1 ? (H - 8) / (shown.length - 1) : 0
  const ys = shown.map((_, i) => (shown.length > 1 ? 4 + i * step : sy))
  const split = { x: W * 0.52, y: sy }
  const col = (a?: Account): string => {
    const c = ACCENT[a?.accent || 'slate']
    return dark ? c.from : c.to
  }
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={cn('shrink-0 overflow-visible', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--ux-1)' }} />
          <stop offset="1" style={{ stopColor: 'var(--ux-3)' }} />
        </linearGradient>
      </defs>
      <path d={`M ${sx} ${sy} L ${split.x} ${split.y}`} fill="none" strokeWidth={1.8} strokeLinecap="round" style={{ stroke: `url(#${id})` }} />
      {shown.map((a, i) => {
        const y = ys[i]
        const c = (split.x + tx) / 2
        const st = states?.[i]
        return (
          <path
            key={a.id}
            d={`M ${split.x} ${split.y} C ${c} ${split.y} ${c} ${y} ${tx} ${y}`}
            fill="none"
            strokeWidth={1}
            strokeLinecap="round"
            strokeOpacity={st === 'running' ? 0.9 : 0.45}
            style={{ stroke: col(a) }}
          />
        )
      })}
      <circle cx={sx} cy={sy} r={4.2} style={{ fill: col(from) }} />
      {shown.map((a, i) => (
        <StateDotAt key={a.id} x={tx} y={ys[i]} r={2.6} color={col(a)} status={states?.[i]} />
      ))}
    </svg>
  )
}

function StateDotAt({ x, y, r, color, status }: { x: number; y: number; r: number; color: string; status?: Task['status'] }) {
  if (status === 'queued') return <circle cx={x} cy={y} r={r} strokeWidth={1.2} style={{ fill: 'var(--surface)', stroke: color }} />
  if (status === 'failed') return <circle cx={x} cy={y} r={r + 0.6} strokeWidth={1.4} style={{ fill: 'var(--surface)', stroke: 'var(--bad)' }} />
  return (
    <>
      {status === 'running' && <circle cx={x} cy={y} r={r + 2.6} opacity={0.25} style={{ fill: color }} />}
      <circle cx={x} cy={y} r={status === 'running' ? r + 0.6 : r} opacity={status === 'done' ? 0.75 : 1} style={{ fill: color }} />
    </>
  )
}

/** One task's state as a neuron: solid and glowing while it works, hollow while it waits, quiet when done. */
export function StateDot({ status, account, size = 10 }: { status?: Task['status']; account?: Account; size?: number }) {
  const dark = useDark()
  const c = ACCENT[account?.accent || 'slate']
  const color = dark ? c.from : c.to
  const r = size / 2 - 2
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className="shrink-0 overflow-visible" aria-hidden>
      <StateDotAt x={0} y={0} r={r} color={color} status={status} />
    </svg>
  )
}
