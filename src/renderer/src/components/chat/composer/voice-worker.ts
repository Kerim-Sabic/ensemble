// Speech to text on this computer: Whisper (base, multilingual, 8-bit) run by transformers.js in
// a worker, on the graphics card when WebGPU is there and on the processor (WebAssembly)
// otherwise. The model and the runtime are fetched once, on first use, and kept in the
// window's cache, so it works offline afterwards. Audio never leaves this worker.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { RUNTIME_MISMATCH, VOICE_MODEL, VOICE_REVISION, VOICE_RUNTIME, type VoiceIn, type VoiceOut } from './voice-protocol'

env.allowLocalModels = false
// No cross-origin isolation in the window, so no shared memory: one thread.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1
// The runtime is fetched, checked and kept here (below), not by the library.
env.useWasmCache = false

const post = (m: VoiceOut): void => (self as unknown as Worker).postMessage(m)

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The runtime's two files, fetched once from jsDelivr and kept in this window's cache, and used
 * only when their bytes match the fingerprints pinned in the code. A copy that does not match,
 * cached or fresh, is never run: the audio this worker holds must not reach code nobody checked.
 */
async function verifiedRuntime(onBytes: (loaded: number, total: number) => void): Promise<{ mjs: string; wasm: string }> {
  const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VOICE_RUNTIME.version}/dist/`
  const cache = typeof caches !== 'undefined' ? await caches.open('ensemble-voice-runtime').catch(() => null) : null
  const totals = new Map<string, { loaded: number; total: number }>()
  const tell = (): void => {
    let loaded = 0
    let total = 0
    for (const t of totals.values()) {
      loaded += t.loaded
      total += t.total
    }
    onBytes(loaded, total)
  }
  const one = async (f: { name: string; sha256: string }, type: string): Promise<string> => {
    const url = base + f.name
    let bytes: ArrayBuffer | null = null
    const kept = await cache?.match(url).catch(() => undefined)
    if (kept) {
      const b = await kept.arrayBuffer()
      if (hex(await crypto.subtle.digest('SHA-256', b)) === f.sha256) bytes = b
      else await cache?.delete(url).catch(() => false)
    }
    if (!bytes) {
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`The speech runtime could not be downloaded (${res.status})`)
      const total = Number(res.headers.get('content-length')) || 0
      const reader = res.body.getReader()
      const parts: Uint8Array[] = []
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        loaded += value.length
        totals.set(f.name, { loaded, total: Math.max(total, loaded) })
        tell()
      }
      const all = new Uint8Array(loaded)
      let at = 0
      for (const p of parts) {
        all.set(p, at)
        at += p.length
      }
      bytes = all.buffer
      if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== f.sha256) throw new Error(RUNTIME_MISMATCH)
      await cache?.put(url, new Response(bytes.slice(0), { headers: { 'content-type': type } })).catch(() => undefined)
    }
    return URL.createObjectURL(new Blob([bytes], { type }))
  }
  const [mjs, wasm] = await Promise.all([one(VOICE_RUNTIME.mjs, 'text/javascript'), one(VOICE_RUNTIME.wasm, 'application/wasm')])
  return { mjs, wasm }
}

let asr: AutomaticSpeechRecognitionPipeline | null = null
let loading: Promise<void> | null = null
let device: 'webgpu' | 'wasm' = 'wasm'
// The processor by default: with this 8-bit model it measured faster than the graphics card
// (3.9 s against 6.1 s for 5 s of speech, on an NVIDIA card). 'auto' tries the card first.
let prefer: 'auto' | 'wasm' = 'wasm'

type Adapter = { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean; vendor?: string; architecture?: string; description?: string } }

/** A real graphics card: a software stand-in (a fallback adapter) is slower than the processor. */
async function hasGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu
    const a = gpu ? await gpu.requestAdapter() : null
    return !!a && !a.isFallbackAdapter && !a.info?.isFallbackAdapter
  } catch {
    return false
  }
}

async function load(): Promise<void> {
  // Bytes per file, so the progress shown is of the whole download.
  const files = new Map<string, { loaded: number; total: number }>()
  const progress = (p: { status?: string; file?: string; loaded?: number; total?: number }): void => {
    if (p.status !== 'progress' || !p.file || !p.total) return
    files.set(p.file, { loaded: p.loaded || 0, total: p.total })
    let loaded = 0
    let total = 0
    for (const f of files.values()) {
      loaded += f.loaded
      total += f.total
    }
    post({ type: 'progress', loaded, total })
  }
  // The runtime first, checked against its fingerprints; its download counts in the progress too.
  const runtime = await verifiedRuntime((loaded, total) => progress({ status: 'progress', file: 'runtime', loaded, total }))
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = runtime
  const make = (d: 'webgpu' | 'wasm'): Promise<AutomaticSpeechRecognitionPipeline> =>
    pipeline('automatic-speech-recognition', VOICE_MODEL, { revision: VOICE_REVISION, dtype: 'q8', device: d, progress_callback: progress }) as Promise<AutomaticSpeechRecognitionPipeline>
  if (prefer === 'auto' && (await hasGpu())) {
    try {
      const p = await make('webgpu')
      // One short run proves the card can do it; a card that cannot gives way to the processor.
      await p(new Float32Array(16000), { language: 'english', task: 'transcribe' })
      asr = p
      device = 'webgpu'
      return
    } catch {
      /* fall back to the processor */
    }
  }
  asr = await make('wasm')
  device = 'wasm'
}

self.onmessage = async (e: MessageEvent<VoiceIn>) => {
  const m = e.data
  if (m.type === 'load') {
    if (m.prefer) prefer = m.prefer
    try {
      loading ??= load()
      await loading
      post({ type: 'ready', device })
    } catch (err) {
      loading = null
      post({ type: 'failed', stage: 'load', message: (err as Error)?.message || String(err) })
    }
    return
  }
  if (m.type === 'transcribe') {
    try {
      loading ??= load()
      await loading
      const t0 = performance.now()
      // Whisper hears 30 seconds at a time: longer speech is read in overlapping windows, not cut off.
      const r = (await asr!(m.audio, { language: m.language || 'english', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 })) as { text: string } | { text: string }[]
      const text = Array.isArray(r) ? r.map((x) => x.text).join(' ') : r.text
      post({ type: 'result', id: m.id, text, ms: Math.round(performance.now() - t0), device })
    } catch (err) {
      post({ type: 'failed', stage: 'transcribe', id: m.id, message: (err as Error)?.message || String(err) })
    }
  }
}
