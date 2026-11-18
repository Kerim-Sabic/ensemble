// A mini app in the locked box. Its HTML is handed to the main process, which serves it on a
// protocol of its own with a content policy that allows nothing from anywhere; here it sits in
// a frame sandboxed with scripts only. It can talk to us in exactly three ways (its size, a
// message it offers, an error), each checked to come from its own frame and kept short. It can
// never send anything by itself: an offered message waits for a click.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { AppWindow, Check, Maximize2, RotateCcw, Send, TriangleAlert, X } from 'lucide-react'
import { APP_LIMITS } from '@shared/iui'
import { api, cn } from '@/lib/util'
import { Button, IconButton, Modal, Spinner } from '../ui'
import { useAnswer, useDark, useNear } from './kit'

const TOKENS: [string, string][] = [
  ['--bg', '--surface'],
  ['--surface', '--surface-2'],
  ['--surface-2', '--surface-3'],
  ['--hover', '--hover'],
  ['--ink', '--ink'],
  ['--ink-2', '--ink-2'],
  ['--ink-3', '--ink-3'],
  ['--line', '--line-2'],
  ['--accent', '--link'],
  ['--ok', '--ok'],
  ['--warn', '--warn'],
  ['--bad', '--bad'],
]
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']

/** The app's colours, as the CSS variables a mini app is promised. */
function themeVars(dark: boolean): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const [to, from] of TOKENS) {
    const v = cs.getPropertyValue(from).trim()
    if (v) out[to] = v
  }
  ;(dark ? SERIES_DARK : SERIES).forEach((c, i) => (out[`--c${i + 1}`] = c))
  out['--radius'] = '10px'
  out['--font'] = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
  out['--mono'] = "'Cascadia Code', Consolas, monospace"
  return out
}

function Frame({ html, title, height: initial, fixedHeight, onPropose, onError, onNote, fill }: { html: string; title: string; height: number; fixedHeight: boolean; onPropose(t: string): void; onError(m: string): void; onNote(m: string): void; fill?: boolean }) {
  const dark = useDark()
  const ref = useRef<HTMLIFrameElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [height, setHeight] = useState(initial)
  const darkAtStart = useRef(dark)

  useEffect(() => {
    let live = true
    setUrl(null)
    api
      .appFrame({ html, theme: themeVars(darkAtStart.current), dark: darkAtStart.current })
      .then((u) => live && setUrl(typeof u === 'string' && u.startsWith('ensemble-app://') ? u : null))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : 'it could not be started'))
    return () => {
      live = false
    }
  }, [html])

  // Only its own frame is listened to, and only for the three things it may say.
  useEffect(() => {
    const on = (e: MessageEvent): void => {
      const w = ref.current?.contentWindow
      if (!w || e.source !== w) return
      const d = e.data as { __iui?: number; kind?: string; height?: unknown; text?: unknown; message?: unknown }
      if (!d || typeof d !== 'object' || d.__iui !== 1) return
      if (d.kind === 'size' || d.kind === 'resize') {
        if (fill || (d.kind === 'size' && fixedHeight)) return
        const h = Number(d.height)
        if (Number.isFinite(h)) setHeight(Math.max(APP_LIMITS.minHeight, Math.min(APP_LIMITS.maxHeight, Math.round(h))))
      } else if (d.kind === 'propose' && typeof d.text === 'string') {
        const t = d.text.slice(0, APP_LIMITS.propose).trim()
        if (t) onPropose(t)
      } else if (d.kind === 'error' && typeof d.message === 'string') onError(d.message.slice(0, 200))
      else if (d.kind === 'note' && typeof d.message === 'string') onNote(d.message.slice(0, 80))
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [fill, fixedHeight, onPropose, onError, onNote])

  // The theme follows the app's while it runs.
  const post = useCallback(() => {
    ref.current?.contentWindow?.postMessage({ __iui: 1, kind: 'theme', vars: themeVars(dark), dark }, '*')
  }, [dark])
  useEffect(() => {
    if (dark !== darkAtStart.current || url) post()
  }, [dark, url, post])

  if (failed) return <div className="flex items-center justify-center text-[12.5px] text-ink-3" style={{ height: initial }}>The mini app could not be started: {failed}</div>
  return (
    <div className="relative bg-surface" style={{ height: fill ? '100%' : height, transition: 'height 0.2s var(--ease-out)' }}>
      {url ? (
        <iframe
          ref={ref}
          src={url}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={post}
          className="block size-full border-0 bg-transparent"
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Spinner />
        </div>
      )}
    </div>
  )
}

/** How wide a mini app may grow past the text column, when the pane has the room. */
const WIDE = 960

/**
 * A mini app is a page of its own and reads better wide. When the chat pane has room, its frame
 * steps out of the text column (up to WIDE), centred on it and never closer than 24 px to the
 * pane's edges. Inside another block, or in a narrow pane, it stays in the column.
 */
function useBreakout(ref: RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>()
  useLayoutEffect(() => {
    const el = ref.current
    const col = el?.parentElement
    if (!el || !col || col.closest('.iui')) return
    let sc: HTMLElement | null = col.parentElement
    while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement
    if (!sc) return
    const pane = sc
    const update = (): void => {
      const colW = col.clientWidth
      const width = Math.min(WIDE, pane.clientWidth - 48)
      if (width <= colW + 24) {
        setStyle(undefined)
        return
      }
      const left = col.getBoundingClientRect().left - pane.getBoundingClientRect().left
      let ml = -(width - colW) / 2
      ml = Math.max(ml, 24 - left)
      ml = Math.min(ml, pane.clientWidth - 24 - width - left)
      setStyle((prev) => (prev && prev.width === width && prev.marginLeft === Math.round(ml) ? prev : { width, marginLeft: Math.round(ml), maxWidth: 'none' }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(pane)
    ro.observe(col)
    return () => ro.disconnect()
  }, [ref])
  return style
}

export function AppFrame({ html, title, height, fixedHeight }: { html: string; title: string; height: number; fixedHeight: boolean }) {
  const [ref, near] = useNear<HTMLDivElement>(500)
  const wide = useBreakout(ref)
  const [run, setRun] = useState(0)
  const [big, setBig] = useState(false)
  const [offer, setOffer] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { send, name } = useAnswer()
  const onPropose = useCallback((t: string) => {
    setOffer(t)
    setSent(null)
  }, [])
  const onError = useCallback((m: string) => setError(m), [])
  // A passing word from the frame (a link that cannot open), shown for a few seconds.
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onNote = useCallback((m: string) => {
    setNote(m)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 2600)
  }, [])
  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), [])
  const restart = (): void => {
    setRun((r) => r + 1)
    setError(null)
    setOffer(null)
  }
  const doSend = async (): Promise<void> => {
    if (!offer) return
    const t = offer
    setSent(t)
    setOffer(null)
    if (!(await send(t))) {
      setSent(null)
      setOffer(t)
    }
  }
  return (
    <section ref={ref} aria-label={`Mini app: ${title}`} style={wide} className="iui my-3 overflow-hidden rounded-[12px] bg-surface shadow-card">
      <header className="flex h-9 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <AppWindow className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{title}</span>
        {note && !error && (
          <span className="animate-fade-in truncate text-[11.5px] text-ink-3" role="status">
            {note}
          </span>
        )}
        {error && (
          <span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] text-warn" title={error}>
            <TriangleAlert className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </span>
        )}
        <span className={cn('hidden shrink-0 text-[11px] text-ink-4 sm:inline', (note || error) && '!hidden')} title="It runs in a locked box: no internet, no files, no access to the app">
          Offline, locked box
        </span>
        <IconButton label="Restart" onClick={restart} className="size-6">
          <RotateCcw className="size-3.5" />
        </IconButton>
        <IconButton label="Open larger" onClick={() => setBig(true)} className="size-6">
          <Maximize2 className="size-3.5" />
        </IconButton>
      </header>
      {near ? <Frame key={run} html={html} title={title} height={height} fixedHeight={fixedHeight} onPropose={onPropose} onError={onError} onNote={onNote} /> : <div style={{ height }} className="bg-surface" />}
      {(offer || sent) && (
        <div className="flex animate-fade-in items-start gap-2.5 border-t border-line bg-surface-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium text-ink-3">{sent ? `Sent${name ? ` to ${name}` : ''}` : 'The app offers a message'}</div>
            <div className="line-clamp-3 text-[12.5px] leading-snug whitespace-pre-wrap text-ink select-text">{sent || offer}</div>
          </div>
          {offer ? (
            <div className="flex shrink-0 items-center gap-1 self-center">
              <IconButton label="Dismiss" onClick={() => setOffer(null)} className="size-7">
                <X className="size-3.5" />
              </IconButton>
              <Button size="sm" variant="primary" onClick={() => void doSend()}>
                <Send className="size-3.5" />
                Send
              </Button>
            </div>
          ) : (
            <Check className={cn('mt-1 size-4 shrink-0 self-center text-ok')} aria-hidden />
          )}
        </div>
      )}
      {big && (
        <Modal open onClose={() => setBig(false)} title={title} width={Math.min(1180, Math.round(window.innerWidth * 0.92))}>
          <div className="mx-6 mt-3 mb-6 overflow-hidden rounded-[12px] shadow-card" style={{ height: Math.round(window.innerHeight * 0.72) }}>
            <Frame html={html} title={title} height={Math.round(window.innerHeight * 0.72)} fixedHeight onPropose={onPropose} onError={onError} onNote={onNote} fill />
          </div>
        </Modal>
      )}
    </section>
  )
}
