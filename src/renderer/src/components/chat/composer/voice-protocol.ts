// What the message box and the speech worker say to each other.

/** Whisper base, multilingual, 8-bit: about 76 MB of model, plus the 28 MB runtime, fetched once. */
export const VOICE_MODEL = 'onnx-community/whisper-base'
/**
 * The model's exact version (a commit of its repository), so the files downloaded are always
 * the same ones: a change upstream reaches nobody until this line is changed. Checked 2026-11-20.
 */
export const VOICE_REVISION = '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c'
/** What the first use downloads, for the line that asks: the model and the runtime together. */
export const VOICE_DOWNLOAD_MB = 105

/**
 * The speech runtime (ONNX Runtime Web), fetched from jsDelivr on first use. It is code that runs
 * with the audio, so it runs only if its bytes match these fingerprints exactly: a changed copy is
 * refused. They are the files of the onnxruntime-web package transformers.js depends on, and
 * scripts/checks/voice.ts fails when that package changes and they were not updated with it.
 */
export const VOICE_RUNTIME = {
  version: '1.31.0-dev.20260914-8d85527a0',
  mjs: { name: 'ort-wasm-simd-threaded.asyncify.mjs', sha256: '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611' },
  wasm: { name: 'ort-wasm-simd-threaded.asyncify.wasm', sha256: '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082' },
}

/** What the worker says when a downloaded runtime does not match its fingerprint. */
export const RUNTIME_MISMATCH = 'runtime-fingerprint-mismatch'

export type VoiceIn = { type: 'load'; prefer?: 'auto' | 'wasm' } | { type: 'transcribe'; id: number; audio: Float32Array; language: string }

export type VoiceOut =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; text: string; ms: number; device: 'webgpu' | 'wasm' }
  | { type: 'failed'; stage: 'load' | 'transcribe'; id?: number; message: string }
