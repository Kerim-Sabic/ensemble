// Dev-only: checks that Ensemble can start the sign-in with online connectors, without signing in.
// For each address it registers Ensemble with the service and gets as far as the sign-in page, then stops.
//   node scripts/oauth-check.mjs https://mcp.linear.app/mcp https://mcp.cloudflare.com/mcp
import { signIn, cancelSignIn, type OAuthState } from '../src/main/connector-auth'

const urls = process.argv.slice(2)
for (const url of urls) {
  let st: OAuthState = {}
  let page = ''
  const run = signIn(url, st, (next) => (st = next), (u) => {
    page = u
    setTimeout(cancelSignIn, 50)
  })
  try {
    await run
    console.log(url, '-> signed in without a page?')
  } catch (e) {
    const host = page ? new URL(page).host : ''
    const ok = !!page && !!st.client && !!st.verifier
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${url}\n     sign-in page: ${host || '(none)'} · registered: ${!!st.client} · ${ok ? 'stopped before signing in' : (e as Error).message}`)
  }
}
