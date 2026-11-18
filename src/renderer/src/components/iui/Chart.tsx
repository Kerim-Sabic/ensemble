// Charts, drawn as SVG by hand: bar (grouped, stacked, horizontal), line, area, pie and donut,
// scatter. Quiet hairline grid, round ticks, thin marks with a 4px rounded data end, a 2px
// surface gap between touching marks, a legend for two or more series, exact values on hover
// and from the keyboard, a table view, and a written summary for screen readers.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { BarChart3, Table2 } from 'lucide-react'
import { formatCompact, formatValue, niceTicks, type ChartBlock, type Format } from '@shared/iui'
import { cn } from '@/lib/util'
import { Card } from './kit'

export const seriesColor = (i: number): string => `var(--s${(i % 8) + 1})`

// ───────────── measuring text ─────────────

let ctx: CanvasRenderingContext2D | null = null
export function textWidth(s: string, size = 11, weight = 400): number {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return s.length * size * 0.56
  ctx.font = `${weight} ${size}px "Inter Variable", "Segoe UI", sans-serif`
  return ctx.measureText(s).width
}
/** Cut a label to fit a width, with an ellipsis. */
export function fit(s: string, max: number, size = 11): string {
  if (max <= 8) return ''
  if (textWidth(s, size) <= max) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (textWidth(s.slice(0, mid) + '…', size) <= max) lo = mid
    else hi = mid - 1
  }
  return lo ? s.slice(0, lo).trimEnd() + '…' : ''
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** A bar with a rounded data end and a square foot on the baseline. */
function bar(x: number, y: number, w: number, h: number, end: 'up' | 'down' | 'right' | 'left', r = 4): string {
  if (w <= 0 || h <= 0) return ''
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  if (end === 'up') return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
  if (end === 'down') return `M${x},${y}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w - rr}Q${x + w},${y + h} ${x + w},${y + h - rr}V${y}Z`
  if (end === 'right') return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`
  return `M${x + w},${y}H${x + rr}Q${x},${y} ${x},${y + rr}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w}Z`
}

type Fmt = { format: Format; unit?: string; big?: boolean }
const full = (v: number | null | undefined, f: Fmt): string => formatValue(v, f.format, f.unit)
const short = (v: number, f: Fmt): string => formatCompact(v, f.format, f.unit, f.big)

/** How a chart's numbers are written. One style per chart: if any value reaches 10,000, thousands are shortened everywhere. */
export function fmtOf(b: ChartBlock): Fmt {
  let top = 0
  for (const s of b.series) {
    for (const v of s.data) if (v != null) top = Math.max(top, Math.abs(v))
    for (const p of s.points || []) top = Math.max(top, Math.abs(p[1]))
  }
  if (b.stacked) for (let i = 0; i < b.x.length; i++) top = Math.max(top, b.series.reduce((t, s) => t + Math.abs(s.data[i] || 0), 0))
  return { format: b.format || 'number', unit: b.unit, big: top >= 1e4 }
}

// ───────────── the tooltip ─────────────

function Tip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: string; rows: { color: string; name: string; value: string; strong?: boolean }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(160)
  useEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth)
  })
  const left = x + 14 + w > width ? Math.max(0, x - 14 - w) : x + 14
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute z-10 min-w-[120px] max-w-[260px] rounded-[9px] bg-raised px-2.5 py-2 text-[12px] shadow-pop"
      style={{ left, top: Math.max(0, y) }}
    >
      <div className="mb-1 truncate text-[11.5px] font-medium text-ink-3">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 py-px">
          <span className="size-2 shrink-0 rounded-[3px]" style={{ background: r.color }} />
          <span className="min-w-0 flex-1 truncate text-ink-2">{r.name}</span>
          <span className={cn('tabular pl-2 text-ink', r.strong ? 'font-semibold' : 'font-medium')}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function Legend({ names, onHover, hover }: { names: string[]; onHover(i: number | null): void; hover: number | null }) {
  return (
    <div className="mb-2 flex flex-wrap gap-x-3.5 gap-y-1" role="list" aria-label="Legend">
      {names.map((n, i) => (
        <span
          key={i}
          role="listitem"
          onPointerEnter={() => onHover(i)}
          onPointerLeave={() => onHover(null)}
          className={cn('inline-flex items-center gap-1.5 text-[12px] text-ink-2 transition-opacity', hover != null && hover !== i && 'opacity-45')}
        >
          <span className="size-2.5 rounded-[3px]" style={{ background: seriesColor(i) }} />
          {n}
        </span>
      ))}
    </div>
  )
}

// ───────────── summary for screen readers ─────────────

export function summarize(b: ChartBlock, f: Fmt): string {
  const kindName = { bar: b.horizontal ? 'Horizontal bar chart' : 'Bar chart', line: 'Line chart', area: 'Area chart', pie: 'Pie chart', donut: 'Donut chart', scatter: 'Scatter chart' }[b.kind]
  const parts = [`${b.stacked && b.kind === 'bar' ? 'Stacked ' + kindName.toLowerCase() : kindName}${b.title ? `: ${b.title}` : ''}.`]
  if (b.kind === 'scatter') {
    for (const s of b.series) parts.push(`${s.name}: ${s.points?.length || 0} points.`)
    return parts.join(' ')
  }
  parts.push(`${b.x.length} ${b.x.length === 1 ? 'value' : 'values'}${b.x.length > 1 ? ` from ${b.x[0]} to ${b.x[b.x.length - 1]}` : ''}.`)
  for (const s of b.series) {
    let lo = -1
    let hi = -1
    s.data.forEach((v, i) => {
      if (v == null) return
      if (lo < 0 || v < (s.data[lo] as number)) lo = i
      if (hi < 0 || v > (s.data[hi] as number)) hi = i
    })
    if (hi < 0) continue
    parts.push(`${s.name}: highest ${full(s.data[hi], f)} (${b.x[hi]}), lowest ${full(s.data[lo], f)} (${b.x[lo]}).`)
  }
  return parts.join(' ')
}

function DataTable({ b, f }: { b: ChartBlock; f: Fmt }) {
  if (b.kind === 'scatter') {
    return (
      <div className="max-h-[300px] overflow-auto">
        <table>
          <thead>
            <tr>
              <th>Series</th>
              <th style={{ textAlign: 'right' }}>{b.xLabel || 'x'}</th>
              <th style={{ textAlign: 'right' }}>{b.yLabel || 'y'}</th>
            </tr>
          </thead>
          <tbody>
            {b.series.flatMap((s, si) =>
              (s.points || []).map((p, i) => (
                <tr key={`${si}-${i}`}>
                  <td>{s.name}</td>
                  <td className="tabular text-right">{formatValue(p[0], 'number')}</td>
                  <td className="tabular text-right">{full(p[1], f)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <div className="max-h-[300px] overflow-auto">
      <table>
        <thead>
          <tr>
            <th />
            {b.series.map((s, i) => (
              <th key={i} style={{ textAlign: 'right' }}>
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.x.map((x, i) => (
            <tr key={i}>
              <td>{x}</td>
              {b.series.map((s, j) => (
                <td key={j} className="tabular text-right">
                  {s.data[i] == null ? '' : full(s.data[i], f)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ───────────── cartesian: bar, line, area ─────────────

const AXIS_FONT = 11

function Cartesian({ b, f, width, hoverSeries, label }: { b: ChartBlock; f: Fmt; width: number; hoverSeries: number | null; label: string }) {
  const n = b.x.length
  const kind = b.kind
  const stacked = !!b.stacked && b.series.length > 1
  const height = width < 520 ? 220 : 260
  const [at, setAt] = useState<number | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // The range the axis must cover.
  const { lo, hi } = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    if (stacked) {
      for (let i = 0; i < n; i++) {
        let pos = 0
        let neg = 0
        for (const s of b.series) {
          const v = s.data[i]
          if (v == null) continue
          if (v >= 0) pos += v
          else neg += v
        }
        hi = Math.max(hi, pos)
        lo = Math.min(lo, neg)
      }
    } else {
      for (const s of b.series)
        for (const v of s.data) {
          if (v == null) continue
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
    }
    if (!Number.isFinite(lo)) return { lo: 0, hi: 1 }
    // Bars and areas stand on zero. A line may float, unless zero is close anyway.
    if (kind !== 'line' || lo > 0 === false || lo < hi * 0.35) {
      lo = Math.min(0, lo)
      hi = Math.max(0, hi)
    }
    return { lo, hi }
  }, [b, n, stacked, kind])

  const ticks = useMemo(() => niceTicks(lo, hi, height < 240 ? 4 : 5), [lo, hi, height])
  const y0 = ticks[0]
  const y1 = ticks[ticks.length - 1]
  const tickLabels = ticks.map((t) => short(t, f))
  const left = Math.ceil(Math.max(...tickLabels.map((t) => textWidth(t, AXIS_FONT)))) + 10
  const right = 10
  const top = 10
  const bottom = 26
  const pw = Math.max(40, width - left - right)
  const ph = height - top - bottom
  const sy = (v: number): number => top + ph - ((v - y0) / (y1 - y0 || 1)) * ph
  const isBar = kind === 'bar'
  const band = pw / Math.max(1, n)
  // i may be fractional: a numeric tick between two samples.
  const cx = (i: number): number => (isBar ? left + band * i + band / 2 : n === 1 ? left + pw / 2 : left + (pw * i) / (n - 1))

  // X labels: every one if they fit, otherwise every k-th, each cut to its room.
  const xLabels = useMemo(() => {
    if (b.xNum && n > 1) {
      const vals = b.xNum.values
      const lo0 = vals[0]
      const hi0 = vals[vals.length - 1]
      const ticks = niceTicks(lo0, hi0, Math.max(2, Math.min(8, Math.floor(pw / 80)))).filter((t) => t >= lo0 - 1e-9 && t <= hi0 + 1e-9)
      return ticks.map((t) => ({ i: ((t - lo0) / (hi0 - lo0 || 1)) * (n - 1), text: formatCompact(t, 'number', b.xNum!.unit === '%' ? undefined : b.xNum!.unit) + (b.xNum!.unit === '%' ? '%' : '') }))
    }
    const widest = Math.max(...b.x.map((x) => textWidth(x, AXIS_FONT)))
    const room = isBar ? band : pw / Math.max(1, n - 1)
    const step = Math.max(1, Math.ceil((Math.min(widest, 120) + 10) / Math.max(1, room)))
    const out: { i: number; text: string }[] = []
    for (let i = 0; i < n; i += step) out.push({ i, text: fit(b.x[i], Math.max(room * step - 8, 24), AXIS_FONT) })
    // Lines: the last label is worth more than a regular rhythm.
    if (!isBar && n > 1 && out[out.length - 1].i !== n - 1) {
      const prev = out[out.length - 1]
      const lastText = fit(b.x[n - 1], 90, AXIS_FONT)
      if (out.length > 1 && cx(n - 1) - cx(prev.i) < (textWidth(prev.text, AXIS_FONT) + textWidth(lastText, AXIS_FONT)) / 2 + 10) out.pop()
      out.push({ i: n - 1, text: fit(b.x[n - 1], 90, AXIS_FONT) })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.x, band, pw, n, isBar])

  const k = b.series.length
  const groupW = Math.min(band * 0.72, stacked ? 28 : k * 24 + (k - 1) * 2)
  const barW = stacked ? Math.min(groupW, 24) : Math.max(1, Math.min(24, (groupW - (k - 1) * 2) / k))
  const gap = barW > 4 ? 2 : barW > 2 ? 1 : 0

  const pick = (clientX: number): number | null => {
    const svg = svgRef.current
    if (!svg) return null
    const r = svg.getBoundingClientRect()
    const x = clientX - r.left
    if (isBar) return Math.max(0, Math.min(n - 1, Math.floor((x - left) / band)))
    if (n === 1) return 0
    return Math.max(0, Math.min(n - 1, Math.round(((x - left) / pw) * (n - 1))))
  }
  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const i = pick(e.clientX)
    const r = svgRef.current!.getBoundingClientRect()
    setAt(i)
    setPointer({ x: e.clientX - r.left, y: e.clientY - r.top })
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setPointer(null)
      setAt((a) => (e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : a == null ? 0 : Math.max(0, Math.min(n - 1, a + (e.key === 'ArrowRight' ? 1 : -1)))))
    } else if (e.key === 'Escape') setAt(null)
  }

  const zero = sy(Math.max(y0, Math.min(y1, 0)))
  const marks: React.ReactNode[] = []
  const labels: React.ReactNode[] = []

  if (isBar) {
    for (let i = 0; i < n; i++) {
      const gx = cx(i) - (stacked ? barW : groupW) / 2
      if (stacked) {
        let pos = 0
        let neg = 0
        // The last segment drawn on each side wears the rounded end.
        let lastPos = -1
        let lastNeg = -1
        b.series.forEach((s, j) => {
          const v = s.data[i]
          if (v == null || v === 0) return
          if (v > 0) lastPos = j
          else lastNeg = j
        })
        b.series.forEach((s, j) => {
          const v = s.data[i]
          if (v == null || v === 0) return
          const from = v > 0 ? pos : neg
          const to = from + v
          if (v > 0) pos = to
          else neg = to
          const ya = sy(Math.max(from, to))
          const yb = sy(Math.min(from, to))
          const round = j === (v > 0 ? lastPos : lastNeg)
          // The surface gap sits on the side away from the baseline.
          const h = Math.max(0, yb - ya - (from !== 0 ? gap : 0))
          const y = v > 0 ? ya : ya + (from !== 0 ? gap : 0)
          marks.push(<path key={`${i}-${j}`} className="iui-mark" data-on={hoverSeries == null || hoverSeries === j} d={round ? bar(gx, y, barW, h, v > 0 ? 'up' : 'down') : `M${gx},${y}h${barW}v${h}h${-barW}Z`} fill={seriesColor(j)} />)
        })
      } else {
        b.series.forEach((s, j) => {
          const v = s.data[i]
          if (v == null) return
          const x = gx + j * (barW + gap)
          const ya = sy(Math.max(v, 0))
          const yb = sy(Math.min(v, 0))
          const h = Math.max(v === 0 ? 0 : 1, yb - ya)
          marks.push(<path key={`${i}-${j}`} className="iui-mark" data-on={hoverSeries == null || hoverSeries === j} d={bar(x, v >= 0 ? zero - h : zero, barW, h, v >= 0 ? 'up' : 'down')} fill={seriesColor(j)} />)
        })
      }
    }
    // One series and room to spare: the value sits on each bar's tip.
    if (k === 1 && n <= 16) {
      const s = b.series[0]
      const widest = Math.max(...s.data.map((v) => (v == null ? 0 : textWidth(short(v, f), 10.5))))
      if (widest + 4 < band) {
        s.data.forEach((v, i) => {
          if (v == null) return
          const y = v >= 0 ? sy(v) - 5 : sy(v) + 12
          labels.push(
            <text key={`v${i}`} x={cx(i)} y={y} textAnchor="middle" fontSize={10.5} fill="var(--ink-2)" className="tabular">
              {short(v, f)}
            </text>,
          )
        })
      }
    }
  } else {
    // Lines and areas, stacked areas summed from the bottom.
    const base = new Array(n).fill(0) as number[]
    const tops: (number | null)[][] = b.series.map((s) =>
      s.data.map((v, i) => {
        if (v == null) return null
        if (kind === 'area' && stacked) {
          base[i] += v
          return base[i]
        }
        return v
      }),
    )
    const runs = (vals: (number | null)[]): number[][] => {
      const out: number[][] = []
      let cur: number[] = []
      vals.forEach((v, i) => {
        if (v == null) {
          if (cur.length) out.push(cur)
          cur = []
        } else cur.push(i)
      })
      if (cur.length) out.push(cur)
      return out
    }
    // Areas first, lines over them, dots over everything.
    tops.forEach((vals, j) => {
      const on = hoverSeries == null || hoverSeries === j
      for (const run of runs(vals)) {
        const line = run.map((i, q) => `${q ? 'L' : 'M'}${cx(i).toFixed(1)},${sy(vals[i] as number).toFixed(1)}`).join('')
        if (kind === 'area') {
          const below = stacked && j > 0 ? tops[j - 1] : null
          const back = [...run]
            .reverse()
            .map((i) => `L${cx(i).toFixed(1)},${(below && below[i] != null ? sy(below[i] as number) : zero).toFixed(1)}`)
            .join('')
          marks.push(<path key={`a${j}-${run[0]}`} className="iui-mark" data-on={on} d={`${line}${back}Z`} fill={seriesColor(j)} fillOpacity={stacked ? 0.22 : 0.1} />)
        }
        marks.push(<path key={`l${j}-${run[0]}`} className="iui-mark" data-on={on} d={line} fill="none" stroke={seriesColor(j)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)
        if (run.length === 1) marks.push(<circle key={`p${j}-${run[0]}`} className="iui-mark" data-on={on} cx={cx(run[0])} cy={sy(vals[run[0]] as number)} r={3.5} fill={seriesColor(j)} stroke="var(--surface)" strokeWidth={2} />)
      }
      // Few points: each one is shown. Always: the last one.
      const dots = n <= 14 && kind === 'line' ? vals.map((_, i) => i) : [vals.length - 1]
      for (const i of dots) {
        const v = vals[i]
        if (v == null) continue
        marks.push(<circle key={`d${j}-${i}`} className="iui-mark" data-on={on} cx={cx(i)} cy={sy(v)} r={n <= 14 && kind === 'line' ? 3.5 : 4} fill={seriesColor(j)} stroke="var(--surface)" strokeWidth={2} />)
      }
    })
  }

  const hovered = at != null
  const tipRows =
    at == null
      ? []
      : b.series.map((s, j) => ({ color: seriesColor(j), name: s.name, value: s.data[at] == null ? 'n/a' : full(s.data[at], f) }))
  if (at != null && stacked && k > 1) {
    const total = b.series.reduce((t, s) => t + (s.data[at] || 0), 0)
    tipRows.push({ color: 'transparent', name: 'Total', value: full(total, f), strong: true } as (typeof tipRows)[number] & { strong: boolean })
  }
  const live = at == null ? '' : `${b.x[at]}: ${tipRows.map((r) => `${r.name} ${r.value}`).join(', ')}`

  return (
    <div className="relative" onPointerLeave={() => (setAt(null), setPointer(null))}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        role="img"
        aria-label={label}
        className="block touch-none overflow-visible"
        onPointerMove={onMove}
        onPointerDown={onMove}
      >
        {/* The hovered column, quietly. */}
        {hovered && isBar && <rect x={left + band * at!} y={top} width={band} height={ph} fill="var(--hover)" rx={4} />}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={left} x2={left + pw} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={left - 8} y={sy(t)} dy="0.34em" textAnchor="end" fontSize={AXIS_FONT} fill="var(--ink-3)">
              {tickLabels[i]}
            </text>
          </g>
        ))}
        {xLabels.map(({ i, text }) => (
          <text
            key={i}
            x={Math.min(Math.max(cx(i), left + textWidth(text, AXIS_FONT) / 2), left + pw - (isBar ? 0 : textWidth(text, AXIS_FONT) / 2) + (isBar ? 0 : right))}
            y={height - 8}
            textAnchor="middle"
            fontSize={AXIS_FONT}
            fill="var(--ink-3)"
          >
            {text}
          </text>
        ))}
        {marks}
        {labels}
        {hovered && !isBar && (
          <g pointerEvents="none">
            <line x1={cx(at!)} x2={cx(at!)} y1={top} y2={top + ph} stroke="var(--axis)" strokeWidth={1} shapeRendering="crispEdges" />
            {b.series.map((s, j) => {
              const raw = s.data[at!]
              if (raw == null) return null
              let v = raw
              if (kind === 'area' && stacked) v = b.series.slice(0, j + 1).reduce((t, x) => t + (x.data[at!] || 0), 0)
              return <circle key={j} cx={cx(at!)} cy={sy(v)} r={4.5} fill={seriesColor(j)} stroke="var(--surface)" strokeWidth={2} />
            })}
          </g>
        )}
      </svg>
      {hovered && (
        <Tip
          x={pointer ? pointer.x : cx(at!)}
          y={pointer ? Math.min(pointer.y - 20, height - 40 - tipRows.length * 18) : top}
          width={width}
          title={b.x[at!]}
          rows={tipRows}
        />
      )}
      <ChartKeys onKey={onKey} live={live} label={label} />
    </div>
  )
}

/** Keyboard focus for a chart: arrows walk the values, and each one is read out. */
function ChartKeys({ onKey, live, label }: { onKey(e: KeyboardEvent): void; live: string; label: string }) {
  return (
    <>
      <div tabIndex={0} onKeyDown={onKey} aria-label={`${label} Use the arrow keys to read each value.`} className="iui-chart absolute inset-0 outline-none" style={{ pointerEvents: 'none' }} />
      <div className="sr-only" aria-live="polite">
        {live}
      </div>
    </>
  )
}

// ───────────── horizontal bars ─────────────

function Horizontal({ b, f, width, hoverSeries, label }: { b: ChartBlock; f: Fmt; width: number; hoverSeries: number | null; label: string }) {
  const n = b.x.length
  const k = b.series.length
  const stacked = !!b.stacked && k > 1
  const [at, setAt] = useState<number | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const rowBar = stacked ? 18 : Math.min(18, Math.max(8, 22 / k))
  const rowH = stacked || k === 1 ? 30 : k * (rowBar + 2) + 12
  const labelW = Math.min(Math.max(...b.x.map((x) => textWidth(x, 12))) + 12, width * 0.36)
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i++) {
    if (stacked) {
      let p = 0
      let q = 0
      for (const s of b.series) {
        const v = s.data[i] || 0
        if (v > 0) p += v
        else q += v
      }
      hi = Math.max(hi, p)
      lo = Math.min(lo, q)
    } else
      for (const s of b.series) {
        const v = s.data[i]
        if (v == null) continue
        hi = Math.max(hi, v)
        lo = Math.min(lo, v)
      }
  }
  const ticks = niceTicks(lo, hi, width < 520 ? 3 : 5)
  const x0 = ticks[0]
  const x1 = ticks[ticks.length - 1]
  const valueRoom = stacked || k > 1 ? 8 : Math.max(...b.series[0].data.map((v) => (v == null ? 0 : textWidth(short(v, f), 11)))) + 10
  const pl = labelW
  const pw = Math.max(40, width - pl - valueRoom - 4)
  const top = 4
  const height = top + n * rowH + 22
  const sx = (v: number): number => pl + ((v - x0) / (x1 - x0 || 1)) * pw
  const zero = sx(Math.max(x0, Math.min(x1, 0)))
  const svgRef = useRef<SVGSVGElement>(null)
  const marks: React.ReactNode[] = []
  for (let i = 0; i < n; i++) {
    const ry = top + i * rowH
    if (stacked) {
      let pos = 0
      let neg = 0
      let lastPos = -1
      b.series.forEach((s, j) => {
        if ((s.data[i] || 0) > 0) lastPos = j
      })
      b.series.forEach((s, j) => {
        const v = s.data[i]
        if (v == null || v === 0) return
        const from = v > 0 ? pos : neg
        const to = from + v
        if (v > 0) pos = to
        else neg = to
        const xa = sx(Math.min(from, to))
        const xb = sx(Math.max(from, to))
        const g = from !== 0 ? 2 : 0
        const x = v > 0 ? xa + g : xa
        const w = Math.max(0, xb - xa - g)
        const y = ry + (rowH - rowBar) / 2
        marks.push(<path key={`${i}-${j}`} className="iui-mark" data-on={hoverSeries == null || hoverSeries === j} d={j === lastPos && v > 0 ? bar(x, y, w, rowBar, 'right') : `M${x},${y}h${w}v${rowBar}h${-w}Z`} fill={seriesColor(j)} />)
      })
    } else {
      b.series.forEach((s, j) => {
        const v = s.data[i]
        if (v == null) return
        const y = ry + (rowH - (k * rowBar + (k - 1) * 2)) / 2 + j * (rowBar + 2)
        const w = Math.max(v === 0 ? 0 : 1, Math.abs(sx(v) - zero))
        marks.push(<path key={`${i}-${j}`} className="iui-mark" data-on={hoverSeries == null || hoverSeries === j} d={bar(v >= 0 ? zero : zero - w, y, w, rowBar, v >= 0 ? 'right' : 'left')} fill={seriesColor(j)} />)
        if (k === 1)
          marks.push(
            <text key={`t${i}`} x={v >= 0 ? zero + w + 6 : zero - w - 6} y={y + rowBar / 2} dy="0.35em" textAnchor={v >= 0 ? 'start' : 'end'} fontSize={11} fill="var(--ink-2)">
              {short(v, f)}
            </text>,
          )
      })
    }
  }
  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const r = svgRef.current!.getBoundingClientRect()
    const y = e.clientY - r.top
    const i = Math.floor((y - top) / rowH)
    setAt(i >= 0 && i < n ? i : null)
    setPointer({ x: e.clientX - r.left, y })
  }
  const onKey = (e: KeyboardEvent): void => {
    if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      setPointer(null)
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      setAt((a) => (e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : a == null ? 0 : Math.max(0, Math.min(n - 1, a + d))))
    } else if (e.key === 'Escape') setAt(null)
  }
  const rows = at == null ? [] : b.series.map((s, j) => ({ color: seriesColor(j), name: s.name, value: s.data[at] == null ? 'n/a' : full(s.data[at], f) }))
  if (at != null && stacked) rows.push({ color: 'transparent', name: 'Total', value: full(b.series.reduce((t, s) => t + (s.data[at] || 0), 0), f) })
  return (
    <div className="relative" onPointerLeave={() => (setAt(null), setPointer(null))}>
      <svg ref={svgRef} width={width} height={height} role="img" aria-label={label} className="block touch-none overflow-visible" onPointerMove={onMove} onPointerDown={onMove}>
        {at != null && <rect x={0} y={top + at * rowH} width={width} height={rowH} rx={6} fill="var(--hover)" />}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={sx(t)} x2={sx(t)} y1={top} y2={top + n * rowH} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} shapeRendering="crispEdges" />
            <text x={sx(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 && valueRoom < 20 ? 'end' : 'middle'} fontSize={AXIS_FONT} fill="var(--ink-3)">
              {short(t, f)}
            </text>
          </g>
        ))}
        {b.x.map((x, i) => (
          <text key={i} x={0} y={top + i * rowH + rowH / 2} dy="0.35em" fontSize={12} fill="var(--ink-2)">
            {fit(x, labelW - 10, 12)}
          </text>
        ))}
        {marks}
      </svg>
      {at != null && <Tip x={pointer ? pointer.x : sx(hi)} y={(pointer ? pointer.y : top + at * rowH) - 10} width={width} title={b.x[at]} rows={rows} />}
      <ChartKeys onKey={onKey} live={at == null ? '' : `${b.x[at]}: ${rows.map((r) => `${r.name} ${r.value}`).join(', ')}`} label={label} />
    </div>
  )
}

// ───────────── pie and donut ─────────────

function Pie({ b, f, width, label }: { b: ChartBlock; f: Fmt; width: number; label: string }) {
  const [at, setAt] = useState<number | null>(null)
  // More than eight slices: the smallest fold into "Other", so no colour is ever made up.
  const slices = useMemo(() => {
    const all = b.x.map((x, i) => ({ name: x, value: Math.max(0, b.series[0].data[i] || 0), color: seriesColor(i) })).filter((s) => s.value > 0)
    if (all.length <= 8) return all
    const sorted = [...all].sort((a, c) => c.value - a.value)
    const keep = sorted.slice(0, 7)
    const rest = sorted.slice(7).reduce((t, s) => t + s.value, 0)
    return [...keep.map((s, i) => ({ ...s, color: seriesColor(i) })), { name: 'Other', value: rest, color: 'var(--ink-4)' }]
  }, [b])
  const total = slices.reduce((t, s) => t + s.value, 0)
  const side = width < 460
  const size = Math.min(side ? width : 220, 220)
  const r = size / 2 - 6
  const inner = b.kind === 'donut' ? r * 0.62 : 0
  const c = size / 2
  let a0 = -Math.PI / 2
  const arcs = slices.map((s) => {
    const a = (s.value / (total || 1)) * Math.PI * 2
    const start = a0
    a0 += a
    return { ...s, start, end: a0 }
  })
  const path = (start: number, end: number, ro: number, ri: number): string => {
    if (end - start >= Math.PI * 2 - 1e-6) end = start + Math.PI * 2 - 1e-4
    const large = end - start > Math.PI ? 1 : 0
    const p = (ang: number, rad: number): string => `${(c + Math.cos(ang) * rad).toFixed(2)},${(c + Math.sin(ang) * rad).toFixed(2)}`
    if (ri <= 0) return `M${c},${c}L${p(start, ro)}A${ro},${ro} 0 ${large} 1 ${p(end, ro)}Z`
    return `M${p(start, ro)}A${ro},${ro} 0 ${large} 1 ${p(end, ro)}L${p(end, ri)}A${ri},${ri} 0 ${large} 0 ${p(start, ri)}Z`
  }
  const pct = (v: number): string => `${((v / (total || 1)) * 100).toFixed(v / (total || 1) < 0.1 ? 1 : 0)}%`
  const onKey = (e: KeyboardEvent): void => {
    if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault()
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      setAt((a) => (a == null ? 0 : (a + d + slices.length) % slices.length))
    } else if (e.key === 'Escape') setAt(null)
  }
  const focus = at != null ? slices[at] : null
  return (
    <div className={cn('relative flex gap-6', side ? 'flex-col items-center' : 'items-center')} onPointerLeave={() => setAt(null)}>
      <svg width={size} height={size} role="img" aria-label={label} className="block shrink-0 overflow-visible">
        {arcs.map((s, i) => {
          const mid = (s.start + s.end) / 2
          const lift = at === i ? 4 : 0
          return (
            <path
              key={i}
              className="iui-mark"
              d={path(s.start, s.end, r, inner)}
              fill={s.color}
              stroke="var(--surface)"
              strokeWidth={2}
              strokeLinejoin="round"
              opacity={at == null || at === i ? 1 : 0.4}
              transform={`translate(${Math.cos(mid) * lift} ${Math.sin(mid) * lift})`}
              style={{ transition: 'transform 0.18s var(--ease-out), opacity 0.15s' }}
              onPointerEnter={() => setAt(i)}
            />
          )
        })}
        {inner > 0 && (
          <g pointerEvents="none">
            <text x={c} y={c - 4} textAnchor="middle" fontSize={focus ? 18 : 20} fontWeight={620} fill="var(--ink)" className="tabular">
              {focus ? pct(focus.value) : short(total, f)}
            </text>
            <text x={c} y={c + 15} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
              {focus ? fit(focus.name, inner * 1.6, 11) : 'Total'}
            </text>
          </g>
        )}
      </svg>
      <div className="min-w-0 flex-1 self-stretch" role="list" style={side ? { width: '100%' } : { alignSelf: 'center', maxWidth: 380 }}>
        {slices.map((s, i) => (
          <div
            key={i}
            role="listitem"
            onPointerEnter={() => setAt(i)}
            className={cn('flex items-center gap-2.5 rounded-[7px] px-2 py-[5px] text-[12.5px] transition-colors', at === i && 'bg-hover')}
          >
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-ink-2">{s.name}</span>
            <span className="tabular text-ink">{full(s.value, f)}</span>
            <span className="tabular w-12 text-right text-ink-3">{pct(s.value)}</span>
          </div>
        ))}
      </div>
      {!(inner > 0) && focus && (
        <div className="pointer-events-none absolute top-1 left-1 rounded-[9px] bg-raised px-2.5 py-1.5 text-[12px] shadow-pop" aria-hidden>
          <span className="text-ink-2">{focus.name}</span> <span className="tabular ml-1 font-medium">{full(focus.value, f)}</span> <span className="tabular ml-1 text-ink-3">{pct(focus.value)}</span>
        </div>
      )}
      <ChartKeys onKey={onKey} live={focus ? `${focus.name}: ${full(focus.value, f)}, ${pct(focus.value)}` : ''} label={label} />
    </div>
  )
}

// ───────────── scatter ─────────────

function Scatter({ b, f, width, hoverSeries, label }: { b: ChartBlock; f: Fmt; width: number; hoverSeries: number | null; label: string }) {
  const height = width < 520 ? 240 : 280
  const pts = b.series.flatMap((s, si) => (s.points || []).map((p) => ({ x: p[0], y: p[1], si })))
  const [at, setAt] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const xt = niceTicks(Math.min(...xs), Math.max(...xs), width < 520 ? 4 : 6)
  const yt = niceTicks(Math.min(...ys), Math.max(...ys), 5)
  const ylabels = yt.map((t) => short(t, f))
  const left = Math.ceil(Math.max(...ylabels.map((t) => textWidth(t, AXIS_FONT)))) + 10
  const top = 10
  const bottom = b.xLabel ? 40 : 26
  const pw = width - left - 12
  const ph = height - top - bottom
  const sx = (v: number): number => left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * pw
  const sy = (v: number): number => top + ph - ((v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * ph
  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const r = svgRef.current!.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    let best = -1
    let bd = 24 * 24
    pts.forEach((p, i) => {
      const d = (sx(p.x) - mx) ** 2 + (sy(p.y) - my) ** 2
      if (d < bd) {
        bd = d
        best = i
      }
    })
    setAt(best >= 0 ? best : null)
  }
  // Keyboard order: left to right.
  const order = useMemo(() => pts.map((_, i) => i).sort((a, c) => pts[a].x - pts[c].x), [pts])
  const onKey = (e: KeyboardEvent): void => {
    if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      setAt((a) => {
        const pos = a == null ? -1 : order.indexOf(a)
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : Math.max(0, Math.min(order.length - 1, pos + (e.key === 'ArrowRight' ? 1 : -1)))
        return order[next]
      })
    } else if (e.key === 'Escape') setAt(null)
  }
  const p = at != null ? pts[at] : null
  const xFmt = (v: number): string => formatCompact(v)
  return (
    <div className="relative" onPointerLeave={() => setAt(null)}>
      <svg ref={svgRef} width={width} height={height} role="img" aria-label={label} className="block touch-none overflow-visible" onPointerMove={onMove}>
        {yt.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={left} x2={left + pw} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} shapeRendering="crispEdges" />
            <text x={left - 8} y={sy(t)} dy="0.34em" textAnchor="end" fontSize={AXIS_FONT} fill="var(--ink-3)">
              {ylabels[i]}
            </text>
          </g>
        ))}
        {xt.map((t, i) => (
          <text key={`x${i}`} x={sx(t)} y={top + ph + 17} textAnchor={i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'} fontSize={AXIS_FONT} fill="var(--ink-3)">
            {xFmt(t)}
          </text>
        ))}
        {b.xLabel && (
          <text x={left + pw / 2} y={height - 4} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
            {b.xLabel}
          </text>
        )}
        {pts.map((q, i) => (
          <circle key={i} className="iui-mark" data-on={hoverSeries == null || hoverSeries === q.si} cx={sx(q.x)} cy={sy(q.y)} r={at === i ? 6 : 4.5} fill={seriesColor(q.si)} fillOpacity={0.85} stroke="var(--surface)" strokeWidth={2} />
        ))}
      </svg>
      {p && (
        <Tip
          x={sx(p.x)}
          y={sy(p.y) - 30}
          width={width}
          title={b.series[p.si].name}
          rows={[
            { color: 'transparent', name: b.xLabel || 'x', value: formatValue(p.x, 'number') },
            { color: seriesColor(p.si), name: b.yLabel || 'y', value: full(p.y, f) },
          ]}
        />
      )}
      <ChartKeys onKey={onKey} live={p ? `${b.series[p.si].name}: ${b.xLabel || 'x'} ${formatValue(p.x, 'number')}, ${b.yLabel || 'y'} ${full(p.y, f)}` : ''} label={label} />
    </div>
  )
}

// ───────────── the block ─────────────

/** The drawing alone, without the card: the calculator uses it for its sweep. */
export const ChartPlot = memo(function ChartPlot({ block }: { block: ChartBlock }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hoverSeries, setHoverSeries] = useState<number | null>(null)
  const f = useMemo(() => fmtOf(block), [block])
  const label = summarize(block, f)
  // Bars whose names are long read better lying down.
  const horizontal = block.kind === 'bar' && (block.horizontal || (block.x.length <= 20 && block.x.some((x) => x.length > 14) && width > 0 && Math.max(...block.x.map((x) => textWidth(x, 11))) > width / Math.max(1, block.x.length) - 8))
  const legend = block.series.length > 1 && block.kind !== 'pie' && block.kind !== 'donut'
  return (
    <div ref={ref} className="min-w-0">
      {legend && <Legend names={block.series.map((s) => s.name)} hover={hoverSeries} onHover={setHoverSeries} />}
      {width > 0 &&
        (block.kind === 'pie' || block.kind === 'donut' ? (
          <Pie b={block} f={f} width={width} label={label} />
        ) : block.kind === 'scatter' ? (
          <Scatter b={block} f={f} width={width} hoverSeries={hoverSeries} label={label} />
        ) : horizontal ? (
          <Horizontal b={block} f={f} width={width} hoverSeries={hoverSeries} label={label} />
        ) : (
          <Cartesian b={block} f={f} width={width} hoverSeries={hoverSeries} label={label} />
        ))}
    </div>
  )
})

export function Chart({ block }: { block: ChartBlock }) {
  const [table, setTable] = useState(false)
  const id = useId()
  const f = fmtOf(block)
  const toggle = useCallback(() => setTable((t) => !t), [])
  return (
    <Card
      title={block.title}
      label="Chart"
      aside={
        <button
          onClick={toggle}
          aria-pressed={table}
          aria-controls={id}
          className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          {table ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />}
          {table ? 'Chart' : 'Table'}
        </button>
      }
    >
      <div id={id}>{table ? <DataTable b={block} f={f} /> : <ChartPlot block={block} />}</div>
      {block.note && <div className="mt-2 text-[11.5px] leading-snug text-ink-3">{block.note}</div>}
    </Card>
  )
}
