// "From anywhere", way 1: a private network (Tailscale) between this computer and the phone.
// Nothing here signs in, installs, registers or publishes. It reads `tailscale status --json` to say
// whether Tailscale is there and connected, and runs `tailscale cert` only when the user presses the
// button for it (the machine's name then appears in a public certificate log; the settings say so
// first), or renews that certificate when the user has turned HTTPS on.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'

export interface TailscaleStatus {
  installed: boolean
  /** Signed in and connected. */
  running: boolean
  /** "Running", "Stopped", "NeedsLogin", ... as Tailscale says it. */
  state?: string
  /** This machine's full name on the private network, without the final dot (kerim-pc.tail1234.ts.net). */
  dnsName?: string
  /** Its addresses on the private network (100.x.y.z first). */
  ips: string[]
  /** Names Tailscale can issue a certificate for: empty until HTTPS is enabled for the network. */
  certDomains: string[]
  error?: string
}

/** What `tailscale status --json` says, in the parts that matter here. */
export function parseStatus(raw: unknown): Omit<TailscaleStatus, 'installed'> {
  const j = raw as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }; CertDomains?: string[] | null }
  if (!j || typeof j !== 'object') return { running: false, ips: [], certDomains: [], error: 'Tailscale gave an answer that could not be read.' }
  const state = typeof j.BackendState === 'string' ? j.BackendState : undefined
  const dns = typeof j.Self?.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : ''
  const ips = (Array.isArray(j.Self?.TailscaleIPs) ? j.Self.TailscaleIPs : []).filter((x) => typeof x === 'string').sort((a, b) => Number(b.includes('.')) - Number(a.includes('.')))
  const certDomains = (Array.isArray(j.CertDomains) ? j.CertDomains : []).filter((x) => typeof x === 'string')
  return { running: state === 'Running', state, dnsName: dns || undefined, ips, certDomains }
}

export type Runner = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

/** Where the Tailscale program is on this computer, or null. */
export function findTailscale(): string | null {
  const places =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
        : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale']
  return places.find((p) => fs.existsSync(p)) || null
}

export class Tailscale {
  /** Every command run, for the checks (which also prove `cert` never runs unless asked). */
  calls: string[][] = []

  constructor(
    private o: {
      /** Runs the Tailscale program; checks pass recorded answers instead. Null: not installed. */
      run?: Runner | null
      /** Where the certificate is kept (the app's data folder). */
      dir: string
      /** Seals the certificate's private key at rest (Windows credential encryption in the app). */
      sealer?: { seal(s: string): string; open(s: string): string }
    },
  ) {}

  private runner(): Runner | null {
    if (this.o.run !== undefined) return this.o.run
    const exe = findTailscale()
    if (!exe) return null
    return (args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code?: unknown }).code) : 1) : 0
          resolve({ code, stdout: String(stdout), stderr: String(stderr) })
        })
      })
  }

  private async exec(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string } | null> {
    const run = this.runner()
    if (!run) return null
    this.calls.push(args)
    return run(args, timeoutMs)
  }

  /** Read only. */
  async status(): Promise<TailscaleStatus> {
    const r = await this.exec(['status', '--json'], 8_000)
    if (!r) return { installed: false, running: false, ips: [], certDomains: [] }
    try {
      return { installed: true, ...parseStatus(JSON.parse(r.stdout)) }
    } catch {
      // Installed but stopped: the command fails or prints plain words.
      return { installed: true, running: false, ips: [], certDomains: [], state: 'Stopped' }
    }
  }

  get certFile(): string {
    return path.join(this.o.dir, 'tailscale', 'phone.crt')
  }

  /** Where `tailscale cert` writes the private key; it is sealed into `sealedKeyFile` and removed at once. */
  get keyFile(): string {
    return path.join(this.o.dir, 'tailscale', 'phone.key')
  }

  get sealedKeyFile(): string {
    return path.join(this.o.dir, 'tailscale', 'phone.key.sealed')
  }

  /** Seals a key `tailscale cert` just wrote, and deletes the plain one. */
  private sealKey(): void {
    try {
      const plain = fs.readFileSync(this.keyFile, 'utf8')
      fs.writeFileSync(this.sealedKeyFile, this.o.sealer ? this.o.sealer.seal(plain) : plain)
      fs.rmSync(this.keyFile, { force: true })
    } catch {
      /* nothing to seal */
    }
  }

  /** The certificate's private key, opened into memory only; null when there is none or it cannot be opened. */
  readKey(): Buffer | null {
    if (fs.existsSync(this.keyFile)) this.sealKey()
    try {
      const sealed = fs.readFileSync(this.sealedKeyFile, 'utf8')
      return Buffer.from(this.o.sealer ? this.o.sealer.open(sealed) : sealed, 'utf8')
    } catch {
      return null
    }
  }

  /** The certificate on disk: its name and when it runs out, or null. */
  certInfo(): { name: string; expires: number } | null {
    try {
      const x = new X509Certificate(fs.readFileSync(this.certFile))
      const name = /DNS:([^,\s]+)/.exec(x.subjectAltName || '')?.[1] || x.subject
      return { name, expires: Date.parse(x.validTo) }
    } catch {
      return null
    }
  }

  /**
   * Gets (or renews) the HTTPS certificate for this machine's name from Tailscale. Only ever called
   * from the user's own action, or for renewal after the user turned HTTPS on.
   */
  async cert(): Promise<{ ok: true; name: string; expires: number } | { ok: false; error: string }> {
    const st = await this.status()
    if (!st.installed) return { ok: false, error: 'Tailscale is not installed on this computer.' }
    if (!st.running || !st.dnsName) return { ok: false, error: 'Tailscale is not connected on this computer.' }
    if (!st.certDomains.includes(st.dnsName)) return { ok: false, error: 'HTTPS is not enabled for your Tailscale network yet. Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console, then try again.' }
    fs.mkdirSync(path.dirname(this.certFile), { recursive: true })
    const r = await this.exec(['cert', '--cert-file', this.certFile, '--key-file', this.keyFile, st.dnsName], 120_000)
    if (!r || r.code !== 0) return { ok: false, error: (r?.stderr || r?.stdout || 'Tailscale could not issue the certificate.').trim().slice(0, 300) }
    // The private key does not stay on disk in the clear.
    this.sealKey()
    const info = this.certInfo()
    return info ? { ok: true, ...info } : { ok: false, error: 'The certificate could not be read after it was issued.' }
  }
}
