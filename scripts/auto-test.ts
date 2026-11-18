// Dev-only: checks goals, loops and the ways of working against the real hub with the scripted
// demo team, from a terminal. No window, no account, no allowance.
//   pnpm auto-test
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Hub } from '../src/main/hub'
import { readVerdict } from '../src/main/autopilot'
import { countdown, everyLabel, goalLine, loopLine, namesLine, parseCommand, parseEvery, span, APP_COMMANDS, GOCRAZY_NEEDS_ULTRA, effectiveMode, MAX_DEPTH_GOCRAZY, MAX_DEPTH_ULTRA, MAX_DEPTH_USUAL, SPAWN_CAP_GOCRAZY, SPAWN_CAP_ULTRA } from '../src/shared/auto'
import { modeNote } from '../src/main/prompts'
import { AccountManager } from '../src/main/accounts'
import { askClaudeOnce, onceResult } from '../src/main/providers/claude'
import { demoTime } from '../src/main/util'
import type { Account, Chat, HubEvent, Item, PermissionLevel } from '../src/shared/types'
import * as iui from '../src/shared/iui' // Live answers checks (Canvas), near the end
import { IUI_BRIEFING } from '../src/main/iui' // Live answers checks (Canvas)

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
// Live answer fences in a reply, and whether each `ui` one is accepted by the window's reader.
const uiFences = (text: string): string[] => [...text.matchAll(/```ui\s*\n([\s\S]*?)\n```/g)].map((m) => m[1])
const blocksOk = (text: string): { n: number; bad: string[] } => {
  const all = uiFences(text)
  return { n: all.length, bad: all.flatMap((b) => { const r = iui.parseBlock(b); return r.ok ? [] : [r.reason || 'rejected'] }) }
}
const same = (name: string, got: unknown, want: unknown): void => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

// ───────────── the small sums ─────────────
console.log('\nwords and sums')
same('names in plain words', [namesLine(['Scout 1', 'Scout 2']), namesLine(['Scout 1', 'Scout 2', 'Scout 3', 'Scout 4', 'Builder A']), namesLine(['Ada'])], ['Scout 1 and Scout 2', '4 scouts and Builder A', 'Ada'])
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
  check('ultra note: rubric, scouts, builders, judges, design bar', /rubric/.test(ultra) && /4 to 8/.test(ultra) && /Judges/.test(ultra) && /design studios/.test(ultra) && /spend allowance heavily/.test(ultra))
  check('research note points to checking facts on the web', [true, false].every((team) => /Checking facts on the web/.test(modeNote('research', { lead: true, team, spawn: false }))))
  check('ultra note: small follow-ups get a direct answer, the stages are for real work', /scale this to the message/.test(ultra) && /thank-you/.test(ultra) && /new, substantial request/.test(crazy))
  check('ultra note when alone: the stages in passes', /in separate passes/.test(modeNote('ultra', { lead: true, team: false, spawn: false })))
  check('ultra note: the lead chooses a shape (tournament, divide and assemble, investigation)', /Tournament, for work/.test(ultra) && /Divide and assemble/.test(ultra) && /Investigation, for a question/.test(ultra) && /small cell/.test(ultra))
  check('go crazy note: four levels and a cross-critique round', /four levels below you/.test(crazy) && /cross-critique round/.test(crazy))
  check('ultra note: three levels by default, no capitals for emphasis', /third level below you/.test(ultra) && !/\b[A-Z]{4,}\b/.test(ultra.replace(/\b(GPT|API|ChatGPT)\b/g, '')))
  // pnpm auto-test with ENSEMBLE_DUMP_NOTES=1 writes the note texts for reading.
  if (process.env.ENSEMBLE_DUMP_NOTES) {
    const mixed = '- 3 Claude accounts (Main, Claude 3, Hello): strongest Fable 5.2 (`fable`, effort up to max); fastest Haiku 5.5 (`haiku`)\n- 1 ChatGPT account (ChatGPT): strongest GPT-6.2-Astra (`gpt-6.2-astra`, effort up to max); fastest GPT-6-Luna (`gpt-6-luna`)'
    const gpt4 = '- 4 ChatGPT accounts (G1, G2, G3, G4): strongest GPT-6.2-Astra (`gpt-6.2-astra`, effort up to max); fastest GPT-6-Luna (`gpt-6-luna`)'
    const fence = '```'
    const block = (title: string, text: string): string => `## ${title}\n\n${fence}text\n${text.trim()}\n${fence}\n`
    fs.mkdirSync('.shots', { recursive: true })
    fs.writeFileSync(
      '.shots/ultra-notes.md',
      [
        '# Ultra and Go crazy: the notes the lead receives\n\nGenerated by `ENSEMBLE_DUMP_NOTES=1 pnpm auto-test` from src/main/prompts.ts modeNote(). The team lines come from hub.ultraTeam(chat); the cap from spawnRoom(); the depth from hub.maxDepth(chat).\n',
        block('modeNote("ultra"), mixed team (3 Claude + 1 ChatGPT), cap 20, depth 3', modeNote('ultra', { lead: true, team: true, spawn: true, cap: 20, models: mixed, depth: 3 })),
        block('modeNote("gocrazy"), ChatGPT-only team (4 accounts), cap 32, depth 4', modeNote('gocrazy', { lead: true, team: true, spawn: true, cap: 32, models: gpt4, depth: 4 })),
        block('modeNote("ultra"), lead alone (no team, cannot start agents)', modeNote('ultra', { lead: true, team: false, spawn: false })),
      ].join('\n'),
    )
  }
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
    const quickText = rows(chat).find((i) => i.kind === 'assistant' && /^Short answer/.test(i.text))?.text || ''
    const qb = blocksOk(quickText)
    check('quick: the answer carries a stats block that parses', qb.n === 1 && !qb.bad.length && /"type":"stats"/.test(quickText), JSON.stringify(qb))
    hub.send({ chatId: chat.id, to: leadId, text: '/council What should the annual discount be?' })
    await until('the council answer', () => idle(chat) && rows(chat).some((i) => i.kind === 'assistant' && /Where everyone agrees/.test(i.text)))
    check('council: typed as a command', rows(chat).some((i) => i.kind === 'user' && i.text === 'What should the annual discount be?'))
    const councilText = rows(chat).find((i) => i.kind === 'assistant' && /Where everyone agrees/.test(i.text))?.text || ''
    const cb = blocksOk(councilText)
    check('council: the answer carries a compare block that parses', cb.n === 1 && !cb.bad.length && /"type":"compare"/.test(councilText), JSON.stringify(cb))
    hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page', mode: 'plan' })
    await until('the plan to be put to the user', () => rows(chat).some((i) => i.kind === 'question' && i.status === 'pending'))
    const q = rows(chat).find((i) => i.kind === 'question' && i.status === 'pending') as Extract<Item, { kind: 'question' }>
    check('plan first: nothing handed out before the yes', !hub.tasksOf(chat.id).length)
    hub.respondQuestion(q.requestId, { [q.questions[0].question]: 'Leave it' })
    await until('the lead to be idle', () => idle(chat))
    check('plan first: declined, nothing started', !hub.tasksOf(chat.id).length)
    const brief = hub.briefingFor(chat.id, leadId)
    check('the lead is told about goals and loops', /## Goals and loops/.test(brief) && /<way-of-working>/.test(brief))
    const member = hub.accounts.accounts.find((a) => a.id !== leadId)
    const web = (b: string): boolean => /## Checking facts on the web/.test(b) && /primary source/.test(b) && /could not find/.test(b)
    check('lead and teammates are told to check facts on the web', web(brief) && (!member || web(hub.briefingFor(chat.id, member.id))))
    const bar = (b: string): boolean => /## What good work looks like/.test(b) && /lorem ipsum/.test(b) && /TODOs/.test(b)
    check('lead and teammates get the bar for good work in every mode', bar(brief) && (!member || bar(hub.briefingFor(chat.id, member.id))))
    const live = (b: string): number => b.split('## Charts, forms and small apps in a reply').length - 1
    same('lead and teammates get the Live answers section once', [live(brief), member ? live(hub.briefingFor(chat.id, member.id)) : 1], [1, 1])
    if (process.env.ENSEMBLE_DUMP_NOTES) fs.writeFileSync('.shots/briefings.md', `# Lead

${brief}

# Member (${member?.name})

${member ? hub.briefingFor(chat.id, member.id) : ''}
`)
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
    same('the cap rises to 20 in Ultra', [SPAWN_CAP_ULTRA, hub.agentCap(chat)], [20, Math.max(usual, 20)])
    same('the depth rises to 3 in Ultra', [MAX_DEPTH_ULTRA, hub.maxDepth(chat)], [3, 3])
    hub.send({ chatId: chat.id, to: leadId, text: '/ultra' })
    check('/ultra alone turns it off again', !chat.ultra)
    same('and the usual cap is back', hub.agentCap(chat), usual)
    hub.setUltra(chat.id, true)
    check('setUltra', chat.ultra === true)
    const leadAccount = hub.accounts.get(leadId)!
    const boost = hub['ultraLead'](chat, leadAccount) as { model?: string; effort?: string } | null
    check('ultra: the lead itself runs its strongest model, thinking hard', boost?.model === 'fable' && boost.effort === 'xhigh', JSON.stringify(boost))
    const gptAccount = hub.accounts.accounts.find((a) => a.provider === 'chatgpt')!
    const gptBoost = hub['ultraLead'](chat, gptAccount) as { model?: string; effort?: string } | null
    check('ultra: a ChatGPT lead gets its strongest model too', /astra/i.test(gptBoost?.model || '') && gptBoost?.effort === 'xhigh', JSON.stringify(gptBoost))
    const plain = hub.createChat({ cwd: work })
    same('outside Ultra the lead is left to the usual choice', hub['ultraLead'](plain, leadAccount), null)
    const team = hub['ultraTeam'](chat) as string
    check('the lead is told the real team: Claude and ChatGPT, strongest and fastest', /Claude/.test(team) && /ChatGPT/.test(team) && /Haiku/.test(team) && /Luna/i.test(team), team)
    // Sticky: a plain message goes in Ultra, and the scripted lead runs the staged pipeline.
    const ultraFrom = Date.now()
    hub.send({ chatId: chat.id, to: leadId, text: 'Design the landing page' })
    await until('the Ultra run to finish', () => idle(chat) && rows(chat).some((i) => i.kind === 'assistant' && /Version B won/.test(i.text)), 90_000)
    const started = (chat.agents || []).length
    console.log(`  (Ultra run: ${((Date.now() - ultraFrom) / 1000).toFixed(1)} s at demo speed ${process.env.ENSEMBLE_DEMO_SPEED || 1}, ${started} agents)`)
    check('ultra: the demo starts scouts, builders and a judge', started >= 7, String(started))
    const staged = hub.tasksOf(chat.id).filter((t) => /^(Scout|Build|Judge):/.test(t.title))
    const on = (kind: string): string => staged.filter((t) => t.title.startsWith(kind)).map((t) => `${t.model}`).join(',')
    check('ultra: scouts on the fast models (Haiku and Luna), builders and judges on the strongest', staged.length >= 7 && /haiku/i.test(on('Scout')) && /luna/i.test(on('Scout')) && /fable/i.test(on('Build')) && /astra/i.test(on('Build')), `scouts ${on('Scout')} builders ${on('Build')} judges ${on('Judge')}`)
    const swept = await hub.sweepIdle(chat, 0)
    check('ultra: agents left idle after the run are sent home', swept.length > 0 && (chat.agents || []).every((a) => a.spawned?.gone), swept.join(', '))
    check('and the lead is told who went', rows(chat).some((i) => i.kind === 'notice' && /home after a few minutes idle/.test(i.text)))
    const builds = staged.filter((t) => t.title.startsWith('Build'))
    check('what a task waits for is said in names, never task ids', builds.length > 0 && builds.every((t) => t.afterFor === '4 scouts') && staged.every((t) => !/\bt\d+\b/.test(`${t.afterFor || ''} ${t.waitingFor || ''}`)), builds.map((t) => t.afterFor).join(' | '))
    const agentsBefore = (chat.agents || []).length
    hub.send({ chatId: chat.id, to: leadId, text: 'Thanks' })
    await until('the thank-you to be answered', () => idle(chat) && rows(chat).some((i) => i.kind === 'assistant' && /Glad it helps/.test(i.text)), 30_000)
    same('a thank-you in Ultra gets a direct answer and starts nobody', (chat.agents || []).length, agentsBefore)
    const ultraText = rows(chat).find((i) => i.kind === 'assistant' && /Version B won/.test(i.text))?.text || ''
    const ub = blocksOk(ultraText)
    check('ultra: the answer is Live answer blocks that all parse (compare, chart, choices) plus the winner in an app', ub.n === 3 && !ub.bad.length && /"type":"compare"/.test(ultraText) && /"type":"chart"/.test(ultraText) && /"type":"choices"/.test(ultraText) && /```app title="[^"]+" height=520\n<!doctype html>[\s\S]*<\/html>\n```/.test(ultraText), JSON.stringify(ub))
    hub.send({ chatId: chat.id, to: leadId, text: 'Chose: Use version B' })
    await until('the choice to be answered', () => idle(chat) && rows(chat).some((i) => i.kind === 'assistant' && /version B is copied/.test(i.text)), 30_000)
    same('a choice clicked in Ultra gets a direct answer and starts nobody', (chat.agents || []).length, agentsBefore)

    const crazy = hub.createChat({ cwd: work })
    hub.setUltra(crazy.id, true)
    const crazyFrom = Date.now()
    hub.send({ chatId: crazy.id, to: leadId, text: '/gocrazy design the landing page' })
    check('go crazy is accepted while Ultra is on', rows(crazy).some((i) => i.kind === 'user' && i.text === 'design the landing page'))
    same('the cap rises to 32 while going crazy', [SPAWN_CAP_GOCRAZY, hub.agentCap(crazy)], [32, Math.max(usual, 32)])
    same('the depth rises to 4 while going crazy', [MAX_DEPTH_GOCRAZY, hub.maxDepth(crazy)], [4, 4])
    same('go crazy: the lead thinks as hard as its model can', (hub['ultraLead'](crazy, hub.accounts.get(leadId)!) as { effort?: string } | null)?.effort, 'max')
    await until('the Go crazy run to finish', () => idle(crazy) && rows(crazy).some((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text)), 120_000)
    console.log(`  (go crazy run: ${((Date.now() - crazyFrom) / 1000).toFixed(1)} s at demo speed ${process.env.ENSEMBLE_DEMO_SPEED || 1}, ${(crazy.agents || []).length} agents)`)
    const crazyText = rows(crazy).find((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text))?.text || ''
    const gb = blocksOk(crazyText)
    check('go crazy: the answer is Live answer blocks that all parse, four versions compared, plus the app', gb.n === 3 && !gb.bad.length && (crazyText.match(/Version [ABCD]/g) || []).length >= 4 && /```app /.test(crazyText), JSON.stringify(gb))
    check('go crazy: 8 or more agents', (crazy.agents || []).length >= 8, String((crazy.agents || []).length))
    const depthOf = (a: Account): number => a.spawned?.depth || 0
    const byName = (c: Chat, n: string): Account | undefined => (c.agents || []).find((a) => a.name === n)
    const deep = (crazy.agents || []).filter((a) => depthOf(a) >= 2)
    check('go crazy: builders start a critic and a tester, a judge a verifier (depth 2)', ['Critic A', 'Critic B', 'Critic C', 'Critic D', 'Tester A', 'Tester B', 'Verifier'].every((n) => depthOf(byName(crazy, n) || ({} as Account)) === 2), deep.map((a) => `${a.name}@${depthOf(a)}`).join(', '))
    const fc = byName(crazy, 'Fact-checker A')
    check('go crazy: a critic starts a fact-checker (depth 3)', !!fc && depthOf(fc) === 3 && fc.spawned?.by === byName(crazy, 'Critic A')?.id)
    check('go crazy: about 23 agents, within the cap', (crazy.agents || []).length >= 20 && (crazy.agents || []).length <= SPAWN_CAP_GOCRAZY, String((crazy.agents || []).length))
    const crazyTasks = hub.tasksOf(crazy.id)
    check('go crazy: every task ended done', crazyTasks.every((t) => t.status === 'done'), crazyTasks.filter((t) => t.status !== 'done').map((t) => `${t.title}:${t.status}`).join(', '))
    check('go crazy: helpers report to whoever started them', crazyTasks.filter((t) => /^(Critique|Test|Verify|Fact-check):/.test(t.title)).every((t) => hub.accounts.get(t.to)?.spawned?.by === t.from))
    // The run is over: the chat is back to plain Ultra by itself, without waiting for the user's next message.
    same('when a Go crazy run ends, the cap and the depth go back to Ultra', [hub.agentCap(crazy), hub.maxDepth(crazy)], [Math.max(usual, SPAWN_CAP_ULTRA), 3])
    if (fc) {
      // The next two checks are about a run in progress.
      hub['markUltra'](crazy, 'gocrazy')
      hub['spawn'](crazy, fc, { name: 'Fourth level', role: 'the last level going crazy allows' })
      const fourth = byName(crazy, 'Fourth level')
      check('going crazy allows a fourth level', fourth?.spawned?.depth === 4)
      const refused = fourth ? (hub['spawn'](crazy, fourth, { name: 'Too deep', role: 'should not exist' }) as string) : ''
      check('an agent at the last level is refused with a clear message', /deepest level/.test(refused) && !byName(crazy, 'Too deep'), refused)
    }
    const builderA = byName(crazy, 'Builder A')
    if (builderA) {
      await hub.removeAgent(crazy.id, builderA.id)
      check('a subtree goes home with its parent', ['Builder A', 'Critic A', 'Tester A', 'Fact-checker A'].every((n) => byName(crazy, n)?.spawned?.gone), ['Critic A', 'Tester A', 'Fact-checker A'].map((n) => `${n}:${!!byName(crazy, n)?.spawned?.gone}`).join(' '))
    }
    hub.send({ chatId: crazy.id, to: leadId, text: 'Thanks', mode: 'quick' })
    same('a message in another mode ends the raised Go crazy cap', hub.agentCap(crazy), Math.max(usual, SPAWN_CAP_ULTRA))
    await until('the lead to be idle', () => idle(crazy), 30_000)

    // A builder's task holds while its own helpers work, and Stop takes the whole tree back.
    const held = hub.createChat({ cwd: work })
    hub.setUltra(held.id, true)
    hub.send({ chatId: held.id, to: leadId, text: '/gocrazy design the landing page' })
    const holding = (): boolean => hub.tasksOf(held.id).some((t) => t.title.startsWith('Build') && t.status === 'running' && t.holding && hub.tasksOf(held.id).some((h) => h.from === t.to && h.title.startsWith('Critique') && (h.status === 'running' || h.status === 'queued')))
    await until('a builder to hold its task for its critic', holding, 90_000)
    check('a nested task holds until its helpers report', holding())
    await hub.stop(held.id)
    await until('everyone to stop', () => (held.agents || []).every((a) => !hub['sessions'].get(`${held.id}:${a.id}`)?.busy) && idle(held), 30_000)
    const live = hub.tasksOf(held.id).filter((t) => t.status === 'running' || t.status === 'queued')
    check('stop takes back a nested subtree', !live.length, live.map((t) => `${t.title}:${t.status}`).join(', '))

    // Ordinary chats keep the usual limits: two levels, and a few agents each below the lead.
    const plainChat = hub.createChat({ cwd: work })
    same('an ordinary chat goes two levels deep', [MAX_DEPTH_USUAL, hub.maxDepth(plainChat)], [2, 2])
    const leadAcc = hub.accounts.get(leadId)!
    hub['spawn'](plainChat, leadAcc, { name: 'Level one', role: 'first level' })
    const one = (plainChat.agents || []).find((a) => a.name === 'Level one')!
    hub['spawn'](plainChat, one, { name: 'Level two', role: 'second level' })
    const two = (plainChat.agents || []).find((a) => a.name === 'Level two')
    check('in an ordinary chat a first-level agent may start one of its own', two?.spawned?.depth === 2)
    const no = two ? (hub['spawn'](plainChat, two, { name: 'Level three', role: 'third level' }) as string) : ''
    check('and that one may not start more', /deepest level/.test(no) && !(plainChat.agents || []).some((a) => a.name === 'Level three'), no)
    hub.setUltra(plainChat.id, true)
    for (let i = 0; i < 6; i++) hub['spawn'](plainChat, one, { name: `Helper ${i + 1}`, role: 'helps' })
    const mine = (plainChat.agents || []).filter((a) => a.spawned?.by === one.id && !a.spawned.gone).length
    same('in Ultra an agent below the lead still starts a few at most', mine, 4)
    const briefTwo = two ? hub.briefingFor(plainChat.id, two.id) : ''
    check('a second-level agent in Ultra is told it may start a few, who cannot start more', /You may start up to 4 of your own/.test(briefTwo) && /One you start cannot start agents of its own/.test(briefTwo), (/## Agents of your own[\s\S]{0,600}/.exec(briefTwo) || [''])[0])
  }

  console.log('\ndemo timers')
  {
    // A slowed demo (the film runs at 0.03) behaves like a normal one stretched in time: the idle sweep
    // and the other engine waits follow ENSEMBLE_DEMO_SPEED in demo mode, and only there.
    const was = process.env.ENSEMBLE_DEMO_SPEED
    process.env.ENSEMBLE_DEMO_SPEED = '0.03'
    const slow = hub.wait(3 * 60 * 1000)
    process.env.ENSEMBLE_DEMO_SPEED = '1'
    const normal = hub.wait(3 * 60 * 1000)
    process.env.ENSEMBLE_DEMO_SPEED = 'nonsense'
    const bad = hub.wait(3 * 60 * 1000)
    if (was === undefined) delete process.env.ENSEMBLE_DEMO_SPEED
    else process.env.ENSEMBLE_DEMO_SPEED = was
    same('the idle sweep delay scales with the demo speed (3 min at speed 0.03, 1 and nonsense)', [Math.round(slow), normal, bad], [6_000_000, 180_000, 180_000])
    same('outside demo mode a wait is unchanged', demoTime(180_000, false), 180_000)
  }

  console.log('\ntry the demo team')
  {
    // "Try the demo team": a ready team and a welcome chat, with no first-run screens, in a folder of its own.
    const trialDir = path.join(os.tmpdir(), 'ensemble-auto-test-trial')
    fs.rmSync(trialDir, { recursive: true, force: true })
    const trial = new Hub({ dataDir: trialDir, version: 'test', demo: true, trial: true, mica: false, isFocused: () => false, notify: () => {}, emit: (ev) => events.push(ev) })
    await trial.start()
    const boot = trial.bootstrap()
    check('demo team: the window is told it is the demo team', boot.env.trial === true && boot.env.demo === true)
    check('demo team: ready accounts, no first-run screens', trial.accounts.accounts.length >= 2 && trial.settings.onboarded === true, `${trial.accounts.accounts.length} accounts, onboarded ${trial.settings.onboarded}`)
    const welcome = [...trial.chats.values()][0]
    const lead = trial.lead()
    const said = welcome && lead ? (trial.openChat(welcome.id).items[lead.id] || []).find((i) => i.kind === 'assistant') : undefined
    const text = said && said.kind === 'assistant' ? said.text : ''
    const wb = blocksOk(text)
    check('demo team: a welcome chat suggests a request, /goal and /gocrazy as choices that parse', welcome?.title === 'Welcome to the demo team' && wb.n === 1 && !wb.bad.length && /\/goal /.test(text) && /\/gocrazy /.test(text), JSON.stringify(wb))
    if (welcome && lead) {
      // Typed, the same words are just words, even in the demo team.
      const typedDemo = trial.createChat({ cwd: work })
      trial.send({ chatId: typedDemo.id, to: lead.id, text: 'Chose: /gocrazy design the landing page' })
      check('demo team: a typed "Chose: /gocrazy" is ordinary words', !typedDemo.ultra && (trial.openChat(typedDemo.id).items[lead.id] || []).some((i) => i.kind === 'user' && i.text === 'Chose: /gocrazy design the landing page'))
      await trial.stop(typedDemo.id)
      trial.send({ chatId: welcome.id, to: lead.id, text: 'Chose: /gocrazy design the landing page', fromControl: true })
      check('demo team: a clicked /gocrazy runs as the command and turns Ultra on by itself', welcome.ultra === true && (trial.openChat(welcome.id).items[lead.id] || []).some((i) => i.kind === 'user' && i.text === 'design the landing page'))
      await trial.stop(welcome.id)
    }
    await trial.dispose()
    // A second start of the same folder adds nothing: the team is set up once.
    const again = new Hub({ dataDir: trialDir, version: 'test', demo: true, trial: true, mica: false, isFocused: () => false, notify: () => {}, emit: () => {} })
    const before = [again.accounts.accounts.length, again.chats.size]
    await again.start()
    same('demo team: set up once, not again on a second start', [again.accounts.accounts.length, again.chats.size], before)
    await again.dispose()
    fs.rmSync(trialDir, { recursive: true, force: true })
    // An ordinary demo run (screenshots, development) is unchanged: no bar, the first-run screens as before.
    same('an ordinary demo run is not the demo team', hub.bootstrap().env.trial, false)

    // In a real chat a control's message is never an app command, whatever an agent put in it.
    const real = hub.createChat({ cwd: work })
    const startedBefore = (real.agents || []).length
    hub.send({ chatId: real.id, to: leadId, text: 'Chose: /gocrazy x', fromControl: true })
    hub.send({ chatId: real.id, to: leadId, text: '/loop 1m check the inbox', fromControl: true, mode: 'gocrazy', goal: { text: 'x' } })
    hub.send({ chatId: real.id, to: leadId, text: '/ultra on', fromControl: true })
    const realSaid = (rows(real) || []).filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : ''))
    check('a control message in a real chat starts nothing: no Ultra, goal, loop or mode, and reaches the lead as text', !real.ultra && !real.goal && !(real.loops || []).length && (real.agents || []).length === startedBefore && realSaid.includes('Chose: /gocrazy x') && realSaid.includes('/loop 1m check the inbox') && realSaid.includes('/ultra on'), JSON.stringify(realSaid))
    await hub.stop(real.id)
    await until('the lead to be idle', () => idle(real), 30_000)
    check('and it started no agents afterwards either', (real.agents || []).length === startedBefore && !(real.loops || []).length)
    // Typed, the commands work as before.
    const typed = hub.createChat({ cwd: work })
    hub.send({ chatId: typed.id, to: leadId, text: '/gocrazy x' })
    check('typed /gocrazy with Ultra off is still refused with the usual toast', !rows(typed).some((i) => i.kind === 'user') && events.some((e) => e.type === 'toast' && e.text === GOCRAZY_NEEDS_ULTRA))
    hub.send({ chatId: typed.id, to: leadId, text: '/ultra on' })
    hub.send({ chatId: typed.id, to: leadId, text: '/gocrazy x' })
    check('typed /ultra on then /gocrazy still run', typed.ultra === true && rows(typed).some((i) => i.kind === 'user' && i.text === 'x'))
    await hub.stop(typed.id)
    await until('the lead to be idle', () => idle(typed), 30_000)
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

  console.log('\nfixes from the audit')
  {
    const H = hub as unknown as { sessions: Map<string, { runsAt: PermissionLevel | null }>; deliver(chat: Chat, from: Account, a: { to: string; text: string }): string }
    const member = hub.accounts.accounts.find((a) => a.id !== leadId && a.enabled && a.provider === 'claude') || hub.accounts.accounts.find((a) => a.id !== leadId && a.enabled)
    if (!member) throw new Error('the demo team has only a lead')

    // A lead out of allowance: what reaches it waits, one offer to switch, and the new lead gets it all.
    const dry = hub.createChat({ cwd: work })
    const refill = Date.now() + 2 * 3600e3
    hub.accounts.setUsage(leadId, { session: { utilization: 1, resetsAt: refill, status: 'rejected' } })
    hub.send({ chatId: dry.id, to: leadId, text: 'What is the state of the build?' })
    await pause(150)
    check('a message to a lead out of allowance waits instead of failing', idle(dry) && rows(dry).some((i) => i.kind === 'user' && i.queued) && !rows(dry).some((i) => i.kind === 'turn'))
    const left = H.deliver(dry, member, { to: lead.name, text: 'The build is green.' })
    check('a note to it waits for the refill too', /no usage allowance left/.test(left), left)
    hub.send({ chatId: dry.id, to: leadId, text: 'And the tests?' })
    const offers = rows(dry).filter((i) => i.kind === 'notice' && i.action?.kind === 'switch-lead')
    same('one offer to switch lead, not one per message', offers.length, 1)
    await hub.setChatLead(dry.id, member.id, true)
    check('nothing is left waiting on the old lead', !rows(dry).some((i) => 'queued' in i && i.queued))
    await until('the new lead to take what was waiting', () => rows(dry, member.id).some((i) => i.kind === 'turn'), 60_000)
    check('the new lead is given what was waiting', rows(dry, member.id).some((i) => i.kind === 'notice' && /Passed on what was waiting/.test(i.text) && /3 messages/.test(i.text)))
    hub.accounts.setUsage(leadId, { session: { utilization: 0.2, resetsAt: refill } })
    await hub.stop(dry.id)

    // An error that arrives as a "success" is not an answer, and a stalled call is really ended.
    let thrown = ''
    try {
      onceResult({ subtype: 'success', is_error: true, result: "You've hit your limit" })
    } catch (e) {
      thrown = (e as Error).message
    }
    check('an error result is thrown, not passed off as an answer', /hit your limit/.test(thrown), thrown)
    same('a real answer comes through', onceResult({ subtype: 'success', result: 'Pricing page' }), 'Pricing page')
    const hang = path.join(work, 'hang.mjs')
    fs.writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
    const t0 = Date.now()
    let why = ''
    try {
      await askClaudeOnce({ configDir: null, cwd: work, executable: hang, system: 'x', prompt: 'x', timeoutMs: 800 })
    } catch (e) {
      why = (e as Error).message
    }
    check('a stalled one-shot call is ended at its timeout', why === 'Timed out.' && Date.now() - t0 < 6000, `${why} after ${Date.now() - t0} ms`)

    // Stop keeps reports that were waiting for the lead.
    const stopped = hub.createChat({ cwd: work })
    hub.send({ chatId: stopped.id, to: leadId, text: 'Summarise the plan', mode: 'quick' })
    H.deliver(stopped, member, { to: lead.name, text: 'Report: the header is done.' })
    await hub.stop(stopped.id, leadId)
    await until('the lead to stop', () => idle(stopped), 30_000)
    const report = (): Item | undefined => rows(stopped).find((i) => i.kind === 'peer' && i.text === 'Report: the header is done.')
    check('stop keeps a waiting report, unread', !!report() && (report() as { queued?: boolean }).queued === true)
    hub.send({ chatId: stopped.id, to: leadId, text: 'Go on', mode: 'quick' })
    check('and it comes with the next turn', (report() as { queued?: boolean }).queued === false)
    await until('the lead to be idle', () => idle(stopped), 30_000)

    // Stop early in an Ultra reply: the demo lead ends its turn at once and starts no more agents.
    const halt = hub.createChat({ cwd: work })
    hub.setUltra(halt.id, true)
    hub.send({ chatId: halt.id, to: leadId, text: 'Design the landing page' })
    await until('the first agents to start', () => (halt.agents || []).length >= 2, 20_000)
    const startedBeforeStop = (halt.agents || []).length
    const t1 = Date.now()
    await hub.stop(halt.id, leadId)
    await until('the stopped lead to end its turn', () => idle(halt), 10_000)
    const took = Date.now() - t1
    await pause(1500)
    check('stop ends a demo lead\'s turn at once and it starts no more agents', took < 1000 && (halt.agents || []).length === startedBeforeStop, `${took} ms, agents ${startedBeforeStop} -> ${(halt.agents || []).length}`)
    // What that reply had handed out is taken back with it: nobody is left working for a lead that was stopped.
    const stillOpen = hub.tasksOf(halt.id).filter((t) => t.status === 'queued' || t.status === 'running')
    const busyAfter = hub.openChat(halt.id).states.filter((s) => s.phase !== 'idle' && s.phase !== 'error').length
    check('stopping the lead mid-reply takes back the tasks that reply handed out', hub.tasksOf(halt.id).length >= 2 && stillOpen.length === 0 && busyAfter === 0, `${stillOpen.length} of ${hub.tasksOf(halt.id).length} tasks still open, ${busyAfter} busy`)
    check('and says so', rows(halt).some((i) => i.kind === 'notice' && /took back the/.test(i.text)))
    await pause(4500)
    check('the stopped lead is not woken by their endings', idle(halt) && !rows(halt).some((i) => i.kind === 'peer' && i.tag === 'result'))
    await hub.stop(halt.id)

    // A message waiting behind a reply can be taken back before it starts.
    const dq = hub.createChat({ cwd: work })
    hub.send({ chatId: dq.id, to: leadId, text: 'Summarise the plan', mode: 'quick' })
    hub.send({ chatId: dq.id, to: leadId, text: 'Also the budget', mode: 'quick' })
    const waitingRow = rows(dq).find((i) => i.kind === 'user' && i.text === 'Also the budget')
    const firstRow = rows(dq).find((i) => i.kind === 'user' && i.text === 'Summarise the plan')
    check('a queued message can be taken back', !!waitingRow && hub.dequeue(dq.id, leadId, waitingRow.id) && (waitingRow as { withdrawn?: boolean }).withdrawn === true && hub.openChat(dq.id).states.find((x) => x.accountId === leadId)?.queued === 0)
    check('one that already started cannot', !!firstRow && !hub.dequeue(dq.id, leadId, firstRow.id))
    await until('the lead to be idle', () => idle(dq), 30_000)
    check('the taken-back message was never answered', rows(dq).filter((i) => i.kind === 'turn').length === 1)
    // Taken back from a turn that also carries a teammate's note: only the message goes, the note waits again.
    const HX = hub as unknown as { hold(chat: Chat, a: Account, w: { text: string; itemIds: string[] }, wake?: boolean): void; waiting: Map<string, { text: string }[]> }
    const bundle = hub.createChat({ cwd: work })
    hub.send({ chatId: bundle.id, to: leadId, text: 'Summarise the plan', mode: 'quick' })
    HX.hold(bundle, lead, { text: '<team-message from="Tester">The header is done.</team-message>', itemIds: [] }, false)
    hub.send({ chatId: bundle.id, to: leadId, text: 'And the footer?', mode: 'quick' })
    const footer = rows(bundle).find((i) => i.kind === 'user' && i.text === 'And the footer?')
    check('a message bundled with a note can be taken back', !!footer && hub.dequeue(bundle.id, leadId, footer.id))
    check('and the note waits again, not lost', (HX.waiting.get(`${bundle.id}:${leadId}`) || []).some((w) => /header is done/.test(w.text)))
    await until('the lead to be idle', () => idle(bundle), 30_000)

    // Lowering the permission level during a reply takes effect for certain.
    const perm = hub.createChat({ cwd: work })
    const lv = (): PermissionLevel | null | undefined => H.sessions.get(`${perm.id}:${leadId}`)?.runsAt
    hub.updateChat(perm.id, { permission: 'full' })
    hub.send({ chatId: perm.id, to: leadId, text: 'Tidy the readme', mode: 'quick' })
    same('the reply runs at full access', lv(), 'full')
    hub.updateChat(perm.id, { permission: 'ask' })
    await until('the reply to end', () => idle(perm), 30_000)
    check('the full-access process is gone once the reply ends', lv() !== 'full', String(lv()))
    hub.send({ chatId: perm.id, to: leadId, text: 'And the licence', mode: 'quick' })
    same('the next turn runs at the level the user chose', lv(), 'ask')
    await until('the lead to be idle', () => idle(perm), 30_000)
  }

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

// ───────────── Live answers (Canvas): pure functions of src/shared/iui.ts ─────────────
console.log('\nlive answers: blocks and formulas')
{
  const { parseBlock, looseJson, num, calcFormula, parseFormula, runCalc, formatValue, formatCompact, niceTicks, parseAppMeta } = iui
  same('loose JSON: trailing commas, comments, bare keys, single quotes', looseJson("{ type: 'chart', // a note\n x: ['a','b',], }"), { type: 'chart', x: ['a', 'b'] })
  same('loose JSON: curly quotes and a missing comma between lines', looseJson('{“type”: “stats”\n"items": []}'), { type: 'stats', items: [] })
  check('loose JSON: a broken block gives a reason with a line', (() => { try { looseJson('{"a": [1, 2'); return false } catch (e) { return /line 1/.test((e as Error).message) } })())
  same('numbers as models write them', ['12', '1,234.5', '$12', '45%', '1.2k', '(3)', '-4', 'abc', '', true].map(num), [12, 1234.5, 12, 45, 1200, -3, -4, null, null, 1])
  const ch = parseBlock('{"type":"chart","kind":"bar","x":["Jan","Feb","Mar"],"series":[{"name":"A","data":["10","20"]},{"name":"B","data":[1,2,3,4]}],}')
  check('chart: numbers as text and series of unequal length are forgiven', ch.ok && ch.block.type === 'chart' && JSON.stringify(ch.block.series.map((s) => s.data)) === '[[10,20,null],[1,2,3]]' && ch.notes.length === 1, JSON.stringify(ch))
  const bare = parseBlock('{"type":"chart","kind":"line","series":[5,6,7]}')
  check('chart: a bare list of numbers and no labels', bare.ok && bare.block.type === 'chart' && bare.block.x.join() === '1,2,3' && bare.block.series[0].data.join() === '5,6,7')
  const sc = parseBlock('{"type":"chart","kind":"scatter","series":[{"name":"S","data":[[1,2],{"x":3,"y":"4"},["a",1]]}]}')
  check('chart: scatter points as pairs or objects, bad ones dropped', sc.ok && sc.block.type === 'chart' && JSON.stringify(sc.block.series[0].points) === '[[1,2],[3,4]]')
  check('chart: {"type":"bar"} reads as a bar chart', (() => { const r = parseBlock('{"type":"bar","x":["a"],"series":[{"name":"n","data":[1]}]}'); return r.ok && r.block.type === 'chart' && r.block.kind === 'bar' })())
  check('chart: a wrong kind is refused with a reason', (() => { const r = parseBlock('{"type":"chart","kind":"radar","series":[1]}'); return !r.ok && /radar/.test(r.reason) })())
  check('chart: a pie with a negative value is refused', !parseBlock('{"type":"chart","kind":"pie","x":["a","b"],"series":[{"name":"n","data":[3,-1]}]}').ok)
  check('a block with no type gives a readable reason', (() => { const r = parseBlock('{"items":[]}'); return !r.ok && /no "type"/.test(r.reason) })())
  check('an unknown type names the known ones', (() => { const r = parseBlock('{"type":"carousel"}'); return !r.ok && /chart, table/.test(r.reason) })())
  check('not JSON at all gives a reason', (() => { const r = parseBlock('<b>hi</b>'); return !r.ok && /not valid JSON/.test(r.reason) })())
  const tb = parseBlock('{"type":"table","columns":["Plan","Price"],"rows":[["Solo","$12"],["Team","$40"]]}')
  check('table: list rows map onto columns; a column of prices becomes money, set right', tb.ok && tb.block.type === 'table' && tb.block.columns[1].format === 'money' && tb.block.columns[1].align === 'right' && tb.block.rows[1].Plan === 'Team', JSON.stringify(tb))
  const st = parseBlock('{"type":"stats","items":[{"label":"Revenue","value":1234567,"format":"money","delta":"+12%"},{"label":"Churn","value":"2.1%","delta":"-0.4 pts","good":"down"},{"label":"Flat","value":3,"delta":0}]}')
  check('stats: deltas lean good or bad, and "down is good" is honoured', st.ok && st.block.type === 'stats' && st.block.items.map((i) => i.tone).join() === 'good,good,flat' && st.block.items[0].value === '$1,234,567', JSON.stringify(st))
  const cmp = parseBlock('{"type":"compare","options":[{"name":"A","score":"7/10","pick":true},{"name":"B","pick":true,"score":9}]}')
  check('compare: "7/10" is a score and only the first pick stays', cmp.ok && cmp.block.type === 'compare' && cmp.block.options[0].score === 7 && cmp.block.options.filter((o) => o.pick).length === 1 && cmp.block.scale === 10)
  const steps = parseBlock('{"type":"steps","items":[{"title":"a","status":"completed"},{"title":"b","status":"in progress"},"c"]}')
  check('steps: statuses in other words', steps.ok && steps.block.type === 'steps' && steps.block.items.map((i) => i.status).join() === 'done,doing,todo')
  const dg = parseBlock('{"type":"diagram","edges":[["a","b"],{"from":"b","to":"c","label":"then"}]}')
  check('diagram: nodes come from the edges when missing', dg.ok && dg.block.type === 'diagram' && dg.block.nodes.length === 3 && dg.block.direction === 'right')
  const fm = parseBlock('{"type":"form","fields":[{"label":"Your budget","type":"currency","required":"yes"},{"label":"Plan","options":["Solo","Team"]}]}')
  check('form: names from labels, types in other words, options make a select', fm.ok && fm.block.type === 'form' && fm.block.fields[0].name === 'your_budget' && fm.block.fields[0].type === 'number' && fm.block.fields[0].required && fm.block.fields[1].type === 'select' && fm.block.submit === 'Send')
  const chs = parseBlock('{"type":"choices","options":["Yes","No"]}')
  check('choices: plain strings as options', chs.ok && chs.block.type === 'choices' && chs.block.options[1].value === 'No')
  same('formulas: precedence', [calcFormula('2+3*4'), calcFormula('(2+3)*4'), calcFormula('-2^2'), calcFormula('2^-1'), calcFormula('2^3^2'), calcFormula('7 % 3')], [14, 20, -4, 0.5, 512, 1])
  same('formulas: comparisons and a ? b : c', [calcFormula('3 > 2 ? 10 : 20'), calcFormula('1 == 2'), calcFormula('x >= 5 && x < 10', { x: 7 }), calcFormula('not 0')], [10, 0, 1, 1])
  same('formulas: the named functions', [calcFormula('min(3, 1, 2)'), calcFormula('max(1, 4)'), calcFormula('round(2.345, 2)'), calcFormula('sqrt(16) + abs(-1)'), calcFormula('pow(2, 10)'), calcFormula('floor(2.7) + ceil(2.1)'), Number(calcFormula('log(exp(2))').toFixed(9))], [1, 4, 2.35, 5, 1024, 5, 2])
  same('formulas: division by zero, bad input and unknown names are n/a, never a throw', [calcFormula('1/0'), calcFormula('sqrt(-1)'), calcFormula('2 +'), calcFormula('foo(1)'), calcFormula('x * 2'), calcFormula('constructor'), calcFormula('alert(1)')].map((v) => Number.isNaN(v)), [true, true, true, true, true, true, true])
  check('formulas: a parse error says what is wrong', (() => { try { parseFormula('max(1, 2'); return false } catch (e) { return /Expected "\)"/.test((e as Error).message) } })())
  const mort = parseBlock(JSON.stringify({ type: 'calc', inputs: [{ name: 'price', label: 'Price', default: 300000 }, { name: 'rate', label: 'Rate', type: 'range', min: 0, max: 10, default: 6 }, { name: 'years', label: 'Years', default: 30 }], outputs: [{ name: 'monthly', label: 'Monthly', formula: 'r = 0 ? 0 : 0', format: 'money' }] }))
  check('calc: a formula using a name that is not an input is refused', !mort.ok && /"r"/.test(mort.reason), JSON.stringify(mort))
  const calc = parseBlock(JSON.stringify({ type: 'calc', inputs: [{ name: 'price', label: 'Price', default: 300000 }, { name: 'rate', label: 'Rate', type: 'range', min: 0, max: 10, default: 6 }, { name: 'years', label: 'Years', default: 30 }], outputs: [{ name: 'monthly', label: 'Monthly payment', formula: 'price * (rate/1200) / (1 - (1 + rate/1200)^(-years*12))', format: 'money' }, { label: 'Total paid', formula: 'monthly * years * 12', format: 'money' }], chart: { x: 'rate', y: 'Monthly payment' } }))
  check('calc: reads, and the chart names its output by label', calc.ok && calc.block.type === 'calc' && calc.block.chart?.y === 0 && calc.block.chart.from === 0 && calc.block.chart.to === 10, JSON.stringify(calc))
  if (calc.ok && calc.block.type === 'calc') {
    const r = runCalc(calc.block, { price: 300000, rate: 6, years: 30 })
    same('calc: a mortgage works out, and later outputs use earlier ones', [r[0].toFixed(2), r[1].toFixed(0)], ['1798.65', '647515'])
    check('calc: a rate of 0 divides by zero and shows n/a', formatValue(runCalc(calc.block, { price: 1, rate: 0, years: 1 })[0], 'money') === 'n/a')
  }
  same('number formats', [formatValue(1234.5, 'money'), formatValue(-12.5, 'money', 'EUR'), formatValue(12.5, 'percent'), formatValue(0.1234), formatValue(1234567, 'integer'), formatValue(NaN), formatValue(3, 'number', 'kg')], ['$1,235', '-12.50 EUR', '13%', '0.123', '1,234,567', 'n/a', '3 kg'])
  same('compact numbers for axes', [formatCompact(950), formatCompact(12500), formatCompact(4_200_000, 'money'), formatCompact(-3, 'percent')], ['950', '12.5K', '$4.2M', '-3%'])
  same('round ticks', [niceTicks(0, 237), niceTicks(-12, 30, 4), niceTicks(5, 5)], [[0, 50, 100, 150, 200, 250], [-20, -10, 0, 10, 20, 30], [4.4, 4.6, 4.8, 5, 5.2, 5.4, 5.6]])
  same('mini app titles and heights', [parseAppMeta('title="Snake game" height=420'), parseAppMeta(''), parseAppMeta('height=5000')], [{ title: 'Snake game', height: 420 }, { title: 'Mini app', height: 360 }, { title: 'Mini app', height: 900 }])
  check('a "__proto__" key cannot reach the prototype', (() => { const o = looseJson('{"__proto__": {"x": 1}}') as Record<string, unknown>; return ({} as Record<string, unknown>).x === undefined && !Object.prototype.hasOwnProperty.call(o, '__proto__') })())
  const big = parseBlock(JSON.stringify({ type: 'chart', kind: 'line', x: Array.from({ length: 260 }, (_, i) => String(i)), series: [{ name: 'n', data: Array.from({ length: 260 }, (_, i) => i) }] }))
  check('a chart with too many points is cut to 200 and says so', big.ok && big.block.type === 'chart' && big.block.x.length === 200 && big.notes.some((n) => /200/.test(n)))
}
  {
    const examples = [...IUI_BRIEFING.matchAll(/```ui\n([\s\S]*?)\n```/g)].map((m) => iui.parseBlock(m[1]))
    check('every example block in the briefing passes the reader', examples.length >= 2 && examples.every((r) => r.ok), JSON.stringify(examples.map((r) => (r.ok ? r.block.type : r.reason))))
    check('the briefing stays about 400 words', IUI_BRIEFING.split(/\s+/).filter(Boolean).length <= 420, String(IUI_BRIEFING.split(/\s+/).filter(Boolean).length))
  }
// ───────────── end of Live answers checks ─────────────

await hub.dispose()
console.log(`\n${passed} passed, ${failed.length} failed`)
if (failed.length) {
  for (const f of failed) console.log(' -', f)
  process.exit(1)
}
process.exit(0)
