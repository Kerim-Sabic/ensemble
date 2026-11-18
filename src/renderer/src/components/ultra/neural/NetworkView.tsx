// The Network view of the Team tab: the whole team as a neural network, with the live numbers
// above it and a legend below, so every state can be read without guessing.

import { useStore } from '@/store'
import { cn } from '@/lib/util'
import { Orb } from '../../Orb'
import { NeuralLegend, NeuralNetwork, useNeural, useNeuralNumbers } from './Neural'

/** Chats for which the next visit to the Team tab should open on the network. */
const wanted = new Set<string>()

/** Opens the Team tab on the network for this chat. */
export function openNetwork(chatId: string): void {
  wanted.add(chatId)
  const s = useStore.getState()
  if (s.chatId !== chatId) void s.openChat(chatId).then(() => useStore.getState().setView('flow'))
  else s.setView('flow')
}

/** True once for a chat that asked to open on the network. */
export function takeNetworkWish(chatId: string): boolean {
  return wanted.delete(chatId)
}

export function NeuralNumbers({ chatId, className }: { chatId: string; className?: string }) {
  const n = useNeuralNumbers(chatId)
  const bits: { v: string; strong?: boolean }[] = [{ v: `${n.present} ${n.present === 1 ? 'agent' : 'agents'}` }]
  if (n.working) bits.push({ v: `${n.working} working`, strong: true })
  if (n.tasks) bits.push({ v: `${n.done} of ${n.tasks} tasks done` })
  if (n.depth > 1) bits.push({ v: `${n.depth} levels deep` })
  if (n.gone) bits.push({ v: `${n.gone} sent home` })
  return (
    <div className={cn('tabular flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3', className)} aria-live="polite">
      {bits.map((b, i) => (
        <span key={b.v} className={cn(b.strong ? 'font-medium text-ink' : i === 0 ? 'text-ink-2' : '')}>
          {i > 0 && <span className="mr-1.5 text-ink-4">·</span>}
          {b.v}
        </span>
      ))}
    </div>
  )
}

/** Accounts on the team that this run has not given any work to: named, not drawn. */
export function Bench({ chatId, onOpen, className }: { chatId: string; onOpen(id: string): void; className?: string }) {
  const { bench } = useNeural(chatId)
  if (!bench.length) return null
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-[11.5px] text-ink-3', className)}>
      <span className="mr-1">Also on the team</span>
      {bench.map((a) => (
        <button
          key={a.id}
          onClick={() => onOpen(a.id)}
          className="flex h-6 items-center gap-1.5 rounded-full px-2 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          <Orb account={a} size={12} />
          {a.name}
        </button>
      ))}
    </div>
  )
}

export function NetworkView({ chatId, onOpen }: { chatId: string; onOpen(id: string): void }) {
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === chatId)?.ultra)
  return (
    <div className="relative flex min-h-0 flex-1 flex-col border-t border-line">
      {/* Depth through light: a soft glow behind the work, nothing drawn that means nothing. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background: ultra
            ? 'radial-gradient(60% 70% at 50% 48%, color-mix(in oklab, var(--ux-2) 7%, transparent), transparent 70%), radial-gradient(40% 50% at 18% 50%, color-mix(in oklab, var(--ux-1) 6%, transparent), transparent 70%)'
            : 'radial-gradient(60% 70% at 50% 48%, color-mix(in oklab, var(--ink) 3%, transparent), transparent 70%)',
        }}
      />
      <div className="relative flex shrink-0 items-center gap-3 px-6 pt-3">
        <NeuralNumbers chatId={chatId} className="flex-1" />
        <span className="hidden shrink-0 text-[11.5px] text-ink-4 2xl:block">Point at a neuron to see what it does. Click to open its conversation.</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <NeuralNetwork chatId={chatId} variant="full" onOpen={onOpen} className="absolute inset-0" />
      </div>
      <div className="relative flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-1 px-6 pb-3">
        <NeuralLegend />
        <Bench chatId={chatId} onOpen={onOpen} />
      </div>
    </div>
  )
}
