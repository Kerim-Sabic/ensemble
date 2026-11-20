// The Inbox view: what needs the user and what the watches found, and beside it the watches
// themselves. Reads its own small store, so the rest of the window is not touched when a watch looks.
import { memo, useEffect, useState } from 'react'
import { CheckCheck, Inbox as InboxIcon, Plus } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/util'
import { Button, Segmented } from '../ui'
import { InboxList, markAllDone } from './InboxList'
import { WatchList } from './WatchList'
import { groupInbox, inboxCount } from './words'
import { openWatchEditor, startWatches, useWatches } from './state'
import { useRepo } from './WatchEditor'

/** A clock for "in 12 min" and "lapses in 5 min": once a minute, and only while the view is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

export function InboxView() {
  useEffect(startWatches, [])
  const now = useMinute()
  const items = useWatches((s) => s.inbox)
  const watches = useWatches((s) => s.watches)
  const [tab, setTab] = useState<'inbox' | 'watches'>(() => (sessionStorage.getItem('ensemble.inbox.tab') === 'watches' ? 'watches' : 'inbox'))
  useEffect(() => sessionStorage.setItem('ensemble.inbox.tab', tab), [tab])
  const cwd = useStore((s) => s.chats.find((c) => c.id === s.chatId)?.cwd || s.settings.defaultCwd)
  const repo = useRepo(cwd, tab === 'watches' && !!watches && !watches.length)
  const count = items ? inboxCount(items, now) : { needs: 0, unread: 0 }
  const g = items ? groupInbox(items) : null
  const anyOpen = !!g && g.found.length + g.failed.length + g.needsYou.filter((i) => !i.approval && !i.confirmWatch).length > 0
  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-6 py-3">
        <Segmented<'inbox' | 'watches'>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'inbox', label: 'Inbox', badge: count.needs || undefined },
            { value: 'watches', label: 'Watches', badge: watches?.filter((w) => w.status === 'active').length || undefined },
          ]}
        />
        <span className="flex-1" />
        {tab === 'inbox' ? (
          anyOpen && (
            <Button size="sm" variant="ghost" onClick={() => items && void markAllDone(items)}>
              <CheckCheck className="size-3.5" /> Mark all done
            </Button>
          )
        ) : (
          <Button size="sm" variant="secondary" onClick={() => openWatchEditor()}>
            <Plus className="size-3.5" /> New watch
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pt-6 pb-10">{tab === 'inbox' ? <InboxList now={now} /> : <WatchList now={now} cwd={cwd} repo={repo} />}</div>
      </div>
    </div>
  )
}

/** The sidebar's way in: the count is what needs the user; new findings show as a dot. */
export const InboxButton = memo(function InboxButton() {
  useEffect(startWatches, [])
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const needs = useWatches((s) => (s.inbox ? inboxCount(s.inbox).needs : 0))
  const unread = useWatches((s) => (s.inbox ? inboxCount(s.inbox).unread : 0))
  const on = view === 'inbox'
  return (
    <button
      onClick={() => setView(on ? 'chat' : 'inbox')}
      aria-label={needs ? `Inbox, ${needs} ${needs === 1 ? 'thing needs' : 'things need'} you` : 'Inbox'}
      className={cn('no-drag mt-0.5 flex h-8 w-full items-center gap-2.5 rounded-[10px] px-3 text-[12.5px] transition-colors', on ? 'bg-active text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink')}
    >
      <InboxIcon className="size-[15px] shrink-0" strokeWidth={1.9} />
      <span className="min-w-0 flex-1 truncate text-left font-medium">Inbox</span>
      {unread > 0 && !needs && <span className="size-[7px] rounded-full bg-link" title={`${unread} new`} />}
      {needs > 0 && <span className="tabular rounded-full bg-warn-soft px-1.5 text-[11px] leading-[17px] font-semibold text-warn">{needs}</span>}
    </button>
  )
})
