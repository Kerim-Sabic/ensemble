import { useState } from 'react'
import { ArrowRight, FlaskConical } from 'lucide-react'
import { useStore } from '@/store'
import { api } from '@/lib/util'
import { Spinner } from './ui'

/**
 * The slim strip at the top of the demo team ("Try the demo team"): it says plainly that the agents
 * are scripted, and offers the way back to the real app. Shown for as long as the demo runs.
 */
export function DemoBar() {
  const trial = useStore((s) => s.env.trial)
  const [leaving, setLeaving] = useState(false)
  if (!trial) return null
  return (
    <div className="drag flex h-8 shrink-0 items-center justify-center gap-2.5 pr-[146px] pl-3 text-[12px]" role="status">
      <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-[3px] text-accent">
        <FlaskConical className="size-3.5 shrink-0" />
        <span className="font-semibold">Demo team</span>
        <span className="truncate text-ink-2">Scripted agents, nothing is sent anywhere</span>
      </span>
      <button
        type="button"
        className="no-drag flex shrink-0 items-center gap-1 rounded-full px-2.5 py-[3px] font-medium text-ink hover:bg-hover disabled:opacity-60"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          void api.switchDemo(false).catch(() => setLeaving(false))
        }}
      >
        {leaving ? <Spinner className="size-3" /> : null}
        Sign in and use it for real
        <ArrowRight className="size-3.5" />
      </button>
    </div>
  )
}
