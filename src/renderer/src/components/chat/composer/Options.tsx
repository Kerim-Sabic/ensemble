import { useRef, useState } from 'react'
import { CalendarClock, Flame, Hourglass, Repeat, Target, Timer, UserCheck, X } from 'lucide-react'
import { UltraGlyph } from '../../ultra/Ultra'
import { WORK_MODES, type Account, type WorkMode } from '@shared/types'
import { EVERY_PRESETS, MODE_INFO, ROUND_PRESETS, everyLabel, parseEvery } from '@shared/auto'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Kbd, Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from '../../ui'
import { Orb } from '../../Orb'
import { CHECKS, RUN_LIMITS, TIME_LIMITS, gocrazyAllowed, paceLabel, type Extras } from './extras'
import { InlineField, MODE_ICON, Pill } from './bits'

/**
 * How the lead goes about the next message. Goes back to Auto once it is sent. Ultra is not a
 * way of working for one message here but the chat's own switch, so it shows as checked while on.
 */
export function ModePill({ mode, onChange, ultra, onUltra }: { mode: WorkMode; onChange(m: WorkMode): void; ultra: boolean; onUltra(on: boolean): void }) {
  const Icon = MODE_ICON[mode]
  const item = (m: WorkMode) => {
    const I = MODE_ICON[m]
    return (
      <MenuItem key={m} icon={<I className="size-[15px]" strokeWidth={1.75} />} checked={m === mode} hint={m === 'chat' && ultra ? 'In Ultra, while it is on for this chat' : MODE_INFO[m].hint} onSelect={() => onChange(m)}>
        {MODE_INFO[m].label}
      </MenuItem>
    )
  }
  const locked = !gocrazyAllowed(ultra)
  return (
    <Menu
      side="top"
      width={316}
      trigger={
        mode === 'gocrazy' ? (
          // Go crazy is Ultra's own: it wears Ultra's colours, not the teammate's.
          <Pill className="cu-pill font-semibold" icon={<Flame className="cu-icon size-[14px] shrink-0" strokeWidth={2} />} aria-label={`Way of working: ${MODE_INFO[mode].label}`}>
            <span className="cu-text">{MODE_INFO[mode].label}</span>
          </Pill>
        ) : (
          <Pill on={mode !== 'chat'} icon={<Icon className="size-[14px] shrink-0" strokeWidth={1.75} />} aria-label={`Way of working: ${MODE_INFO[mode].label}`}>
            {MODE_INFO[mode].label}
          </Pill>
        )
      }
    >
      <MenuLabel>Way of working for this message</MenuLabel>
      {WORK_MODES.filter((m) => m !== 'ultra' && m !== 'gocrazy').map(item)}
      <MenuSeparator />
      <MenuLabel>Full power · uses allowance very fast</MenuLabel>
      <MenuItem
        icon={<UltraGlyph size={15} className={cn(!ultra && 'opacity-70 grayscale')} />}
        checked={ultra}
        hint={ultra ? 'On for this chat. Choose again to turn it off' : 'Many agents on the strongest models at full effort. Stays on for this chat'}
        onSelect={() => onUltra(!ultra)}
      >
        <span className="flex items-center gap-2">
          Ultra <Kbd>Alt+U</Kbd>
        </span>
      </MenuItem>
      <MenuItem
        icon={<Flame className="size-[15px]" strokeWidth={1.75} />}
        checked={mode === 'gocrazy'}
        disabled={locked}
        hint={locked ? 'Turn Ultra on first' : MODE_INFO.gocrazy.hint}
        onSelect={() => onChange(mode === 'gocrazy' ? 'chat' : 'gocrazy')}
      >
        {MODE_INFO.gocrazy.label}
      </MenuItem>
    </Menu>
  )
}

const RowTitle = ({ kind }: { kind: 'goal' | 'loop' }) => {
  const Icon = kind === 'goal' ? Target : Repeat
  return (
    <span className="flex h-7 shrink-0 items-center gap-1.5 pr-1 pl-1 text-[12.5px] font-semibold text-accent">
      <Icon className="size-[14px]" strokeWidth={2} />
      {kind === 'goal' ? 'Goal' : 'Loop'}
    </span>
  )
}

const Close = ({ label, onClick }: { label: string; onClick(): void }) => (
  <Tip label={label} side="top">
    <button type="button" aria-label={label} onClick={onClick} className="absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-[8px] text-ink-4 transition-colors hover:bg-hover hover:text-ink">
      <X className="size-3.5" />
    </button>
  </Tip>
)

/** The settings of a goal about to be started: how to tell it is done, and how far it may go. */
export function GoalOptions({
  x,
  set,
  onSubmit,
  onDone,
  replaces,
  lead,
  notLead,
}: {
  x: Extras
  set(patch: Partial<Extras>): void
  onSubmit(): void
  /** Hands the keyboard back to the message. */
  onDone(): void
  /** The chat already has a goal under way. */
  replaces: boolean
  lead?: Account
  /** Someone other than the lead is selected: the goal goes to the lead all the same. */
  notLead: boolean
}) {
  const settings = useStore((s) => s.settings)
  const rounds = x.rounds ?? settings.goalRounds ?? 12
  const check = x.check ?? settings.goalCheck ?? 'fresh'
  const limit = TIME_LIMITS.find((t) => t.minutes === x.minutes) || TIME_LIMITS[0]
  const presets = ROUND_PRESETS.includes(rounds) ? ROUND_PRESETS : [...ROUND_PRESETS, rounds].sort((a, b) => a - b)

  return (
    <div className="relative pt-2.5 pr-11 pl-3">
      <div className="flex flex-wrap items-center gap-1">
        <RowTitle kind="goal" />
        <Menu
          side="top"
          width={220}
          trigger={
            <Pill icon={<Hourglass className="size-[13px] shrink-0" strokeWidth={1.75} />} aria-label="Rounds">
              {rounds} rounds
            </Pill>
          }
        >
          <MenuLabel>Most rounds before it stops and asks</MenuLabel>
          {presets.map((n) => (
            <MenuItem key={n} checked={n === rounds} onSelect={() => set({ rounds: n })} hint={n === (settings.goalRounds ?? 12) ? 'Your usual' : undefined}>
              {n} rounds
            </MenuItem>
          ))}
        </Menu>
        <Menu
          side="top"
          width={200}
          trigger={
            <Pill icon={<CalendarClock className="size-[13px] shrink-0" strokeWidth={1.75} />} aria-label="Time limit">
              {limit.minutes ? `Up to ${limit.label}` : limit.label}
            </Pill>
          }
        >
          <MenuLabel>Stop after</MenuLabel>
          {TIME_LIMITS.map((t) => (
            <MenuItem key={t.label} checked={t.minutes === x.minutes} onSelect={() => set({ minutes: t.minutes })}>
              {t.label}
            </MenuItem>
          ))}
        </Menu>
        <Menu
          side="top"
          width={270}
          trigger={
            <Pill icon={<UserCheck className="size-[13px] shrink-0" strokeWidth={1.75} />} aria-label="Who checks">
              {CHECKS[check].label}
            </Pill>
          }
        >
          <MenuLabel>Who says it is done</MenuLabel>
          {(['fresh', 'self'] as const).map((c) => (
            <MenuItem key={c} checked={c === check} hint={CHECKS[c].hint} onSelect={() => set({ check: c })}>
              {CHECKS[c].label}
            </MenuItem>
          ))}
        </Menu>
        <InlineField
          label="Done when"
          value={x.doneWhen}
          onChange={(doneWhen) => set({ doneWhen })}
          placeholder="optional, e.g. all tests pass"
          onEnter={onSubmit}
          onEscape={onDone}
          className="ml-1 min-w-[180px] flex-1 basis-[240px]"
        />
      </div>
      <Close label="Not a goal" onClick={() => set({ kind: null })} />
      {(replaces || (notLead && lead)) && (
        <div className="flex items-center gap-1.5 pt-1.5 pl-1.5 text-[11.5px] text-ink-3">
          {notLead && lead && (
            <span className="flex items-center gap-1">
              Goes to <Orb account={lead} size={12} /> <span className="font-medium text-ink-2">{lead.name}</span>, who leads this chat
            </span>
          )}
          {notLead && lead && replaces && <span className="text-ink-4">·</span>}
          {replaces && <span>Replaces the current goal</span>}
        </div>
      )}
    </div>
  )
}

/** The settings of a loop about to be started: how often, until when, how many times. */
export function LoopOptions({ x, set, onSubmit, onDone }: { x: Extras; set(patch: Partial<Extras>): void; onSubmit(): void; onDone(): void }) {
  const keepRunning = useStore((s) => s.settings.keepRunning)
  const run = useStore((s) => s.run)
  const [custom, setCustom] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  const openCustom = (): void => {
    setCustom(x.every && !EVERY_PRESETS.some((p) => p.ms === x.every) ? everyLabel(x.every).replace(/^every /, '').replace(/\s+/g, '') : '')
    setBad(false)
    // The menu hands focus back to its button as it closes; take it after that.
    setTimeout(() => field.current?.focus(), 40)
  }
  const commit = (): boolean => {
    if (custom === null) return true
    if (!custom.trim()) {
      setCustom(null)
      return true
    }
    const ms = parseEvery(custom)
    if (!ms) {
      setBad(true)
      return false
    }
    set({ every: ms })
    setCustom(null)
    return true
  }

  return (
    <div className="relative pt-2.5 pr-11 pl-3">
      <div className="flex flex-wrap items-center gap-1">
        <RowTitle kind="loop" />
        {custom !== null ? (
          <Tip label={bad ? 'Write it like 10m, 2h or 1d (at least a minute)' : 'Like 10m, 90m, 2h or 1d'} side="top">
            <label
              className={cn(
                'flex h-7 w-[132px] shrink-0 items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 text-[12.5px] shadow-[inset_0_0_0_1px_var(--line)]',
                bad ? 'shadow-[inset_0_0_0_1px_var(--bad)]' : 'focus-within:shadow-[inset_0_0_0_1px_var(--line-2),0_0_0_3px_color-mix(in_oklab,var(--a2)_16%,transparent)]',
              )}
            >
              <span className="text-ink-3">Every</span>
              <input
                ref={field}
                value={custom}
                placeholder="10m"
                spellCheck={false}
                aria-label="Custom pace"
                onChange={(e) => {
                  setCustom(e.target.value)
                  setBad(false)
                }}
                onBlur={() => void commit()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (commit()) onDone()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setCustom(null)
                    onDone()
                  }
                }}
                className="selectable w-full min-w-0 bg-transparent text-ink outline-none placeholder:text-ink-4"
              />
            </label>
          </Tip>
        ) : (
          <Menu
            side="top"
            width={210}
            trigger={
              <Pill icon={<Timer className="size-[13px] shrink-0" strokeWidth={1.75} />} aria-label="How often">
                {paceLabel(x.every)}
              </Pill>
            }
          >
            <MenuLabel>How often it runs</MenuLabel>
            {EVERY_PRESETS.map((p) => (
              <MenuItem key={p.label} checked={p.ms === x.every} hint={p.ms === null ? 'The agent says when the next run is due' : undefined} onSelect={() => set({ every: p.ms })}>
                {p.label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem checked={!!x.every && !EVERY_PRESETS.some((p) => p.ms === x.every)} hint="Type it, like 10m, 2h or 1d" onSelect={openCustom}>
              {x.every && !EVERY_PRESETS.some((p) => p.ms === x.every) ? paceLabel(x.every) : 'Another pace'}
            </MenuItem>
          </Menu>
        )}
        <Menu
          side="top"
          width={190}
          trigger={
            <Pill icon={<Hourglass className="size-[13px] shrink-0" strokeWidth={1.75} />} aria-label="Most runs">
              {x.maxRuns ? `Up to ${x.maxRuns} runs` : 'No run limit'}
            </Pill>
          }
        >
          <MenuLabel>Stop after</MenuLabel>
          {RUN_LIMITS.map((n) => (
            <MenuItem key={n ?? 0} checked={n === x.maxRuns} onSelect={() => set({ maxRuns: n })}>
              {n ? `${n} runs` : 'No limit'}
            </MenuItem>
          ))}
        </Menu>
        <InlineField
          label="Stop when"
          value={x.until}
          onChange={(until) => set({ until })}
          placeholder="optional, e.g. the deploy is live"
          onEnter={onSubmit}
          onEscape={onDone}
          className="ml-1 min-w-[180px] flex-1 basis-[240px]"
        />
      </div>
      <Close label="Not a loop" onClick={() => set({ kind: null })} />
      {!keepRunning && (
        <div className="flex flex-wrap items-center gap-x-2 pt-1.5 pl-1.5 text-[11.5px] text-ink-3">
          <span>Loops run only while Ensemble is open.</span>
          <button type="button" onClick={() => void run(api.updateSettings({ keepRunning: true }))} className="font-medium text-ink-2 underline decoration-line-2 underline-offset-2 transition-colors hover:text-ink hover:decoration-ink-3">
            Keep it running in the tray
          </button>
        </div>
      )}
    </div>
  )
}
