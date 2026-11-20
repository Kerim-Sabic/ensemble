import { memo } from 'react'
import { CircleAlert, Maximize2 } from 'lucide-react'
import type { ScreenKind } from '@shared/types'
import { screenKey, useStore } from '@/store'
import type { ScreenItem } from '@/lib/derive'
import { accentVars, api, cn, siteOf } from '@/lib/util'
import { Spinner } from '../ui'
import { LiveFrame, Pointer, SurfaceIcon } from './Screen'
import { StepIcon } from './LiveView'

/**
 * A window onto a screen a teammate is using, placed in the chat where they
 * started using it. It shows the screen as it is now while they work, and the
 * last picture afterwards. Clicking it opens the Live view.
 */
export const ScreenCard = memo(function ScreenCard({ chatId, accountId, surface, items, latest, compact }: { chatId: string; accountId: string; surface: ScreenKind; items: ScreenItem[]; latest: boolean; compact?: boolean }) {
  const key = screenKey(chatId, accountId, surface)
  const screen = useStore((s) => s.screens[key])
  const account = useStore((s) => s.members[accountId])
  const watch = useStore((s) => s.watch)
  const last = items[items.length - 1]
  const shot = [...items].reverse().find((i) => i.shot)?.shot
  const url = screen?.url || [...items].reverse().find((i) => i.url)?.url
  // Only the newest card follows the screen; older ones stay as the record of that turn.
  const live = latest && !!screen
  const working = live && screen.active
  const running = last.status === 'running'
  const ratio = screen ? screen.width / screen.height : surface === 'browser' ? 1280 / 800 : 16 / 9

  return (
    <button
      onClick={() => watch(key, live ? null : last.id)}
      style={accentVars(account?.accent)}
      className={cn(
        'group/sc my-3 block w-full animate-rise overflow-hidden rounded-[14px] bg-surface text-left shadow-card transition-shadow duration-200 hover:shadow-float',
        compact ? 'max-w-full' : 'max-w-[540px]',
        working && 'shadow-[0_0_0_1px_color-mix(in_oklab,var(--a2)_45%,var(--line)),0_14px_36px_-16px_color-mix(in_oklab,var(--a2)_50%,transparent)]',
      )}
    >
      <div className="relative w-full overflow-hidden bg-surface-3" style={{ aspectRatio: String(ratio) }}>
        {live ? (
          <LiveFrame screenKey={key} still={shot} className="absolute inset-0 size-full object-fill" />
        ) : shot ? (
          <img src={api.fileUrl(shot)} alt="" draggable={false} loading="lazy" className="absolute inset-0 size-full object-fill" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <SurfaceIcon kind={surface} className="size-6 text-ink-4" />
          </div>
        )}
        {live && screen.pointer && <Pointer pointer={screen.pointer} account={account} small />}
        {working && (
          <span className="absolute top-2.5 left-2.5 flex h-[22px] items-center gap-1.5 rounded-full bg-black/60 pr-2.5 pl-2 text-[11px] font-medium text-white backdrop-blur-sm">
            <span className="size-1.5 animate-pulse-soft rounded-full bg-[#ff5b4f]" /> Live
          </span>
        )}
        <span className="absolute top-2.5 right-2.5 flex h-[22px] items-center gap-1.5 rounded-full bg-black/60 px-2.5 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover/sc:opacity-100 group-hover/sc:backdrop-blur-sm">
          <Maximize2 className="size-3" /> {live ? 'Watch' : 'Replay'}
        </span>
      </div>
      <div className="flex h-10 items-center gap-2 px-3 text-[12.5px]">
        <SurfaceIcon kind={surface} className="size-[15px] shrink-0 text-ink-3" />
        <span className="max-w-[40%] shrink-0 truncate font-medium">{surface === 'browser' ? siteOf(url) || 'Browser' : 'This computer'}</span>
        <span className={cn('min-w-0 flex-1 truncate', running ? 'shimmer-text' : last.status === 'error' ? 'text-bad' : 'text-ink-3')}>{last.label}</span>
        <span className="tabular shrink-0 text-[11.5px] text-ink-4">
          {items.length} {items.length === 1 ? 'step' : 'steps'}
        </span>
      </div>
    </button>
  )
})

/** One step on a screen, as a line among the rest of what the agent did. */
export const ScreenRow = memo(function ScreenRow({ item, chatId, accountId }: { item: ScreenItem; chatId: string; accountId: string }) {
  const watch = useStore((s) => s.watch)
  const running = item.status === 'running'
  return (
    <button
      onClick={() => watch(screenKey(chatId, accountId, item.surface), item.id)}
      title={item.status === 'error' ? item.error : undefined}
      className="group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2 rounded-[7px] px-1.5 text-left text-[13px] transition-colors hover:bg-hover"
    >
      <StepIcon action={item.action} surface={item.surface} className={cn('size-[15px] shrink-0', item.status === 'error' ? 'text-bad' : 'text-ink-3')} />
      <span className={cn('min-w-0 flex-1 truncate', running ? 'shimmer-text' : 'text-ink-2')}>{item.label}</span>
      {running ? (
        <Spinner className="size-3" />
      ) : item.status === 'error' ? (
        <CircleAlert className="size-3.5 text-bad" />
      ) : (
        <span className="text-[11.5px] text-ink-4 opacity-0 group-hover/row:opacity-100">See it</span>
      )}
    </button>
  )
})
