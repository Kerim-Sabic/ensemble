// The message box's ears: the microphone, a simple ear for when speaking has stopped, and the
// worker that turns speech into text on this computer. Nothing here sends audio anywhere.
import { RUNTIME_MISMATCH, type VoiceIn, type VoiceOut } from './voice-protocol'

/** Set once the speech model has been downloaded on this computer: later uses ask nothing. */
export const VOICE_READY_KEY = 'ensemble.voice.ready'

/** One plain line for each way voice can fail. The box is left as it was. */
export const VOICE_ERRORS = {
  noMic: 'No microphone was found. Plug one in and try again.',
  blocked: 'The microphone is blocked. Allow desktop apps to use it in Windows Settings, Privacy and security, Microphone.',
  busy: 'The microphone is in use by another app or could not be opened.',
  download: 'The speech model could not be downloaded. Check the internet connection and try again.',
  tampered: 'The downloaded speech runtime did not match the copy Ensemble expects, so voice was not started.',
  slow: 'This computer took too long to turn speech into text. Try a shorter message.',
  failed: 'Speech could not be turned into text this time. Try again.',
  silent: 'Nothing was heard. Speak a little closer to the microphone.',
}

export class VoiceError extends Error {}

// ───────────── the worker ─────────────

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, { resolve(r: { text: string; ms: number; device: string }): void; reject(e: Error): void }>()
let ready: Promise<string> | null = null
let onProgress: ((loaded: number, total: number) => void) | null = null

function theWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<VoiceOut>) => {
    const m = e.data
    if (m.type === 'progress') onProgress?.(m.loaded, m.total)
    else if (m.type === 'result') {
      waiting.get(m.id)?.resolve({ text: m.text, ms: m.ms, device: m.device })
      waiting.delete(m.id)
    } else if (m.type === 'failed' && m.id != null) {
      waiting.get(m.id)?.reject(new VoiceError(m.message))
      waiting.delete(m.id)
    }
  }
  worker.onerror = () => {
    for (const w of waiting.values()) w.reject(new VoiceError(VOICE_ERRORS.failed))
    waiting.clear()
  }
  return worker
}

/** A worker that is stuck (a machine too slow) is thrown away; the next use starts a fresh one. */
function dropWorker(): void {
  worker?.terminate()
  worker = null
  ready = null
  for (const w of waiting.values()) w.reject(new VoiceError(VOICE_ERRORS.slow))
  waiting.clear()
}

/** How long a download may go without any progress before it counts as failed. */
const LOAD_STALL_MS = 120_000
/** The model takes a few hundred MB while loaded: it is let go after this long unused, and loads again from the cache when needed. */
const IDLE_UNLOAD_MS = 10 * 60_000
let idle: ReturnType<typeof setTimeout> | null = null
function restIdle(): void {
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => {
    idle = null
    if (worker && !waiting.size) {
      worker.terminate()
      worker = null
      ready = null
    }
  }, IDLE_UNLOAD_MS)
}

/** For checks: start again with a fresh worker, on the processor only ('wasm') or the best there is ('auto'). */
export function resetVoice(to: 'auto' | 'wasm'): void {
  dropWorker()
  prefer = to
}
// The processor by default: with this 8-bit model it measured faster than the graphics card
// (3.9 s against 6.1 s for 5 s of speech, on an NVIDIA card). 'auto' tries the card first.
let prefer: 'auto' | 'wasm' = 'wasm'

/** Loads the model (downloading it the first time). Resolves with where it runs: 'webgpu' or 'wasm'. */
export function loadVoice(progress?: (loaded: number, total: number) => void): Promise<string> {
  if (progress) onProgress = progress
  if (ready) return ready
  const w = theWorker()
  restIdle()
  ready = new Promise<string>((resolve, reject) => {
    // A download that stops moving fails after a while, instead of spinning for ever.
    let stall: ReturnType<typeof setTimeout> | null = null
    const arm = (): void => {
      if (stall) clearTimeout(stall)
      stall = setTimeout(() => {
        w.removeEventListener('message', on)
        dropWorker()
        reject(new VoiceError(VOICE_ERRORS.download))
      }, LOAD_STALL_MS)
    }
    const on = (e: MessageEvent<VoiceOut>): void => {
      const m = e.data
      if (m.type === 'progress') arm()
      else if (m.type === 'ready') {
        if (stall) clearTimeout(stall)
        w.removeEventListener('message', on)
        localStorage.setItem(VOICE_READY_KEY, '1')
        resolve(m.device)
      } else if (m.type === 'failed' && m.stage === 'load') {
        if (stall) clearTimeout(stall)
        w.removeEventListener('message', on)
        ready = null
        reject(new VoiceError(m.message === RUNTIME_MISMATCH ? VOICE_ERRORS.tampered : VOICE_ERRORS.download))
      }
    }
    w.addEventListener('message', on)
    arm()
    w.postMessage({ type: 'load', prefer } satisfies VoiceIn)
  })
  return ready
}

/**
 * Turns 16 kHz mono audio into text. Gives up (and throws the worker away) when it takes far
 * longer than the audio itself, which is what a machine too slow for this looks like.
 */
export async function transcribe(audio: Float32Array, language: string): Promise<{ text: string; ms: number; device: string }> {
  await loadVoice()
  const w = theWorker()
  const id = ++seq
  const seconds = audio.length / 16000
  const limit = Math.max(25000, seconds * 8000)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dropWorker()
      reject(new VoiceError(VOICE_ERRORS.slow))
    }, limit)
    waiting.set(id, {
      resolve: (r) => (clearTimeout(timer), restIdle(), resolve(r)),
      reject: (e) => (clearTimeout(timer), restIdle(), reject(e)),
    })
    w.postMessage({ type: 'transcribe', id, audio, language } satisfies VoiceIn, [audio.buffer])
  })
}

// ───────────── the microphone ─────────────

export interface Listening {
  /** Ends listening and hands back what was recorded (16 kHz mono), or null if nothing was said. */
  finish(): Float32Array | null
  /** Ends listening and throws away what was recorded. */
  cancel(): void
}

/** Opens the microphone. Levels (0 to 1) arrive as it listens; onQuiet fires after speech, then a pause. */
export async function listen(opts: { onLevel(level: number): void; onQuiet(): void; onTooLong(): void }): Promise<Listening> {
  if (!navigator.mediaDevices?.getUserMedia) throw new VoiceError(VOICE_ERRORS.noMic)
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (e) {
    const name = (e as DOMException)?.name
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') throw new VoiceError(VOICE_ERRORS.noMic)
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') throw new VoiceError(VOICE_ERRORS.blocked)
    throw new VoiceError(VOICE_ERRORS.busy)
  }
  const ctx = new AudioContext({ sampleRate: 16000 })
  const source = ctx.createMediaStreamSource(stream)
  // A script processor is old but simple, and enough for a few seconds of speech at 16 kHz.
  const proc = ctx.createScriptProcessor(2048, 1, 1)
  const chunks: Float32Array[] = []
  let heard = false
  // The room's own noise: the quietest moment heard so far (speech never lowers it).
  let floor = 1
  let quietFor = 0
  let total = 0
  let closed = false
  proc.onaudioprocess = (e) => {
    if (closed) return
    const d = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(d))
    let sum = 0
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
    const rms = Math.sqrt(sum / d.length)
    const secs = d.length / 16000
    total += secs
    floor = Math.min(floor, Math.max(rms, 0.002))
    // Speech stands well above the room's noise; a noisy room raises the bar, but only so far.
    const speaking = rms > Math.min(0.06, Math.max(0.015, floor * 3))
    if (speaking) {
      heard = true
      quietFor = 0
    } else quietFor += secs
    opts.onLevel(Math.min(1, rms * 9))
    if (heard && quietFor > 1.4) opts.onQuiet()
    else if (!heard && total > 10) opts.onQuiet()
    if (total > 120) opts.onTooLong()
  }
  source.connect(proc)
  proc.connect(ctx.destination)
  const close = (): void => {
    if (closed) return
    closed = true
    try {
      proc.disconnect()
      source.disconnect()
    } catch {
      /* already apart */
    }
    for (const t of stream.getTracks()) t.stop()
    void ctx.close().catch(() => {})
  }
  return {
    finish() {
      close()
      if (!heard) return null
      return joinChunks(chunks)
    },
    cancel: close,
  }
}

export function joinChunks(chunks: Float32Array[]): Float32Array {
  const n = chunks.reduce((t, c) => t + c.length, 0)
  const out = new Float32Array(n)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** Any audio the browser can read (a WAV, say), as 16 kHz mono: how a test feeds the same path. */
export async function decodeTo16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 16000, 16000)
  const buf = await ctx.decodeAudioData(bytes)
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000)
  const src = off.createBufferSource()
  src.buffer = buf
  src.connect(off.destination)
  src.start()
  const out = await off.startRendering()
  return new Float32Array(out.getChannelData(0))
}
