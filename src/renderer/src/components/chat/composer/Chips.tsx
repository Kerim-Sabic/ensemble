import { CircleStop, Repeat, Target, Undo2, WandSparkles, X } from 'lucide-react'
import { cn } from '@/lib/util'
import { Tip } from '../../ui'
import { MODE_ICON } from './bits'
import type { Preview } from './extras'

const chip = 'flex h-6 min-w-0 animate-fade-in items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap'

/** What a typed command will do, shown before it is sent. */
export function PreviewChip({ preview }: { preview: Preview }) {
  const Icon = preview.tone === 'goal' ? Target : preview.tone === 'loop' ? Repeat : preview.tone === 'stop' ? CircleStop : MODE_ICON[preview.mode || 'chat']
  return (
    <Tip label={preview.hint} side="top">
      <span className={cn(chip, preview.tone === 'stop' ? 'bg-hover text-ink-2' : 'bg-accent-soft text-accent')}>
        <Icon className="size-3 shrink-0" strokeWidth={2.1} />
        <span className="truncate">{preview.label}</span>
      </span>
    </Tip>
  )
}

/** Offers to make a message that reads like a long or repeating job into a goal or a loop. */
export function NudgeChip({ kind, onTake, onDismiss }: { kind: 'goal' | 'loop'; onTake(): void; onDismiss(): void }) {
  const Icon = kind === 'goal' ? Target : Repeat
  return (
    <span className={cn(chip, 'gap-0 bg-surface-2 p-0 text-ink-2 shadow-[inset_0_0_0_1px_var(--line)]')}>
      <Tip label={kind === 'goal' ? 'The team keeps going until it is done' : 'It runs now, then again by itself'} side="top">
        <button type="button" onClick={onTake} className="flex h-6 min-w-0 items-center gap-1.5 rounded-l-full pr-1 pl-2 transition-colors hover:text-ink">
          <Icon className="size-3 shrink-0 text-accent" strokeWidth={2.1} />
          <span className="truncate">{kind === 'goal' ? 'Make this a goal' : 'Make this a loop'}</span>
        </button>
      </Tip>
      <button type="button" aria-label="Not now" onClick={onDismiss} className="flex h-6 items-center rounded-r-full pr-2 pl-1 text-ink-4 transition-colors hover:text-ink">
        <X className="size-3" />
      </button>
    </span>
  )
}

/** After the message was improved: the way back to what was written. */
export function UndoChip({ onUndo }: { onUndo(): void }) {
  return (
    <span className={cn(chip, 'gap-1 bg-accent-soft pr-0.5 text-accent')}>
      <WandSparkles className="size-3 shrink-0" strokeWidth={2} />
      Improved
      <button type="button" onClick={onUndo} className="ml-1 flex h-5 items-center gap-1 rounded-full bg-surface px-1.5 text-ink-2 shadow-card transition-colors hover:text-ink">
        <Undo2 className="size-3" strokeWidth={2.1} /> Undo
      </button>
    </span>
  )
}
