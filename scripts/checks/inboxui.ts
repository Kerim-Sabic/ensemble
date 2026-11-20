// Watches and Inbox in the window (Canvas): the plain words the window shows, and how the inbox
// groups and counts. Everything here is the pure helpers the components draw with.
import type { Ctx } from './ctx'
import type { InboxItem, Watch, WatchRun } from '../../src/shared/watches'
import { DEFAULT_CAPS } from '../../src/shared/watches'
import { APP_COMMANDS, parseCommand } from '../../src/shared/auto'
import { capsLine, costLine, groupInbox, modelLooksToday, inboxCount, lapseLine, nameFrom, nextLine, outcomeLine, problemOf, readyMade, triggerLine, triggerOf, whenOf } from '../../src/renderer/src/components/watches/words'

export default async function checks(c: Ctx): Promise<void> {
  const { same, check } = c

  // What a watch looks at.
  same('triggers in plain words', [
    triggerLine({ kind: 'schedule', every: 30 }),
    triggerLine({ kind: 'schedule', every: 120 }),
    triggerLine({ kind: 'schedule', every: 2 }),
    triggerLine({ kind: 'schedule', at: '07:00' }),
    triggerLine({ kind: 'schedule', at: '07:00', days: [1, 2, 3, 4, 5] }),
    triggerLine({ kind: 'schedule', at: '09:30', days: [1, 3, 5] }),
    triggerLine({ kind: 'schedule', at: '10:00', days: [0, 6] }),
    triggerLine({ kind: 'github', repo: 'Kerim-Sabic/ensemble', on: 'ci-failed' }),
    triggerLine({ kind: 'github', repo: 'a/b', on: 'issue' }),
    triggerLine({ kind: 'github', repo: 'a/b', on: 'pr' }),
    triggerLine({ kind: 'url', url: 'https://www.example.com/pricing/' }),
    triggerLine({ kind: 'path', path: 'C:\\Users\\kerim\\ensemble\\src' }),
    triggerLine({ kind: 'command', command: 'git status' }),
  ], [
    'Every 30 minutes',
    'Every 2 hours',
    'Every 5 minutes',
    'Every day at 07:00',
    'On weekdays at 07:00',
    'On Mon, Wed and Fri at 09:30',
    'At weekends at 10:00',
    'Failed checks on Kerim-Sabic/ensemble',
    'New issues on a/b',
    'New pull requests on a/b',
    'Changes to example.com/pricing',
    'Changes in ensemble/src',
    'Changes in what a command prints',
  ])

  // When it looks next, from a fixed "now": Friday 20 November 2026, 10:00 local time.
  const now = new Date(2026, 10, 20, 10, 0).getTime()
  const at = (d: number, h: number, m = 0): number => new Date(2026, 10, 20 + d, h, m).getTime()
  same('the next look in plain words', [
    nextLine({ status: 'active', nextAt: now + 12 * 60_000 }, now),
    nextLine({ status: 'active', nextAt: at(0, 18) }, now),
    nextLine({ status: 'active', nextAt: at(1, 7) }, now),
    nextLine({ status: 'active', nextAt: at(3, 7) }, now),
    nextLine({ status: 'paused', nextAt: at(1, 7) }, now),
    nextLine({ status: 'active', nextAt: null }, now),
    nextLine({ status: 'active', nextAt: now + 10_000 }, now),
  ], ['In 12 min', 'Today at 18:00', 'Tomorrow at 07:00', 'Mon at 07:00', 'Paused', 'Looking now', 'Any moment'])

  // What the last look found.
  const run = (outcome: WatchRun['outcome'], note?: string, model?: string, ago = 60_000): WatchRun => ({ id: Math.random().toString(36), at: now - ago, ms: 900, outcome, note, model })
  same('outcomes in plain words', [
    outcomeLine(undefined),
    outcomeLine(run('quiet')),
    outcomeLine(run('found', 'CI failed on main: 2 tests in checkout.test.ts')),
    outcomeLine(run('handed', 'Handed to the team: fix the failing checkout test')),
    outcomeLine(run('failed', 'GitHub said: rate limited')),
    outcomeLine(run('skipped', 'outside its hours')),
    outcomeLine(run('capped')),
    outcomeLine(run('missed')),
  ], [
    'Has not looked yet',
    'Nothing new',
    'CI failed on main: 2 tests in checkout.test.ts',
    'Handed to the team: fix the failing checkout test',
    'Could not look: GitHub said: rate limited',
    'Skipped: outside its hours',
    "Held back by today's limit",
    'Missed while Ensemble was closed',
  ])

  // What it cost today: looks with and without a model; skipped and capped ones are not looks.
  const watch = (runs: WatchRun[]): Pick<Watch, 'runs'> => ({ runs })
  same('what a watch cost today', [
    costLine(watch([]), now),
    costLine(watch([run('quiet'), run('quiet')]), now),
    costLine(watch([run('found', 'x', 'gpt-6-luna'), run('quiet'), run('quiet'), run('skipped')]), now),
    costLine(watch([run('found', 'x', 'gpt-6-luna')]), now),
    costLine(watch([run('quiet', undefined, undefined, 20 * 3_600_000)]), now),
    costLine(watch([run('failed', 'GitHub said: rate limited')]), now),
    costLine(watch([run('failed', 'x'), run('quiet')]), now),
  ], ['No looks yet today', '2 looks today, no model needed', '3 looks today, 1 with a model', '1 look today, with a model', 'No looks yet today', '1 look today, without a model', '2 looks today, none with a model'])

  same('looks used today, over all watches, are the ones that needed a model', modelLooksToday([watch([run('found', 'x', 'm'), run('quiet')]), watch([run('quiet'), run('handed', 'y', 'm'), run('found', 'z', 'm', 20 * 3_600_000)])], now), 2)

  // The inbox: needs you first (soonest to lapse on top), then found (newest first), then failed.
  const item = (id: string, kind: InboxItem['kind'], ago: number, extra: Partial<InboxItem> = {}): InboxItem => ({ id, kind, title: id, body: '', at: now - ago, read: false, done: false, ...extra })
  const items: InboxItem[] = [
    item('found-old', 'found', 3_600_000, { read: true }),
    item('approve-late', 'needs-you', 60_000, { approval: { chatId: 'c', requestId: 'r1', expiresAt: now + 50 * 60_000 } }),
    item('found-new', 'found', 60_000),
    item('failed', 'failed', 120_000),
    item('approve-soon', 'needs-you', 600_000, { approval: { chatId: 'c', requestId: 'r2', expiresAt: now + 5 * 60_000 } }),
    item('goal-question', 'needs-you', 30_000),
    item('done', 'found', 10_000, { done: true }),
    item('lapsed', 'needs-you', 7_200_000, { approval: { chatId: 'c', requestId: 'r3', expiresAt: now - 60_000 } }),
  ]
  const g = groupInbox(items)
  same('needs you first, what lapses soonest on top', g.needsYou.map((i) => i.id), ['lapsed', 'approve-soon', 'approve-late', 'goal-question'])
  same('found for you, newest first; failed apart; done apart', [g.found.map((i) => i.id), g.failed.map((i) => i.id), g.done.map((i) => i.id)], [['found-new', 'found-old'], ['failed'], ['done']])
  same('the sidebar counts what needs you (not a lapsed approval), and new findings separately', inboxCount(items, now), { needs: 3, unread: 2 })
  same('when an approval lapses', [lapseLine(now + 38 * 60_000, now), lapseLine(new Date(2026, 10, 20, 18, 30).getTime(), now), lapseLine(new Date(2026, 10, 21, 2, 52).getTime(), now), lapseLine(new Date(2026, 10, 23, 9, 0).getTime(), now), lapseLine(now - 1, now), lapseLine(undefined, now)], ['Lapses in 38 min', 'Lapses at 18:30', 'Lapses tomorrow at 02:52', 'Lapses Mon at 09:00', 'Lapsed', null])

  same('the daily limits in a sentence', capsLine(DEFAULT_CAPS), 'At most 60 looks a day, 30 per account; no looks on an account with less than 30% left')

  // Making a watch: what is still missing, in plain words; and a round trip of "When?".
  same('what is missing before a watch can be saved', [
    problemOf({ prompt: '', when: { kind: 'every', minutes: 30 } }),
    problemOf({ prompt: 'x', when: { kind: 'every', minutes: 2 } }),
    problemOf({ prompt: 'x', when: { kind: 'daily', at: '7am', days: 'all' } }),
    problemOf({ prompt: 'x', when: { kind: 'github', repo: 'just-a-name', on: 'issue' } }),
    problemOf({ prompt: 'x', when: { kind: 'url', url: 'example.com' } }),
    problemOf({ prompt: 'x', when: { kind: 'daily', at: '07:00', days: 'weekdays' }, hours: [20, 8] }),
    problemOf({ prompt: 'x', when: { kind: 'github', repo: 'Kerim-Sabic/ensemble', on: 'ci-failed' }, hours: [8, 20] }),
  ], [
    'Say what to keep an eye on.',
    'Look at most every 5 minutes.',
    'Give the time as hours and minutes, for example 07:00.',
    'Give the repository as owner/name, for example Kerim-Sabic/ensemble.',
    'Give the full address of the page, starting with https://.',
    'The hours should run from an earlier hour to a later one.',
    null,
  ])
  const triggers = [
    { kind: 'schedule', every: 30 },
    { kind: 'schedule', at: '07:00', days: [1, 2, 3, 4, 5] },
    { kind: 'github', repo: 'a/b', on: 'pr' },
    { kind: 'url', url: 'https://example.com' },
    { kind: 'path', path: 'C:\\x' },
  ] as const
  same('"When?" goes to a trigger and back unchanged', triggers.map((t) => triggerOf(whenOf(t))), triggers)
  same('a name from what to watch', [nameFrom('tell me when the pricing page changes.'), nameFrom('When a CI run fails on the main branch of the project, find which step failed and why')], ['Tell me when the pricing page changes', 'When a CI run fails on the main branch of the…'])

  // Ready-made watches fit the folder, and only with triggers that exist.
  const withRepo = readyMade({ repo: 'Kerim-Sabic/ensemble', cwd: 'C:\\Users\\kerim\\ensemble' })
  check('ready-made watches for a folder with a repository: failed checks first, at most four, all valid', withRepo.length >= 3 && withRepo.length <= 4 && withRepo[0].trigger.kind === 'github' && withRepo.every((r) => problemOf({ prompt: r.prompt, when: whenOf(r.trigger) }) === null), JSON.stringify(withRepo.map((r) => r.name)))
  same('without a repository, nothing that needs GitHub is offered', readyMade({ repo: null, cwd: 'C:\\work\\site' }).map((r) => r.trigger.kind), ['path'])
  same('never the command trigger among the ready-made ones', withRepo.some((r) => r.trigger.kind === 'command'), false)

  // "/watch" opens the make-a-watch screen (the window handles it; the engine drops the line).
  same('"/watch" is a command of the window, with what to keep an eye on', [parseCommand('/watch'), parseCommand('/watch tell me when the pricing page changes'), parseCommand('/watcher x')], [{ kind: 'watch', text: '' }, { kind: 'watch', text: 'tell me when the pricing page changes' }, null])
  check('"/watch" is offered when "/" is typed', APP_COMMANDS.some((x) => x.name === 'watch'))

  // No line the window draws here sells a number of agents.
  const all = [
    ...triggers.map((t) => triggerLine(t)),
    outcomeLine(run('handed', undefined)),
    costLine(watch([run('found', 'x', 'm')]), now),
    capsLine(DEFAULT_CAPS),
    ...withRepo.flatMap((r) => [r.name, r.why]),
  ]
  check('no text counts agents', !all.some((s) => /\bagents?\b/i.test(s)), all.filter((s) => /\bagents?\b/i.test(s)).join(' | '))
}
