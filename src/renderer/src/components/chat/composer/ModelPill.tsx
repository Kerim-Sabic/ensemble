import { ChevronDown, Gauge } from 'lucide-react'
import type { Account } from '@shared/types'
import { agentKey, useStore } from '@/store'
import { api, prettyModel } from '@/lib/util'
import { Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from '../../ui'

const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const EFFORT_HINT: Record<string, string> = {
  low: 'Quick answers, least allowance',
  medium: 'Balanced',
  high: 'Thinks things through',
  xhigh: 'Thinks hard about difficult work',
  max: 'Everything it has. Slow and costly.',
}

/** The model and effort the next message will run with, changeable in place. */
export function ModelPill({ account }: { account: Account }) {
  const status = useStore((s) => s.statuses[account.id])
  const live = useStore((s) => (s.chatId ? s.agents[agentKey(s.chatId, account.id)]?.model : undefined))
  // Why the app chose the model it is running, when nobody picked one by hand.
  const why = useStore((s) => (s.chatId && !account.model ? s.agents[agentKey(s.chatId, account.id)]?.modelWhy : undefined))
  const smart = useStore((s) => s.settings.smartModels)
  const run = useStore((s) => s.run)
  // An agent started inside a chat has no settings of its own: it shows what it runs, and why.
  if (account.spawned) {
    const label = prettyModel(live) || 'Picked when it starts'
    return (
      <Tip side="top" label={why || 'The app picks the strongest model its account can afford each time it starts.'}>
        <span className="flex h-7 min-w-[68px] shrink-[20] items-center gap-1.5 rounded-[8px] px-1.5 text-[12.5px] text-ink-3">
          <Gauge className="size-[14px] shrink-0" strokeWidth={1.75} />
          <span className="truncate">{label}</span>
        </span>
      </Tip>
    )
  }
  const models = (status?.models || []).filter((m) => m.value)
  const chosen = models.find((m) => m.value === account.model)
  const efforts = (chosen?.efforts || models.find((m) => m.value === 'default')?.efforts || models.find((m) => m.isDefault)?.efforts || (account.provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'])).filter((e) => e !== 'ultra')
  const name = chosen?.label.replace(/\s*\(.*\)$/, '') || prettyModel(live) || models.find((m) => m.isDefault)?.label || (account.provider === 'chatgpt' ? 'ChatGPT' : 'Default model')
  const set = (patch: { model?: string | null; effort?: string | null }): void => void run(api.updateAccount(account.id, patch))

  return (
    <Menu
      side="top"
      width={272}
      trigger={
        <button className="flex h-7 min-w-[68px] shrink-[20] items-center gap-1.5 rounded-[8px] px-1.5 text-[12.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink">
          <Gauge className="size-[14px] shrink-0" strokeWidth={1.75} />
          <span className="truncate">
            {name}
            {account.effort && <span className="text-ink-4"> · {EFFORT_LABEL[account.effort] || account.effort}</span>}
          </span>
          <ChevronDown className="size-3 shrink-0 text-ink-4" />
        </button>
      }
    >
      {models.length > 0 && (
        <>
          <MenuLabel>Model for {account.name}</MenuLabel>
          <MenuItem
            checked={!account.model}
            hint={smart && account.provider === 'claude' ? why || 'The strongest model the allowance can afford, chosen each time it starts' : why || 'Whatever this account is set to use'}
            onSelect={() => set({ model: null })}
          >
            {smart && account.provider === 'claude' ? 'Best for the allowance' : 'Account default'}
          </MenuItem>
          {models
            .filter((m) => m.value !== 'default')
            .map((m) => (
              <MenuItem key={m.value} checked={m.value === account.model} hint={m.description} onSelect={() => set({ model: m.value })}>
                {m.label}
              </MenuItem>
            ))}
          <MenuSeparator />
        </>
      )}
      <MenuLabel>Effort</MenuLabel>
      <MenuItem checked={!account.effort} onSelect={() => set({ effort: null })}>
        Default
      </MenuItem>
      {efforts.map((e) => (
        <MenuItem key={e} checked={e === account.effort} hint={EFFORT_HINT[e]} onSelect={() => set({ effort: e })}>
          {EFFORT_LABEL[e] || e}
        </MenuItem>
      ))}
    </Menu>
  )
}

