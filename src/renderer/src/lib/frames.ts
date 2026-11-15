// Pictures of the screens agents are using arrive here as they change, and
// whoever is drawing one subscribes to it. Kept out of the store on purpose: a
// frame is not state, and ten of them a second should not wake every component.

import { api } from './util'

type Listener = (frame: ImageBitmap) => void

const latest = new Map<string, ImageBitmap>()
const listeners = new Map<string, Set<Listener>>()
const order = new Map<string, number>()
let started = false
let seq = 0

export function startFrames(): void {
  if (started) return
  started = true
  api.onFrame((f) => {
    const n = ++seq
    // Decoding takes a moment and can finish out of order; an older picture never replaces a newer one.
    void createImageBitmap(new Blob([f.data as BlobPart], { type: 'image/jpeg' })).then(
      (bmp) => {
        // The app sends the next picture of this screen only once this one has been dealt with,
        // so a busy window is never buried in pictures it has no time to draw.
        api.frameSeen(f.key)
        if ((order.get(f.key) || 0) > n) {
          bmp.close()
          return
        }
        order.set(f.key, n)
        const old = latest.get(f.key)
        latest.set(f.key, bmp)
        for (const l of listeners.get(f.key) || []) l(bmp)
        old?.close()
      },
      () => api.frameSeen(f.key),
    )
  })
}

export function lastFrame(key: string): ImageBitmap | undefined {
  return latest.get(key)
}

export function subscribe(key: string, l: Listener): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(l)
  return () => {
    set?.delete(l)
  }
}

/** A screen went away: its last picture is no longer worth keeping. */
export function forgetFrames(key: string): void {
  latest.get(key)?.close()
  latest.delete(key)
  order.delete(key)
}
