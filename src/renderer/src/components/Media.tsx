import { memo, useEffect, useRef, useState } from 'react'
import { FolderOpen, Pause, Play, Video } from 'lucide-react'
import { mediaKind } from '@shared/tools'
import { api, baseName, cn } from '@/lib/util'

// Pictures, sound and video an agent made or points to, shown and played right where they
// are mentioned: in a reply, in a question that asks you to choose between them, and in the
// list of what was made in a chat.

/** Only one thing plays at a time, so voices can be compared one after another. */
let current: HTMLMediaElement | null = null
function claim(el: HTMLMediaElement): void {
  if (current && current !== el) current.pause()
  current = el
}

const clock = (s: number): string => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00')

/** A compact player for a sound: play and pause, where it is, how long it is. */
export const AudioPlayer = memo(function AudioPlayer({ path, label, compact }: { path: string; label?: string; compact?: boolean }) {
  const el = useRef<HTMLAudioElement>(null)
  const [on, setOn] = useState(false)
  const [t, setT] = useState(0)
  const [len, setLen] = useState(0)
  const [failed, setFailed] = useState(false)
  if (failed) return null
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const a = el.current
    if (!a) return
    if (a.paused) {
      claim(a)
      void a.play()
    } else a.pause()
  }
  const seek = (e: React.MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation()
    const a = el.current
    if (!a || !len) return
    const r = e.currentTarget.getBoundingClientRect()
    a.currentTime = ((e.clientX - r.left) / r.width) * len
  }
  return (
    <span onClick={(e) => e.stopPropagation()} className={cn('flex min-w-0 items-center gap-2.5 rounded-[11px] bg-surface-2 py-1.5 pr-3 pl-1.5 shadow-[inset_0_0_0_1px_var(--line)]', compact ? 'w-full' : 'w-[340px] max-w-full')}>
      <audio
        ref={el}
        src={api.fileUrl(path)}
        preload="metadata"
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => setOn(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLen(e.currentTarget.duration)}
        onError={() => setFailed(true)}
      />
      <button onClick={toggle} aria-label={on ? 'Pause' : 'Play'} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--a2,var(--ink))] text-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-transform hover:scale-105 active:scale-95">
        {on ? <Pause className="size-3.5 fill-current" strokeWidth={0} /> : <Play className="ml-0.5 size-3.5 fill-current" strokeWidth={0} />}
      </button>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-medium">{label || baseName(path)}</span>
          <span className="tabular shrink-0 text-[11px] text-ink-3">{on || t ? `${clock(t)} / ` : ''}{clock(len)}</span>
        </span>
        <span onClick={seek} className="mt-1.5 block h-[4px] cursor-pointer overflow-hidden rounded-full bg-line-2">
          <span className="block h-full rounded-full bg-[var(--a2,var(--ink-2))] transition-[width] duration-200 ease-linear" style={{ width: `${len ? (t / len) * 100 : 0}%` }} />
        </span>
      </span>
    </span>
  )
})

/** A video that plays in place. */
export const VideoPlayer = memo(function VideoPlayer({ path, compact }: { path: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <span onClick={(e) => e.stopPropagation()} className={cn('block overflow-hidden rounded-[12px] bg-black shadow-float', compact ? 'w-full max-w-[320px]' : 'w-[520px] max-w-full')}>
      <video src={api.fileUrl(path)} controls preload="metadata" onPlay={(e) => claim(e.currentTarget)} onError={() => setFailed(true)} className="block max-h-[360px] w-full" />
    </span>
  )
})

/** A picture, opened full size on click. */
export function Picture({ path, compact }: { path: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <img
      src={api.fileUrl(path)}
      alt={baseName(path)}
      loading="lazy"
      onError={() => setFailed(true)}
      onClick={(e) => {
        e.stopPropagation()
        void api.openPath(path)
      }}
      className={cn('block cursor-zoom-in rounded-[10px] object-cover shadow-card', compact ? 'h-20 max-w-[160px]' : 'max-h-[340px] max-w-full')}
    />
  )
}

/** Whatever kind of media a file is, shown the right way. */
export function MediaView({ path, compact, label }: { path: string; compact?: boolean; label?: string }) {
  const k = mediaKind(path)
  if (k === 'audio') return <AudioPlayer path={path} compact={compact} label={label} />
  if (k === 'video') return <VideoPlayer path={path} compact={compact} />
  if (k === 'image') return <Picture path={path} compact={compact} />
  return null
}

/** Several files mentioned together, laid out so they can be compared. */
export function MediaStrip({ paths, className }: { paths: string[]; className?: string }) {
  if (!paths.length) return null
  const sounds = paths.filter((p) => mediaKind(p) === 'audio')
  const pictures = paths.filter((p) => mediaKind(p) === 'image')
  const videos = paths.filter((p) => mediaKind(p) === 'video')
  return (
    <div className={cn('my-2 space-y-2', className)}>
      {pictures.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pictures.map((p) => (
            <Picture key={p} path={p} compact={pictures.length > 1} />
          ))}
        </div>
      )}
      {sounds.length > 0 && (
        <div className={cn('grid gap-1.5', sounds.length > 1 && 'sm:grid-cols-2')}>
          {sounds.map((p) => (
            <AudioPlayer key={p} path={p} compact />
          ))}
        </div>
      )}
      {videos.map((p) => (
        <VideoPlayer key={p} path={p} />
      ))}
    </div>
  )
}

/** A small tile for a list of everything made: a thumbnail, or an icon and a name. */
export function MediaTile({ path, onOpen }: { path: string; onOpen?: () => void }) {
  const k = mediaKind(path)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [path])
  if (k === 'audio') return <AudioPlayer path={path} compact />
  return (
    <button
      onClick={() => (onOpen ? onOpen() : void api.openPath(path))}
      title={baseName(path)}
      className="group/tile relative aspect-square w-full overflow-hidden rounded-[10px] bg-surface-3 shadow-card"
    >
      {k === 'image' && !failed ? (
        <img src={api.fileUrl(path)} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover transition-transform duration-300 group-hover/tile:scale-105" />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-1 px-1 text-[10.5px] text-ink-3">
          {k === 'video' ? <Video className="size-5" /> : <FolderOpen className="size-5" />}
          <span className="w-full truncate text-center">{baseName(path)}</span>
        </span>
      )}
    </button>
  )
}
