// The watches: each row answers at a glance what it watches, when it looks next, what the last
// look found, and what it cost today. A row opens to its recent history.
import { memo, useState } from 'react'
import { ChevronRight, CirclePause, CirclePlay, Eye, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { UnattendedCaps, Watch, WatchOutcome } from '@shared/watches'
import { DEFAULT_CAPS } from '@shared/watches'
import { useStore } from '@/store'
import { api, cn, relative } from '@/lib/util'
import { Button, IconButton, Menu, MenuItem, MenuSeparator, Spinner, inputClass } from '../ui'
import { capsLine, costLine, modelLooksToday, nextLine, OUTCOME, outcomeLine, readyMade, triggerLine, onFindWords } from './words'
import { openWatchEditor, refreshToday, useWatches, watchApi } from './state'

const TONE: Record<string, string> = { quiet: 'bg-ink-4', news: 'bg-link', bad: 'bg-bad', muted: 'bg-line-2' }
const TONE_TEXT: Record<string, string> = { quiet: 'text-ink-3', news: 'text-ink', bad: 'text-bad', muted: 'text-ink-3' }

function Dot({ outcome, paused }: { outcome?: WatchOutcome; paused?: boolean }) {
  const tone = outcome ? OUTCOME[outcome].tone : 'muted'
  return <span aria-hidden className={cn('mt-[6px] size-2 shrink-0 rounded-full', paused ? 'bg-transparent shadow-[inset_0_0_0_1.5px_var(--ink-4)]' : TONE[tone])} />
}

const History = memo(function History({ watch }: { watch: Watch }) {
  const runs = watch.runs.slice(0, 8)
  if (!runs.length) return <div className="px-4 pb-3 pl-[37px] text-[12px] text-ink-3">It has not looked yet.</div>
  return (
    <ol className="m-0 list-none space-y-1 px-4 pb-3.5 pl-[37px]">
      {runs.map((r) => (
        <li key={r.id} className="flex items-baseline gap-2.5 text-[12px]">
          <span className="tabular w-[92px] shrink-0 text-ink-4">{new Date(r.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          {/* The history stays calm: the colour is in the dot, the words in ink. */}
          <span aria-hidden className={cn('size-1.5 shrink-0 -translate-y-[1px] self-center rounded-full', TONE[OUTCOME[r.outcome].tone])} />
          <span className={cn('min-w-0 flex-1 leading-snug', OUTCOME[r.outcome].tone === 'quiet' || OUTCOME[r.outcome].tone === 'muted' ? 'text-ink-3' : 'text-ink-2')}>{outcomeLine(r)}</span>
          <span className="shrink-0 text-[11px] text-ink-4">{r.model ? r.model : 'no model'}</span>
        </li>
      ))}
    </ol>
  )
})

const Row = memo(function Row({ watch, now }: { watch: Watch; now: number }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const looking = useWatches((s) => !!s.looking[watch.id])
  const last = watch.runs[0]
  const paused = watch.status === 'paused'
  // Suggested by an agent and not yet confirmed: it waits, paused, for the user's yes in the inbox.
  const waiting = paused && watch.madeBy === 'agent' && !watch.runs.length
  const tone = last ? OUTCOME[last.outcome].tone : 'muted'
  return (
    <li>
      <div className="group/w flex items-start gap-3 px-4 py-3">
        <Dot outcome={last?.outcome} paused={paused} />
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <span className={cn('min-w-0 truncate text-[13.5px] font-medium', paused ? 'text-ink-3' : 'text-ink')}>{watch.name}</span>
            <ChevronRight className={cn('size-3 shrink-0 translate-y-[1px] text-ink-4 transition-transform', open && 'rotate-90')} />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-ink-3">
            {triggerLine(watch.trigger)} · {onFindWords(watch.onFind)}
          </div>
          <div className={cn('mt-1 line-clamp-2 text-[12.5px] leading-snug', TONE_TEXT[tone])}>
            {looking ? 'Looking now…' : outcomeLine(last)}
            {last && !looking && <span className="text-ink-4"> · {relative(last.at)}</span>}
          </div>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-0.5 pt-px text-right">
          <span className={cn('text-[12px]', waiting ? 'font-medium text-warn' : paused ? 'text-ink-4' : 'text-ink-2')}>{waiting ? 'Waiting for your OK' : nextLine(watch, now)}</span>
          <span className="text-[11px] text-ink-4">{costLine(watch, now)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="Look now" disabled={looking || paused} onClick={() => void watchApi.run(watch.id)}>
            {looking ? <Spinner /> : <RefreshCw className="size-3.5" />}
          </IconButton>
          <Menu
            align="end"
            width={200}
            trigger={
              <button aria-label={`More for ${watch.name}`} className="flex size-7 items-center justify-center rounded-[8px] text-ink-2 hover:bg-hover hover:text-ink">
                <MoreHorizontal className="size-4" />
              </button>
            }
          >
            <MenuItem icon={paused ? <CirclePlay className="size-3.5" /> : <CirclePause className="size-3.5" />} onSelect={() => void watchApi.pause(watch, !paused)}>
              {paused ? 'Resume' : 'Pause'}
            </MenuItem>
            <MenuItem icon={<Pencil className="size-3.5" />} onSelect={() => openWatchEditor(watch)}>
              Edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 className="size-3.5" />} onSelect={() => setConfirm(true)}>
              Delete
            </MenuItem>
          </Menu>
        </div>
      </div>
      {confirm && (
        <div role="alertdialog" aria-label="Delete this watch?" className="mx-4 mb-3 flex items-center gap-2 rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1 text-ink">Delete “{watch.name}”? Its history goes with it.</span>
          <Button size="sm" variant="ghost" autoFocus onClick={() => setConfirm(false)}>
            Keep
          </Button>
          <Button size="sm" variant="danger" onClick={() => void watchApi.remove(watch.id)}>
            Delete
          </Button>
        </div>
      )}
      {open && <History watch={watch} />}
    </li>
  )
})

/** Today's limits on work nobody is watching, with today's use and a way to change them. */
function Limits() {
  const today = useWatches((s) => s.today)
  const watches = useWatches((s) => s.watches)
  const saved = useStore((s) => s.settings.unattended)
  const caps = today?.caps || saved || DEFAULT_CAPS
  const used = today ? today.runs : modelLooksToday(watches || [])
  const [edit, setEdit] = useState<UnattendedCaps | null>(null)
  const num = (k: keyof UnattendedCaps, label: string, max: number) => (
    <label className="flex items-center gap-2 text-[12px] text-ink-2">
      {label}
      <input type="number" min={k === 'keepFree' ? 0 : 1} max={max} value={edit?.[k] ?? 0} onChange={(e) => setEdit((x) => (x ? { ...x, [k]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) } : x))} className={cn(inputClass, 'tabular h-7 w-[70px] px-2 text-right')} />
    </label>
  )
  return (
    <div className="mb-5 rounded-[12px] bg-surface-2 px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-ink">Daily limits</div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{capsLine(caps)}.</div>
        </div>
        {/* The engine's own count when it gives one; otherwise the looks that needed a model, from the watches' runs. */}
        <div className="shrink-0 text-right">
          <div className="tabular text-[13px] font-semibold text-ink">
            {used} <span className="font-normal text-ink-3">of {caps.runsPerDay}</span>
          </div>
          <div className="text-[11px] text-ink-4">looks used today</div>
        </div>
        {!edit && (
          <Button size="sm" variant="ghost" onClick={() => setEdit(caps)}>
            Change
          </Button>
        )}
      </div>
      {edit && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
          {num('runsPerDay', 'Looks a day', 1000)}
          {num('runsPerAccount', 'Per account', 1000)}
          {num('keepFree', 'Keep free %', 90)}
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                void api.updateSettings({ unattended: edit }).then(refreshToday)
                setEdit(null)
              }}
            >
              Save
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}

export function WatchList({ now, repo, cwd }: { now: number; repo?: string | null; cwd?: string | null }) {
  const watches = useWatches((s) => s.watches)
  const available = useWatches((s) => s.available)
  if (!watches) return null
  const sorted = [...watches].sort((a, b) => (a.status === b.status ? (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) : a.status === 'active' ? -1 : 1))
  return (
    <div>
      <Limits />
      {sorted.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-card">
          {sorted.map((w) => (
            <Row key={w.id} watch={w} now={now} />
          ))}
        </ul>
      ) : (
        <div className="mx-auto mt-10 max-w-[460px] text-center">
          <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-[14px] bg-surface-2 text-ink-3 shadow-card">
            <Eye className="size-5" strokeWidth={1.7} />
          </span>
          <div className="text-[15px] font-semibold text-ink">No watches yet</div>
          <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-ink-2">
            A watch looks at something by itself, on a schedule or when it changes, and stays silent until it finds something worth telling you.
            {!available && ' This build does not run watches yet.'}
          </p>
          <div className="mt-5 grid gap-2 text-left">
            {readyMade({ repo, cwd }).map((r) => (
              <button key={r.name} onClick={() => openWatchEditor(undefined, r)} className="flex items-center gap-3 rounded-[12px] bg-surface px-3.5 py-2.5 text-left shadow-card transition-colors hover:bg-surface-2">
                <Eye className="size-4 shrink-0 text-ink-3" strokeWidth={1.8} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{r.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">{r.why}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-4" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
