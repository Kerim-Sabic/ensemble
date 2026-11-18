// The small actions that sit beside a message: copy it, put your own back in the message box,
// try a failed reply again. They fade in on hover and take no room, so nothing moves.

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil, X } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/util'
import { IconButton } from '../ui'
import { seedComposer } from './Composer'

/** Copies text, and says whether it worked. Falls back to the older way when the clipboard API refuses. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

/**
 * Copies `text`. Once it is on the clipboard the icon turns into a check and the tip says
 * "Copied"; if it could not be copied, it says so instead.
 */
export function CopyButton({ text, className, side = 'top' }: { text: string; className?: string; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const toast = useStore((s) => s.toast)
  const t = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(t.current), [])
  return (
    <IconButton
      label={state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy'}
      side={side}
      onClick={() => {
        void copyText(text.trim()).then((ok) => {
          setState(ok ? 'done' : 'failed')
          if (!ok) toast('Could not copy. Click into the window and try again.', 'warn')
          clearTimeout(t.current)
          t.current = setTimeout(() => setState('idle'), ok ? 1400 : 2400)
        })
      }}
      className={cn('size-6 rounded-[7px] text-ink-3', className)}
    >
      {state === 'done' ? <Check className="size-3.5 text-ok" strokeWidth={2.5} /> : state === 'failed' ? <X className="size-3.5 text-bad" strokeWidth={2.5} /> : <Copy className="size-3.5" />}
    </IconButton>
  )
}

/** Puts one of your messages back in the message box, to change and send again. */
export function EditButton({ text, side = 'top' }: { text: string; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <IconButton label="Edit in the message box" side={side} onClick={() => seedComposer(text)} className="size-6 rounded-[7px] text-ink-3">
      <Pencil className="size-3.5" />
    </IconButton>
  )
}
