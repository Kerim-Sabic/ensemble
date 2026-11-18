// How a chat looks while Ultra is on: a mark in its header and in the sidebar, a faint edge of
// colour along the top, and a live network of its agents at the top of the transcript.

import './styles'
import { useEffect, useId, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Maximize2 } from 'lucide-react'
import { api, cn } from '@/lib/util'
import { useStore, workingIn } from '@/store'
import { IconButton, Menu, MenuItem, MenuLabel, Tip } from '../ui'
import { useNet } from './AgentNetwork'
import { NeuralNetwork } from './neural/Neural'
import { openNetwork } from './neural/NetworkView'

/** Three linked nodes in the Ultra colours: the mark of a chat that runs a whole network. */
export function UltraGlyph({ size = 14, className }: { size?: number; className?: string }) {
  // Each copy has its own gradient: a shared id breaks when the first copy is hidden.
  const id = `ux-g${useId().replace(/:/g, '')}`
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={cn('shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="16" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--ux-1)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--ux-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--ux-3)' }} />
        </linearGradient>
      </defs>
      <path d="M4 8 C 7 8, 8 3.6, 12 3.6 M4 8 C 7 8, 8 12.4, 12 12.4 M12 3.6 L12 12.4" stroke={`url(#${id})`} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="4" cy="8" r="2.4" fill={`url(#${id})`} />
      <circle cx="12" cy="3.6" r="1.9" fill={`url(#${id})`} />
      <circle cx="12" cy="12.4" r="1.9" fill={`url(#${id})`} />
    </svg>
  )
}

/** The word "Ultra" in its colours. */
export function UltraWord({ className }: { className?: string }) {
  return <span className={cn('ux-ultra-text font-semibold tracking-[-0.005em]', className)}>Ultra</span>
}

/** In the chat's header while Ultra is on. One click away from turning it off. */
export function UltraMark({ chatId }: { chatId: string }) {
  const run = useStore((s) => s.run)
  return (
    <Menu
      align="end"
      width={260}
      trigger={
        <button aria-label="Ultra is on" className="ux-ultra-pill no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[12px] transition-opacity hover:opacity-85">
          <UltraGlyph size={13} />
          <UltraWord />
        </button>
      }
    >
      <MenuLabel>Ultra is on in this chat</MenuLabel>
      <div className="px-2.5 pb-1.5 text-[11.5px] leading-snug text-ink-3">Many agents on the strongest models at full effort, cross-checked. Uses allowance very fast.</div>
      <MenuItem
        hint="New messages go back to the usual way of working"
        onSelect={() => {
          if (typeof api.setUltra === 'function') void run(api.setUltra(chatId, false))
        }}
      >
        Turn Ultra off
      </MenuItem>
    </Menu>
  )
}

const OPEN_KEY = 'ensemble.network.open'

/**
 * Whether the network strip is up in this chat: always in Ultra, and otherwise once more than
 * three agents are at work. It stays up until the work has been quiet for a few seconds, so it
 * does not jump in and out as agents start and finish, and the transcript under it holds still.
 */
export function useStripShown(chatId: string | null | undefined): boolean {
  const ultra = useStore((s) => !!chatId && !!s.chats.find((c) => c.id === chatId)?.ultra)
  const many = useStore((s) => !!chatId && s.accounts.filter((a) => a.enabled).length + (s.chats.find((c) => c.id === chatId)?.agents?.length ?? 0) > 1)
  const busy = useStore((s) => workingIn(s, chatId))
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (busy > 3) {
      setHeld(true)
      return
    }
    if (!held || busy > 0) return
    const t = setTimeout(() => setHeld(false), 4000)
    return () => clearTimeout(t)
  }, [busy, held])
  useEffect(() => setHeld(false), [chatId])
  return many && (ultra || busy > 3 || held)
}

/**
 * At the top of a chat while Ultra is on, or while more than three agents are at work: one line
 * with how many are working and a thumbnail of the network. A click opens the full network
 * (about 120 px in all); another folds it back to the line.
 */
export function NetworkStrip({ chatId, onOpen, off }: { chatId: string; onOpen?(id: string): void; /** Hidden while the brain view stands in for it. */ off?: boolean }) {
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === chatId)?.ultra)
  const { net, busy, tasks, finished } = useNet(chatId)
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === '1')
  const show = useStripShown(chatId) && net.nodes.length > 1 && !off
  const done = tasks.filter((t) => t.status === 'done').length
  const toggle = (): void => {
    setOpen((o) => {
      localStorage.setItem(OPEN_KEY, o ? '0' : '1')
      return !o
    })
  }
  const n = net.nodes.length
  const bg = ultra ? 'var(--surface)' : 'var(--surface-2)'
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto w-full max-w-[780px] overflow-hidden px-7"
        >
          <div className={cn('mt-1 mb-2 rounded-[12px]', ultra ? 'ux-ultra-frame' : 'bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]')} data-network-strip>
            <div className="flex h-9 w-full items-center pr-1.5">
            <button onClick={toggle} aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-3 text-left text-[12px] text-ink-3">
              {ultra && <UltraGlyph size={13} />}
              {ultra && <UltraWord className="text-[12px]" />}
              <span className="tabular min-w-0 flex-1 truncate">
                {ultra && <span className="text-ink-4">· </span>}
                <span className="text-ink-2">{n} agents</span>
                {finished > 0 && (
                  <Tip label={`${finished} more did their part and were sent home`} side="bottom">
                    <span> · {finished} finished</span>
                  </Tip>
                )}
                {busy.size > 0 && (
                  <>
                    <span className="text-ink-4"> · </span>
                    <span className="font-medium text-ink">{busy.size} working</span>
                  </>
                )}
                {tasks.length > 0 && (
                  <>
                    <span className="text-ink-4"> · </span>
                    {done} of {tasks.length} tasks done
                  </>
                )}
              </span>
              {!open && <NeuralNetwork chatId={chatId} variant="mini" height={26} bg={bg} className="!w-[132px] shrink-0 max-[1000px]:!w-[96px]" />}
              <Tip label={open ? 'Fold the network' : 'Show the network'} side="left">
                <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-200', open && 'rotate-180')} />
              </Tip>
            </button>
            <IconButton label="Open the whole network" side="left" onClick={() => openNetwork(chatId)} className="size-6 rounded-[7px] text-ink-3">
              <Maximize2 className="size-3.5" />
            </IconButton>
            </div>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <NeuralNetwork chatId={chatId} variant="strip" height={84} bg={bg} onOpen={onOpen} className="-mt-1" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** A thin line of colour along the top of a chat in Ultra, and a faint glow under it. */
export function UltraEdge() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] animate-fade-in" aria-hidden>
      <div className="ux-ultra-edge h-[2px] opacity-90" />
      <div className="ux-ultra-glow h-28" />
    </div>
  )
}
