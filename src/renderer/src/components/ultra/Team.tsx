// Ways to show a big team without crowding: the "+N" chip at the end of the agent tabs with its
// grouped menu, and the collapsible group rows of the side panel.

import { useMemo, useState, type ReactNode } from 'react'
import { DropdownMenu } from 'radix-ui'
import { ChevronRight, ShieldQuestion } from 'lucide-react'
import type { Account, AgentPhase } from '@shared/types'
import { agentKey, isBusy, useStore } from '@/store'
import { accentVars, cn } from '@/lib/util'
import { Tip } from '../ui'
import { Orb, OrbStack } from '../Orb'
import { groupAgents, type AgentGroup } from './groups'
import { useLazyStore } from '@/lib/lazy'

/** Each member's phase, as one string, so a list redraws when someone starts or stops and not on every word. */
export function usePhases(chatId: string | null | undefined, team: Account[]): Map<string, AgentPhase> {
  // Phases are reported, not typed into: they follow the store as low-priority work (lib/lazy.ts).
  const sig = useLazyStore((s) => (chatId ? team.map((a) => s.agents[agentKey(chatId, a.id)]?.phase || 'idle').join('|') : ''), `${chatId}|${team.map((a) => a.id).join()}`)
  return useMemo(() => {
    const parts = sig.split('|')
    return new Map(team.map((a, i) => [a.id, (parts[i] || 'idle') as AgentPhase]))
  }, [sig, team])
}

export const working = (p: AgentPhase | undefined): boolean => !!p && p !== 'idle' && p !== 'error'

/** Waiting for you first, then at work, then the rest, each in team order. */
export function busyFirst(list: Account[], phases: Map<string, AgentPhase>): Account[] {
  const rank = (a: Account): number => (phases.get(a.id) === 'waiting' ? 0 : working(phases.get(a.id)) ? 1 : 2)
  return list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a)
}

/** "9 · 4 working", "3 · 1 needs you". */
export function groupCount(g: AgentGroup, phases: Map<string, AgentPhase>): ReactNode {
  const busy = g.members.filter((a) => working(phases.get(a.id))).length
  const asks = g.members.filter((a) => phases.get(a.id) === 'waiting').length
  return (
    <span className="tabular">
      {g.members.length}
      {asks ? <span className="text-warn"> · {asks} needs you</span> : busy ? <span> · {busy} working</span> : <span> · free</span>}
    </span>
  )
}

// ───────────── the "+N" chip and its menu ─────────────

const itemClass =
  'flex min-h-9 items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-[13px] text-ink outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover cursor-default'
const contentClass = 'no-drag z-[70] max-h-[70vh] min-w-[248px] animate-pop overflow-y-auto rounded-[12px] bg-raised p-1 shadow-pop outline-none'

function MemberItem({ chatId, account, phase, onPick }: { chatId: string; account: Account; phase?: AgentPhase; onPick(id: string): void }) {
  const activity = useLazyStore((s) => s.agents[agentKey(chatId, account.id)]?.activity, `${chatId}|${account.id}`)
  const busy = working(phase)
  return (
    <DropdownMenu.Item onSelect={() => onPick(account.id)} className={itemClass} style={accentVars(account.accent)}>
      <Orb account={account} size={16} phase={phase} off={!!account.spawned?.gone} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{account.name}</span>
        <span className={cn('block truncate text-[11.5px] leading-snug', phase === 'waiting' ? 'text-warn' : busy ? 'text-ink-2' : 'text-ink-3')}>
          {phase === 'waiting' ? 'Needs your OK' : busy ? activity || 'Working' : account.role || (account.spawned?.gone ? 'Sent home' : 'Free')}
        </span>
      </span>
    </DropdownMenu.Item>
  )
}

/**
 * The agents that did not fit in the tab row, as one chip with their faces stacked. Its menu
 * lists them by group: "Scouts · 9, 4 working" opens to the scouts themselves.
 */
export function OverflowChip({
  chatId,
  team,
  hidden,
  phases,
  onPick,
}: {
  chatId: string
  team: Account[]
  hidden: Account[]
  phases: Map<string, AgentPhase>
  onPick(id: string): void
}) {
  const hiddenIds = useMemo(() => new Set(hidden.map((a) => a.id)), [hidden])
  // Groups are made from the whole team, so a group reads complete, and listed when any of it is hidden.
  const { singles, groups } = useMemo(() => groupAgents(team.filter((a) => !!a.spawned)), [team])
  const shownGroups = groups.filter((g) => g.members.some((a) => hiddenIds.has(a.id)))
  const loose = busyFirst([...team.filter((a) => !a.spawned && hiddenIds.has(a.id)), ...singles.filter((a) => hiddenIds.has(a.id))], phases)
  const busy = hidden.filter((a) => working(phases.get(a.id))).length
  const asks = hidden.filter((a) => phases.get(a.id) === 'waiting').length
  const faces = busyFirst(hidden, phases).slice(0, 3)
  return (
    <DropdownMenu.Root>
      <Tip label={`${hidden.length} more in this chat${asks ? `, ${asks} waiting for your OK` : busy ? `, ${busy} working` : ''}`}>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label={`${hidden.length} more agents`}
            className={cn(
              'no-drag relative flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink data-[state=open]:bg-hover',
              asks > 0 && 'text-warn',
            )}
          >
            <OrbStack accounts={faces} size={16} max={3} />
            <span className="tabular">+{hidden.length}</span>
            {busy > 0 && !asks && <span className="size-1.5 animate-pulse-soft rounded-full bg-[var(--a2)]" style={accentVars(faces[0]?.accent)} />}
            {asks > 0 && <span className="size-1.5 animate-pulse-soft rounded-full bg-warn" />}
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={10} className={contentClass}>
          <DropdownMenu.Label className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-ink-3">
            {hidden.length} more in this chat{busy ? `, ${busy} working` : ''}
          </DropdownMenu.Label>
          {loose.map((a) => (
            <MemberItem key={a.id} chatId={chatId} account={a} phase={phases.get(a.id)} onPick={onPick} />
          ))}
          {loose.length > 0 && shownGroups.length > 0 && <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />}
          {shownGroups.map((g) => {
            const members = busyFirst(g.members, phases)
            return (
              <DropdownMenu.Sub key={g.key}>
                <DropdownMenu.SubTrigger className={itemClass}>
                  <OrbStack accounts={members} size={16} max={3} />
                  <span className="min-w-0 flex-1 truncate font-medium">{g.label}</span>
                  <span className="shrink-0 text-[11.5px] text-ink-3">{groupCount(g, phases)}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-ink-4" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent sideOffset={4} collisionPadding={10} className={contentClass}>
                    {members.map((a) => (
                      <MemberItem key={a.id} chatId={chatId} account={a} phase={phases.get(a.id)} onPick={onPick} />
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

// ───────────── a group in the side panel ─────────────

/**
 * One line for a whole group: their faces, the name, how many and how many at work. A click opens
 * it to the members, those at work first. Opens by itself when the agent being viewed is in it.
 */
export function GroupRow({ group, phases, focusId, children }: { group: AgentGroup; phases: Map<string, AgentPhase>; focusId?: string; children(members: Account[]): ReactNode }) {
  const inside = !!focusId && group.members.some((a) => a.id === focusId)
  const [open, setOpen] = useState(inside)
  const members = busyFirst(group.members, phases)
  const asks = group.members.some((a) => phases.get(a.id) === 'waiting')
  const any = group.members.some((a) => working(phases.get(a.id)))
  const depth = group.members[0]?.spawned?.depth || 1
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-hover"
        aria-expanded={open}
      >
        <span className={cn('shrink-0 border-b border-l border-line-2', depth > 1 ? 'ml-3.5 h-3 w-2.5' : 'ml-0.5 h-3 w-1.5', '-mt-2 rounded-bl-[5px]')} />
        <OrbStack accounts={members} size={17} max={3} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">{group.label}</span>
          <span className={cn('block truncate text-[11.5px] leading-[15px]', asks ? 'text-warn' : any ? 'text-ink-2' : 'text-ink-3')}>
            {asks ? (
              <span className="flex items-center gap-1 font-medium">
                <ShieldQuestion className="size-3" /> {groupCount(group, phases)}
              </span>
            ) : (
              groupCount(group, phases)
            )}
          </span>
        </span>
        <ChevronRight className={cn('size-3.5 shrink-0 text-ink-4 transition-transform duration-200', open && 'rotate-90')} />
      </button>
      {open && <div className="ml-[17px] animate-fade-in space-y-px border-l border-line-2 pl-1.5">{children(members)}</div>}
    </div>
  )
}
