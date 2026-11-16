import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, Maximize2, Minus, Plus, Video, X } from 'lucide-react'
import { mediaKind } from '@shared/tools'
import { useStore } from '@/store'
import { api, baseName, cn } from '@/lib/util'
import { Tip } from './ui'

/**
 * Pictures and videos open here, inside Ensemble, instead of in another app.
 * Scroll zooms toward the cursor, drag moves a zoomed picture, double-click switches between
 * fitting the window and full size, and ← → step through everything shown alongside it.
 */

/** Opens the viewer on `path`, with every picture and video in the same part of the window around it. */
export function viewFrom(target: Element | null, path: string): void {
  const scope = target?.closest('[data-view-scope]') || document.querySelector('[data-view-scope]') || document.body
  const seen = new Set<string>()
  const paths: string[] = []
  for (const el of scope.querySelectorAll<HTMLElement>('[data-view-path]')) {
    const p = el.dataset.viewPath || ''
    const k = mediaKind(p)
    if (!p || seen.has(p) || (k !== 'image' && k !== 'video')) continue
    seen.add(p)
    paths.push(p)
  }
  if (!seen.has(path)) paths.push(path)
  useStore.getState().openViewer(paths, Math.max(0, paths.indexOf(path)))
}

const MAX = 8
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function Viewer() {
  const viewer = useStore((s) => s.viewer)
  if (!viewer) return null
  return <Open paths={viewer.paths} start={viewer.index} />
}

function Open({ paths, start }: { paths: string[]; start: number }) {
  const close = useStore((s) => s.closeViewer)
  const toast = useStore((s) => s.toast)
  const [index, setIndex] = useState(start)
  const [closing, setClosing] = useState(false)
  const path = paths[index] || paths[0]
  const kind = mediaKind(path)
  const many = paths.length > 1

  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [nat, setNat] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ s: 1, x: 0, y: 0 })
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)

  const fit = nat.w && size.w ? Math.min(1, (size.w - 48) / nat.w, (size.h - 48) / nat.h) : 1
  const zoomed = view.s > fit * 1.001

  const shut = useCallback((): void => {
    setClosing(true)
    setTimeout(close, 140)
  }, [close])
  const go = useCallback((d: number): void => setIndex((i) => (i + d + paths.length) % paths.length), [paths.length])

  // The stage's size, kept current as the window changes.
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A new file starts fitted.
  useEffect(() => {
    setLoaded(false)
    setFailed(false)
    setNat({ w: 0, h: 0 })
    setView({ s: 1, x: 0, y: 0 })
  }, [path])
  useEffect(() => {
    if (nat.w) setView({ s: fit, x: 0, y: 0 })
    // Fitting again on resize only while not zoomed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat.w, nat.h])
  useEffect(() => {
    if (!zoomed && nat.w) setView({ s: fit, x: 0, y: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h])

  // The neighbours load ahead, so stepping through is instant.
  useEffect(() => {
    for (const d of [1, -1]) {
      const p = paths[(index + d + paths.length) % paths.length]
      if (p && mediaKind(p) === 'image') new Image().src = api.fileUrl(p)
    }
  }, [index, paths])

  /** Zooms to `next` (or by a function of the current zoom), keeping the point under (cx, cy) where it is. */
  const zoomAt = useCallback(
    (next: number | ((s: number) => number), cx?: number, cy?: number): void => {
      setView((v) => {
        const s = clamp(typeof next === 'function' ? next(v.s) : next, Math.min(fit, 0.1), MAX)
        const r = stage.current?.getBoundingClientRect()
        if (!r) return { ...v, s }
        const px = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2)
        const py = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2)
        if (s <= fit * 1.001) return { s, x: 0, y: 0 }
        return { s, x: px - ((px - v.x) * s) / v.s, y: py - ((py - v.y) * s) / v.s }
      })
    },
    [fit],
  )
  const reset = (): void => setView({ s: fit, x: 0, y: 0 })

  const copy = async (): Promise<void> => {
    try {
      await api.copyImage(path)
      toast('Picture copied')
    } catch {
      toast('Could not copy that picture', 'warn')
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const handled = (): void => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.key === 'Escape') {
        handled()
        if (zoomed) reset()
        else shut()
      } else if (e.key === 'ArrowRight' && many) {
        handled()
        go(1)
      } else if (e.key === 'ArrowLeft' && many) {
        handled()
        go(-1)
      } else if (kind === 'image' && (e.key === '+' || e.key === '=')) {
        handled()
        zoomAt(view.s * 1.4)
      } else if (kind === 'image' && e.key === '-') {
        handled()
        zoomAt(view.s / 1.4)
      } else if (kind === 'image' && e.key === '0') {
        handled()
        reset()
      } else if (kind === 'image' && e.key === '1') {
        handled()
        zoomAt(1)
      } else if (kind === 'image' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        handled()
        void copy()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const onWheel = (e: React.WheelEvent): void => {
    if (kind !== 'image' || !loaded) return
    // A trackpad pinch arrives as a wheel with ctrl held, in small steps.
    const step = e.ctrlKey ? Math.exp(-e.deltaY / 100) : Math.exp(-e.deltaY / 400)
    // Applied to the zoom as it is by then, so a fast run of wheel steps adds up.
    zoomAt((s) => s * step, e.clientX, e.clientY)
  }
  const onDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    if (zoomed) {
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* a synthetic pointer */
      }
    }
  }
  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (zoomed && d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const onUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    // A click on the empty space around the picture closes; a drag, or a click on the picture, never does.
    if (d && !d.moved && e.target === e.currentTarget && !onPicture(e.clientX, e.clientY)) shut()
  }

  /** Whether a point falls on the picture as it is drawn now. */
  const onPicture = (cx: number, cy: number): boolean => {
    const r = stage.current?.getBoundingClientRect()
    if (!r || kind !== 'image' || !nat.w) return false
    const mx = r.left + r.width / 2 + view.x
    const my = r.top + r.height / 2 + view.y
    return Math.abs(cx - mx) <= (nat.w * view.s) / 2 && Math.abs(cy - my) <= (nat.h * view.s) / 2
  }

  const pct = Math.round(view.s * 100)
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${baseName(path)}`}
      className={cn('no-drag fixed inset-0 z-[80] flex flex-col bg-[rgba(12,12,11,0.88)] text-white backdrop-blur-xl', closing ? 'animate-[viewer-out_140ms_ease-in_forwards]' : 'animate-[viewer-in_180ms_ease-out]')}
    >
      {/* top bar */}
      <div className="relative z-10 flex h-14 shrink-0 items-center gap-3 px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{baseName(path)}</div>
          <div className="tabular truncate text-[11.5px] text-white/55">
            {many ? `${index + 1} of ${paths.length}` : kind === 'video' ? 'Video' : 'Picture'}
            {nat.w ? ` · ${nat.w} × ${nat.h}` : ''}
            {kind === 'image' && loaded ? ` · ${pct}%` : ''}
          </div>
        </div>
        {kind === 'image' && (
          <div className="flex items-center gap-0.5 rounded-[10px] bg-white/10 p-0.5">
            <Bar label="Zoom out (−)" onClick={() => zoomAt(view.s / 1.4)}>
              <Minus className="size-4" />
            </Bar>
            <button onClick={() => (zoomed ? reset() : zoomAt(1))} className="tabular h-8 min-w-[52px] rounded-[8px] px-2 text-[12px] text-white/80 hover:bg-white/10 hover:text-white">
              {zoomed ? 'Fit' : '100%'}
            </button>
            <Bar label="Zoom in (+)" onClick={() => zoomAt(view.s * 1.4)}>
              <Plus className="size-4" />
            </Bar>
          </div>
        )}
        <div className="flex items-center gap-0.5">
          {kind === 'image' && (
            <Bar label="Copy picture (Ctrl+C)" onClick={() => void copy()}>
              <Copy className="size-4" />
            </Bar>
          )}
          <Bar label="Show in folder" onClick={() => void api.showInFolder(path)}>
            <FolderOpen className="size-4" />
          </Bar>
          <Bar label="Open in another app" onClick={() => void api.openPath(path)}>
            <ExternalLink className="size-4" />
          </Bar>
          <span className="mx-1.5 h-5 w-px bg-white/15" />
          <Bar label="Close (Esc)" onClick={shut}>
            <X className="size-[18px]" />
          </Bar>
        </div>
      </div>

      {/* the picture or video */}
      <div
        ref={stage}
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={(e) => kind === 'image' && (zoomed ? reset() : zoomAt(Math.max(1, fit * 2), e.clientX, e.clientY))}
        className={cn('relative min-h-0 flex-1 overflow-hidden select-none', kind === 'image' && (zoomed ? (drag.current?.moved ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'))}
      >
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-white/60">
            This file can no longer be opened.
            <button onClick={() => void api.showInFolder(path)} className="rounded-[9px] bg-white/10 px-3 py-1.5 text-white/85 hover:bg-white/15">
              Show in folder
            </button>
          </div>
        ) : kind === 'video' ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <video
              key={path}
              src={api.fileUrl(path)}
              controls
              autoPlay
              onLoadedMetadata={(e) => setNat({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
              onError={() => setFailed(true)}
              className="pointer-events-auto max-h-full max-w-full rounded-[10px] shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
            />
          </div>
        ) : (
          <img
            key={path}
            src={api.fileUrl(path)}
            alt={baseName(path)}
            draggable={false}
            onLoad={(e) => {
              setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              setLoaded(true)
            }}
            onError={() => setFailed(true)}
            style={{
              width: nat.w || undefined,
              height: nat.h || undefined,
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.s})`,
              transition: drag.current ? 'none' : 'transform 160ms cubic-bezier(.2,.8,.2,1), opacity 200ms',
              opacity: loaded ? 1 : 0,
              imageRendering: view.s > 2 ? 'pixelated' : undefined,
            }}
            className="pointer-events-none absolute top-1/2 left-1/2 max-w-none origin-center rounded-[4px] shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
          />
        )}

        {many && (
          <>
            <Side side="left" onClick={() => go(-1)} />
            <Side side="right" onClick={() => go(1)} />
          </>
        )}
        {kind === 'image' && loaded && !zoomed && !many && (
          <div className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[11px] text-white/40">Scroll to zoom · double-click for full size · Esc to close</div>
        )}
      </div>

      {/* everything else shown with it */}
      {many && <Strip paths={paths} index={index} onPick={setIndex} />}
    </div>
  )
}

function Bar({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Tip label={label}>
      <button onClick={onClick} aria-label={label} className="flex size-8 items-center justify-center rounded-[8px] text-white/80 transition-colors hover:bg-white/10 hover:text-white">
        {children}
      </button>
    </Tip>
  )
}

function Side({ side, onClick }: { side: 'left' | 'right'; onClick(): void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous (←)' : 'Next (→)'}
      className={cn(
        'absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white/85 backdrop-blur-md transition-all hover:scale-105 hover:bg-black/55 hover:text-white',
        side === 'left' ? 'left-4' : 'right-4',
      )}
    >
      <Icon className="size-5" />
    </button>
  )
}

function Strip({ paths, index, onPick }: { paths: string[]; index: number; onPick(i: number): void }) {
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    row.current?.children[index]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [index])
  return (
    <div className="h-[76px] shrink-0 overflow-x-auto px-4 pb-3">
      <div ref={row} className="mx-auto flex h-full w-max items-center gap-2">
      {paths.map((p, i) => (
        <button
          key={p}
          onClick={() => onPick(i)}
          aria-label={baseName(p)}
          className={cn('relative size-14 shrink-0 overflow-hidden rounded-[9px] bg-white/10 transition-all duration-150', i === index ? 'opacity-100 ring-2 ring-white ring-offset-2 ring-offset-black/60' : 'opacity-50 hover:opacity-90')}
        >
          {mediaKind(p) === 'video' ? (
            <span className="flex size-full items-center justify-center">
              <Video className="size-5 text-white/80" />
            </span>
          ) : (
            <img src={api.fileUrl(p)} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
          )}
        </button>
      ))}
      </div>
    </div>
  )
}

/** A small "open large" button for a video playing in place. */
export function ExpandButton({ path, className }: { path: string; className?: string }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        viewFrom(e.currentTarget, path)
      }}
      aria-label="Open large"
      className={cn('flex size-7 items-center justify-center rounded-[8px] bg-black/55 text-white backdrop-blur-sm transition-opacity hover:bg-black/75', className)}
    >
      <Maximize2 className="size-3.5" />
    </button>
  )
}
