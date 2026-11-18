// Blocks that answer the agent: choices and form. They send only on a real click (or Enter in
// the form), as an ordinary message from the user, and lock afterwards to show what was sent.
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Check, CornerDownLeft, Send } from 'lucide-react'
import type { ChoicesBlock, FormBlock, FormField } from '@shared/iui'
import { cn } from '@/lib/util'
import { Button, Spinner, inputClass } from '../ui'
import { Card, hash, useAnswer, useKept } from './kit'

function SentNote({ name }: { name?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-3">
      <Check className="size-3.5 text-ok" strokeWidth={2.6} aria-hidden />
      Sent{name ? ` to ${name}` : ''}
    </span>
  )
}

// ───────────── choices ─────────────

export function Choices({ block, source }: { block: ChoicesBlock; source: string }) {
  const { send, name, to } = useAnswer()
  const [sent, setSent] = useKept<string[] | null>(`choices:${to}:${hash(source)}`, null)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const go = async (labels: string[]): Promise<void> => {
    if (!labels.length || sent || busy) return
    setBusy(true)
    setSent(labels)
    const ok = await send(`Chose: ${labels.join(', ')}`)
    setBusy(false)
    if (!ok) setSent(null)
  }
  const locked = !!sent
  const chosen = sent || picked
  return (
    <Card title={block.prompt} label="Choices" aside={locked ? <SentNote name={name} /> : block.multiple ? <span className="text-[11.5px] text-ink-3">Pick any</span> : undefined}>
      <div className="grid gap-1.5" role={block.multiple ? 'group' : 'radiogroup'} aria-label={block.prompt || 'Choices'} style={{ gridTemplateColumns: block.options.length > 3 && block.options.every((o) => !o.detail && o.label.length < 28) ? 'repeat(auto-fill, minmax(170px, 1fr))' : '1fr' }}>
        {block.options.map((o) => {
          const on = chosen.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              role={block.multiple ? 'checkbox' : 'radio'}
              aria-checked={on}
              disabled={locked || busy}
              onClick={() => (block.multiple ? setPicked((p) => (p.includes(o.label) ? p.filter((x) => x !== o.label) : [...p, o.label])) : void go([o.label]))}
              className={cn(
                'group/o flex w-full items-start gap-2.5 rounded-[10px] px-3 py-2 text-left transition-all disabled:cursor-default',
                on ? 'bg-[color-mix(in_oklab,var(--iui-pick)_9%,transparent)] shadow-[inset_0_0_0_1.5px_var(--iui-pick)]' : 'shadow-[inset_0_0_0_1px_var(--line)] enabled:hover:bg-hover enabled:active:scale-[0.995]',
                locked && !on && 'opacity-45',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-[3px] flex size-3.5 shrink-0 items-center justify-center border',
                  block.multiple ? 'rounded-[4px]' : 'rounded-full',
                  on ? 'border-[var(--iui-pick)] bg-[var(--iui-pick)]' : 'border-ink-4 group-hover/o:border-ink-3',
                )}
              >
                {on && <Check className="size-2.5 text-white" strokeWidth={3.5} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug font-medium text-ink">{o.label}</span>
                {o.detail && <span className="mt-0.5 block text-[12px] leading-snug text-ink-3">{o.detail}</span>}
              </span>
              {!block.multiple && !locked && <CornerDownLeft className="mt-[3px] size-3.5 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/o:opacity-100" aria-hidden />}
              {busy && on && <Spinner />}
            </button>
          )
        })}
      </div>
      {block.multiple && !locked && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="text-[11.5px] text-ink-3">{picked.length ? `${picked.length} picked` : ''}</span>
          <Button size="sm" variant="primary" disabled={!picked.length || busy} onClick={() => void go(picked)}>
            <Send className="size-3.5" />
            Send
          </Button>
        </div>
      )}
    </Card>
  )
}

// ───────────── form ─────────────

type Values = Record<string, string | boolean>

function initial(fields: FormField[]): Values {
  const v: Values = {}
  for (const f of fields) {
    if (f.type === 'checkbox') v[f.name] = f.default === true || f.default === 'true'
    else if (f.type === 'range') v[f.name] = String(f.default ?? f.min ?? 0)
    else if (f.type === 'select') v[f.name] = f.default != null ? String(f.default) : ''
    else v[f.name] = f.default != null ? String(f.default) : ''
  }
  return v
}

function problem(f: FormField, v: string | boolean): string | null {
  if (f.type === 'checkbox') return f.required && !v ? 'Needs to be ticked' : null
  const s = String(v ?? '').trim()
  if (!s) return f.required ? 'Needed' : null
  if (f.type === 'number' || f.type === 'range') {
    const n = Number(s)
    if (!Number.isFinite(n)) return 'Should be a number'
    if (f.min != null && n < f.min) return `At least ${f.min}`
    if (f.max != null && n > f.max) return `At most ${f.max}`
  }
  if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'Should be a date'
  return null
}

function shown(f: FormField, v: string | boolean): string {
  if (f.type === 'checkbox') return v ? 'yes' : 'no'
  const s = String(v ?? '').trim()
  if (f.type === 'select') return f.options?.find((o) => o.value === s)?.label || s
  return s
}

/** The answers, worded for a person: short ones on one line, longer ones as a list. */
export function answersText(fields: FormField[], values: Values): string {
  const parts = fields.map((f) => ({ label: f.label, value: shown(f, values[f.name]) })).filter((p) => p.value !== '')
  if (!parts.length) return 'Answers: (none)'
  const short = parts.length <= 4 && parts.every((p) => p.value.length <= 40 && !p.value.includes('\n') && p.label.length <= 30)
  if (short) return `Answers: ${parts.map((p) => `${p.label.replace(/[:?]\s*$/, '')} ${p.value}`).join(', ')}`
  return `Answers:\n${parts.map((p) => `- ${p.label.replace(/[:?]\s*$/, '')}: ${p.value.includes('\n') ? `\n  ${p.value.replace(/\n/g, '\n  ')}` : p.value}`).join('\n')}`
}

export function Form({ block, source }: { block: FormBlock; source: string }) {
  const { send, name, to } = useAnswer()
  const id = useId()
  const [sent, setSent] = useKept<Values | null>(`form:${to}:${hash(source)}`, null)
  const [values, setValues] = useState<Values>(() => initial(block.fields))
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const locked = !!sent
  const shownValues = sent || values
  const problems = Object.fromEntries(block.fields.map((f) => [f.name, problem(f, values[f.name])]))
  const bad = Object.values(problems).some(Boolean)

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (locked || busy) return
    setTried(true)
    if (bad) {
      const first = block.fields.find((f) => problems[f.name])
      if (first) document.getElementById(`${id}-${first.name}`)?.focus()
      return
    }
    setBusy(true)
    setSent(values)
    const ok = await send(answersText(block.fields, values))
    setBusy(false)
    if (!ok) setSent(null)
  }
  const set = (k: string, v: string | boolean): void => setValues((p) => ({ ...p, [k]: v }))
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Card title={block.title} label="Form" aside={locked ? <SentNote name={name} /> : undefined}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
        <fieldset disabled={locked || busy} className="m-0 grid min-w-0 gap-x-4 gap-y-3 border-0 p-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))' }}>
          {block.fields.map((f) => {
            const fid = `${id}-${f.name}`
            const err = tried && !locked ? problems[f.name] : null
            const v = shownValues[f.name]
            const describedBy = [f.hint && `${fid}-h`, err && `${fid}-e`].filter(Boolean).join(' ') || undefined
            const ring = err ? 'shadow-[inset_0_0_0_1px_var(--bad)]' : ''
            // Short answers sit side by side when there is room; long ones take the whole row.
            const wide = f.type === 'textarea' || f.type === 'range' || f.type === 'checkbox' || (f.hint?.length || 0) > 60
            const span = wide ? { gridColumn: '1 / -1' } : undefined
            if (f.type === 'checkbox') {
              return (
                <div key={f.name} style={span}>
                  <label htmlFor={fid} className="flex cursor-pointer items-start gap-2.5">
                    <input id={fid} type="checkbox" checked={!!v} onChange={(e) => set(f.name, e.target.checked)} className="peer sr-only" aria-describedby={describedBy} aria-invalid={!!err} />
                    <span
                      aria-hidden
                      className={cn(
                        'mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[5px] transition-colors peer-focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--link)_30%,transparent)]',
                        v ? 'bg-[var(--iui-pick)] text-white' : err ? 'shadow-[inset_0_0_0_1.25px_var(--bad)]' : 'shadow-[inset_0_0_0_1.25px_var(--ink-4)]',
                      )}
                    >
                      {v && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="text-[13px] leading-snug text-ink">
                      {f.label}
                      {f.required && <span className="text-ink-3"> (needed)</span>}
                    </span>
                  </label>
                  {f.hint && <div id={`${fid}-h`} className="mt-0.5 ml-[26px] text-[11.5px] text-ink-3">{f.hint}</div>}
                  {err && <div id={`${fid}-e`} className="mt-0.5 ml-[26px] text-[11.5px] text-bad">{err}</div>}
                </div>
              )
            }
            return (
              <div key={f.name} style={span} className="min-w-0">
                <label htmlFor={fid} className="mb-1 flex items-baseline gap-2 text-[12.5px] font-medium text-ink-2">
                  <span className="min-w-0 flex-1">
                    {f.label}
                    {f.required && <span className="font-normal text-ink-3"> (needed)</span>}
                  </span>
                  {f.type === 'range' && <span className="tabular font-semibold text-ink">{String(v)}</span>}
                </label>
                {f.type === 'textarea' ? (
                  <textarea
                    id={fid}
                    value={String(v ?? '')}
                    onChange={(e) => set(f.name, e.target.value)}
                    onKeyDown={onKey}
                    rows={3}
                    placeholder={f.placeholder}
                    aria-describedby={describedBy}
                    aria-invalid={!!err}
                    aria-required={f.required}
                    className={cn(inputClass, 'h-auto min-h-[72px] resize-y py-2 leading-snug', ring)}
                  />
                ) : f.type === 'select' ? (
                  <select
                    id={fid}
                    value={String(v ?? '')}
                    onChange={(e) => set(f.name, e.target.value)}
                    aria-describedby={describedBy}
                    aria-invalid={!!err}
                    aria-required={f.required}
                    className={cn(inputClass, ring, !v && 'text-ink-3')}
                  >
                    {!f.default && <option value="">Choose…</option>}
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'range' ? (
                  <input
                    id={fid}
                    type="range"
                    className="iui-range"
                    min={f.min ?? 0}
                    max={f.max ?? 100}
                    step={f.step ?? 1}
                    value={String(v)}
                    onChange={(e) => set(f.name, e.target.value)}
                    style={{ ['--fill' as string]: `${((Number(v) - (f.min ?? 0)) / ((f.max ?? 100) - (f.min ?? 0) || 1)) * 100}%` }}
                    aria-describedby={describedBy}
                  />
                ) : (
                  <input
                    id={fid}
                    type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                    inputMode={f.type === 'number' ? 'decimal' : undefined}
                    min={f.min}
                    max={f.max}
                    step={f.step ?? (f.type === 'number' ? 'any' : undefined)}
                    value={String(v ?? '')}
                    onChange={(e) => set(f.name, e.target.value)}
                    placeholder={f.placeholder}
                    aria-describedby={describedBy}
                    aria-invalid={!!err}
                    aria-required={f.required}
                    className={cn(inputClass, ring, f.type === 'number' && 'tabular')}
                  />
                )}
                {f.hint && (
                  <div id={`${fid}-h`} className="mt-1 text-[11.5px] leading-snug text-ink-3">
                    {f.hint}
                  </div>
                )}
                {err && (
                  <div id={`${fid}-e`} className="mt-1 text-[11.5px] text-bad" role="alert">
                    {err}
                  </div>
                )}
              </div>
            )
          })}
        </fieldset>
        {!locked && (
          <div className="flex items-center justify-end gap-3 pt-0.5">
            <span className="text-[11.5px] text-ink-3">{tried && bad ? 'Some answers are missing' : name ? `Goes to ${name}` : ''}</span>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              {busy ? <Spinner className="text-inverse" /> : <Send className="size-3.5" />}
              {block.submit}
            </Button>
          </div>
        )}
      </form>
    </Card>
  )
}
