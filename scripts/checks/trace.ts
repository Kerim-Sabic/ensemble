import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Ctx } from './ctx'
import { TRACE_KEEP_FILES, Tracer } from '../../src/main/trace'
import { admitted, commandOf, evidenceLine, evidenceOf, evidenceShown, evidenceStamp, evidenceWanted, gapsIn, inputLine, pathsOf, redact, replySpan, runOf, runSummary, type TraceRecord } from '../../src/shared/trace'
import type { Chat, Item } from '../../src/shared/types'

// The execution trace and the evidence drawn from it.
export default async function (c: Ctx): Promise<void> {
  const { check, same } = c

  // ----- reading a step -----
  same('test, build, lint and type-check runs are told from the command', [runOf('pnpm test'), runOf('npx vitest run src/api'), runOf('pytest -q'), runOf('cargo test --all'), runOf('npm run build'), runOf('npx tsc --noEmit -p tsconfig.json'), runOf('pnpm lint'), runOf('git status'), runOf('cat vitest.config.ts'), runOf('ls && pnpm auto-test')], ['Tests', 'Tests', 'Tests', 'Tests', 'Build', 'Type check', 'Lint', null, null, 'Tests'])
  same('the line that says how a run went', [runSummary('RUN v2\n ✓ a\n Tests  14 passed (14)\n Duration 2s'), runSummary('...\nFound 3 errors in 2 files.'), runSummary('hello\nworld')], ['Tests  14 passed (14)', 'Found 3 errors in 2 files.', undefined])
  const secret = redact('curl -H "Authorization: Bearer abcdef0123456789abcdef" https://x.test?api_key=sk-live-AAAABBBBCCCCDDDDEEEE && export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 PASSWORD="hunter two" name=Ada')
  check('keys, tokens and passwords never reach the trace', !/abcdef0123456789abcdef|sk-live|ghp_abc|hunter two/.test(secret) && /name=Ada/.test(secret) && /\[hidden\]/.test(secret), secret)
  same('branch names and paths made of words stay readable', [redact('git switch -c fix/issue-142-annual-toggle-shows-monthly-prices-after'), redact('git push origin feature/utf8-decoding-breaks-on-windows-11-and-v2')], ['git switch -c fix/issue-142-annual-toggle-shows-monthly-prices-after', 'git push origin feature/utf8-decoding-breaks-on-windows-11-and-v2'])
  same('but keys split by separators are still hidden', [redact('token aB3dEf9GhIj2KlMnOp4QrStUvWx/Yz5aBcDeF7gHiJkLmN+oP8q'), redact('id 9f8a7b6c-5d4e3f2a-1b0c9d8e-7f6a5b4c-3d2e1f0a'), redact('ref a1b2c3d4e5-f6a7b8c9d0-e1f2a3b4c5-d6e7f8a9b0')], ['token [hidden]', 'id [hidden]', 'ref [hidden]'])
  check('a long key-shaped string is hidden, ordinary words are not', redact('key 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e and a perfectly ordinary sentence about internationalization') === 'key [hidden] and a perfectly ordinary sentence about internationalization')
  same('a step in one line', inputLine('Edit', { file_path: 'src/a.ts', old_string: 'x'.repeat(500), new_string: 'y' }), 'src/a.ts')
  same('commands and files of a step', [commandOf('Bash', { command: ' pnpm  test ' }), commandOf('Read', { command: 'x' }), pathsOf('Write', { file_path: 'a.ts' }), pathsOf('FileChange', { changes: [{ path: 'b.ts' }, { path: 'c.ts' }] }), pathsOf('Read', { file_path: 'a.ts' })], ['pnpm test', undefined, ['a.ts'], ['b.ts', 'c.ts'], []])
  same('what a reply admits it did not check', admitted('Done. **Checked:** tests pass. **Not checked:** how it looks on a phone. It should now work in Safari too.'), ['how it looks on a phone', 'It should now work in Safari too'])
  same('"Not checked: nothing" admits nothing', admitted('Checked: everything. Not checked: nothing.'), [])

  // ----- the four lists, from records made by hand -----
  const t0 = 1_000_000
  const rec: TraceRecord[] = [
    { t: 'turn-start', ts: t0, agent: 'lead', name: 'Main', depth: 0, kind: 'user', permission: 'auto', provider: 'claude', model: 'claude-opus-5-5' },
    { t: 'tool', ts: t0 + 10, agent: 'lead', id: 'a', name: 'Write', input: 'src/pay.ts', ok: true, paths: ['src/pay.ts'], hashes: ['aaaa'] },
    { t: 'tool', ts: t0 + 20, agent: 'lead', id: 'b', name: 'Bash', input: 'pnpm test', ok: false, command: 'pnpm test', run: { what: 'Tests', passed: false, summary: '2 failed' }, tail: '2 failed' },
    { t: 'tool', ts: t0 + 30, agent: 'bob', id: 'c', name: 'Edit', input: 'src/pay.ts', ok: true, paths: ['src\\pay.ts'], hashes: ['bbbb'] },
    { t: 'tool', ts: t0 + 40, agent: 'lead', id: 'd', name: 'Bash', input: 'pnpm test', ok: true, command: 'pnpm test', ms: 900, run: { what: 'Tests', passed: true, summary: '14 passed' } },
    { t: 'tool', ts: t0 + 50, agent: 'lead', id: 'e', name: 'Bash', input: 'curl https://api.test/health', ok: false, command: 'curl https://api.test/health', tail: 'could not resolve host' },
    { t: 'tool', ts: t0 + 55, agent: 'lead', id: 'f', name: 'WebFetch', input: 'https://docs.test', ok: false, tail: 'timed out' },
    { t: 'task', ts: t0 + 56, id: 't1', from: 'lead', to: 'bob', title: 'Review the checkout flow', status: 'failed' },
    { t: 'turn-end', ts: t0 + 60, agent: 'lead', item: 'e1', status: 'done', model: 'claude-opus-5-5', said: 'All in. Not checked: the webhook against the live provider.' },
    { t: 'tool', ts: t0 + 70, agent: 'lead', id: 'g', name: 'Write', input: 'later.ts', ok: true, paths: ['later.ts'] },
  ]
  const span = replySpan(rec, 'lead', 'e1')
  same('a reply covers the work since the message it answers', span, { from: t0, to: t0 + 60, own: false })
  const taskTurns: TraceRecord[] = [
    { t: 'turn-start', ts: 10, agent: 'bob', name: 'Bob', depth: 1, kind: 'task', task: 't1', permission: 'auto', provider: 'claude' },
    { t: 'turn-end', ts: 20, agent: 'bob', item: 'b1', status: 'done' },
    { t: 'turn-start', ts: 30, agent: 'bob', name: 'Bob', depth: 1, kind: 'task', task: 't2', permission: 'auto', provider: 'claude' },
    { t: 'turn-start', ts: 40, agent: 'bob', name: 'Bob', depth: 1, kind: 'team', permission: 'auto', provider: 'claude' },
    { t: 'turn-end', ts: 50, agent: 'bob', item: 'b2', status: 'done' },
  ]
  same('the reply of a teammate covers its task, with the reports that came in, and no earlier task', replySpan(taskTurns, 'bob', 'b2'), { from: 30, to: 50, own: true })
  const ev = evidenceOf(rec, t0, t0 + 60, (id) => (id === 'lead' ? 'Main' : 'Bob'))
  same('changed: one file, edited twice, by both, with its last hash', ev.changed, [{ path: 'src/pay.ts', edits: 2, by: ['Main', 'Bob'], hash: 'bbbb' }])
  same('ran: every command in order with how it ended', ev.ran.map((r) => `${r.command}:${r.ok}`), ['pnpm test:false', 'pnpm test:true', 'curl https://api.test/health:false'])
  same('passed: only the run that was seen to pass, with its own summary', ev.passed.map((p) => `${p.what} (${p.detail})`), ['Tests passed (14 passed)'])
  const unc = ev.uncertain.map((u) => u.what)
  check('uncertain: the failed command that was never put right', unc.some((u) => u.startsWith('A command failed: curl')), unc.join(' | '))
  check('uncertain: the failed step, the task that did not finish, and what the reply admits', unc.some((u) => u.startsWith('A step failed: WebFetch')) && unc.includes('"Review the checkout flow" did not finish (Bob)') && ev.uncertain.some((u) => u.what === 'The reply says' && /webhook/.test(u.detail || '')), unc.join(' | '))
  check('a test run that failed and then passed is not held against the result', !unc.some((u) => /Tests failed/.test(u)))
  same('what happened after the reply is not counted', ev.changed.some((x) => x.path === 'later.ts'), false)
  const stale = evidenceOf([...rec.slice(0, 5), { t: 'tool', ts: t0 + 45, agent: 'lead', id: 'h', name: 'Edit', input: 'src/pay.ts', ok: true, paths: ['src/pay.ts'] }], t0, t0 + 60)
  check('a change after the last passing run is called out', stale.uncertain.some((u) => u.what === 'Files changed after the last tests run'))
  const bare = evidenceOf(rec.slice(0, 2), t0, t0 + 15)
  check('changes with no run at all are called out', bare.uncertain.some((u) => u.what.startsWith('Files changed, and no test')))
  same('the one-line summary', evidenceLine(ev), '1 file changed · 3 commands ran · tests passed · 4 things unverified')
  same('nothing to show gives an empty line', evidenceLine(evidenceOf([], 0, 1)), '')
  const goal = evidenceOf([{ t: 'auto', ts: 5, agent: 'lead', of: 'goal', event: 'check', title: 'Check 1', text: 'No test run shown.' }, { t: 'auto', ts: 9, agent: 'lead', of: 'goal', event: 'met', title: 'Goal met', text: 'Tests pass.' }], 0, 10)
  check('a goal that is met clears the checker\'s earlier objection', goal.passed.some((p) => p.what === 'The goal was checked and is met') && !goal.uncertain.length, JSON.stringify(goal.uncertain))

  // ----- the writer: rotation, damage, and never failing a turn -----
  const dir = path.join(os.tmpdir(), 'ensemble-auto-trace')
  fs.rmSync(dir, { recursive: true, force: true })
  const fake = { dataDir: dir, chat: (): Chat => ({ id: 'c1', cwd: dir, permission: 'auto', sessions: {} }) as unknown as Chat, who: () => undefined, items: (): Item[] => [], tasks: () => [] }
  const small = new Tracer(fake, 2000)
  for (let i = 0; i < 40; i++) small.hubEvent({ type: 'item', chatId: 'c1', accountId: 'a', item: { id: `x${i}`, kind: 'tool', ts: 1000 + i, name: 'Bash', input: { command: `echo step ${i} token=abc123SECRETabc123` }, status: 'done', output: 'ok' } as Item })
  await small.flush()
  const sizes = [small.file('c1'), small.file('c1', true)].map((f) => (fs.existsSync(f) ? fs.statSync(f).size : -1))
  check('the trace file is started afresh at its limit, and the full one is kept', sizes[0] > 0 && sizes[0] <= 2000 && sizes[1] > 0 && sizes[1] <= 2000, sizes.join(','))
  const early = await small.read('c1')
  check(`a run that fills a few files keeps its start: all of it is read back, oldest first (up to ${TRACE_KEEP_FILES} kept files)`, early.length === 40 && (early[0] as { id: string }).id === 'x0' && early.every((r, i) => i === 0 || r.ts >= early[i - 1].ts), String(early.length))
  for (let i = 40; i < 240; i++) small.hubEvent({ type: 'item', chatId: 'c1', accountId: 'a', item: { id: `x${i}`, kind: 'tool', ts: 1000 + i, name: 'Bash', input: { command: `echo step ${i}` }, status: 'done' } as Item })
  await small.flush()
  const kept = Array.from({ length: TRACE_KEEP_FILES + 2 }, (_, n) => small.file('c1', n)).filter((f) => fs.existsSync(f))
  const back = await small.read('c1')
  check('past the kept files only the oldest goes: at most that many files, each within its limit, newest last', kept.length === TRACE_KEEP_FILES + 1 && kept.every((f) => fs.statSync(f).size <= 2000) && back.length > 40 && back.length < 240 && back.every((r, i) => i === 0 || r.ts >= back[i - 1].ts) && (back[back.length - 1] as { id: string }).id === 'x239', `${kept.length} files, ${back.length} records`)
  check('nothing secret-looking was written', !fs.readFileSync(small.file('c1'), 'utf8').includes('SECRET'))
  fs.appendFileSync(small.file('c1'), '{"t":"tool","ts":99999,"agent":"a","id":"cut')
  same('a line cut short by a crash is skipped, the rest is read', (await small.read('c1')).length, back.length)
  same('no write failed', small.failures, 0)
  {
    const two = new Tracer({ ...fake, dataDir: path.join(dir, 'two') }, 100_000)
    const t1 = (chatId: string) => ({ id: 't1', chatId, title: 'Write the copy', brief: '', from: 'a', to: 'b', status: 'running' as const, createdAt: 1 })
    two.hubEvent({ type: 'task', task: t1('c1') })
    two.hubEvent({ type: 'task', task: t1('c2') })
    const n = async (id: string): Promise<number> => (await two.read(id)).filter((r) => r.t === 'task').length
    same('task t1 of one chat does not hide task t1 of another (ids start again in every chat)', [await n('c1'), await n('c2')], [1, 1])
    two.hubEvent({ type: 'task', task: t1('c2') })
    same('and the same status again in the same chat is still written once', await n('c2'), 1)
  }
  small.breakWrites = true
  small.hubEvent({ type: 'item', chatId: 'c1', accountId: 'a', item: { id: 'y', kind: 'tool', ts: 1, name: 'Bash', input: { command: 'x' }, status: 'done' } as Item })
  small.hubEvent({ type: 'task', task: { id: 't', chatId: 'c1', title: 'T', brief: '', from: 'a', to: 'b', status: 'queued', createdAt: 1 } })
  await small.flush()
  check('a trace that cannot be written is counted, and throws nothing', small.failures === 2)

  // ----- the real hub with the scripted team -----
  const { hub, lead, leadId } = c
  const chat = hub.createChat({ cwd: c.work })
  hub.send({ chatId: chat.id, to: leadId, text: 'Add a pricing page with a checkout flow' })
  const allIdle = (): boolean => hub.openChat(chat.id).states.every((s) => s.phase === 'idle' && !s.queued) && !hub.tasksOf(chat.id).some((t) => t.status === 'running' || t.status === 'queued')
  await c.until('the team to finish the pricing page', () => c.rows(chat).filter((i) => i.kind === 'turn').length >= 1 && allIdle() && c.rows(chat).some((i) => i.kind === 'assistant' && /tests pass/i.test(i.text)), 90_000)
  hub.tracer.breakWrites = false
  const all = await hub.trace(chat.id)
  const starts = all.filter((r) => r.t === 'turn-start') as Extract<TraceRecord, { t: 'turn-start' }>[]
  const first = starts[0]
  check('the first turn: the lead, set off by the person, with provider and permission', !!first && first.agent === leadId && first.kind === 'user' && first.depth === 0 && first.provider === lead.provider && first.permission === chat.permission && first.name === lead.name, JSON.stringify(first))
  const started = starts.filter((r) => !!r.by)
  check('an agent started in the chat is recorded with who started it and how deep it is', started.length > 0 && started.some((r) => r.by === leadId && r.depth === 1) && starts.some((r) => !r.by && r.agent !== leadId), JSON.stringify(started.slice(0, 2)))
  const tasks = all.filter((r) => r.t === 'task') as Extract<TraceRecord, { t: 'task' }>[]
  const oneTask = tasks.find((t) => t.status === 'done')
  check('tasks: from, to and every change of status, in order', !!oneTask && tasks.filter((t) => t.id === oneTask.id).map((t) => t.status).join('>').endsWith('running>done') && oneTask.from === leadId, tasks.filter((t) => t.id === oneTask?.id).map((t) => t.status).join('>'))
  const tools = all.filter((r) => r.t === 'tool') as Extract<TraceRecord, { t: 'tool' }>[]
  check('steps: files written with their paths, and commands recognised as runs', tools.some((t) => t.name === 'Write' && t.paths?.length === 1 && t.ok) && tools.some((t) => !!t.command && t.run?.what === 'Tests' && t.run.passed), tools.map((t) => t.name).slice(0, 12).join(','))
  const ends = all.filter((r) => r.t === 'turn-end') as Extract<TraceRecord, { t: 'turn-end' }>[]
  const lastTurn = [...c.rows(chat)].reverse().find((i) => i.kind === 'turn')
  const leadEnd = ends.find((e) => e.item === lastTurn?.id)
  check('a turn ends with its row id, its model and the start of what was said', !!leadEnd && leadEnd.status === 'done' && !!leadEnd.model && /tests pass/i.test(leadEnd.said || ''), JSON.stringify(leadEnd))
  check('the file is where the app says, one record per line', fs.existsSync(hub.tracePath(chat.id)) && fs.readFileSync(hub.tracePath(chat.id), 'utf8').trim().split('\n').length === all.length)
  const e = await hub.evidence(chat.id, { kind: 'turn', accountId: leadId, itemId: lastTurn?.id || '' })
  check('evidence for the lead\'s final reply covers the whole team\'s work', e.changed.length >= 2 && e.ran.length >= 1 && e.passed.some((p) => p.what === 'Tests passed') && e.agents.length >= 3, `${evidenceLine(e)} | ${e.agents.join(',')}`)
  if (oneTask) {
    const te = await hub.evidence(chat.id, { kind: 'task', taskId: oneTask.id })
    const owner = hub.accounts.get(oneTask.to)?.name || ''
    check('evidence for one task is its owner\'s work only', te.agents.length >= 1 && te.agents.includes(owner) && te.changed.every((x) => x.by.every((b) => te.agents.includes(b))), `${owner} | ${te.agents.join(',')}`)
  }
  same('a reply that is not in the trace has no evidence', evidenceLine(await hub.evidence(chat.id, { kind: 'turn', accountId: leadId, itemId: 'nope' })), '')

  // A goal: every check is written down, and the met goal counts as passed.
  const g = hub.createChat({ cwd: c.work })
  hub.send({ chatId: g.id, to: leadId, text: 'Add a pricing page', goal: { doneWhen: 'the tests pass and the page was opened' } })
  await c.until('the goal to be met', () => g.goal?.status === 'met', 60_000)
  const gt = (await hub.trace(g.id)).filter((r) => r.t === 'auto') as Extract<TraceRecord, { t: 'auto' }>[]
  same('goal events are in the trace: set, a check that failed, met', gt.map((r) => r.event).filter((x) => x === 'set' || x === 'check' || x === 'met'), ['set', 'check', 'met'])
  const ge = await hub.evidence(g.id, { kind: 'goal' })
  check('the goal\'s evidence: checked and met, with the earlier objection cleared', ge.passed.some((p) => p.what === 'The goal was checked and is met') && !ge.uncertain.some((u) => u.what.startsWith('The checker said')), JSON.stringify(ge.uncertain))
  const gTurn = [...c.rows(g)].reverse().find((i) => i.kind === 'turn')
  const gReply = await hub.evidence(g.id, { kind: 'turn', accountId: leadId, itemId: gTurn?.id || '' })
  check('the last reply of a goal carries the check that judged it', gReply.passed.some((p) => p.what === 'The goal was checked and is met'), evidenceLine(gReply))
  // ----- acceptance fixes (t83): what the window shows, through the pure decisions it uses -----
  // Evidence.tsx decides with evidenceWanted, evidenceShown, evidenceStamp and evidenceLine from
  // src/shared/trace.ts; these checks run those same functions.
  const ended = (status: 'done' | 'interrupted' | 'error', steps?: number, durationMs = 1500) => ({ status, steps, durationMs })

  // 1. A goal met after an earlier "not there yet": the current state says met.
  const rounds: TraceRecord[] = [
    { t: 'turn-start', ts: 100, agent: 'lead', name: 'Main', depth: 0, kind: 'user', permission: 'auto', provider: 'claude' },
    { t: 'turn-end', ts: 200, agent: 'lead', item: 'r1', status: 'done' },
    { t: 'auto', ts: 210, agent: 'lead', of: 'goal', event: 'check', title: 'Check 1 of 12', text: 'The page was not opened.', round: 1 },
    { t: 'turn-start', ts: 220, agent: 'lead', name: 'Main', depth: 0, kind: 'auto', permission: 'auto', provider: 'claude' },
    { t: 'turn-end', ts: 300, agent: 'lead', item: 'r2', status: 'done' },
    { t: 'auto', ts: 310, agent: 'lead', of: 'goal', event: 'met', title: 'Goal met', text: 'Tests pass and the page opened.', round: 2 },
  ]
  const met = evidenceOf(rounds, 100, 310, undefined, undefined, { reply: 'r2' })
  check('goal met after "not yet": the current state is met, with no objection left standing', met.passed.some((p) => p.what === 'The goal was checked and is met') && !met.uncertain.some((u) => /checker said/i.test(u.what)) && !/unverified/.test(evidenceLine(met)), `${evidenceLine(met)} | ${JSON.stringify(met.uncertain)}`)
  same('the earlier "not yet" stays as an earlier round, the met one is current', met.reviewed.map((r) => `${r.what}:${r.ok}:${!!r.earlier}`), ['Round 1:false:true', 'Round 2:true:false'])
  // The window read this reply's evidence when the reply ended, before the check: it must read again.
  const before = evidenceStamp({ goal: { status: 'active', checking: true, log: [{}] }, tasks: [], records: 40 })
  const after = evidenceStamp({ goal: { status: 'met', checking: false, log: [{}, {}] }, tasks: [], records: 41 })
  check('the window reads the evidence again once the goal is checked', before !== after)
  check('and again when a task reports', evidenceStamp({ goal: null, tasks: [{ id: 't', status: 'running' }], records: 5 }) !== evidenceStamp({ goal: null, tasks: [{ id: 't', status: 'done' }], records: 5 }))
  {
    // The same with the real hub: an early read (as the window did when the reply ended) and a later one.
    const g2 = hub.createChat({ cwd: c.work })
    hub.send({ chatId: g2.id, to: leadId, text: 'Add a pricing page', goal: { doneWhen: 'the tests pass and the page was opened' } })
    await c.until('the second round to end', () => c.rows(g2).filter((i) => i.kind === 'turn').length >= 2, 60_000)
    const t2 = c.rows(g2).filter((i) => i.kind === 'turn')[1]
    const stamp = (): string => evidenceStamp({ goal: hub.chats.get(g2.id)?.goal, tasks: hub.tasksOf(g2.id), records: c.rows(g2).length })
    const early = stamp()
    await c.until('the goal to be met', () => g2.goal?.status === 'met', 60_000)
    const late = await hub.evidence(g2.id, { kind: 'turn', accountId: leadId, itemId: t2.id })
    check('real goal: what the window depends on changed between the reply and the check', early !== stamp(), `${early} -> ${stamp()}`)
    check('real goal: read again, the reply shows the goal met and the earlier objection only as an earlier round', late.passed.some((p) => p.what === 'The goal was checked and is met') && !late.uncertain.some((u) => /checker said/i.test(u.what)) && late.reviewed.some((r) => r.earlier && !r.ok) && late.reviewed.some((r) => !r.earlier && r.ok), `${evidenceLine(late)} | ${JSON.stringify(late.reviewed)}`)
  }

  // 2. A stopped run that changed one file shows its evidence, and says it was stopped.
  const stopped: TraceRecord[] = [
    { t: 'turn-start', ts: 10, agent: 'lead', name: 'Main', depth: 0, kind: 'user', permission: 'auto', provider: 'claude' },
    { t: 'tool', ts: 20, agent: 'lead', id: 'w', name: 'Write', input: 'src/a.ts', ok: true, paths: ['src/a.ts'] },
    { t: 'turn-end', ts: 30, agent: 'lead', item: 's1', status: 'interrupted' },
  ]
  const se = evidenceOf(stopped, 10, 30, undefined, undefined, { reply: 's1' })
  check('a stopped run is looked at even with no steps counted', evidenceWanted(ended('interrupted')), 'the old rule only looked at replies with steps or 4 s of work, and never at failed ones')
  check('a stopped run that changed a file shows the block, with "Stopped before finishing"', evidenceShown(ended('interrupted'), se) && se.changed.length === 1 && se.uncertain.some((u) => u.what === 'Stopped before finishing'), JSON.stringify(se.uncertain))
  {
    const st = hub.createChat({ cwd: c.work })
    hub.send({ chatId: st.id, to: leadId, text: 'Add a pricing page with a checkout flow' })
    await c.until('a file to be written', () => hub.tracer.failures >= 0 && c.rows(st).length > 0 && hasWrite(st.id), 60_000)
    await hub.stop(st.id)
    await c.until('everyone to stop', () => hub.openChat(st.id).states.every((x) => x.phase === 'idle' || x.phase === 'error'), 30_000)
    const turn = [...c.rows(st)].reverse().find((i) => i.kind === 'turn')
    const ev2 = turn ? await hub.evidence(st.id, { kind: 'turn', accountId: leadId, itemId: turn.id }) : null
    const end = turn && turn.kind === 'turn' ? ended(turn.status, turn.steps, turn.durationMs) : ended('done')
    check('real Stop: the stopped reply shows what changed before Stop, and that it was stopped', !!ev2 && evidenceWanted(end) && evidenceShown(end, ev2) && ev2.changed.length >= 1 && ev2.uncertain.some((u) => u.what === 'Stopped before finishing' || / was stopped before finishing/.test(u.what)) && !ev2.uncertain.some((u) => /^A step failed: (Write|Edit)/.test(u.what)), `${turn && turn.kind === 'turn' ? turn.status : '?'} | ${ev2 ? evidenceLine(ev2) : ''} | ${JSON.stringify(ev2?.uncertain)}`)
  }

  {
    // A teammate's step cut short by Stop is told with the stop, not as a failure; a task that never ran was called off.
    const team: TraceRecord[] = [
      { t: 'turn-start', ts: 10, agent: 'lead', name: 'Main', depth: 0, kind: 'user', permission: 'auto', provider: 'claude' },
      { t: 'turn-end', ts: 20, agent: 'lead', item: 'h1', status: 'done' },
      { t: 'task', ts: 21, id: 'b', from: 'lead', to: 'bob', title: 'Build the page', status: 'running' },
      { t: 'task', ts: 22, id: 'r', from: 'lead', to: 'bob', title: 'Review the page', status: 'queued' },
      { t: 'tool', ts: 25, agent: 'bob', id: 'w1', name: 'Write', input: 'src/a.ts', ok: true, paths: ['src/a.ts'] },
      { t: 'tool', ts: 26, agent: 'bob', id: 'w2', name: 'Write', input: 'src/b.ts', ok: false, paths: ['src/b.ts'] },
      { t: 'turn-end', ts: 30, agent: 'bob', item: 'bx', status: 'interrupted' },
      { t: 'task', ts: 31, id: 'b', from: 'lead', to: 'bob', title: 'Build the page', status: 'cancelled' },
      { t: 'task', ts: 31, id: 'r', from: 'lead', to: 'bob', title: 'Review the page', status: 'cancelled' },
    ]
    const te = evidenceOf(team, 10, 40, (id) => (id === 'bob' ? 'Bob' : 'Main'), undefined, { reply: 'h1' })
    same('after Stop: what was written stays, the cut step is told with the stop, the task that never ran was called off', [te.changed.map((x) => x.path), te.uncertain.map((u) => `${u.what}${u.detail ? ` [${u.detail}]` : ''}`)], [['src/a.ts'], ['Files changed, and no test, build or check was run [Nothing in the record shows the change working.]', '"Build the page" was stopped before finishing (Bob) [while: Write src/b.ts]', '"Review the page" was called off before it started (Bob)']])
  }

  // 3. A failed run: what it ran is shown with the error; one that did nothing shows no block.
  const failed: TraceRecord[] = [
    { t: 'turn-start', ts: 10, agent: 'lead', name: 'Main', depth: 0, kind: 'user', permission: 'auto', provider: 'claude' },
    { t: 'tool', ts: 20, agent: 'lead', id: 'b', name: 'Bash', input: 'pnpm install', ok: true, command: 'pnpm install' },
    { t: 'turn-end', ts: 30, agent: 'lead', item: 'f1', status: 'error', error: 'Usage limit reached.' },
  ]
  const fe = evidenceOf(failed, 10, 30, undefined, undefined, { reply: 'f1' })
  check('a failed run that ran something shows the block, with the error', evidenceWanted(ended('error')) && evidenceShown(ended('error'), fe) && fe.uncertain.some((u) => u.what === 'Ended with an error: Usage limit reached.'), JSON.stringify(fe.uncertain))
  const idleFail = evidenceOf([failed[0], failed[2]], 10, 30, undefined, undefined, { reply: 'f1' })
  same('a failed run that did nothing shows no block', evidenceShown(ended('error'), idleFail), false)
  {
    // The error text reaches the trace from the row the person saw.
    const rows: Item[] = [
      { id: 'n', kind: 'notice', ts: 1, level: 'error', text: 'Main has used up its allowance.' } as Item,
      { id: 'tt', kind: 'turn', ts: 2, status: 'error', durationMs: 900 } as Item,
    ]
    const tr = new Tracer({ ...fake, dataDir: path.join(dir, 'err'), items: () => rows }, 100_000)
    tr.hubEvent({ type: 'item', chatId: 'c1', accountId: 'a', item: rows[1] })
    await tr.flush()
    const end = (await tr.read('c1')).find((r) => r.t === 'turn-end') as Extract<TraceRecord, { t: 'turn-end' }> | undefined
    same('a failed turn is written down with the error the person saw', end?.error, 'Main has used up its allowance.')
  }

  // 4. A Verified run whose reviewer names a gap: the review is its own line, the gap is uncertain.
  const report = 'Reviewed, and I found nothing that should block it.\n\n- `src/api/checkout.ts:18` the webhook checks the event type before it activates a plan\n- One gap: no test covers a webhook that arrives twice. It is harmless today, but worth a test\n\nChecked with `npx vitest run src/api --coverage`: 14 tests pass.'
  same('the gaps a review names', gapsIn(report), ['no test covers a webhook that arrives twice'])
  same('a review with nothing open names no gap', gapsIn('Reviewed it end to end. No problems found, and nothing blocks it.'), [])
  const verified: TraceRecord[] = [
    { t: 'turn-start', ts: 10, agent: 'lead', name: 'Main', depth: 0, kind: 'user', permission: 'auto', provider: 'claude' },
    { t: 'tool', ts: 20, agent: 'lead', id: 'r', name: 'Bash', input: 'npx vitest run', ok: true, command: 'npx vitest run', run: { what: 'Tests', passed: true, summary: '14 passed' } },
    { t: 'task', ts: 30, id: 'rv', from: 'lead', to: 'hello', title: 'Review the checkout flow', status: 'done', result: report },
    { t: 'turn-end', ts: 40, agent: 'lead', item: 'v1', status: 'done' },
  ]
  const ve = evidenceOf(verified, 10, 40, (id) => (id === 'hello' ? 'Hello' : 'Main'), undefined, { reply: 'v1' })
  check('a reviewer is its own line: who, what they concluded', ve.reviewed.length === 1 && ve.reviewed[0].by === 'Hello' && ve.reviewed[0].verdict === 'Reviewed, and I found nothing that should block it.' && !ve.reviewed[0].ok, JSON.stringify(ve.reviewed))
  check('the gap the reviewer named is under what remains uncertain, and the line says who reviewed', ve.uncertain.some((u) => u.what === "Hello's review named a gap" && /arrives twice/.test(u.detail || '')) && /reviewed by Hello/.test(evidenceLine(ve)), `${evidenceLine(ve)} | ${JSON.stringify(ve.uncertain)}`)
  {
    // The real team run above has a reviewer that names that gap.
    const rv = e.reviewed.find((r) => /review/i.test(r.what))
    check('real Verified run: the reviewer, its conclusion, and its gap reach the lead reply\'s evidence', !!rv && e.uncertain.some((u) => /review named a gap/.test(u.what) && /twice/.test(u.detail || '')), `${JSON.stringify(e.reviewed)} | ${JSON.stringify(e.uncertain)}`)
  }

  // 5. A reply that changed nothing and ran nothing shows no block, finished or stopped.
  const nothing: TraceRecord[] = [stopped[0], { t: 'turn-end', ts: 30, agent: 'lead', item: 'z', status: 'done' }]
  same('a finished reply that did nothing shows no block', evidenceShown(ended('done', 2), evidenceOf(nothing, 10, 30, undefined, undefined, { reply: 'z' })), false)
  same('a stopped reply that did nothing shows no block', evidenceShown(ended('interrupted'), evidenceOf([stopped[0], stopped[2]], 10, 30, undefined, undefined, { reply: 's1' })), false)

  // 6. A started agent whose account ran out moves before its turn runs: the turn is recorded on the account it really ran on.
  {
    const mv = hub.createChat({ cwd: c.work })
    const gpt = hub.accounts.accounts.find((a) => a.provider === 'chatgpt' && a.enabled)
    if (gpt) {
      hub['spawn'](mv, lead, { name: 'Mover', role: 'shows where a moved agent is recorded', model: 'luna' })
      const agent = (mv.agents || []).find((a) => a.name === 'Mover')
      const before = hub.accounts.usage.get(gpt.id)
      hub.accounts.setUsage(gpt.id, { session: { utilization: 1, resetsAt: Date.now() + 3600e3, status: 'rejected' } })
      try {
        if (agent) {
          hub['onTurnStart'](hub['session'](mv, agent), { kind: 'task', text: 'x', itemIds: [], origin: { kind: 'human' } })
          await hub.tracer.flush(mv.id)
          const rec = (await hub.trace(mv.id)).filter((r) => r.t === 'turn-start' && r.agent === agent.id).pop() as Extract<TraceRecord, { t: 'turn-start' }> | undefined
          check("a moved agent's turn is recorded on the account it moved to, not the one that ran out", agent.provider === 'claude' && rec?.provider === 'claude', `${agent.provider} / ${rec?.provider}`)
        } else check("a moved agent's turn is recorded on the account it moved to", false, 'the agent was not started')
      } finally {
        hub.accounts.setUsage(gpt.id, { session: before?.session?.status === 'rejected' ? { utilization: 0.1, resetsAt: Date.now() + 3600e3 } : before?.session || { utilization: 0.1, resetsAt: Date.now() + 3600e3 } })
        ;(hub['running'] as Map<string, Set<string>>).delete(mv.id)
      }
    } else check("a moved agent's turn is recorded on the account it moved to", false, 'the demo team has no ChatGPT account')
  }

  same('tracing never failed during these runs', hub.tracer.failures, 0)

  async function hasWriteNow(chatId: string): Promise<boolean> {
    return (await hub.trace(chatId)).some((r) => r.t === 'tool' && !!r.paths?.length && r.ok)
  }
  // c.until polls synchronously: keep the last answer of an asynchronous look at the trace.
  function hasWrite(chatId: string): boolean {
    void hasWriteNow(chatId).then((v) => (seenWrite[chatId] = v))
    return !!seenWrite[chatId]
  }
}
const seenWrite: Record<string, boolean> = {}
