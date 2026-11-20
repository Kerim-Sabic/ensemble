// The microphone in the message box. Press it (or Alt+V) and speak; press again, or simply stop
// speaking, and the words appear in the box to be read before they are sent. Esc cancels.
// Speech becomes text on this computer: the first use downloads a speech model once.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/util'
import { Button, IconButton, Spinner, Tip } from '../../ui'
import { pauseBeforeEnd, readSpoken, type Heard } from './voice-commands'
import { VOICE_DOWNLOAD_MB } from './voice-protocol'
import { decodeTo16k, listen, loadVoice, resetVoice, transcribe, VOICE_ERRORS, VOICE_READY_KEY, VoiceError, type Listening } from './voice'

type Phase = { kind: 'idle' } | { kind: 'asking' } | { kind: 'downloading'; loaded: number; total: number } | { kind: 'listening'; since: number } | { kind: 'writing' }

// The button that is on screen, so a test can feed it speech the way the microphone would.
let active: { heard(h: Heard): void; language: string; commands: boolean } | null = null

declare global {
  interface Window {
    /** For checks: run a recording (WAV bytes, base64) through the same transcriber the button uses. */
    __voiceTest?: (wavBase64: string, apply?: boolean) => Promise<{ text: string; ms: number; device: string; seconds: number; heard: Heard }>
    /** For checks: run on the processor only ('wasm') or the best there is ('auto'), with a fresh worker. */
    __voiceDevice?: (to: 'auto' | 'wasm') => void
  }
}
window.__voiceDevice = resetVoice
window.__voiceTest = async (b64, apply = false) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const audio = await decodeTo16k(bytes.buffer)
  const seconds = audio.length / 16000
  const pause = pauseBeforeEnd(audio)
  const r = await transcribe(audio, active?.language || 'english')
  const heard = readSpoken(r.text, active?.commands ?? true, { pause })
  if (apply) active?.heard(heard)
  return { ...r, seconds, heard }
}

const mb = (n: number): string => `${Math.round(n / 1e6)}`

export function VoiceButton({ onHeard, language, commands, disabled }: { onHeard(h: Heard): void; language: string; commands: boolean; disabled?: boolean }) {
  const toast = useStore((s) => s.toast)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [level, setLevel] = useState(0)
  const [, tick] = useState(0)
  const rec = useRef<Listening | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    active = { heard: onHeard, language, commands }
    return () => {
      active = null
    }
  }, [onHeard, language, commands])

  const fail = useCallback(
    (e: unknown) => {
      rec.current?.cancel()
      rec.current = null
      setPhase({ kind: 'idle' })
      setLevel(0)
      toast(e instanceof VoiceError ? e.message : VOICE_ERRORS.failed, 'warn')
    },
    [toast],
  )

  /** Listening is over: what was said goes to the speech model, and its words to the box. */
  const finish = useCallback(async () => {
    const r = rec.current
    if (!r || phaseRef.current.kind !== 'listening') return
    rec.current = null
    setLevel(0)
    const audio = r.finish()
    if (!audio) {
      setPhase({ kind: 'idle' })
      toast(VOICE_ERRORS.silent, 'info')
      return
    }
    setPhase({ kind: 'writing' })
    try {
      // Measured before the audio goes to the worker (handing it over empties it here).
      const pause = pauseBeforeEnd(audio)
      const out = await transcribe(audio, language)
      const heard = readSpoken(out.text, commands, { pause })
      setPhase({ kind: 'idle' })
      if (!heard.text && !heard.command) toast(VOICE_ERRORS.silent, 'info')
      else onHeard(heard)
    } catch (e) {
      fail(e)
    }
  }, [language, commands, onHeard, toast, fail])

  const cancel = useCallback(() => {
    rec.current?.cancel()
    rec.current = null
    setLevel(0)
    setPhase({ kind: 'idle' })
  }, [])

  const startListening = useCallback(async () => {
    try {
      // The model warms up while the person speaks.
      void loadVoice().catch(() => undefined)
      const r = await listen({
        onLevel: (l) => setLevel((p) => p * 0.55 + l * 0.45),
        onQuiet: () => void finishRef.current(),
        onTooLong: () => void finishRef.current(),
      })
      rec.current = r
      setPhase({ kind: 'listening', since: Date.now() })
    } catch (e) {
      fail(e)
    }
  }, [fail])

  const finishRef = useRef(finish)
  finishRef.current = finish

  /** The first use: download the model, then listen. */
  const download = useCallback(async () => {
    setPhase({ kind: 'downloading', loaded: 0, total: VOICE_DOWNLOAD_MB * 1e6 })
    try {
      await loadVoice((loaded, total) => setPhase({ kind: 'downloading', loaded, total: Math.max(total, loaded) }))
      setPhase({ kind: 'idle' })
      await startListening()
    } catch (e) {
      fail(e)
    }
  }, [startListening, fail])

  const press = useCallback(() => {
    const p = phaseRef.current
    if (p.kind === 'listening') return void finish()
    if (p.kind === 'asking') return setPhase({ kind: 'idle' })
    if (p.kind !== 'idle' || disabled) return
    if (!localStorage.getItem(VOICE_READY_KEY)) setPhase({ kind: 'asking' })
    else void startListening()
  }, [finish, startListening, disabled])

  // Alt+V from anywhere; Esc cancels listening (before anything else hears it, so it does not also stop the agent).
  const pressRef = useRef(press)
  pressRef.current = press
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyV') {
        if (s.modal || s.viewer) return
        e.preventDefault()
        pressRef.current()
      } else if (e.key === 'Escape' && (phaseRef.current.kind === 'listening' || phaseRef.current.kind === 'asking')) {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cancel])

  // The clock while listening.
  useEffect(() => {
    if (phase.kind !== 'listening') return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [phase.kind])

  // Leaving the chat (or closing the box) lets go of the microphone.
  useEffect(() => () => rec.current?.cancel(), [])

  const card =
    phase.kind === 'asking' ? (
      <div role="dialog" aria-label="Speak to the message box" className="absolute right-0 bottom-full z-20 mb-3 w-[300px] animate-pop rounded-[14px] bg-raised p-3.5 text-[12.5px] leading-snug shadow-pop">
        <div className="mb-1 flex items-center gap-2 font-semibold text-ink">
          <Mic className="size-3.5" strokeWidth={2} /> Speak instead of typing
        </div>
        <p className="m-0 text-ink-2">
          Speech is turned into text on this computer. The first time, Ensemble downloads a speech model of about {VOICE_DOWNLOAD_MB} MB. What you say never leaves this computer.
        </p>
        <div className="mt-3 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: 'idle' })}>
            Not now
          </Button>
          <Button size="sm" variant="primary" autoFocus onClick={() => void download()}>
            Download and start
          </Button>
        </div>
      </div>
    ) : phase.kind === 'downloading' ? (
      <div role="status" className="absolute right-0 bottom-full z-20 mb-3 w-[300px] animate-pop rounded-[14px] bg-raised p-3.5 text-[12.5px] shadow-pop">
        <div className="mb-2 flex items-center gap-2 text-ink">
          <Spinner className="size-3" /> Getting the speech model
          <span className="tabular ml-auto text-ink-3">
            {mb(phase.loaded)} of {mb(phase.total)} MB
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-hover">
          <div className="h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${Math.min(100, (phase.loaded / (phase.total || 1)) * 100)}%` }} />
        </div>
        <div className="mt-2 text-[11.5px] text-ink-3">Only this once. After that, voice works offline.</div>
      </div>
    ) : null

  if (phase.kind === 'listening' || phase.kind === 'writing') {
    const secs = phase.kind === 'listening' ? Math.floor((Date.now() - phase.since) / 1000) : 0
    return (
      <span className="relative mr-1 flex shrink-0 animate-pop items-center gap-0.5">
        <Tip label={phase.kind === 'listening' ? 'Listening. Click or press Alt+V when you are done' : 'Turning speech into text on this computer'} kbd={phase.kind === 'listening' ? 'Esc cancels' : undefined} side="top">
          <button
            type="button"
            onClick={() => void finish()}
            aria-label={phase.kind === 'listening' ? 'Listening. Click when you are done' : 'Writing it down'}
            aria-live="polite"
            className="flex h-7 items-center gap-2 rounded-full bg-[color-mix(in_oklab,var(--bad)_10%,transparent)] pr-2.5 pl-2 text-[12px] font-medium text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--bad)_28%,transparent)]"
          >
            {phase.kind === 'listening' ? (
              <>
                <span className="relative flex size-2.5 items-center justify-center" aria-hidden>
                  <span className="absolute inset-0 animate-ping rounded-full bg-bad opacity-40" />
                  <span className="relative size-2 rounded-full bg-bad" />
                </span>
                <Level level={level} />
                <span className="tabular w-7 text-left text-ink-2">
                  {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
                </span>
              </>
            ) : (
              <>
                <Spinner className="size-3" />
                <span className="text-ink-2">Writing it down</span>
              </>
            )}
          </button>
        </Tip>
        {phase.kind === 'listening' && (
          <IconButton label="Cancel" kbd="Esc" side="top" onClick={cancel} className="size-6">
            <X className="size-3.5" />
          </IconButton>
        )}
      </span>
    )
  }

  return (
    <span className="relative flex shrink-0">
      {card}
      <IconButton
        label={phase.kind === 'downloading' ? 'Getting the speech model' : 'Speak instead of typing. Audio stays on this computer'}
        kbd="Alt+V"
        side="top"
        disabled={disabled || phase.kind === 'downloading'}
        aria-pressed={phase.kind === 'asking'}
        onClick={press}
        className={cn(phase.kind === 'asking' && 'bg-hover text-ink')}
      >
        <Mic className="size-[15px]" strokeWidth={1.75} />
      </IconButton>
    </span>
  )
}

/** Five soft bars that follow the voice. */
function Level({ level }: { level: number }) {
  const shape = [0.45, 0.8, 1, 0.75, 0.5]
  return (
    <span className="flex h-3.5 items-center gap-[2px]" aria-hidden>
      {shape.map((s, i) => (
        <span key={i} className="w-[3px] rounded-full bg-ink-2 transition-[height] duration-100" style={{ height: `${Math.max(3, Math.min(14, 3 + level * s * 22))}px` }} />
      ))}
    </span>
  )
}
