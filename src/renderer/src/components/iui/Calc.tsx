// A calculator: inputs on the left (or on top when narrow), answers that work themselves out
// again as you type or drag, and an optional chart of one answer across one input's range.
import { useId, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { formatValue, runCalc, type CalcBlock, type CalcInput, type ChartBlock } from '@shared/iui'
import { cn } from '@/lib/util'
import { inputClass } from '../ui'
import { ChartPlot, useWidth } from './Chart'
import { Card } from './kit'

const SWEEP = 40

function InputRow({ inp, raw, onChange, id }: { inp: CalcInput; raw: string; onChange(v: string): void; id: string }) {
  const n = Number(raw)
  if (inp.type === 'select' && inp.options) {
    const short = inp.options.length <= 4 && inp.options.every((o) => o.label.length <= 12)
    return (
      <div>
        <div id={`${id}-l`} className="mb-1 text-[12.5px] font-medium text-ink-2">
          {inp.label}
        </div>
        {short ? (
          <div role="radiogroup" aria-labelledby={`${id}-l`} className="inline-flex h-8 w-full items-center gap-0.5 rounded-[9px] bg-hover p-0.5">
            {inp.options.map((o) => {
              const on = Number(raw) === o.value
              return (
                <button
                  key={o.label}
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange(String(o.value))}
                  className={cn('h-7 flex-1 rounded-[7px] px-2 text-[12.5px] font-medium transition-all', on ? 'bg-surface text-ink shadow-[0_0_0_0.5px_var(--line-2),0_1px_2px_rgba(0,0,0,0.08)]' : 'text-ink-2 hover:text-ink')}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        ) : (
          <select aria-labelledby={`${id}-l`} value={raw} onChange={(e) => onChange(e.target.value)} className={inputClass}>
            {inp.options.map((o) => (
              <option key={o.label} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
    )
  }
  const lo = inp.min ?? 0
  const hi = inp.max ?? 100
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline gap-2 text-[12.5px] font-medium text-ink-2">
        <span className="min-w-0 flex-1 truncate">{inp.label}</span>
      </label>
      <div className="flex items-center gap-2.5">
        {inp.type === 'range' && (
          <input
            type="range"
            aria-label={inp.label}
            className="iui-range min-w-0 flex-1"
            min={lo}
            max={hi}
            step={inp.step ?? 'any'}
            value={Number.isFinite(n) ? n : lo}
            onChange={(e) => onChange(e.target.value)}
            style={{ ['--fill' as string]: `${Math.max(0, Math.min(1, ((Number.isFinite(n) ? n : lo) - lo) / (hi - lo || 1))) * 100}%` }}
          />
        )}
        <div className={cn('relative', inp.type === 'range' ? 'w-[96px] shrink-0' : 'w-full')}>
          <input
            id={id}
            type="number"
            inputMode="decimal"
            value={raw}
            min={inp.min}
            max={inp.max}
            step={inp.step ?? 'any'}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!Number.isFinite(n) || raw.trim() === ''}
            className={cn(inputClass, 'tabular h-8 text-right', inp.unit && 'pr-9', (!Number.isFinite(n) || raw.trim() === '') && 'shadow-[inset_0_0_0_1px_var(--bad)]')}
          />
          {inp.unit && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11.5px] text-ink-3">{inp.unit}</span>}
        </div>
      </div>
    </div>
  )
}

export function Calc({ block }: { block: CalcBlock }) {
  const id = useId()
  const start = useMemo(() => Object.fromEntries(block.inputs.map((i) => [i.name, String(i.default)])), [block])
  const [raw, setRaw] = useState<Record<string, string>>(start)
  const [ref, width] = useWidth<HTMLDivElement>()
  const side = width >= 620
  const values = useMemo(() => Object.fromEntries(block.inputs.map((i) => [i.name, raw[i.name]?.trim() === '' ? NaN : Number(raw[i.name])])), [block, raw])
  const results = useMemo(() => runCalc(block, values), [block, values])
  const changed = block.inputs.some((i) => raw[i.name] !== start[i.name])

  // The sweep: one answer across the range of one input, the others as they are now.
  const chart = useMemo<ChartBlock | null>(() => {
    const c = block.chart
    if (!c) return null
    const inp = block.inputs.find((i) => i.name === c.x)!
    const out = block.outputs[c.y]
    const xs: number[] = []
    if (inp.type === 'select' && inp.options) inp.options.forEach((o) => xs.push(o.value))
    else if (inp.step && (c.to - c.from) / inp.step <= SWEEP) {
      for (let v = c.from; v <= c.to + inp.step / 2 && xs.length <= SWEEP + 1; v += inp.step) xs.push(Number(v.toPrecision(10)))
    } else {
      // Evenly spaced; the labels round, the sums do not, so the line stays smooth.
      for (let k = 0; k <= SWEEP; k++) xs.push(c.from + ((c.to - c.from) * k) / SWEEP)
    }
    const numeric = !(inp.type === 'select' && inp.options)
    const ys = xs.map((x) => {
      const r = runCalc(block, { ...values, [inp.name]: x })[c.y]
      return Number.isFinite(r) ? r : null
    })
    const xLabel = (x: number): string => (inp.type === 'select' && inp.options ? inp.options.find((o) => o.value === x)?.label || String(x) : formatValue(x, 'number', inp.unit))
    return {
      type: 'chart',
      kind: c.kind,
      x: xs.map(xLabel),
      series: [{ name: out.label, data: ys }],
      format: out.format,
      unit: out.unit,
      xNum: numeric ? { values: xs, unit: inp.unit } : undefined,
    }
  }, [block, values])

  const main = block.outputs.findIndex((o) => o.main)
  return (
    <Card
      title={block.title}
      label="Calculator"
      aside={
        changed ? (
          <button onClick={() => setRaw(start)} className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] font-medium text-ink-3 hover:bg-hover hover:text-ink">
            <RotateCcw className="size-3" />
            Reset
          </button>
        ) : undefined
      }
    >
      <div ref={ref} className={cn('gap-5', side ? 'grid grid-cols-[minmax(220px,0.9fr)_minmax(0,1.1fr)]' : 'flex flex-col')}>
        <div className="space-y-3" role="group" aria-label="Inputs">
          {block.inputs.map((inp) => (
            <InputRow key={inp.name} id={`${id}-${inp.name}`} inp={inp} raw={raw[inp.name] ?? ''} onChange={(v) => setRaw((r) => ({ ...r, [inp.name]: v }))} />
          ))}
        </div>
        <div className="min-w-0">
          <div className="rounded-[10px] bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--line)]" aria-live="polite" role="group" aria-label="Results">
            {main >= 0 && (
              <div className="mb-2">
                <div className="text-[12px] text-ink-3">{block.outputs[main].label}</div>
                <div className="tabular mt-0.5 text-[28px] leading-tight font-semibold tracking-[-0.025em] text-ink">{formatValue(results[main], block.outputs[main].format, block.outputs[main].unit, block.outputs[main].digits)}</div>
              </div>
            )}
            <div className="space-y-0">
              {block.outputs.map((o, i) =>
                i === main ? null : (
                  <div key={i} className="flex items-baseline gap-3 border-t border-line py-1.5 first:border-t-0">
                    <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">{o.label}</span>
                    <span className={cn('tabular text-[13.5px] font-medium', Number.isFinite(results[i]) ? 'text-ink' : 'text-ink-3')}>{formatValue(results[i], o.format, o.unit, o.digits)}</span>
                  </div>
                ),
              )}
            </div>
          </div>
          {chart && (
            <div className="mt-3">
              <div className="mb-1 text-[11.5px] text-ink-3">
                {block.outputs[block.chart!.y].label} by {block.inputs.find((i) => i.name === block.chart!.x)?.label.toLowerCase()}
              </div>
              <ChartPlot block={chart} />
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

