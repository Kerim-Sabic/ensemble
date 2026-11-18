// Dev-only: checks goals, loops and the ways of working against the real hub with the scripted
// demo team, from a terminal. No window, no account, no allowance.
//   pnpm auto-test
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Hub } from '../src/main/hub'
import { readVerdict } from '../src/main/autopilot'
import { countdown, everyLabel, goalLine, loopLine, parseCommand, parseEvery, span, APP_COMMANDS, GOCRAZY_NEEDS_ULTRA, effectiveMode } from '../src/shared/auto'
import { modeNote } from '../src/main/prompts'
import { AccountManager } from '../src/main/accounts'
import type { Chat, HubEvent, Item } from '../src/shared/types'

const dataDir = path.join(os.tmpdir(), 'ensemble-auto-test')
fs.rmSync(dataDir, { recursive: true, force: true })
const work = path.join(os.tmpdir(), 'ensemble-auto-work')
fs.mkdirSync(work, { recursive: true })

let passed = 0
const failed: string[] = []
const check = (name: string, ok: unknown, detail = ''): void => {
  if (ok) passed++
  else failed.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}
const same = (name: string, got: unknown, want: unknown): void => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

// ───────────── the small sums ─────────────
console.log('\nwords and sums')
same('10m', parseEvery('10m'), 600_000)
same('every 2 hours', parseEvery('every 2 hours'), 7_200_000)
same('daily', parseEvery('daily'), 86_400_000)
same('20s is raised to a minute', parseEvery('20s'), 60_000)
same('not a pace', parseEvery('soon'), undefined)
same('/goal', parseCommand('/goal all tests pass'), { kind: 'goal', text: 'all tests pass' })
same('/goal pause', parseCommand('/goal pause'), { kind: 'goal-action', action: 'pause' })
same('/goal alone', parseCommand('/goal'), null)
same('/loop with a pace', parseCommand('/loop 10m check the deploy'), { kind: 'loop', every: 600_000, prompt: 'check the deploy' })
same('/loop every 2 hours', parseCommand('/loop every 2 hours look at the inbox'), { kind: 'loop', every: 7_200_000, prompt: 'look at the inbox' })
same('/loop own pace', parseCommand('/loop watch the build'), { kind: 'loop', every: null, prompt: 'watch the build' })
same('/loop whose message starts with a number', parseCommand('/loop 3 things to check each time'), { kind: 'loop', every: null, prompt: '3 things to check each time' })
same('/loop stop', parseCommand('/loop stop'), { kind: 'loop-stop' })
same('/council', parseCommand('/council which database?'), { kind: 'mode', mode: 'council', text: 'which database?' })
same('not a command', parseCommand('make /goal work'), null)
same('someone else\'s command', parseCommand('/review this'), null)
same('/ultra on', parseCommand('/ultra on'), { kind: 'ultra', on: true })
same('/ultra off', parseCommand('/ultra off'), { kind: 'ultra', on: false })
same('/ultra alone flips it', parseCommand('/ultra'), { kind: 'ultra' })
same('/ultra with a request', parseCommand('/ultra build the landing page'), { kind: 'mode', mode: 'ultra', text: 'build the landing page' })
same('/gocrazy', parseCommand('/gocrazy design the landing page'), { kind: 'mode', mode: 'gocrazy', text: 'design the landing page' })
same('/gocrazy alone', parseCommand('/gocrazy'), null)
same('Ultra is sticky for messages with no mode', [effectiveMode(undefined, true), effectiveMode('chat', true), effectiveMode('quick', true), effectiveMode(undefined, false)], ['ultra', 'ultra', 'quick', 'chat'])
check('APP_COMMANDS lists ultra and gocrazy', APP_COMMANDS.some((c) => c.name === 'ultra') && APP_COMMANDS.some((c) => c.name === 'gocrazy'))
{
  const team = '- 4 ChatGPT accounts (A, B, C, D): strongest GPT-6-Astra (`gpt-6-astra`, effort up to max); fastest GPT-6-Luna (`gpt-6-luna`)'
  const crazy = modeNote('gocrazy', { lead: true, team: true, spawn: true, cap: 24, models: team })
  check('go crazy note: the real team, a wide swarm, two judging rounds', crazy.includes(team) && /12 to 20/.test(crazy) && /two rounds/.test(crazy) && /up to 24 more agents/.test(crazy))
  const ultra = modeNote('ultra', { lead: true, team: true, spawn: true, cap: 16, models: team })
  check('ultra note: rubric, scouts, builders, judges, design bar', /Rubric/.test(ultra) && /4 to 8/.test(ultra) && /Judges/.test(ultra) && /design studios/.test(ultra) && /spend allowance heavily/.test(ultra))
  check('ultra note when alone: the stages in passes', /in separate passes/.test(modeNote('ultra', { lead: true, team: false, spawn: false })))
}
{
  // Roles the app gives ChatGPT accounts fit the team: an all-ChatGPT team gets a lead and real parts.
  const dir = path.join(os.tmpdir(), 'ensemble-auto-roles')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const am = new AccountManager({ dataDir: dir, demo: true, emit: () => {}, claudePath: () => null })
  for (const n of ['G1', 'G2', 'G3', 'G4']) am.add({ name: n, provider: 'chatgpt', configDir: `demo://${n}` })
  same('all ChatGPT: lead and coding, then real parts', am.accounts.map((a) => a.role), ['Lead and coding', 'Coding', 'Research', 'Review and testing'])
  am.update(am.accounts[2].id, { role: 'Spanish copy' })
  am.add({ name: 'C1', provider: 'claude', configDir: 'demo://C1' })
  same('with a Claude account: the first is images and a second opinion; a typed role stays', am.accounts.map((a) => a.role), ['Images and a second opinion', 'Coding', 'Spanish copy', 'Research', null])
}
same('span', [span(45_000), span(300_000), span(5_400_000), span(172_800_000)], ['45 s', '5 min', '1 h 30 min', '2 days'])
same('everyLabel', [everyLabel(null), everyLabel(300_000), everyLabel(3_600_000), everyLabel(86_400_000)], ['at its own pace', 'every 5 min', 'every hour', 'every day'])
same('countdown', [countdown(1000 + 252_000, 1000), countdown(500, 1000), countdown(null)], ['4:12', 'now', ''])
same('verdict, clean', readVerdict('{"met": true, "blocked": false, "why": "Tests pass.", "next": ""}'), { met: true, blocked: false, why: 'Tests pass.' })
same('verdict, wrapped in prose', readVerdict('Here you go:\n```json\n{"met": false, "why": "No test run shown.", "next": "Run the tests."}\n```')?.met, false)
same('verdict, blocked', readVerdict('{"met": false, "blocked": true, "why": "Needs the API key."}')?.blocked, true)
same('verdict, loose', readVerdict('"met": true but the rest is broken')?.met, true)
same('verdict, nonsense', readVerdict('I think so'), null)

// ───────────── the engine ─────────────
const events: HubEvent[] = []
const waiters: { test: () => boolean; resolve: () => void }[] = []
const notes: string[] = []
function makeHub(): Hub {
  return new Hub({
    dataDir,
    version: 'test',
    demo: true,
    mica: false,
    isFocused: () => false,
    notify: (title, body) => notes.push(`${title} | ${body}`),
    emit: (ev) => {
      events.push(ev)
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].test()) waiters.splice(i, 1)[0].resolve()
    },
  })
}
let hub = makeHub()
const until = (what: string, test: () => boolean, ms = 60_000): Promise<void> =>
  new Promise((resolve, reject) => {
    if (test()) return resolve()
    const t = setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), ms)
    waiters.push({ test, resolve: () => (clearTimeout(t), resolve()) })
  })
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

await hub.start()
for (const c of await hub.accounts.discover()) if (c.signedIn) hub.accounts.add({ name: c.suggestedName, provider: c.provider, configDir: c.configDir })
await hub.accounts.refresh()
const lead = hub.lead()
if (!lead) throw new Error('the demo team has no lead')
const leadId = lead.id
const rows = (chat: Chat, who = leadId): Item[] => hub.openChat(chat.id).items[who] || []
const autos = (chat: Chat, who = leadId): string[] => rows(chat, who).flatMap((i) => (i.kind === 'auto' ? [`${i.of}:${i.event}`] : []))
const idle = (chat: Chat, who = leadId): boolean => {
  const s = hub.openChat(chat.id).states.find((x) => x.accountId === who)
  return !!s && s.phase === 'idle' && !s.queued
}

try {
  console.log('\na goal is worked on until a fresh check says it is met')
  {
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page', goal: { doneWhen: 'the tests pass and the page was opened' } })
    check('set at once', chat.goal?.status === 'active' && chat.goal.round === 0 && chat.goal.maxRounds === 12 && chat.goal.check === 'fresh')
    same('goal text is the message', chat.goal?.text, 'Add a pricing page')
    await until('the first check to be under way', () => !!chat.goal?.checking)
    check('checking is shown while the check is made', chat.goal?.checking === true)
    await until('the lead to be sent back', () => chat.goal?.round === 1)
    same('one check so far, not met', chat.goal?.log.map((l) => l.met), [false])
    same('where it stands, in words', goalLine(chat.goal!), 'Round 2 of 12')
    await until('the goal to be met', () => chat.goal?.status === 'met')
    same('two checks: not met, then met', chat.goal?.log.map((l) => l.met), [false, true])
    same('rows in the transcript', autos(chat), ['goal:set', 'goal:check', 'goal:met'])
    check('ended and no longer checking', !!chat.goal?.endedAt && !chat.goal?.checking)
    check('the user was told', notes.some((n) => n.startsWith('Goal met')), notes.join(' / '))
    check('the lead reported it through the tool', rows(chat).some((i) => i.kind === 'tool' && i.name === 'mcp__team__goal_report'))
    await until('the lead to be idle', () => idle(chat))
    await pause(300)
    same('nothing more is sent once it is met', autos(chat).length, 3)
    await hub.setGoal(chat.id, null)
    check('taking it off the chat', chat.goal === null)
  }

  console.log('\nrounds run out, and more can be given')
  {
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: '/goal ship the pricing page' })
    same('typed as a command', [chat.goal?.text, chat.goal?.status], ['ship the pricing page', 'active'])
    check('the command itself is not shown as the message', rows(chat).some((i) => i.kind === 'user' && i.text === 'ship the pricing page'))
    chat.goal!.maxRounds = 1
    await until('it to stop', () => chat.goal?.status === 'stopped')
    check('stopped with the reason', /Not met after 1 round/.test(chat.goal?.note || ''), chat.goal?.note)
    await until('the lead to be idle', () => idle(chat))
    await hub.goalAction(chat.id, 'more')
    check('given more rounds and going again', chat.goal?.status === 'active' && chat.goal.maxRounds > 1, `${chat.goal?.status} ${chat.goal?.maxRounds}`)
    await until('the goal to be met', () => chat.goal?.status === 'met')
    check('rows', autos(chat).join(' ') === 'goal:set goal:stopped goal:resumed goal:met', autos(chat).join(' '))
  }

  console.log('\nstop pauses a goal, resume carries on')
  {
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page', goal: {} })
    await pause(400)
    await hub.stop(chat.id)
    await until('the goal to be paused', () => chat.goal?.status === 'paused')
    check('paused by the stop', /stopped/.test(chat.goal?.note || ''), chat.goal?.note)
    await until('the lead to be idle', () => idle(chat))
    await pause(4200)
    await hub.goalAction(chat.id, 'resume')
    check('active again', chat.goal?.status === 'active')
    await until('the goal to be met', () => chat.goal?.status === 'met')
    check('met after resuming', true)

    hub.send({ chatId: chat.id, to: leadId, text: 'Now add a checkout', goal: { check: 'self', maxRounds: 3 } })
    check('a new goal replaces the old', chat.goal?.status === 'active' && chat.goal.text === 'Now add a checkout' && chat.goal.check === 'self')
    await until('the first self check', () => (chat.goal?.log.length || 0) >= 1)
    same("the lead's own word: not claimed, so not met", chat.goal?.log[0].met, false)
    await hub.goalAction(chat.id, 'pause')
    check('pause', chat.goal?.status === 'paused')
    await until('the lead to be idle', () => idle(chat), 30_000)
    // A goal that waits on the user is in play again as soon as they answer.
    chat.goal!.status = 'blocked'
    hub.send({ chatId: chat.id, to: leadId, text: 'Use the test key, it is in the env file.', mode: 'quick' })
    check('answering a goal that needed you sets it going again', chat.goal?.status === 'active' && autos(chat).at(-1) === 'goal:resumed', `${chat.goal?.status} ${autos(chat).at(-1)}`)
    await until('the goal to be met after the answer', () => chat.goal?.status === 'met')
    same("the lead's own word is taken once it is given", chat.goal?.log.map((l) => l.met), [false, true])
    await until('the lead to be idle', () => idle(chat), 30_000)
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a footer', goal: { maxRounds: 5 } })
    await pause(200)
    hub.send({ chatId: chat.id, to: leadId, text: '/goal stop' })
    await pause(100)
    check('/goal stop', chat.goal?.status === 'stopped', `${chat.goal?.status}: ${chat.goal?.note} | ${JSON.stringify(chat.goal?.log.map((l) => l.met))} | ${autos(chat).join(' ')}`)
    await until('the lead to be idle', () => idle(chat), 30_000)
  }

  console.log('\na loop runs again by itself and ends when its condition is met')
  {
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'Check whether the deploy is live', loop: { every: 600_000, until: 'the deploy is live' } })
    const loop = chat.loops?.[0]
    check('started and running at once', !!loop && loop.status === 'active' && loop.runs === 1 && loop.running === true && loop.to === leadId, JSON.stringify(loop))
    same('no user bubble for a loop, a row instead', [rows(chat).filter((i) => i.kind === 'user').length, autos(chat)], [0, ['loop:set']])
    await until('run 1 to end', () => !loop!.running)
    check('next run is scheduled one pace after the start', !!loop!.nextAt && Math.abs(loop!.nextAt - (loop!.lastAt! + 600_000)) < 2000, String(loop!.nextAt))
    check('a line about the run is kept', /still building/.test(loop!.last || ''), loop!.last)
    check('where it stands, in words', /^Next run in \d+:\d\d$/.test(loopLine(loop!)), loopLine(loop!))
    hub.runLoop(chat.id, loop!.id)
    check('run now', loop!.running === true && loop!.runs === 2)
    await until('run 2 to end', () => !loop!.running)
    hub.updateLoop(chat.id, loop!.id, { status: 'paused' })
    check('paused', loop!.status === 'paused' && loop!.nextAt === null)
    hub.updateLoop(chat.id, loop!.id, { status: 'active', every: 120_000 })
    check('going again at a new pace', loop!.status === 'active' && loop!.every === 120_000)
    await until('run 3 to start by itself', () => loop!.runs === 3, 15_000)
    await until('the loop to end', () => loop!.status === 'done')
    check('ended by the agent, with the reason', /live/.test(loop!.note || ''), loop!.note)
    check('rows', autos(chat).join(' ') === 'loop:set loop:run loop:paused loop:resumed loop:run loop:done', autos(chat).join(' '))
    check('the user was told twice: by the agent and by the app', notes.some((n) => n.startsWith('The deploy is live')) && notes.some((n) => n.startsWith('Loop ended')), notes.join(' / '))
    await pause(1500)
    same('a loop that ended does not run again', loop!.runs, 3)
  }

  console.log('\nloop limits and commands')
  {
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: '/loop 5m check the deploy' })
    const a = chat.loops?.[0]
    same('typed with a pace', [a?.every, a?.prompt], [300_000, 'check the deploy'])
    hub.addLoop(chat.id, { prompt: 'second loop', every: 3_600_000, maxRuns: 1, startNow: false })
    const b = chat.loops?.[1]
    check('a loop that waits one pace first', !!b && b.runs === 0 && !!b.nextAt && b.nextAt > Date.now() + 3_500_000)
    await until('the first loop to finish its run', () => !a!.running)
    hub.runLoop(chat.id, b!.id)
    await until('the one-run loop to end', () => b!.status === 'done')
    check('ended after its one run', /1 time/.test(b!.note || ''), b!.note)
    hub.send({ chatId: chat.id, to: leadId, text: '/loop stop' })
    check('/loop stop ends what is going', (chat.loops || []).every((l) => l.status === 'done'))
    for (let i = 0; i < 8; i++) hub.addLoop(chat.id, { prompt: `loop ${i}`, every: 3_600_000, startNow: false })
    let refused = ''
    try {
      hub.addLoop(chat.id, { prompt: 'one too many', every: 3_600_000, startNow: false })
    } catch (e) {
      refused = (e as Error).message
    }
    check('no more than eight at once', /up to 8/.test(refused), refused)
    const id = chat.loops!.find((l) => l.status === 'active')!.id
    hub.removeLoop(chat.id, id)
    check('removing one', !chat.loops!.some((l) => l.id === id))
    hub.auto.stopLoops(chat)
  }

  console.log('\nways of working')
  {
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'What should the annual discount be?', mode: 'quick' })
    await until('the quick answer', () => idle(chat) && rows(chat).some((i) => i.kind === 'assistant'))
    check('quick: answered alone', rows(chat).some((i) => i.kind === 'assistant' && /^Short answer/.test(i.text)) && !hub.tasksOf(chat.id).length)
    hub.send({ chatId: chat.id, to: leadId, text: '/council What should the annual discount be?' })
    await until('the council answer', () => idle(chat) && rows(chat).some((i) => i.kind === 'assistant' && /Where everyone agrees/.test(i.text)))
    check('council: typed as a command', rows(chat).some((i) => i.kind === 'user' && i.text === 'What should the annual discount be?'))
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page', mode: 'plan' })
    await until('the plan to be put to the user', () => rows(chat).some((i) => i.kind === 'question' && i.status === 'pending'))
    const q = rows(chat).find((i) => i.kind === 'question' && i.status === 'pending') as Extract<Item, { kind: 'question' }>
    check('plan first: nothing handed out before the yes', !hub.tasksOf(chat.id).length)
    hub.respondQuestion(q.requestId, { [q.questions[0].question]: 'Leave it' })
    await until('the lead to be idle', () => idle(chat))
    check('plan first: declined, nothing started', !hub.tasksOf(chat.id).length)
    const brief = hub.briefingFor(chat.id, leadId)
    check('the lead is told about goals and loops', /## Goals and loops/.test(brief) && /<way-of-working>/.test(brief))
  }

  console.log('\nultra and go crazy')
  {
    const chat = hub.createChat({ cwd: work })
    const usual = hub.agentCap(chat)
    const toasts = (): string[] => events.flatMap((e) => (e.type === 'toast' ? [e.text] : []))
    hub.send({ chatId: chat.id, to: leadId, text: '/gocrazy design the landing page' })
    check('go crazy is refused while Ultra is off', toasts().at(-1) === GOCRAZY_NEEDS_ULTRA && !rows(chat).some((i) => i.kind === 'user'), toasts().at(-1))
    hub.send({ chatId: chat.id, to: leadId, text: '/ultra on' })
    check('/ultra on turns it on', chat.ultra === true && !rows(chat).some((i) => i.kind === 'user'))
    same('the cap rises to 16 in Ultra', hub.agentCap(chat), Math.max(usual, 16))
    hub.send({ chatId: chat.id, to: leadId, text: '/ultra' })
    check('/ultra alone turns it off again', !chat.ultra)
    same('and the usual cap is back', hub.agentCap(chat), usual)
    hub.setUltra(chat.id, true)
    check('setUltra', chat.ultra === true)
    const team = hub['ultraTeam'](chat) as string
    check('the lead is told the real team: Claude and ChatGPT, strongest and fastest', /Claude/.test(team) && /ChatGPT/.test(team) && /Haiku/.test(team) && /Luna/i.test(team), team)
    // Sticky: a plain message goes in Ultra, and the scripted lead runs the staged pipeline.
    hub.send({ chatId: chat.id, to: leadId, text: 'Design the landing page' })
    await until('the Ultra run to finish', () => idle(chat) && rows(chat).some((i) => i.kind === 'assistant' && /Version B won/.test(i.text)), 90_000)
    const started = (chat.agents || []).length
    check('ultra: the demo starts scouts, builders and a judge', started >= 7, String(started))
    const staged = hub.tasksOf(chat.id).filter((t) => /^(Scout|Build|Judge):/.test(t.title))
    const on = (kind: string): string => staged.filter((t) => t.title.startsWith(kind)).map((t) => `${t.model}`).join(',')
    check('ultra: scouts on the fast models (Haiku and Luna), builders and judges on the strongest', staged.length >= 7 && /haiku/i.test(on('Scout')) && /luna/i.test(on('Scout')) && /fable/i.test(on('Build')) && /astra/i.test(on('Build')), `scouts ${on('Scout')} builders ${on('Build')} judges ${on('Judge')}`)

    const crazy = hub.createChat({ cwd: work })
    hub.setUltra(crazy.id, true)
    hub.send({ chatId: crazy.id, to: leadId, text: '/gocrazy design the landing page' })
    check('go crazy is accepted while Ultra is on', rows(crazy).some((i) => i.kind === 'user' && i.text === 'design the landing page'))
    same('the cap rises to 24 while going crazy', hub.agentCap(crazy), Math.max(usual, 24))
    await until('the Go crazy run to finish', () => idle(crazy) && rows(crazy).some((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text)), 120_000)
    check('go crazy: 8 or more agents', (crazy.agents || []).length >= 8, String((crazy.agents || []).length))
    hub.send({ chatId: crazy.id, to: leadId, text: 'Thanks', mode: 'quick' })
    same('a message in another mode ends the raised Go crazy cap', hub.agentCap(crazy), Math.max(usual, 16))
    await until('the lead to be idle', () => idle(crazy), 30_000)
  }

  console.log('\nenhance')
  {
    const out = await hub.enhance('make the pricing page better', null)
    check('rewrites a rough message', out.length > 40 && /^Make the pricing page better\./.test(out), out)
    same('leaves a command alone', await hub.enhance('/goal ship it', null), '/goal ship it')
    same('leaves a scrap alone', await hub.enhance('hi', null), 'hi')
  }

  console.log('\nnothing runs away or is left hanging')
  // A goal with nothing under way and no check owed is paused after 30 s (checked at the end of this part).
  const adrift = hub.createChat({ cwd: work })
  hub.auto.setGoal(adrift, { text: 'A goal nobody is working on' })
  {
    // A check that is owed is made after a loop's run that was queued behind the round.
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page', goal: {} })
    await pause(300)
    hub['session'](chat, lead).enqueue({ kind: 'auto', text: '<loop id="Lx" run="1" pace="every 10 min">\nCheck the deploy\n</loop>', origin: { kind: 'human' }, itemIds: [], auto: { of: 'loop', ref: 'Lx' } })
    await until('the check after the loop run', () => (chat.goal?.log.length || 0) >= 1, 30_000)
    check('the round is checked once the loop run behind it ends', chat.goal?.status === 'active' || chat.goal?.status === 'met', `${chat.goal?.status}`)
    await until('the goal to be met', () => chat.goal?.status === 'met')
    same('and carried on to the end', chat.goal?.log.map((l) => l.met), [false, true])
    await until('the lead to be idle', () => idle(chat), 30_000)
  }
  {
    // Stop while the lead is on a loop's run pauses the goal and the loop.
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'Check whether the deploy is live', loop: { every: 600_000 } })
    hub.auto.setGoal(chat, { text: 'Ship the pricing page' })
    await pause(300)
    await hub.stop(chat.id)
    check('stop during a loop run pauses the goal', chat.goal?.status === 'paused', `${chat.goal?.status} ${chat.goal?.note}`)
    check('and the loop', chat.loops?.[0]?.status === 'paused', chat.loops?.[0]?.status)
    await until('the lead to be idle', () => idle(chat), 30_000)
    await pause(1500)
    check('nothing starts after the stop', chat.goal?.status === 'paused' && chat.goal.round === 0 && !autos(chat).includes('goal:check'), autos(chat).join(' '))
  }
  {
    // Stop while the check is being made: its verdict does not start another round.
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page', goal: {} })
    await until('the check to be under way', () => !!chat.goal?.checking)
    await hub.stop(chat.id)
    await pause(2500)
    check('a check under way at the stop sends nothing', chat.goal?.status === 'paused' && chat.goal.round === 0 && !chat.goal.log.length && idle(chat), `${chat.goal?.status} round ${chat.goal?.round} log ${chat.goal?.log.length}`)
  }
  {
    // The chat's Stop holds loops that are waiting for their next run.
    const chat = hub.createChat({ cwd: work })
    const l = hub.auto.addLoop(chat, { prompt: 'look at the inbox', every: 3_600_000, startNow: false })
    await hub.stop(chat.id)
    check("the chat's Stop pauses a loop between runs", l.status === 'paused' && l.nextAt === null && /stopped the team/.test(l.note || ''), `${l.status} ${l.note}`)
  }
  {
    // What an agent starts by itself is held to limits; the user's own choice is not.
    const chat = hub.createChat({ cwd: work })
    const mine = hub.auto.addLoop(chat, { prompt: 'agent loop', every: 60_000 }, false, true)
    same('an agent loop runs at most every 5 min, 20 times', [mine.every, mine.maxRuns], [300_000, 20])
    const kept = hub.auto.addLoop(chat, { prompt: 'agent loop with its own limit', every: 600_000, maxRuns: 3 }, false, true)
    same('an agent loop keeps a limit it gave', [kept.every, kept.maxRuns], [600_000, 3])
    const user = hub.auto.addLoop(chat, { prompt: 'user loop', every: 60_000, startNow: false })
    same("the user's loop is as asked", [user.every, user.maxRuns], [60_000, null])
    hub.updateLoop(chat.id, user.id, { every: 'soon' as unknown as number })
    same('a pace that is not a number changes nothing', user.every, 60_000)
    same('a loop of the lead is not ended by someone else without its id', [/No loop of yours/.test(hub.auto.loopUpdate(chat, { ...lead, id: 'someone-else' }, { stop: true })), mine.status], [true, 'active'])
    same('an agent goal gets the usual rounds at most', hub.auto.setGoal(chat, { text: 'agent goal', maxRounds: 200 }, true).goal.maxRounds, 12)
    same("the user's goal gets what they asked", hub.auto.setGoal(chat, { text: 'user goal', maxRounds: 50 }).goal.maxRounds, 50)
    await hub.auto.goalAction(chat, 'clear')
    hub.auto.stopLoops(chat)
  }
  await until('the goal nobody works on to be paused', () => adrift.goal?.status === 'paused', 40_000)
  check('a goal with nothing under way is paused, not sent back', /nothing was under way/.test(adrift.goal?.note || '') && adrift.goal?.round === 0, adrift.goal?.note)

  console.log('\nreopening the app')
  {
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page', goal: {} })
    hub.addLoop(chat.id, { prompt: 'keep an eye on it', every: 3_600_000, startNow: false })
    // One whose run fell due while the app was closed.
    hub.addLoop(chat.id, { prompt: 'overdue', every: 3_600_000, startNow: false })
    chat.loops![1].nextAt = Date.now() - 60_000
    await pause(300)
    const id = chat.id
    const ultraChat = hub.createChat({ cwd: work })
    hub.setUltra(ultraChat.id, true)
    await hub.dispose()
    hub = makeHub()
    await hub.start()
    check('Ultra is kept on the chat', hub.chats.get(ultraChat.id)?.ultra === true)
    const again = hub.chats.get(id)
    check('a goal that was under way waits for a word from the user', again?.goal?.status === 'paused' && /closed/.test(again.goal.note || ''), `${again?.goal?.status} ${again?.goal?.note}`)
    check('a loop keeps its time', again?.loops?.[0]?.status === 'active' && !!again.loops[0].nextAt && !again.loops[0].running)
    check('a run that fell due while closed waits a full pace', (again?.loops?.[1]?.nextAt || 0) > Date.now() + 3_500_000, String(again?.loops?.[1]?.nextAt))
  }
} catch (e) {
  failed.push(`stopped early: ${(e as Error).message}`)
  console.log('  FAIL', (e as Error).message)
}

await hub.dispose()
console.log(`\n${passed} passed, ${failed.length} failed`)
if (failed.length) {
  for (const f of failed) console.log(' -', f)
  process.exit(1)
}
process.exit(0)
