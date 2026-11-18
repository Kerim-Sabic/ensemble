// The pieces every Live answers block shares: its card, remembered state, the way it answers
// the agent, lazy drawing and the guard that keeps one bad block from taking the chat down.
import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { useStore } from '@/store'
import { cn } from '@/lib/util'

/** Who wrote the text the blocks are in, so an answer goes back to them. */
export const IuiContext = createContext<{ replyTo?: string }>({})

/** The window is dark: blocks that paint colours themselves need to know. */
export function useDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const el = document.documentElement
    const mo = new MutationObserver(() => setDark(el.classList.contains('dark')))
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

/** A short fingerprint of a text, for keys. */
export function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

// What a block remembers (ticks, what a form sent) for as long as the app is open, even when
// the chat scrolls it out of the drawn part and back.
const kept = new Map<string, unknown>()

export function useKept<T>(key: string, init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : typeof init === 'function' ? (init as () => T)() : init))
  const set = useCallback(
    (next: T | ((p: T) => T)) =>
      setV((p) => {
        const n = typeof next === 'function' ? (next as (p: T) => T)(p) : next
        kept.set(key, n)
        return n
      }),
    [key],
  )
  return [v, set]
}

/** Send an ordinary message to the agent whose reply the block is in. Only ever called from a real click. */
export function useAnswer(): { send(text: string): Promise<boolean>; to: string | undefined; name: string | undefined } {
  const { replyTo } = useContext(IuiContext)
  const name = useStore((s) => (replyTo ? s.members[replyTo]?.name : undefined))
  const send = useCallback(
    async (text: string) => {
      const s = useStore.getState()
      const to = replyTo && s.members[replyTo] ? replyTo : undefined
      // Marked as coming from a control, so the engine never reads it as an app command in a real chat.
      return s.send(text, undefined, to, { fromControl: true })
    },
    [replyTo],
  )
  return { send, to: replyTo, name }
}

/** True once the element has come near the view; stays true. */
export function useNear<T extends HTMLElement>(margin = 600): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (near) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: `${margin}px 0px` },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [near, margin])
  return [ref, near]
}

/** The frame every block sits in. */
export function Card({ title, aside, children, className, pad = true, label }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string; pad?: boolean; label?: string }) {
  return (
    <section aria-label={title || label} className={cn('iui my-3 min-w-0 animate-fade-in rounded-[12px] bg-surface shadow-card select-text', pad && 'px-4 py-3.5', className)}>
      {(title || aside) && (
        <header className={cn('flex min-h-6 items-center gap-3', pad ? 'mb-2.5' : 'px-4 pt-3 pb-2')}>
          {title && <div role="heading" aria-level={4} className="m-0 min-w-0 flex-1 truncate text-[13px] leading-snug font-semibold tracking-[-0.005em] text-ink">{title}</div>}
          {aside && <div className={cn('flex shrink-0 items-center gap-1.5', !title && 'ml-auto')}>{aside}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

const WAIT: Record<string, string> = {
  chart: 'Drawing a chart',
  table: 'Laying out a table',
  stats: 'Gathering the figures',
  compare: 'Setting out the options',
  steps: 'Writing the steps',
  diagram: 'Drawing a diagram',
  tabs: 'Filling the tabs',
  checklist: 'Writing a checklist',
  choices: 'Preparing the choices',
  form: 'Building a form',
  calc: 'Building a calculator',
  app: 'Building a mini app',
}

/** What a block looks like while it is still being written. */
export function Waiting({ kind, height = 120 }: { kind?: string; height?: number }) {
  return (
    <div className="iui my-3 overflow-hidden rounded-[12px] bg-surface shadow-card" role="status" aria-live="polite" style={{ height }}>
      <div className="flex h-full flex-col gap-2.5 px-4 py-3.5">
        <div className="text-[12.5px] font-medium text-ink-3">
          <span className="shimmer-text">{(kind && WAIT[kind]) || 'Preparing a live answer'}</span>
        </div>
        <div className="iui-wait min-h-0 flex-1 rounded-[8px]" />
      </div>
    </div>
  )
}

/** A block that cannot be drawn: its source as ordinary code, and one line saying why. */
export function Fallback({ source, lang, reason }: { source: string; lang: string; reason: string }) {
  return (
    <div className="my-3">
      <div className="mb-1 flex items-center gap-1.5 text-[12px] text-ink-3">
        <span className="inline-block size-1.5 rounded-full bg-warn" aria-hidden />
        <span>Could not draw this {lang === 'app' ? 'mini app' : 'block'}: {reason}</span>
      </div>
      <pre className="m-0 max-h-[320px] overflow-auto rounded-[11px] bg-[var(--code-bg)] !py-3 text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] select-text">
        <code>{source}</code>
      </pre>
    </div>
  )
}

/** One block failing to draw shows its source instead; the rest of the reply carries on. */
export class Guard extends Component<{ source: string; lang: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown): { error: string } {
    return { error: e instanceof Error ? e.message.slice(0, 160) : 'it failed to draw' }
  }
  componentDidCatch(e: unknown, info: ErrorInfo): void {
    console.warn('[iui] a block failed to draw', e, info.componentStack?.slice(0, 400))
  }
  componentDidUpdate(prev: { source: string }): void {
    if (prev.source !== this.props.source && this.state.error) this.setState({ error: null })
  }
  render(): ReactNode {
    if (this.state.error) return <Fallback source={this.props.source} lang={this.props.lang} reason={`it failed to draw (${this.state.error})`} />
    return this.props.children
  }
}
