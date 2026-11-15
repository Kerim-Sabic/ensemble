import { useState } from 'react'
import { ArrowUp, Maximize2, Square } from 'lucide-react'
import type { Account } from '@shared/types'
import { agentKey, leadOf, useStore, useTeam } from '@/store'
import { accentVars, api, cn, duration, prettyModel } from '@/lib/util'
import { IconButton } from './ui'
import { Orb } from './Orb'
import { Transcript } from './chat/Transcript'
import { useElapsed } from './chat/Cards'

function Pane({ chatId, account, isLead }: { chatId: string; account: Account; isLead: boolean }) {
  const state = useStore((s) => s.agents[agentKey(chatId, account.id)])
  const hasItems = useStore((s) => (s.items[agentKey(chatId, account.id)]?.length || 0) > 0)
  const status = useStore((s) => s.statuses[account.id])
  const task = useStore((s) => (state?.taskId ? s.tasks[chatId]?.find((t) => t.id === state.taskId) : undefined))
  const send = useStore((s) => s.send)
  const setFocus = useStore((s) => s.setFocus)
  const setView = useStore((s) => s.setView)
  const [text, setText] = useState('')
  const busy = !!state && state.phase !== 'idle' && state.phase !== 'error'
  const elapsed = useElapsed(busy ? state?.turnStartedAt : undefined)
  const out = status?.state === 'signed-out'

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    void send(t, undefined, account.id)
  }

  return (
    <section style={accentVars(account.accent)} className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px] bg-surface shadow-card">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pr-2 pl-3.5">
        <Orb account={account} size={26} phase={state?.phase} off={out} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[13.5px] font-semibold">{account.name}</span>
            {isLead && <span className="text-[11px] text-ink-3">Lead</span>}
            {state?.model && <span className="truncate text-[11px] text-ink-4">{prettyModel(state.model)}</span>}
          </div>
          <div className="truncate text-[12px] leading-[16px]">
            {out ? (
              <span className="text-warn">Signed out</span>
            ) : busy ? (
              <>
                <span className={cn(state?.phase === 'waiting' ? 'font-medium text-warn' : 'shimmer-text')}>{state?.activity || 'Working'}</span>
                {elapsed > 3000 && <span className="tabular ml-1.5 text-ink-4">{duration(elapsed)}</span>}
              </>
            ) : state?.phase === 'error' ? (
              <span className="text-bad">Stopped with a problem</span>
            ) : (
              <span className="text-ink-3">{task ? task.title : 'Free'}</span>
            )}
          </div>
        </div>
        {busy && (
          <IconButton label={`Stop ${account.name}`} onClick={() => void api.stop(chatId, account.id)}>
            <Square className="size-3 fill-current" strokeWidth={0} />
          </IconButton>
        )}
        <IconButton
          label="Open full chat"
          onClick={() => {
            setFocus(account.id)
            setView('chat')
          }}
        >
          <Maximize2 className="size-[14px]" />
        </IconButton>
      </header>

      {hasItems ? (
        <Transcript chatId={chatId} accountId={account.id} compact />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Orb account={account} size={36} off={out} />
          <p className="max-w-[240px] text-[12.5px] leading-relaxed text-ink-3">
            {out ? 'Sign in to bring this account onto the team.' : isLead ? 'The lead has not been asked anything in this chat yet.' : `${account.name} has not been given anything in this chat yet.`}
          </p>
        </div>
      )}

      <div className="shrink-0 border-t border-line p-2">
        <div className="flex h-9 items-center gap-1.5 rounded-[11px] bg-surface-2 pr-1 pl-3 shadow-[inset_0_0_0_1px_var(--line)] focus-within:shadow-[inset_0_0_0_1px_var(--line-2)]">
          <input
            value={text}
            disabled={out}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={out ? 'Signed out' : `Message ${account.name}`}
            className="selectable min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
          />
          <button
            onClick={submit}
            disabled={!text.trim()}
            aria-label="Send"
            className="flex size-7 items-center justify-center rounded-full bg-ink text-inverse transition-all disabled:bg-transparent disabled:text-ink-4"
          >
            <ArrowUp className="size-3.5" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </section>
  )
}

/** Everyone on the team side by side, live. */
export function TeamView() {
  const chatId = useStore((s) => s.chatId)
  const team = useTeam()
  const leadId = useStore((s) => leadOf(s)?.id)
  if (!chatId) return null
  const cols = team.length <= 1 ? 'grid-cols-1' : team.length === 2 ? 'grid-cols-2' : team.length === 4 ? 'grid-cols-2 xl:grid-cols-4' : 'grid-cols-2 xl:grid-cols-3'
  const rows = team.length > 2 && team.length <= 4 ? 'grid-rows-2 xl:grid-rows-1' : team.length > 4 ? 'auto-rows-[minmax(320px,1fr)]' : 'grid-rows-1'
  return (
    <div className={cn('grid h-full min-h-0 gap-2.5 overflow-auto bg-surface-2 p-2.5', cols, rows)}>
      {team.map((a) => (
        <Pane key={a.id} chatId={chatId} account={a} isLead={a.id === leadId} />
      ))}
    </div>
  )
}
