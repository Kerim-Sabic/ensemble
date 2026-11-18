import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentState } from '@shared/types'
import { agentKey, isBusy, useStore } from '@/store'
import { accentVars, cn, siteOf } from '@/lib/util'
import { Orb } from '../Orb'
import { StatusMark } from '../team/TeamBoard'
import type { Status } from '../team/model'
import { LiveFrame, Pointer, SurfaceIcon } from './Screen'
import type { ScreenEntry } from './LiveView'

// Every live screen at once, in an even grid that fills the space it has: 2 side by side,
// 4 as two by two, 6 as three by two, and so on, each tile at the screen's own shape.
// Small tiles get an occasional picture; the one you rest on gets every frame.

const GAP = 12
const CAPTION = 40
/** Up to this many tiles, each one gets every frame. */
const FULL_UP_TO = 2

/** The tile width that makes `n` tiles of `ratio` as large as they can be in `w` by `h`. */
export function gridFor(n: number, w: number, h: number, ratio: number): { cols: number; tileW: number } {
  let best = { cols: 1, tileW: 0 }
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols)
    const byW = (w - (cols - 1) * GAP) / cols
    // A few pixels to spare on each row, so rounding never pushes the last row out of sight.
    const byH = ((h - (rows - 1) * GAP) / rows - CAPTION - 4) * ratio
    // One pixel short, so fractional widths never wrap a row early.
    const tileW = Math.floor(Math.min(byW, byH)) - 1
    // Nearly as large and wider, like the screens themselves, wins: six make three by two, not two by three.
    if (tileW > best.tileW * 1.06 || (tileW > best.tileW * 0.94 && cols > best.cols && rows <= Math.ceil(n / best.cols))) best = { cols, tileW }
  }
  return best
}

const statusOf = (st: AgentState | undefined): Status => (st?.phase === 'waiting' ? 'needs' : st?.phase === 'error' ? 'problem' : isBusy(st) ? 'working' : 'free')

function Caption({ entry, chatId, big }: { entry: ScreenEntry; chatId: string; big?: boolean }) {
  const st = useStore((s): AgentState | undefined => s.agents[agentKey(chatId, entry.account.id)])
  const status = statusOf(st)
  const latest = entry.steps[entry.steps.length - 1]
  const what = status === 'needs' ? st?.activity || 'Needs your OK' : status === 'working' ? st?.activity || 'Working' : latest?.label || entry.screen?.title || 'Ready'
  const where = entry.kind === 'browser' ? siteOf(entry.screen?.url || '') || entry.screen?.title : 'This computer'
  return (
    <div className={cn('flex shrink-0 items-center gap-2 px-3', big ? 'h-11 text-[13px]' : 'h-10 text-[12.5px]')}>
      <Orb account={entry.account} size={big ? 20 : 18} phase={st?.phase} />
      <span className="max-w-[45%] shrink-0 truncate font-medium">{entry.account.name}</span>
      <span className={cn('min-w-0 flex-1 truncate', status === 'working' ? 'shimmer-text' : status === 'needs' ? 'font-medium text-warn' : 'text-ink-3')}>{what}</span>
      {where && <span className="hidden max-w-[30%] shrink-0 truncate text-[11.5px] text-ink-4 @[300px]:inline">{where}</span>}
      {/* Live sits here in the caption, not over the page, so the picture is never covered. */}
      {entry.screen?.active && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-[#e5483d] dark:text-[#ff7a70]" title="Live">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-[#ff5b4f]" />
          <span className="hidden @[240px]:inline">Live</span>
        </span>
      )}
      <StatusMark status={status} />
    </div>
  )
}

function Picture({ entry, full, small }: { entry: ScreenEntry; full: boolean; small: boolean }) {
  const lastShot = [...entry.steps].reverse().find((s) => s.shot)?.shot
  const sc = entry.screen
  return (
    <div className="relative w-full overflow-hidden bg-surface-3" style={{ aspectRatio: sc ? `${sc.width} / ${sc.height}` : '16 / 10', ...accentVars(entry.account.accent) }}>
      {sc ? (
        <LiveFrame screenKey={entry.key} still={lastShot} full={full} className="absolute inset-0 size-full object-fill" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <SurfaceIcon kind={entry.kind} className="size-6 text-ink-4" />
        </div>
      )}
      {sc?.pointer && <Pointer pointer={sc.pointer} account={entry.account} small={small} />}
    </div>
  )
}

const Tile = memo(function Tile({ entry, chatId, width, full, peeked, onFocus, onHover }: { entry: ScreenEntry; chatId: string; width: number; full: boolean; peeked: boolean; onFocus(key: string): void; onHover(key: string | null, el: HTMLElement | null): void }) {
  const working = !!entry.screen?.active
  return (
    <button
      data-live-tile={entry.key}
      onClick={() => onFocus(entry.key)}
      onMouseEnter={(e) => onHover(entry.key, e.currentTarget)}
      onMouseLeave={() => onHover(null, null)}
      style={{ width, ...accentVars(entry.account.accent) }}
      className={cn(
        '@container flex flex-col overflow-hidden rounded-[12px] bg-surface text-left shadow-card transition-[box-shadow,opacity] duration-200 hover:shadow-float focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--link)]',
        working && 'shadow-[0_0_0_1px_color-mix(in_oklab,var(--a2)_45%,var(--line)),var(--shadow-card)]',
        peeked && 'opacity-40',
      )}
    >
      <Picture entry={entry} full={full} small />
      <Caption entry={entry} chatId={chatId} />
    </button>
  )
})

export function LiveGrid({ entries, chatId, onFocus }: { entries: ScreenEntry[]; chatId: string; onFocus(key: string): void }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const first = entries[0]?.screen
  const ratio = first ? first.width / first.height : 16 / 10
  const { tileW } = gridFor(entries.length, size.w, size.h, ratio)

  // Resting on a tile shows it larger after a moment, over its neighbours, at every frame.
  const [peek, setPeek] = useState<{ key: string; x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onHover = useCallback((key: string | null, el: HTMLElement | null) => {
    clearTimeout(timer.current)
    if (!key || !el) {
      setPeek(null)
      return
    }
    timer.current = setTimeout(() => {
      const b = box.current?.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      if (b) setPeek({ key, x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 })
    }, 420)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (peek && !entries.some((e) => e.key === peek.key)) setPeek(null)
  }, [entries, peek])

  const peekEntry = peek && entries.find((e) => e.key === peek.key)
  // The peek is a good deal larger than the tile, but leaves the grid around it in sight.
  const peekW = Math.floor(Math.min(tileW * 1.6, size.w * 0.8, (size.h * 0.8 - CAPTION) * ratio))
  const peekH = peekW / ratio + CAPTION + 4
  const big = peekEntry && peekW > tileW * 1.15
  const left = peek ? Math.max(12, Math.min(size.w - peekW - 12, peek.x - peekW / 2)) : 0
  const top = peek ? Math.max(12, Math.min(size.h - peekH - 12, peek.y - peekH / 2)) : 0

  return (
    <div ref={box} className="relative min-h-0 flex-1">
      {tileW > 0 && (
        <div className="flex h-full flex-wrap content-center items-start justify-center overflow-hidden" style={{ gap: GAP }}>
          {entries.map((e) => (
            <Tile key={e.key} entry={e} chatId={chatId} width={tileW} full={entries.length <= FULL_UP_TO} peeked={!!big && peek?.key === e.key} onFocus={onFocus} onHover={onHover} />
          ))}
        </div>
      )}
      {big && peekEntry && (
        <div
          key={peekEntry.key}
          className="pointer-events-none absolute z-20 flex animate-pop flex-col overflow-hidden rounded-[14px] bg-surface shadow-pop"
          style={{ left, top, width: peekW, ...accentVars(peekEntry.account.accent) }}
        >
          <Picture entry={peekEntry} full small={false} />
          <Caption entry={peekEntry} chatId={chatId} big />
        </div>
      )}
    </div>
  )
}
