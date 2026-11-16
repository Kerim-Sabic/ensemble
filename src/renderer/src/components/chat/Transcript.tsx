import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, History } from 'lucide-react'
import type { Account, Item, ScreenKind } from '@shared/types'
import { agentKey, leadOf, useStore } from '@/store'
import { accentVars, cn } from '@/lib/util'
import { useStreamed } from '@/lib/streams'
import { mediaPathsIn } from '@shared/tools'
import { MediaStrip } from '../Media'
import { Orb } from '../Orb'
import { Markdown } from '../Markdown'
import { ActivityGroup, type ActivityItem } from './ToolRows'
import { ScreenCard } from '../screen/ScreenCard'
import { AskCard, DelegateCard, ImageCard, NoticeRow, OutgoingRow, PeerCard, PermissionCard, QuestionCard, SignInCard, SpawnCard, TurnFooter, UserBubble, WorkingLine } from './Cards'

type Delegate = Extract<Item, { kind: 'delegate' }>
type ScreenStep = Extract<Item, { kind: 'screen' }>
type ScreenBlock = { type: 'screen'; key: string; surface: ScreenKind; items: ScreenStep[]; latest?: boolean }

type Block =
  | { type: 'label'; key: string }
  | ScreenBlock
  | { type: 'activity'; key: string; items: ActivityItem[] }
  | { type: 'delegates'; key: string; items: Delegate[] }
  | { type: 'item'; key: string; item: Item }

const EMPTY: Item[] = []

function build(items: Item[]): { blocks: Block[]; children: Map<string, number> } {
  const blocks: Block[] = []
  const children = new Map<string, number>()
  // One window per screen per turn: it appears where the agent first used the screen.
  let cards: Partial<Record<ScreenKind, ScreenBlock>> = {}
  let needLabel = true
  const label = (id: string): void => {
    if (!needLabel) return
    blocks.push({ type: 'label', key: `l-${id}` })
    needLabel = false
  }
  for (const it of items) {
    const last = blocks[blocks.length - 1]
    switch (it.kind) {
      case 'user':
      case 'peer':
        blocks.push({ type: 'item', key: it.id, item: it })
        needLabel = true
        cards = {}
        break
      case 'screen': {
        label(it.id)
        let card = cards[it.surface]
        if (!card) {
          card = { type: 'screen', key: `sc-${it.id}`, surface: it.surface, items: [] }
          cards[it.surface] = card
          blocks.push(card)
        }
        card.items.push(it)
        const tail = blocks[blocks.length - 1]
        if (tail?.type === 'activity') tail.items.push(it)
        else blocks.push({ type: 'activity', key: it.id, items: [it] })
        break
      }
      case 'tool':
        if (it.parentId) {
          children.set(it.parentId, (children.get(it.parentId) || 0) + 1)
          break
        }
      // falls through
      case 'thinking':
        if (it.kind === 'thinking' && !it.streaming && !it.text.trim() && (it.durationMs || 0) < 1000) break
        label(it.id)
        if (last?.type === 'activity') last.items.push(it)
        else blocks.push({ type: 'activity', key: it.id, items: [it] })
        break
      case 'delegate':
        label(it.id)
        if (last?.type === 'delegates') last.items.push(it)
        else blocks.push({ type: 'delegates', key: it.id, items: [it] })
        break
      case 'assistant':
        if (!it.text.trim() && !it.streaming) break
        label(it.id)
        blocks.push({ type: 'item', key: it.id, item: it })
        break
      case 'turn':
        cards = {}
      // falls through
      case 'notice':
        blocks.push({ type: 'item', key: it.id, item: it })
        break
      default:
        label(it.id)
        blocks.push({ type: 'item', key: it.id, item: it })
    }
  }
  // The newest window onto each screen is the one that keeps following it.
  const seen = new Set<ScreenKind>()
  for (let i = blocks.length - 1; i >= 0 && seen.size < 2; i--) {
    const b = blocks[i]
    if (b.type !== 'screen' || seen.has(b.surface)) continue
    seen.add(b.surface)
    b.latest = true
  }
  return { blocks, children }
}

const AssistantText = memo(function AssistantText({ item, compact, shown }: { item: Extract<Item, { kind: 'assistant' }>; compact?: boolean; shown: Set<string> }) {
  // While it is being written the words arrive here directly, without the rest of the chat hearing of it.
  const text = useStreamed(item.id, item.text, item.streaming)
  // Files it mentions are shown with it, once it has finished writing, unless they are already on show.
  const media = useMemo(() => (item.streaming ? [] : mediaPathsIn(item.text).filter((p) => !shown.has(p.toLowerCase()))), [item.streaming, item.text, shown])
  return (
    <div className="py-1">
      <Markdown text={text} compact={compact} streaming={item.streaming} />
      <MediaStrip paths={media} />
    </div>
  )
})

// A long chat is thousands of rows. Only the recent part is drawn; the rest is one click away.
const PAGE = 70
const MORE = 120
const MOST = 420

/** Somewhere a reader would expect a stretch of chat to begin. */
const startsTurn = (b: Block): boolean => b.type === 'label' || (b.type === 'item' && (b.item.kind === 'user' || b.item.kind === 'peer'))

const SenderLabel = memo(function SenderLabel({ account, lead }: { account: Account | undefined; lead: boolean }) {
  return (
    <div className="mt-2 mb-1 flex items-center gap-2 text-[12.5px]">
      <Orb account={account} size={16} />
      <span className="font-semibold">{account?.name}</span>
      {lead && <span className="text-ink-3">Lead</span>}
    </div>
  )
})

export function Transcript({ chatId, accountId, compact }: { chatId: string; accountId: string; compact?: boolean }) {
  const k = agentKey(chatId, accountId)
  const items = useStore((s) => s.items[k] ?? EMPTY)
  const state = useStore((s) => s.agents[k])
  const account = useStore((s) => s.members[accountId])
  const isLead = useStore((s) => leadOf(s)?.id === accountId)
  const setFocus = useStore((s) => s.setFocus)
  const setView = useStore((s) => s.setView)

  const { blocks, children } = useMemo(() => build(items), [items])
  // Media that already has a row of its own, so a reply mentioning it does not show it twice.
  const onShow = useMemo(() => new Set(items.filter((i) => i.kind === 'image').map((i) => (i as { path: string }).path.toLowerCase())), [items])
  const busy = !!state && state.phase !== 'idle' && state.phase !== 'error'

  const ref = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)

  // Which block the drawn part starts at. Left to itself it is the last screenful or so and
  // moves along as the chat grows. Once you scroll up it is pinned to a block, so what you
  // are reading does not slide away while the team keeps working.
  const [pin, setPin] = useState<string | null>(null)
  const page = compact ? 40 : PAGE
  const start = useMemo(() => {
    let at = Math.max(0, blocks.length - page)
    if (pin) {
      const i = blocks.findIndex((b) => b.key === pin)
      if (i >= 0) at = Math.max(Math.min(i, at), blocks.length - MOST)
    }
    // Begin at the start of a turn when one is near, so the first thing drawn has its name on it.
    for (let i = at; i > 0 && at - i < 25; i--) {
      if (startsTurn(blocks[i])) return i
    }
    return at
  }, [blocks, pin, page])
  const shown = useMemo(() => (start > 0 ? blocks.slice(start) : blocks), [blocks, start])
  const startKey = shown[0]?.key
  const grew = useRef<{ height: number; top: number } | null>(null)

  const toBottom = useCallback((smooth?: boolean) => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
  }, [])

  // New transcript on screen: start at the latest message.
  useLayoutEffect(() => {
    stick.current = true
    setAway(false)
    setPin(null)
    toBottom()
  }, [k, toBottom])

  useLayoutEffect(() => {
    if (stick.current) toBottom()
  }, [items, state?.activity, busy, toBottom])

  // Earlier messages were just added above: stay on the line that was being read.
  useLayoutEffect(() => {
    const el = ref.current
    const g = grew.current
    grew.current = null
    if (el && g) el.scrollTop = g.top + (el.scrollHeight - g.height)
  }, [startKey])

  // Text is written into rows without this component hearing of it, and pictures load late:
  // whenever what is drawn gets taller while you are at the end, stay at the end.
  useEffect(() => {
    const el = inner.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [toBottom])

  const startRef = useRef(startKey)
  startRef.current = startKey
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      if (near !== stick.current) setPin(near ? null : startRef.current || null)
      stick.current = near
      setAway(!near)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const earlier = useCallback(() => {
    const el = ref.current
    if (el) grew.current = { height: el.scrollHeight, top: el.scrollTop }
    stick.current = false
    setAway(true)
    setPin(blocks[Math.max(0, start - MORE)]?.key || null)
  }, [blocks, start])

  const open = useCallback(
    (id: string) => {
      setFocus(id)
      setView('chat')
    },
    [setFocus, setView],
  )

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]" style={accentVars(account?.accent)}>
        <div ref={inner} data-view-scope className={cn('mx-auto w-full', compact ? 'px-4 pt-3 pb-4' : 'max-w-[780px] px-7 pt-6 pb-10')}>
          {start > 0 && (
            <button
              onClick={earlier}
              className="mx-auto mb-4 flex h-7 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
            >
              <History className="size-3.5" strokeWidth={1.9} />
              Show earlier messages
            </button>
          )}
          {shown.map((b, n) => {
            const i = start + n
            if (b.type === 'label') return compact ? null : <SenderLabel key={b.key} account={account} lead={isLead} />
            if (b.type === 'screen') return <ScreenCard key={b.key} chatId={chatId} accountId={accountId} surface={b.surface} items={b.items} latest={!!b.latest} compact={compact} />
            if (b.type === 'activity') return <ActivityGroup key={b.key} items={b.items} children={children} active={busy && i === blocks.length - 1} chatId={chatId} accountId={accountId} />
            if (b.type === 'delegates') {
              return (
                <div key={b.key} className={cn('my-3 grid gap-2.5', b.items.length > 1 && !compact ? 'grid-cols-[repeat(auto-fit,minmax(210px,1fr))]' : 'grid-cols-1')}>
                  {b.items.map((d) => (
                    <DelegateCard key={d.id} item={d} chatId={chatId} onOpen={open} />
                  ))}
                </div>
              )
            }
            const it = b.item
            switch (it.kind) {
              case 'user':
                return <UserBubble key={b.key} item={it} />
              case 'peer':
                return <PeerCard key={b.key} item={it} onOpen={open} />
              case 'assistant':
                return <AssistantText key={b.key} item={it} compact={compact} shown={onShow} />
              case 'outgoing':
                return <OutgoingRow key={b.key} item={it} onOpen={open} />
              case 'spawn':
                return <SpawnCard key={b.key} item={it} onOpen={open} />
              case 'ask':
                return <AskCard key={b.key} item={it} onOpen={open} />
              case 'permission':
                return <PermissionCard key={b.key} item={it} />
              case 'signin':
                return <SignInCard key={b.key} item={it} chatId={chatId} accountId={accountId} />
              case 'question':
                return <QuestionCard key={b.key} item={it} accountId={accountId} />
              case 'notice':
                return <NoticeRow key={b.key} item={it} chatId={chatId} />
              case 'image':
                return <ImageCard key={b.key} item={it} />
              case 'turn':
                return <TurnFooter key={b.key} item={it} chatId={chatId} accountId={accountId} />
              default:
                return null
            }
          })}
          {busy && state && state.phase !== 'responding' && state.phase !== 'waiting' && <WorkingLine account={account} state={state} />}
        </div>
      </div>
      {away && (
        <button
          onClick={() => {
            stick.current = true
            toBottom(true)
          }}
          aria-label="Jump to latest"
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 animate-pop items-center justify-center rounded-full bg-raised text-ink-2 shadow-float hover:text-ink"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}
