import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Hub } from '../../src/main/hub'
import { Saver, writeJson, readJson } from '../../src/main/util'
import { IDLE, SAVE_GAP_MS, SAVE_NOW_KINDS } from '../../src/main/session'
import { LaterWrites, WRITE_LATER_MS } from '../../src/main/later'
import { Resources, SETTLED_EVERY_MS, type AgentReading } from '../../src/main/resources'
import type { Chat, Item } from '../../src/shared/types'
import type { Ctx } from './ctx'

// A light engine (Auditor, 4.1): fewer and smaller writes, idle agent programs closed and resumed,
// helper processes started rarely, and nothing that matters lost to a crash. Numbers are fed in; no real processes.
const sha = (t: string | Buffer): string => createHash('sha256').update(t).digest('hex')
const readText = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const valid = (file: string): boolean => {
  try {
    const sum = JSON.parse(fs.readFileSync(`${file}.sum`, 'utf8')) as { cur: string }
    return sum.cur === sha(fs.readFileSync(file))
  } catch {
    return false
  }
}

export default async function checks(c: Ctx): Promise<void> {
  /** Waits for something that changes on disk (c.until re-tests only when the hub says something). */
  const poll = async (what: string, test: () => boolean, ms = 60_000): Promise<void> => {
    const end = Date.now() + ms
    while (!test() && Date.now() < end) await c.pause(20)
    if (!test()) throw new Error(`timed out waiting for: ${what}`)
  }
  const tmp = path.join(os.tmpdir(), `ensemble-auto-load-${process.pid}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  // ── saving a transcript: not more often than the gap, never read back, always valid ──
  {
    const file = path.join(tmp, 'agent.json')
    let items = Array.from({ length: 400 }, (_, i) => ({ id: `i${i}`, text: 'x'.repeat(1000) }))
    const saver = new Saver(file, () => items, SAVE_GAP_MS)
    let writes = 0
    let last = 0
    const seen = (): void => {
      try {
        const m = fs.statSync(file).mtimeMs
        if (m !== last) {
          writes++
          last = m
        }
      } catch {
        /* not there yet */
      }
    }
    // Reads of the live file (as the last-good check used to do on every save) are counted.
    let readBack = 0
    const oRead = fs.readFileSync
    ;(fs as unknown as { readFileSync: unknown }).readFileSync = (p: fs.PathOrFileDescriptor, ...a: unknown[]) => {
      if (p === file) readBack++
      return (oRead as (...x: unknown[]) => unknown)(p, ...a)
    }
    try {
      saver.now()
      await c.pause(200)
      seen()
      // The very first save looks for a file that is not there yet; what is counted is every save after it.
      readBack = 0
      const t0 = Date.now()
      // An agent streaming for 1.5 s: a change every 20 ms.
      while (Date.now() - t0 < 1500) {
        items = [...items, { id: `s${Date.now()}`, text: 'more' }]
        saver.touch()
        await c.pause(20)
        seen()
      }
      c.check(`while an agent writes, its transcript is saved at most once per ${SAVE_GAP_MS / 1000} s (the whole file each time)`, writes <= 2, `${writes} saves in 1.5 s`)
      saver.now()
      await c.pause(300)
      seen()
      const readsDuring = readBack
      c.check('a reply that ends is saved at once, complete and checksummed', valid(file) && (JSON.parse(readText(file)) as unknown[]).length === items.length, `${writes} saves`)
      c.same('a save does not read back and hash the file it wrote itself', readsDuring, 0)
    } finally {
      ;(fs as unknown as { readFileSync: unknown }).readFileSync = oRead
    }
    // A file another program changed since the app's own save is read and checked again, as before.
    fs.writeFileSync(file, '[1,2,3]')
    let again = 0
    const o2 = fs.readFileSync
    ;(fs as unknown as { readFileSync: unknown }).readFileSync = (p: fs.PathOrFileDescriptor, ...a: unknown[]) => {
      if (p === file) again++
      return (o2 as (...x: unknown[]) => unknown)(p, ...a)
    }
    try {
      writeJson(file, [4])
    } finally {
      ;(fs as unknown as { readFileSync: unknown }).readFileSync = o2
    }
    c.check('a file another program changed is read and checked again before it is kept', again > 0 && valid(file) && readText(file) === '[4]', `${again} reads`)
  }

  // ── the saver's three speeds: at once, soon (coalesced), and with the gap ──
  {
    const file = path.join(tmp, 'speeds.json')
    let state: unknown = { v: 0, pad: 'z'.repeat(300_000) }
    const saver = new Saver(file, () => state, SAVE_GAP_MS)
    const has = (v: number): boolean => readText(file).includes(`"v":${v},`)
    saver.now()
    await poll('first save', () => has(0), 3000)
    // At once, also while a save is on its way: the newer state follows straight away, not after the gap.
    state = { v: 1, pad: 'z'.repeat(300_000) }
    saver.now()
    state = { v: 2, pad: 'z'.repeat(300_000) }
    saver.now()
    await poll('the newest state, though a save was in flight', () => has(2), 1500)
    c.check(`a change that must not wait is on disk within a second even when another save was on its way (not after ${SAVE_GAP_MS / 1000} s)`, has(2))
    // Soon: a burst of fifty is a few writes, and the last state is on disk within the window.
    let writes = 0
    let seenAt = 0
    const count = (): void => {
      try {
        const m = fs.statSync(file).mtimeMs
        if (m !== seenAt) {
          writes++
          seenAt = m
        }
      } catch {
        /* not yet */
      }
    }
    count()
    writes = 0
    for (let i = 3; i < 53; i++) {
      state = { v: i, pad: 'z'.repeat(300_000) }
      saver.soon(500)
      await c.pause(10)
      count()
    }
    await poll('the last state of the burst', () => has(52), 3000)
    count()
    c.check('fifty rows arriving in half a second are a few writes (within 500 ms of each other), and the last is on disk', writes <= 3 && has(52), `${writes} writes`)
  }

  // ── the last-good copy and the checksum are right after every write, and a torn write is still found ──
  {
    const file = path.join(tmp, 'steps.json')
    const saver = new Saver(file, () => state, SAVE_GAP_MS)
    let state: unknown = { n: 0 }
    const bad: string[] = []
    let previous = ''
    for (let n = 1; n <= 6; n++) {
      state = { n, pad: 'y'.repeat(500) }
      saver.now()
      await poll(`save ${n}`, () => valid(file) && readText(file).includes(`"n":${n}`), 3000)
      if (!valid(file)) bad.push(`${n}: checksum`)
      if (n > 1 && readText(`${file}.bak`) !== previous) bad.push(`${n}: last-good copy is not the state before`)
      previous = readText(file)
    }
    c.check('after every one of six saves the file matches its checksum and the last-good copy is the state before it', bad.length === 0, bad.join('; '))
    // The live file is cut in half (a torn write): the next read must not return it, and gives the last-good state.
    const whole = readText(file)
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)))
    const back = readJson<{ n?: number }>(file, {})
    c.check('a file cut in half is detected on load and the last-good state is given instead', back.n === 5, JSON.stringify(back).slice(0, 80))
  }

  // ── task lists: a burst of changes is one write, valid on disk, nothing written after delete ──
  {
    const later = new LaterWrites()
    const file = path.join(tmp, 'chat1', 'tasks.json')
    let list: number[] = []
    for (let i = 0; i < 50; i++) {
      list = [...list, i]
      later.put(file, () => list)
    }
    c.same('fifty task changes in a burst wait for one write', [later.written, fs.existsSync(file)], [0, false])
    await c.pause(WRITE_LATER_MS + 200)
    c.check(`and are on disk within ${WRITE_LATER_MS} ms, as one valid, checksummed write`, later.written === 1 && valid(file) && readJson<number[]>(file, []).length === 50, `${later.written} writes`)
    later.put(file, () => [1])
    later.drop(path.join(tmp, 'chat1') + path.sep)
    await c.pause(WRITE_LATER_MS + 100)
    c.same('a deleted chat gets nothing written back', [later.written, readJson<number[]>(file, []).length], [1, 50])
    later.put(file, () => [9])
    later.flush()
    c.same('closing the app writes what is due at once', readJson<number[]>(file, []), [9])
  }

  // ── the resource sampler: a process start at most every few minutes once measured, none while idle ──
  {
    let reads = 0
    const r = new Resources({ file: path.join(tmp, 'res.json'), read: async () => (reads++, [{ pid: 2, ppid: 1, name: 'claude.exe', mb: 300, cpu: 1 }]), appPid: 1, appName: 'Ensemble.exe' })
    const readings: AgentReading[] = Array.from({ length: 4 }, (_, i) => ({ root: 10 + i, provider: 'claude', mb: 300, cpu: 0, procs: 1 }))
    let live = false
    r.start(() => live, 40)
    await c.pause(400)
    c.same('no agent at work: no process is started to measure anything', reads, 0)
    for (let i = 0; i < 4; i++) r.add(readings)
    live = true
    await c.pause(400)
    r.stop()
    c.check(`once measured, a sample (a PowerShell on Windows) comes at most every ${SETTLED_EVERY_MS / 60000} min`, reads <= 1, `${reads} samples in 0.4 s at a 40 ms pace`)
  }

  // ── a crash: the data folder as it is on disk at an instant, opened by a hub that never saw the first one ──
  const dirA = path.join(tmp, 'crash-a')
  const open = async (dir: string): Promise<Hub> => {
    const h = new Hub({ dataDir: dir, version: 'test', demo: true, mica: false, isFocused: () => false, notify: () => {}, emit: () => {} })
    await h.start()
    for (const a of await h.accounts.discover()) if (a.signedIn && !h.accounts.accounts.some((x) => x.provider === a.provider && x.configDir === a.configDir)) h.accounts.add({ name: a.suggestedName, provider: a.provider, configDir: a.configDir })
    await h.accounts.refresh()
    return h
  }
  let n = 0
  /** What a crash right now would leave: the folder copied as it is, without dispose or flush. */
  const crashed = async (): Promise<Hub> => {
    const dir = path.join(tmp, `crash-${++n}`)
    // A file may be swapped in while the folder is copied: that is a crash too, so a copy that trips on it is simply taken again.
    for (let k = 0; ; k++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.cpSync(dirA, dir, { recursive: true })
        break
      } catch (e) {
        if (k >= 4) throw e
      }
    }
    return open(dir)
  }
  const A = await open(dirA)
  try {
    const lead = A.lead()!
    const chat = A.createChat({ cwd: c.work })
    const mine = (h: Hub, who = lead.id): Item[] => h.openChat(chat.id).items[who] || []
    const session = A['session'](chat, lead) as { busy: boolean; state: { queued: number }; runtime: unknown; askPermission(a: unknown): Promise<unknown>; askQuestion(q: unknown, s: AbortSignal): Promise<unknown>; add(i: Item): void }
    const idleNow = (): boolean => !session.busy && !session.state.queued
    await c.pause(700) // the chat itself is on disk (the chat list is saved 400 ms after a change)

    // The person's own messages: on disk at once, also one that waits behind a running reply.
    A.send({ chatId: chat.id, to: lead.id, text: 'First question about this folder', mode: 'quick' })
    A.send({ chatId: chat.id, to: lead.id, text: 'Second one, sent while the first is answered' })
    await c.pause(250)
    let B = await crashed()
    const said = mine(B).filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)
    c.check('the person\'s own messages are on disk within a quarter of a second, also one queued behind a reply', said.includes('First question about this folder') && said.includes('Second one, sent while the first is answered'), JSON.stringify(said))
    await B.dispose()
    await poll('both to be answered', () => mine(A).filter((i) => i.kind === 'turn').length >= 2 && idleNow(), 60_000)

    // A reply's end: written at once.
    const turns = mine(A).filter((i) => i.kind === 'turn').length
    await c.pause(300) // one whole-file write (a save already on its way is followed straight away by the one that holds the end row)
    B = await crashed()
    c.same('a reply that has ended is on disk at once', mine(B).filter((i) => i.kind === 'turn').length, turns)
    await B.dispose()

    // Permission request and answer, question and answer.
    const ask = session.askPermission({ toolName: 'Bash', title: '', input: { command: 'npm test' }, canRemember: false, signal: new AbortController().signal })
    const permRow = (): Item | undefined => mine(A).find((i) => i.kind === 'permission')
    await poll('the permission card', () => !!permRow(), 2000)
    await c.pause(150)
    B = await crashed()
    c.check('a request for permission is on disk at once', mine(B).some((i) => i.kind === 'permission'))
    await B.dispose()
    A.respondPermission((permRow() as { requestId: string }).requestId, 'allow')
    await ask
    await c.pause(150)
    B = await crashed()
    c.same('and so is its answer', (mine(B).find((i) => i.kind === 'permission') as { status?: string } | undefined)?.status, 'allowed')
    await B.dispose()
    const q = session.askQuestion([{ question: 'Which plan?', options: [{ label: 'Team' }, { label: 'Scale' }] }], new AbortController().signal)
    const qRow = (): Item | undefined => mine(A).find((i) => i.kind === 'question')
    await poll('the question card', () => !!qRow(), 2000)
    await c.pause(150)
    B = await crashed()
    c.check('a question to the person is on disk at once', mine(B).some((i) => i.kind === 'question'))
    await B.dispose()
    A.respondQuestion((qRow() as { requestId: string }).requestId, { 'Which plan?': 'Team' })
    await q
    await c.pause(150)
    B = await crashed()
    c.same('and so is the answer', (mine(B).find((i) => i.kind === 'question') as { status?: string } | undefined)?.status, 'answered')
    await B.dispose()

    // A goal's row and a loop's row.
    A.send({ chatId: chat.id, to: lead.id, text: 'Add a pricing page', goal: { doneWhen: 'the tests pass' } })
    await c.pause(250)
    B = await crashed()
    c.check("a goal's first row is on disk at once", mine(B).some((i) => i.kind === 'auto' && (i as { of?: string }).of === 'goal'))
    await B.dispose()
    await poll('the goal to end', () => chat.goal?.status === 'met' || chat.goal?.status === 'stopped', 60_000)
    await poll('the lead to be idle', idleNow, 30_000)
    A.addLoop(chat.id, { prompt: 'Check the deploy', every: 600_000 })
    await c.pause(250)
    B = await crashed()
    c.check("a loop's first row is on disk at once", mine(B).some((i) => i.kind === 'auto' && (i as { of?: string }).of === 'loop'))
    await B.dispose()
    A.send({ chatId: chat.id, to: lead.id, text: '/loop stop' })
    await poll('the lead to be idle', idleNow, 30_000)

    // Task state: within the burst window, never older than it, never a broken file.
    const spawned = A['spawn'](chat, lead, { name: 'Writer', role: 'writes a short note', brief: 'Write a two-line note.' }) as string
    c.check('an agent is started with a task', /joined the chat/.test(spawned), spawned)
    const tasksFile = path.join(dirA, 'chats', chat.id, 'tasks.json')
    await c.pause(WRITE_LATER_MS + 250)
    const handed = readJson<{ id: string; status: string }[]>(tasksFile, [])
    c.check(`a task handed out is on disk within ${WRITE_LATER_MS} ms`, handed.length >= 1 && valid(tasksFile), JSON.stringify(handed.map((t) => `${t.id}:${t.status}`)))
    await poll('the task to be done', () => A.tasksOf(chat.id).every((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'), 60_000)
    await c.pause(WRITE_LATER_MS + 250)
    c.check('and its end state is on disk after the same window', readJson<{ status: string }[]>(tasksFile, []).every((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'))
    // A change and a crash inside the window: the earlier state is what is found, whole and checked.
    const t2 = A['spawn'](chat, lead, { name: 'Writer 2', role: 'writes another note', brief: 'Write one line.' }) as string
    c.check('a second task starts', /joined the chat/.test(t2), t2)
    const before = readJson<{ id: string; status: string }[]>(tasksFile, []).length
    B = await crashed()
    const found = B.tasksOf(chat.id)
    c.check('a crash inside the burst window loses at most that burst: the older tasks are all there, the file whole and checked', found.length >= before && found.length <= before + 1 && valid(path.join(B.dataDir, 'chats', chat.id, 'tasks.json')), `${found.length} found, ${before} before`)
    await B.dispose()
    await poll('the second task to be done', () => A.tasksOf(chat.id).every((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'), 60_000)

    // What a crash in the middle of a reply can lose: streamed text and tool rows after the last save, and nothing else.
    await poll('the lead to be idle', idleNow, 30_000)
    session.add({ id: 'late-tool', kind: 'tool', ts: Date.now(), name: 'Read', status: 'done' } as unknown as Item)
    session.add({ id: 'late-text', kind: 'assistant', ts: Date.now(), text: 'half of a reply that was still being written', streaming: true } as Item)
    await c.pause(100)
    // The person's message arrives (saved at once) while the reply they were waiting on has no end row yet.
    session.add({ id: 'last-user', kind: 'user', ts: Date.now(), text: 'Last question before the crash' } as Item)
    await c.pause(250)
    B = await crashed()
    const after = mine(B)
    c.check('a crash mid-reply: the transcript loads and the person\'s last message is there', after.some((i) => i.kind === 'user' && (i as { text: string }).text === 'Last question before the crash'))
    c.check('and the tool row and half-written text added since the last save are the only things that can be missing', SAVE_NOW_KINDS.has('user') && !SAVE_NOW_KINDS.has('assistant') && !SAVE_NOW_KINDS.has('tool') && !SAVE_NOW_KINDS.has('thinking'))
    c.check('the live file and its checksum agree on disk', valid(path.join(B.dataDir, 'chats', chat.id, `${lead.id}.json`)))
    const reopened = B['session'](chat, lead) as { unfinished: { worked: boolean; inputs: Item[] } | null }
    c.check('and the unanswered message is found after the crash, so the reply can be picked up (shown as cut short)', !!reopened.unfinished && reopened.unfinished.inputs.some((i) => i.id === 'last-user'), JSON.stringify(reopened.unfinished?.inputs.map((i) => i.id)))
    await B.dispose()
    await poll('the last reply', () => idleNow(), 60_000)

    // Closing the app: everything that was waiting is written, including text the 10 s gap was holding.
    session.add({ id: 'held-tool', kind: 'tool', ts: Date.now(), name: 'Grep', status: 'done' } as unknown as Item)
    session.add({ id: 'held-text', kind: 'assistant', ts: Date.now(), text: 'text the gap was still holding back', streaming: false } as Item)
    A['commitTask'](A.tasksOf(chat.id)[0])
  } finally {
    await A.dispose()
  }
  {
    const back = await open(dirA)
    const chatId = [...back.chats.keys()][0]
    const rows = back.openChat(chatId).items[back.lead()!.id] || []
    c.check('closing the app writes what the gap and the task window were holding', rows.some((i) => i.id === 'held-tool') && rows.some((i) => i.id === 'held-text') && valid(path.join(dirA, 'chats', chatId, 'tasks.json')))
    await back.dispose()
  }

  // ── an idle agent's program is closed, and its next turn resumes the same conversation ──
  const was = IDLE.closeMs
  const { hub } = await c.freshHub('load')
  try {
    IDLE.closeMs = 300
    const lead = hub.lead()!
    const chat = hub.createChat({ cwd: c.work })
    const session = hub['session'](chat, lead) as { busy: boolean; state: { queued: number }; runtime: unknown }
    const replies = (): number => (hub.openChat(chat.id).items[lead.id] || []).filter((i) => i.kind === 'turn').length
    const idle = (): boolean => !session.busy && !session.state.queued
    hub.send({ chatId: chat.id, to: lead.id, text: 'What is in this folder?', mode: 'quick' })
    await poll('the first reply', () => replies() >= 1 && idle(), 60_000)
    const id = chat.sessions[lead.id]?.providerSessionId
    c.check('while it has just answered, its program is open', !!session['runtime'])
    await poll('the idle time to pass', () => !session['runtime'], 5_000)
    c.check(`after ${IDLE.closeMs} ms idle (4 min in the app) its program is closed`, !session['runtime'])
    // Two messages arrive while it is closed: both are answered, in the same conversation.
    hub.send({ chatId: chat.id, to: lead.id, text: 'And how many files?', mode: 'quick' })
    hub.send({ chatId: chat.id, to: lead.id, text: 'Thanks', mode: 'quick' })
    await poll('both to be answered', () => replies() >= 3 && idle(), 60_000)
    c.same('messages that arrive while it is closed are all answered, in the same conversation', [replies(), chat.sessions[lead.id]?.providerSessionId], [3, id])
    const users = (hub.openChat(chat.id).items[lead.id] || []).filter((i) => i.kind === 'user').length
    c.same('and none is lost', users, 3)

    // A task handed to a closed agent starts; its owner waiting on it is closed too, and comes back with the report.
    const work2 = hub.createChat({ cwd: c.work })
    const mate = hub['spawn'](work2, lead, { name: 'Closed one', role: 'takes work after a rest', brief: 'Write one line.' }) as string
    c.check('an agent is started', /joined the chat/.test(mate), mate)
    await poll('its first task', () => hub.tasksOf(work2.id).every((t) => t.status === 'done' || t.status === 'failed'), 60_000)
    const agent = (work2.agents || [])[0]
    const aSession = hub['session'](work2, agent) as { runtime: unknown }
    await poll("its program to close while it waits", () => !aSession['runtime'], 5_000)
    c.check("an agent that has finished its task has no program open", !aSession['runtime'])
    // Free agents are re-used by the app's own rule, so hand the work over directly.
    const handed = hub['assign'](work2, lead, { to: 'Closed one', title: 'A second job', brief: 'Write another line.' }) as string
    c.check('a task handed to an agent whose program is closed is accepted', /is with Closed one/.test(handed), handed)
    await poll('the second task to be done', () => hub.tasksOf(work2.id).length >= 2 && hub.tasksOf(work2.id).every((t) => t.status === 'done'), 60_000)
    c.check('and it started and was done, by the same agent, from a closed program', hub.tasksOf(work2.id).every((t) => t.status === 'done' && t.to === agent.id))

    // A teammate's question reaches a closed agent.
    await poll("the agent's program to close again", () => !aSession['runtime'], 5_000)
    const answer = await (hub['toolsFor'](hub['session'](work2, lead)) as { name: string; run: (a: Record<string, unknown>) => Promise<string> }[]).find((t) => t.name === 'ask')!.run({ to: 'Closed one', question: 'Did you write two lines?', depth: 'quick' })
    c.check('a question put to an agent whose program is closed is answered', /<answer from="Closed one">/.test(answer), answer.slice(0, 120))

    // Waiting for the person in the middle of a reply is not idle: the program stays open well past the idle time.
    const leadS = hub['session'](work2, lead) as { runtime: unknown; busy: boolean }
    const pending = (): Item | undefined => (hub.openChat(work2.id).items[lead.id] || []).find((i) => i.kind === 'question' && (i as { status?: string }).status === 'pending')
    hub.send({ chatId: work2.id, to: lead.id, text: 'Add a pricing page', mode: 'plan' })
    await poll('the plan and its question', () => !!pending(), 30_000)
    await c.pause(IDLE.closeMs * 4)
    c.check('an agent waiting for the person to answer is not idle: its program stays open and the reply is not cut', !!leadS.runtime && leadS.busy)
    const qr = pending() as unknown as { requestId: string; questions: { question: string }[] }
    hub.respondQuestion(qr.requestId, { [qr.questions[0].question]: 'Leave it' })
    await poll('the reply to finish after the answer', () => !leadS.busy, 30_000)
    c.check('and it carries on with the answer once it comes', (hub.openChat(work2.id).items[lead.id] || []).some((i) => i.kind === 'assistant' && /Nothing has been started/.test((i as { text: string }).text)))
  } finally {
    IDLE.closeMs = was
    await hub.dispose()
  }

  // ── the Go crazy run, with every program closed 300 ms after its agent goes quiet: nothing is lost, nothing looks stale ──
  {
    const { hub: h } = await c.freshHub('load-crazy')
    try {
      IDLE.closeMs = 300
      const lead = h.lead()!
      const crazy = h.createChat({ cwd: c.work })
      h.setUltra(crazy.id, true)
      h.send({ chatId: crazy.id, to: lead.id, text: '/gocrazy design the landing page' })
      const rows = (): Item[] => h.openChat(crazy.id).items[lead.id] || []
      await poll('the Go crazy run', () => rows().some((i) => i.kind === 'assistant' && /both judging rounds/.test((i as { text: string }).text)) && h.tasksOf(crazy.id).every((t) => t.status !== 'running' && t.status !== 'queued'), 180_000)
      const tasks = h.tasksOf(crazy.id)
      c.check('with idle programs closed after 300 ms, the whole run still finishes, every task done, none closed as stale', tasks.length > 10 && tasks.every((t) => t.status === 'done'), tasks.filter((t) => t.status !== 'done').map((t) => `${t.title}:${t.status}`).join(', '))
      const sweep = h['sweepStale'](crazy) as number
      c.same('and the stale-task sweep finds nothing to close', sweep, 0)
    } finally {
      IDLE.closeMs = was
      await h.dispose()
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}
