// A small popover for changing a loop where it stands: what it says, how often, when it stops.

import { useState, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import type { Loop } from '@shared/types'
import { EVERY_PRESETS, everyLabel, parseEvery } from '@shared/auto'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Button, inputClass } from '../ui'

const label = 'mb-1 block text-[11.5px] font-medium text-ink-3'

function Form({ chatId, loop, onDone }: { chatId: string; loop: Loop; onDone(): void }) {
  const run = useStore((s) => s.run)
  const [prompt, setPrompt] = useState(loop.prompt)
  const preset = EVERY_PRESETS.some((p) => p.ms === loop.every)
  const [every, setEvery] = useState<number | null>(loop.every)
  const [custom, setCustom] = useState('')
  const [until, setUntil] = useState(loop.until || '')
  const [max, setMax] = useState(loop.maxRuns ? String(loop.maxRuns) : '')
  const [busy, setBusy] = useState(false)

  const typed = custom.trim() ? parseEvery(custom) : undefined
  const bad = !!custom.trim() && typed === undefined
  const pace = custom.trim() ? typed : every
  const runs = max.trim() ? Math.floor(Number(max)) : null
  const badRuns = runs !== null && (!Number.isFinite(runs) || runs < 1)
  const ok = !!prompt.trim() && !bad && !badRuns && !busy

  const save = (): void => {
    if (!ok) return
    setBusy(true)
    void run(api.updateLoop(chatId, loop.id, { prompt: prompt.trim(), every: pace ?? null, until: until.trim(), maxRuns: runs })).then((c) => {
      setBusy(false)
      if (c) onDone()
    })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
      }}
      className="space-y-3"
    >
      <div>
        <span className={label}>What it says each time</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className={cn(inputClass, 'h-auto resize-none py-2 leading-snug')}
        />
      </div>
      <div>
        <span className={label}>How often</span>
        <div className="flex flex-wrap gap-1">
          {EVERY_PRESETS.map((p) => {
            const on = !custom.trim() && every === p.ms
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setEvery(p.ms)
                  setCustom('')
                }}
                className={cn(
                  'h-6 rounded-full px-2.5 text-[12px] transition-colors',
                  on ? 'bg-ink font-medium text-inverse' : 'bg-surface-2 text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] hover:bg-surface-3 hover:text-ink',
                )}
              >
                {p.label.replace(/^Every /, '').replace(/^(hour|day)$/, '1 $1')}
              </button>
            )
          })}
        </div>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Or type one: 10m, 2h, 1d"
          className={cn(inputClass, 'mt-1.5 h-8', bad && 'shadow-[inset_0_0_0_1px_var(--bad)]')}
        />
        {bad && <span className="mt-1 block text-[11.5px] text-bad">That is not a pace it can read. Try 10m, 2h or 1d.</span>}
        {typed !== undefined ? (
          <span className="mt-1 block text-[11.5px] text-ink-3">Runs {everyLabel(typed)}</span>
        ) : (
          !preset && !custom.trim() && every === loop.every && <span className="mt-1 block text-[11.5px] text-ink-3">Runs {everyLabel(loop.every)} for now</span>
        )}
      </div>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <span className={label}>Stop when</span>
          <input value={until} onChange={(e) => setUntil(e.target.value)} placeholder="Say it in words (optional)" className={cn(inputClass, 'h-8')} />
        </div>
        <div className="w-[92px] shrink-0">
          <span className={label}>At most</span>
          <input
            value={max}
            onChange={(e) => setMax(e.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            placeholder="No limit"
            className={cn(inputClass, 'tabular h-8', badRuns && 'shadow-[inset_0_0_0_1px_var(--bad)]')}
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!ok}>
          Save
        </Button>
      </div>
    </form>
  )
}

/** Wraps a trigger; opens the editor for `loop` beside it. */
export function LoopEditor({ chatId, loop, children }: { chatId: string; loop: Loop; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="no-drag z-[70] w-[340px] max-w-[92vw] animate-pop rounded-[14px] bg-raised p-3.5 shadow-pop outline-none"
        >
          <div className="mb-2.5 text-[13px] font-semibold">Edit loop</div>
          {open && <Form chatId={chatId} loop={loop} onDone={() => setOpen(false)} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
