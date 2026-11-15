import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChangedFile, FolderChanges, PermissionLevel, RewindPreview } from '@shared/types'
import { uid } from '../util'
import { toolText, type AgentRuntime, type RuntimeEvent, type RuntimeOptions, type TurnInput } from './types'

// A scripted stand-in for a real agent. It drives the real hub (tasks, messages,
// approvals) so the interface can be exercised without using anyone's allowance.
// Only used when the app is started with ENSEMBLE_DEMO=1.

const SPEED = Number(process.env.ENSEMBLE_DEMO_SPEED || '1')
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / SPEED))

type Step = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }

const PLAN: Step[] = [
  { content: 'Look at how the project is set up', status: 'pending', activeForm: 'Looking at the project' },
  { content: 'Build the pricing page', status: 'pending', activeForm: 'Building the pricing page' },
  { content: 'Add the checkout endpoint and webhook', status: 'pending', activeForm: 'Adding the checkout endpoint' },
  { content: 'Create the hero illustration', status: 'pending', activeForm: 'Creating the hero illustration' },
  { content: 'Have the checkout reviewed by someone who did not write it', status: 'pending', activeForm: 'Having the checkout reviewed' },
  { content: 'Check that everything works together', status: 'pending', activeForm: 'Checking everything together' },
]

/** The page the demo team "built", so its browser has something real to open and click. */
const DEMO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pricing · Storefront</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 'Segoe UI',system-ui,sans-serif;color:#1b1a17;background:linear-gradient(180deg,#f4f1ea,#fbfaf7 420px)}
nav{display:flex;align-items:center;gap:28px;padding:20px 56px;font-size:14px;color:#5c5a54}nav b{font-size:17px;color:#1b1a17;margin-right:auto;letter-spacing:-.01em}nav a{color:inherit;text-decoration:none}
nav .cta{padding:8px 16px;border-radius:999px;background:#1b1a17;color:#fff}
header{text-align:center;padding:54px 24px 8px}h1{font-size:46px;letter-spacing:-.035em;margin:0 0 10px;line-height:1.1}header p{margin:0;color:#5c5a54;font-size:17px}
.toggle{display:inline-flex;margin:30px auto 0;padding:4px;border-radius:999px;background:#e9e5dc}.toggle button{border:0;background:transparent;padding:8px 20px;border-radius:999px;font:inherit;font-size:14px;color:#5c5a54;cursor:pointer}
.toggle button[aria-pressed=true]{background:#fff;color:#1b1a17;box-shadow:0 1px 3px rgba(0,0,0,.14)}.save{margin-left:6px;font-size:12px;color:#1c9a55;font-weight:600}
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;max-width:1040px;margin:38px auto 0;padding:0 28px}
.tier{background:#fff;border-radius:22px;padding:28px;box-shadow:0 0 0 1px rgba(24,20,12,.08),0 14px 34px -18px rgba(24,20,12,.25)}
.tier.pop{box-shadow:0 0 0 2px #de5b36,0 22px 44px -18px rgba(222,91,54,.45)}.tier h2{margin:0;font-size:18px}.tier .for{color:#8f8c85;font-size:14px;margin:2px 0 18px}
.price{font-size:44px;font-weight:650;letter-spacing:-.03em}.price small{font-size:15px;font-weight:400;color:#8f8c85;letter-spacing:0}
ul{list-style:none;padding:0;margin:18px 0 24px;font-size:14.5px;color:#3d3b36}li{padding:5px 0}li::before{content:'✓';color:#1c9a55;font-weight:700;margin-right:10px}
.tier a{display:block;text-align:center;padding:11px;border-radius:12px;background:#f1eee7;color:#1b1a17;text-decoration:none;font-weight:600;font-size:14.5px}.tier.pop a{background:#de5b36;color:#fff}
.badge{float:right;font-size:11.5px;font-weight:600;color:#de5b36;background:#fdebe4;padding:3px 9px;border-radius:999px}
</style></head><body>
<nav><b>Storefront</b><a href="#">Product</a><a href="#">Customers</a><a href="#">Pricing</a><a class="cta" href="#">Start free</a></nav>
<header><h1>Simple pricing that grows with you</h1><p>Start free. Upgrade when your team does.</p>
<div class="toggle" role="group" aria-label="Billing period"><button id="m" aria-pressed="true">Monthly</button><button id="a" aria-pressed="false">Annual<span class="save">save 20%</span></button></div></header>
<section class="tiers">
<div class="tier"><h2>Starter</h2><div class="for">For trying things out</div><div class="price" data-m="0" data-a="0">$0<small> / month</small></div><ul><li>1 project</li><li>Community support</li><li>Basic analytics</li></ul><a href="#">Start free</a></div>
<div class="tier pop"><span class="badge">Most popular</span><h2>Team</h2><div class="for">For growing teams</div><div class="price" data-m="29" data-a="23">$29<small> / month</small></div><ul><li>Unlimited projects</li><li>Priority support</li><li>Advanced analytics</li><li>Team roles</li></ul><a href="#">Choose Team</a></div>
<div class="tier"><h2>Scale</h2><div class="for">For larger organisations</div><div class="price" data-m="99" data-a="79">$99<small> / month</small></div><ul><li>Everything in Team</li><li>Single sign-on</li><li>Audit log</li><li>Dedicated manager</li></ul><a href="#">Talk to sales</a></div>
</section>
<script>var m=document.getElementById('m'),a=document.getElementById('a');function set(y){m.setAttribute('aria-pressed',String(!y));a.setAttribute('aria-pressed',String(y));document.querySelectorAll('.price').forEach(function(p){p.firstChild.nodeValue='$'+p.dataset[y?'a':'m']})}m.onclick=function(){set(false)};a.onclick=function(){set(true)}</script>
</body></html>`

/** A short tone as a WAV file, standing in for a voice sample. */
function tone(file: string, freq: number, secs = 1.6): void {
  const rate = 22050
  const n = Math.floor(rate * secs)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 800, (n - i) / 800)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 11000 * env), 44 + i * 2)
  }
  fs.writeFileSync(file, buf)
}

function demoPage(): string {
  const file = path.join(os.tmpdir(), 'ensemble-demo-site', 'pricing.html')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, DEMO_PAGE, 'utf8')
  } catch {
    /* the demo just skips its look at the page */
  }
  return file
}

/** What the demo team "changed", for the Changes list. */
const DEMO_FILES: ChangedFile[] = [
  { path: 'src/pages/Pricing.tsx', status: 'untracked', added: 96, removed: 0 },
  { path: 'src/api/checkout.ts', status: 'untracked', added: 58, removed: 0 },
  { path: 'src/api/checkout.test.ts', status: 'untracked', added: 41, removed: 0 },
  { path: 'src/routes.tsx', status: 'modified', added: 3, removed: 1 },
  { path: 'public/hero.png', status: 'untracked' },
]

export function demoChanges(touched: number): FolderChanges {
  return { repo: true, branch: 'feature/pricing', files: touched ? DEMO_FILES.slice(0, Math.min(DEMO_FILES.length, touched + 1)) : [] }
}

export function demoDiff(rel: string): string {
  if (rel.endsWith('routes.tsx')) {
    return [
      'diff --git a/src/routes.tsx b/src/routes.tsx',
      '--- a/src/routes.tsx',
      '+++ b/src/routes.tsx',
      '@@ -1,12 +1,14 @@ import { createBrowserRouter } from "react-router"',
      " import { Account } from './pages/Account'",
      " import { Home } from './pages/Home'",
      "+import { Pricing } from './pages/Pricing'",
      ' ',
      ' export const router = createBrowserRouter([',
      "   { path: '/', element: <Home /> },",
      "-  { path: '/account', element: <Account /> }",
      "+  { path: '/account', element: <Account /> },",
      "+  { path: '/pricing', element: <Pricing /> },",
      ' ])',
    ].join('\n')
  }
  if (/\.(png|jpg)$/.test(rel)) return ''
  const body = [
    "import { post } from './client'",
    "import type { Plan, Session } from '../types'",
    '',
    'export async function createCheckout(plan: Plan) {',
    "  return post<Session>('/api/checkout', { plan })",
    '}',
    '',
    'export async function handleWebhook(event: WebhookEvent) {',
    "  if (event.type !== 'checkout.completed') return",
    '  await activatePlan(event.customer, event.plan)',
    '}',
  ]
  return [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)].join('\n')
}

export class DemoRuntime implements AgentRuntime {
  private stopped = false
  private disposed = false
  private turn = 0
  private plan: Step[] = PLAN.map((s) => ({ ...s }))
  private used = 18000
  /** Whether the turn in progress wrote files, which is what gives it an undo point. */
  private wrote = false

  constructor(
    private o: RuntimeOptions,
    private isLead: boolean,
  ) {}

  private emit(ev: RuntimeEvent): void {
    if (!this.disposed) this.o.host.emit(ev)
  }

  send(input: TurnInput): void {
    void this.play(input)
  }

  private async say(text: string): Promise<void> {
    const id = uid('a')
    this.emit({ type: 'text-start', id })
    const words = text.split(/(\s+)/)
    for (let i = 0; i < words.length && !this.stopped; i += 3) {
      this.emit({ type: 'text-delta', id, text: words.slice(i, i + 3).join('') })
      await wait(28)
    }
    this.emit({ type: 'text-end', id, text })
  }

  private async think(text: string, ms = 900): Promise<void> {
    const id = uid('r')
    this.emit({ type: 'thinking-start', id })
    await wait(ms)
    this.emit({ type: 'thinking-end', id, text })
  }

  private async tool(name: string, input: unknown, output: string, ms = 700, isError = false): Promise<void> {
    if (this.stopped) return
    const id = uid('t')
    this.emit({ type: 'tool-start', id, name, input })
    await wait(ms)
    this.emit({ type: 'tool-end', id, output, isError })
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    const t = this.o.tools.find((x) => x.name === name)
    if (!t) return ''
    const id = uid('t')
    this.emit({ type: 'tool-start', id, name: `mcp__team__${name}`, input: args })
    const out = toolText(await t.run(args))
    await wait(250)
    this.emit({ type: 'tool-end', id, output: out, isError: false })
    return out
  }

  /** Marks steps of the plan and shows the updated list. */
  private async mark(done: number[], doing: number[]): Promise<void> {
    for (const i of done) this.plan[i].status = 'completed'
    for (const i of doing) if (this.plan[i].status !== 'completed') this.plan[i].status = 'in_progress'
    await this.tool('TodoWrite', { todos: this.plan.map((s) => ({ ...s })) }, 'Plan updated', 220)
  }

  private async play(input: TurnInput): Promise<void> {
    const started = Date.now()
    this.stopped = false
    this.turn++
    this.wrote = false
    let last = ''
    let edited = false
    const MODELS: Record<string, string> = { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
    this.emit({ type: 'session', sessionId: `demo-${this.o.account.id}`, model: this.o.account.provider === 'claude' ? MODELS[this.o.model || ''] || 'claude-fable-5-2' : 'gpt-5.2-codex' })
    // Only the short window moves as it works: the week and the strongest model's allowance stay as the demo set them.
    this.emit({ type: 'usage', usage: { session: { utilization: Math.min(0.95, 0.12 + this.turn * 0.07), resetsAt: Date.now() + 3.2 * 3600e3 } } })
    // Lets the "ran out of allowance" path be seen without anyone running out.
    if (this.isLead && this.o.configDir === null && /simulate a limit/i.test(input.text) && input.origin.kind === 'human') {
      await this.think('Starting on this.', 500)
      this.emit({ type: 'usage', usage: { session: { utilization: 1, resetsAt: Date.now() + 2.1 * 3600e3, status: 'rejected' } } })
      this.emit({ type: 'turn-end', status: 'error', resultText: '', durationMs: Date.now() - started, reason: 'limit', error: 'Usage limit reached.' })
      return
    }
    try {
      if (this.isLead) last = await this.leadTurn(input)
      else {
        last = await this.memberTurn(input)
        edited = this.wrote
      }
    } catch (e) {
      this.emit({ type: 'turn-end', status: 'error', resultText: '', durationMs: Date.now() - started, reason: 'other', error: (e as Error).message })
      return
    }
    this.used += 9000 + last.length * 6
    this.emit({
      type: 'turn-end',
      status: this.stopped ? 'interrupted' : 'done',
      resultText: last,
      durationMs: Date.now() - started,
      steps: 4,
      tokens: 380 + last.length * 2,
      checkpoint: edited && !this.stopped ? uid('cp') : undefined,
    })
    if (this.o.account.provider === 'claude') this.emit({ type: 'context', used: this.used, max: 200000 })
    if (this.isLead && this.o.suggestions && this.plan.every((s) => s.status === 'completed')) {
      await wait(500)
      this.emit({ type: 'suggestion', text: 'Make the annual discount 15% instead' })
    }
  }

  /** Three short voice samples made on the spot, then a question asking which one to use. */
  private async voices(): Promise<string> {
    await this.think('Three takes, each with a different character, so they can be compared side by side.', 600)
    const dir = path.join(os.tmpdir(), 'ensemble-demo-voices')
    fs.mkdirSync(dir, { recursive: true })
    const takes = [
      { label: 'Warm', freq: 220 },
      { label: 'Bright', freq: 330 },
      { label: 'Calm', freq: 165 },
    ].map((t) => ({ ...t, file: path.join(dir, `voice-${t.label.toLowerCase()}.wav`) }))
    const id = uid('t')
    this.emit({ type: 'tool-start', id, name: 'Bash', input: { command: 'python make_voices.py --takes 3', description: 'Making three voice samples' } })
    await wait(900)
    for (const t of takes) tone(t.file, t.freq)
    this.emit({ type: 'tool-end', id, output: ['Saved:', ...takes.map((t) => t.file)].join('\n'), isError: false })
    const answers = await this.o.host.askQuestion(
      [{ question: 'Which voice should the video use?', header: 'Voice', options: takes.map((t) => ({ label: t.label, description: `${t.label} take: ${t.file}` })) }],
      new AbortController().signal,
    )
    const pick = answers ? Object.values(answers)[0] : ''
    const text = pick ? `Going with the ${pick} voice for the narration.` : 'No voice chosen yet. Say which one when you are ready.'
    await this.say(text)
    return text
  }

  /** Needs a page the user has to be signed in to: asks them, and waits. */
  private async signIn(): Promise<string> {
    await this.think('The dashboard is behind a sign-in, so the user has to do that part.', 500)
    const out = await this.call('browser', { action: 'sign_in', url: demoPage(), text: 'Your sales dashboard is behind a sign-in, and I need it to read the numbers from last month.' })
    const ok = /signed in to/i.test(out) && !/did not/i.test(out)
    const text = ok ? 'Thanks, I am in. Reading the numbers now.' : 'I could not get past the sign-in, so I left the numbers out.'
    await this.say(text)
    return text
  }

  private async leadTurn(input: TurnInput): Promise<string> {
    if (input.origin.kind === 'human' && /voice/i.test(input.text)) return this.voices()
    if (input.origin.kind === 'human' && /sign in/i.test(input.text) && this.o.tools.some((t) => t.name === 'browser')) return this.signIn()
    if (input.origin.kind === 'peer') {
      const status = await this.call('task_status', {})
      const done = [...status.matchAll(/^t\d+ · done · .+? · (.+)$/gm)].map((m) => m[1])
      const finished: number[] = []
      if (done.some((t) => /pricing/i.test(t))) finished.push(1)
      if (done.some((t) => /checkout/i.test(t))) finished.push(2)
      if (done.some((t) => /illustration|hero/i.test(t))) finished.push(3)
      if (done.some((t) => /review/i.test(t))) finished.push(4)
      const out = [...status.matchAll(/^t\d+ · (running|queued) · (.+?) · /gm)].map((m) => m[2])
      if (out.length) {
        await this.mark(finished, [])
        const text = `Got it. Still waiting on ${out.join(' and ')}.`
        await this.say(text)
        return text
      }
      await this.mark(finished, [5])
      await this.think('All the reports are in. Checking the pieces fit together before answering.', 700)
      await this.tool('Bash', { command: 'npm test', description: 'Run the test suite' }, 'Test Files  12 passed (12)\n     Tests  87 passed (87)\n  Duration  3.41s', 900)
      // Open the finished page and try the toggle, the way a person would check it.
      const page = await this.call('browser', { action: 'open', url: demoPage() })
      const annual = /\[(\d+)\] button "Annual/.exec(page)?.[1]
      if (annual) {
        await wait(900)
        await this.call('browser', { action: 'click', ref: Number(annual) })
        await wait(900)
        await this.call('browser', { action: 'look' })
      }
      // A quick second opinion from a teammate on another provider, without ending the turn.
      const team = await this.call('roster', {})
      const second = /^- (.+?) \(ChatGPT/m.exec(team)?.[1]
      if (second) await this.call('ask', { to: second, question: 'Quick second opinion: is 20% a sensible default for the annual discount on a three-tier plan, or should it be lower?' })
      await this.call('vault_save', {
        path: 'Projects/Storefront.md',
        mode: 'section',
        heading: 'Decisions',
        content: '- Pricing page shipped with a monthly/annual toggle; annual is set to 20% off as a proposal, to be confirmed.',
      })
      // Say how each model did, so the team learns where a cheaper one is enough.
      if (this.o.tools.some((t) => t.name === 'rate_work')) {
        for (const m of status.matchAll(/^(t\d+) · done · (.+?) · /gm)) await this.call('rate_work', { id: m[1], verdict: /scout/i.test(m[2]) ? 'more_than_needed' : 'enough' })
      }
      await this.mark([5], [])
      const text =
        'Everything is in and the tests pass.\n\n' +
        '**What changed**\n\n' +
        '- `src/pages/Pricing.tsx` has the new three-tier layout, with the annual toggle wired to `usePlan()`\n' +
        '- `src/api/checkout.ts` creates the session and handles the webhook\n' +
        '- A hero illustration was generated and saved to `public/hero.png`\n\n' +
        "```ts\nexport async function createCheckout(plan: Plan) {\n  return post<Session>('/api/checkout', { plan })\n}\n```\n\n" +
        'One thing to decide: the annual discount is set to 20%. Say the word if you want a different number.'
      await this.say(text)
      return text
    }
    // "On my computer, ..." shows an agent working an app on the (pretend) desktop.
    if (/on my computer/i.test(input.text) && this.o.tools.some((t) => t.name === 'computer')) {
      await this.think('This lives in an app window, so it needs the screen rather than a command.', 700)
      await this.say("I'll do that in the Notes app.")
      const first = await this.call('computer', { action: 'open', text: 'Notes' })
      if (/did not allow|switched off|stopped you/i.test(first)) {
        const text = 'I have not touched the computer. Tell me if you would like this done another way.'
        await this.say(text)
        return text
      }
      await wait(500)
      await this.call('computer', { action: 'left_click', coordinate: [640, 300] })
      await wait(400)
      await this.call('computer', { action: 'type', text: ['Design review, Thursday 3pm', '- Pricing page', '- Checkout flow'].join('\n') })
      await wait(400)
      await this.call('computer', { action: 'key', text: 'ctrl+s' })
      const text = 'Done. The note is written and saved in Notes.'
      await this.say(text)
      return text
    }
    this.plan = PLAN.map((s) => ({ ...s }))
    await this.think('This splits cleanly: the page and the checkout endpoint touch different files, and the illustration is a job for ChatGPT.', 1000)
    await this.say("I'll take a quick look at the project, then split this across the team.")
    await this.mark([], [0])
    await this.call('vault_search', { query: 'pricing tiers' })
    await this.tool('Read', { file_path: `${this.o.cwd}\\package.json` }, '{\n  "name": "storefront",\n  "scripts": { "dev": "vite", "test": "vitest" }\n}', 500)
    await this.tool('Grep', { pattern: 'usePlan' }, 'src/hooks/usePlan.ts\nsrc/pages/Account.tsx', 500)
    const roster = await this.call('roster', {})
    const names = [...roster.matchAll(/^- (.+?) \((.+?)\)/gm)].map((m) => ({ name: m[1], kind: m[2] }))
    const claude = names.filter((n) => n.kind.startsWith('Claude'))
    const gpt = names.find((n) => n.kind.startsWith('ChatGPT'))
    await this.mark([0], [1, 2, 3])
    // What the parts share goes on the board, where every agent is pointed with its task.
    await this.call('board_post', {
      title: 'Checkout contract',
      text: '`createCheckout(plan)` posts `{ plan }` to `/api/checkout` and returns a `Session`. The page never computes amounts.\n\nFiles: `src/pages` belongs to the pricing page task, `src/api` to the checkout task.',
    })
    // More hands than the team has: an agent started for this chat, on whichever account has allowance to spare.
    let scout = ''
    if (this.o.tools.some((t) => t.name === 'spawn_agent')) {
      const started = await this.call('spawn_agent', {
        name: 'Scout',
        role: 'researches how competitors price their plans',
        title: 'Competitor pricing research',
        brief:
          'Goal: know how three comparable products price their plans before we fix ours.\n\nLook at the public pricing pages of three products like ours. For each, note the tiers, the monthly and annual price, and the annual discount. Give every figure its source link and the date you read it, and say what you could not confirm.\n\nReport a short table and one paragraph on what it suggests for our annual discount.',
      })
      if (/joined the chat/.test(started)) scout = 'Scout'
    }
    const ids: string[] = []
    const taskId = (reply: string): void => {
      const id = /Task (t\d+)/.exec(reply)?.[1]
      if (id) ids.push(id)
    }
    if (claude[0]) {
      taskId(
        await this.call('assign_task', {
        to: claude[0].name,
        title: 'Build the pricing page',
        model: 'sonnet',
        effort: 'medium',
        brief:
          'Goal: a pricing page for the storefront, so visitors can compare plans before checkout.\n\nBuild `src/pages/Pricing.tsx` with three tiers (Starter, Team, Scale) and a monthly/annual toggle wired to the existing `usePlan()` hook. Match the styling of `src/pages/Account.tsx`. Register the route in `src/routes.tsx`. Those two files are yours; leave `src/api` alone, someone else is working there.\n\nCheck it with `npx vitest run src/pages`. Report the files you changed and the test output.',
        }),
      )
    }
    if (claude[1]) {
      taskId(
        await this.call('assign_task', {
        to: claude[1].name,
        title: 'Checkout endpoint and webhook',
        model: 'opus',
        effort: 'high',
        brief:
          'Goal: let the new pricing page start a checkout.\n\nAdd `src/api/checkout.ts` with `createCheckout(plan)` and a webhook handler that marks the plan active, plus tests next to it. Everything under `src/api` is yours; do not touch `src/pages`.\n\nCheck it with `npx vitest run src/api`. Report the files you changed and the test output.',
        }),
      )
    }
    // The review is lined up now and starts by itself once both builds have reported.
    if (claude[0] && ids.length === 2) {
      await this.call('assign_task', {
        to: claude[0].name,
        title: 'Review the checkout flow',
        effort: 'high',
        after: ids,
        brief:
          'Review the new checkout work as someone who did not write it: `src/api/checkout.ts`, its tests, and how `src/pages/Pricing.tsx` calls it. Look for money handled wrongly, a webhook that trusts its input, and paths the tests miss. Do not change the files. Report problems most serious first, each with the file and line, or say plainly that you found none.',
      })
    }
    if (gpt) {
      await this.call('assign_task', {
        to: gpt.name,
        title: 'Hero illustration',
        brief: 'A minimal flat illustration for the top of a pricing page: a small paper boat on calm blue water, lots of empty space for a headline. Save it as `public/hero.png` and report the full path.',
      })
    }
    const text = names.length
      ? `Work is handed out: ${[...names.map((n) => n.name), ...(scout ? [`${scout} (a new agent, on the research)`] : [])].join(', ')}. I'll check each piece as it comes back and put it together.`
      : 'There is nobody else on the team yet, so I will do this myself.'
    await this.say(text)
    return text
  }

  private async memberTurn(input: TurnInput): Promise<string> {
    // A teammate's question: a short answer, nothing else.
    if (input.text.startsWith('<question')) {
      await this.think('This is a question to answer, not work to start.', 500)
      const text =
        this.o.account.provider === 'chatgpt'
          ? 'Keep 20%. Fifteen to twenty percent is the usual range for annual plans, and 20% has the advantage of being easy to say: two months free.'
          : 'Yes. The toggle reads and writes the plan through `usePlan()`, so the page and the checkout call always agree on which period is selected.'
      await this.say(text)
      return text
    }
    // A sub-agent this teammate started has reported: check it and write the report on the whole task.
    if (/^\s*<task-result/.test(input.text)) {
      await this.think('The tests are in. Running everything together before reporting.', 600)
      await this.call('board_read', {})
      await this.tool('Bash', { command: 'npx vitest run src/api', description: 'Run the API tests' }, 'Test Files  3 passed (3)\n     Tests  14 passed (14)', 1000)
      const text = 'Done.\n\n- Created `src/api/checkout.ts` with `createCheckout(plan)` and the webhook handler\n- Tester, a sub-agent I started, added `src/api/checkout.test.ts`; I read it and ran it\n- `npx vitest run src/api` passes (14 tests)\n\nNothing left open.'
      await this.say(text)
      return text
    }
    if (/title="[^"]*research/i.test(input.text)) {
      await this.think('Three comparable products, their public pricing pages, and a source for every figure.', 800)
      await this.tool('WebSearch', { query: 'SaaS pricing page three tiers annual discount' }, '10 results', 900)
      await this.tool('WebFetch', { url: 'https://www.example.com/pricing' }, 'Starter $0 · Team $29 · Scale $99. Annual: two months free.', 800)
      await this.tool('WebFetch', { url: 'https://www.example.org/plans' }, 'Free · Pro $24 · Business $79. Save 20% yearly.', 800)
      await this.tool('WebFetch', { url: 'https://www.example.net/pricing' }, 'Basic $12 · Plus $32 · Enterprise: contact us. 15% off annual.', 800)
      const text =
        'Done.\n\n| Product | Tiers | Annual discount | Source |\n| --- | --- | --- | --- |\n| Example.com | $0 / $29 / $99 | about 17% (two months free) | example.com/pricing, read today |\n| Example.org | $0 / $24 / $79 | 20% | example.org/plans, read today |\n| Example.net | $12 / $32 / custom | 15% | example.net/pricing, read today |\n\nAll three offer 15 to 20% for paying yearly, so 20% puts us at the generous end without standing out. The enterprise price at Example.net could not be confirmed.'
      await this.say(text)
      return text
    }
    if (/title="[^"]*review/i.test(input.text)) {
      await this.think('Reading it as someone who has to trust it with money, not as its author.', 800)
      await this.tool('Read', { file_path: `${this.o.cwd}\\src\\api\\checkout.ts` }, 'export async function createCheckout(plan: Plan) { … }', 600)
      await this.tool('Read', { file_path: `${this.o.cwd}\\src\\api\\checkout.test.ts` }, "describe('checkout', () => { … })", 500)
      await this.tool('Grep', { pattern: 'createCheckout' }, 'src/api/checkout.ts\nsrc/pages/Pricing.tsx', 400)
      await this.tool('Bash', { command: 'npx vitest run src/api --coverage', description: 'Run the API tests with coverage' }, 'Test Files  3 passed (3)\n     Tests  14 passed (14)\n  Coverage  91.4% lines', 1000)
      const text =
        'Reviewed, and I found nothing that should block it.\n\n- `src/api/checkout.ts:18` the webhook checks the event type before it activates a plan, and ignores everything else\n- `src/pages/Pricing.tsx:42` passes the selected plan through unchanged; amounts are never computed in the page\n- One gap: no test covers a webhook that arrives twice. It is harmless today because activation is idempotent, but worth a test\n\nChecked with `npx vitest run src/api --coverage`: 14 tests pass, 91% of lines covered.'
      await this.say(text)
      return text
    }
    this.wrote = this.o.account.provider === 'claude'
    if (this.o.account.provider === 'chatgpt') {
      await this.think('A calm, minimal composition will sit well behind the headline.', 600)
      await this.tool('ImageGen', {}, 'Generated 1 image', 1600)
      const sample = process.env.ENSEMBLE_DEMO_IMAGE
      if (sample && fs.existsSync(sample)) this.emit({ type: 'image', path: sample })
      await this.tool('Shell', { command: 'Copy-Item hero.png public/hero.png' }, '', 400)
      const text = 'Done. Saved the illustration to `public/hero.png` (1536×1024, flat style, blue background).'
      await this.say(text)
      return text
    }
    const isTask = input.text.startsWith('<task')
    const api = /title="[^"]*checkout/i.test(input.text)
    const file = api ? 'src\\api\\checkout.ts' : 'src\\pages\\Pricing.tsx'
    await this.think('Reading the existing code first so the new file matches its conventions.', 700)
    await this.call('board_read', {})
    await this.tool('Read', { file_path: `${this.o.cwd}\\src\\pages\\Account.tsx` }, 'export function Account() { … }', 500)
    // The checkout owner writes the endpoint and starts a sub-agent of its own for the tests.
    if (isTask && api && !/title="[^"]*test/i.test(input.text) && this.o.tools.some((t) => t.name === 'spawn_agent')) {
      await this.tool('Write', { file_path: `${this.o.cwd}\\${file}`, content: "export async function createCheckout(plan: Plan) {\n  return post<Session>('/api/checkout', { plan })\n}" }, 'File created', 900)
      const started = await this.call('spawn_agent', {
        name: 'Tester',
        role: 'writes and runs the API tests',
        title: 'Tests for the checkout endpoint',
        brief:
          'Write `src/api/checkout.test.ts` for the new `createCheckout(plan)` and the webhook handler in `src/api/checkout.ts`: the happy path, an unknown plan, and a webhook of the wrong type. Only the test file is yours. Run `npx vitest run src/api` and report the output.',
      })
      if (/joined the chat/.test(started)) {
        const text = 'The endpoint is written. Tester, a sub-agent I started, is covering it with tests; I will report once they pass.'
        await this.say(text)
        return text
      }
    }
    await this.tool('Write', { file_path: `${this.o.cwd}\\${file}`, content: 'export function Pricing() {\n  const { plan, setPlan } = usePlan()\n  return <Tiers plan={plan} onChange={setPlan} />\n}' }, 'File created', 900)
    await this.tool(
      'Edit',
      { file_path: `${this.o.cwd}\\${api ? 'src\\api\\checkout.test.ts' : 'src\\routes.tsx'}`, old_string: "{ path: '/account', element: <Account /> }", new_string: "{ path: '/account', element: <Account /> },\n  { path: '/pricing', element: <Pricing /> }," },
      'Applied 1 edit',
      600,
    )
    await this.tool('Bash', { command: `npx vitest run ${api ? 'src/api' : 'src/pages'}`, description: api ? 'Run the API tests' : 'Run the page tests' }, 'Test Files  3 passed (3)\n     Tests  14 passed (14)', 1100)
    const text = isTask
      ? api
        ? 'Done.\n\n- Created `src/api/checkout.ts` with `createCheckout(plan)` and the webhook handler\n- Added `src/api/checkout.test.ts`\n- `npx vitest run src/api` passes (14 tests)\n\nNothing left open.'
        : 'Done.\n\n- Created `src/pages/Pricing.tsx` with the three tiers and the annual toggle\n- Registered the route in `src/routes.tsx`\n- `npx vitest run src/pages` passes (14 tests)\n\nNothing left open.'
      : 'Sure. I looked at the page and it is in good shape; the toggle state lives in `usePlan()` as expected.'
    await this.say(text)
    return text
  }

  async interrupt(): Promise<void> {
    this.stopped = true
  }

  async setPermission(_level: PermissionLevel): Promise<void> {}

  async rewind(_checkpoint: string, _apply: boolean): Promise<RewindPreview> {
    await wait(300)
    return { ok: true, files: [`${this.o.cwd}\\src\\pages\\Pricing.tsx`, `${this.o.cwd}\\src\\routes.tsx`], added: 3, removed: 99 }
  }

  dispose(): void {
    this.disposed = true
    this.stopped = true
  }
}
