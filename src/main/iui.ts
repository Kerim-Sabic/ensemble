// Live answers (code name iui), the main-process side: the locked box mini apps run in, and the words every
// agent is given about interactive answers.
//
// A mini app is HTML an agent wrote, so it is treated as hostile. The window hands it here and
// gets back an address on a protocol of our own. That protocol serves it with a content policy
// that allows its own inline script and style and nothing else: no network, no files, no other
// origin, no frames, no forms that go anywhere. The window shows it in a frame sandboxed with
// scripts only, so it has an opaque origin and cannot reach the app, navigate the window or open
// popups. The window's own policy lets a frame load this protocol and nothing else, and WebRTC (which no content policy
// covers) is cut off both in the page and for the window.
import { ipcMain, protocol, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { APP_LIMITS, isWholePage } from '@shared/iui'

export const IUI_SCHEME = 'ensemble-app'

/** Goes in the one registerSchemesAsPrivileged call, before the app is ready. */
export const IUI_PRIVILEGES = { scheme: IUI_SCHEME, privileges: { standard: true, secure: true } }

/** The whole policy of a mini app. Nothing may be loaded from anywhere. */
export const APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"

const pages = new Map<string, string>()
const MAX_PAGES = 120

const TOKEN_KEY = /^--[a-z0-9-]{1,32}$/
const TOKEN_VALUE = /^[#a-zA-Z0-9\s(),.%\-'"]{1,120}$/

/** Theme values from the window, kept to what a colour or font name can look like. */
function cleanTokens(theme: unknown): string {
  if (!theme || typeof theme !== 'object') return ''
  const out: string[] = []
  for (const [k, v] of Object.entries(theme as Record<string, unknown>).slice(0, 40)) {
    if (typeof v !== 'string' || !TOKEN_KEY.test(k) || !TOKEN_VALUE.test(v.trim()) || /<|\/|;|\{|\}/.test(v)) continue
    out.push(`${k}:${v.trim()}`)
  }
  return out.join(';')
}

// Runs before anything the agent wrote. Gives the page the bridge, keeps its height in step with
// its content, reports errors to the frame's title bar, and takes away WebRTC.
const PRELUDE = `(() => {
  const post = (m) => { try { parent.postMessage(Object.assign({ __iui: 1 }, m), '*') } catch (e) {} };
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }) } catch (e) {}
  }
  let fixed = 0;
  const api = {
    resize(h) { const n = Math.round(Number(h)); if (n > 0) { fixed = n; post({ kind: 'resize', height: n }) } },
    propose(text) { if (text != null) post({ kind: 'propose', text: String(text).slice(0, ${APP_LIMITS.propose}) }) },
    get dark() { return document.documentElement.dataset.theme === 'dark' },
  };
  Object.defineProperty(window, 'ensemble', { value: Object.freeze(api), writable: false, configurable: false });
  // The app's colours live in the first style of the page, so a page's own variables of the same
  // name (--bg, --ink are common) still win. A change of theme rewrites that style, nothing else.
  window.addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.__iui !== 1 || e.data.kind !== 'theme') return;
    const out = [];
    for (const [k, v] of Object.entries(e.data.vars || {}).slice(0, 40)) {
      if (/^--[a-z0-9-]{1,32}$/.test(k) && typeof v === 'string' && /^[#a-zA-Z0-9\\s(),.%'"-]{1,120}$/.test(v)) out.push(k + ':' + v);
    }
    const style = document.getElementById('ensemble-theme');
    if (style) style.textContent = ':root{' + out.join(';') + '}';
    document.documentElement.dataset.theme = e.data.dark ? 'dark' : 'light';
  });
  let last = 0;
  const measure = () => {
    if (fixed) return;
    // The body's own height, not the document's: the document is never shorter than the frame,
    // so measuring it would let a frame grow but never shrink to what it shows.
    const b = document.body;
    if (!b) return;
    const cs = getComputedStyle(b);
    const h = Math.ceil(Math.max(b.scrollHeight, b.getBoundingClientRect().height) + parseFloat(cs.marginTop || '0') + parseFloat(cs.marginBottom || '0'));
    if (h && Math.abs(h - last) > 1) { last = h; post({ kind: 'size', height: h }) }
  };
  addEventListener('load', () => { measure(); try { new ResizeObserver(measure).observe(document.body) } catch (e) {} });
  // A link may only move within the page. Anything else would take the frame away from the app
  // (the window refuses it anyway, leaving an empty frame), so it is stopped here, kindly.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const el = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null;
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); else if (!id) scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (/^javascript:/i.test(href)) return;
    e.preventDefault();
    post({ kind: 'note', message: 'Links do not open from a mini app' });
  }, true);
  document.addEventListener('submit', (e) => { if (!e.defaultPrevented) e.preventDefault() }, true);
  // Pictures from the web cannot load here: a quiet placeholder instead of a broken-image sign.
  const PH = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice"><rect width="640" height="400" fill="rgba(128,128,128,0.13)"/><path d="M280 236l34-40 26 30 18-20 42 50H240z" fill="rgba(128,128,128,0.32)"/><circle cx="296" cy="176" r="12" fill="rgba(128,128,128,0.32)"/></svg>');
  addEventListener('error', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG' || t.dataset.iuiPlaceholder) return;
    t.dataset.iuiPlaceholder = '1';
    t.removeAttribute('srcset');
    t.src = PH;
  }, true);
  addEventListener('error', (e) => { if (e.target === window || e.target === undefined || e.message) post({ kind: 'error', message: String(e.message || 'Script error').slice(0, 200) }) });
  addEventListener('unhandledrejection', (e) => post({ kind: 'error', message: String((e.reason && e.reason.message) || e.reason || 'Promise rejected').slice(0, 200) }));
})();`

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{color-scheme:light;font-family:var(--font);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
html[data-theme=dark]{color-scheme:dark}
body{margin:0;padding:14px;background:var(--bg);color:var(--ink);overflow-x:hidden}
button,input,select,textarea{font:inherit;color:inherit}
button{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:5px 11px;cursor:pointer}
button:hover{background:var(--hover)}
input,select,textarea{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:5px 8px}
input[type=range]{accent-color:var(--accent);padding:0;border:0;background:none}
canvas{max-width:100%}
:focus-visible{outline:2px solid color-mix(in oklab,var(--accent) 70%,transparent);outline-offset:2px}`

// Thin scrollbars like the app's, for whole pages and fragments alike.
const SCROLL_CSS = `::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:rgba(128,128,128,.38);border-radius:10px;border:3px solid transparent;background-clip:content-box}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}`

/**
 * The page a mini app is served as: our head, then whatever the agent wrote. A fragment gets the
 * app's look (font, colours, controls); a complete page keeps its own design and only gains the
 * colour variables, the bridge and the scrollbars.
 */
export function appPage(html: string, theme: unknown, dark: boolean): string {
  const body = html.slice(0, APP_LIMITS.html)
  const whole = isWholePage(body)
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><style id="ensemble-theme">:root{${cleanTokens(theme)}}</style><style>${SCROLL_CSS}${whole ? '' : `\n${BASE_CSS}`}</style><script>${PRELUDE}</script>`
  const attrs = `data-theme="${dark ? 'dark' : 'light'}"`
  const mark = (m: string): string => (/data-theme/.test(m) ? m : m.replace(/>$/, ` ${attrs}>`))
  // A whole document gets our head put inside its own, before anything it loads.
  if (/<head[\s>]/i.test(body)) return body.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${head}`).replace(/<html(\s[^>]*)?>/i, mark)
  if (/<html[\s>]/i.test(body)) return body.replace(/<html(\s[^>]*)?>/i, (m) => `${mark(m)}<head>${head}</head>`)
  if (/<body[\s>]/i.test(body)) return `<!doctype html><html ${attrs}><head>${head}</head>${body.replace(/<!doctype[^>]*>/i, '')}</html>`
  return `<!doctype html><html ${attrs}><head>${head}</head><body>${body}</body></html>`
}

/** Keep a mini app's page and return the address it can be loaded from. */
export function holdApp(req: unknown): string {
  const r = (req && typeof req === 'object' ? req : {}) as { html?: unknown; theme?: unknown; dark?: unknown }
  if (typeof r.html !== 'string' || !r.html.trim()) throw new Error('A mini app needs HTML')
  const id = randomBytes(12).toString('hex')
  pages.set(id, appPage(r.html, r.theme, r.dark === true))
  while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value as string)
  return `${IUI_SCHEME}://${id}/`
}

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': APP_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=(), display-capture=()',
}

/** Serve the protocol and answer the window's requests. Call once, when the app is ready. */
export function registerIui(): void {
  protocol.handle(IUI_SCHEME, (req) => {
    try {
      const u = new URL(req.url)
      const page = u.pathname === '/' && req.method === 'GET' ? pages.get(u.hostname) : undefined
      if (!page) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Content-Security-Policy': APP_CSP } })
      return new Response(page, { status: 200, headers: HEADERS })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  ipcMain.handle('iui-app', (_e, req: unknown) => holdApp(req))
}

/**
 * What the window itself adds. A mini app moving its own frame elsewhere (a link, a location
 * change) is refused by the window's content policy, whose frame-src allows this protocol only
 * (checked: ERR_BLOCKED_BY_CSP, no request is made); form posts, popups and moving the window are
 * refused by the sandbox. WebRTC is the one way out no content policy covers: the page loses it
 * in the prelude, and here the window may not use UDP that bypasses a proxy, which is what a
 * peer connection to an outside server needs. Ensemble itself uses no WebRTC.
 */
export function guardFrames(contents: WebContents): void {
  try {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  } catch {
    /* not every build has it */
  }
}

/** What every agent is told about interactive answers. The lead's prompts add it to each briefing. */
export const IUI_BRIEFING = `## Charts, forms and small apps in a reply

In replies to the user, two kinds of fenced block are drawn live instead of shown as code: \`ui\` and \`app\`. Reach for them on these triggers, instead of what you would otherwise write:
- Comparing options (apps, plans, tools, approaches): a \`compare\` block instead of a comparison table. One option each, short pros and cons, your pick marked "pick": true.
- Figures across categories or over time: a \`chart\` (line over time, bar across categories).
- You need answers from the user before you can go on: a \`form\`, one field per question, instead of a numbered list of questions. Just one decision between a few ways forward: \`choices\`.
- They will want to try their own numbers (a loan, a budget, a price): \`calc\`.
- Headline figures: \`stats\`. A plan or progress: \`steps\`. How parts connect: \`diagram\`.
- Anything else interactive (a game, a tool): an \`app\` fence.

Rules: ordinary answers stay ordinary text. Say the takeaway in words as well. Only real data: never make up numbers to fill a chart. At most one or two blocks. Never in reports or messages to other agents.

A \`ui\` fence holds one JSON object. Three examples:
\`\`\`ui
{"type":"chart","kind":"line","title":"Revenue by quarter ($k)","x":["Q1","Q2","Q3"],"series":[{"name":"Revenue","data":[40,52,61]}]}
\`\`\`
\`\`\`ui
{"type":"compare","options":[{"name":"Plan A","pros":["$5 a month"],"cons":["No offline use"]},{"name":"Plan B","pros":["Works offline"],"cons":["$9 a month"],"pick":true}]}
\`\`\`
\`\`\`ui
{"type":"form","fields":[{"name":"size","label":"Team size","type":"number","required":true},{"name":"budget","label":"Budget per person","type":"select","options":["Under $5","$5 to $15","More"]}]}
\`\`\`
Fields (? means optional):
- compare: options [{name, summary?, pros?, cons?, score?, pick?}]
- chart: kind bar|line|area|pie|scatter, x [labels], series [{name, data [numbers]}], unit?, stacked?
- form: fields [{name, label, type: text|textarea|number|select|checkbox|date, options?, required?}], submit?. Sends the answers to you.
- choices: prompt?, options [{label, detail?}]. A click sends the choice to you.
- calc: inputs [{name, label, default, min?, max?, unit?}], outputs [{label, formula, format?: number|money|percent}]. Formulas use input names with + - * / ^ ( ), a ? b : c, min max round sqrt pow log.
- stats: items [{label, value, delta?}]; steps: items [{title, detail?, status?: done|doing|todo}]
- diagram: kind flow|tree, nodes [{id, label}], edges [{from, to}]
Percent values are written as 12.5 for 12.5%.

An \`app\` fence (\`\`\`app title="Name" height=520) holds one self-contained HTML page with inline CSS and JavaScript. No network, no outside files: draw pictures with CSS or SVG; links work only within the page. Colours: CSS variables --bg, --surface, --ink, --line, --accent. ensemble.propose(text) offers the user a message to send you; it never sends by itself.`
