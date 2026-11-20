// The phone's end of the tunnel to Ensemble through a relay. Plain script: the phone page loads it
// with <script src="/tunnel.js">, and Ensemble's checks import the same file, so what is checked is
// what runs on the phone. It sets globalThis.EnsembleTunnel.
//
// Everything between the phone and the computer is end-to-end encrypted here and in
// src/main/relay.ts: the relay passes opaque text and can neither read, change, replay nor inject
// a frame, nor pair a phone. Only standard primitives, through WebCrypto:
//   - P-256 ECDH. The phone's own key pair is made once, its private half not extractable, and kept
//     (by the page) in IndexedDB. The computer's public key comes from the QR code, never from the relay.
//   - Every connection makes fresh ephemeral keys on both sides. The session keys come from
//     HKDF-SHA-256 over ECDH(phone, computer) || ECDH(phone ephemeral, computer ephemeral), salted with
//     the hash of the whole handshake, one key per direction.
//   - AES-256-GCM, the nonce is the direction and a counter that must go up by exactly one, so a
//     changed, replayed, dropped or reordered frame ends the session.
//   - Pairing proves the one-time code from the computer's screen inside the encrypted channel.
;(function () {
  'use strict'
  const subtle = globalThis.crypto.subtle
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  const b64u = (bytes) => {
    let s = ''
    const u = new Uint8Array(bytes)
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const unb64u = (s) => {
    const t = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4))
    const u = new Uint8Array(t.length)
    for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i)
    return u
  }
  const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }

  const ECDH = { name: 'ECDH', namedCurve: 'P-256' }

  /** The phone's own key pair, made once. The private half can be used but never read out. */
  async function createIdentity() {
    const pair = await subtle.generateKey(ECDH, false, ['deriveBits'])
    const pub = b64u(await subtle.exportKey('raw', pair.publicKey))
    return { privateKey: pair.privateKey, pub }
  }

  const importPub = (b64) => subtle.importKey('raw', unb64u(b64), ECDH, false, [])
  const dh = async (priv, pubB64) => new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importPub(pubB64) }, priv, 256))

  /** The handshake's salt and the two directional keys; the same as deriveKeys in src/main/relay.ts. */
  async function deriveKeys(ikm, transcript) {
    const salt = new Uint8Array(await subtle.digest('SHA-256', enc.encode(transcript)))
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
    const key = (info) => subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    return { salt, p2c: await key('ensemble p2c'), c2p: await key('ensemble c2p') }
  }

  const nonceOf = (dir, n) => {
    const iv = new Uint8Array(12)
    const v = new DataView(iv.buffer)
    v.setUint32(0, dir)
    v.setBigUint64(4, BigInt(n))
    return iv
  }

  /**
   * One tunnel to the computer through the relay. It reconnects by itself (a phone that sleeps,
   * changes network or loses signal), with a fresh session each time, and sends again what was
   * waiting for an answer, under the same request id, so the computer never acts on it twice.
   *
   * o: { relay, room, pcPub, identity:{privateKey,pub}, deviceId?, pair?:{code,name},
   *      WebSocket?, onState?(state, detail), onPaired?(device), onBye?() }
   */
  function open(o) {
    const WS = o.WebSocket || globalThis.WebSocket
    const wsUrl = String(o.relay).replace(/^http/, 'ws').replace(/\/+$/, '') + '/room/' + encodeURIComponent(o.room) + '/phone'
    let ws = null
    let session = null
    let deviceId = o.deviceId || null
    let pairing = o.pair || null
    let retry = 0
    let timer = null
    let closed = false
    let seq = 0
    const pending = new Map() // id -> {frame, resolve, reject}
    const streams = new Map() // id -> {path, onLine}
    let frags = {} // pieces of large answers, by id
    const state = (s, detail) => o.onState && o.onState(s, detail)

    async function seal(obj) {
      const iv = nonceOf(1, session.out++)
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: session.salt }, session.p2c, enc.encode(JSON.stringify(obj)))
      return 'e.' + b64u(ct)
    }
    async function unseal(d) {
      const iv = nonceOf(2, session.in++)
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: session.salt }, session.c2p, unb64u(d.slice(2)))
      return JSON.parse(dec.decode(pt))
    }
    const raw = (d) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ t: 'd', d }))
    async function send(obj) {
      // Until the computer has answered the pairing or the hello, only those two go out; requests wait in
      // `pending` and leave once the session is ready, so nothing is sent twice.
      if (!session || (!session.ready && obj.t !== 'pair' && obj.t !== 'hello')) return false
      // Encrypt and send in one step per frame: the counters must go out in order.
      session.chain = session.chain.then(async () => raw(await seal(obj)))
      await session.chain
      return true
    }

    function drop(why) {
      session = null
      frags = {}
      if (ws) {
        try { ws.close() } catch { /* already closed */ }
      }
      ws = null
      if (closed) return
      state(why === 'pc-offline' ? 'pc-offline' : 'offline', why)
      clearTimeout(timer)
      retry = Math.min(retry + 1, 6)
      timer = setTimeout(connect, 400 * 2 ** (retry - 1) + Math.random() * 300)
    }

    async function connect() {
      if (closed) return
      clearTimeout(timer)
      state('connecting')
      const eph = await subtle.generateKey(ECDH, false, ['deriveBits'])
      const ephPub = b64u(await subtle.exportKey('raw', eph.publicKey))
      const nonce = b64u(rand(16))
      const kind = pairing ? 'pair' : 'resume'
      const hello = { k: kind, sp: o.identity.pub, ep: ephPub, n: nonce, dev: deviceId || undefined }
      let sock
      try {
        sock = new WS(wsUrl)
      } catch (e) {
        return drop(String(e && e.message))
      }
      ws = sock
      sock.onopen = () => raw(JSON.stringify(hello))
      sock.onclose = () => { if (ws === sock) drop('closed') }
      sock.onerror = () => { if (ws === sock) drop('error') }
      sock.onmessage = async (ev) => {
        if (ws !== sock) return
        let m
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data)) } catch { return drop('bad frame') }
        // The phone does not wait for the relay to close the connection: it ends it and tries again later.
        if (m.t === 'offline') return drop('pc-offline')
        if (m.t !== 'd' || typeof m.d !== 'string') return
        try {
          if (!session) {
            // The computer's answer to the hello, in the clear: its ephemeral key and nonce.
            const h = JSON.parse(m.d)
            // In the clear, so anyone on the path could have written it: the phone stops trying and says so,
            // but keeps its pairing. Only a "bye" inside the encrypted channel (the computer itself) removes it.
            if (h.k === 'unknown') { closed = true; state('unknown'); return sock.close() }
            if (h.k !== 'hi' || typeof h.ep !== 'string' || typeof h.n !== 'string') return drop('bad hello')
            const ikm = concat(await dh(o.identity.privateKey, o.pcPub), await dh(eph.privateKey, h.ep))
            const transcript = ['ensemble-tunnel-1', kind, o.identity.pub, ephPub, nonce, o.pcPub, h.ep, h.n, deviceId || ''].join('|')
            const k = await deriveKeys(ikm, transcript)
            session = { ...k, in: 0, out: 0, ready: false, chain: Promise.resolve() }
            if (pairing) await send({ t: 'pair', code: pairing.code, name: pairing.name || 'Phone' })
            else await send({ t: 'hello' })
            return
          }
          if (!m.d.startsWith('e.')) return drop('clear frame after handshake')
          let f = await unseal(m.d)
          // A large answer comes in pieces; it is read once all of them are in.
          if (f.t === 'frag') {
            const got = (frags[f.id] = frags[f.id] || [])
            got[f.i] = f.s
            if (f.n > 200 || got.join('').length > 16e6) return drop('answer too large')
            if (got.filter((x) => typeof x === 'string').length < f.n) return
            delete frags[f.id]
            f = JSON.parse(got.join(''))
          }
          if (f.t === 'paired') {
            session.ready = true
            deviceId = f.device.id
            pairing = null
            retry = 0
            state('ready')
            o.onPaired && o.onPaired(f.device)
            resend()
          } else if (f.t === 'refused') {
            closed = true
            state('refused', f.error)
            sock.close()
          } else if (f.t === 'ready') {
            session.ready = true
            retry = 0
            state('ready')
            resend()
          } else if (f.t === 'res') {
            const p = pending.get(f.id)
            if (p) {
              pending.delete(f.id)
              p.resolve({ status: f.s, json: f.b })
            }
          } else if (f.t === 'ev') {
            const s = streams.get(f.id)
            if (s) s.onLine(f.line)
          } else if (f.t === 'bye') {
            closed = true
            state('unpaired')
            o.onBye && o.onBye()
            sock.close()
          }
        } catch {
          // A frame that does not decrypt (changed, replayed, out of order, or not from the computer) ends the session.
          drop('frame rejected')
        }
      }
    }

    /** After a (re)connection: what was waiting for an answer goes again, under the same ids; streams are opened again. */
    function resend() {
      for (const [id, p] of pending) void send({ ...p.frame, id })
      for (const [id, s] of streams) void send({ t: 'sub', id, p: s.path })
    }

    void connect()

    return {
      get deviceId() { return deviceId },
      /** One API call. POSTs carry a request id: sent again after a reconnect, the computer answers it once. */
      request(method, path, body, opts) {
        const id = 'q' + ++seq
        const rid = method !== 'GET' ? (opts && opts.rid) || b64u(rand(12)) : undefined
        const frame = { t: 'req', m: method, p: path, b: body, rid }
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (pending.delete(id)) reject(new Error('timeout'))
          }, (opts && opts.timeoutMs) || 45_000)
          pending.set(id, { frame, resolve: (r) => { clearTimeout(timeout); resolve(r) }, reject })
          void send({ ...frame, id })
        })
      },
      /** The live stream: `onLine` gets the same text blocks the page reads from /api/events on Wi-Fi. */
      stream(path, onLine) {
        const id = 's' + ++seq
        streams.set(id, { path, onLine })
        void send({ t: 'sub', id, p: path })
        return { close: () => { streams.delete(id); void send({ t: 'unsub', id }) } }
      },
      /** Comes back now (the page became visible again) instead of waiting for the next try. */
      wake() { if (!session && !closed) { retry = 0; void connect() } },
      close() {
        closed = true
        clearTimeout(timer)
        for (const p of pending.values()) p.reject(new Error('closed'))
        pending.clear()
        if (ws) try { ws.close() } catch { /* gone */ }
      },
    }
  }

  /** The pairing link from the computer's QR code: #r=<room>&k=<computer key>&c=<code>. */
  function readLink(hash) {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, ''))
    const room = q.get('r')
    const pcPub = q.get('k')
    const code = (q.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!room || !/^[A-Za-z0-9_-]{22}$/.test(room) || !pcPub || !/^[A-Za-z0-9_-]{80,100}$/.test(pcPub) || code.length !== 8) return null
    return { room, pcPub, code }
  }

  globalThis.EnsembleTunnel = { createIdentity, open, readLink, b64u, unb64u }
})()
