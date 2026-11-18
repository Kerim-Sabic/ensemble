// Dev-only: checks goals, loops and the ways of working against the real hub with the scripted
// demo team, from a terminal. No window, no account, no allowance.
//   pnpm auto-test
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Hub } from '../src/main/hub'
import { readVerdict } from '../src/main/autopilot'
import { countdown, everyLabel, goalLine, loopLine, namesLine, parseCommand, parseEvery, span, APP_COMMANDS, GOCRAZY_NEEDS_ULTRA, effectiveMode, MAX_DEPTH_GOCRAZY, MAX_DEPTH_ULTRA, MAX_DEPTH_USUAL, SPAWN_CAP_GOCRAZY, SPAWN_CAP_ULTRA, CRAZY_FLOOR, isSmallTalk } from '../src/shared/auto'
import { leadBriefing, memberBriefing, modeNote, modeReminder, crazyFollowUp, type BriefingContext } from '../src/main/prompts'
import { codexConfig } from '../src/main/providers/codex'
import { AccountManager } from '../src/main/accounts'
import { askClaudeOnce, onceResult } from '../src/main/providers/claude'
import { demoTime } from '../src/main/util'
import type { Account, Chat, HubEvent, Item, PermissionLevel } from '../src/shared/types'
import * as iui from '../src/shared/iui' // Live answers checks (Canvas), near the end
import { handoverLine, supplyOf, supplyWords } from '../src/shared/failover' // automatic handover checks (Failover)
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
  // Design work: generated images when the team has a ChatGPT account, SVG and CSS when it has none.
  {
    const claudeOnly = '- 2 Claude accounts (A, B): strongest Fable 5.2 (`fable`, effort up to max); fastest Haiku 5.5 (`haiku`)'
    const drawn = modeNote('ultra', { lead: true, team: true, spawn: true, cap: 16, models: team })
    const plain = modeNote('ultra', { lead: true, team: true, spawn: true, cap: 16, models: claudeOnly })
    check('ultra note: an image agent on a ChatGPT account serves the builders when the team has one', /image agent on a ChatGPT account/.test(drawn) && /moodboard/.test(drawn) && !/SVG and CSS/.test(drawn))
    check('and on a team without one, the builders draw in SVG and CSS', /SVG and CSS/.test(plain) && !/image agent/.test(plain))
    check('go crazy note: the images are a region of their own', /image agent on a ChatGPT account \(a region of its own\)/.test(crazy))
    const acct = (name: string, provider: 'claude' | 'chatgpt'): Account => ({ id: name.toLowerCase(), name, provider, configDir: null, enabled: true }) as unknown as Account
    const ctxOf = (self: Account, mates: Account[], lead: Account = self): BriefingContext => ({ self, lead, teammates: mates.map((account) => ({ account, available: true })), spawn: 4, depth: lead === self ? 0 : 1, smart: false, cwd: work, memory: null, hasTools: true, hands: { browser: false, computer: false }, menus: { claude: '', chatgpt: '' }, vault: null })
    const ada = acct('Ada', 'claude')
    const gale = acct('Gale', 'chatgpt')
    const withGpt = leadBriefing(ctxOf(ada, [gale]))
    const noGpt = leadBriefing(ctxOf(ada, [acct('Bo', 'claude')]))
    check('lead briefing: design uses generated images in full when the team has a ChatGPT account', /moodboard/.test(withGpt) && /art director/.test(withGpt) && /real product screenshot/.test(withGpt) && /paths of the generated images/.test(withGpt) && /several variations of each asset/.test(withGpt))
    check('and SVG and CSS when it has none, with no pictures promised', /SVG and CSS/.test(noGpt) && !/moodboard/.test(noGpt))
    const gptMember = memberBriefing(ctxOf(gale, [ada], ada))
    const claudeMember = memberBriefing(ctxOf(acct('Cy', 'claude'), [ada], ada))
    check('member briefings: a ChatGPT member makes the pictures itself and copies them into the project', /you generate them yourself/.test(gptMember) && /copy each one/.test(gptMember))
    check('a Claude member on a team with no ChatGPT account draws in SVG and CSS', /SVG and CSS/.test(claudeMember) && !/moodboard/.test(claudeMember))
  }
  check('ultra note: small follow-ups get a direct answer, the stages are for real work', /scale this to the message/.test(ultra) && /thank-you/.test(ultra) && /new, substantial request/.test(crazy))
  check('ultra note when alone: the stages in passes', /in separate passes/.test(modeNote('ultra', { lead: true, team: false, spawn: false })))
  check('ultra note: the lead chooses a shape (tournament, divide and assemble, investigation)', /Tournament, for work/.test(ultra) && /Divide and assemble/.test(ultra) && /Investigation, for a question/.test(ultra) && /small cell/.test(ultra))
  check('go crazy note: eight levels and a cross-critique round', /eight levels below you/.test(crazy) && /eighth level/.test(crazy) && /cross-critique round/.test(crazy))
  check('go crazy note: its numbers are floors, and only real small talk skips the stages', /floors, not ceilings/.test(crazy) && /at least 8 agents/.test(crazy) && /however briefly it is put/.test(crazy))
  same('small talk, as the app reads it', ['Thanks!', 'Chose: Use version B', 'status?', 'Any news?', 'build the landing page', 'fix it', 'Research our competitors and write it up'].map(isSmallTalk), [true, true, true, true, false, false, false])
  const follow = crazyFollowUp({ started: 2, floor: 8, room: 30, depth: 8 })
  check('the one follow-up: the count, the floor, the live room and depth, the team tool, and what to do when refused', /only 2 agents/.test(follow) && /at least 8/.test(follow) && /up to 30 more agents/.test(follow) && /down to 8 levels/.test(follow) && /mcp__team__spawn_agent/.test(follow) && /If a spawn was refused/.test(follow))
  const codex = codexConfig({ team: { url: 'http://127.0.0.1:1/mcp/x' } }) as { agents?: { enabled?: boolean }; features?: Record<string, boolean>; mcp_servers?: Record<string, unknown> }
  check("ChatGPT agents get the team's tool server and none of Codex's own agent tools", codex.agents?.enabled === false && codex.features?.multi_agent === false && codex.features?.sleep_tool === false && !!codex.mcp_servers?.team)
  check('go crazy note: a brain in regions (sub-leads with teams, lateral links, feedback loops, memory, attention, integrator)', /like a brain, in regions/.test(crazy) && /3 to 5 region leads/.test(crazy) && /Lateral links/.test(crazy) && /Feedback loops/.test(crazy) && /memory \(keeps the board current/.test(crazy) && /Attention/.test(crazy) && /integrator/.test(crazy))
  check('ultra note: no regions, the brain is for Go crazy', !/in regions/.test(ultra))
  const keep = modeReminder('gocrazy', { cap: 30, depth: 5, total: 48 })
  check('goal reminder for Go crazy: the regions, the room and depth now, and the goal\'s limits', /mode="gocrazy"/.test(keep) && /regions/.test(keep) && /up to 30 more agents \(48 in the chat at most\), down to 5 levels/.test(keep) && /rounds, its time, and the user's Stop/.test(keep))
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
        block('modeNote("gocrazy"), ChatGPT-only team (4 accounts), cap 48, depth 5', modeNote('gocrazy', { lead: true, team: true, spawn: true, cap: 48, models: gpt4, depth: 5 })),
        block('modeReminder("gocrazy"): ahead of each later round of a goal set in Go crazy', modeReminder('gocrazy', { cap: 30, depth: 5, total: 48 })),
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
    const img = hub.tasksOf(chat.id).find((t) => t.title.startsWith('Images:'))
    const builtWith = hub.tasksOf(chat.id).filter((t) => t.title.startsWith('Build:'))
    check('ultra design run: a ChatGPT agent makes the moodboard and the hero, and the builders build with them', !!img && img.status === 'done' && hub.accounts.get(img.to)?.provider === 'chatgpt' && builtWith.length > 0 && builtWith.every((t) => (t.after || []).includes(img.id) && /designs\/assets\//.test(t.brief)), img ? `${img.status} on ${hub.accounts.get(img.to)?.provider}` : 'no image task')
    const staged = hub.tasksOf(chat.id).filter((t) => /^(Scout|Build|Judge):/.test(t.title))
    const on = (kind: string): string => staged.filter((t) => t.title.startsWith(kind)).map((t) => `${t.model}`).join(',')
    check('ultra: scouts on the fast models (Haiku and Luna), builders and judges on the strongest', staged.length >= 7 && /haiku/i.test(on('Scout')) && /luna/i.test(on('Scout')) && /fable/i.test(on('Build')) && /astra/i.test(on('Build')), `scouts ${on('Scout')} builders ${on('Build')} judges ${on('Judge')}`)
    const swept = await hub.sweepIdle(chat, 0)
    check('ultra: agents left idle after the run are sent home', swept.length > 0 && (chat.agents || []).every((a) => a.spawned?.gone), swept.join(', '))
    check('and the lead is told who went', rows(chat).some((i) => i.kind === 'notice' && /home after a few minutes idle/.test(i.text)))
    const builds = staged.filter((t) => t.title.startsWith('Build'))
    check('what a task waits for is said in names, never task ids', builds.length > 0 && builds.every((t) => /^4 scouts( and Image maker)?$/.test(t.afterFor || '')) && staged.every((t) => !/\bt\d+\b/.test(`${t.afterFor || ''} ${t.waitingFor || ''}`)), builds.map((t) => t.afterFor).join(' | '))
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
    same('going crazy, the cap is what the machine carries (up to a safety stop of 200)', [SPAWN_CAP_GOCRAZY, hub.agentCap(crazy)], [200, Math.max(usual, Math.min(200, hub.machineCap(crazy)))])
    same('the depth rises to 8 while going crazy', [MAX_DEPTH_GOCRAZY, hub.maxDepth(crazy)], [8, 8])
    check('chat.crazy is on while going crazy, and the window hears it', crazy.crazy === true && events.some((e) => e.type === 'chat' && e.chat.id === crazy.id && e.chat.crazy === true))
    {
      // The cap is bounded by the memory there is: 3 agents' worth free after the reserve.
      const real = hub.machine
      const live = (crazy.agents || []).filter((a) => !a.spawned?.gone).length
      hub.machine = { free: () => 2 * 1024 ** 3 + 3 * 400 * 1024 ** 2 + 1, total: () => 8 * 1024 ** 3, cores: () => 64 }
      same('with little free memory the Go crazy cap is what fits', [hub.memoryCap(crazy), hub.agentCap(crazy)], [live + 3, Math.max(usual, live + 3)])
      hub.machine = { free: () => 512 * 1024 ** 3, total: () => 1024 * 1024 ** 3, cores: () => 2 }
      same('with few processor cores the cap is what they carry (6 each)', hub.agentCap(crazy), Math.max(usual, 12))
      hub.machine = { free: () => 512 * 1024 ** 3, total: () => 1024 * 1024 ** 3, cores: () => 128 }
      same('with a huge machine there is no set number, only the safety stop', hub.agentCap(crazy), 200)
      hub.machine = { ...real, free: () => 2 * 1024 ** 3 + 30 * 400 * 1024 ** 2, total: () => 8 * 1024 ** 3, cores: () => 64 }
      const roster = hub['rosterText'](crazy, hub.accounts.get(leadId)!) as string
      const roomNow = hub['spawnRoom'](crazy, hub.accounts.get(leadId)!) as number
      check('the roster shows the live room', new RegExp(`You can start ${roomNow} more`).test(roster) && roomNow <= 30, (/You can start[^\n]*/.exec(roster) || [''])[0])
      hub.machine = real
    }
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
    const regions = (crazy.agents || []).filter((a) => depthOf(a) === 1)
    const teams = regions.filter((r) => (crazy.agents || []).some((a) => a.spawned?.by === r.id))
    check('go crazy: 3 to 5 regions, each a lead at depth 1 with a team of its own', teams.length >= 3 && teams.length <= 5, regions.map((r) => `${r.name}:${(crazy.agents || []).filter((a) => a.spawned?.by === r.id).length}`).join(', '))
    check('go crazy: scouts, builders and judges are in their regions (depth 2)', ['Scout 1', 'Scout 8', 'Builder A', 'Builder D', 'Judge 1', 'Judge 3', 'Archivist'].every((n) => depthOf(byName(crazy, n) || ({} as Account)) === 2) && byName(crazy, 'Scout 1')?.spawned?.by === byName(crazy, 'Research lead')?.id && byName(crazy, 'Builder A')?.spawned?.by === byName(crazy, 'Build lead')?.id, deep.map((a) => `${a.name}@${depthOf(a)}`).join(', '))
    check('go crazy: builders start a critic and a tester, a judge a verifier (depth 3)', ['Critic A', 'Critic B', 'Critic C', 'Critic D', 'Tester A', 'Tester B', 'Verifier'].every((n) => depthOf(byName(crazy, n) || ({} as Account)) === 3), deep.map((a) => `${a.name}@${depthOf(a)}`).join(', '))
    const fc = byName(crazy, 'Fact-checker A')
    check('go crazy: a critic starts a fact-checker (depth 4)', !!fc && depthOf(fc) === 4 && fc.spawned?.by === byName(crazy, 'Critic A')?.id)
    const buildLead = byName(crazy, 'Build lead')
    const memoryLead = byName(crazy, 'Memory lead')
    const lateral = buildLead && memoryLead ? (hub.openChat(crazy.id).items[buildLead.id] || []).some((i) => i.kind === 'outgoing' && i.to === memoryLead.id) : false
    check('go crazy: a lateral message between regions (building tells memory)', lateral)
    check('go crazy: the memory region keeps the board (findings and decisions)', /Findings/.test(hub['boardText'](crazy) as string) && /Decisions/.test(hub['boardText'](crazy) as string))
    const crazyImg = hub.tasksOf(crazy.id).find((t) => t.title.startsWith('Images:'))
    check('go crazy design run: an image region on ChatGPT, and building waits for it', !!crazyImg && crazyImg.status === 'done' && hub.accounts.get(crazyImg.to)?.provider === 'chatgpt' && hub.tasksOf(crazy.id).some((t) => t.title === 'Region: building' && (t.after || []).includes(crazyImg.id)))
    check('go crazy: about 28 agents, within the cap', (crazy.agents || []).length >= 25 && (crazy.agents || []).length <= SPAWN_CAP_GOCRAZY, String((crazy.agents || []).length))
    const crazyTasks = hub.tasksOf(crazy.id)
    check('go crazy: every task ended done', crazyTasks.every((t) => t.status === 'done'), crazyTasks.filter((t) => t.status !== 'done').map((t) => `${t.title}:${t.status}`).join(', '))
    check('go crazy: helpers report to whoever started them', crazyTasks.filter((t) => /^(Critique|Test|Verify|Fact-check):/.test(t.title)).every((t) => hub.accounts.get(t.to)?.spawned?.by === t.from))
    // The run is over: the chat is back to plain Ultra by itself, without waiting for the user's next message.
    same('when a Go crazy run ends, the cap and the depth go back to Ultra', [hub.agentCap(crazy), hub.maxDepth(crazy)], [Math.max(usual, SPAWN_CAP_ULTRA), 3])
    check('and chat.crazy goes off', !crazy.crazy)
    if (fc) {
      // The next two checks are about a run in progress.
      hub['markUltra'](crazy, 'gocrazy')
      let deepest: Account | undefined = fc
      for (const n of ['Level 5', 'Level 6', 'Level 7', 'Level 8']) {
        hub['spawn'](crazy, deepest!, { name: n, role: 'one level further down' })
        deepest = byName(crazy, n) || deepest
      }
      check('going crazy allows eight levels', deepest?.spawned?.depth === 8, `${deepest?.name}@${deepest?.spawned?.depth}`)
      const refused = deepest ? (hub['spawn'](crazy, deepest, { name: 'Too deep', role: 'should not exist' }) as string) : ''
      check('an agent at the last level is refused with a clear message', /deepest level/.test(refused) && !byName(crazy, 'Too deep'), refused)
    }
    const builderA = byName(crazy, 'Builder A')
    if (builderA) {
      await hub.removeAgent(crazy.id, builderA.id)
      check('a subtree goes home with its parent', ['Builder A', 'Critic A', 'Tester A', 'Fact-checker A'].every((n) => byName(crazy, n)?.spawned?.gone), ['Critic A', 'Tester A', 'Fact-checker A'].map((n) => `${n}:${!!byName(crazy, n)?.spawned?.gone}`).join(' '))
    }

    // Brain mode: Ultra, Go crazy and a goal together. Every round of the goal runs in Go crazy.
    {
      const brain = hub.createChat({ cwd: work })
      hub.setUltra(brain.id, true)
      const leadAcc = hub.accounts.get(leadId)!
      const sent: string[] = []
      const ses = hub['session'](brain, leadAcc) as { enqueue: (p: { text: string }, front?: boolean) => void }
      const real = ses.enqueue.bind(ses)
      ses.enqueue = (p, front) => {
        sent.push(p.text)
        real(p, front)
      }
      hub.send({ chatId: brain.id, to: leadId, text: 'Add a pricing page', mode: 'gocrazy', goal: { doneWhen: 'the tests pass and the page was opened' } })
      check('a goal set in Go crazy keeps that mode', brain.goal?.mode === 'gocrazy' && brain.crazy === true, `${brain.goal?.mode} ${brain.crazy}`)
      await until('round 2 of the Go crazy goal', () => (brain.goal?.round || 0) >= 1 && sent.length >= 2, 60_000)
      const round2 = sent[sent.length - 1]
      check('round 2 carries the Go crazy reminder with the room and depth in force', /<way-of-working mode="gocrazy">/.test(round2) && /This goal runs in Go crazy/.test(round2) && /down to 8 levels/.test(round2) && /<goal-check round="2"/.test(round2), round2.slice(0, 300))
      same('and the Go crazy cap and depth hold in round 2', [hub.agentCap(brain), hub.maxDepth(brain), brain.crazy], [Math.max(usual, Math.min(200, hub.machineCap(brain))), 8, true])
      await until('the Go crazy goal to be met', () => brain.goal?.status === 'met' && idle(brain), 60_000)
      same('once the goal is met, Go crazy ends with it', [!!brain.crazy, hub.agentCap(brain), hub.maxDepth(brain)], [false, Math.max(usual, SPAWN_CAP_ULTRA), 3])
      check('the goal kept to its rounds', (brain.goal?.round || 0) + 1 <= (brain.goal?.maxRounds || 0))

      const stopped = hub.createChat({ cwd: work })
      hub.setUltra(stopped.id, true)
      hub.send({ chatId: stopped.id, to: leadId, text: 'Add a pricing page', mode: 'gocrazy', goal: { doneWhen: 'the tests pass' } })
      check('a second Go crazy goal is under way', stopped.crazy === true && stopped.goal?.status === 'active')
      await hub.goalAction(stopped.id, 'stop')
      same('a stopped goal ends the Go crazy run', [stopped.goal?.status, !!stopped.crazy, hub.agentCap(stopped), hub.maxDepth(stopped)], ['stopped', false, Math.max(usual, SPAWN_CAP_ULTRA), 3])
      await until('the stopped chat to be idle', () => idle(stopped), 30_000)

      const off = hub.createChat({ cwd: work })
      hub.setUltra(off.id, true)
      hub.send({ chatId: off.id, to: leadId, text: 'Add a pricing page', mode: 'gocrazy', goal: { doneWhen: 'the tests pass' } })
      hub.setUltra(off.id, false)
      check('turning Ultra off ends Go crazy, goal or not', !off.crazy && hub.maxDepth(off) === 2)
      await hub.goalAction(off.id, 'stop')
      await until('that chat to be idle', () => idle(off), 30_000)
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

    // A lead out of allowance with handover switched off: what reaches it waits, one offer to switch, and the new lead gets it all.
    hub.updateSettings({ handover: false })
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
    check('handover off: no automatic handover, the old offer only', !dry.cover && rows(dry, member.id).every((i) => !(i.kind === 'notice' && i.handover)))
    hub.accounts.setUsage(leadId, { session: { utilization: 0.2, resetsAt: refill } })
    await hub.stop(dry.id)
    hub.updateSettings({ handover: true })

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

    // Steering: a message sent while the lead works reaches the work under way.
    const st = hub.createChat({ cwd: work })
    hub.send({ chatId: st.id, to: leadId, text: 'Add a pricing page with a checkout flow' })
    await until('the lead to be working', () => !idle(st), 10_000)
    await pause(300)
    const how = hub.steer({ chatId: st.id, to: leadId, text: 'stop that and just say STEERED' })
    same('a message to a working agent is steered in', how, 'steered')
    const said = rows(st).filter((i) => i.kind === 'user' && /just say STEERED/.test(i.text))
    check('it shows once, where it was sent, marked as steered and not waiting', said.length === 1 && (said[0] as { steered?: boolean }).steered === true && !(said[0] as { queued?: boolean }).queued, JSON.stringify(said))
    check('nothing is lined up behind the turn', hub.openChat(st.id).states.find((x) => x.accountId === leadId)?.queued === 0)
    await until('the lead to finish', () => idle(st), 30_000)
    const turnsSteered = rows(st).filter((i) => i.kind === 'turn')
    const lastSaid = [...rows(st)].reverse().find((i) => i.kind === 'assistant')
    check('the work under way changed course: its reply is the steered one', !!lastSaid && (lastSaid as { text: string }).text.trim() === 'STEERED', lastSaid && (lastSaid as { text: string }).text)
    check('in the same turn: one turn for the whole piece of work, not a second one', turnsSteered.length === 1 && (turnsSteered[0] as { status?: string }).status === 'done', JSON.stringify(turnsSteered.map((t) => (t as { status?: string }).status)))
    check('and nothing was handed out after the change of course', hub.tasksOf(st.id).length === 0, String(hub.tasksOf(st.id).length))
    // An agent that is not working: the message goes the usual way, as a turn of its own.
    same('to an idle agent it is sent as usual', hub.steer({ chatId: st.id, to: leadId, text: 'Thanks', mode: 'quick' }), 'sent')
    await until('the lead to answer', () => rows(st).filter((i) => i.kind === 'turn').length === 2 && idle(st), 30_000)
    // A command is never steered in: it goes through send(), which reads it.
    const sc = hub.createChat({ cwd: work })
    hub.send({ chatId: sc.id, to: leadId, text: 'Summarise the plan', mode: 'quick' })
    same('a command goes the usual way even while the agent works', hub.steer({ chatId: sc.id, to: leadId, text: '/goal pause' }), 'sent')
    await until('the lead to be idle', () => idle(sc), 30_000)
    // Stopped right after steering: the steered words stay in the transcript, and nothing runs on by itself afterwards.
    const ss = hub.createChat({ cwd: work })
    hub.send({ chatId: ss.id, to: leadId, text: 'Add a pricing page with a checkout flow' })
    await until('the lead to be working', () => !idle(ss), 10_000)
    hub.steer({ chatId: ss.id, to: leadId, text: 'Use a dark theme too' })
    await hub.stop(ss.id, leadId)
    await until('the lead to stop', () => idle(ss), 10_000)
    await pause(1500)
    const ssTurns = rows(ss).filter((i) => i.kind === 'turn')
    check('stopped after steering: the words stay, one interrupted turn, nothing runs on its own', rows(ss).filter((i) => i.kind === 'user' && /dark theme/.test(i.text)).length === 1 && ssTurns.length === 1 && (ssTurns[0] as { status?: string }).status === 'interrupted' && idle(ss), JSON.stringify(ssTurns.map((t) => (t as { status?: string }).status)))
  }

  console.log('\nautomatic handover when an account runs out')
  {
    type Sp = { name?: string; role: string; account?: string; brief?: string; title?: string }
    const H = hub as unknown as {
      assign(chat: Chat, from: Account, a: { to: string; title: string; brief: string }): string
      spawn(chat: Chat, by: Account, a: Sp): string
      memoryOf(chat: Chat, a: Account): string
    }
    const ids = hub.accounts.accounts.filter((a) => a.enabled).map((a) => a.id)
    const c3 = hub.accounts.accounts.find((a) => a.name === 'Claude 3')!
    const hello = hub.accounts.accounts.find((a) => a.name === 'Hello')!
    const gpt = hub.accounts.accounts.find((a) => a.provider === 'chatgpt')!
    const hour = 3600e3
    const out = (id: string, at: number): void => hub.accounts.setUsage(id, { session: { utilization: 1, resetsAt: at, status: 'rejected' } })
    const low = (id: string): void => hub.accounts.setUsage(id, { session: { utilization: 0.93, resetsAt: Date.now() + 2 * hour, status: 'allowed_warning' } })
    const fine = (id: string): void => hub.accounts.setUsage(id, { session: { utilization: 0.2, resetsAt: Date.now() + 3 * hour, status: 'allowed' } })
    const handovers = (chat: Chat): Item[] => ids.flatMap((id) => rows(chat, id).filter((i) => i.kind === 'notice' && !!i.handover))
    const errors = (chat: Chat, who: string): Item[] => rows(chat, who).filter((i) => i.kind === 'notice' && i.level === 'error')
    const clk = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    // The states, worked out from the usage windows, with give so an account near the line does not flip.
    const now = Date.now()
    same('fine, running low, out', [supplyOf({ session: { utilization: 0.5, resetsAt: now + hour } }).state, supplyOf({ session: { utilization: 0.91, resetsAt: now + hour } }).state, supplyOf({ weekly: { utilization: 0.96, resetsAt: now + hour } }).state, supplyOf({ session: { utilization: 0.4, resetsAt: now + hour, status: 'rejected' } }).state], ['ok', 'low', 'low', 'out'])
    same('low stays low until clearly below the line', [supplyOf({ session: { utilization: 0.85, resetsAt: now + hour } }, { state: 'low', until: null }).state, supplyOf({ session: { utilization: 0.8, resetsAt: now + hour } }, { state: 'low', until: null }).state], ['low', 'ok'])
    check('a window whose refill time has passed is fine again', supplyOf({ session: { utilization: 1, resetsAt: now - 1000, status: 'rejected' } }).state === 'ok')
    check('out until the later refill when both windows are out', supplyOf({ session: { utilization: 1, resetsAt: now + hour }, weekly: { utilization: 1, resetsAt: now + 5 * hour } }).until === now + 5 * hour)
    same('the team panel words', [supplyWords({ state: 'out', until: now }, () => '14:30', 'Hello'), supplyWords({ state: 'low', until: null }, clk), supplyWords({ state: 'ok', until: null }, clk)], ['Out until 14:30 · covered by Hello', 'Running low', ''])
    same('the handover line', handoverLine('Hello', 'Main', 'out', now, () => '14:30'), 'Hello took over as lead: Main ran out of usage. Main is back at 14:30.')
    check('the state reaches the window with the usage', (() => { out(c3.id, now + hour); const u = hub.accounts.usage.get(c3.id); fine(c3.id); return u?.supply?.state === 'out' })())

    // 1. The lead runs out in the middle of a reply: the best placed teammate takes over by itself.
    const mid = hub.createChat({ cwd: work })
    hub.send({ chatId: mid.id, to: leadId, text: 'Add a pricing page, and simulate a limit' })
    await until('a teammate to take over', () => !!mid.cover, 20_000)
    const next = hub.lead(mid)!
    check('a Claude teammate with room took over, not the lead itself', next.id !== leadId && next.provider === 'claude' && mid.cover?.from === leadId && mid.cover.why === 'out', `${next.name} ${JSON.stringify(mid.cover)}`)
    const row = handovers(mid)
    check('one clean handover row, in the new lead\'s transcript: who, why, back when', row.length === 1 && rows(mid, next.id).includes(row[0]) && /took over as lead: Main ran out of usage\. Main is back at \d/.test((row[0] as { text: string }).text), JSON.stringify(row.map((r) => (r as { text: string }).text)))
    check('no error and no switch offer on the old lead', errors(mid, leadId).length === 0 && !rows(mid).some((i) => i.kind === 'notice' && i.action?.kind === 'switch-lead'))
    await until('the new lead to carry on the interrupted work', () => rows(mid, next.id).some((i) => i.kind === 'turn'), 30_000)
    check('nothing is left waiting on the old lead', !rows(mid).some((i) => 'queued' in i && i.queued))
    check('what the user asked shows in the new lead transcript too', rows(mid, next.id).some((i) => i.kind === 'user' && /simulate a limit/.test(i.text)))
    hub.send({ chatId: mid.id, to: next.id, text: 'Thanks. What is left?', mode: 'quick' })
    out(leadId, Date.now() + 2 * hour)
    await pause(300)
    same('never twice for one outage', handovers(mid).length, 1)
    fine(leadId)
    await until('the hand-back to be offered once the old lead refills', () => mid.cover?.back === true, 5000)
    await until('the new lead to be idle', () => idle(mid, next.id), 30_000)
    await hub.setChatLead(mid.id, leadId)
    check('handing back is one click, and clears the cover', hub.lead(mid)?.id === leadId && !mid.cover)

    // 2. The lead is out before a message: it hands over first and the message goes to the new lead.
    const before = hub.createChat({ cwd: work })
    out(leadId, Date.now() + hour)
    hub.send({ chatId: before.id, to: leadId, text: 'What is the state of the build?', mode: 'quick' })
    const took = hub.lead(before)!
    check('the message went to whoever took over', took.id !== leadId && rows(before, took.id).some((i) => i.kind === 'user' && i.text === 'What is the state of the build?'), took.name)
    await until('it to answer', () => idle(before, took.id) && rows(before, took.id).some((i) => i.kind === 'turn'), 30_000)
    fine(leadId)

    // 3. A teammate's task: its account runs out partway, and it moves to someone with room.
    const job = hub.createChat({ cwd: work })
    H.assign(job, lead, { to: c3.name, title: 'Write the header', brief: 'Write the site header.' })
    out(c3.id, Date.now() + hour)
    const task = (): ReturnType<typeof hub.tasksOf>[number] | undefined => hub.tasksOf(job.id)[0]
    await until('the task to move', () => !!task()?.movedFrom, 20_000)
    check('it moved off the account that ran out, to one with room', task()?.movedFrom === c3.id && task()?.to !== c3.id && hub.accounts.supply(task()!.to).state === 'ok' && task()?.moves === 1, JSON.stringify({ to: task()?.to, moves: task()?.moves }))
    check('the lead is told in one line', rows(job).some((i) => i.kind === 'notice' && /Claude 3 ran out of allowance, so .+ picked up "Write the header"/.test(i.text)))
    await until('the moved task to finish', () => task()?.status === 'done', 30_000)
    check('no error row on the agent that ran out', errors(job, c3.id).length === 0)
    // New work avoids an account that is out, and one that is running low while others have room.
    low(hello.id)
    H.assign(job, lead, { to: 'auto', title: 'Write the footer', brief: 'Write the site footer.' })
    const second = hub.tasksOf(job.id).find((t) => t.title === 'Write the footer')
    check('new work skips accounts that are out or running low', !!second && second.to !== c3.id && second.to !== hello.id, second?.to)
    fine(hello.id)
    fine(c3.id)
    await until('the footer to finish', () => second?.status === 'done', 30_000)

    // 4. Agents started in the chat: their account runs out, and they move to one with room.
    const kids = hub.createChat({ cwd: work })
    H.spawn(kids, lead, { name: 'Critic', role: 'reviews the header', account: c3.name, title: 'Look over the header', brief: 'Look over the header and say what to fix.' })
    const critic = (kids.agents || []).find((a) => a.name === 'Critic')!
    out(c3.id, Date.now() + hour)
    await until('the agent to move', () => critic.spawned?.base !== c3.id, 20_000)
    check('a started agent whose account ran out moved to an account with room', !!critic.spawned && critic.spawned.base !== c3.id && hub.accounts.supply(critic.spawned.base).state === 'ok', critic.spawned?.base)
    check('whoever started it is told in one line', rows(kids).some((i) => i.kind === 'notice' && /Critic moved from Claude 3's account to .+'s: Claude 3 ran out of usage/.test(i.text)))
    const ctask = hub.tasksOf(kids.id).find((t) => t.to === critic.id)
    await until('its task to finish on the new account', () => ctask?.status === 'done', 30_000)
    check('it carries a summary of its work', /Task from Main, "Look over the header"/.test(H.memoryOf(kids, critic)))
    // A sub-agent two levels down, idle on an account that runs out, moves when it is next given work.
    fine(c3.id)
    H.spawn(kids, critic, { name: 'Fact-checker', role: 'checks claims', account: c3.name })
    const fc = (kids.agents || []).find((a) => a.name === 'Fact-checker')!
    check('a sub-agent at depth 2 was started on Claude 3', fc?.spawned?.depth === 2 && fc.spawned.base === c3.id, JSON.stringify(fc?.spawned))
    out(c3.id, Date.now() + hour)
    const handed = H.assign(kids, critic, { to: fc.name, title: 'Check the claims', brief: 'Check every claim in the header copy.' })
    check('work for it is accepted while another account has room', /Fact-checker/.test(handed) && !/no usage allowance/.test(handed), handed)
    await until('the sub-agent to move', () => fc.spawned?.base !== c3.id, 10_000)
    const ftask = hub.tasksOf(kids.id).find((t) => t.to === fc.id)
    await until('the sub-agent\'s task to finish', () => ftask?.status === 'done', 30_000)
    check('the sub-agent moved before its turn and did the work', fc.spawned!.base !== c3.id && ftask?.status === 'done' && rows(kids, critic.id).some((i) => i.kind === 'notice' && /Fact-checker moved from Claude 3/.test(i.text)))
    fine(c3.id)
    await until('everyone in the chat to be idle', () => hub.openChat(kids.id).states.every((x) => x.phase === 'idle' || x.phase === 'error'), 30_000)
    // Three levels down in Ultra, running out in the middle of its task: it moves and starts the task again.
    const deep = hub.createChat({ cwd: work })
    hub.setUltra(deep.id, true)
    H.spawn(deep, lead, { name: 'Builder', role: 'builds a version' })
    const builder = (deep.agents || []).find((a) => a.name === 'Builder')!
    H.spawn(deep, builder, { name: 'Critic B', role: 'critiques it' })
    const cb = (deep.agents || []).find((a) => a.name === 'Critic B')!
    H.spawn(deep, cb, { name: 'Checker', role: 'checks the critique', account: c3.name, title: 'Check the critique', brief: 'Check each point in the critique.' })
    const checker = (deep.agents || []).find((a) => a.name === 'Checker')!
    out(c3.id, Date.now() + hour)
    const dtask = hub.tasksOf(deep.id).find((t) => t.to === checker?.id)
    await until('the depth-3 agent to move and finish', () => dtask?.status === 'done', 30_000)
    check('an agent at depth 3 that ran out partway moved and finished its task', checker?.spawned?.depth === 3 && checker.spawned.base !== c3.id && dtask?.moves === 1 && dtask.movedFrom === c3.id, JSON.stringify({ spawned: checker?.spawned, moves: dtask?.moves }))
    fine(c3.id)
    await until('the deep chat to be idle', () => hub.openChat(deep.id).states.every((x) => x.phase === 'idle' || x.phase === 'error'), 30_000)
    hub.setUltra(deep.id, false)

    // 5. Every account is out: the work waits, the chat is told once, and the first refill takes it.
    const all = hub.createChat({ cwd: work })
    const first = Date.now() + 40 * 60e3
    out(leadId, Date.now() + 2 * hour)
    out(hello.id, Date.now() + 3 * hour)
    out(gpt.id, Date.now() + 4 * hour)
    out(c3.id, first)
    hub.send({ chatId: all.id, to: leadId, text: 'Summarise the plan', mode: 'quick' })
    hub.send({ chatId: all.id, to: leadId, text: 'And the budget', mode: 'quick' })
    const told = rows(all).filter((i) => i.kind === 'notice' && /Every account on the team is out of usage/.test(i.text))
    check('told once, with the earliest refill and who it is', told.length === 1 && new RegExp(`goes on by itself at ${clk(first)}, when Claude 3 refills`).test((told[0] as { text: string }).text), JSON.stringify(told.map((t) => (t as { text: string }).text)))
    check('the messages wait, no handover, no error', !all.cover && handovers(all).length === 0 && rows(all).filter((i) => i.kind === 'user' && i.queued).length === 2 && errors(all, leadId).length === 0)
    fine(c3.id)
    await until('the first account to refill takes the waiting work', () => all.cover?.to === c3.id, 5000)
    await until('the waiting messages to be answered', () => rows(all, c3.id).some((i) => i.kind === 'turn'), 30_000)
    check('nothing is left waiting', !rows(all).some((i) => 'queued' in i && i.queued))
    for (const id of ids) fine(id)
    await until('the new lead to be idle', () => idle(all, c3.id), 30_000)

    // 6. No flapping: a lead that is only running low hands over to an account that is fine, once.
    const calm = hub.createChat({ cwd: work })
    low(leadId)
    low(c3.id)
    hub.send({ chatId: calm.id, to: leadId, text: 'Tidy the readme', mode: 'quick' })
    const took2 = hub.lead(calm)!
    check('running low hands over, to an account that is itself fine', calm.cover?.why === 'low' && took2.id !== leadId && took2.id !== c3.id && hub.accounts.supply(took2.id).state === 'ok', `${took2.name} ${JSON.stringify(calm.cover)}`)
    check('the line says it is about to run out', /Main is about to run out of usage/.test((handovers(calm)[0] as { text?: string })?.text || ''))
    await until('the new lead to answer', () => idle(calm, took2.id) && rows(calm, took2.id).some((i) => i.kind === 'turn'), 30_000)
    low(took2.id)
    hub.send({ chatId: calm.id, to: took2.id, text: 'And the licence', mode: 'quick' })
    same('a second account running low right after does not bounce the lead again', [handovers(calm).length, hub.lead(calm)?.id], [1, took2.id])
    await until('the lead to be idle', () => idle(calm, took2.id), 30_000)
    for (const id of ids) fine(id)
    for (const c of [mid, before, job, kids, all, calm]) await hub.stop(c.id)
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
  console.log('\ngo crazy: the one follow-up, and a team of ChatGPT accounts only')
  {
    const leadAcc = hub.accounts.get(leadId)!
    // A known effort the model lacks runs at the nearest one below; a word that is no level is refused with why.
    const clamp = hub['runFor'](leadAcc, 'haiku', 'max') as { run: { effort?: string } } | string
    check('effort "max" on a model that stops at "high" runs at "high"', typeof clamp !== 'string' && clamp.run.effort === 'high', JSON.stringify(clamp))
    const bad = hub['runFor'](leadAcc, 'haiku', 'turbo') as string
    check('an effort that is no level at all is refused, with the levels there are', typeof bad === 'string' && /low, medium, high/.test(bad), String(bad))

    const few = hub.createChat({ cwd: work })
    hub.setUltra(few.id, true)
    hub.send({ chatId: few.id, to: leadId, text: '/gocrazy design the landing page with only two agents' })
    await until('the follow-up and the regions', () => idle(few) && rows(few).some((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text)), 120_000)
    const nudges = rows(few).filter((i) => i.kind === 'notice' && /asked once to start the regions/.test(i.text))
    same('a Go crazy lead that starts 2 gets exactly one follow-up', nudges.length, 1)
    check('and then starts the regions', (few.agents || []).filter((a) => a.spawned?.depth === 1).length >= 3 && (few.agents || []).length >= CRAZY_FLOOR, String((few.agents || []).length))

    const thanks = hub.createChat({ cwd: work })
    hub.setUltra(thanks.id, true)
    hub.send({ chatId: thanks.id, to: leadId, text: '/gocrazy thanks' })
    await until('the thank-you', () => idle(thanks) && rows(thanks).some((i) => i.kind === 'assistant'), 30_000)
    check('a small follow-up in Go crazy gets no follow-up and starts nobody', !rows(thanks).some((i) => i.kind === 'notice' && /asked once/.test(i.text)) && !(thanks.agents || []).length)

    const stopped = hub.createChat({ cwd: work })
    hub.setUltra(stopped.id, true)
    hub.send({ chatId: stopped.id, to: leadId, text: '/gocrazy design the landing page with only two agents' })
    await hub.stop(stopped.id)
    await until('the stopped chat to settle', () => idle(stopped), 30_000)
    await pause(300)
    check('Stop prevents the follow-up', !rows(stopped).some((i) => i.kind === 'notice' && /asked once/.test(i.text)))

    const spawnTool = (hub['toolsFor'](hub['session'](stopped, leadAcc)) as { name: string; run: (a: Record<string, unknown>) => Promise<string> }[]).find((t) => t.name === 'spawn_agent')
    const refusedWhy = spawnTool ? await spawnTool.run({ name: 'Nope', role: 'tries a model nobody has', model: 'gpt-9-imaginary' }) : ''
    check("a refused spawn's reason is the tool's answer the lead reads", /cannot run "gpt-9-imaginary"/.test(refusedWhy) || /no .* account|cannot run/i.test(refusedWhy), refusedWhy)

    // A team of ChatGPT accounts only, with a ChatGPT lead.
    const gptDir = path.join(os.tmpdir(), 'ensemble-auto-gpt')
    fs.rmSync(gptDir, { recursive: true, force: true })
    const gpt = new Hub({
      dataDir: gptDir,
      version: 'test',
      demo: true,
      mica: false,
      isFocused: () => false,
      notify: () => {},
      emit: (ev) => {
        events.push(ev)
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].test()) waiters.splice(i, 1)[0].resolve()
      },
    })
    await gpt.start()
    // The demo's own ChatGPT sign-in, and three more on the same plan (signed in, the same models).
    const g1 = gpt.accounts.add({ name: 'G1', provider: 'chatgpt', configDir: null })
    await gpt.accounts.refresh()
    for (const n of ['G2', 'G3', 'G4']) {
      const g = gpt.accounts.add({ name: n, provider: 'chatgpt', configDir: `demo://${n.toLowerCase()}` })
      gpt.accounts['setStatus']({ ...gpt.accounts.statuses.get(g1.id)!, accountId: g.id })
      gpt.accounts.setUsage(g.id, { session: { utilization: 0.1, resetsAt: Date.now() + 3 * 3600e3 }, weekly: { utilization: 0.3, resetsAt: Date.now() + 80 * 3600e3 } })
    }
    const gLead = gpt.lead()!
    check('the ChatGPT-only team has a ChatGPT lead', gLead?.provider === 'chatgpt' && gpt.accounts.accounts.every((a) => a.provider === 'chatgpt'))
    const gRows = (c: Chat): Item[] => gpt.openChat(c.id).items[gLead.id] || []
    const gIdle = (c: Chat): boolean => {
      const st = gpt.openChat(c.id).states.find((x) => x.accountId === gLead.id)
      return !!st && st.phase === 'idle' && !st.queued
    }
    const gc = gpt.createChat({ cwd: work })
    gpt.setUltra(gc.id, true)
    const leadTools = (gpt['toolsFor'](gpt['session'](gc, gLead)) as { name: string }[]).map((t) => t.name)
    check('a ChatGPT lead holds spawn_agent and assign_task', leadTools.includes('spawn_agent') && leadTools.includes('assign_task'), leadTools.join(', '))
    // The tools really reach it over the tool server, the way the ChatGPT program asks for them.
    const url = gpt['toolServer'].register(`${gc.id}:${gLead.id}`, gpt['toolsFor'](gpt['session'](gc, gLead))) as string | undefined
    let listed: string[] = []
    if (url) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
      const body = await res.text()
      listed = [...body.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1])
    }
    check('the tool server lists spawn_agent and assign_task for the ChatGPT lead', listed.includes('spawn_agent') && listed.includes('assign_task'), listed.join(', ') || 'nothing listed')
    const luna = gpt['spawn'](gc, gLead, { name: 'Luna scout', role: 'scouts', model: 'luna', effort: 'medium' }) as string
    const astra = gpt['spawn'](gc, gLead, { name: 'Astra builder', role: 'builds', model: 'astra', effort: 'max' }) as string
    const sol = gpt['spawn'](gc, gLead, { name: 'Sol critic', role: 'critiques', model: 'sol' }) as string
    check('spawns named by ChatGPT model (luna, astra, sol) start on ChatGPT accounts', [luna, astra, sol].every((r) => /joined the chat/.test(r)) && (gc.agents || []).every((a) => a.provider === 'chatgpt'), [luna, astra, sol].join(' | '))
    const opus = gpt['spawn'](gc, gLead, { name: 'Opus', role: 'x', model: 'opus' }) as string
    check('a Claude model on a ChatGPT-only team is refused with why', /no Claude account/.test(opus), opus)
    await gpt.sweepIdle(gc, 0)
    const gFrom = Date.now()
    gpt.send({ chatId: gc.id, to: gLead.id, text: '/gocrazy design the landing page' })
    await until('the ChatGPT-only Go crazy run', () => gIdle(gc) && gRows(gc).some((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text)), 120_000)
    const live = (gc.agents || []).filter((a) => a.spawned && a.spawned.at >= gFrom)
    console.log(`  (ChatGPT-only go crazy: ${((Date.now() - gFrom) / 1000).toFixed(1)} s, ${live.length} agents)`)
    // The whole team works, not just the lead's account: the agents are spread over all four accounts.
    const perAccount = gpt.accounts.accounts.map((a) => live.filter((x) => x.spawned?.base === a.id).length)
    console.log(`  (agents per account, ${gpt.accounts.accounts.map((a) => a.name).join('/')}: ${perAccount.join('/')})`)
    check('ChatGPT only: the agents are spread over all four accounts', perAccount.every((n) => n >= Math.floor(live.length / 4) - 2) && Math.max(...perAccount) - Math.min(...perAccount) <= 3, perAccount.join('/'))
    // A lead that names its own account for every agent does not get to leave the rest of the team idle.
    const pile = gpt.createChat({ cwd: work })
    gpt.setUltra(pile.id, true)
    gpt['markUltra'](pile, 'gocrazy')
    const replies: string[] = []
    for (let i = 0; i < 12; i++) replies.push(gpt['spawn'](pile, gLead, { name: `Piled ${i + 1}`, role: 'one of twelve the lead asked to put on its own account', account: gLead.name, model: 'luna' }) as string)
    const piled = gpt.accounts.accounts.map((a) => (pile.agents || []).filter((x) => x.spawned?.base === a.id).length)
    check('agents all asked onto the lead\'s own account are still spread over the team', (pile.agents || []).length === 12 && Math.max(...piled) - Math.min(...piled) <= 2, piled.join('/'))
    check('and the lead is told why', replies.some((r) => /placed on another to keep the whole team working/.test(r)))
    check('ChatGPT only: the regions run, every agent on a ChatGPT account, down to depth 4', live.length >= 25 && live.every((a) => a.provider === 'chatgpt') && live.some((a) => a.spawned?.depth === 4) && live.filter((a) => a.spawned?.depth === 1).length >= 3, `${live.length} agents, deepest ${Math.max(...live.map((a) => a.spawned?.depth || 0))}`)
    const gtasks = gpt.tasksOf(gc.id).filter((t) => t.createdAt >= gFrom)
    check('ChatGPT only: scouts on Luna, builders on Astra', gtasks.filter((t) => t.title.startsWith('Scout')).every((t) => /luna/i.test(t.model || '')) && gtasks.filter((t) => t.title.startsWith('Build')).every((t) => /astra/i.test(t.model || '')), gtasks.map((t) => `${t.title}:${t.model}`).slice(0, 6).join(', '))
    check('ChatGPT only: no follow-up was needed', !gRows(gc).some((i) => i.kind === 'notice' && /asked once/.test(i.text)))
    const gfew = gpt.createChat({ cwd: work })
    gpt.setUltra(gfew.id, true)
    gpt.send({ chatId: gfew.id, to: gLead.id, text: '/gocrazy design the landing page with only two agents' })
    await until('the ChatGPT lead to be asked once and start the regions', () => gIdle(gfew) && gRows(gfew).some((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text)), 120_000)
    same('ChatGPT only: a lead that starts 2 gets exactly one follow-up', gRows(gfew).filter((i) => i.kind === 'notice' && /asked once/.test(i.text)).length, 1)
    await gpt.dispose()
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
