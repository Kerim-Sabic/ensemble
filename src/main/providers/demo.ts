import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChangedFile, FolderChanges, PermissionLevel, RewindPreview } from '@shared/types'
import { demoSpeed, uid } from '../util'
import { toolText, type AgentRuntime, type RuntimeEvent, type RuntimeOptions, type TurnInput } from './types'

// A scripted stand-in for a real agent. It drives the real hub (tasks, messages,
// approvals) so the interface can be exercised without using anyone's allowance.
// Only used when the app is started with ENSEMBLE_DEMO=1.

const SPEED = demoSpeed()
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / SPEED))

/** The first line of a message, short enough to quote. */
const truncateLine = (text: string): string => {
  const line = text.split('\n')[0].trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

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

/** A Live answer `ui` fence holding one block, as a lead writes it. */
function uiFence(block: Record<string, unknown>): string {
  return '```ui\n' + JSON.stringify(block) + '\n```'
}

/**
 * The winning landing page of the demo's Ultra run, as the lead shows it running in an `app` block:
 * self-contained, no network, coloured by the frame's variables so it fits light and dark.
 */
const WINNER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);padding:28px 32px}
.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:34px}
.logo{display:flex;align-items:center;gap:8px;font-weight:650;letter-spacing:-.01em}
.mark{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 45%,var(--ink)))}
.links{display:flex;gap:18px;color:var(--ink-2);font-size:13px}
.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:28px;align-items:center;margin-bottom:28px}
h1{font-size:34px;line-height:1.08;letter-spacing:-.025em;font-weight:700;margin-bottom:12px}
.lede{color:var(--ink-2);max-width:40ch;margin-bottom:18px}
.cta{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:10px;padding:10px 16px;font:600 13px system-ui,sans-serif;background:var(--accent);color:#fff;cursor:pointer}
.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--line);margin-left:6px}
.art{height:150px;border-radius:16px;background:var(--surface);border:1px solid var(--line);position:relative;overflow:hidden}
.art i{position:absolute;border-radius:50%;filter:blur(2px);opacity:.85}
.art i:nth-child(1){width:120px;height:120px;left:18px;top:14px;background:color-mix(in srgb,var(--accent) 70%,transparent)}
.art i:nth-child(2){width:90px;height:90px;right:26px;bottom:-18px;background:color-mix(in srgb,var(--accent) 35%,transparent)}
.art b{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 12px system-ui;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:6px 12px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px}
.card h3{font-size:13px;margin-bottom:4px}
.card p{color:var(--ink-2);font-size:12.5px}
.price{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.toggle{display:inline-flex;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:3px}
.toggle button{border:0;background:transparent;color:var(--ink-2);font:600 12px system-ui;padding:5px 12px;border-radius:999px;cursor:pointer}
.toggle button.on{background:var(--bg);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.amount{font-size:22px;font-weight:700;letter-spacing:-.02em}
.amount small{font-size:12px;color:var(--ink-2);font-weight:500}
.save{color:var(--accent);font-size:12px;font-weight:600;margin-left:8px}
@media (max-width:640px){.hero{grid-template-columns:1fr}.art{display:none}.cards{grid-template-columns:1fr}}
</style></head><body>
<div class="nav"><div class="logo"><span class="mark"></span>Northwind</div><div class="links"><span>Product</span><span>Pricing</span><span>Docs</span></div></div>
<div class="hero"><div>
<h1>Plan the week in five minutes.</h1>
<p class="lede">Northwind turns scattered tasks into one calm plan, and keeps it current as the week moves.</p>
<button class="cta" onclick="ensemble.propose('Use version B')">Start free</button><button class="cta ghost">See how it works</button>
</div><div class="art"><i></i><i></i><b>12 tasks, 1 plan</b></div></div>
<div class="cards">
<div class="card"><h3>One inbox</h3><p>Mail, chat and notes land in one list you can sort in seconds.</p></div>
<div class="card"><h3>A plan that adapts</h3><p>Move one thing and the rest of the week rearranges itself.</p></div>
<div class="card"><h3>Calm by default</h3><p>No badges, no noise: one summary each morning.</p></div>
</div>
<div class="price"><div><span class="amount" id="amt">$12<small> / month</small></span><span class="save" id="save"></span></div>
<div class="toggle"><button class="on" id="m">Monthly</button><button id="y">Yearly</button></div></div>
<script>
const m=document.getElementById('m'),y=document.getElementById('y'),amt=document.getElementById('amt'),save=document.getElementById('save');
function set(yearly){m.classList.toggle('on',!yearly);y.classList.toggle('on',yearly);amt.innerHTML=(yearly?'$10':'$12')+'<small> / month'+(yearly?', paid yearly':'')+'</small>';save.textContent=yearly?'Two months free':'';}
m.onclick=()=>set(false);y.onclick=()=>set(true);
</script>
</body></html>`

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

/** Thrown inside a scripted turn once it has been stopped, so the turn ends there and starts nothing more. */
class Stopped extends Error {}
class OutOfUsage extends Error {}
/** The person sent words into the turn under way: the scripted work changes course at its next step. */
class Steered extends Error {}

export class DemoRuntime implements AgentRuntime {
  private stopped = false
  /** A turn is being played, so words can be steered into it. */
  private running = false
  /** Words steered into the turn under way, taken in at its next step. */
  private steerIn: TurnInput[] = []
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

  /** Like Claude, the scripted team takes words sent mid-turn in at its next step. */
  steer(input: TurnInput): boolean {
    if (!this.running || this.stopped || this.disposed) return false
    this.steerIn.push(input)
    return true
  }

  /** Reads what was steered in and changes course: "just say X" is honoured to the word. */
  private async afterSteer(): Promise<string> {
    for (;;) {
      // The app's own framing line is for the model; the scripted reply quotes only the person's words.
      const said = this.steerIn
        .splice(0)
        .map((x) => x.text.replace(/^\(Sent while you were working[^)]*\)\s*/, '').trim())
        .join('\n')
      try {
        await this.think(`A new message from you while I was working: "${said.slice(0, 120)}". Changing course.`, 500)
        const just = /just say\s+["“]?([^"”\n]+?)["”]?\s*$/i.exec(said)?.[1]
        const reply = just ? just.trim() : `Got your message while I was working, so I changed course: ${said}`
        await this.say(reply)
        if (!this.steerIn.length) return reply
      } catch (e) {
        if (!(e instanceof Steered)) throw e
      }
    }
  }

  /** Waits like the real thing would, but a stop cuts the wait short and ends the turn. */
  private wakers = new Set<() => void>()
  private async pause(ms: number): Promise<void> {
    if (this.stopped) throw new Stopped()
    await new Promise<void>((r) => {
      const done = (): void => {
        clearTimeout(t)
        this.wakers.delete(done)
        r()
      }
      const t = setTimeout(done, ms / SPEED)
      this.wakers.add(done)
    })
    if (this.stopped) throw new Stopped()
    if (this.steerIn.length) throw new Steered()
  }

  private async say(text: string): Promise<void> {
    if (this.stopped) throw new Stopped()
    const id = uid('a')
    this.emit({ type: 'text-start', id })
    const words = text.split(/(\s+)/)
    for (let i = 0; i < words.length && !this.stopped; i += 3) {
      this.emit({ type: 'text-delta', id, text: words.slice(i, i + 3).join('') })
      await this.pause(28)
    }
    this.emit({ type: 'text-end', id, text })
  }

  private async think(text: string, ms = 900): Promise<void> {
    if (this.stopped) throw new Stopped()
    // The allowance ran out in the middle of the reply: it ends at its next step, as a real one would.
    if (this.o.outUntil?.()) throw new OutOfUsage()
    const id = uid('r')
    this.emit({ type: 'thinking-start', id })
    await this.pause(ms)
    this.emit({ type: 'thinking-end', id, text })
  }

  private async tool(name: string, input: unknown, output: string, ms = 700, isError = false): Promise<void> {
    if (this.stopped) throw new Stopped()
    if (this.o.outUntil?.()) throw new OutOfUsage()
    const id = uid('t')
    this.emit({ type: 'tool-start', id, name, input })
    await this.pause(ms)
    this.emit({ type: 'tool-end', id, output, isError })
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    // A stopped turn hands out nothing more and starts no more agents.
    if (this.stopped) throw new Stopped()
    if (this.o.outUntil?.()) throw new OutOfUsage()
    const t = this.o.tools.find((x) => x.name === name)
    if (!t) return ''
    const id = uid('t')
    this.emit({ type: 'tool-start', id, name: `mcp__team__${name}`, input: args })
    const out = toolText(await t.run(args))
    await this.pause(250)
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
    this.running = true
    try {
      await this.playTurn(input)
    } finally {
      this.running = false
      this.steerIn = []
    }
  }

  private async playTurn(input: TurnInput): Promise<void> {
    const started = Date.now()
    this.stopped = false
    this.turn++
    this.wrote = false
    let last = ''
    let edited = false
    const MODELS: Record<string, string> = { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
    this.emit({ type: 'session', sessionId: `demo-${this.o.account.id}`, model: this.o.account.provider === 'claude' ? MODELS[this.o.model || ''] || 'claude-fable-5-2' : this.o.model || this.o.defaultModel || 'gpt-6.1-sol' })
    // An account with nothing left fails the turn a moment in, as a real one does (with the "simulate a limit" lead below, this is what drives the handover paths).
    if (this.o.outUntil?.()) {
      await this.pause(300)
      if (this.stopped) this.emit({ type: 'turn-end', status: 'interrupted', resultText: '', durationMs: Date.now() - started })
      else this.emit({ type: 'turn-end', status: 'error', resultText: '', durationMs: Date.now() - started, reason: 'limit', error: 'Usage limit reached.' })
      return
    }
    // Only the short window moves as it works: the week and the strongest model's allowance stay as the demo set them.
    // It stops short of where an account counts as running low, so the scripted team never hands work over by itself.
    this.emit({ type: 'usage', usage: { session: { utilization: Math.min(0.85, 0.12 + this.turn * 0.07), resetsAt: Date.now() + 3.2 * 3600e3 } } })
    // Lets the "ran out of allowance" path be seen without anyone running out.
    if (this.isLead && this.o.configDir === null && /simulate a limit/i.test(input.text) && input.origin.kind === 'human') {
      await this.think('Starting on this.', 500)
      this.emit({ type: 'usage', usage: { session: { utilization: 1, resetsAt: Date.now() + 2.1 * 3600e3, status: 'rejected' } } })
      this.emit({ type: 'turn-end', status: 'error', resultText: '', durationMs: Date.now() - started, reason: 'limit', error: 'Usage limit reached.' })
      return
    }
    try {
      try {
        if (this.isLead) last = await this.leadTurn(input)
        else {
          last = await this.memberTurn(input)
          edited = this.wrote
        }
      } catch (e) {
        if (!(e instanceof Steered)) throw e
        last = await this.afterSteer()
      }
      // Words that came in after the last step are still read before the turn ends.
      if (this.steerIn.length) last = await this.afterSteer()
    } catch (e) {
      if (e instanceof Stopped || this.stopped) this.emit({ type: 'turn-end', status: 'interrupted', resultText: '', durationMs: Date.now() - started })
      else if (e instanceof OutOfUsage) this.emit({ type: 'turn-end', status: 'error', resultText: '', durationMs: Date.now() - started, reason: 'limit', error: 'Usage limit reached.' })
      else this.emit({ type: 'turn-end', status: 'error', resultText: '', durationMs: Date.now() - started, reason: 'other', error: (e as Error).message })
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
    await this.pause(900)
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

  /** One run of a loop: a few lines on what changed, and on the third run the thing it was watching for happens. */
  private async loopRun(input: TurnInput): Promise<string> {
    const run = Number(/<loop [^>]*run="(\d+)"/.exec(input.text)?.[1] || '1')
    const ownPace = /pace="at its own pace"/.test(input.text)
    await this.think('A repeat run: look at what changed since last time and say only that.', 500)
    await this.tool('Bash', { command: 'gh run list --limit 1', description: 'Check the latest deploy' }, run < 3 ? `in_progress  Deploy storefront  main  step ${Math.min(6, 3 + run)} of 6` : 'completed  success  Deploy storefront  main  2m 41s', 600)
    let text: string
    if (run < 3) {
      text = run === 1 ? 'The deploy is still building (step 4 of 6). Nothing needs doing yet.' : 'No change: still building, now on step 5 of 6.'
      if (ownPace) await this.call('loop_update', { next_in_minutes: 1 })
    } else {
      text = 'The deploy is live: it finished in 2 min 41 s and the pricing page answers with the new tiers. That was what this loop was watching for, so it ends here.'
      await this.call('notify_user', { title: 'The deploy is live', text: 'Storefront finished deploying and the pricing page is up.' })
      await this.call('loop_update', { stop: true, reason: 'The deploy is live.' })
    }
    await this.say(text)
    return text
  }

  /** The first round on a goal builds the thing but does not check it; sent back, the lead runs it and reports the evidence. */
  private async goalRound(input: TurnInput): Promise<string> {
    if (/<goal-check/.test(input.text)) {
      await this.think('The check is right: it was built but never run end to end. Run it and look at the result.', 700)
      await this.tool('Bash', { command: 'npm test', description: 'Run the test suite' }, 'Test Files  12 passed (12)\n     Tests  87 passed (87)\n  Duration  3.41s', 900)
      if (this.o.tools.some((t) => t.name === 'browser')) {
        await this.call('browser', { action: 'open', url: demoPage() })
        await this.pause(600)
        await this.call('browser', { action: 'look' })
      }
      await this.call('goal_report', { state: 'met', note: 'npm test: 87 of 87 pass. Opened the pricing page: three tiers, and the annual toggle changes the prices.' })
      const text =
        'It is done, and checked this time.\n\n' +
        '**Evidence**\n\n' +
        '- `npm test`: 12 files, 87 tests, all passing\n' +
        '- Opened the pricing page in the browser: the three tiers show, and the annual toggle changes every price\n\n' +
        'Nothing is left open.'
      await this.say(text)
      return text
    }
    await this.think('A goal, so this has to end finished and checked, not merely started.', 800)
    await this.tool('Read', { file_path: `${this.o.cwd}\\src\\pages\\Account.tsx` }, 'export function Account() { /* … */ }', 500)
    await this.tool('Write', { file_path: `${this.o.cwd}\\src\\pages\\Pricing.tsx`, content: 'export function Pricing() { /* three tiers and an annual toggle */ }' }, 'File created', 700)
    await this.tool('Edit', { file_path: `${this.o.cwd}\\src\\routes.tsx`, old_string: '] as const', new_string: "  { path: '/pricing', element: <Pricing /> },\n] as const" }, 'File updated', 500)
    this.wrote = true
    const text = 'The pricing page is built: `src/pages/Pricing.tsx` has the three tiers and the annual toggle, and the route is registered.\n\n**Left:** I have not run the tests or opened the page yet.'
    await this.say(text)
    return text
  }

  /**
   * Ultra and Go crazy: a rubric on the board, then a swarm of scouts on the fast models, builders
   * on the strongest models at full effort once the scouts are in, and judges once the builders
   * are in, all started at once and lined up with `after` so the stages run by themselves.
   * Ultra starts 7 agents (4 scouts, 2 builders, 1 judge); Go crazy 15 (8, 4, and 3 judges in two rounds).
   */
  private async ultraStart(crazy: boolean, input: TurnInput): Promise<string> {
    const ask = truncateLine((input.text.split('</way-of-working>').pop() || '').trim()) || 'this request'
    // A choice clicked in a Live answer comes back as plain words: answered directly, nobody started.
    const chose = /^(?:Chose|Answers):\s*(.+)$/i.exec(ask) || /^((?:Use|Show me) version \w|Refine \w once more)\b.*$/i.exec(ask)
    if (chose) {
      const pick = chose[1].trim()
      const text = /use version/i.test(pick)
        ? `Done: version B is copied into \`site/index.html\` and the old page is kept as \`site/index.old.html\`.\n\nI opened it at phone and laptop sizes in light and dark mode, and it matches what you saw above.`
        : /refine/i.test(pick)
          ? 'One more round on B: a fresh reviewer goes over it against the rubric, and I fix what it finds. Send "go" when you want it started.'
          : `Version A is in \`designs/a/index.html\`, with screenshots in \`designs/a/shots/\`. It scored 43 of 50, three behind B, mostly on hierarchy.`
      await this.say(text)
      return text
    }
    // Ultra stays on for the chat, so a thank-you or a quick question arrives this way too: it gets a direct answer, as the briefing says.
    if (/^(thanks|thank you|thx|ty|cheers|great|nice|perfect|awesome|ok|okay|cool|looks good)\b/i.test(ask) || (ask.length < 60 && /\?$/.test(ask) && /\b(status|where are we|how far|done yet|progress)\b/i.test(ask))) {
      const text = /\?$/.test(ask) ? 'Nothing is running right now. The last run finished, with version B as the winner.' : 'Glad it helps. Tell me what to change next and I will take it from there.'
      await this.say(text)
      return text
    }
    await this.think(
      crazy
        ? 'Go crazy: the whole pipeline at full scale. A wide scout swarm on the fast models, every strong model building its own version, then two rounds of judges who built nothing.'
        : 'Ultra: a rubric first, then scouts on the fast models, builders on the strongest models at full effort, and a judge who did none of the work.',
      900,
    )
    const roster = await this.call('roster', {})
    // Names already in the chat (from an earlier run) are not used again, so nobody is renamed under their task.
    const taken = new Set([...roster.matchAll(/^- (.+?) \(/gm)].map((m) => m[1].toLowerCase()))
    const free = (names: string[]): string => {
      const name = names.find((n) => !taken.has(n.toLowerCase())) || names[names.length - 1]
      taken.add(name.toLowerCase())
      return name
    }
    const numbered = (base: string): string => free(Array.from({ length: 60 }, (_, i) => `${base} ${i + 1}`))
    const lettered = (): string => free([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `Builder ${l}`))
    // Pictures come from a ChatGPT agent when the team has one (the note lists the team's accounts).
    const draw = /^- \d+ ChatGPT accounts? \(/m.test(input.text)
    const imageBrief = `Request: ${ask}\n\nMake the images the builders will use. First a moodboard: three clearly different directions as images (style, colour, feel of the type, composition), 16:9. Then the hero in the direction that fits the rubric best, at 2560×1097, in three variations: subject, composition, lighting and palette as the rubric and the moodboard set them, no text in the image, no stock clichés. Save them in designs/assets/, note on the board that they are generated, and report the paths.`
    const useImages = 'Build with the generated images in designs/assets/ (the moodboard and the hero): use them as files and as references.'
    await this.call('board_post', {
      title: 'Rubric',
      text: `What the best result for "${ask}" looks like. Every version is scored 1 to 10 on each:\n1. Does exactly what was asked\n2. Correct: it runs, nothing is broken\n3. Complete: no placeholders, every state handled\n4. Craft: typography, spacing, hierarchy, the details\n5. Fast and accessible\n6. Holds up next to the best reference the scouts find`,
    })
    // The models come from the team the note describes, as a real lead's would: a team of ChatGPT
    // accounts alone scouts on Luna and builds on Astra; one of Claude alone, Haiku and Fable.
    const told = (word: string): { value: string; label: string }[] => [...input.text.matchAll(new RegExp(`${word} ([^(\\n]+?) \\(\`([^\`]+)\``, 'g'))].map((m) => ({ label: m[1].trim(), value: m[2] }))
    const strong = told('strongest')
    const fast = told('fastest')
    const strongOf = (i: number, fallback: string): string => (strong.length ? strong[i % strong.length].value : fallback)
    const fastOf = (i: number, fallback: string): string => (fast.length ? fast[i % fast.length].value : fallback)
    const painter = fast.find((m) => /gpt|luna/i.test(m.value))?.value || 'luna'
    const short = (list: { label: string }[], fallback: string): string => (list.length ? [...new Set(list.map((m) => m.label.replace(/^GPT-[\d.]+-/, '').replace(/ [\d.]+$/, '')))].join(' and ') : fallback)
    const angles = crazy
      ? ['the best work in this field', 'design systems and type', 'what users complain about', 'accessibility rules', 'performance budgets', 'motion and interaction', 'competitors, side by side', 'award-winning examples']
      : ['the best work in this field', 'what users complain about', 'accessibility and performance', 'competitors, side by side']
    const builders = (
      crazy
        ? [
            { model: strongOf(0, 'fable'), effort: 'max' },
            // A second strong Claude model where the team has Claude at all.
            { model: strong.some((m) => /fable/i.test(m.value)) ? 'opus' : strongOf(1, 'opus'), effort: 'max' },
            { model: strongOf(1, 'astra'), effort: 'xhigh' },
            { model: strongOf(1, 'astra'), effort: 'max' },
          ]
        : [
            { model: strongOf(0, 'fable'), effort: 'max' },
            { model: strongOf(1, 'astra'), effort: 'xhigh' },
          ]
    ).map((b) => ({ ...b, name: lettered() }))
    const judges = (
      crazy
        ? [
            { model: strongOf(0, 'fable'), effort: 'max', round: 1 },
            { model: strongOf(1, 'astra'), effort: 'xhigh', round: 1 },
            { model: strong.some((m) => /fable/i.test(m.value)) ? 'opus' : strongOf(0, 'opus'), effort: 'max', round: 2 },
          ]
        : [{ model: strongOf(0, 'fable'), effort: 'max', round: 1 }]
    ).map((j) => ({ ...j, name: numbered('Judge') }))
    const started: string[] = []
    // Starts one agent; when its model cannot run here, it starts on the account's usual model instead.
    const start = async (args: Record<string, unknown>): Promise<string | undefined> => {
      if (this.stopped) return undefined
      let r = await this.call('spawn_agent', args)
      if (!/joined the chat/.test(r)) r = await this.call('spawn_agent', { ...args, model: undefined, effort: undefined })
      if (/joined the chat/.test(r)) started.push(String(args.name))
      return /Task (t\d+)/.exec(r)?.[1]
    }
    // A lead that holds back (as real leads were seen to: two agents for a whole Go crazy request), for the app's one follow-up.
    if (crazy && /\b(only two|two agents)\b/i.test(ask)) {
      for (const [i, angle] of angles.slice(0, 2).entries()) await start({ name: numbered('Scout'), role: `scouts ${angle}`, title: `Scout: ${angle}`, model: fastOf(i, i % 2 ? 'luna' : 'haiku'), effort: 'medium', brief: `Request: ${ask}\n\nYour one angle: ${angle}. Report up to six findings, each with a link and a date.` })
      return this.said(`Two scouts are looking into "${ask}". I will take it from there once they report.`)
    }
    if (crazy) {
      // Go crazy works like a brain: four regions, each led by an agent that runs a team of its own,
      // lined up so building waits for research and judging for building. Memory keeps the board.
      const lead = { model: strongOf(0, 'fable'), effort: 'high' }
      const names = { research: free(['Research lead', 'Research lead 2']), memory: free(['Memory lead', 'Memory lead 2']), build: free(['Build lead', 'Build lead 2']), judging: free(['Judging lead', 'Judging lead 2']) }
      const others = `Other regions: research ${names.research}; memory ${names.memory}; building ${names.build}; judging ${names.judging}.`
      const scoutLines = angles.map((a, i) => `- ${numbered('Scout')} on ${fastOf(i, i % 2 ? 'luna' : 'haiku')}: ${a}`)
      const images = draw ? await start({ name: free(['Image lead', 'Image lead 2']), role: 'leads the image region: the moodboard and the assets for the builders', title: 'Images: moodboard, hero and assets', model: painter, effort: 'high', brief: imageBrief }) : undefined
      const research = await start({ name: names.research, role: 'leads the research region', title: 'Region: research', ...lead, brief: `Request: ${ask}\n\nYou lead the research region. Start these scouts at once, one angle each, and report what they found once all are in:\n${scoutLines.join('\n')}\n\n${others}` })
      const after = research ? [research] : []
      await start({ name: names.memory, role: 'leads the memory region: keeps the board current', title: 'Region: memory', ...lead, after, brief: `Request: ${ask}\n\nYou lead the memory region. Keep the board current: the rubric, the scouts' findings with sources, decisions and why, each version's latest scores. Start an archivist for the decisions.\n\n${others}` })
      const build = await start({ name: names.build, role: 'leads the building region', title: 'Region: building', ...lead, after: images ? [...after, images] : after, brief: `Request: ${ask}\n\nYou lead the building region. Start these builders at once, each making a complete version of its own as a small cell:\n${builders.map((b) => `- ${b.name} on ${b.model} at ${b.effort}`).join('\n')}${images ? `\n\n${useImages}` : ''}\n\n${others}` })
      await start({ name: names.judging, role: 'leads the judging region', title: 'Region: judging', ...lead, after: build ? [build] : [], brief: `Request: ${ask}\n\nYou lead the judging region. Start these judges, round two after round one:\n${judges.map((j) => `- ${j.name} on ${j.model} at ${j.effort}, round ${j.round}`).join('\n')}\n\n${others}` })
      const text =
        `Going crazy: four regions are working on "${ask}", each led by an agent with a team of its own.\n\n` +
        `1. **Research** (${names.research}): ${angles.length} scouts on ${short(fast, 'Haiku and Luna')}, one narrow angle each, with sources\n` +
        `2. **Building** (${names.build}): ${builders.length} builders on ${short(strong, 'Fable and Astra')} at full effort, each with its own critic, once research is in\n` +
        `3. **Judging** (${names.judging}): ${judges.length} judges in two rounds, with a verifier\n` +
        `4. **Memory** (${names.memory}): keeps the board current for every region\n` +
        (images ? '5. **Images** (on ChatGPT): a moodboard of three directions and the hero in three variations, for the builders\n' : '') +
        '\n' +
        'I will bring the winner together, refine it, and check it myself before I answer.'
      await this.say(text)
      return text
    }
    // A design run on a team with a ChatGPT account: an image agent makes the moodboard and the hero assets the builders use.
    const imageIds: string[] = []
    if (draw) {
      const id = await start({ name: free(['Image maker', 'Image maker 2', 'Image maker 3']), role: 'makes the moodboard and the hero images for the builders', title: 'Images: moodboard and hero', model: painter, effort: 'medium', brief: imageBrief })
      if (id) imageIds.push(id)
    }
    const scoutIds: string[] = []
    for (const [i, angle] of angles.entries()) {
      const id = await start({
        name: numbered('Scout'),
        role: `scouts ${angle}`,
        title: `Scout: ${angle}`,
        model: fastOf(i, i % 2 ? 'luna' : 'haiku'),
        effort: 'medium',
        brief: `Request: ${ask}\n\nYour one angle: ${angle}. Find the strongest examples and facts on it, nothing else. Report up to six findings, each with a link and the date you read it, and say what you could not confirm.`,
      })
      if (id) scoutIds.push(id)
    }
    const buildIds: string[] = []
    for (const [bi, b] of builders.entries()) {
      // Each builder is a small cell: a critic on another model attacks its draft before it is submitted,
      // and the first builders (all of them in Ultra's first) also get a tester that renders it.
      const tester = crazy ? bi < 2 : bi === 0
      const cell = `Before you submit, start a critic on a different model to attack your draft${tester ? ', and a tester that renders it and reports what it saw' : ''}; answer the critic's points first.${crazy && bi === 0 ? ' Your critic may start a fact-checker for the claims it leans on.' : ''}`
      const id = await start({
        name: b.name,
        role: `builds version ${b.name.slice(-1)}`,
        title: `Build: version ${b.name.slice(-1)}`,
        model: b.model,
        effort: b.effort,
        after: [...scoutIds, ...imageIds],
        brief: `Request: ${ask}\n\nMake a complete version of your own, working to the rubric on the board and using the scouts' findings below. Do not look at the other versions. Work in designs/${b.name.slice(-1).toLowerCase()}/ only.${imageIds.length ? ' ' + useImages : ''} Render it and take a screenshot in light and dark mode. ${cell} Report the path and the screenshots.`,
      })
      if (id) buildIds.push(id)
    }
    const round1: string[] = []
    for (const j of judges) {
      const id = await start({
        name: j.name,
        role: j.round === 1 ? 'judges the versions against the rubric' : 'judges the final round, fresh',
        title: `Judge: round ${j.round}`,
        model: j.model,
        effort: j.effort,
        after: j.round === 1 ? buildIds : [...buildIds, ...round1],
        brief: `You did none of this work. Score every version (A, B${crazy ? ', C, D' : ''}) on each rubric criterion from 1 to 10 with a reason, name the best version, and list the best ideas in the others.${j.round === 2 ? ' Round one has judged already; judge the improved versions afresh.' : ''}${crazy && j === judges[0] ? ' Start a verifier who checks your scores against the screenshots before you report.' : ''}`,
      })
      if (id && j.round === 1) round1.push(id)
    }
    const text =
      `${crazy ? 'Going crazy' : 'Ultra is under way'}: ${started.length} agents are working on "${ask}".\n\n` +
      `1. **Scouts** (${angles.length}, on ${short(fast, 'Haiku and Luna')}): one narrow angle each, with sources\n` +
      `2. **Builders** (${builders.length}, on ${short(strong, 'Fable and Astra')} at full effort): each makes a complete version of its own once the scouts are in${imageIds.length ? ', with the generated images' : ''}\n` +
      `3. **Judges** (${judges.length}${crazy ? ', in two rounds' : ''}): score every version against the rubric on the board\n` +
      (imageIds.length ? '4. **Images** (on ChatGPT): a moodboard of three directions and the hero in three variations, for the builders\n' : '') +
      '\n' +
      'I will merge the best ideas into the winner, refine it, and check it myself before I answer.'
    await this.say(text)
    return text
  }

  /** The lead hears from an Ultra stage: waits for the rest, or wraps up once the judges are in. */
  private async ultraReport(status: string): Promise<string> {
    const tasks = [...status.matchAll(/^(t\d+) · (\w+)[^·\n]* · (.+?) · ((?:Scout|Build|Judge|Region|Archive|Images):[^\n]*)$/gm)].map((m) => ({ id: m[1], status: m[2], who: m[3], title: m[4] }))
    const open = tasks.filter((t) => !/^(done|failed|cancelled)$/.test(t.status))
    if (open.length) {
      const stage = open.some((t) => t.title.startsWith('Scout')) ? 'the scouts' : open.some((t) => t.title.startsWith('Images')) ? 'the images' : open.some((t) => t.title.startsWith('Build')) ? 'the builders' : 'the judges'
      const text = `Got it. ${tasks.length - open.length} of ${tasks.length} are in; waiting on ${stage}.`
      await this.say(text)
      return text
    }
    const crazy = tasks.filter((t) => t.title.startsWith('Build')).length > 2
    await this.think('Every stage is in. Merging the best ideas into the winner, then checking it myself.', 800)
    await this.tool('Edit', { file_path: `${this.o.cwd}\\designs\\b\\index.html`, old_string: '<section class="hero">', new_string: '<section class="hero" data-merged="A:type-scale C:motion">' }, 'Applied 1 edit', 600)
    await this.tool('Bash', { command: 'npx playwright screenshot designs/b/index.html --viewport 390x844,1440x900 --color-scheme light,dark', description: 'Screenshot the winner at two sizes, light and dark' }, '4 screenshots saved to designs/b/shots/', 900)
    for (const t of tasks.filter((x) => x.title.startsWith('Scout'))) await this.call('dismiss_agent', { name: t.who })
    // The answer is made of Live answer blocks, as a real lead's would be: the versions side by side,
    // the judges' scores, the next step as choices, and the winner running.
    const versions = crazy ? ['A', 'B', 'C', 'D'] : ['A', 'B']
    const scores: Record<string, number> = { A: 43, B: 46, C: 42, D: 42 }
    const notes: Record<string, { summary: string; pros: string[]; cons: string[] }> = {
      A: { summary: 'Editorial and calm, built on a strong type scale', pros: ['The best type scale of the four', 'Fast on a phone'], cons: ['The call to action sits low on small screens'] },
      B: { summary: 'One idea per screen, a clear path to the call to action', pros: ['The clearest hierarchy', 'The most careful details, light and dark'], cons: ['Motion is minimal'] },
      C: { summary: 'Rich motion and depth', pros: ['The best motion, merged into B'], cons: ['Heavier to load', 'Busier hierarchy'] },
      D: { summary: 'Dense and product-led', pros: ['Shows the product early'], cons: ['Feels crowded at laptop size'] },
    }
    const text =
      `**Version B won${crazy ? ' both judging rounds' : ''}**, with the type scale from A${crazy ? ' and the motion from C' : ''} merged in. Below: the versions, the judges' scores, and the winner running.\n\n` +
      uiFence({ type: 'compare', title: 'The versions', options: versions.map((v) => ({ name: `Version ${v}`, summary: notes[v].summary, pros: notes[v].pros, cons: notes[v].cons, score: scores[v], pick: v === 'B' })) }) +
      '\n\n' +
      uiFence({ type: 'chart', kind: 'bar', title: `Judges' scores (of 50)${crazy ? ', final round' : ''}`, x: versions.map((v) => `Version ${v}`), series: [{ name: 'Score', data: versions.map((v) => scores[v]) }], note: 'Five criteria from the rubric, 1 to 10 each' }) +
      '\n\n' +
      '```app title="Version B, the winner" height=520\n' +
      WINNER_PAGE +
      '\n```\n\n' +
      '**Checked:** rendered at phone and laptop sizes in light and dark mode (`designs/b/shots/`), and the judges re-scored the merged version. **Not checked:** how it reads with your real content; the copy is placeholder.\n\n' +
      uiFence({ type: 'choices', prompt: 'What next?', options: [{ label: 'Use version B', detail: 'Copy it into the site' }, { label: 'Refine B once more', detail: 'Another review and fix round' }, { label: 'Show me version A', detail: 'The runner-up, running' }] })
    await this.say(text)
    return text
  }

  /** How a message sent in one of the ways of working plays out. */
  private async modeTurn(mode: string, input: TurnInput): Promise<string | null> {
    if (mode === 'ultra' || mode === 'gocrazy') return this.ultraStart(mode === 'gocrazy', input)
    if (mode === 'quick') {
      const text =
        'Short answer: keep the annual discount at 20%. It is the usual range, and "two months free" is easy to say.\n\n' +
        uiFence({ type: 'stats', items: [{ label: 'Suggested discount', value: '20%' }, { label: 'Usual range', value: '15 to 20%' }, { label: 'Months free', value: 2, hint: 'per year, paid yearly' }] })
      await this.say(text)
      return text
    }
    if (mode === 'plan') {
      await this.think('Plan first: look, lay it out, and wait for a yes before touching anything.', 700)
      await this.tool('Grep', { pattern: 'usePlan' }, 'src/hooks/usePlan.ts\nsrc/pages/Account.tsx', 400)
      await this.say('**The plan**\n\n1. Build the pricing page with three tiers and an annual toggle (a teammate, on a mid-sized model)\n2. Add the checkout endpoint and its webhook, with tests (another teammate, at high effort)\n3. A fresh reviewer goes over the money handling\n4. I run the tests and open the page myself\n\nRoughly 15 minutes and a small part of the allowance. The risk is the webhook trusting its input, which the review is there to catch.')
      const answers = await this.o.host.askQuestion(
        [{ question: 'Go ahead with this plan?', header: 'Plan', options: [{ label: 'Go ahead', description: 'Start the work as laid out' }, { label: 'Change something', description: 'Tell me what to do differently first' }, { label: 'Leave it', description: 'Do not start' }] }],
        new AbortController().signal,
      )
      const pick = answers ? Object.values(answers)[0] : ''
      if (!/go ahead/i.test(pick || '')) {
        const text = pick ? 'Nothing has been started. Tell me what to change and I will redo the plan.' : 'Nothing has been started. The plan is above whenever you want to go ahead.'
        await this.say(text)
        return text
      }
      return null
    }
    if (mode === 'council') {
      await this.think('They want separate answers to compare. Each model answers on its own; mine is written before I read theirs.', 900)
      await this.call('roster', {})
      const text =
        'Three independent answers are in.\n\n' +
        '**Where everyone agrees**\n\n- An annual discount is worth offering, and it should be a round number that is easy to say\n\n' +
        '**Where they differ**\n\n' +
        uiFence({
          type: 'compare',
          options: [
            { name: 'Opus: 20%', summary: '"Two months free"', pros: ['Clarity beats a finer number'], cons: ['Gives up a little margin'], pick: true },
            { name: 'Sonnet: 15%', summary: 'Protect margin first', pros: ['Safer until churn is known'], cons: ['Harder to say in a headline'] },
            { name: 'ChatGPT: 17%', summary: 'The median of comparable products', pros: ['Matches the market'], cons: ['An odd number to advertise'] },
          ],
        }) +
        '\n\n' +
        '**My judgment**\n\n20%. The margin argument is real but small at this size, and the simple message is worth more than three points.\n\n' +
        '**Still uncertain**\n\nNobody had data on your own churn, which is what would settle it.'
      await this.say(text)
      return text
    }
    return null
  }

  private async leadTurn(input: TurnInput): Promise<string> {
    if (/<loop /.test(input.text)) return this.loopRun(input)
    if (/<goal[ -]/.test(input.text)) return this.goalRound(input)
    const mode = /<way-of-working mode="(\w+)"/.exec(input.text)?.[1]
    if (mode) {
      const done = await this.modeTurn(mode, input)
      if (done !== null) return done
    }
    if (input.origin.kind === 'human' && /voice/i.test(input.text)) return this.voices()
    if (input.origin.kind === 'human' && /sign in/i.test(input.text) && this.o.tools.some((t) => t.name === 'browser')) return this.signIn()
    if (input.origin.kind === 'peer') {
      const status = await this.call('task_status', {})
      // The latest work handed out was an Ultra stage: that story carries on instead.
      const latest = [...status.matchAll(/^t(\d+) · [^\n]* · ([^·\n]+)$/gm)].sort((a, b) => Number(b[1]) - Number(a[1]))[0]
      if (latest && /^(Scout|Build|Judge|Critique|Test|Verify|Fact-check|Region|Archive|Images):/.test(latest[2])) return this.ultraReport(status)
      const done =[...status.matchAll(/^t\d+ · done · .+? · (.+)$/gm)].map((m) => m[1])
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
        await this.pause(900)
        await this.call('browser', { action: 'click', ref: Number(annual) })
        await this.pause(900)
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
      await this.pause(500)
      await this.call('computer', { action: 'left_click', coordinate: [640, 300] })
      await this.pause(400)
      await this.call('computer', { action: 'type', text: ['Design review, Thursday 3pm', '- Pricing page', '- Checkout flow'].join('\n') })
      await this.pause(400)
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
    if (/<loop /.test(input.text)) return this.loopRun(input)
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
    // A note from another part of the team, on its own: read, put on the board when it is a decision, and nothing else.
    if (/<team-message/.test(input.text) && !/<task[ -]/.test(input.text)) {
      if (/Decision from/.test(input.text)) await this.call('board_post', { title: 'Decisions', text: (/Decision from [^:]+: ([^\n<]+)/.exec(input.text)?.[1] || '').trim() || 'See the latest note from building.' })
      return this.said('Noted, and on the board.')
    }
    // A stage of an Ultra run: scout, builder or judge.
    const stage = /<task id="[^"]*" from="[^"]*" title="(Scout|Build|Judge|Critique|Test|Verify|Fact-check|Region|Archive|Images):\s*([^"]*)"/.exec(input.text)
    if (stage) return this.ultraStage(stage[1], stage[2], input.text)
    // A helper this agent started inside an Ultra run has reported.
    if (/<task-result[^>]*title="(Critique|Test|Verify|Fact-check|Scout|Build|Judge|Archive):/.test(input.text)) return this.ultraHelped()
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
    const isTask = /<task id="/.test(input.text)
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

  /** One agent's part in an Ultra run: a scout, a builder, a judge, or a helper one of them started. */
  private async ultraStage(kind: string, what: string, text: string): Promise<string> {
    if (kind === 'Region') return this.region(what, text)
    if (kind === 'Images') return this.imageWork(what)
    if (kind === 'Archive') {
      await this.call('board_read', {})
      await this.call('board_post', { title: 'Decisions', text: 'Four versions, A to D, in designs/a to designs/d. Body text at least 4.5:1 contrast. Small motion under 300 ms. Judges see versions by letter, never by author.' })
      return this.said('Done: the decisions so far are on the board under "Decisions", each with why.')
    }
    if (kind === 'Scout') {
      await this.think(`One angle only: ${what}. Sources for everything.`, 500)
      await this.tool('WebSearch', { query: what }, '10 results', 700)
      await this.tool('WebFetch', { url: 'https://www.example.com/showcase' }, 'A gallery of the year\'s strongest work, with notes from the jury.', 600)
      const text = `Done: ${what}.\n\n1. The strongest examples lead with one idea and a lot of space (example.com/showcase, read today)\n2. Type does the work: two sizes, one family, a tight scale (example.org/type, read today)\n3. Nothing moves without a reason; motion stays under 300 ms (example.net/motion, read today)\n\nCould not confirm: how any of them test on slow phones.`
      await this.say(text)
      return text
    }
    if (kind === 'Build') {
      const v = (/version (\w)/i.exec(what)?.[1] || 'A').toLowerCase()
      this.wrote = this.o.account.provider === 'claude'
      const assets = /designs\/assets\//.test(text)
      await this.think(assets ? 'Working to the rubric on the board, with the scouts\' findings and the generated images. My own version, start to finish.' : 'Working to the rubric on the board, with the scouts\' findings. My own version, start to finish.', assets ? 400 : 700)
      if (assets) await this.tool('Read', { file_path: `${this.o.cwd}\\designs\\assets\\hero-2.png` }, 'Read the image (2560×1097)', 300)
      await this.call('board_read', {})
      await this.tool('Write', { file_path: `${this.o.cwd}\\designs\\${v}\\index.html`, content: '<section class="hero">…</section>' }, 'File created', 900)
      await this.tool('Bash', { command: `npx playwright screenshot designs/${v}/index.html --color-scheme light,dark`, description: 'Render the version in light and dark' }, `2 screenshots saved to designs/${v}/shots/`, 800)
      const sample = process.env.ENSEMBLE_DEMO_IMAGE
      if (sample && fs.existsSync(sample)) this.emit({ type: 'image', path: sample })
      // The builder's own cell: a critic on another model, and sometimes a tester, before it submits.
      const V = v.toUpperCase()
      const other = this.o.account.provider === 'claude' ? 'astra' : 'opus'
      const helpers: string[] = []
      if (/start a critic/.test(text)) {
        const ok = await this.helper({
          name: `Critic ${V}`,
          role: `attacks version ${V} before it is submitted`,
          title: `Critique: version ${V}`,
          model: other,
          effort: 'high',
          brief: `Version ${V} is in designs/${v}/ with screenshots in designs/${v}/shots/. You did not make it. Attack it against the rubric on the board: what is weakest, most serious first, each with where it is and the smallest fix.${/may start a fact-checker/.test(text) ? ' Start a fact-checker for the claims your critique leans on.' : ''}`,
        })
        if (ok) helpers.push('critic')
      }
      if (/and a tester/.test(text)) {
        const ok = await this.helper({
          name: `Tester ${V}`,
          role: `renders version ${V} and reports what it sees`,
          title: `Test: version ${V}`,
          model: 'sonnet',
          effort: 'medium',
          brief: `Render designs/${v}/index.html at phone and laptop sizes in light and dark mode, run an accessibility check, and report exactly what you saw: what breaks, what overflows, any contrast failures. Do not change the files.`,
        })
        if (ok) helpers.push('tester')
      }
      if (helpers.length) return this.said(`Draft of version ${V} is in \`designs/${v}/\`. My ${helpers.join(' and ')} ${helpers.length === 1 ? 'is' : 'are'} on it; I submit once their points are answered.`)
      return this.said(`Done: version ${V} is complete in \`designs/${v}/index.html\`, with screenshots in light and dark mode in \`designs/${v}/shots/\`. It scores itself 8 or 9 on every criterion; the weakest is motion, which is minimal.`)
    }
    if (kind === 'Critique') {
      const V = /version (\w)/i.exec(what)?.[1] || 'A'
      await this.think('I did not make this. Looking for what a demanding creative director would reject first.', 600)
      await this.tool('Read', { file_path: `${this.o.cwd}\\designs\\${V.toLowerCase()}\\index.html` }, '<section class="hero">…</section>', 400)
      if (/start a fact-checker/i.test(text)) {
        const ok = await this.helper({
          name: `Fact-checker ${V}`,
          role: `checks the claims in the critique of version ${V}`,
          title: `Fact-check: critique of version ${V}`,
          model: 'haiku',
          effort: 'medium',
          brief: 'The critique leans on two claims: that body text needs at least 4.5:1 contrast, and that small interface motion over 300 ms reads as slow. Check each at the primary source, with a link and a date, and say whether it holds.',
        })
        if (ok) return this.said(`First notes on version ${V} are in. A fact-checker is confirming the two claims they lean on; my critique follows once it reports.`)
      }
      return this.said(`Critique of version ${V}, most serious first:\n\n1. The secondary text is too faint in dark mode (about 3.8:1); raise it to 4.5:1\n2. The hero headline wraps to three lines on a phone; tighten it or step the size down\n3. The pricing cards' hover lifts by 8 px and feels loose; 2 px is enough`)
    }
    if (kind === 'Test') {
      const v = (/version (\w)/i.exec(what)?.[1] || 'A').toLowerCase()
      await this.tool('Bash', { command: `npx playwright screenshot designs/${v}/index.html --viewport 390x844,1440x900 --color-scheme light,dark`, description: 'Render at phone and laptop sizes, light and dark' }, `4 screenshots saved to designs/${v}/tested/`, 800)
      await this.tool('Bash', { command: `npx axe designs/${v}/index.html`, description: 'Run an accessibility check' }, '1 issue: color-contrast on .muted (3.8:1)', 600)
      return this.said(`Rendered version ${v.toUpperCase()} at 390 and 1440 px, light and dark (\`designs/${v}/tested/\`). Nothing overflows. One accessibility failure: \`.muted\` text is 3.8:1 in dark mode.`)
    }
    if (kind === 'Verify') {
      await this.think("Checking each score against what the screenshots really show, not against the judge's words.", 600)
      await this.tool('Read', { file_path: `${this.o.cwd}\\designs\\b\\shots\\dark.png` }, '[image]', 400)
      return this.said("Verified. The scores match the screenshots, with one correction: B's craft is a 9 in dark mode, not a 10, because of a faint caption. B still leads.")
    }
    if (kind === 'Fact-check') {
      await this.tool('WebSearch', { query: 'WCAG 2.2 contrast minimum body text' }, '10 results', 600)
      await this.tool('WebFetch', { url: 'https://www.w3.org/TR/WCAG22/#contrast-minimum' }, 'Success Criterion 1.4.3: at least 4.5:1 for normal text.', 600)
      return this.said('Both claims hold.\n\n1. 4.5:1 for body text: WCAG 2.2, criterion 1.4.3 (w3.org/TR/WCAG22, read today)\n2. Small interface motion reads as slow past about 300 ms: platform motion guidelines put small transitions at 100 to 300 ms (read today)')
    }
    // A judge. The first judge when going crazy has its scores verified before it reports.
    await this.think('I built none of these. Scoring each one against the rubric, criterion by criterion.', 700)
    await this.call('board_read', {})
    await this.tool('Read', { file_path: `${this.o.cwd}\\designs\\a\\index.html` }, '<section class="hero">…</section>', 400)
    await this.tool('Read', { file_path: `${this.o.cwd}\\designs\\b\\index.html` }, '<section class="hero">…</section>', 400)
    if (/start a verifier/i.test(text)) {
      const ok = await this.helper({
        name: 'Verifier',
        role: "checks the judge's scores against the screenshots",
        title: `Verify: ${what}`,
        model: 'sonnet',
        effort: 'high',
        brief: 'Draft scores (of 50): A 43, B 46, C 42, D 42. Check each against the screenshots in designs/a/shots/ to designs/d/shots/, not against my words, and say where a score is wrong and why.',
      })
      if (ok) return this.said('Draft scores are in. A verifier is checking them against the screenshots; I report once it is done.')
    }
    return this.said(`Done (${what}).\n\n| Version | Total of 50 |\n| --- | --- |\n| A | 43 |\n| **B** | **46** |\n\nBest: **B**, for the clearest hierarchy and the most careful details. Worth taking from A: its type scale.`)
  }

  /** Going crazy: the lead of one region starts its own team from the lines in its brief. */
  private async region(what: string, text: string): Promise<string> {
    const other = (r: string): string | undefined => new RegExp(`${r} ([^;.\\n]+)`).exec(/Other regions: ([^\n]+)/.exec(text)?.[1] || '')?.[1]?.trim()
    const ask = /Request: ([^\n]+)/.exec(text)?.[1] || 'the request'
    if (what === 'research') {
      await this.think('My region is research: one scout per angle, none overlapping, sources for everything.', 600)
      const lines = [...text.matchAll(/^- (Scout \d+) on (\S+): (.+)$/gm)]
      for (const m of lines) await this.helperId({ name: m[1], role: `scouts ${m[3]}`, title: `Scout: ${m[3]}`, model: m[2], effort: 'medium', brief: `Request: ${ask}\n\nYour one angle: ${m[3]}. Report up to six findings, each with a link and the date you read it, and say what you could not confirm.` })
      return this.said(`${lines.length} scouts are out, one angle each. I report once all are in.`)
    }
    if (what === 'memory') {
      await this.call('board_read', {})
      await this.call('board_post', { title: 'Findings', text: 'From research: lead with one idea and a lot of space (example.com/showcase); two type sizes, one family (example.org/type); motion under 300 ms (example.net/motion). All read today.' })
      const ok = await this.helperId({ name: 'Archivist', role: 'writes the decisions to the board as they are made', title: 'Archive: decisions', model: 'haiku', effort: 'medium', brief: 'Read the board and the reports so far, and pin the decisions made, each with why, under "Decisions".' })
      return this.said(ok !== undefined ? 'The findings are on the board. An archivist is writing up the decisions; I report once it is done.' : 'The findings are on the board.')
    }
    if (what === 'building') {
      await this.think('My region is building: four complete versions, each a small cell with its own critic.', 600)
      const lines = [...text.matchAll(/^- (Builder (\w)) on (\S+) at (\w+)$/gm)]
      for (const [i, m] of lines.entries()) {
        const tester = i < 2
        const cell = `Before you submit, start a critic on a different model to attack your draft${tester ? ', and a tester that renders it and reports what it saw' : ''}; answer the critic's points first.${i === 0 ? ' Your critic may start a fact-checker for the claims it leans on.' : ''}`
        await this.helperId({ name: m[1], role: `builds version ${m[2]}`, title: `Build: version ${m[2]}`, model: m[3], effort: m[4], brief: `Request: ${ask}\n\nMake a complete version of your own, working to the rubric on the board and using the research findings. Do not look at the other versions. Work in designs/${m[2].toLowerCase()}/ only.${/designs\/assets\//.test(text) ? ' Build with the generated images in designs/assets/ (the moodboard and the hero): use them as files and as references.' : ''} Render it and take a screenshot in light and dark mode. ${cell} Report the path and the screenshots.` })
      }
      // A lateral link: building tells memory a decision directly, not through the lead.
      const memory = other('memory')
      const last = lines.length ? lines[lines.length - 1][2] : 'D'
      if (memory) await this.call('message', { to: memory, text: `Decision from building: ${lines.length} versions, A to ${last}, each in its own folder under designs/. Please keep it on the board.` })
      return this.said(`${lines.length} builders are at work, each with its own critic. I report once all versions are in.`)
    }
    // The judging region.
    await this.think('My region is judging: two rounds, fresh judges in the second, scores checked against the evidence.', 600)
    const lines = [...text.matchAll(/^- (Judge \d+) on (\S+) at (\w+), round (\d)$/gm)]
    const round1: string[] = []
    for (const [i, m] of lines.entries()) {
      const id = await this.helperId({
        name: m[1],
        role: m[4] === '1' ? 'judges the versions against the rubric' : 'judges the final round, fresh',
        title: `Judge: round ${m[4]}`,
        model: m[2],
        effort: m[3],
        after: m[4] === '1' ? [] : round1,
        brief: `You did none of this work. Score every version (A, B, C, D) on each rubric criterion from 1 to 10 with a reason, name the best version, and list the best ideas in the others.${m[4] === '2' ? ' Round one has judged already; judge the improved versions afresh.' : ''}${i === 0 ? ' Start a verifier who checks your scores against the screenshots before you report.' : ''}`,
      })
      if (id && m[4] === '1') round1.push(id)
    }
    return this.said(`${lines.length} judges are lined up in two rounds. I report once the final round is in.`)
  }

  /** Starts an agent of this one's own: its task id, '' when it started with no task, undefined when it could not start. */
  private async helperId(args: Record<string, unknown>): Promise<string | undefined> {
    if (this.stopped || !this.o.tools.some((t) => t.name === 'spawn_agent')) return undefined
    let r = await this.call('spawn_agent', args)
    if (!/joined the chat/.test(r)) r = await this.call('spawn_agent', { ...args, model: undefined, effort: undefined })
    return /joined the chat/.test(r) ? /Task (t\d+)/.exec(r)?.[1] || '' : undefined
  }

  /** The image agent of a design run: a moodboard of directions, then the hero in variations, saved where the builders read them. */
  private async imageWork(what: string): Promise<string> {
    const sample = process.env.ENSEMBLE_DEMO_IMAGE
    const show = (): void => {
      if (sample && fs.existsSync(sample)) this.emit({ type: 'image', path: sample })
    }
    await this.think('Three clearly different directions first, then the hero in the one that fits the rubric, at the size the layout needs.', 400)
    await this.tool('ImageGen', { prompt: 'Moodboard, three directions for a landing page: editorial calm, bold geometric, soft gradient. 16:9 each, no text.' }, 'Generated 3 images', 700)
    show()
    await this.tool('ImageGen', { prompt: 'Hero, 2560×1097: one product object on a quiet surface, soft window light from the left, the rubric palette, generous empty space on the right for the headline; no text, no stock clichés.' }, 'Generated 3 variations', 700)
    show()
    await this.tool('Shell', { command: 'Copy-Item moodboard-*.png, hero-*.png designs/assets/' }, '', 250)
    await this.call('board_post', { title: 'Images', text: 'Generated with ChatGPT image generation (label them as generated): moodboard-1 to 3 (editorial calm, bold geometric, soft gradient) and hero-1 to 3 (2560×1097) in designs/assets/. hero-2 fits the rubric best.' })
    return this.said(`Done: ${what}.\n\n- Moodboard, three directions: \`designs/assets/moodboard-1.png\` to \`moodboard-3.png\` (editorial calm, bold geometric, soft gradient)\n- Hero, three variations at 2560×1097: \`designs/assets/hero-1.png\` to \`hero-3.png\`; hero-2 fits the rubric best\n\nAll of them are generated images, noted as such on the board.`)
  }

  private async said(text: string): Promise<string> {
    await this.say(text)
    return text
  }

  /** Starts a helper of this agent's own inside an Ultra run; false when the chat allows no deeper level. */
  private async helper(args: Record<string, unknown>): Promise<boolean> {
    if (this.stopped || !this.o.tools.some((t) => t.name === 'spawn_agent')) return false
    // Refused for the model (a Claude model on a team of ChatGPT accounts): the answer says why, so try again on the account's usual model.
    let r = await this.call('spawn_agent', args)
    if (!/joined the chat/.test(r) && args.model && !/deepest level|limit|already has/i.test(r)) r = await this.call('spawn_agent', { ...args, model: undefined, effort: undefined })
    return /joined the chat/.test(r)
  }

  /** A builder, judge or critic hears from a helper it started: waits for the rest, then submits. */
  private async ultraHelped(): Promise<string> {
    const status = await this.call('task_status', {})
    const mine = [...status.matchAll(/^t\d+ · (\w+)[^·\n]* · .+? · ((Critique|Test|Verify|Fact-check|Scout|Build|Judge|Archive):[^\n]*)$/gm)].map((m) => ({ status: m[1], title: m[2], kind: m[3] }))
    const open = mine.filter((t) => !/^(done|failed|cancelled)$/.test(t.status))
    if (open.length) {
      const who = [...new Set(open.map((t) => (t.kind === 'Critique' ? 'the critic' : t.kind === 'Test' ? 'the tester' : t.kind === 'Verify' ? 'the verifier' : t.kind === 'Fact-check' ? 'the fact-checker' : t.kind === 'Scout' ? 'the other scouts' : t.kind === 'Build' ? 'the other builders' : t.kind === 'Judge' ? 'the other judges' : 'the archivist')))]
      return this.said(`Got one report; waiting on ${who.join(' and ')}.`)
    }
    const kinds = new Set(mine.map((t) => t.kind))
    // A region's lead: its whole team is in.
    if (kinds.has('Scout')) {
      await this.call('board_read', {})
      return this.said(`Research region: all ${mine.length} scouts are in. The strongest examples lead with one idea and a lot of space; type does the work with a tight scale; motion stays under 300 ms. Every finding has a link and a date; memory has them on the board. Could not confirm: how any of them test on slow phones.`)
    }
    if (kinds.has('Build')) return this.said(`Building region: all ${mine.length} versions are complete in \`designs/a/\` to \`designs/${String.fromCharCode(96 + mine.length)}/\`, each cleared by its own critic before it was submitted, with screenshots in light and dark mode.`)
    if (kinds.has('Judge')) return this.said('Judging region: both rounds are in. **B** won both, 46 of 50 in the final round (verified against the screenshots). Worth taking from A: its type scale; from C: its motion.')
    if (kinds.has('Archive')) return this.said('Memory region: the board holds the rubric, the findings with their sources, and the decisions so far, with why. I keep it current as the regions report.')
    const V = /version (\w)/i.exec(mine[0]?.title || '')?.[1] || 'A'
    if (kinds.has('Fact-check')) {
      return this.said(`Critique of version ${V}, most serious first, with both claims confirmed by the fact-checker:\n\n1. The secondary text is too faint in dark mode (3.8:1; WCAG 1.4.3 asks 4.5:1)\n2. The hero headline wraps to three lines on a phone\n3. The cards' hover lift of 8 px reads as loose; 2 px is enough`)
    }
    if (kinds.has('Verify')) {
      return this.said('Done (round 1), with the scores verified against the screenshots.\n\n| Version | Total of 50 |\n| --- | --- |\n| A | 43 |\n| **B** | **45** |\n| C | 42 |\n| D | 42 |\n\nBest: **B**. Worth taking from A: its type scale; from C: its motion.')
    }
    await this.think("My critic's points first: contrast, the headline on a phone, the hover.", 600)
    await this.tool('Edit', { file_path: `${this.o.cwd}\\designs\\${V.toLowerCase()}\\index.html`, old_string: '.muted { opacity: .55 }', new_string: '.muted { opacity: .72 }' }, 'Applied 1 edit', 600)
    return this.said(`Done: version ${V} is complete in \`designs/${V.toLowerCase()}/index.html\`. My ${kinds.has('Test') ? 'critic and tester' : 'critic'} found ${kinds.has('Test') ? 'a contrast failure and a long headline' : 'three weak spots'}; all are fixed and re-rendered in light and dark (\`designs/${V.toLowerCase()}/shots/\`).`)
  }

  async interrupt(): Promise<void> {
    this.stopped = true
    this.steerIn = []
    for (const wake of [...this.wakers]) wake()
  }

  async setPermission(_level: PermissionLevel): Promise<void> {}

  async rewind(_checkpoint: string, _apply: boolean): Promise<RewindPreview> {
    await wait(300)
    return { ok: true, files: [`${this.o.cwd}\\src\\pages\\Pricing.tsx`, `${this.o.cwd}\\src\\routes.tsx`], added: 3, removed: 99 }
  }

  dispose(): void {
    this.disposed = true
    this.stopped = true
    for (const wake of [...this.wakers]) wake()
  }
}
