// The inbox: what needs the user first, then what the watches found, then watches that keep failing.
// Each row says what it is in a line or two, when, and from which watch; nothing about machinery.
import { memo, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Check, CheckCheck, ChevronRight, Eye, Inbox as InboxIcon, ShieldQuestion, Target } from 'lucide-react'
import type { InboxItem, Watch } from '@shared/watches'
import { useStore } from '@/store'
import { api, cn, relative } from '@/lib/util'
import { Button, Tip } from '../ui'
import { groupInbox, lapseLine } from './words'
import { confirmWatch, openWatchEditor, useWatches, watchApi } from './state'

function Group({ title, count, hint, children }: { title: string; count: number; hint?: string; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section className="mb-7" aria-label={title}>
      <h2 className="mb-2 flex items-baseline gap-2 px-1 text-[12px] font-semibold text-ink-2">
        {title}
        <span className="tabular font-normal text-ink-4">{count}</span>
        {hint && <span className="ml-auto text-[11.5px] font-normal text-ink-4">{hint}</span>}
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-card">{children}</ul>
    </section>
  )
}

const Meta = ({ parts }: { parts: React.ReactNode[] }) => (
  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-3">
    {parts.filter(Boolean).map((p, i) => (
      <span key={i} className="flex items-center gap-1.5">
        {i > 0 && <span className="text-ink-4">·</span>}
        {p}
      </span>
    ))}
  </div>
)

/** Opens what an item is about: its chat when it has one, otherwise the watch that made it. */
function useOpen(item: InboxItem, watch: Watch | undefined): (() => void) | null {
  const openChat = useStore((s) => s.openChat)
  const setView = useStore((s) => s.setView)
  if (item.chatId) return () => void openChat(item.chatId as string).then(() => setView('chat'))
  if (watch?.trigger.kind === 'url') return () => void api.openExternal(watch.trigger.kind === 'url' ? watch.trigger.url : '')
  if (watch?.trigger.kind === 'github') return () => void api.openExternal(`https://github.com/${watch.trigger.kind === 'github' ? watch.trigger.repo : ''}`)
  return null
}

const NeedsYou = memo(function NeedsYou({ item, watch, now }: { item: InboxItem; watch?: Watch; now: number }) {
  const [busy, setBusy] = useState<string | null>(null)
  const open = useOpen(item, watch)
  const lapse = lapseLine(item.approval?.expiresAt, now)
  const lapsed = lapse === 'Lapsed'
  const proposed = item.confirmWatch ? watch : undefined
  const act = async (what: string, f: () => Promise<unknown>): Promise<void> => {
    setBusy(what)
    try {
      await f()
      await watchApi.mark(item.id, { read: true, done: true })
    } finally {
      setBusy(null)
    }
  }
  const answer = (d: 'allow' | 'deny'): Promise<void> => act(d, () => api.respondPermission(item.approval!.requestId, d))
  // An approval leads with what will happen; its own title ("Waiting for your OK") is what the icon says.
  const head = item.approval && item.body ? item.body : item.title
  const body = item.approval && item.body ? '' : item.body
  const Icon = item.approval ? ShieldQuestion : item.confirmWatch ? Eye : item.ref?.startsWith('goal:') || /goal/i.test(item.title) ? Target : AlertTriangle
  const kind = item.approval ? 'Waiting for your OK' : item.confirmWatch ? 'Suggested watch' : item.ref?.startsWith('goal:') ? 'Goal' : null
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <Icon className={cn('mt-[2px] size-4 shrink-0', lapsed ? 'text-ink-4' : 'text-warn')} strokeWidth={1.9} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] leading-snug font-medium text-ink select-text">{head}</div>
        {body && <p className="m-0 mt-0.5 line-clamp-3 text-[12.5px] leading-snug whitespace-pre-line text-ink-2 select-text">{body}</p>}
        <Meta parts={[kind, lapse && <span className={cn(lapsed ? 'text-ink-4' : 'font-medium text-warn')}>{lapse}</span>, !proposed && watch?.name, relative(item.at)]} />
      </div>
      <div className="flex shrink-0 items-start gap-1.5">
        {item.approval && !lapsed ? (
          <>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void answer('deny')}>
              Deny
            </Button>
            <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void answer('allow')}>
              {busy === 'allow' ? 'Approving' : 'Approve'}
            </Button>
          </>
        ) : proposed ? (
          <>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act('no', () => confirmWatch(proposed, false))}>
              No
            </Button>
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => openWatchEditor(proposed)}>
              Change
            </Button>
            <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void act('yes', () => confirmWatch(proposed, true))}>
              Turn on
            </Button>
          </>
        ) : (
          <>
            {open && (
              <Button size="sm" variant="secondary" onClick={open}>
                Open
              </Button>
            )}
            <DoneButton id={item.id} />
          </>
        )}
      </div>
    </li>
  )
})

function DoneButton({ id }: { id: string }) {
  return (
    <Tip label="Done">
      <button onClick={() => void watchApi.mark(id, { read: true, done: true })} aria-label="Done" className="flex size-7 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-hover hover:text-ink">
        <Check className="size-4" strokeWidth={2} />
      </button>
    </Tip>
  )
}

const Found = memo(function Found({ item, watch }: { item: InboxItem; watch?: Watch }) {
  const open = useOpen(item, watch)
  const read = (): void => {
    if (!item.read) void watchApi.mark(item.id, { read: true })
  }
  return (
    <li className="group/f flex gap-3 px-4 py-3" onClick={read} onFocus={read}>
      <span className="mt-[7px] flex size-2 shrink-0 items-center justify-center" aria-hidden>
        <span className={cn('size-2 rounded-full transition-colors', item.read ? 'bg-transparent' : 'bg-link')} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('text-[13.5px] leading-snug text-ink', !item.read && 'font-semibold')}>
          {item.title}
          {!item.read && <span className="sr-only"> (new)</span>}
        </div>
        {item.body && <p className="m-0 mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-2 select-text">{item.body}</p>}
        <Meta parts={[watch?.name, relative(item.at)]} />
      </div>
      <div className="flex shrink-0 items-start gap-1">
        {open && (
          <Button size="sm" variant="secondary" onClick={open}>
            Open <ArrowUpRight className="size-3.5" />
          </Button>
        )}
        <DoneButton id={item.id} />
      </div>
    </li>
  )
})

const Failed = memo(function Failed({ item, watch }: { item: InboxItem; watch?: Watch }) {
  return (
    <li className="flex gap-3 px-4 py-2.5">
      <AlertTriangle className="mt-[2px] size-3.5 shrink-0 text-ink-3" strokeWidth={1.9} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] leading-snug text-ink-2">{item.title}</div>
        {item.body && <p className="m-0 mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-3 select-text">{item.body}</p>}
        <Meta parts={[relative(item.at)]} />
      </div>
      <div className="flex shrink-0 items-start gap-1">
        {watch && (
          <Button size="sm" variant="ghost" onClick={() => openWatchEditor(watch)}>
            Check the watch
          </Button>
        )}
        <DoneButton id={item.id} />
      </div>
    </li>
  )
})

export function InboxList({ now }: { now: number }) {
  const items = useWatches((s) => s.inbox)
  const watches = useWatches((s) => s.watches)
  const [showDone, setShowDone] = useState(false)
  if (!items) return null
  const byId = new Map((watches || []).map((w) => [w.id, w]))
  const g = groupInbox(items)
  const open = g.needsYou.length + g.found.length + g.failed.length
  if (!open) {
    return (
      <div className="mx-auto mt-16 max-w-[400px] text-center">
        <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-[14px] bg-surface-2 text-ink-3 shadow-card">
          <InboxIcon className="size-5" strokeWidth={1.7} />
        </span>
        <div className="text-[15px] font-semibold text-ink">Nothing needs you</div>
        <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-ink-2">
          What your watches find shows up here, and anything that waits for your OK: an action to approve, a goal with a question, a watch the team suggests.
        </p>
        {g.done.length > 0 && <p className="m-0 mt-3 text-[12px] text-ink-3">{g.done.length} done</p>}
      </div>
    )
  }
  return (
    <div>
      <Group title="Needs you" count={g.needsYou.length}>
        {g.needsYou.map((i) => (
          <NeedsYou key={i.id} item={i} watch={i.watchId ? byId.get(i.watchId) : undefined} now={now} />
        ))}
      </Group>
      <Group title="Found for you" count={g.found.length} hint={g.found.some((i) => !i.read) ? `${g.found.filter((i) => !i.read).length} new` : undefined}>
        {g.found.map((i) => (
          <Found key={i.id} item={i} watch={i.watchId ? byId.get(i.watchId) : undefined} />
        ))}
      </Group>
      <Group title="Watches that could not look" count={g.failed.length}>
        {g.failed.map((i) => (
          <Failed key={i.id} item={i} watch={i.watchId ? byId.get(i.watchId) : undefined} />
        ))}
      </Group>
      {g.done.length > 0 && (
        <button onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} className="flex h-7 items-center gap-1.5 rounded-[8px] px-1.5 text-[12px] text-ink-3 hover:bg-hover hover:text-ink">
          <ChevronRight className={cn('size-3.5 transition-transform', showDone && 'rotate-90')} />
          Done <span className="tabular text-ink-4">{g.done.length}</span>
        </button>
      )}
      {showDone && (
        <ul className="mt-1 divide-y divide-line rounded-[12px] bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]">
          {g.done.slice(0, 30).map((i) => (
            <li key={i.id} className="flex items-center gap-2.5 px-4 py-2 text-[12.5px] text-ink-3">
              <CheckCheck className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
              <span className="shrink-0 text-[11.5px] text-ink-4">{relative(i.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Marks everything open as done, apart from approvals, which need an answer. */
export async function markAllDone(items: InboxItem[]): Promise<void> {
  for (const i of items) if (!i.done && !(i.kind === 'needs-you' && (i.approval || i.confirmWatch))) await watchApi.mark(i.id, { read: true, done: true })
}
