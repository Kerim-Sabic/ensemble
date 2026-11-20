import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TurnEvidence } from '../evidence/Evidence'
import { ArrowDown } from 'lucide-react'
import type { Account, Item } from '@shared/types'
import { agentKey, leadOf, useStore } from '@/store'
import { accentVars, cn } from '@/lib/util'
import { useStreamed } from '@/lib/streams'
import { mediaPathsIn } from '@shared/tools'
import { MediaStrip } from '../Media'
import { Orb } from '../Orb'
import { Markdown } from '../Markdown'
import { ActivityGroup } from './ToolRows'
import { ScreenCard } from '../screen/ScreenCard'
import { CopyButton } from './MessageActions'
import { AutoRow, AskCard, DelegateCard, DelegateGroup, SpawnGroup, ImageCard, NoticeRow, OutgoingRow, PeerCard, PermissionCard, QuestionCard, SignInCard, SpawnCard, TurnFooter, UserBubble, WorkingLine } from './Cards'
import { rendered, timed, useRenderTime } from '@/lib/perf'
import { sameRows, windowOf } from '@/lib/windowing'
import { build, guess, keepSame, NO_KIDS, withCounts, type Block } from './blocks'

const EMPTY: Item[] = []


const AssistantText = memo(function AssistantText({ item, compact, shown, replyTo }: { item: Extract<Item, { kind: 'assistant' }>; compact?: boolean; shown: Set<string>; replyTo?: string }) {
  rendered('AssistantText')
  // While it is being written the words arrive here directly, without the rest of the chat hearing of it.
  const text = useStreamed(item.id, item.text, item.streaming)
  // Files it mentions are shown with it, once it has finished writing, unless they are already on show.
  const media = useMemo(() => (item.streaming ? [] : mediaPathsIn(item.text).filter((p) => !shown.has(p.toLowerCase()))), [item.streaming, item.text, shown])
  return (
    <div className="group/a relative py-1">
      <Markdown text={text} compact={compact} streaming={item.streaming} replyTo={replyTo} />
      <MediaStrip paths={media} />
      {/* At the end of the reply, in the margin, on hover: nothing moves. */}
      {!item.streaming && item.text.trim() && (
        <div
          className={cn(
            'pointer-events-none absolute bottom-1 opacity-0 transition-opacity duration-150 group-hover/a:pointer-events-auto group-hover/a:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
            compact ? 'right-0 rounded-[8px] bg-surface shadow-card' : '-right-7',
          )}
        >
          <CopyButton text={item.text} side="left" />
        </div>
      )}
    </div>
  )
})

// A long chat is thousands of rows. Only the rows near what can be seen are drawn; empty space of
// the right height stands in for the rest (lib/windowing.ts), so it scrolls like a short one and
// every row can still be reached by scrolling.
const OVERSCAN = 1400

const SenderLabel = memo(function SenderLabel({ account, lead }: { account: Account | undefined; lead: boolean }) {
  return (
    <div className="mt-2 mb-1 flex items-center gap-2 text-[12.5px]">
      <Orb account={account} size={16} />
      <span className="font-semibold">{account?.name}</span>
      {lead && <span className="text-ink-3">Lead</span>}
    </div>
  )
})

/** One block of the transcript. Drawn again only when its own content changes. */
const Row = memo(function Row({
  b,
  chatId,
  accountId,
  compact,
  account,
  isLead,
  active,
  shown,
  onOpen,
}: {
  b: Block
  chatId: string
  accountId: string
  compact?: boolean
  account: Account | undefined
  isLead: boolean
  active: boolean
  shown: Set<string>
  onOpen(id: string): void
}) {
  rendered('Row')
  if (b.type === 'label') return compact ? null : <SenderLabel account={account} lead={isLead} />
  if (b.type === 'screen') return <ScreenCard chatId={chatId} accountId={accountId} surface={b.surface} items={b.items} latest={!!b.latest} compact={compact} />
  if (b.type === 'activity') return <ActivityGroup items={b.items} children={b.kids || NO_KIDS} active={active} chatId={chatId} accountId={accountId} />
  if (b.type === 'spawns') {
    // Agents joining one after another read as one line once there are a few of them.
    if (b.items.length >= 3) return <SpawnGroup items={b.items} onOpen={onOpen} />
    return (
      <>
        {b.items.map((it) => (
          <SpawnCard key={it.id} item={it} onOpen={onOpen} />
        ))}
      </>
    )
  }
  if (b.type === 'delegates') {
    // A whole batch handed out at once is one card, not a wall of them.
    if (b.items.length >= 5) return <DelegateGroup items={b.items} chatId={chatId} onOpen={onOpen} />
    return (
      <div className={cn('my-3 grid gap-2.5', b.items.length > 1 && !compact ? 'grid-cols-[repeat(auto-fit,minmax(210px,1fr))]' : 'grid-cols-1')}>
        {b.items.map((d) => (
          <DelegateCard key={d.id} item={d} chatId={chatId} onOpen={onOpen} />
        ))}
      </div>
    )
  }
  const it = b.item
  switch (it.kind) {
    case 'user':
      return <UserBubble item={it} chatId={chatId} accountId={accountId} />
    case 'peer':
      return <PeerCard item={it} onOpen={onOpen} />
    case 'assistant':
      return <AssistantText item={it} compact={compact} shown={shown} replyTo={accountId} />
    case 'outgoing':
      return <OutgoingRow item={it} onOpen={onOpen} />
    case 'spawn':
      return <SpawnCard item={it} onOpen={onOpen} />
    case 'ask':
      return <AskCard item={it} onOpen={onOpen} />
    case 'permission':
      return <PermissionCard item={it} />
    case 'signin':
      return <SignInCard item={it} chatId={chatId} accountId={accountId} />
    case 'question':
      return <QuestionCard item={it} accountId={accountId} />
    case 'notice':
      return <NoticeRow item={it} chatId={chatId} accountId={accountId} />
    case 'image':
      return <ImageCard item={it} />
    case 'auto':
      return <AutoRow item={it} />
    case 'turn':
      return (
        <>
          <TurnFooter item={it} chatId={chatId} accountId={accountId} />
          <TurnEvidence item={it} chatId={chatId} accountId={accountId} />
        </>
      )
    default:
      return null
  }
})

/** Measured heights of blocks, per transcript and width, kept while the window is open. */
const measured = new Map<string, Map<string, number>>()
/** Blocks each transcript has drawn before: drawn again (scrolled back into view), they do not play their entrance again. */
const drawnBefore = new Map<string, Set<string>>()

/**
 * Scrolls a transcript to one row and flashes it, even when that row is far off screen and not
 * drawn: `revealItem(chatId, accountId, itemId)`. Open the chat first (store.openChat); if its
 * rows are still being read the reveal waits for them (up to five seconds). Rows that belong to a
 * run (tool use, handouts) are found by any of their ids.
 */
let pending: { k: string; id: string; at: number } | null = null
const revealBus = new EventTarget()
export function revealItem(chatId: string, accountId: string, itemId: string): void {
  pending = { k: agentKey(chatId, accountId), id: itemId, at: Date.now() }
  revealBus.dispatchEvent(new Event('reveal'))
}

// Reachable from the page's console in a measuring run, for scripts/visual/perf-window.json.
if ((window as { __ensemblePerf?: unknown }).__ensemblePerf) (window as unknown as { __revealItem: typeof revealItem }).__revealItem = revealItem

const idsOf = (b: Block): string[] => (b.type === 'item' ? [b.item.id] : b.type === 'label' ? [] : (b.items as { id: string }[]).map((i) => i.id))

// Drawn again only when its own props or what it listens to change, not whenever the view around it is.
export const Transcript = memo(function Transcript({ chatId, accountId, compact, fadeTop }: { chatId: string; accountId: string; compact?: boolean; fadeTop?: boolean }) {
  rendered('Transcript')
  useRenderTime('Transcript')
  const k = agentKey(chatId, accountId)
  const items = useStore((s) => s.items[k] ?? EMPTY)
  const state = useStore((s) => s.agents[k])
  const account = useStore((s) => s.members[accountId])
  const isLead = useStore((s) => leadOf(s)?.id === accountId)
  const setFocus = useStore((s) => s.setFocus)
  const setView = useStore((s) => s.setView)

  // Blocks that did not change are the very same objects as last time, so their rows are not drawn again.
  const last = useRef<{ k: string; blocks: Block[] }>({ k: '', blocks: [] })
  const blocks = useMemo(() => timed('T.build', () => {
    const { blocks: next, children } = build(items)
    withCounts(next, children)
    const kept = keepSame(last.current.k === k ? last.current.blocks : [], next)
    last.current = { k, blocks: kept }
    return kept
  }), [items, k])
  // Media that already has a row of its own, so a reply mentioning it does not show it twice.
  const mediaSig = useMemo(() => timed('T.media', () => items.filter((i) => i.kind === 'image').map((i) => (i as { path: string }).path.toLowerCase()).join('\n')), [items])
  const onShow = useMemo(() => new Set(mediaSig ? mediaSig.split('\n') : []), [mediaSig])
  const busy = !!state && state.phase !== 'idle' && state.phase !== 'error'

  const ref = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)

  // ---- windowing: which blocks are drawn ----
  const width = useRef(0)
  const viewH = useRef(typeof window === 'undefined' ? 800 : window.innerHeight)
  const top = useRef(0)
  const heights = useCallback((): Map<string, number> => {
    const id = `${k}|${compact ? 'c' : 'f'}|${width.current}`
    let m = measured.get(id)
    if (!m) measured.set(id, (m = new Map()))
    return m
  }, [k, compact])
  const spanFor = useCallback(
    (list: Block[]) => {
      const m = heights()
      const h = list.map((b) => m.get(b.key) ?? guess(b, compact))
      return windowOf(h, top.current, viewH.current, OVERSCAN, stick.current)
    },
    [heights, compact],
  )
  const [tick, setTick] = useState(0)
  const span = useMemo(() => timed('T.span', () => spanFor(blocks)), [spanFor, blocks, tick])
  const spanRef = useRef(span)
  spanRef.current = span
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks

  /** Writes down how tall each drawn block turned out to be: the distance to the next one. */
  const measure = useCallback(() => timed('T.measure', () => {
    const box = inner.current
    if (!box) return
    const rows = box.querySelectorAll<HTMLElement>(':scope > [data-b]')
    if (!rows.length) return
    const m = heights()
    const end = box.querySelector<HTMLElement>(':scope > [data-end]')
    for (let i = 0; i < rows.length; i++) {
      const next = i + 1 < rows.length ? rows[i + 1].offsetTop : end ? end.offsetTop : rows[i].offsetTop + rows[i].offsetHeight
      const key = rows[i].dataset.b as string
      m.set(key, Math.max(0, next - rows[i].offsetTop))
    }
  }), [heights])

  const toBottom = useCallback((smooth?: boolean) => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
  }, [])

  // New transcript on screen: start at the latest message.
  useLayoutEffect(() => {
    stick.current = true
    setAway(false)
    toBottom()
  }, [k, toBottom])

  useLayoutEffect(() => {
    measure()
    if (stick.current) toBottom()
  }, [items, state?.activity, busy, span, measure, toBottom])

  // Text is written into rows without this component hearing of it, and pictures load late:
  // whenever what is drawn gets taller while you are at the end, stay at the end. The width
  // changing means every height written down so far is out of date.
  useEffect(() => {
    const el = inner.current
    const view = ref.current
    if (!el || !view) return
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth)
      const resized = w !== width.current || view.clientHeight !== viewH.current
      width.current = w
      viewH.current = view.clientHeight
      measure()
      if (stick.current) toBottom()
      if (resized) setTick((t) => t + 1)
    })
    ro.observe(el)
    // The window onto the chat gets shorter too, when something opens above or below it.
    ro.observe(view)
    return () => ro.disconnect()
  }, [toBottom, measure])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const onScroll = (): void => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      stick.current = near
      setAway(!near)
      top.current = el.scrollTop
      viewH.current = el.clientHeight
      // Draw other blocks only when what should be drawn changes, at most once a frame.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = spanFor(blocksRef.current)
        if (!sameRows(next, spanRef.current)) setTick((t) => t + 1)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [spanFor])

  const open = useCallback(
    (id: string) => {
      setFocus(id)
      setView('chat')
    },
    [setFocus, setView],
  )

  // Asked to show one row (revealItem): if it is drawn, scroll to it and flash it; if not, scroll to
  // where it should be, which draws it, and look again once it is there and measured.
  const reveal = useCallback(() => {
    const p = pending
    const el = ref.current
    if (!p || p.k !== k || !el) return
    if (Date.now() - p.at > 5000) {
      pending = null
      return
    }
    const list = blocksRef.current
    const at = list.findIndex((b) => idsOf(b).includes(p.id))
    if (at < 0) return // its rows have not come in yet
    const row = [...el.querySelectorAll<HTMLElement>('[data-items]')].find((r) => (r.dataset.items || '').split(' ').includes(p.id))
    if (row) {
      pending = null
      stick.current = false
      row.scrollIntoView({ block: 'center' })
      row.classList.remove('row-flash')
      void row.offsetWidth
      row.classList.add('row-flash')
      setTimeout(() => row.classList.remove('row-flash'), 1800)
      return
    }
    const m = heights()
    let y = inner.current ? parseFloat(getComputedStyle(inner.current).paddingTop) || 0 : 0
    for (let j = 0; j < at; j++) y += m.get(list[j].key) ?? guess(list[j], compact)
    stick.current = false
    top.current = Math.max(0, y - el.clientHeight / 3)
    el.scrollTop = top.current
  }, [k, heights, compact])
  useEffect(() => {
    revealBus.addEventListener('reveal', reveal)
    return () => revealBus.removeEventListener('reveal', reveal)
  }, [reveal])
  // After each drawing: a row that was being looked for may now be there.
  useLayoutEffect(() => {
    if (pending) reveal()
  }, [blocks, span, reveal])

  const lastIndex = blocks.length - 1
  const drawn = blocks.slice(span.start, span.end)
  let before = drawnBefore.get(k)
  if (!before) drawnBefore.set(k, (before = new Set()))
  // Written down after drawing, so a block counts as seen from its second drawing on.
  const seen = before
  useEffect(() => {
    for (const b of drawn) seen.add(b.key)
  })
  return (
    <div
      className="relative min-h-0 flex-1"
      // Under the network strip, lines that scroll up fade out before its edge instead of being cut by it.
      // The fade sits on this box, not on the scrolling one, so scrolling never has to redraw it.
      style={fadeTop ? { maskImage: 'linear-gradient(to bottom, transparent 0, #000 20px)', WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 20px)' } : undefined}
    >
      <div ref={ref} className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]" style={accentVars(account?.accent)}>
        <div ref={inner} data-view-scope className={cn('mx-auto w-full', compact ? 'px-4 pt-3 pb-4' : 'max-w-[780px] px-7 pt-6 pb-10')}>
          {span.top > 0 && <div aria-hidden style={{ height: span.top }} />}
          {drawn.map((b, n) => (
            <div key={b.key} data-b={b.key} data-item={b.key} data-items={idsOf(b).join(' ')} data-seen={seen.has(b.key) ? '' : undefined}>
              <Row b={b} chatId={chatId} accountId={accountId} compact={compact} account={account} isLead={isLead} active={busy && span.start + n === lastIndex} shown={onShow} onOpen={open} />
            </div>
          ))}
          <div data-end aria-hidden style={span.bottom > 0 ? { height: span.bottom } : undefined} />
          {busy && state && state.phase !== 'responding' && state.phase !== 'waiting' && <WorkingLine account={account} state={state} />}
        </div>
      </div>
      {away && (
        <button
          onClick={() => {
            const el = ref.current
            stick.current = true
            // Smooth over a short way; a long way is a jump, so thousands of rows are not drawn on the way.
            toBottom(!!el && el.scrollHeight - el.scrollTop < 4 * el.clientHeight)
          }}
          aria-label="Jump to latest"
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 animate-pop items-center justify-center rounded-full bg-raised text-ink-2 shadow-float hover:text-ink"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
})
