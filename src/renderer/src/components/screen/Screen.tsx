import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Globe, Monitor } from 'lucide-react'
import type { Account, ScreenKind, ScreenState } from '@shared/types'
import { useStore } from '@/store'
import { lastFrame, subscribe } from '@/lib/frames'
import { accentVars, api, cn } from '@/lib/util'

export const SurfaceIcon = ({ kind, className }: { kind: ScreenKind; className?: string }) => (kind === 'browser' ? <Globe className={className} strokeWidth={1.75} /> : <Monitor className={className} strokeWidth={1.75} />)

/** Whether the window can be seen at all. Nothing needs to be kept fresh for a window nobody is looking at. */
function useSeen(): boolean {
  const [seen, setSeen] = useState(() => !document.hidden)
  useEffect(() => {
    const on = (): void => setSeen(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return seen
}

/**
 * The picture of a screen an agent is using. `full` is the live view, which asks
 * the app for every frame; anywhere else it is a small window that is kept
 * current with an occasional picture, and a burst of them when the agent acts.
 * `still` is what to show until the first arrives.
 */
export const LiveFrame = memo(function LiveFrame({ screenKey, still, full, className, style }: { screenKey: string; still?: string; full?: boolean; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const exists = useStore((s) => !!s.screens[screenKey])
  const seen = useSeen()
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    setDrawn(false)
    const draw = (bmp: ImageBitmap): void => {
      const c = ref.current
      if (!c) return
      if (c.width !== bmp.width || c.height !== bmp.height) {
        c.width = bmp.width
        c.height = bmp.height
      }
      try {
        c.getContext('2d')?.drawImage(bmp, 0, 0)
        setDrawn(true)
      } catch {
        /* a frame that was replaced mid-draw: the next one is already on its way */
      }
    }
    const last = lastFrame(screenKey)
    if (last) draw(last)
    return subscribe(screenKey, draw)
  }, [screenKey])

  useEffect(() => {
    if (!exists || !seen) return
    void api.screenWatch(screenKey, true, !!full)
    return () => void api.screenWatch(screenKey, false, !!full)
  }, [screenKey, exists, seen, full])

  return (
    <>
      <canvas ref={ref} className={cn(className, !drawn && 'hidden')} style={style} />
      {!drawn && still && <img src={api.fileUrl(still)} alt="" draggable={false} className={className} style={style} />}
    </>
  )
})

const CLICKS = new Set(['click', 'left_click', 'right_click', 'double_click', 'triple_click', 'middle_click', 'select'])

/** The agent's pointer, drawn over the picture: it glides to wherever the agent last acted and wears its name. */
export const Pointer = memo(function Pointer({ pointer, account, small }: { pointer: NonNullable<ScreenState['pointer']>; account: Account | undefined; small?: boolean }) {
  return (
    <div
      className="pointer-events-none absolute z-10 transition-[left,top] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
      style={{ left: `${Math.min(100, Math.max(0, pointer.x * 100))}%`, top: `${Math.min(100, Math.max(0, pointer.y * 100))}%`, ...accentVars(account?.accent) }}
    >
      {CLICKS.has(pointer.action) && <span key={pointer.ts} className="click-ripple" />}
      <svg width={small ? 14 : 20} height={small ? 14 : 20} viewBox="0 0 20 20" className="absolute -top-px -left-px drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]" aria-hidden>
        <path d="M2.2 1.6 17 8.3l-6.3 1.9-2.1 6.2L2.2 1.6Z" fill="var(--a2)" stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      {!small && account && (
        <span className="absolute top-[17px] left-[13px] rounded-full bg-[var(--a2)] px-2 py-[2px] text-[11px] leading-[15px] font-medium whitespace-nowrap text-white shadow-[0_1px_4px_rgba(0,0,0,0.25)]">
          {account.name}
        </span>
      )}
    </div>
  )
})

/** Where a past step happened, marked on its still picture. */
export function StepMark({ x, y, account }: { x: number; y: number; account: Account | undefined }) {
  return (
    <span className="pointer-events-none absolute z-10" style={{ left: `${x * 100}%`, top: `${y * 100}%`, ...accentVars(account?.accent) }}>
      <span className="absolute -top-[13px] -left-[13px] size-[26px] rounded-full border-2 border-[var(--a2)] bg-[color-mix(in_oklab,var(--a2)_22%,transparent)] shadow-[0_0_0_1px_rgba(255,255,255,0.85),0_2px_8px_rgba(0,0,0,0.25)]" />
      <span className="absolute -top-[2.5px] -left-[2.5px] size-[5px] rounded-full bg-[var(--a2)]" />
    </span>
  )
}
