import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

/**
 * Signing in to an online connector with the service's own sign-in page (MCP's OAuth flow):
 * Ensemble registers itself with the service, opens the sign-in page in the browser, catches the
 * answer on a page served from this computer, and keeps the tokens. Tokens are renewed with the
 * refresh token before they run out, so the person signs in once.
 */

/** Everything a sign-in leaves behind, kept sealed in the connector. */
export interface OAuthState {
  client?: OAuthClientInformationMixed
  /** The address the client was registered with; another address needs a new registration. */
  redirect?: string
  tokens?: OAuthTokens
  /** When the tokens were saved, to work out when they run out. */
  savedAt?: number
  verifier?: string
  discovery?: OAuthDiscoveryState
}

export class NeedsSignIn extends Error {
  constructor() {
    super('Sign in to this service again.')
  }
}

/** The fixed port first, so the registration made at the first sign-in keeps working later. */
const PORTS = [33418, 33419, 0]

class Provider implements OAuthClientProvider {
  private stateValue = crypto.randomBytes(16).toString('hex')

  constructor(
    private s: OAuthState,
    private save: (s: OAuthState) => void,
    private redirect: string,
    private onRedirect: ((url: URL) => void) | null,
  ) {}

  get redirectUrl(): string {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Ensemble',
      client_uri: 'https://github.com/Kerim-Sabic/ensemble',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.stateValue
  }

  expectedState(): string {
    return this.stateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.s.redirect === this.redirect ? this.s.client : undefined
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.s = { ...this.s, client: info, redirect: this.redirect }
    this.save(this.s)
  }

  tokens(): OAuthTokens | undefined {
    return this.s.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.s = { ...this.s, tokens, savedAt: Date.now() }
    this.save(this.s)
  }

  redirectToAuthorization(url: URL): void {
    if (!this.onRedirect) throw new NeedsSignIn()
    this.onRedirect(url)
  }

  saveCodeVerifier(v: string): void {
    this.s = { ...this.s, verifier: v }
    this.save(this.s)
  }

  codeVerifier(): string {
    if (!this.s.verifier) throw new Error('The sign-in was started somewhere else. Try again.')
    return this.s.verifier
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.s.discovery
  }

  saveDiscoveryState(d: OAuthDiscoveryState): void {
    this.s = { ...this.s, discovery: d }
    this.save(this.s)
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const next = { ...this.s }
    if (scope === 'all' || scope === 'client') delete next.client
    if (scope === 'all' || scope === 'tokens') delete next.tokens
    if (scope === 'all' || scope === 'verifier') delete next.verifier
    if (scope === 'all' || scope === 'discovery') delete next.discovery
    this.s = next
    this.save(this.s)
  }
}

/** How long the access token has left, in ms; Infinity when the service did not say. */
export function timeLeft(s: OAuthState): number {
  if (!s.tokens?.access_token) return 0
  if (!s.tokens.expires_in || !s.savedAt) return Infinity
  return s.savedAt + s.tokens.expires_in * 1000 - Date.now()
}

/** Renews the access token if it runs out within `margin`. Throws NeedsSignIn when only a new sign-in will do. */
export async function renew(url: string, s: OAuthState, save: (s: OAuthState) => void, margin = 10 * 60e3): Promise<boolean> {
  if (!s.tokens) throw new NeedsSignIn()
  if (timeLeft(s) > margin) return false
  if (!s.tokens.refresh_token || !s.redirect) throw new NeedsSignIn()
  const p = new Provider(s, save, s.redirect, null)
  const r = await auth(p, { serverUrl: url })
  if (r !== 'AUTHORIZED') throw new NeedsSignIn()
  return true
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px/1.5 system-ui,'Segoe UI',sans-serif;background:#f4f2ee;color:#1b1a17;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><div style="font-size:22px;font-weight:600;margin-bottom:6px">${title}</div><div style="color:#5c5a54">${text}</div></div>`

let active: { cancel(): void } | null = null

/**
 * The whole sign-in: opens the service's page with `open`, waits for the answer (five minutes at most),
 * and leaves fresh tokens in the state through `save`.
 */
export async function signIn(url: string, s: OAuthState, save: (s: OAuthState) => void, open: (url: string) => void): Promise<void> {
  active?.cancel()
  const server = http.createServer()
  let port = 0
  for (const p of PORTS) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(p, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      port = (server.address() as AddressInfo).port
      break
    } catch {
      /* taken: try the next */
    }
  }
  if (!port) throw new Error('Could not open a local page to finish signing in.')
  const redirect = `http://127.0.0.1:${port}/callback`
  const keep = (next: OAuthState): void => {
    state = next
    save(next)
  }
  // A sign-in asked for by the person always starts over, keeping only the registration.
  let state: OAuthState = { client: s.client, redirect: s.redirect, discovery: s.discovery }
  const provider = new Provider(state, keep, redirect, (u) => open(u.toString()))

  let settle: { ok(code: string): void; fail(e: Error): void } = { ok: () => undefined, fail: () => undefined }
  const answer = new Promise<string>((ok, fail) => (settle = { ok, fail }))
  server.on('request', (req, res) => {
    const u = new URL(req.url || '/', redirect)
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const err = u.searchParams.get('error')
    const code = u.searchParams.get('code')
    const okState = u.searchParams.get('state') === provider.expectedState()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (err || !code || !okState) {
      res.end(PAGE('Sign-in did not finish', 'You can close this tab and try again in Ensemble.'))
      settle.fail(new Error(err ? `The service said: ${u.searchParams.get('error_description') || err}` : 'The sign-in page sent back an answer Ensemble did not ask for.'))
    } else {
      res.end(PAGE('Signed in', 'You can close this tab and go back to Ensemble.'))
      settle.ok(code)
    }
  })
  const timer = setTimeout(() => settle.fail(new Error('The sign-in was not finished within five minutes.')), 5 * 60e3)
  active = { cancel: () => settle.fail(new Error('Sign-in cancelled.')) }
  try {
    const first = await auth(provider, { serverUrl: url })
    if (first === 'AUTHORIZED') return
    const code = await answer
    await auth(new Provider(state, keep, redirect, null), { serverUrl: url, authorizationCode: code })
  } finally {
    clearTimeout(timer)
    active = null
    server.close()
  }
}

export function cancelSignIn(): void {
  active?.cancel()
}
