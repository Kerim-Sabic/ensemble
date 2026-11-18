import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AppWindow,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  Clock,
  Eye,
  Globe,
  Hand,
  Keyboard,
  Monitor,
  MousePointer2,
  MousePointerClick,
  Move,
  RotateCw,
  Search,
  Square,
  Type,
  X,
} from 'lucide-react'
import type { Account, ScreenInput, ScreenKind, ScreenState } from '@shared/types'
import { agentKey, isBusy, screenKey, useStore, useTeam } from '@/store'
import { screenSteps, type ScreenItem } from '@/lib/derive'
import { accentVars, api, cn, relative, siteOf } from '@/lib/util'
import { Button, IconButton, Segmented, Spinner, Tip } from '../ui'
import { KeyRound } from 'lucide-react'
import { Orb } from '../Orb'
import { seedComposer } from '../chat/Composer'
import { LiveFrame, Pointer, StepMark, SurfaceIcon } from './Screen'
import { LiveGrid } from './LiveGrid'

export function StepIcon({ action, surface, className }: { action: string; surface: ScreenKind; className?: string }) {
  const p = { className, strokeWidth: 1.75 }
  switch (action) {
    case 'open':
      return surface === 'browser' ? <Globe {...p} /> : <AppWindow {...p} />
    case 'click':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
      return <MousePointerClick {...p} />
    case 'type':
      return <Type {...p} />
    case 'press':
    case 'key':
      return <Keyboard {...p} />
    case 'scroll':
      return <ArrowDownUp {...p} />
    case 'back':
      return <ArrowLeft {...p} />
    case 'forward':
      return <ArrowRight {...p} />
    case 'reload':
      return <RotateCw {...p} />
    case 'find':
      return <Search {...p} />
    case 'look':
    case 'screenshot':
      return <Eye {...p} />
    case 'read':
      return <BookOpenText {...p} />
    case 'wait':
      return <Clock {...p} />
    case 'select':
      return <ChevronsUpDown {...p} />
    case 'windows':
    case 'focus_window':
      return <AppWindow {...p} />
    case 'left_click_drag':
      return <Move {...p} />
    case 'mouse_move':
      return <MousePointer2 {...p} />
    default:
      return <SurfaceIcon kind={surface} className={className} />
  }
}

export interface ScreenEntry {
  key: string
  account: Account
  kind: ScreenKind
  screen?: ScreenState
  steps: ScreenItem[]
  at: number
}

const EMPTY: ScreenItem[] = []

/** Every screen this chat has: the ones open right now, and the ones that only have a recording. */
export function useScreens(chatId: string): ScreenEntry[] {
  const team = useTeam()
  const screens = useStore((s) => s.screens)
  // Changes when a step is added or finishes, not on every streamed word.
  const sig = useStore((s) =>
    team
      .map((a) => {
        const items = s.items[agentKey(chatId, a.id)]
        if (!items) return ''
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i]
          if (it.kind === 'screen') return `${items.length}:${it.id}:${it.status}:${it.shot ? 1 : 0}`
        }
        return '0'
      })
      .join('|'),
  )
  return useMemo(() => {
    const st = useStore.getState()
    const out: ScreenEntry[] = []
    for (const a of team) {
      const items = st.items[agentKey(chatId, a.id)] || []
      for (const kind of ['browser', 'desktop'] as const) {
        const key = screenKey(chatId, a.id, kind)
        const steps = items.length ? screenSteps(items, kind) : EMPTY
        const screen = screens[key]
        if (!screen && !steps.length) continue
        out.push({ key, account: a, kind, screen, steps, at: steps.length ? steps[steps.length - 1].ts : Date.now() })
      }
    }
    return out.sort((x, y) => Number(!!y.screen?.active) - Number(!!x.screen?.active) || Number(!!y.screen) - Number(!!x.screen) || y.at - x.at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, screens, team, chatId])
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

function Stage({ entry, chatId, step, control }: { entry: ScreenEntry; chatId: string; step: ScreenItem | null; control: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const ratio = entry.screen ? entry.screen.width / entry.screen.height : entry.kind === 'browser' ? 1280 / 800 : 16 / 9
  const lastShot = [...entry.steps].reverse().find((s) => s.shot)?.shot
  const moved = useRef(0)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      const width = Math.min(w, h * ratio)
      setSize({ w: Math.floor(width), h: Math.floor(width / ratio) })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ratio])

  useEffect(() => {
    if (control) stage.current?.focus()
  }, [control])

  const send = useCallback((input: ScreenInput) => void api.screenInput(chatId, entry.account.id, input), [chatId, entry.account.id])
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = (stage.current as HTMLDivElement).getBoundingClientRect()
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }
  }
  const mods = (e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): string[] =>
    [e.ctrlKey && 'control', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta'].filter((m): m is string => !!m)
  const button = (b: number): 'left' | 'middle' | 'right' => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left')

  const hands = control && !step && entry.kind === 'browser' && !!entry.screen
  const showing = step?.shot || (!entry.screen ? lastShot : undefined)

  return (
    <div ref={box} className="flex min-h-0 flex-1 items-center justify-center">
      <div
        ref={stage}
        tabIndex={hands ? 0 : -1}
        style={{ width: size.w, height: size.h, ...accentVars(entry.account.accent) }}
        className={cn(
          'relative overflow-hidden rounded-[10px] bg-surface-3 shadow-float outline-none transition-shadow duration-200',
          hands && 'cursor-default shadow-[0_0_0_2px_var(--ink),0_12px_32px_-12px_rgba(0,0,0,0.35)]',
          entry.screen?.active && !step && !hands && 'shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--a2)_70%,transparent),0_16px_44px_-16px_color-mix(in_oklab,var(--a2)_55%,transparent)]',
        )}
        onMouseMove={
          hands
            ? (e) => {
                const now = performance.now()
                if (now - moved.current < 30) return
                moved.current = now
                send({ type: 'mouse', action: 'move', ...at(e), mods: mods(e) })
              }
            : undefined
        }
        onMouseDown={
          hands
            ? (e) => {
                e.preventDefault()
                stage.current?.focus()
                send({ type: 'mouse', action: 'down', ...at(e), button: button(e.button), clicks: e.detail || 1, mods: mods(e) })
              }
            : undefined
        }
        onMouseUp={hands ? (e) => send({ type: 'mouse', action: 'up', ...at(e), button: button(e.button), clicks: e.detail || 1, mods: mods(e) }) : undefined}
        onWheel={hands ? (e) => send({ type: 'wheel', ...at(e), dx: e.deltaX, dy: e.deltaY }) : undefined}
        onContextMenu={hands ? (e) => e.preventDefault() : undefined}
        onKeyDown={
          hands
            ? (e) => {
                e.preventDefault()
                e.stopPropagation()
                send({ type: 'key', action: 'down', key: e.key, mods: mods(e) })
              }
            : undefined
        }
        onKeyUp={
          hands
            ? (e) => {
                e.preventDefault()
                e.stopPropagation()
                send({ type: 'key', action: 'up', key: e.key, mods: mods(e) })
              }
            : undefined
        }
      >
        {showing ? (
          <img src={api.fileUrl(showing)} alt="" draggable={false} className="absolute inset-0 size-full object-fill" />
        ) : entry.screen && !step ? (
          <LiveFrame screenKey={entry.key} still={lastShot} full className="absolute inset-0 size-full object-fill" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px] text-ink-3">
            <SurfaceIcon kind={entry.kind} className="size-6 text-ink-4" />
            {step ? 'No picture was kept for this step.' : 'Nothing to show yet.'}
          </div>
        )}
        {step && step.x !== undefined && step.y !== undefined && <StepMark x={step.x} y={step.y} account={entry.account} />}
        {!step && entry.screen?.pointer && !hands && <Pointer pointer={entry.screen.pointer} account={entry.account} />}
        {!step && !entry.screen && showing && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-4 pt-10 pb-3 text-[12.5px] text-white">
            {entry.kind === 'browser' ? 'This browser has been closed. This is the last thing it showed.' : 'This is the last picture of the screen from when it was in use.'}
          </div>
        )}
      </div>
    </div>
  )
}

function Toolbar({ entry, chatId, control, setControl, replaying }: { entry: ScreenEntry; chatId: string; control: boolean; setControl(v: boolean): void; replaying: boolean }) {
  const run = useStore((s) => s.run)
  const busy = useStore((s) => isBusy(s.agents[agentKey(chatId, entry.account.id)]))
  const sc = entry.screen
  const [draft, setDraft] = useState<string | null>(null)
  const lastUrl = [...entry.steps].reverse().find((s) => s.url)?.url
  const go = (to: string): void => void run(api.screenGo(chatId, entry.account.id, to))

  if (entry.kind === 'desktop') {
    return (
      <div className="flex h-11 shrink-0 items-center gap-2.5 px-1 text-[13px]">
        <Monitor className="size-4 text-ink-3" strokeWidth={1.75} />
        <span className="font-medium">This computer</span>
        <span className="min-w-0 flex-1 truncate text-ink-3">
          {sc?.active ? `${entry.account.name} has the mouse and keyboard. Press Esc anywhere to stop it.` : 'A recording of what was done on your screen.'}
        </span>
        {sc?.active && busy && (
          <Button size="sm" onClick={() => void api.stop(chatId, entry.account.id)}>
            <Square className="size-2.5 fill-current" strokeWidth={0} /> Stop {entry.account.name}
          </Button>
        )}
      </div>
    )
  }

  if (!sc) {
    return (
      <div className="flex h-11 shrink-0 items-center gap-2.5 px-1 text-[13px]">
        <Globe className="size-4 text-ink-3" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-ink-3">{lastUrl ? siteOf(lastUrl) : 'Browser'} · closed</span>
        <Button size="sm" onClick={() => void run(api.screenOpen(chatId, entry.account.id, lastUrl))}>
          Open it again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1">
      <IconButton label="Back" disabled={!sc.canGoBack || replaying} onClick={() => go('back')}>
        <ArrowLeft className="size-[15px]" />
      </IconButton>
      <IconButton label="Forward" disabled={!sc.canGoForward || replaying} onClick={() => go('forward')}>
        <ArrowRight className="size-[15px]" />
      </IconButton>
      <IconButton label="Reload" disabled={replaying} onClick={() => go('reload')}>
        {sc.loading ? <Spinner className="size-3.5" /> : <RotateCw className="size-[14px]" />}
      </IconButton>
      <form
        className="mx-1 min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault()
          const v = (draft ?? '').trim()
          setDraft(null)
          ;(document.activeElement as HTMLElement | null)?.blur()
          if (v) go(v)
        }}
      >
        <input
          value={draft ?? (sc.url && sc.url !== 'about:blank' ? sc.url : '')}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => setDraft(null)}
          placeholder="Type an address and press Enter"
          spellCheck={false}
          aria-label="Address"
          className="selectable h-8 w-full rounded-full bg-surface-2 px-3.5 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-shadow placeholder:text-ink-3 focus:text-ink focus:shadow-[inset_0_0_0_1px_var(--line-2),0_0_0_3px_color-mix(in_oklab,var(--link)_18%,transparent)]"
        />
      </form>
      <Tip label={control ? 'Give the mouse back' : 'Use this browser yourself, for example to sign in'}>
        <button
          onClick={() => setControl(!control)}
          disabled={replaying}
          className={cn(
            'no-drag flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors disabled:opacity-40',
            control ? 'bg-ink text-inverse' : 'text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-hover hover:text-ink',
          )}
        >
          <Hand className="size-3.5" /> {control ? 'You have the mouse' : 'Take the mouse'}
        </button>
      </Tip>
      <IconButton label="Close this browser" onClick={() => void api.screenClose(chatId, entry.account.id)}>
        <X className="size-[15px]" />
      </IconButton>
    </div>
  )
}

function Steps({ entry, stepId, onPick }: { entry: ScreenEntry; stepId: string | null; onPick(id: string | null): void }) {
  const steps = entry.steps
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!stepId) list.current?.scrollTo({ top: 0 })
  }, [steps.length, stepId])
  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-l border-line bg-surface-2/60">
      <div className="flex h-11 shrink-0 items-center justify-between pr-3 pl-4 text-[12px]">
        <span className="font-medium text-ink-2">What it did</span>
        <span className="tabular text-ink-3">{steps.length ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : ''}</span>
      </div>
      <div ref={list} className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
        {entry.screen && (
          <button
            onClick={() => onPick(null)}
            className={cn('flex w-full items-center gap-2.5 rounded-[9px] px-2 py-2 text-left text-[12.5px] transition-colors', !stepId ? 'bg-active font-medium' : 'hover:bg-hover')}
          >
            <span className="flex size-4 items-center justify-center">
              <span className={cn('size-2 rounded-full', entry.screen.active ? 'animate-pulse-soft bg-bad' : 'bg-ok')} />
            </span>
            {entry.screen.active ? 'Live' : 'As it is now'}
          </button>
        )}
        {[...steps].reverse().map((s, i) => (
          <button
            key={s.id}
            onClick={() => onPick(s.id)}
            className={cn('group/st flex w-full items-start gap-2.5 rounded-[9px] px-2 py-1.5 text-left transition-colors', stepId === s.id ? 'bg-active' : 'hover:bg-hover')}
          >
            <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center">
              {s.status === 'running' ? <Spinner className="size-3" /> : s.status === 'error' ? <CircleAlert className="size-3.5 text-bad" /> : <StepIcon action={s.action} surface={s.surface} className="size-3.5 text-ink-3" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('line-clamp-2 block text-[12.5px] leading-snug', s.status === 'running' ? 'shimmer-text' : s.status === 'error' ? 'text-ink-2' : 'text-ink')}>{s.label}</span>
              {s.status === 'error' && s.error && <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-bad">{s.error}</span>}
              {s.surface === 'browser' && s.url && s.action === 'open' && <span className="block truncate text-[11px] text-ink-4">{siteOf(s.url)}</span>}
            </span>
            <span className="tabular mt-[2px] shrink-0 text-[10.5px] text-ink-4">{steps.length - i}</span>
          </button>
        ))}
        {!steps.length && <p className="px-2 pt-1 text-[12px] leading-relaxed text-ink-3">Each thing a teammate does here is listed as it happens. Click one to see the screen at that moment.</p>}
      </div>
    </aside>
  )
}

/** Sign in to a site before the team needs it. The team's browsers share one set of sign-ins and keep them. */
function SignInAhead({ chatId, leadId }: { chatId: string; leadId: string }) {
  const run = useStore((s) => s.run)
  const watch = useStore((s) => s.watch)
  const [url, setUrl] = useState('')
  const go = async (): Promise<void> => {
    const u = url.trim()
    if (!u) return
    await run(api.screenOpen(chatId, leadId, /^[a-z]+:/i.test(u) ? u : `https://${u}`))
    watch(screenKey(chatId, leadId, 'browser'), null, true)
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void go()
      }}
      className="mt-6 flex w-[460px] max-w-full items-center gap-2 rounded-[14px] bg-surface p-1.5 pl-3.5 shadow-card"
    >
      <KeyRound className="size-4 shrink-0 text-ink-3" strokeWidth={1.8} />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Sign in to a site the team will need, e.g. github.com"
        spellCheck={false}
        className="selectable h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
      />
      <Button size="sm" variant="primary" type="submit" disabled={!url.trim()}>
        Open and sign in
      </Button>
    </form>
  )
}

function Empty({ chatId }: { chatId: string }) {
  const env = useStore((s) => s.env)
  const settings = useStore((s) => s.settings)
  const lead = useTeam()[0]
  const run = useStore((s) => s.run)
  const setView = useStore((s) => s.setView)
  const setModal = useStore((s) => s.setModal)
  const browser = env.canBrowse && settings.browser
  const computer = env.canControl && settings.computer !== 'off'
  const ask = (text: string): void => {
    setView('chat')
    setTimeout(() => seedComposer(text), 60)
  }
  const ideas = [
    browser && { icon: Globe, title: 'Check a site the team built', text: 'Open the site in your browser, click through the main flow and tell me what looks wrong: ' },
    browser && { icon: Search, title: 'Look something up on a site', text: 'Open the browser and find out ' },
    computer && { icon: Monitor, title: 'Do something in an app', text: 'On my computer, ' },
  ].filter((x): x is { icon: typeof Globe; title: string; text: string } => !!x)

  return (
    <div className="hero flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-[18px] bg-surface shadow-float">
        <MousePointerClick className="size-6 text-ink-2" strokeWidth={1.6} />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.02em]">Watch the team work a screen</h1>
      <p className="mt-2 max-w-[460px] text-[13.5px] leading-relaxed text-ink-2">
        {browser || computer
          ? `When a teammate opens a web page${computer ? ' or uses your computer' : ''}, you see it here as it happens, with every step recorded so you can go back through it.`
          : 'The browser and computer control are switched off. Turn them on in Settings to let the team open web pages and use apps.'}
      </p>
      {ideas.length > 0 && (
        <div className="mt-7 flex max-w-[640px] flex-wrap justify-center gap-2">
          {ideas.map((i) => (
            <button key={i.title} onClick={() => ask(i.text)} className="flex h-9 items-center gap-2 rounded-full bg-surface px-3.5 text-[12.5px] font-medium shadow-card transition-all hover:-translate-y-px hover:shadow-float">
              <i.icon className="size-3.5 text-ink-3" strokeWidth={1.9} /> {i.title}
            </button>
          ))}
        </div>
      )}
      {browser && lead && <SignInAhead chatId={chatId} leadId={lead.id} />}
      <div className="mt-5 flex gap-2">
        {browser && lead && (
          <Button variant="ghost" onClick={() => void run(api.screenOpen(chatId, lead.id))}>
            Open {lead.name}'s browser yourself
          </Button>
        )}
        {!(browser || computer) && (
          <Button variant="primary" onClick={() => setModal({ kind: 'settings' })}>
            Open Settings
          </Button>
        )}
      </div>
    </div>
  )
}

type Mode = 'single' | 'all'
const MODE_KEY = 'ensemble.live.mode'
const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'single' ? 'single' : 'all'
  } catch {
    return 'all'
  }
}
/** The screen the Live view showed last, so coming back after being sent to another one opens that one. */
let lastKey: string | null = null

/** Every screen the team is working in this chat, live, with a recording of each step. */
export function LiveView() {
  const chatId = useStore((s) => s.chatId)
  const live = useStore((s) => s.live)
  const setLive = useStore((s) => s.setLive)
  const entries = useScreens(chatId || '')
  const [control, setControl] = useState(false)
  // Single or All. Being sent to one screen (from a card in the chat, a step, signing in) shows that one.
  const [mode, setModeState] = useState<Mode>(() => (live.step || live.control || (live.key && live.key !== lastKey) ? 'single' : readMode()))
  const setMode = useCallback((m: Mode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* forgotten next time */
    }
  }, [])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (live.key || live.step) setModeState('single')
  }, [live.key, live.step])
  useEffect(() => {
    lastKey = live.key
  }, [live.key])
  const open = useMemo(() => entries.filter((e) => e.screen), [entries])
  const grid = open.length > 1 && mode === 'all' && !live.step && !control

  const entry = entries.find((e) => e.key === live.key) || entries[0]
  const step = entry && live.step ? entry.steps.find((s) => s.id === live.step) || null : null
  const state = useStore((s) => (chatId && entry ? s.agents[agentKey(chatId, entry.account.id)] : undefined))

  // Taking the mouse is for the screen in front of you, not the next one you switch to,
  // unless you came here to sign in, in which case you have it straight away.
  useEffect(() => {
    setControl(!!live.control && !live.step)
    if (live.control) setLive({ control: false })
  }, [entry?.key, live.step]) // eslint-disable-line react-hooks/exhaustive-deps

  const move = useCallback(
    (by: number) => {
      if (!entry?.steps.length) return
      const i = live.step ? entry.steps.findIndex((s) => s.id === live.step) : entry.steps.length
      const next = i + by
      if (next >= entry.steps.length) setLive({ step: null })
      else if (next >= 0) setLive({ step: entry.steps[next].id })
    },
    [entry, live.step, setLive],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (grid || control || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'))) return
      if (e.key === 'ArrowLeft') move(-1)
      else if (e.key === 'ArrowRight') move(1)
      else if (e.key === 'Escape' && live.step) setLive({ step: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move, control, grid, live.step, setLive])

  if (!chatId) return null
  if (!entry) return <Empty chatId={chatId} />

  const index = step ? entry.steps.indexOf(step) : -1
  const busy = isBusy(state)
  const latest = entry.steps[entry.steps.length - 1]
  const toggle = open.length > 1 && (
    <Segmented<Mode>
      value={grid ? 'all' : 'single'}
      onChange={setMode}
      className="shrink-0"
      options={[
        { value: 'single', label: 'Single' },
        { value: 'all', label: 'All', badge: open.length },
      ]}
    />
  )

  if (grid) {
    const working = open.filter((e) => e.screen?.active).length
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-2 px-5 pt-2 pb-4">
        <div className="flex h-11 shrink-0 items-center gap-3">
          {toggle}
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
            {open.length} screens open{working ? ` · ${working} in use right now` : ''} · click one to watch it on its own
          </span>
        </div>
        <LiveGrid
          entries={open}
          chatId={chatId}
          onFocus={(key) => {
            setMode('single')
            setLive({ key, step: null })
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-surface-2">
      <div className="flex min-w-0 flex-1 flex-col px-4 pt-2 pb-3">
        {entries.length > 1 && (
          <div className="flex shrink-0 items-center gap-3 pt-1 pb-1.5">
          {toggle}
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {entries.map((e) => (
              <button
                key={e.key}
                onClick={() => setLive({ key: e.key, step: null })}
                style={accentVars(e.account.accent)}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-2 rounded-full pr-3 pl-1.5 text-[12.5px] transition-colors',
                  e.key === entry.key ? 'bg-surface font-medium shadow-card' : 'text-ink-2 hover:bg-hover hover:text-ink',
                )}
              >
                <Orb account={e.account} size={18} live={!!e.screen?.active} />
                {e.account.name}
                <SurfaceIcon kind={e.kind} className="size-3.5 text-ink-3" />
                {e.screen?.active && <span className="size-1.5 animate-pulse-soft rounded-full bg-bad" />}
              </button>
            ))}
          </div>
          </div>
        )}
        <Toolbar entry={entry} chatId={chatId} control={control} setControl={setControl} replaying={!!step} />
        <Stage entry={entry} chatId={chatId} step={step} control={control} />
        <div className="flex h-10 shrink-0 items-center gap-2.5 pt-2 text-[12.5px]" style={accentVars(entry.account.accent)}>
          {step ? (
            <>
              <IconButton label="Earlier step" kbd="←" side="top" disabled={index <= 0} onClick={() => move(-1)}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <span className="tabular text-ink-3">
                Step {index + 1} of {entry.steps.length}
              </span>
              <IconButton label="Later step" kbd="→" side="top" onClick={() => move(1)}>
                <ChevronRight className="size-4" />
              </IconButton>
              <StepIcon action={step.action} surface={step.surface} className="ml-1 size-3.5 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{step.label}</span>
              <span className="shrink-0 text-ink-4">{relative(step.ts) === 'now' ? 'just now' : `${relative(step.ts)} ago`}</span>
              {entry.screen && (
                <Button size="sm" onClick={() => setLive({ step: null })}>
                  Back to live
                </Button>
              )}
            </>
          ) : (
            <>
              <Orb account={entry.account} size={18} live={busy && !!entry.screen?.active} />
              <span className="font-medium">{entry.account.name}</span>
              <span className={cn('min-w-0 flex-1 truncate', busy && entry.screen?.active ? 'shimmer-text' : 'text-ink-3')}>
                {control ? 'You have the mouse. Click in the page and type as you would in any browser.' : busy && entry.screen?.active ? state?.activity || 'Working' : latest ? latest.label : entry.screen?.title || 'Ready'}
              </span>
              {entry.kind === 'browser' && entry.screen?.title && !control && <span className="max-w-[34%] shrink-0 truncate text-ink-4">{entry.screen.title}</span>}
            </>
          )}
        </div>
      </div>
      <Steps entry={entry} stepId={step?.id || null} onPick={(id) => setLive({ key: entry.key, step: id })} />
    </div>
  )
}
