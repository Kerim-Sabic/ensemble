// Watches and the inbox. Two layers: the engine on its own with a fake clock, a fake gate and a
// counted model (so time, sleep, caps and model calls can be checked exactly), then the real hub
// in demo mode with the scripted team (a watch that finds nothing, one that finds something, one
// that fails, a finding handed to the team, approvals and blocked goals in the inbox, a restart).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Ctx } from './ctx'
import type { Hub } from '../../src/main/hub'
import type { GhList } from '../../src/shared/github'
import type { HubEvent } from '../../src/shared/types'
import { WATCH_CONTEXT, WATCH_SYSTEM, inHours, nextDue, readAnswer, steadyText, triggerLine, watchPrompt, type InboxItem, type UnattendedGate, type Watch, type Zone } from '../../src/shared/watches'
import { Watches, fallbackGate, type WatchHost } from '../../src/main/watches'
import { saveIo } from '../../src/main/util'
import { fingerprint } from '../../src/shared/watches'
import { parseCommand } from '../../src/shared/auto'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const UTC: Zone = { offset: () => 0 }
/** Central Europe in 2026: summer time from 29 March 01:00 UTC to 25 October 01:00 UTC. */
const CET: Zone = { offset: (ms) => (ms >= Date.UTC(2026, 2, 29, 1) && ms < Date.UTC(2026, 9, 25, 1) ? 120 : 60) }

interface Rig {
  e: Watches
  clock: { t: number }
  calls: string[]
  notes: { title: string; body: string }[]
  handed: string[]
  page: { text: string }
  gh: { runs: number[] }
  gate: { allow: boolean; used: number }
  busy: { on: boolean }
  answer: { text: string; slow?: number; fail?: boolean }
  dir: string
  host: WatchHost
}

function rig(name: string, o: { zone?: Zone; dir?: string; start?: number } = {}): Rig {
  const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), `ens-watch-${name}-`))
  const clock = { t: o.start ?? Date.UTC(2026, 10, 20, 9, 0) }
  const calls: string[] = []
  const notes: { title: string; body: string }[] = []
  const handed: string[] = []
  const page = { text: '<p>All systems normal</p><p>Updated at 07:00</p>' }
  const gh = { runs: [101, 102] }
  const gate = { allow: true, used: 0 }
  const busy = { on: false }
  const answer: Rig['answer'] = { text: 'QUIET' }
  const g: UnattendedGate = {
    pick: () => (gate.allow ? { accountId: 'acc-1' } : { accountId: null, why: "Today's unattended looks are used up." }),
    record: () => void gate.used++,
    today: () => ({ runs: gate.used, byAccount: {}, caps: { runsPerDay: 60, runsPerAccount: 30, keepFree: 30 } }),
  }
  const host: WatchHost = {
    dataDir: dir,
    demo: true,
    now: () => clock.t,
    zone: o.zone || UTC,
    emit: () => {},
    notify: (title, body) => void notes.push({ title, body }),
    gate: () => g,
    ask: async (_id, _sys, prompt) => {
      calls.push(prompt)
      if (answer.slow) await new Promise((r) => setTimeout(r, answer.slow))
      if (answer.fail) throw new Error('The model did not answer.')
      return { text: answer.text, model: 'fake light model' }
    },
    busy: () => busy.on,
    handTo: async (w, title) => {
      handed.push(title)
      return `chat-for-${w.id}`
    },
    github: {
      list: async (): Promise<GhList> => ({ repo: { owner: 'acme', repo: 'site', url: '' }, via: 'demo', issues: [], pulls: [], runs: gh.runs.map((id) => ({ id, workflow: 'CI', title: `Run ${id}`, branch: 'main', event: 'push', conclusion: 'failure', createdAt: '', url: `https://github.com/acme/site/actions/runs/${id}` })) }),
    },
    fetchText: async (url) => {
      if (/fail/.test(url)) throw new Error('The page could not be reached.')
      return page.text
    },
    runCommand: async () => 'ok',
  }
  const e = new Watches(host, false)
  e.start()
  return { e, clock, calls, notes, handed, page, gh, gate, busy, answer, dir, host }
}

// Measure only parsing time inside a worker. The parent also has a deadline so a
// regression cannot freeze the test runner for minutes on malformed markup.
async function parseTime(input: string): Promise<number> {
  const worker = new Worker(`const {parentPort, workerData} = require('node:worker_threads');
    const parse = (${steadyText.toString()}); const start = performance.now();
    parse(workerData); parentPort.postMessage(performance.now() - start);`, { eval: true, workerData: input })
  return new Promise(resolve => {
    const timer = setTimeout(() => { void worker.terminate(); resolve(Infinity) }, 2500)
    worker.once('message', ms => { clearTimeout(timer); void worker.terminate(); resolve(ms) })
    worker.once('error', () => { clearTimeout(timer); resolve(Infinity) })
  })
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const outcomes = (w: Watch | undefined): string[] => (w?.runs || []).map((r) => r.outcome)

export default async function (c: Ctx): Promise<void> {
  // ── the clock: schedules, daylight saving, hours ──
  const fri8 = Date.UTC(2026, 10, 20, 8, 0) // a Friday, 08:00 UTC
  c.same('watches: 07:00 on weekdays, asked on a Friday after seven, is Monday 07:00', new Date(nextDue({ kind: 'schedule', at: '07:00', days: [1, 2, 3, 4, 5] }, fri8, fri8, UTC)).toISOString(), '2026-11-23T07:00:00.000Z')
  c.same('watches: 07:00 every day, asked before seven, is today', new Date(nextDue({ kind: 'schedule', at: '07:00' }, Date.UTC(2026, 10, 20, 6, 59), 0, UTC)).toISOString(), '2026-11-20T07:00:00.000Z')
  c.same('watches: 07:00 local the day summer time starts is 05:00 UTC (the evening before, 06:00 UTC)', [nextDue({ kind: 'schedule', at: '07:00' }, Date.UTC(2026, 2, 28, 7, 0), 0, CET), nextDue({ kind: 'schedule', at: '07:00' }, Date.UTC(2026, 2, 27, 7, 0), 0, CET)].map((t) => new Date(t).toISOString()), ['2026-03-29T05:00:00.000Z', '2026-03-28T06:00:00.000Z'])
  c.same('watches: 02:30 on the night the clock jumps is moved forward, not lost', new Date(nextDue({ kind: 'schedule', at: '02:30' }, Date.UTC(2026, 2, 28, 12, 0), 0, CET)).toISOString(), '2026-03-29T01:30:00.000Z')
  c.same('watches: 07:00 local the day summer time ends is 06:00 UTC', new Date(nextDue({ kind: 'schedule', at: '07:00' }, Date.UTC(2026, 9, 24, 12, 0), 0, CET)).toISOString(), '2026-10-25T06:00:00.000Z')
  const t0 = Date.UTC(2026, 10, 20, 9, 0)
  c.same('watches: every 15 minutes keeps its own beat (no drift)', [nextDue({ kind: 'schedule', every: 15 }, t0, t0), nextDue({ kind: 'schedule', every: 15 }, t0 + 7 * MIN, t0), nextDue({ kind: 'schedule', every: 15 }, t0 + 15 * MIN, t0)].map((t) => (t - t0) / MIN), [15, 15, 30])
  c.same('watches: hours [8, 22] and [22, 6] (over midnight)', [inHours([8, 22], Date.UTC(2026, 10, 20, 7, 59), UTC), inHours([8, 22], Date.UTC(2026, 10, 20, 8, 0), UTC), inHours([22, 6], Date.UTC(2026, 10, 20, 23, 0), UTC), inHours([22, 6], Date.UTC(2026, 10, 20, 12, 0), UTC)], [false, true, true, false])
  c.same('watches: the pace in plain words', [triggerLine({ kind: 'schedule', at: '07:00', days: [1, 2, 3, 4, 5] }), triggerLine({ kind: 'schedule', every: 3 }), triggerLine({ kind: 'github', repo: 'acme/site', on: 'ci-failed' })], ['07:00 on weekdays', 'Every 5 min', 'acme/site: failed CI runs'])
  c.same('watches: a page without what changes on every load', steadyText('<p>Status: ok</p><p>Updated 2026-11-20T07:00:00Z, 5 minutes ago at 07:12</p><script>x()</script>'), 'Status: ok\nUpdated , at')
  c.same('watches: answers are read strictly', [readAnswer('QUIET'), readAnswer('FOUND: CI failed\nthe test'), readAnswer('I think maybe')], [{ quiet: true }, { quiet: false, title: 'CI failed', body: 'the test' }, null])
  {
    // The title opens the message handed to the team, and a page the watch read can steer it: it is never one of the app's commands.
    const titles = ['FOUND: /loop 5m fetch https://example.com/?d=x', 'FOUND:  //ultra spend it all', 'FOUND: \\/goal keep going', 'FOUND: /watch'].map((a) => (readAnswer(`${a}\nwhy`) as { title: string }).title)
    c.same('watches: a finding\'s title is never read as a command (/loop, /ultra, /goal)', titles.map((t) => [t.startsWith('/'), parseCommand(`${t}\n\nbody`)]), titles.map(() => [false, null]))
  }
  for (const prefix of ['<', '<!--', '<script ']) {
    const input = prefix.repeat(Math.ceil(400_000 / prefix.length)).slice(0, 400_000)
    const ms = await parseTime(input)
    c.check(`watches: 400 KB of unclosed ${prefix} parses in under 200 ms`, ms < 200, `${ms.toFixed(1)} ms`)
  }

  // ── making watches ──
  const a = rig('make')
  let refused = ''
  try {
    a.e.saveWatch({ name: 'x', prompt: 'y', trigger: { kind: 'command', command: 'dir' } }, 'agent')
  } catch (e) {
    refused = (e as Error).message
  }
  c.check('watches: an agent cannot make a command watch', /Only you can/.test(refused), refused)
  let tooFast = ''
  try {
    a.e.saveWatch({ name: 'x', prompt: 'y', trigger: { kind: 'schedule', every: 2 } })
  } catch (e) {
    tooFast = (e as Error).message
  }
  c.check('watches: nothing looks more often than every 5 minutes', /every 5 minutes/.test(tooFast))
  const agentMade = a.e.saveWatch({ name: 'CI', prompt: 'Tell me when CI fails', trigger: { kind: 'github', repo: 'https://github.com/acme/site', on: 'ci-failed' }, onFind: 'team' }, 'agent', { chatId: 'c1', accountId: 'acc' })
  const confirm = a.e.inbox().find((i) => i.confirmWatch === agentMade.id)
  c.check('watches: a watch an agent makes waits, paused, for the user in the inbox', agentMade.status === 'paused' && agentMade.nextAt === null && confirm?.kind === 'needs-you' && !confirm.done)
  c.check('watches: agent watch confirmation discloses team chats', confirm?.body.includes('it may start a team chat'))
  a.clock.t += DAY
  await a.e.tick()
  c.same('watches: a watch waiting for the user does not run', [a.calls.length, a.e.get(agentMade.id)?.runs.length], [0, 0])
  a.e.saveWatch({ ...a.e.get(agentMade.id)!, status: 'active' }, 'agent')
  c.same('watches: an agent cannot turn it on itself', a.e.get(agentMade.id)?.status, 'paused')
  a.e.saveWatch({ ...a.e.get(agentMade.id)!, status: 'active' }, 'user')
  c.check('watches: the user turns it on, and the inbox item is done', a.e.get(agentMade.id)?.status === 'active' && !!a.e.inbox().find((i) => i.confirmWatch === agentMade.id)?.done)
  a.e.dispose()

  // ── compare first: no model when nothing changed, exactly one when it did ──
  const b = rig('compare')
  const page = b.e.saveWatch({ name: 'Status page', prompt: 'Tell me if it says anything is down', trigger: { kind: 'url', url: 'https://status.example.com' } })
  await b.e.runNow(page.id)
  c.same('watches: the first look shows the model what is there (one call)', b.calls.length, 1)
  for (let i = 0; i < 5; i++) {
    b.clock.t += 15 * MIN
    await b.e.tick()
  }
  c.same('watches: five looks at an unchanged page make no model call', [b.calls.length, outcomes(b.e.get(page.id)).slice(0, 5)], [1, ['quiet', 'quiet', 'quiet', 'quiet', 'quiet']])
  c.check('watches: a quiet look is recorded with no model and no tokens', b.e.get(page.id)!.runs.slice(0, 5).every((r) => !r.model && !r.tokens))
  b.page.text = '<p>All systems normal</p><p>Updated at 08:15</p>'
  b.clock.t += 15 * MIN
  await b.e.tick()
  c.same('watches: only a time changed on the page: still no call', b.calls.length, 1)
  b.page.text = '<p>All systems normal</p><p>Updated at 08:35</p><p>Checkout is down in Europe</p>'
  b.answer.text = 'FOUND: Checkout is down in Europe\nThe status page says so.'
  b.clock.t += 15 * MIN
  await b.e.tick()
  c.check('watches: a change makes exactly one model call, shown only the new line', b.calls.length === 2 && /Checkout is down in Europe/.test(b.calls[1]) && !/All systems normal/.test(b.calls[1].split('What changed since the last look:')[1] || ''))
  c.same('watches: the finding is in the inbox once', b.e.inbox().filter((i) => i.kind === 'found').map((i) => i.title), ['Checkout is down in Europe'])
  b.e.flushNotes()
  c.check('watches: and the user is told', b.notes.some((n) => /Checkout is down/.test(n.title)))
  // The same finding again (the page flips back and forth): not repeated while the first is not done.
  b.page.text = '<p>All systems normal</p><p>Updated at 09:00</p>'
  b.clock.t += 15 * MIN
  await b.e.tick()
  b.page.text = '<p>All systems normal</p><p>Updated at 09:20</p><p>Checkout is down in Europe</p><p>Still</p>'
  b.clock.t += 15 * MIN
  await b.e.tick()
  c.same('watches: a finding already in the inbox is not added again', b.e.inbox().filter((i) => i.kind === 'found').length, 1)
  // The context stays small however many runs came before.
  b.answer.text = 'QUIET'
  const sizes: number[] = []
  for (let i = 0; i < 50; i++) {
    b.page.text = `<p>All systems normal</p><p>Updated at 10:00</p><p>Visitor note ${i}: ${'x'.repeat(200)}</p>`
    b.clock.t += 15 * MIN
    await b.e.tick()
    sizes.push(b.e.lastContext)
  }
  const bound = WATCH_SYSTEM.length + WATCH_CONTEXT.prompt + WATCH_CONTEXT.changed + WATCH_CONTEXT.findings * (WATCH_CONTEXT.finding + 4) + 400
  c.check('watches: after 50 more runs the model context is the same small size', Math.max(...sizes) <= bound && sizes[49] <= sizes[1] + 50, `first ${sizes[0]}, last ${sizes[49]}, max ${Math.max(...sizes)}, bound ${bound}`)
  c.same('watches: at most 30 runs are kept', b.e.get(page.id)!.runs.length, 30)
  b.e.dispose()

  // ── never twice at once, never twice for the same due time ──
  const d = rig('double')
  const w1 = d.e.saveWatch({ name: 'Brief', prompt: 'A morning brief', trigger: { kind: 'schedule', every: 30 } })
  d.answer.slow = 50
  d.clock.t += 31 * MIN
  await Promise.all([d.e.tick(), d.e.tick(), d.e.tick()])
  c.same('watches: three timers at once give one run and one call', [d.calls.length, d.e.get(w1.id)!.runs.length], [1, 1])
  await d.e.tick()
  c.same('watches: the same due time is not run again', d.calls.length, 1)
  // Three days asleep: the missed looks are recorded, and one run is made, not a burst.
  d.answer.slow = 0
  d.clock.t += 3 * DAY
  await d.e.tick()
  const after = d.e.get(w1.id)!
  c.check('watches: after 3 days asleep, one run and the missed looks on record', d.calls.length === 2 && after.runs.filter((r) => r.outcome === 'missed').length >= 10 && after.runs.filter((r) => r.outcome !== 'missed').length === 2, `${d.calls.length} calls, ${outcomes(after).join(',')}`)
  c.check('watches: the record says how many were missed in all', after.runs.some((r) => r.outcome === 'missed' && /looks in all were missed/.test(r.note || '')))
  c.check('watches: the next look is in the future, on its beat', (after.nextAt || 0) > d.clock.t && (after.nextAt || 0) - d.clock.t <= 30 * MIN)
  // Changed while a run is under way: the old run's result is thrown away.
  d.answer.slow = 30
  d.answer.text = 'FOUND: Old news\nfrom the old version'
  const beforeEdit = d.gate.used
  const racing = d.e.runNow(w1.id)
  await new Promise((r) => setTimeout(r, 5))
  d.e.saveWatch({ ...d.e.get(w1.id)!, prompt: 'Changed: only tell me about deploys' })
  await racing
  c.check('watches: an edited run discards its finding but counts its model call', !d.e.inbox().some((i) => i.title === 'Old news') && d.gate.used === beforeEdit + 1)
  const beforeDelete = d.gate.used
  const deleting = d.e.runNow(w1.id)
  await new Promise(r => setTimeout(r, 5))
  d.e.remove(w1.id)
  await deleting
  c.same('watches: a deleted run still counts its model call', d.gate.used, beforeDelete + 1)
  d.e.dispose()

  // ── limits: hours, the user's own work, the caps ──
  const l = rig('limits')
  const night = l.e.saveWatch({ name: 'Daytime only', prompt: 'brief', trigger: { kind: 'schedule', every: 60 }, hours: [8, 22] })
  l.clock.t = Date.UTC(2026, 10, 20, 23, 30)
  await l.e.tick()
  c.check('watches: outside its hours it is skipped, with no call', l.calls.length === 0 && outcomes(l.e.get(night.id))[0] === 'skipped')
  l.e.remove(night.id)
  l.clock.t = Date.UTC(2026, 10, 21, 12, 0)
  const work = l.e.saveWatch({ name: 'Every 10', prompt: 'brief', trigger: { kind: 'schedule', every: 10 } })
  l.busy.on = true
  l.clock.t += 11 * MIN
  await l.e.tick()
  c.check('watches: while the user\'s own work runs, it waits and says so', l.calls.length === 0 && /Your own work/.test(l.e.get(work.id)!.runs[0].note || ''))
  l.busy.on = false
  l.gate.allow = false
  for (let i = 0; i < 3; i++) {
    l.clock.t += 11 * MIN
    await l.e.tick()
  }
  c.check('watches: when the caps say no, the run is capped with no call', l.calls.length === 0 && outcomes(l.e.get(work.id)).slice(0, 3).every((o) => o === 'capped'))
  c.same('watches: and the inbox says so once a day, not every run', l.e.inbox().filter((i) => i.ref?.startsWith('capped:')).length, 1)
  l.e.dispose()

  // ── never silent failure ──
  const f = rig('fail')
  const broken = f.e.saveWatch({ name: 'Broken page', prompt: 'changes', trigger: { kind: 'url', url: 'https://example.com/fail' } })
  for (let i = 0; i < 3; i++) {
    f.clock.t += 16 * MIN
    await f.e.tick()
  }
  const bw = f.e.get(broken.id)!
  c.check('watches: three failures in a row pause the watch', bw.status === 'paused' && bw.failures === 3 && bw.nextAt === null && outcomes(bw).slice(0, 3).every((o) => o === 'failed'))
  c.check('watches: and put a failed item with the reason in the inbox', f.e.inbox().some((i) => i.kind === 'failed' && i.watchId === broken.id && /could not be reached/.test(i.body)))
  f.clock.t += DAY
  await f.e.tick()
  c.same('watches: a paused watch stays quiet', bw.runs.length, 3)
  f.e.dispose()

  // ── a finding handed to the team; GitHub as a source ──
  const h = rig('team')
  const ci = h.e.saveWatch({ name: 'CI', prompt: 'Tell me when CI fails', trigger: { kind: 'github', repo: 'acme/site', on: 'ci-failed' }, onFind: 'team' })
  h.answer.text = 'FOUND: CI failed on main\nRun 101 and 102.'
  await h.e.runNow(ci.id)
  const handedItem = h.e.inbox().find((i) => i.kind === 'found')
  c.check('watches: with onFind team, the finding starts a chat and the inbox links it', h.handed.length === 1 && handedItem?.chatId === `chat-for-${ci.id}` && h.e.get(ci.id)!.runs[0].outcome === 'handed')
  h.answer.text = 'FOUND: CI failed again\nRun 103.'
  await h.e.runNow(ci.id)
  c.same('watches: the same failed runs again: no change, no call', h.calls.length, 1)
  h.gh.runs = [101, 102, 103]
  await h.e.runNow(ci.id)
  c.check('watches: only the new failed run is shown to the model', h.calls.length === 2 && /Run 103/.test(h.calls[1]) && !/Run 101/.test(h.calls[1].split('What changed since the last look:')[1].split('Already told')[0]))
  c.check('watches: the last findings ride along so nothing is told twice', /Already told the user recently/.test(h.calls[1]) && /CI failed on main/.test(h.calls[1]))
  // Start an actual model call, then shut down while it is suspended. The persisted
  // claim must be restored and the late response must not overwrite the new engine.
  const live = h.e.get(ci.id)!
  h.gh.runs.push(104)
  const entered = deferred<void>()
  const reply = deferred<{ text: string }>()
  h.host.ask = async () => { entered.resolve(); return reply.promise }
  const interrupted = h.e.runNow(ci.id)
  await entered.promise
  c.same('watches: restart interrupts a real in-flight model call', h.e.get(ci.id)?.nextAt, null)
  h.e.dispose()
  const again = rig('team-again', { dir: h.dir, start: h.clock.t })
  c.check('watches: after a restart the watches and the inbox are there', again.e.get(ci.id)?.runs.length === live.runs.length && again.e.inbox().length === h.e.inbox().length)
  c.check('watches: a run cut short by the restart is due again at once', (again.e.get(ci.id)?.nextAt || Infinity) <= again.clock.t)
  reply.resolve({ text: 'FOUND: Late response\nMust be discarded.' })
  await interrupted
  // The restarted app sees the same repository: run 104 is still there and still untold.
  again.gh.runs = [...h.gh.runs]
  await again.e.tick()
  c.same('watches: the interrupted run actually resumes after restart', again.calls.length, 1)
  c.check('watches: the old engine cannot publish after disposal', !h.e.inbox().some(i => i.title === 'Late response'))
  again.e.dispose()

  const accounting = rig('handoff-gate')
  const autoTeam = accounting.e.saveWatch({ name: 'Team', prompt: 'Report changes', trigger: { kind: 'schedule', every: 15 }, onFind: 'team' })
  accounting.host.ask = async () => {
    accounting.gate.allow = false
    return { text: 'FOUND: Changed\nCheck the result.' }
  }
  await accounting.e.runNow(autoTeam.id)
  c.same('watches: the team handoff is gated again after the look spends the last allowance', [accounting.gate.used, accounting.handed.length], [1, 0])
  accounting.e.dispose()

  const cap = rig('handoff-cap')
  const cappedTeam = cap.e.saveWatch({ name: 'Team cap', prompt: 'Report changes', trigger: { kind: 'schedule', every: 15 }, onFind: 'team' })
  const accounts: string[] = []
  cap.host.handTo = async (_w, title, _body, accountId) => { cap.handed.push(title); accounts.push(accountId); return 'chat-' + cap.handed.length }
  for (let i = 0; i < 4; i++) {
    cap.answer.text = `FOUND: Change ${i}\nCheck it.`
    await cap.e.runNow(cappedTeam.id)
  }
  c.same('watches: four findings spend four looks plus only three admitted team runs', [cap.gate.used, cap.handed.length], [7, 3])
  c.check('watches: handoffs use and record the account picked by the gate', accounts.length === 3 && accounts.every(a => a === 'acc-1') && cap.e.get(cappedTeam.id)!.runs.filter(r => r.chatId).every(r => r.teamAccountId === 'acc-1'))
  cap.e.dispose()
  const cappedRestart = rig('cap-restart', { dir: cap.dir, start: cap.clock.t })
  cappedRestart.answer.text = 'FOUND: More news\nCheck it.'
  await cappedRestart.e.runNow(cappedTeam.id)
  c.same('watches: restart preserves the daily team cap', cappedRestart.handed.length, 0)
  cappedRestart.clock.t += DAY
  cappedRestart.answer.text = 'FOUND: Tomorrow news\nCheck it.'
  await cappedRestart.e.runNow(cappedTeam.id)
  c.same('watches: next local day allows a team handoff again', cappedRestart.handed.length, 1)
  cappedRestart.e.dispose()

  // While a team chat a watch started is still working, the next finding is told, and uses none of the day's three.
  const oneAtATime = rig('handoff-busy')
  const busyTeam = { on: true }
  oneAtATime.host.teamBusy = () => busyTeam.on
  // The hub itself refuses while one is working (as watchHand does), whether or not the engine asked first.
  oneAtATime.host.handTo = async (_w, title) => (busyTeam.on ? undefined : (oneAtATime.handed.push(title), 'chat-busy-' + oneAtATime.handed.length))
  const waitingTeam = oneAtATime.e.saveWatch({ name: 'Team wait', prompt: 'Report changes', trigger: { kind: 'schedule', every: 15 }, onFind: 'team' })
  for (let i = 0; i < 4; i++) {
    oneAtATime.answer.text = `FOUND: While busy ${i}\nCheck it.`
    await oneAtATime.e.runNow(waitingTeam.id)
  }
  const looksWhileBusy = oneAtATime.gate.used
  c.check('watches: findings while a team chat a watch started is working are told, not handed, and use only their looks', oneAtATime.handed.length === 0 && looksWhileBusy === 4 && oneAtATime.e.inbox().filter((i) => i.kind === 'found').length === 4 && /not handed to the team/.test(oneAtATime.e.get(waitingTeam.id)!.runs[0].note || ''), `${oneAtATime.handed.length} handed, ${looksWhileBusy} counted`)
  busyTeam.on = false
  for (let i = 0; i < 4; i++) {
    oneAtATime.answer.text = `FOUND: After ${i}\nCheck it.`
    await oneAtATime.e.runNow(waitingTeam.id)
  }
  c.same('watches: and none of the three handoffs of the day was used up meanwhile: three chats still start, the fourth is held', [oneAtATime.handed.length, oneAtATime.e.inbox().filter((i) => i.ref?.startsWith('capped:')).length], [3, 1])
  oneAtATime.e.dispose()

  const parallel = rig('handoff-parallel')
  const handStarted = deferred<void>()
  const handRelease = deferred<string>()
  parallel.answer.text = 'FOUND: Finding\nCheck it.'
  parallel.host.handTo = async (_w, title) => { parallel.handed.push(title); handStarted.resolve(); return handRelease.promise }
  const p1 = parallel.e.saveWatch({ name: 'One', prompt: 'brief', trigger: { kind: 'schedule', every: 15 }, onFind: 'team' })
  const p2 = parallel.e.saveWatch({ name: 'Two', prompt: 'brief', trigger: { kind: 'schedule', every: 15 }, onFind: 'team' })
  const first = parallel.e.runNow(p1.id)
  await handStarted.promise
  const second = parallel.e.runNow(p2.id)
  await new Promise(r => setImmediate(r))
  c.same('watches: simultaneous findings launch only one team handoff', parallel.handed.length, 1)
  handRelease.resolve('team-chat')
  await Promise.all([first, second])
  parallel.e.dispose()

  const rollback = rig('clock-back')
  const backWatch = rollback.e.saveWatch({ name: 'Every 15', prompt: 'brief', trigger: { kind: 'schedule', every: 15 } })
  rollback.clock.t += 15 * MIN
  await rollback.e.tick()
  rollback.clock.t -= DAY
  await rollback.e.tick()
  c.check('watches: a backward clock clamps the next look within one interval', rollback.e.get(backWatch.id)!.nextAt! <= rollback.clock.t + 15 * MIN)
  rollback.clock.t += 15 * MIN
  await rollback.e.tick()
  c.same('watches: after a backward clock the watch really runs within that interval', rollback.calls.length, 2)
  rollback.e.dispose()

  const load = rig('many-quiet')
  const stable = steadyText(load.page.text).split('\n').map(fingerprint)
  for (let i = 0; i < 200; i++) {
    const w = load.e.saveWatch({ name: `Page ${i}`, prompt: 'changes', trigger: { kind: 'url', url: 'https://example.com' } })
    Object.assign(load.e.get(w.id)!, { seen: fingerprint(stable.join('|')), seenItems: stable })
  }
  let flight = 0, peak = 0, writes = 0
  const rename = saveIo.rename
  saveIo.rename = (from, to) => { if (to === path.join(load.dir, 'watches.json')) writes++; rename(from, to) }
  load.host.fetchText = async () => {
    peak = Math.max(peak, ++flight)
    await new Promise(r => setImmediate(r))
    flight--
    return load.page.text
  }
  load.clock.t += 15 * MIN
  try {
    await Promise.all([load.e.tick(), load.e.tick()])
    load.e.dispose()
  } finally { saveIo.rename = rename }
  c.check('watches: 200 quiet watches use at most four concurrent looks', peak <= 4 && peak > 0 && load.e.list().every(w => w.runs[0]?.outcome === 'quiet'), `peak ${peak}`)
  c.check('watches: 200 quiet watches batch to at most three durable writes and zero model calls', writes <= 3 && writes > 0 && load.calls.length === 0, `${writes} writes, ${load.calls.length} calls`)

  // ── an approval the guard asked for in an unattended run: its summary and its expiry reach the inbox ──
  const g = rig('approval')
  g.e.observe({ type: 'item', chatId: 'c9', accountId: 'a9', item: { id: 'p1', ts: 1, kind: 'permission', requestId: 'req-9', toolName: 'mcp__github__create_issue', title: 'Use github: create_issue {"title":"CI failed"}', detail: 'It asks because it posts to GitHub. This run has read a web page.', canRemember: false, status: 'pending', unattended: true, expiresAt: g.clock.t + 40 * MIN } as never })
  const ap = g.e.inbox().find((i) => i.approval?.requestId === 'req-9')
  c.check("watches: an unattended approval carries the guard's summary, its reason and when it lapses", ap?.title.startsWith('Use github: create_issue') === true && /posts to GitHub/.test(ap.body) && ap.approval?.expiresAt === g.clock.t + 40 * MIN, JSON.stringify(ap))
  g.e.dispose()

  // ── the built-in caps (until guard.ts offers its own) ──
  const capsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ens-caps-')), 'caps.json')
  const acc = [
    { id: 'claude-a', provider: 'claude', ready: true, left: 90 },
    { id: 'gpt-low', provider: 'chatgpt', ready: true, left: 20 },
    { id: 'gpt-ok', provider: 'chatgpt', ready: true, left: 60 },
  ]
  const gate = fallbackGate({ file: capsFile, now: () => Date.UTC(2026, 10, 20, 9), zone: UTC, caps: () => ({ runsPerDay: 3, runsPerAccount: 2, keepFree: 30 }), accounts: () => acc })
  c.same('watches: the built-in caps pick a ChatGPT account first, never one running low', gate.pick().accountId, 'gpt-ok')
  gate.record('gpt-ok', { ms: 1, turns: 1 })
  gate.record('gpt-ok', { ms: 1, turns: 1 })
  c.same('watches: an account at its daily share hands over to the next', gate.pick().accountId, 'claude-a')
  gate.record('claude-a', { ms: 1, turns: 1 })
  c.check('watches: the daily cap stops all unattended looks', gate.pick().accountId === null && gate.today().runs === 3)

  // ── the real hub in demo mode ──
  const { hub, dataDir } = await c.freshHub('watches')
  const events: HubEvent[] = []
  const emit = hub.emit.bind(hub)
  hub.emit = (ev: HubEvent) => {
    events.push(ev)
    emit(ev)
  }
  try {
    const quiet = await hub.watches.runNow(hub.watches.saveWatch({ name: 'Morning check', prompt: 'Tell me only if anything is wrong', trigger: { kind: 'schedule', at: '07:00', days: [1, 2, 3, 4, 5] } }).id)
    c.check('watches (demo): a watch that finds nothing is quiet', quiet.runs[0]?.outcome === 'quiet' && !!quiet.runs[0].model)
    const found = await hub.watches.runNow(hub.watches.saveWatch({ name: 'CI on the pricing site', prompt: 'Tell me when CI fails', trigger: { kind: 'github', repo: 'acme/pricing-site', on: 'ci-failed' } }).id)
    c.check('watches (demo): a watch that finds something puts it in the inbox', found.runs[0]?.outcome === 'found' && hub.watches.inbox().some((i) => i.kind === 'found' && i.watchId === found.id && /CI failed/.test(i.title)), JSON.stringify(found.runs[0]))
    const again2 = await hub.watches.runNow(found.id)
    c.same('watches (demo): looked again with nothing new: quiet, no model', [again2.runs[0]?.outcome, again2.runs[0]?.model], ['quiet', undefined])
    const failing = hub.watches.saveWatch({ name: 'Status page', prompt: 'Tell me if anything is down', trigger: { kind: 'url', url: 'https://status.example.com/fail' } })
    for (let i = 0; i < 3; i++) await hub.watches.runNow(failing.id)
    c.check('watches (demo): a watch that fails three times is paused and told', hub.watches.get(failing.id)?.status === 'paused' && hub.watches.inbox().some((i) => i.kind === 'failed' && i.watchId === failing.id))
    c.check('watches (demo): the window hears of it (watches and inbox events)', events.some((e) => e.type === 'watches') && events.some((e) => e.type === 'inbox'))
    const team = await hub.watches.runNow(hub.watches.saveWatch({ name: 'CI, handed on', prompt: 'Tell me when CI fails', trigger: { kind: 'github', repo: 'acme/pricing-site', on: 'ci-failed' }, onFind: 'team' }).id)
    const chatId = team.runs[0]?.chatId
    const chat = chatId ? hub.chats.get(chatId) : undefined
    c.check('watches (demo): handed to the team: a chat with watchId, in Verified, with a small goal', team.runs[0]?.outcome === 'handed' && chat?.watchId === team.id && !!chat?.goal && (chat.goal.maxRounds || 0) <= 3, JSON.stringify(team.runs[0]))
    c.check('watches (demo): the team chat uses the gate-picked account', !!chat && chat.leadId === team.runs[0]?.teamAccountId)
    if (chat) {
      // Leave the first goal active while another finding arrives: serializing just
      // the handTo promises is not enough to serialize the actual team work.
      const concurrent = await hub.watches.runNow(hub.watches.saveWatch({ name: 'Another CI', prompt: 'Tell me when CI fails', trigger: { kind: 'github', repo: 'acme/pricing-site', on: 'ci-failed' }, onFind: 'team' }).id)
      c.check('watches (demo): an active team goal prevents a second team chat', concurrent.runs[0]?.outcome === 'found' && !concurrent.runs[0]?.chatId && [...hub.chats.values()].filter(x => x.watchId).length === 1)
      await hub.stop(chat.id)
    }
    // Approvals and blocked goals, from the hub's own events.
    const anyChat = hub.createChat({ cwd: c.work })
    hub.emit({ type: 'item', chatId: anyChat.id, accountId: c.leadId, item: { id: 'perm-x', ts: Date.now(), kind: 'permission', requestId: 'req-x', toolName: 'Bash', title: 'Run npm install', status: 'pending' } })
    const asked = hub.watches.inbox().find((i) => i.approval?.requestId === 'req-x')
    c.check('watches (demo): a permission waiting in a chat is a needs-you item with the approval', asked?.kind === 'needs-you' && asked.approval?.chatId === anyChat.id && !asked.done)
    hub.emit({ type: 'item-patch', chatId: anyChat.id, accountId: c.leadId, id: 'perm-x', patch: { status: 'allowed' } })
    c.check('watches (demo): answered, it goes', !!hub.watches.inbox().find((i) => i.approval?.requestId === 'req-x')?.done)
    hub.emit({ type: 'chat', chat: { ...anyChat, goal: { id: 'g-x', text: 'Ship it', status: 'blocked', round: 1, maxRounds: 3, check: 'fresh', createdAt: Date.now(), note: 'Which provider?', log: [] } } })
    c.check('watches (demo): a goal that needs the user is in the inbox', hub.watches.inbox().some((i) => i.ref === 'goal:g-x' && !i.done && i.title === 'The goal needs you'))
    hub.emit({ type: 'chat', chat: { ...anyChat, goal: { id: 'g-x', text: 'Ship it', status: 'active', round: 1, maxRounds: 3, check: 'fresh', createdAt: Date.now(), log: [] } } })
    c.check('watches (demo): going again, it goes from the inbox', !!hub.watches.inbox().find((i) => i.ref === 'goal:g-x')?.done)
    // Everything survives a restart of the hub.
    const watchesBefore = hub.watches.list().length
    const inboxBefore = hub.watches.inbox().length
    await hub.dispose()
    const H = hub.constructor as unknown as new (host: object) => Hub
    const back = new H({ dataDir, version: 'test', demo: true, mica: false, isFocused: () => false, notify: () => {}, emit: () => {} })
    await back.start()
    c.same('watches (demo): after a restart of the hub the watches and the inbox are all there', [back.watches.list().length, back.watches.inbox().length], [watchesBefore, inboxBefore])
    c.check('watches (demo): the paused watch is still paused, the others still on', back.watches.get(failing.id)?.status === 'paused' && back.watches.get(found.id)?.status === 'active')
    await back.dispose()
  } finally {
    hub.emit = emit
  }
  void (null as unknown as InboxItem)
  void watchPrompt
}
