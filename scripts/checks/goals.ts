import type { Account, Chat, Goal, Item, Settings, Task } from '../../src/shared/types'
import { isLimitNotice, isLimitText } from '../../src/shared/limits'
import { goalLine } from '../../src/shared/auto'
import { Autopilot, type AutoHost } from '../../src/main/autopilot'
import { ClaudeRuntime } from '../../src/main/providers/claude'
import type { Ctx } from './ctx'

// Goals that finish. Each block below is a way a real goal went wrong in Kerim's chats on
// 2026-11-19 and 2026-11-20 (read from the installed app's data, read-only):
//  - a goal of 50 rounds was "stopped rather than left to spin" at round 2 while the team was
//    still working, because the check ran when the lead stopped typing and saw only its last reply;
//  - a goal sat "active" for 13 hours with no check, because a task was marked as under way that
//    nobody was working on (its owner had become the lead);
//  - a goal was paused each time the lead changed, and the lead's "You've hit your Fable limit"
//    replies were taken for ordinary answers.

type Row = Record<string, unknown>

class FakeSession {
  items: Item[] = []
  busy = false
  state = { queued: 0 }
  sent: string[] = []
  constructor(
    public chat: Chat,
    public account: Account,
  ) {}
  add(it: Item): void {
    this.items.push(it)
  }
  enqueue(p: { text: string }): void {
    this.sent.push(p.text)
    this.state.queued++
  }
}

/** A goal engine on a stand-in chat whose clock, team and checker the checks control. */
function bench(opts: { handover?: boolean } = {}) {
  const real = Date.now
  let now = real()
  Date.now = () => now
  const a = { id: 'lead-a', name: 'Ada', provider: 'claude', enabled: true } as unknown as Account
  const b = { id: 'lead-b', name: 'Ben', provider: 'chatgpt', enabled: true } as unknown as Account
  const chat = { id: 'c-goals', title: 'Goals', cwd: 'C:\\work', loops: [], goal: null } as unknown as Chat
  const sessions = new Map<string, FakeSession>([
    [a.id, new FakeSession(chat, a)],
    [b.id, new FakeSession(chat, b)],
  ])
  const st = {
    lead: a as Account | null,
    under: { tasks: 0, agents: 0 },
    out: {} as Record<string, { why: string; until?: number } | null>,
    verdicts: [] as (string | Promise<string>)[],
    judged: [] as string[],
    told: [] as string[],
  }
  const settings = { goalRounds: 12, goalCheck: 'fresh', handover: !!opts.handover } as unknown as Settings
  const host: AutoHost = {
    demo: false,
    settings: () => settings,
    chats: () => [chat],
    chat: () => chat,
    lead: () => st.lead,
    account: (id) => [a, b].find((x) => x.id === id),
    unavailable: (acc) => st.out[acc.id] || null,
    session: (_c, acc) => sessions.get(acc.id) as never,
    out: () => st.under.tasks,
    under: () => ({ ...st.under }),
    sweep: () => 0,
    changed: () => {},
    preface: () => ({ text: '', itemIds: [] }),
    tell: (title) => void st.told.push(title),
    stop: async () => {},
    judge: async (_system, prompt) => {
      st.judged.push(prompt)
      return (await st.verdicts.shift()) ?? '{"met": false, "blocked": false, "why": "It is not shown to work yet.", "next": "Run it."}'
    },
    loopRun: () => undefined as never,
  }
  const auto = new Autopilot(host)
  let n = 0
  const row = (s: FakeSession, r: Row): void => s.add({ id: `i${++n}`, ts: now, ...r } as unknown as Item)
  /** One reply of an agent, as the app would have recorded it, and the engine told that it ended. */
  const turn = (who: Account, t: { text?: string; tools?: [string, Row, string][]; reports?: [string, string][]; handed?: string[]; status?: 'done' | 'error' | 'interrupted'; reason?: string; error?: string; kind?: string } = {}): void => {
    const s = sessions.get(who.id)!
    s.state.queued = 0
    now += 1000
    for (const [name, input, output] of t.tools || []) row(s, { kind: 'tool', name, input, output, status: 'done' })
    for (const title of t.handed || []) row(s, { kind: 'delegate', title, to: b.id })
    for (const [title, text] of t.reports || []) row(s, { kind: 'peer', tag: 'result', title, text, status: 'done', from: b.id })
    if (t.text) row(s, { kind: 'assistant', text: t.text })
    row(s, { kind: 'turn', status: t.status || 'done' })
    now += 1000
    auto.afterTurn(s as never, { kind: t.kind || 'user', text: '', itemIds: [], origin: { kind: 'human' } } as never, { status: t.status || 'done', resultText: t.text || '', durationMs: 1000, steps: 1, tools: (t.tools || []).length, reason: t.reason, error: t.error } as never)
  }
  const tick = (): void => (auto as unknown as { tick(): void }).tick()
  /** Lets a check that is under way come back. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
  }
  const goal = (text: string, extra: Partial<Goal> = {}): Goal => {
    const g = auto.setGoal(chat, { text, ...extra } as never).goal
    now += 1000
    return g
  }
  return {
    a,
    b,
    chat,
    st,
    auto,
    turn,
    tick,
    settle,
    goal,
    session: (who: Account) => sessions.get(who.id)!,
    ahead: (ms: number) => void (now += ms),
    rows: (who: Account) => sessions.get(who.id)!.items.filter((i) => i.kind === 'auto').map((i) => (i as unknown as { title: string }).title),
    done: () => void (Date.now = real),
  }
}

const NOT_MET = '{"met": false, "blocked": false, "why": "The page is built but nothing shows the tests were run.", "next": "Run the tests."}'
const MET = '{"met": true, "blocked": false, "why": "The tests were run and pass, and the page was opened."}'

export default async function goals(c: Ctx): Promise<void> {
  const { check, same } = c

  // ───── the provider's own "out of allowance" notice, in the wording that got through ─────
  {
    const fable = "You've hit your Fable limit · resets Nov 21, 5pm (Europe/Warsaw). Switch to another model to continue."
    check('"You\'ve hit your Fable limit" is read as a usage limit', isLimitText(fable) && isLimitNotice(fable))
    check('so are the older wordings', ['Usage limit reached.', 'Claude AI usage limit reached|1763730000', 'Rate limit exceeded', "You've hit your limit · resets 5pm", 'You have reached your weekly limit.'].every(isLimitText))
    check('a reply that only mentions limits is not a limit notice', !isLimitNotice('I raised the rate limit on the endpoint to 50 a minute and the tests pass.') && !isLimitNotice(`${fable} ${'x'.repeat(400)}`))
    check('ordinary errors are not limits', !isLimitText('socket hang up') && !isLimitText('The page could not be reached.'))
  }

  // ───── a result that is not the reply's own does not end the reply ─────
  // Seen 2026-11-20: a task was closed with "Finished, but left no report" by a result of 0 steps
  // and 231 ms that arrived 14 s before the agent's first words; the agent then worked on, unheard.
  {
    const events: { type: string; status?: string; resultText?: string; reason?: string }[] = []
    const fresh = (): { onMessage(m: unknown): void } & Record<string, unknown> => {
      const rt = Object.create(ClaudeRuntime.prototype) as { onMessage(m: unknown): void } & Record<string, unknown>
      Object.assign(rt, { o: { host: { emit: (ev: { type: string }) => void events.push(ev) } }, disposed: false, interrupted: false, inTurn: true, turnStart: Date.now(), lastError: null, pendingText: [], pendingThinking: [], blocks: new Map(), seenTools: new Set(), steered: new Set(), steerWait: null, swallow: 0, swallowUntil: 0, edited: false, moved: false, typed: false, strayWait: null, turnId: 'u1', q: null })
      rt.reportContext = async () => {}
      return rt
    }
    const ends = (): typeof events => events.filter((e) => e.type === 'turn-end')
    const stray = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', duration_ms: 231 }
    const real = { type: 'result', subtype: 'success', is_error: false, num_turns: 7, result: 'Measured it: 34 writes a minute before, 6 after.', duration_ms: 90_000 }

    let rt = fresh()
    rt.onMessage(stray)
    same('a result with no step and no text does not end the reply', [ends().length, rt.inTurn], [0, true])
    rt.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Measured it.' }] }, parent_tool_use_id: null })
    rt.onMessage(real)
    check("the reply's own result does, with its text", ends().length === 1 && ends()[0].status === 'done' && /34 writes a minute before/.test(ends()[0].resultText || ''), JSON.stringify(ends()))
    clearTimeout(rt.strayWait as NodeJS.Timeout)

    events.length = 0
    rt = fresh()
    rt.typed = true
    rt.onMessage(stray)
    same('a typed command may end with no step and no text', ends().length, 1)

    events.length = 0
    rt = fresh()
    rt.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello.' }] }, parent_tool_use_id: null })
    rt.onMessage({ ...stray, num_turns: 1 })
    same('a reply that produced something ends on its result even when the result is empty', ends().length, 1)

    events.length = 0
    rt = fresh()
    rt.onMessage({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: "You've hit your Fable limit · resets Nov 21, 5pm (Europe/Warsaw). Switch to another model to continue.", duration_ms: 300 })
    check('a limit notice that arrives as an ordinary answer ends the reply as out of allowance', ends().length === 1 && ends()[0].status === 'error' && ends()[0].reason === 'limit', JSON.stringify(ends()))
  }

  // ───── the window says what an idle-looking goal waits for ─────
  {
    const g = { id: 'G', text: 'x', status: 'active', round: 0, maxRounds: 12, check: 'fresh', createdAt: 0, log: [] } as Goal
    same('working', goalLine(g), 'Working on it')
    same('waiting for the team, first round', goalLine({ ...g, waiting: 'team' }), 'Waiting for the team')
    same('waiting for the team, later round', goalLine({ ...g, round: 2, waiting: 'team' }), 'Round 3 of 12 · waiting for the team')
    same('a failed reply being tried again', goalLine({ ...g, round: 1, waiting: 'retry' }), 'Round 2 of 12 · a reply failed, trying again shortly')
    same('a check under way wins', goalLine({ ...g, checking: true, waiting: 'team' }), 'Checking whether it is done')
    same('paused for allowance', goalLine({ ...g, status: 'paused', waiting: 'allowance' }), 'Waiting for the allowance to come back')
    same('paused by the user', goalLine({ ...g, status: 'paused' }), 'Paused')
  }

  // ───── a check is made when the team's work is in, and judges all of it ─────
  {
    const t = bench()
    try {
      const g = t.goal('Ship the pricing page', { doneWhen: 'the tests pass' })
      t.st.under.tasks = 2
      t.turn(t.a, { text: 'I split it: the page and its tests are with the team.', handed: ['Build the pricing page', 'Write the tests'] })
      await t.settle()
      same('no check while the team still has work under way', [t.st.judged.length, g.round, g.status], [0, 0, 'active'])
      same('and the goal says what it waits for', g.waiting, 'team')
      t.ahead(20 * 60_000)
      t.tick()
      t.tick()
      same('waiting for the team for twenty minutes neither checks nor pauses it', [t.st.judged.length, g.status], [0, 'active'])
      t.st.under.tasks = 1
      t.turn(t.a, { reports: [['Build the pricing page', 'Built src/pages/Pricing.tsx with three tiers and the annual toggle.']] })
      await t.settle()
      same('a reply that only takes in one report is not a round', [t.st.judged.length, g.round], [0, 0])
      t.st.under.tasks = 0
      t.st.verdicts.push(NOT_MET)
      t.turn(t.a, { text: 'Both parts are in.', reports: [['Write the tests', 'Wrote 12 tests for the toggle.']], tools: [['Read', { file_path: 'C:\\work\\src\\pages\\Pricing.tsx' }, 'export function Pricing() {}']] })
      await t.settle()
      same('one check once everything is in, and one round used for three replies', [t.st.judged.length, g.round, g.log.length], [1, 1, 1])
      const p = t.st.judged[0]
      check('the checker sees the whole stretch: what was handed out', /Handed out the task "Build the pricing page"/.test(p), p.slice(0, 400))
      check('… both reports that came back', /Build the pricing page.*Built src\/pages\/Pricing\.tsx/s.test(p) && /Write the tests.*Wrote 12 tests/s.test(p))
      check('… and the earlier replies, not only the last', /Earlier replies since the last check/.test(p) && /I split it/.test(p) && /Both parts are in/.test(p))
      check('the lead is sent back with what is missing', /<goal-check round="2"/.test(t.session(t.a).sent.at(-1) || '') && /nothing shows the tests were run/.test(t.session(t.a).sent.at(-1) || ''))
      same('nothing is waited for any more', g.waiting || null, null)
      t.st.verdicts.push(MET)
      t.turn(t.a, { text: 'Ran npm test: 87 of 87 pass. Opened the page.', tools: [['Bash', { command: 'npm test' }, 'Tests  87 passed (87)']] })
      await t.settle()
      same('met on the second check', [g.status, g.log.map((l) => l.met)], ['met', [false, true]])
      check('the second check sees only what came after the first', !/I split it/.test(t.st.judged[1]) && /npm test/.test(t.st.judged[1]), t.st.judged[1].slice(0, 300))
    } finally {
      t.done()
    }
  }

  // ───── a last reply with no text does not blank the report ─────
  {
    const t = bench()
    try {
      const g = t.goal('Fix the toggle')
      t.st.under.tasks = 1
      t.turn(t.a, { text: 'Fixed the toggle and ran npm test: 87 of 87 pass.', tools: [['Bash', { command: 'npm test' }, 'Tests  87 passed (87)']] })
      t.st.under.tasks = 0
      t.st.verdicts.push(MET)
      t.turn(t.a, { reports: [['Review the fix', 'The fix is right.']] })
      await t.settle()
      check('the report is the last reply that said something', /Fixed the toggle and ran npm test/.test(t.st.judged[0] || '') && !/the replies had no text/.test(t.st.judged[0] || ''), (t.st.judged[0] || '').slice(-400))
      same('and the goal is met', g.status, 'met')
    } finally {
      t.done()
    }
  }

  // ───── "no work done" means nobody did anything, not that the lead only read reports ─────
  {
    const t = bench()
    try {
      const g = t.goal('Make every page world class', { maxRounds: 50 } as never)
      for (let i = 0; i < 3; i++) {
        t.st.verdicts.push(NOT_MET)
        t.turn(t.a, { text: 'Noted.', reports: [[`Polish page ${i + 1}`, `Page ${i + 1} is redone and passes the critic.`]] })
        await t.settle()
      }
      same('three rounds where the team did the work and the lead said little: still going', [g.status, g.round], ['active', 3])
      const spin = t.goal('Write the summary', { maxRounds: 50 } as never)
      for (let i = 0; i < 2; i++) {
        t.st.verdicts.push(NOT_MET)
        t.turn(t.a, { text: 'It is done.' })
        await t.settle()
      }
      check('two rounds in which nobody did anything at all: stopped, with the reason', spin.status === 'stopped' && /no work done/.test(spin.note || ''), `${spin.status}: ${spin.note}`)
    } finally {
      t.done()
    }
  }

  // ───── teammates mid-reply without a task hold the check for a few minutes, not for ever ─────
  {
    const t = bench()
    try {
      const g = t.goal('Tidy the docs')
      t.st.under.agents = 1
      t.turn(t.a, { text: 'Tidied the docs.', tools: [['Edit', { file_path: 'C:\\work\\README.md' }, 'File updated']] })
      await t.settle()
      t.ahead(60_000)
      t.tick()
      await t.settle()
      same('a teammate still replying: the check waits', t.st.judged.length, 0)
      t.ahead(3 * 60_000)
      t.st.verdicts.push(MET)
      t.tick()
      t.ahead(4000)
      t.tick()
      await t.settle()
      same('after three minutes it goes ahead', [t.st.judged.length, g.status], [1, 'met'])
    } finally {
      t.done()
    }
  }

  // ───── a change of lead does not stop a goal ─────
  {
    const t = bench()
    try {
      const g = t.goal('Ship the checkout')
      t.st.verdicts.push(NOT_MET)
      t.turn(t.a, { text: 'Built the checkout.', tools: [['Write', { file_path: 'C:\\work\\Checkout.tsx' }, 'File created']] })
      await t.settle()
      t.session(t.a).state.queued = 0 // the old lead never got to its next round
      const round = g.round
      t.st.lead = t.b
      t.auto.leadChanged(t.chat, t.b)
      same('the user gave the chat a new lead: the goal stays in play', g.status, 'active')
      check('the transcript says so', t.rows(t.b).some((r) => /Goal carries on with Ben as lead/.test(r)), t.rows(t.b).join(' | '))
      t.tick()
      const sent = t.session(t.b).sent.at(-1) || ''
      check('the new lead is sent to the goal', /You lead this chat now, and its goal is in play/.test(sent) && /Goal: Ship the checkout/.test(sent), sent.slice(0, 200))
      same('which uses up no round', g.round, round)
      const brief = t.auto.brief(t.chat)
      check('the handover tells the new lead the goal, its last check and how it is checked', /Ship the checkout/.test(brief) && /nothing shows the tests were run/.test(brief) && /goal_report/.test(brief), brief)
      t.st.verdicts.push(MET)
      t.turn(t.b, { text: 'Ran the tests: all pass.', tools: [['Bash', { command: 'npm test' }, 'Tests  40 passed (40)']] })
      await t.settle()
      same('and finishes it', g.status, 'met')
    } finally {
      t.done()
    }
  }
  {
    const t = bench()
    try {
      const g = t.goal('Ship the footer')
      let answer: (v: string) => void = () => {}
      t.st.verdicts.push(new Promise<string>((r) => (answer = r)))
      t.turn(t.a, { text: 'Built the footer.', tools: [['Write', { file_path: 'C:\\work\\Footer.tsx' }, 'File created']] })
      await t.settle()
      check('a check is under way', g.checking === true)
      t.st.lead = t.b
      t.auto.leadChanged(t.chat, t.b)
      answer(NOT_MET)
      await t.settle()
      same('the lead changed during the check: its verdict stands and the goal goes on', [g.status, g.round, g.log.length], ['active', 1, 1])
      check('what is missing goes to whoever leads now', /nothing shows the tests were run/.test(t.session(t.b).sent.at(-1) || '') && !t.session(t.a).sent.length, `${t.session(t.a).sent.length} ${t.session(t.b).sent.length}`)
    } finally {
      t.done()
    }
  }

  // ───── a lead out of allowance: the goal waits and carries on by itself ─────
  {
    const t = bench({ handover: true })
    try {
      const g = t.goal('Ship the header')
      t.turn(t.a, { status: 'error', reason: 'limit', error: "You've hit your Fable limit · resets 5pm" })
      same('with automatic handover on, the goal is not paused when the lead runs out', g.status, 'active')
      t.st.lead = t.b
      t.auto.leadChanged(t.chat, t.b, t.a)
      t.tick()
      check('the lead the app put in carries it on', g.status === 'active' && /its goal is in play/.test(t.session(t.b).sent.at(-1) || ''), `${g.status} ${t.session(t.b).sent.at(-1)}`)
    } finally {
      t.done()
    }
  }
  {
    const t = bench({ handover: true })
    try {
      const g = t.goal('Ship the header')
      t.turn(t.a, { status: 'error', reason: 'limit', error: 'Usage limit reached.' })
      t.st.out[t.a.id] = { why: 'out of allowance', until: Date.now() + 3600e3 }
      t.ahead(20_000)
      t.tick()
      same('nobody has taken over yet: still in play', g.status, 'active')
      t.ahead(30_000)
      t.tick()
      check('nobody took over: it waits for the refill, and says it will carry on by itself', g.status === 'paused' && g.waiting === 'allowance' && /carries on by itself when it is back/.test(g.note || ''), `${g.status} ${g.waiting} ${g.note}`)
      t.ahead(60 * 60_000)
      t.tick()
      same('still out: still waiting', g.status, 'paused')
      t.st.out[t.a.id] = null
      const round = g.round
      t.tick()
      check('the allowance is back: in play again without anyone pressing Resume', g.status === 'active' && t.rows(t.a).some((r) => /Goal going again: the allowance is back/.test(r)), `${g.status} | ${t.rows(t.a).join(' | ')}`)
      t.tick()
      check('and the lead is sent back to it, with no round used', /The usage allowance is back/.test(t.session(t.a).sent.at(-1) || '') && g.round === round, t.session(t.a).sent.at(-1))
    } finally {
      t.done()
    }
  }
  {
    const t = bench()
    try {
      const g = t.goal('Ship the header')
      t.st.out[t.a.id] = { why: 'out of allowance' }
      t.turn(t.a, { status: 'error', reason: 'limit', error: 'Usage limit reached.' })
      check('with handover off it waits for the refill at once', g.status === 'paused' && g.waiting === 'allowance', `${g.status} ${g.waiting}`)
      t.st.lead = t.b
      t.auto.leadChanged(t.chat, t.b)
      check('giving the chat a lead with allowance sets it going again', g.status === 'active' && t.rows(t.b).some((r) => /Goal going again with Ben as lead/.test(r)), `${g.status} | ${t.rows(t.b).join(' | ')}`)
    } finally {
      t.done()
    }
  }

  // ───── a reply that failed for a passing reason is tried again before the user is asked ─────
  {
    const t = bench()
    try {
      const g = t.goal('Ship the sidebar')
      t.turn(t.a, { status: 'error', reason: 'other', error: 'socket hang up' })
      check('one failed reply does not pause the goal', g.status === 'active' && g.waiting === 'retry' && t.rows(t.a).some((r) => /A reply failed: trying again in a minute/.test(r)), `${g.status} ${g.waiting} | ${t.rows(t.a).join(' | ')}`)
      t.ahead(30_000)
      t.tick()
      same('not before the minute is up', t.session(t.a).sent.length, 0)
      t.ahead(31_000)
      t.tick()
      const sent = t.session(t.a).sent.at(-1) || ''
      check('then the lead is sent back, told what happened', /stopped with a problem before it finished \(socket hang up\)/.test(sent), sent.slice(0, 200))
      same('with no round used', g.round, 0)
      t.turn(t.a, { status: 'error', reason: 'other', error: 'socket hang up' })
      same('a second failure in a row is tried again too', g.status, 'active')
      t.turn(t.a, { status: 'error', reason: 'other', error: 'socket hang up' })
      check('a third pauses it and says why', g.status === 'paused' && /3 replies in a row failed: socket hang up/.test(g.note || ''), `${g.status} ${g.note}`)
      await t.auto.goalAction(t.chat, 'resume')
      same('resuming uses up no round either', [g.status, g.round], ['active', 0])
      t.turn(t.a, { text: 'Built the sidebar.', tools: [['Write', { file_path: 'C:\\work\\Sidebar.tsx' }, 'File created']] })
      await t.settle()
      t.turn(t.a, { status: 'error', reason: 'other', error: 'socket hang up' })
      same('a reply that worked in between starts the count again', g.status, 'active')
      const signed = t.goal('Ship the menu')
      t.turn(t.a, { status: 'error', reason: 'auth', error: 'Not logged in' })
      check('a signed-out lead is not retried: only the user can fix that', signed.status === 'paused' && /signed out/.test(signed.note || ''), signed.note)
    } finally {
      t.done()
    }
  }

  // ───── the real engine: a task nobody works on is closed, and a new lead's own task folds into leading ─────
  {
    const { hub } = c
    const H = hub as unknown as {
      tasksOf(id: string): Task[]
      sweepStale(chat: Chat): number
      staleSince: Map<string, number>
      underWay(chat: Chat, a: Account): { tasks: number; agents: number }
      catchUp(chat: Chat, a: Account): string
    }
    const member = hub.accounts.accounts.find((x) => x.id !== c.leadId && x.enabled && !x.spawned)
    if (!member) throw new Error('the demo team has only a lead')
    const task = (chat: Chat, id: string, from: string, to: string, title: string, more: Partial<Task> = {}): Task => {
      const t = { id, chatId: chat.id, title, brief: title, from, to, status: 'running', createdAt: Date.now(), startedAt: Date.now(), ...more } as Task
      H.tasksOf(chat.id).push(t)
      return t
    }

    const chat = hub.createChat({ cwd: c.work })
    const stuck = task(chat, 't1', c.leadId, member.id, 'Research the watch link')
    const behind = task(chat, 't2', c.leadId, member.id, 'Verify the research', { status: 'queued', waitingOn: ['t1'], startedAt: undefined })
    same('a task marked as under way counts as work the goal waits for', H.underWay(chat, c.lead).tasks, 2)
    same('the first look only notes that nobody is on it', [H.sweepStale(chat), stuck.status], [0, 'running'])
    H.staleSince.set(`${chat.id}:t1`, Date.now() - 10 * 60_000)
    same('after two minutes with nobody on it, it is closed', [H.sweepStale(chat), stuck.status], [1, 'failed'])
    check('with a result that says what happened', /stopped working on this without finishing it or reporting/.test(stuck.result || ''), stuck.result)
    check('what was lined up behind it is called off, not left waiting for ever', behind.status === 'cancelled' && /waiting for t1/.test(behind.result || ''), `${behind.status}: ${behind.result}`)
    check('and whoever handed it out is told', c.rows(chat, c.leadId).some((i) => i.kind === 'peer' && i.tag === 'result' && /Research the watch link/.test(i.title || '')), JSON.stringify(c.rows(chat, c.leadId).map((i) => i.kind)))
    same('nothing is counted as under way any more', H.underWay(chat, c.lead).tasks, 0)
    await c.until('the lead to have read the report', () => c.idle(chat), 60_000)

    // A teammate who becomes the lead while on a task: the task is theirs as lead now.
    const two = hub.createChat({ cwd: c.work })
    hub.send({ chatId: two.id, to: c.leadId, text: 'hello' })
    await c.until('the first lead to have answered', () => c.idle(two) && c.rows(two, c.leadId).some((i) => i.kind === 'turn'), 60_000)
    const own = task(two, 't1', c.leadId, member.id, 'Phone and remote: finish and verify')
    const review = task(two, 't2', c.leadId, c.leadId, 'Review the phone work', { status: 'queued', waitingOn: ['t1'], startedAt: undefined })
    const third = hub.accounts.accounts.find((x) => x.id !== c.leadId && x.id !== member.id && x.enabled && !x.spawned)?.id || c.leadId
    const other = task(two, 't3', c.leadId, third, 'Work another teammate still has')
    // Kept quiet for the change, so no report wakes anyone and the handover note is still there to read.
    const quiet = (hub as unknown as { quiet: Set<string> }).quiet
    quiet.add(two.id)
    await hub.setChatLead(two.id, member.id)
    quiet.delete(two.id)
    check('a task the new lead itself was on is closed as part of leading', own.status === 'cancelled' && /took over as lead while on this, and carries it on as lead/.test(own.result || ''), `${own.status}: ${own.result}`)
    same('what was lined up behind it does not wait for ever', review.status, 'cancelled')
    check('tasks with other teammates now report to the new lead', other.from === member.id && other.status === 'running', `${other.from} ${other.status}`)
    // (The scripted lead may have handed the new lead a task of its own in its first reply: that one folds in too.)
    check('the chat remembers what the new lead was on', !!two.handoff?.own?.includes('Phone and remote: finish and verify'), JSON.stringify(two.handoff?.own))
    two.goal = { id: 'Gtest', text: 'Finish phone and remote', status: 'active', round: 0, maxRounds: 12, check: 'fresh', createdAt: Date.now(), log: [] }
    const text = H.catchUp(two, member)
    check('the handover says that task is now part of leading', /You were on (this task|these tasks) when you took over\. (It is|They are) now part of leading/.test(text) && /- Phone and remote: finish and verify/.test(text), text.slice(-700))
    check('and tells the new lead about the goal in play', /<goal id="Gtest"/.test(text) && /Finish phone and remote/.test(text) && /It has not been checked yet/.test(text), text.slice(-500))
    two.goal = null
    other.status = 'done'
  }

  // ───── the real engine with the scripted team: a goal survives a change of lead and is met ─────
  {
    const { hub } = c
    const member = hub.accounts.accounts.find((x) => x.id !== c.leadId && x.enabled && !x.spawned && x.provider === 'claude') || hub.accounts.accounts.find((x) => x.id !== c.leadId && x.enabled && !x.spawned)
    if (!member) throw new Error('the demo team has only a lead')
    const chat = hub.createChat({ cwd: c.work })
    hub.send({ chatId: chat.id, to: c.leadId, text: 'Add a pricing page', goal: { doneWhen: 'the tests pass and the page was opened' } })
    await c.until('the first check to send the lead back', () => chat.goal?.round === 1, 60_000)
    await hub.setChatLead(chat.id, member.id)
    check('changing the lead in the middle leaves the goal in play', chat.goal?.status === 'active', `${chat.goal?.status}: ${chat.goal?.note}`)
    await c.until('the goal to be met under the new lead', () => chat.goal?.status === 'met', 90_000)
    check('met, with the new lead doing the last round', chat.goal?.status === 'met' && c.rows(chat, member.id).some((i) => i.kind === 'auto' && i.event === 'met'), JSON.stringify(c.rows(chat, member.id).filter((i) => i.kind === 'auto').map((i) => (i as { title?: string }).title)))
    await c.until('the chat to be quiet', () => c.idle(chat), 60_000)
  }
}
