import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import { Smartphone } from 'lucide-react'
import type { RemoteInfo } from '@shared/types'
import { useStore } from '@/store'
import { api, cn, relative } from '@/lib/util'
import { Button, Row, Toggle } from '../ui'
import { FromAnywhere } from './FromAnywhere'

/** The link as a QR code, drawn as one SVG path. Black on white in both themes, so every camera reads it. */
export function Qr({ text, size = 132 }: { text: string; size?: number }) {
  const { d, n } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    let path = ''
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`
    return { d: path, n: count }
  }, [text])
  return (
    <svg width={size} height={size} viewBox={`-2 -2 ${n + 4} ${n + 4}`} shapeRendering="crispEdges" role="img" aria-label="QR code to open Ensemble on your phone" className="shrink-0 rounded-[10px] bg-white">
      <path d={d} fill="#000" />
    </svg>
  )
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Settings, "Phone and remote": turn it on, pair a phone with a code, see and remove paired devices. */
export function RemoteSection() {
  const on = useStore((s) => s.settings.remote === true)
  const run = useStore((s) => s.run)
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [pick, setPick] = useState(0)
  const [, tick] = useState(0)

  // While it is on, what is shown is read again every two seconds: a phone pairing, a device coming and going.
  useEffect(() => {
    let alive = true
    const read = (): void => void api.remoteInfo().then((i) => alive && setInfo(i), () => undefined)
    read()
    if (!on) return () => void (alive = false)
    const t = setInterval(read, 2000)
    const c = setInterval(() => tick((n) => n + 1), 1000)
    return () => {
      alive = false
      clearInterval(t)
      clearInterval(c)
    }
  }, [on])

  const listening = on && !!info?.listening
  const addresses = info?.addresses || []
  const address = addresses[Math.min(pick, Math.max(0, addresses.length - 1))]
  const pairing = info?.pairing && info.pairing.expiresAt > Date.now() ? info.pairing : null
  const link = address && pairing ? `${address.url}/#${pairing.code.replace('-', '')}` : ''

  return (
    <>
      <div className="mt-5 mb-1 text-[12px] font-medium text-ink-3">Phone and remote</div>
      <div className="divide-y divide-line">
        <Row label="Use Ensemble from your phone" hint="Follow the team, send messages, stop it, and answer approvals and questions from a phone you have paired. Off until you turn it on.">
          <Toggle checked={on} onChange={(remote) => void run(api.updateSettings({ remote }))} label="Use Ensemble from your phone" />
        </Row>

        {on && info && !info.listening && (
          <div className="py-3 text-[12px] leading-snug text-bad">Could not start{info.error ? `: ${info.error}` : '.'} Turn it off and on again, or restart Ensemble.</div>
        )}

        {listening && (
          <div className="py-3">
            <div className="flex items-start gap-4">
              {pairing && link ? (
                <Qr text={link} />
              ) : (
                <div className="grid size-[132px] shrink-0 place-items-center rounded-[10px] bg-surface-2 text-ink-4">
                  <Smartphone className="size-9" strokeWidth={1.5} />
                </div>
              )}
              <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">
                {pairing ? (
                  <>
                    <div className="text-[13px] font-medium text-ink">Scan this with your phone's camera</div>
                    <div className="mt-1">
                      Or open <span className="selectable font-medium text-ink">{address?.url.replace('http://', '')}</span> on the phone and type this code:
                    </div>
                    <div className="selectable mt-2 font-mono text-[20px] font-semibold tracking-[0.12em] text-ink">{pairing.code}</div>
                    <div className="mt-1 text-[12px] text-ink-3">Works once, for {clock(pairing.expiresAt - Date.now())} more.</div>
                  </>
                ) : (
                  <>
                    <div className="text-[13px] font-medium text-ink">Pair a phone</div>
                    <div className="mt-1">You get a code that works once, for five minutes. The phone keeps its own key after that, and you can remove it here at any time.</div>
                  </>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant={pairing ? 'secondary' : 'primary'} onClick={() => void api.remotePair().then(setInfo, () => undefined)}>
                    {pairing ? 'New code' : 'Show a pairing code'}
                  </Button>
                  {addresses.length > 1 &&
                    addresses.map((a, i) => (
                      <button key={a.url} onClick={() => setPick(i)} className={cn('rounded-full px-2.5 py-1 text-[11.5px] font-medium', a === address ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink')}>
                        {a.kind === 'private' ? 'Private network' : a.kind === 'this' ? 'This computer' : 'Wi-Fi'} · {a.url.replace('http://', '').replace(/:\d+$/, '')}
                      </button>
                    ))}
                </div>
              </div>
            </div>

            <div className="mt-4 text-[12px] font-medium text-ink-3">Paired devices</div>
            {info?.devices.length ? (
              <div className="mt-1 divide-y divide-line">
                {info.devices.map((d) => (
                  <div key={d.id} className="flex items-center gap-3 py-2">
                    <Smartphone className="size-4 shrink-0 text-ink-3" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{d.name}</div>
                      <div className="text-[12px] text-ink-3">
                        {d.online ? 'Connected now' : `Last seen ${relative(d.lastSeen)}${relative(d.lastSeen) === 'now' ? '' : ' ago'}`}
                        {d.via === 'relay' ? ' · through the relay' : ''}
                        {d.notifications ? ' · notifications on' : ''}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => void api.remoteRemove(d.id).then(setInfo, () => undefined)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-1 text-[12px] text-ink-3">None yet.</div>
            )}

            {info && <FromAnywhere info={info} onInfo={setInfo} />}

            <div className="mt-3 rounded-[10px] bg-surface-2 px-3 py-2.5 text-[12px] leading-snug text-ink-3">
              It works while the phone can reach this computer: on the same Wi-Fi, or from anywhere over Tailscale or through your own relay (above). Over plain Wi-Fi the connection is not encrypted, so do not use it on a network you do not trust; through the relay it is encrypted end to end. Ensemble has to be running. A paired phone
              can read chats, message the lead, stop the team, answer approvals and questions, pick up work that was cut short, and start a chat in a folder that already has one. It cannot change accounts, settings, permission levels or computer control. Windows may ask once whether Ensemble may be reached on private networks.
            </div>
          </div>
        )}
      </div>
    </>
  )
}
