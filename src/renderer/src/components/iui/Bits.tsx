// The quieter blocks: stats, compare, steps, checklist and tabs.
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDownRight, ArrowUpRight, Check, Minus, Plus, Sparkles } from 'lucide-react'
import type { ChecklistBlock, CompareBlock, StatsBlock, StepsBlock, TabsBlock } from '@shared/iui'
import { cn } from '@/lib/util'
import { Markdown } from '../Markdown'
import { Card, hash, useKept } from './kit'

// ───────────── stats ─────────────

export function Stats({ block }: { block: StatsBlock }) {
  const few = block.items.length
  return (
    <section aria-label={block.title || 'Key figures'} className="iui my-3 animate-fade-in select-text">
      {block.title && <div role="heading" aria-level={4} className="m-0 mb-2 text-[13px] font-semibold text-ink">{block.title}</div>}
      <div
        className="grid gap-px overflow-hidden rounded-[12px] bg-line shadow-card"
        style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${few <= 2 ? 200 : 150}px, 1fr))` }}
      >
        {block.items.map((it, i) => (
          <div key={i} className="min-w-0 bg-surface px-4 py-3">
            <div className="truncate text-[12px] text-ink-3">{it.label}</div>
            <div className="tabular mt-0.5 truncate text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">{it.value}</div>
            {(it.delta || it.hint) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-snug">
                {it.delta && (
                  <span
                    className={cn(
                      'tabular inline-flex items-center gap-0.5 rounded-full px-1.5 py-px font-medium',
                      it.tone === 'good' ? 'bg-ok-soft text-ok' : it.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-hover text-ink-2',
                    )}
                  >
                    {it.tone === 'flat' ? null : /^\s*[-−–▼↓]/.test(it.delta) ? <ArrowDownRight className="size-3" aria-hidden /> : <ArrowUpRight className="size-3" aria-hidden />}
                    {it.tone === 'flat' && /^[+-]?0(\.0+)?$/.test(it.delta.trim()) ? 'No change' : it.delta.replace(/^[▲▼↑↓]\s*/, '')}
                    <span className="sr-only">{it.tone === 'good' ? ' (good)' : it.tone === 'bad' ? ' (bad)' : ''}</span>
                  </span>
                )}
                {it.hint && <span className="text-ink-3">{it.hint}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ───────────── compare ─────────────

export function Compare({ block }: { block: CompareBlock }) {
  const scale = block.scale || 10
  return (
    <section aria-label={block.title || 'Options compared'} className="iui my-3 animate-fade-in select-text">
      {block.title && <div role="heading" aria-level={4} className="m-0 mb-2 text-[13px] font-semibold text-ink">{block.title}</div>}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${block.options.length > 3 ? 190 : 220}px, 1fr))` }}>
        {block.options.map((o, i) => (
          <div
            key={i}
            className={cn(
              'relative flex min-w-0 flex-col rounded-[12px] bg-surface px-4 py-3.5',
              o.pick ? 'shadow-[0_0_0_1.5px_var(--iui-pick),0_8px_24px_-12px_color-mix(in_oklab,var(--iui-pick)_45%,transparent)]' : 'shadow-card',
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 text-[14px] leading-snug font-semibold tracking-[-0.01em] text-ink">{o.name}</div>
              {o.pick && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--iui-pick)_12%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[color-mix(in_oklab,var(--iui-pick)_80%,var(--ink))]">
                  <Sparkles className="size-3" aria-hidden />
                  Recommended
                </span>
              )}
            </div>
            {o.summary && <div className="mt-1 text-[12.5px] leading-snug text-ink-2">{o.summary}</div>}
            {o.score != null && (
              <div className="mt-2.5 flex items-center gap-2" aria-label={`Score ${o.score} out of ${scale}`}>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, o.score / scale)) * 100}%`, background: o.pick ? 'var(--iui-pick)' : 'var(--ink-3)' }} />
                </div>
                <span className="tabular text-[12px] font-medium text-ink">
                  {Number(o.score.toFixed(1))}
                  <span className="text-ink-3">/{scale}</span>
                </span>
              </div>
            )}
            {(o.pros.length > 0 || o.cons.length > 0) && (
              <ul className="mt-2.5 space-y-1">
                {o.pros.map((p, j) => (
                  <li key={`p${j}`} className="flex gap-2 text-[12.5px] leading-snug text-ink-2">
                    <Plus className="mt-[2px] size-3.5 shrink-0 text-ok" aria-label="For" strokeWidth={2.4} />
                    <span className="min-w-0">{p}</span>
                  </li>
                ))}
                {o.cons.map((c, j) => (
                  <li key={`c${j}`} className="flex gap-2 text-[12.5px] leading-snug text-ink-2">
                    <Minus className="mt-[2px] size-3.5 shrink-0 text-bad" aria-label="Against" strokeWidth={2.4} />
                    <span className="min-w-0">{c}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ───────────── steps ─────────────

export function Steps({ block }: { block: StepsBlock }) {
  const done = block.items.filter((s) => s.status === 'done').length
  return (
    <Card title={block.title} label="Steps" aside={<span className="tabular text-[11.5px] text-ink-3">{done} of {block.items.length} done</span>}>
      <ol className="m-0 list-none p-0">
        {block.items.map((s, i) => {
          const last = i === block.items.length - 1
          return (
            <li key={i} className="relative flex gap-3 pb-3 last:pb-0" aria-current={s.status === 'doing' ? 'step' : undefined}>
              {!last && <span className={cn('absolute top-[22px] bottom-[2px] left-[9px] w-px', s.status === 'done' ? 'bg-ink-4' : 'bg-line-2')} aria-hidden />}
              <span className="relative mt-[1px] flex size-[19px] shrink-0 items-center justify-center" aria-hidden>
                {s.status === 'done' ? (
                  <span className="flex size-[19px] items-center justify-center rounded-full bg-ink text-inverse">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : s.status === 'doing' ? (
                  <>
                    <span className="plan-doing absolute inset-0 rounded-full" />
                    <span className="size-[7px] rounded-full bg-ink" />
                  </>
                ) : (
                  <span className="tabular flex size-[19px] items-center justify-center rounded-full text-[10.5px] font-semibold text-ink-3 shadow-[inset_0_0_0_1.25px_var(--line-2)]">{i + 1}</span>
                )}
              </span>
              <div className="min-w-0 flex-1 pt-px">
                <div className={cn('text-[13px] leading-snug font-medium', s.status === 'todo' ? 'text-ink-2' : 'text-ink')}>
                  {s.title}
                  <span className="sr-only">{s.status === 'done' ? ' (done)' : s.status === 'doing' ? ' (in progress)' : ' (to do)'}</span>
                </div>
                {s.detail && <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{s.detail}</div>}
              </div>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

// ───────────── checklist ─────────────

export function Checklist({ block, source }: { block: ChecklistBlock; source: string }) {
  const [ticks, setTicks] = useKept<boolean[]>(`check:${hash(source)}`, () => block.items.map((i) => i.done))
  const done = ticks.filter(Boolean).length
  return (
    <Card
      title={block.title}
      label="Checklist"
      aside={
        <span className="flex items-center gap-2">
          <span className="h-1 w-14 overflow-hidden rounded-full bg-hover" aria-hidden>
            <span className="block h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${(done / block.items.length) * 100}%` }} />
          </span>
          <span className="tabular text-[11.5px] text-ink-3">
            {done} of {block.items.length}
          </span>
        </span>
      }
    >
      <ul className="-mx-1.5 m-0 list-none p-0">
        {block.items.map((it, i) => {
          const on = !!ticks[i]
          return (
            <li key={i}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[8px] px-1.5 py-[5px] hover:bg-hover">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={on}
                  onChange={() => setTicks((t) => t.map((x, j) => (j === i ? !x : x)))}
                />
                <span
                  aria-hidden
                  className={cn(
                    'mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[5px] transition-colors peer-focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--link)_30%,transparent)]',
                    on ? 'bg-ok text-white' : 'shadow-[inset_0_0_0_1.25px_var(--ink-4)]',
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className={cn('min-w-0 flex-1 text-[13px] leading-snug transition-colors', on ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink')}>{it.label}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// ───────────── tabs ─────────────

export function Tabs({ block, compact }: { block: TabsBlock; compact?: boolean }) {
  const [on, setOn] = useState(0)
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent): void => {
    const n = block.tabs.length
    let next = on
    if (e.key === 'ArrowRight') next = (on + 1) % n
    else if (e.key === 'ArrowLeft') next = (on - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else return
    e.preventDefault()
    setOn(next)
    refs.current[next]?.focus()
  }
  return (
    <Card pad={false} label="Tabs">
      <div role="tablist" aria-orientation="horizontal" onKeyDown={onKey} className="flex gap-0.5 overflow-x-auto border-b border-line px-2 pt-1.5">
        {block.tabs.map((t, i) => (
          <button
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            role="tab"
            id={`${id}-t${i}`}
            aria-selected={on === i}
            aria-controls={`${id}-p${i}`}
            tabIndex={on === i ? 0 : -1}
            onClick={() => setOn(i)}
            className={cn(
              'relative h-8 shrink-0 rounded-t-[7px] px-3 text-[12.5px] font-medium whitespace-nowrap transition-colors',
              on === i ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {t.label}
            {on === i && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-ink" aria-hidden />}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-p${on}`} aria-labelledby={`${id}-t${on}`} className="px-4 py-3">
        <Markdown text={block.tabs[on].content} compact={compact ?? true} />
      </div>
    </Card>
  )
}
