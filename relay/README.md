# Ensemble relay

The relay lets a paired phone reach Ensemble on your computer from anywhere: mobile data, another Wi-Fi, abroad. You run it yourself, on your own Cloudflare account, on the free plan. There is no shared relay, and Ensemble has no built-in relay address.

## What it is

The relay is a small Cloudflare Worker with one Durable Object per "room". A room joins one computer and its paired phones.

- **Your computer** keeps one outbound connection to its room. No port is opened on the computer.
- **Your phone** connects to the same room.
- **The relay** passes text between the two. It serves the phone page as well (`index.html`, `tunnel.js`, `sw.js`, the icon).

## What it can and cannot see

Everything between the phone and the computer is end-to-end encrypted, in `resources/remote/tunnel.js` on the phone and `src/main/relay.ts` on the computer:

- Each phone has its own P-256 key pair, made on the phone. Its private half cannot be read out, even by the page.
- The computer has its own key pair.
- Every connection makes fresh keys on both sides. The session keys come from ECDH and HKDF-SHA-256.
- Frames are AES-256-GCM with a counter that must go up by exactly one.

**The relay can see:**

- That a room exists, and the hash of the computer's room secret (the only thing it stores).
- When the computer and each phone connect and disconnect, from which IP address, and how many frames of what size pass.
- In the clear during the handshake: public keys, random numbers, and the device id of a phone that reconnects.

**The relay cannot:**

- Read, change, replay, reorder or inject a frame. Any of these ends the session.
- See a prompt, a reply, a chat title, an approval, the pairing code or a device name.
- Pair a phone. Pairing proves the one-time code from the computer's screen inside the encrypted channel.
- Act as a phone it has seen before. A phone's long-term key never leaves the phone.

**The one thing you have to trust:** the relay sends the phone its page. A relay that served a changed page could steal what the phone shows and types. This is why the relay must be your own, and why Ensemble offers no shared one. Treat your Cloudflare account like the computer itself: use a strong password and two-factor sign-in.

## Put it on your Cloudflare account

You need a free Cloudflare account and Node.js on any computer.

```bash
cd relay
npx wrangler@4 login        # opens the browser to sign in to Cloudflare
npx wrangler@4 deploy       # prints the address, for example https://ensemble-relay.<you>.workers.dev
```

Then in Ensemble on your computer:

1. Settings → Phone and remote → turn it on.
2. Under **From anywhere**, enter the address `wrangler deploy` printed (https), press **Save**, and turn **Use the relay** on.
3. Press **Show a pairing code** and scan the QR code with the iPhone's camera. It opens the relay's page and pairs. The room, the computer's key and the code travel after the `#` of the link, so they never reach any server.
4. On the iPhone, tap Share → **Add to Home Screen**, open Ensemble from there, and tap **Turn on notifications** if you want them.

To stop: turn **Use the relay** off in Ensemble, which closes the connection at once. To remove the relay itself: `npx wrangler@4 delete`.

## Limits

Each limit is in `core.ts`, and the relay enforces it:

- A frame is at most 256 KB.
- A phone may send 40 frames a second (80 at once); the computer 400 (800 at once).
- A room holds 8 phones.
- A computer must claim its room within 5 seconds.

The free plan's daily Worker and Durable Object allowances cover one person's use. Idle connections use WebSocket hibernation, so a quiet room costs almost nothing.

## Run it locally

For tests, `relay/node.ts` runs the same protocol (`core.ts`) in Node. Ensemble's checks (`scripts/checks/reach.ts`) start it on `127.0.0.1` and attack it. The computer accepts `http://` only for an address on this computer; any other relay must be `https://`.
