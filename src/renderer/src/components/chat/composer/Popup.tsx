import { useEffect, useRef, type MouseEvent } from 'react'
import { Slash } from 'lucide-react'
import type { Account } from '@shared/types'
import { APP_COMMANDS } from '@shared/auto'
import { cn } from '@/lib/util'
import { Orb } from '../../Orb'
import { COMMAND_ICON } from './bits'

export type Command = { name: string; description: string; hint?: string; app?: boolean; disabled?: boolean }
export type Popup = { kind: 'mention'; items: Account[] } | { kind: 'command'; items: Command[] } | null

const rank = <T extends { name: string }>(all: T[], q: string): T[] => {
  const n = (c: T): string => c.name.toLowerCase()
  return [...all.filter((c) => n(c).startsWith(q)), ...all.filter((c) => !n(c).startsWith(q) && n(c).includes(q))]
}

/** "@" at the start offers the team; "/" offers the app's own commands, then the ones the teammate knows. */
export function popupFor(text: string, team: Account[], known: Command[] | undefined, ultra = false): Popup {
  const mention = /^@([^\s]*)$/.exec(text)?.[1]
  if (mention !== undefined) {
    const items = team.filter((a) => a.name.toLowerCase().replace(/\s+/g, '').startsWith(mention.toLowerCase()))
    return items.length ? { kind: 'mention', items } : null
  }
  const cmd = /^\/([\w:-]*)$/.exec(text)?.[1]
  if (cmd === undefined) return null
  const q = cmd.toLowerCase()
  // Go crazy only runs in Ultra: it stays in the list, greyed, so it can be found.
  const app = rank(APP_COMMANDS, q).map((c) => (c.name === 'gocrazy' && !ultra ? { ...c, app: true, disabled: true, description: 'Turn Ultra on first (Alt+U)' } : { ...c, app: true }))
  // A teammate's own command of the same name would never be reached: the app answers first.
  const theirs = rank((known || []).filter((c) => !APP_COMMANDS.some((a) => a.name === c.name.toLowerCase())), q).slice(0, 8)
  const items = [...app, ...theirs]
  return items.length ? { kind: 'command', items } : null
}

export function ComposerPopup({ popup, index, onPick, onHover, who, leadId }: { popup: NonNullable<Popup>; index: number; onPick(i: number): void; onHover(i: number): void; who?: string; leadId?: string }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const label = (text: string) => <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-ink-3">{text}</div>
  const pick = (i: number) => ({
    'data-i': i,
    'aria-disabled': popup.kind === 'command' && popup.items[i].disabled ? true : undefined,
    onMouseDown: (e: MouseEvent) => {
      e.preventDefault()
      onPick(i)
    },
    onMouseEnter: () => onHover(i),
  })

  return (
    <div
      ref={box}
      role="listbox"
      className={cn(
        'absolute bottom-full left-3 z-20 mb-2 max-h-[min(440px,52vh)] animate-pop overflow-y-auto rounded-[12px] bg-raised p-1 shadow-pop',
        popup.kind === 'mention' ? 'w-[240px]' : 'w-[440px] max-w-[calc(100%-24px)]',
      )}
    >
      {popup.kind === 'mention' ? (
        <>
          {label('Send to')}
          {popup.items.map((a, i) => (
            <button key={a.id} {...pick(i)} className={cn('flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px]', i === index && 'bg-hover')}>
              <Orb account={a} size={15} />
              <span className="flex-1 truncate">{a.name}</span>
              {a.id === leadId && <span className="text-[11px] text-ink-3">Lead</span>}
            </button>
          ))}
        </>
      ) : (
        popup.items.map((c, i) => {
          const Icon = (c.app && COMMAND_ICON[c.name]) || Slash
          const first = i === 0 || popup.items[i - 1].app !== c.app
          return (
            <div key={`${c.app ? 'app' : 'agent'}:${c.name}`}>
              {first && (i > 0 ? <div className="mx-1.5 my-1 h-px bg-line" /> : null)}
              {first && label(c.app ? 'Ensemble' : `Commands ${who || 'this teammate'} knows`)}
              <button {...pick(i)} className={cn('flex min-h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left', i === index && 'bg-hover', c.disabled && 'cursor-default opacity-45')}>
                <Icon className={cn('size-3.5 shrink-0', c.app ? 'text-ink-2' : 'text-ink-3')} strokeWidth={c.app ? 1.9 : 2} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px]">
                    {c.name}
                    {c.hint && <span className="ml-1.5 text-ink-4">{c.hint}</span>}
                  </span>
                  {c.description && <span className="block truncate text-[11.5px] text-ink-3">{c.description}</span>}
                </span>
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
