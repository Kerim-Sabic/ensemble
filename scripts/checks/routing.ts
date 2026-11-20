import fs from 'node:fs'
import path from 'node:path'
import { familyOf, FLOOR, heldOut, HOLDOUT, Learning, taskFeatures } from '../../src/main/learning'
import type { Tier } from '../../src/shared/budget'
import type { Account, Chat, Goal, HubEvent, Task } from '../../src/shared/types'
import type { Ctx } from './ctx'

// Model routing: outcomes count only on real evidence, a held-out set must bear out every move,
// grouping by similar words is used only when it predicts better on held-out data, and difficulty
// and confidence change real decisions through the hub's own dispatch.

/** A small seeded random source, so every run of the simulations is the same. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Job = { chatId: string; id: string; title: string; brief: string; effort?: string }

export default async function (c: Ctx): Promise<void> {
  const { dataDir, check, same } = c
  const dir = path.join(dataDir, 'routing-checks')
  // A clean folder: a checksum or backup left by an earlier run would make the old file below look damaged.
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'learning.json')
  let now = Date.UTC(2026, 1, 1)
  const saved = (): { version: number; recent: { key: string; attempts: Record<string, Record<string, unknown>> }[] } => JSON.parse(fs.readFileSync(file, 'utf8'))

  // ----- migration of old files -----
  fs.writeFileSync(file, JSON.stringify({ Sonnet: { family: 'Sonnet', tier: 'mid', done: 23, failed: 4, weak: 17, kinds: { code: { weak: 17 } } }, Sol: null }))
  const learn = new Learning(dir, () => now)
  same('routing migrates the oldest file in place', saved().version, 3)
  check('old lifetime totals survive migration and restart', new Learning(dir).summary().includes('finished 23 of 27 attempts'))
  fs.writeFileSync(file, JSON.stringify({ version: 2, models: {}, easySinceTrial: 4, recent: [{ key: 'old/t1', kind: 'code', difficulty: 'standard', at: now, attempts: { Sonnet: { ok: true, review: 'too_weak' } } }] }))
  new Learning(dir, () => now)
  const v2 = saved()
  check('a version 2 file keeps its task rows when it is moved to version 3', v2.version === 3 && v2.recent.length === 1 && v2.recent[0].attempts.Sonnet.review === 'too_weak', JSON.stringify(v2).slice(0, 200))
  learn.reset()

  // ----- tasks, and where their outcomes go -----
  let id = 0
  const job = (title = 'Implement the migration', brief = '', effort?: string, chatId = 'routing'): Job => ({ chatId, id: 't' + ++id, title, brief, effort })
  /** The next task of this kind whose outcomes land in the fitted set (held false) or the held-out set. */
  const into = (held: boolean, make: () => Job = () => job()): Job => {
    for (;;) {
      const t = make()
      if (heldOut(`${t.chatId}/${t.id}`) === held) return t
    }
  }
  same('short mechanical task is easy', taskFeatures(job('Rename the images')).difficulty, 'easy')
  same('independent review is at least standard', taskFeatures(job("Review another team's work")).difficulty, 'standard')
  same('architecture plus concurrency is hard', taskFeatures(job('Design the architecture', 'Account for concurrency.')).difficulty, 'hard')
  same('file count, brief structure, constraints and effort affect difficulty', taskFeatures(job('Implement changes', '1. Preserve a.ts and b.ts\n2. Verify c.ts\n3. Update d.ts', 'high')).difficulty, 'hard')
  same('explicit effort contributes to an otherwise easy task', taskFeatures(job('Extract the counts', '', 'high')).difficulty, 'standard')
  check('a task is described by its words and the file types it names', taskFeatures(job('Fix the shader', 'In render.ts and main.css')).words.join(' ') === '.css .ts main render shader', taskFeatures(job('Fix the shader', 'In render.ts and main.css')).words.join(' '))

  // Held-out assignment: by the task's id alone, the same every time, near the intended share.
  const keys = Array.from({ length: 5000 }, (_, i) => `chat-${i % 37}/t${i}`)
  const share = keys.filter(heldOut).length / keys.length
  check('held-out assignment is near the intended share of one task in five', Math.abs(share - HOLDOUT.share) < 0.02, share.toFixed(3))
  check('and stable: the same task always lands in the same set', keys.every((k) => heldOut(k) === heldOut(`${k}`)) && heldOut('routing/t1') === heldOut('routing/' + 't1'))

  // ----- what counts as an outcome -----
  same('a task with no history keeps the usual tier', learn.decide('mid', job()).tier, 'mid')
  for (let i = 0; i < 3; i++) learn.vote('sonnet', 'too_weak', undefined, job(), true)
  for (let i = 0; i < 3; i++) learn.vote('haiku', 'enough', undefined, job(), true)
  same('three ratings never move anything, up or down', learn.decide('mid', job()).tier, 'mid')
  learn.reset()

  // A cheaper model that only "finishes": that is no evidence the work was good.
  for (let i = 0; i < 20; i++) learn.outcome('haiku', true, job())
  for (let i = 0; i < 20; i++) learn.outcome('sonnet', true, job())
  const finished = Array.from({ length: 20 }, () => learn.decide('mid', job()))
  check('a cheaper model that finishes twenty times with no review or passing run gets no more work for it', finished.every((d) => d.tier === 'mid' && !d.trial), finished.map((d) => d.tier).join(','))
  learn.reset()

  // Real evidence of poor work: independent reviews. Ten bad ones, eight in the fitted set and two held out.
  const bad = [...Array.from({ length: 8 }, () => into(false)), ...Array.from({ length: 2 }, () => into(true))]
  for (const t of bad) {
    learn.outcome('sonnet', true, t)
    learn.vote('sonnet', 'enough', undefined, t)
    learn.vote('sonnet', 'too_weak', undefined, t, true)
  }
  const up = learn.decide('mid', job())
  same('ten independent bad reviews (eight fitted, two held out) step up, over the assigner\'s own "enough"', up.tier, 'strong')
  check('the explanation is one plain sentence with both counts', /^Code at ordinary difficulty fell short 8 times out of 8 on mid-sized models, and 2 out of 2 in the held-out check, so this one runs on a stronger model$/.test(up.why), up.why)
  same('evidence is kept apart by difficulty', learn.decide('mid', job('Implement the architecture for concurrent migration')).tier, 'mid')
  now += 46 * 86_400_000
  same('old evidence decays below the floor', learn.decide('mid', job()).tier, 'mid')
  now -= 46 * 86_400_000
  learn.reset()

  // The fitted set alone is not enough: the held-out set must bear the move out.
  for (let i = 0; i < 12; i++) {
    const t = into(false)
    learn.outcome('sonnet', true, t)
    learn.vote('sonnet', 'too_weak', undefined, t, true)
  }
  const waiting = learn.decide('mid', job())
  same('a move the fitted set supports waits while the held-out set has nothing to say', waiting.tier, 'mid')
  for (let i = 0; i < 3; i++) {
    const t = into(true)
    learn.outcome('sonnet', true, t)
    learn.vote('sonnet', 'enough', undefined, t, true)
  }
  const contradicted = learn.decide('mid', job())
  same('a move supported by the fitted set and contradicted by the held-out set is not made', contradicted.tier, 'mid')
  check('and the sentence says the held-out check does not bear it out', /but the held-out check does not bear that out yet \(0 out of 3\), so the usual model stays$/.test(contradicted.why), contradicted.why)
  learn.reset()

  // Failing at the work is seen for every task, so it counts by itself (a network or storage failure does not reach here).
  for (let i = 0; i < 7; i++) learn.outcome('sonnet', false, into(false))
  learn.outcome('sonnet', false, into(true))
  learn.outcome('sonnet', false, into(true))
  same('seven real failures in the fitted set are still below the floor', learn.decide('mid', job()).tier, 'mid')
  learn.outcome('sonnet', false, into(false))
  same(`${FLOOR} real failures, borne out by two held out, move the tier up`, learn.decide('mid', job()).tier, 'strong')
  check('network and storage failures carry no performance evidence', !learn.workFailure('HTTP 503') && !learn.workFailure('ENOSPC writing output') && learn.workFailure('Could not complete the requested work'))
  learn.reset()

  // The assigner's own rating weighs a quarter: sixteen dislikes on finished work are not enough.
  for (let i = 0; i < 16; i++) {
    const t = job()
    learn.outcome('sonnet', true, t)
    learn.vote('sonnet', 'too_weak', undefined, t)
  }
  same('the assigner disliking the pick sixteen times is not enough on its own', learn.decide('mid', job()).tier, 'mid')
  learn.reset()

  // Over-qualification: independent ratings, in both sets.
  for (let i = 0; i < 9; i++) learn.vote('sonnet', 'more_than_needed', undefined, into(false), true)
  for (let i = 0; i < 4; i++) learn.vote('sonnet', 'more_than_needed', undefined, into(true), true)
  const over = learn.decide('mid', job())
  same('ratings that keep finding a model more than needed support a cheaper tier', over.tier, 'light')
  check('and the sentence says so with the counts', /^Ratings found mid-sized models more than needed 9 times out of 9 for code at ordinary difficulty, and 4 out of 4 in the held-out check, so this one runs a step down$/.test(over.why), over.why)
  learn.reset()

  // Evidence from the execution trace: the last run of each kind decides.
  const ran = job()
  const ranAt = (command: string, ok: boolean, ts: number) => ({ command, ok, ts })
  same('a passing test run in the trace is evidence of good work', learn.proveFrom('haiku', ran, { ran: [ranAt('npx vitest run src/api', false, 1), ranAt('npx vitest run src/api', true, 2), ranAt('git status', false, 3)] }), 'pass')
  same('a failing last build is evidence of work that fell short', learn.proveFrom('haiku', job(), { ran: [ranAt('npm test', true, 1), ranAt('npm run build', false, 2)] }), 'fail')
  same('no test or build run is no evidence', learn.proveFrom('haiku', job(), { ran: [ranAt('git status', true, 1)] }), null)
  // A goal met by a fresh checker credits the tasks of the round it judged; the lead's own word does not.
  const goal = (check: Goal['check']): Pick<Goal, 'check' | 'createdAt' | 'log'> => ({ check, createdAt: now - 10_000, log: [{ round: 0, ts: now - 5_000, met: false, note: 'not yet' }] })
  const tasks = [
    { ...job(), status: 'done' as const, ranOn: 'claude-haiku-4-5', finishedAt: now - 1_000 },
    { ...job(), status: 'done' as const, ranOn: 'claude-haiku-4-5', finishedAt: now - 8_000 },
  ]
  same('a goal met by a fresh checker credits only the tasks finished in the round it judged', [learn.goalMet(goal('self'), tasks), learn.goalMet(goal('fresh'), tasks)], [0, 1])
  learn.reset()

  // ----- the trial: one easy task in twenty -----
  const easy = (): Job => job('Extract the counts')
  const before = Array.from({ length: 19 }, () => learn.decide('mid', easy()))
  const sample = easy()
  learn.flush()
  const probe = new Learning(dir, () => now)
  const trial = probe.decide('mid', sample)
  check('only one easy assignment in twenty is a marked trial, even across restart', before.every((d) => !d.trial && d.tier === 'mid') && trial.trial && trial.tier === 'light' && trial.why.startsWith('A trial: one easy task in twenty'))
  for (let i = 0; i < 3; i++) {
    probe.outcome('haiku', false, sample)
    probe.vote('haiku', 'too_weak', undefined, sample)
    probe.outcome('sonnet', true, sample)
  }
  check('retry counts the failed trial once and credits its stronger replacement once', probe.list().find((r) => r.family === 'Haiku')?.failed === 1 && probe.list().find((r) => r.family === 'Sonnet')?.done === 1)
  probe.flush()
  check('task feedback survives restart without repeating the trial penalty', new Learning(dir).list().find((r) => r.family === 'Haiku')?.weak === 1)
  learn.reset()

  // ----- simulation: a known best tier is found and kept -----
  // Each task fails at its work at the tier's rate; finished work is reviewed by someone independent
  // most of the time and found too weak at the tier's rate. Mid is the usual tier; easy work can only
  // reach light through trials.
  const models: Record<string, string> = { light: 'haiku', mid: 'sonnet', strong: 'opus' }
  const truth = {
    easy: { fail: { light: 0.02, mid: 0.01, strong: 0.01 }, weak: { light: 0.03, mid: 0.01, strong: 0.01 }, reviewed: 0.9, n: 1200, best: 'light' },
    hard: { fail: { light: 0.5, mid: 0.35, strong: 0.03 }, weak: { light: 0.6, mid: 0.4, strong: 0.05 }, reviewed: 0.6, n: 300, best: 'strong' },
  } as const
  for (const bucket of ['hard', 'easy'] as const) {
    const t = truth[bucket]
    const rnd = random(bucket === 'easy' ? 7 : 11)
    const picks: Tier[] = []
    for (let i = 0; i < t.n; i++) {
      const task = { chatId: `sim-${bucket}`, id: `t${i}`, title: bucket === 'easy' ? 'Extract the counts' : 'Implement a concurrent architecture migration' }
      const tier = learn.decide('mid', task, ['strong', 'mid', 'light']).tier as 'light' | 'mid' | 'strong'
      picks.push(tier)
      const failed = rnd() < t.fail[tier]
      learn.outcome(models[tier], !failed, task)
      if (!failed && rnd() < t.reviewed) learn.vote(models[tier], rnd() < t.weak[tier] ? 'too_weak' : 'enough', undefined, task, true)
    }
    const tail = picks.slice(-200)
    const first = picks.indexOf(t.best)
    const switches = tail.filter((x, i) => i > 0 && x !== tail[i - 1]).length
    check(`simulation: ${bucket} work converges to the ${t.best} tier and stays there (no switching in the last 200)`, tail.every((x) => x === t.best) && switches === 0, `first ${t.best} at task ${first}; last 200: ${[...new Set(tail)].join(',')}`)
    learn.reset()
  }

  // ----- beyond the regex kind: grouping by similar words, used only when held-out data says so -----
  // Every task here is "code" by the regex, at the same difficulty. Words carry the signal: shader work
  // falls short on mid-sized models, button work does not.
  {
    const rnd = random(3)
    for (let i = 0; i < 240; i++) {
      const shader = i % 2 === 0
      const t = job('Implement the feature', shader ? 'The shader pipeline on the gpu.' : 'The button label and tooltip.', 'high')
      learn.outcome('sonnet', true, t)
      learn.vote('sonnet', rnd() < (shader ? 0.85 : 0.08) ? 'too_weak' : 'enough', undefined, t, true)
    }
    const g = learn.grouping()
    check('when words carry the signal, grouping by similar words predicts held-out outcomes better than the kind, and is used', g.mode === 'similar' && (g.similar ?? 1) < (g.kind ?? 0), JSON.stringify(g))
    const s = learn.decide('mid', job('Implement the feature', 'The shader pipeline on the gpu.', 'high'), ['strong', 'mid', 'light'])
    const b = learn.decide('mid', job('Implement the feature', 'The button label and tooltip.', 'high'), ['strong', 'mid', 'light'])
    check('and it routes shader work up while button work stays', s.tier === 'strong' && b.tier === 'mid' && s.why.startsWith('Tasks like this one'), `${s.tier}: ${s.why} | ${b.tier}: ${b.why}`)
    learn.reset()
  }
  {
    // Words are noise here; only the kind matters. The simpler grouping is kept.
    const rnd = random(5)
    const vocab = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    const word = (): string => vocab[Math.floor(rnd() * vocab.length)]
    for (let i = 0; i < 240; i++) {
      const code = i % 2 === 0
      const t = job(`${code ? 'Implement' : 'Write'} the ${word()} ${word()}`, `${word()} ${word()}`, 'high')
      learn.outcome('sonnet', true, t)
      learn.vote('sonnet', rnd() < (code ? 0.1 : 0.8) ? 'too_weak' : 'enough', undefined, t, true)
    }
    const g = learn.grouping()
    check('when words carry nothing the kind does not, the regex kind is kept', g.mode === 'kind', JSON.stringify(g))
    learn.reset()
  }

  fs.writeFileSync(file, '{"version":3,"models":false,"recent":[null,{"attempts":null}]}')
  same('malformed saved fields leave routing usable', new Learning(dir).decide('mid', job()).tier, 'mid')

  // ----- through the real dispatch: assign -> begin -> smartRun -> learning.decide -----
  const { hub: h } = await c.freshHub('routing-dispatch')
  try {
    const lead = h.lead() as Account
    const chat: Chat = h.createChat({ cwd: c.work })
    const mate = h.bootstrap().accounts.find((a) => a.id !== lead.id && a.provider === 'claude' && a.enabled && !a.model)
    check('the demo team has a teammate whose model the app picks', !!mate)
    if (mate) {
      const hub = h as unknown as { assign(chat: Chat, from: Account, args: { to: string; title: string; brief: string }): string }
      const give = (brief: string): Task => {
        hub.assign(chat, lead, { to: mate.name, title: 'Implement the export endpoint', brief })
        return h.tasksOf(chat.id).at(-1) as Task
      }
      const standard = 'Update src/api/export.ts and src/api/routes.ts.'
      const hard = 'Update src/api/export.ts and src/api/routes.ts. Mind the architecture and the concurrency.'
      const tierOf = (t: Task): string => familyOf(t.model)?.tier || 'none'
      const plain = give(standard)
      same('with no history, a teammate runs the usual model for its place in the team', tierOf(plain), 'strong')
      // Clean, independently reviewed results on the mid-sized model, for ordinary code work.
      const seed = (n: number): void => {
        for (let i = 0; i < n; i++) {
          const t = { chatId: 'history', id: `h${i}`, title: 'Implement the import endpoint', brief: standard }
          h.learning.outcome('claude-sonnet-4-5', true, t)
          h.learning.vote('claude-sonnet-4-5', 'enough', undefined, t, true)
        }
      }
      seed(6)
      const thin = give(standard)
      same('confidence: six clean results are not enough to move a real assignment', tierOf(thin), 'strong')
      h.learning.reset()
      seed(60)
      const sure = give(standard)
      same('confidence: sixty clean results move the same assignment to the cheaper model', tierOf(sure), 'mid')
      check('and the task carries the reason in a sentence', /fell short only 0 times out of \d+ on mid-sized models, and 0 out of \d+ in the held-out check, so this one runs on that cheaper model/.test(sure.modelWhy || ''), sure.modelWhy)
      const tough = give(hard)
      same('difficulty: the same history does not move a hard task', tierOf(tough), 'strong')
      // The finished task's own test run reaches routing through the execution trace.
      // Polled: the harness's `until` looks again only when the main hub says something, and this is a second hub.
      for (let end = Date.now() + 60_000; !h.tasksOf(chat.id).some((t) => t.status === 'done'); await c.pause(50)) {
        if (Date.now() > end) throw new Error('timed out waiting for: the dispatched task to finish')
      }
      const done = h.tasksOf(chat.id).find((t) => t.status === 'done') as Task
      const family = familyOf(done.ranOn)?.name || ''
      let row: Record<string, unknown> | undefined
      for (let i = 0; i < 100 && !row?.run; i++) {
        await c.pause(50)
        const json = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'learning.json'), 'utf8')) as { recent: { key: string; attempts: Record<string, Record<string, unknown>> }[] }
        row = json.recent.find((r) => r.key === `${chat.id}/${done.id}`)?.attempts[family]
      }
      check('a finished task\'s passing test run, read from the execution trace, is recorded as evidence', row?.ok === true && row?.run === 'pass', JSON.stringify(row))
      // A goal met by a fresh checker reaches routing through the hub's own events.
      const gchat: Chat = h.createChat({ cwd: c.work })
      gchat.goal = { id: 'g1', text: 'Ship it', status: 'met', round: 1, maxRounds: 12, check: 'fresh', createdAt: Date.now() - 10_000, log: [], doneWhen: '' } as unknown as Goal
      const credited = { id: 't1', chatId: gchat.id, title: 'Implement the export endpoint', brief: standard, from: lead.id, to: mate.id, status: 'done', createdAt: Date.now() - 5_000, finishedAt: Date.now() - 1_000, ranOn: 'claude-haiku-4-5' } as Task
      h.tasksOf(gchat.id).push(credited)
      h.learning.flush()
      h.emit({ type: 'item', chatId: gchat.id, accountId: lead.id, item: { id: 'auto-g', kind: 'auto', ts: Date.now(), of: 'goal', event: 'met', ref: 'g1', title: 'Goal met after 2 rounds' } } as HubEvent)
      h.learning.flush()
      const after = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'learning.json'), 'utf8')) as { recent: { key: string; attempts: Record<string, Record<string, unknown>> }[] }
      check('a goal met by a fresh checker credits the round\'s tasks through the hub', after.recent.find((r) => r.key === `${gchat.id}/t1`)?.attempts.Haiku?.goal === true)
      for (const ch of [chat, gchat]) await h.stop(ch.id)
    }
  } finally {
    await h.dispose()
  }
}
