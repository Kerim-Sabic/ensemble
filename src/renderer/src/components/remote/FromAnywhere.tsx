import { useCallback, useEffect, useState } from 'react'
import { Bell, Globe, Lock, Network } from 'lucide-react'
import type { RemoteInfo, RemoteReach } from '@shared/types'
import { api, cn } from '@/lib/util'
import { Button, Toggle } from '../ui'
import { Qr } from './RemoteSection'

const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const day = (ts: number): string => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] bg-surface-2 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <span className="text-ink-3">{icon}</span>
        {title}
      </div>
      <div className="mt-1.5 text-[12.5px] leading-snug text-ink-2">{children}</div>
    </div>
  )
}

/**
 * Settings, "Phone and remote", "From anywhere": two ways to reach Ensemble when the phone is not
 * on this Wi-Fi (a private network, or a relay of one's own), and notifications.
 */
export function FromAnywhere({ info, onInfo }: { info: RemoteInfo; onInfo(i: RemoteInfo): void }) {
  const [reach, setReach] = useState<RemoteReach | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)

  const read = useCallback(() => void api.remoteReach().then((r) => setReach(r), () => undefined), [])
  useEffect(() => {
    read()
    const t = setInterval(read, 8000)
    const c = setInterval(() => tick((n) => n + 1), 1000)
    return () => {
      clearInterval(t)
      clearInterval(c)
    }
  }, [read])
  useEffect(() => {
    if (reach && !url) setUrl(reach.relay.url)
  }, [reach, url])

  const set = async (patch: Parameters<typeof api.remoteReachSet>[0]): Promise<void> => {
    setBusy(true)
    try {
      setReach(await api.remoteReachSet(patch))
    } finally {
      setBusy(false)
    }
  }

  if (!reach) return null
  const ts = reach.tailscale
  const pairing = info.pairing && info.pairing.expiresAt > Date.now() ? info.pairing : null
  const link = pairing ? reach.relay.link : null

  return (
    <div className="mt-4">
      <div className="text-[12px] font-medium text-ink-3">From anywhere</div>
      <div className="mt-1 text-[12px] leading-snug text-ink-3">For when your phone is not on this Wi-Fi. Choose one of two ways. Ensemble has to be running on this computer either way.</div>

      <div className="mt-2.5 space-y-2.5">
        <Card icon={<Network className="size-4" strokeWidth={1.75} />} title="A private network (Tailscale)">
          {!ts.installed ? (
            <>
              Tailscale links your own devices in a private network, free for personal use. Nothing is opened to the internet.{' '}
              <button className="font-medium text-ink underline decoration-line underline-offset-2" onClick={() => void api.openExternal('https://tailscale.com/download')}>
                Get Tailscale
              </button>
            </>
          ) : !ts.running ? (
            <>Tailscale is installed on this computer but not connected. Open it and sign in, then come back here.</>
          ) : (
            <div className="flex items-start gap-3.5">
              {ts.url && <Qr text={ts.url} size={104} />}
              <div className="min-w-0 flex-1">
                <div>
                  Connected as <span className="selectable font-medium text-ink">{ts.name}</span>.
                </div>
                <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
                  <li>On the iPhone, install Tailscale and sign in with the same account.</li>
                  <li>
                    Scan this, or open <span className="selectable font-medium text-ink">{ts.url?.replace('http://', '')}</span>, and pair with a code as on Wi-Fi.
                  </li>
                </ol>
              </div>
            </div>
          )}
          {ts.running && (
            <div className="mt-2.5 border-t border-line pt-2.5">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                <Lock className="size-3.5 text-ink-3" strokeWidth={1.75} /> HTTPS, for the Home Screen app and notifications
              </div>
              {reach.https.cert ? (
                <div className="mt-1 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    {reach.https.url ? <span className="selectable font-medium text-ink">{reach.https.url.replace('https://', '')}</span> : 'Certificate ready.'} Valid until {day(reach.https.cert.expires)}; renewed before then while this is on.
                  </div>
                  <Toggle checked={reach.https.on} onChange={(on) => void set({ https: on })} label="Use HTTPS" />
                </div>
              ) : (
                <>
                  <div className="mt-1">
                    Getting a certificate publishes this computer’s name, <span className="font-medium text-ink">{ts.name}</span>, in a public log of certificates. Anyone can see that the name exists, not what runs on it.
                    {!ts.httpsReady && ' First turn on MagicDNS and HTTPS Certificates in the Tailscale admin console.'}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    disabled={busy || !ts.httpsReady}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        setReach(await api.remoteTailscaleCert())
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    {busy ? 'Getting the certificate…' : 'Get the HTTPS certificate'}
                  </Button>
                </>
              )}
              {reach.certError && <div className="mt-1.5 text-[12px] text-bad">{reach.certError}</div>}
            </div>
          )}
        </Card>

        <Card icon={<Globe className="size-4" strokeWidth={1.75} />} title="A relay of your own">
          <div>
            Scan once and it works anywhere. Everything between the phone and this computer is encrypted end to end: the relay passes it on without being able to read or change it. The relay also sends the phone its page, so it must be your own, on your
            Cloudflare account (free). The steps are in relay/README.md.
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://ensemble-relay.your-name.workers.dev"
              spellCheck={false}
              aria-label="Relay address"
              className="min-w-0 flex-1 rounded-[8px] border border-line-2 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:border-ink-3"
            />
            <Button size="sm" variant="secondary" disabled={busy || url.trim() === reach.relay.url} onClick={() => void set({ relayUrl: url })}>
              Save
            </Button>
            <Toggle checked={reach.relay.on} onChange={(on) => void set({ relayOn: on })} label="Use the relay" />
          </div>
          <div className={cn('mt-1.5 text-[12px]', reach.relay.error && reach.relay.on ? 'text-bad' : 'text-ink-3')}>
            {!reach.relay.url ? 'No relay yet. Nothing connects anywhere until you enter one and turn it on.' : !reach.relay.on ? 'Off. Nothing connects to the relay.' : reach.relay.connected ? 'Connected to the relay.' : reach.relay.error || 'Connecting…'}
          </div>
          {reach.relay.on && reach.relay.connected && (
            <div className="mt-2.5 flex items-start gap-3.5">
              {link ? <Qr text={link} size={104} /> : null}
              <div className="min-w-0 flex-1">
                {link ? (
                  <>
                    <div className="font-medium text-ink">Scan this with the iPhone’s camera</div>
                    <div className="mt-0.5">It pairs the phone through the relay. Works once, for {clock((pairing?.expiresAt || 0) - Date.now())} more.</div>
                  </>
                ) : (
                  <div>Pair a phone through the relay with a code that works once, for five minutes.</div>
                )}
                <Button size="sm" variant={link ? 'secondary' : 'primary'} className="mt-2" onClick={() => void api.remotePair().then((i) => (onInfo(i), read()), () => undefined)}>
                  {link ? 'New code' : 'Show a pairing code'}
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card icon={<Bell className="size-4" strokeWidth={1.75} />} title="Notifications on the phone">
          <div>Short and private: they say only that something happened, never what a chat is about. On the iPhone, open Ensemble from the Home Screen (over HTTPS), then tap Turn on notifications.</div>
          <div className="mt-2 divide-y divide-line">
            {(
              [
                ['needs', 'When something needs your answer'],
                ['goals', 'When a goal finishes'],
                ['found', 'When a watch finds something'],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                <span>{label}</span>
                <Toggle checked={reach.push[k]} onChange={(on) => void set({ push: { [k]: on } })} label={label} />
              </div>
            ))}
          </div>
          <div className="mt-1 text-[12px] text-ink-3">{reach.push.phones ? `${reach.push.phones} ${reach.push.phones === 1 ? 'phone gets' : 'phones get'} notifications.` : 'No phone has turned them on yet.'}</div>
        </Card>
      </div>
    </div>
  )
}
