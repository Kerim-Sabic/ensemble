import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Hub } from '../../src/main/hub'
import { Resources, agentsIn, capacityLine, MB_RANGE, CORE_RANGE, MIN_MEM_SAMPLES, MIN_READINGS, type AgentReading, type ProcRow } from '../../src/main/resources'
import type { Account, Chat } from '../../src/shared/types'
import type { Ctx } from './ctx'

// Measured resources and team size by useful work (Auditor). Numbers are fed in; no real processes.
const GB = 1024 ** 3
const MB = 1024 ** 2
const readings = (mb: number, n: number, provider: 'claude' | 'chatgpt' = 'claude', cpu = 0): AgentReading[] => Array.from({ length: n }, (_, i) => ({ root: 1000 + i, provider, mb, cpu, procs: 3 }))

export default async function (c: Ctx): Promise<void> {
  const tmp = path.join(os.tmpdir(), 'ensemble-auto-resources')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  // ── the sampler's arithmetic ──
  {
    const rows: ProcRow[] = [
      { pid: 1, ppid: 0, name: 'Ensemble.exe', mb: 300, cpu: 50 },
      { pid: 2, ppid: 1, name: 'Ensemble.exe', mb: 200, cpu: 10 }, // the window
      { pid: 3, ppid: 1, name: 'claude.exe', mb: 500, cpu: 20 },
      { pid: 4, ppid: 3, name: 'node.exe', mb: 80, cpu: 2 }, // a connector server
      { pid: 5, ppid: 4, name: 'conhost.exe', mb: 10, cpu: 0 },
      { pid: 6, ppid: 1, name: 'codex.exe', mb: 70, cpu: 5 },
      { pid: 7, ppid: 1, name: 'git.exe', mb: 15, cpu: 0 }, // the app's own git call
      { pid: 8, ppid: 99, name: 'claude.exe', mb: 900, cpu: 0 }, // someone else's
    ]
    const a = agentsIn(rows, 1, 'Ensemble.exe')
    c.same('the sampler finds each agent with what it started, and only the app\'s', a.map((x) => `${x.provider}:${Math.round(x.mb)}:${x.procs}`).sort(), ['chatgpt:70:1', 'claude:590:3'])
  }

  // ── the estimate: fallback, measured, bounds ──
  {
    const r = new Resources({ file: path.join(tmp, 'a.json') })
    const e = r.estimate()
    c.same('before there are samples: the old fixed figures (400 MB, a sixth of a core)', [e.mb, Math.round(e.core * 1000) / 1000, e.measured], [400, 0.167, false])
    const burst = new Resources({ file: path.join(tmp, 'burst.json') })
    burst.add(readings(90, MIN_READINGS))
    c.same(`${MIN_READINGS} agents read once (say, while they start up) are not yet a measurement: the fixed figure stands`, [burst.estimate().mb, burst.estimate().measured], [400, false])
    for (let i = 1; i < MIN_MEM_SAMPLES; i++) burst.add(readings(90, MIN_READINGS))
    c.same(`after ${MIN_MEM_SAMPLES} separate samples it is`, burst.estimate().measured, true)
    for (let i = 0; i < 4; i++) r.add(readings(560, 4))
    c.same('with measurements: the high figure per agent', [r.estimate().mb, r.estimate().measured], [560, true])
    const low = new Resources({ file: path.join(tmp, 'b.json') })
    for (let i = 0; i < 4; i++) low.add(readings(20, 4))
    const high = new Resources({ file: path.join(tmp, 'c.json') })
    for (let i = 0; i < 4; i++) high.add(readings(9000, 4))
    c.same(`memory per agent stays within ${MB_RANGE[0]} to ${MB_RANGE[1]} MB`, [low.estimate().mb, high.estimate().mb], MB_RANGE)
    // Processor share: two samples a minute apart, 3 agents at work using 18 s of processor time between them.
    let t = 0
    const cpu = new Resources({ file: path.join(tmp, 'd.json'), now: () => t })
    for (let i = 0; i < 8; i++) {
      cpu.add(readings(500, 3, 'claude', i * 6), { claude: 3, chatgpt: 0 })
      t += 60_000
    }
    c.same('the processor share of an agent at work is measured (6 s a minute = 10%)', Math.round(cpu.estimate().core * 100) / 100, 0.1)
    const idle = new Resources({ file: path.join(tmp, 'e.json'), now: () => t })
    for (let i = 0; i < 8; i++) {
      idle.add(readings(500, 3, 'claude', i * 0.001), { claude: 3, chatgpt: 0 })
      t += 60_000
    }
    c.same(`and it stays within ${CORE_RANGE[0]} to ${CORE_RANGE[1]} of a core`, idle.estimate().core, CORE_RANGE[0])
    c.check('the line the user sees, measured', /^This computer can carry about 14 more agents now \(about 560 MB and \d+% of a core each, measured\)\.$/.test(capacityLine(14, { ...r.estimate(), core: 0.05, coreMeasured: true })), capacityLine(14, r.estimate()))
    c.check('and before there are measurements', capacityLine(1, new Resources({ file: path.join(tmp, 'f.json') }).estimate()) === 'This computer can carry about 1 more agent now (about 400 MB each, estimated until there are measurements).')
  }

  // ── the cap follows what was measured, and survives a restart ──
  const { hub, dataDir } = await c.freshHub('resources')
  try {
    const chat = hub.createChat({ cwd: c.work })
    hub.setUltra(chat.id, true)
    hub['markUltra'](chat, 'gocrazy')
    // 8 GB in all, so a 2 GB reserve; 2 GB + 6000 MB free leaves 6000 MB for agents.
    hub.machine = { free: () => 2 * GB + 6000 * MB, total: () => 8 * GB, cores: () => 64 }
    const live = (chat.agents || []).filter((a) => !a.spawned?.gone).length
    c.same('with no samples, the room is 6000 MB at 400 MB each', hub.memoryCap(chat) - live, 15)
    for (let i = 0; i < 4; i++) hub.resources.add(readings(600, 4))
    c.same('measured at 600 MB each, the room shrinks to 10', hub.memoryCap(chat) - live, 10)
    const lighter = new Resources({ file: path.join(tmp, 'g.json') })
    for (let i = 0; i < 4; i++) lighter.add(readings(250, 4))
    const kept = hub.resources
    ;(hub as unknown as { resources: Resources }).resources = lighter
    c.same('measured at 250 MB each, it grows to 24', hub.memoryCap(chat) - live, 24)
    ;(hub as unknown as { resources: Resources }).resources = kept
    hub.machine = { free: () => 512 * GB, total: () => 1024 * GB, cores: () => 4 }
    c.same('with plenty of memory the processor decides: 4 cores at a sixth each', hub.machineCap(chat), 24)
    // The cores are shared: agents live in another chat take their part first.
    const other = hub.createChat({ cwd: c.work })
    other.agents = Array.from({ length: 6 }, (_, i) => ({ id: `elsewhere-${i}`, name: `Elsewhere ${i}`, provider: 'claude', configDir: null, enabled: true, accent: 'blue', createdAt: 1, spawned: { chatId: other.id, base: c.leadId, by: c.leadId, depth: 1, at: 1 } }) as unknown as Account)
    c.same('six agents live in another chat leave this one 18 of the 24', hub.machineCap(chat), 18)
    other.agents = []
    const cap = hub.capacity()
    c.check('the capacity the window gets: the number and the plain line', cap.more >= 0 && /^This computer can carry about \d+ more agents? now \(about 600 MB/.test(cap.text) && hub.bootstrap().capacity?.text === cap.text, cap.text)
    const roster = hub['rosterText'](chat, hub.accounts.get(c.leadId)!) as string
    c.check('the lead is told the cap and why, in plain words', /Going crazy, the limit is what this computer can carry right now: about 600 MB per agent \(measured\)/.test(roster) && /only together with a task that can start now/.test(roster), (/You can start[^\n]*/.exec(roster) || [''])[0])
    hub.resources.flush()
  } finally {
    await hub.dispose()
  }
  {
    const again = new Hub({ dataDir, version: 'test', demo: true, mica: false, isFocused: () => false, notify: () => {}, emit: () => {} })
    const e = again.resources.estimate()
    c.same('what was measured survives a restart (resources.json)', [e.mb, e.measured, fs.existsSync(path.join(dataDir, 'resources.json'))], [600, true, true])
    await again.dispose()
  }

  // ── team size by useful work ──
  const { hub: h } = await c.freshHub('useful-work')
  try {
    const lead = h.accounts.get(h.lead()!.id)!
    const leadId = lead.id
    const chat = h.createChat({ cwd: c.work })
    const spawnTool = (): ((a: Record<string, unknown>) => Promise<string>) => (h['toolsFor'](h['session'](chat, lead)) as { name: string; run: (a: Record<string, unknown>) => Promise<string> }[]).find((t) => t.name === 'spawn_agent')!.run
    const noTask = await spawnTool()({ name: 'Idle one', role: 'nothing yet' })
    c.check('an agent may be started first and handed its work next, as leads are told', /joined the chat/.test(noTask) && /assign_task/.test(noTask), noTask)
    const waiting = await spawnTool()({ name: 'Helper', role: 'looks something up', brief: 'Look up the pricing of three competitors and report.' })
    c.check('until it has work it counts as free, so the next one waits', /^Not started: Idle one is free/.test(waiting) && !(chat.agents || []).some((a) => a.name === 'Helper'), waiting)
    const idleOne = (chat.agents || []).find((a) => a.name === 'Idle one') as Account
    await h.removeAgent(chat.id, idleOne.id)
    const first = await spawnTool()({ name: 'Helper', role: 'looks something up', brief: 'Look up the pricing of three competitors and report.' })
    c.check('with a task it starts', /joined the chat/.test(first), first)
    const helper = (chat.agents || []).find((a) => a.name === 'Helper') as Account
    const idleH = (): boolean => {
      const st = h.openChat(chat.id).states.find((x) => x.accountId === helper.id)
      return !!st && st.phase === 'idle' && !st.queued && h.tasksOf(chat.id).every((t) => t.status !== 'running' && t.status !== 'queued')
    }
    const until = async (test: () => boolean, ms = 60_000): Promise<void> => {
      const end = Date.now() + ms
      while (!test() && Date.now() < end) await c.pause(100)
    }
    await until(idleH)
    const refused = await spawnTool()({ name: 'Second', role: 'looks up more', brief: 'Look up two more competitors.' })
    c.check('free agents first: the refusal names them and says what to do', /^Not started: Helper is free and can take this work\. Hand it to them with assign_task, or send them home with dismiss_agent and then start the new one\. Free now: Helper\.$/.test(refused) && !(chat.agents || []).some((a) => a.name === 'Second'), refused)
    await h.removeAgent(chat.id, helper.id)
    const after = await spawnTool()({ name: 'Second', role: 'looks up more', brief: 'Look up two more competitors.' })
    c.check('once the free one went home, the new one starts', /joined the chat/.test(after), after)
    await until(() => h.tasksOf(chat.id).every((t) => t.status !== 'running' && t.status !== 'queued'))
    for (const a of chat.agents || []) if (!a.spawned?.gone) await h.removeAgent(chat.id, a.id)

    // Agents lined up behind work that is still running may not run far ahead of it.
    const lined = h.createChat({ cwd: c.work })
    h.setUltra(lined.id, true)
    h['spawn'](lined, lead, { name: 'Blocker', role: 'works a while', brief: 'A long piece of work.' })
    const t1 = h.tasksOf(lined.id)[0]?.id
    for (let i = 1; i <= 9; i++) h['spawn'](lined, lead, { name: `Waiter ${i}`, role: 'waits', brief: 'Check the long piece of work.', after: [t1] })
    const tool = (h['toolsFor'](h['session'](lined, lead)) as { name: string; run: (a: Record<string, unknown>) => Promise<string> }[]).find((t) => t.name === 'spawn_agent')!.run
    const ahead = await tool({ name: 'Waiter 10', role: 'waits', brief: 'Check it too.', after: [t1] })
    c.check('no more agents lined up behind unfinished work than 8 or twice what can run now', /^Not started: 9 agents are already lined up waiting/.test(ahead) && /against 1 task that can run now/.test(ahead), ahead)
    const now = await tool({ name: 'Runner', role: 'works now', brief: 'Independent work that can start now.' })
    c.check('work that can start now is still let through', /joined the chat/.test(now), now)
    await h.stop(lined.id)
    void leadId

    // The scripted Go crazy run still finishes with its regions under these rules.
    const crazy = h.createChat({ cwd: c.work })
    h.setUltra(crazy.id, true)
    h.send({ chatId: crazy.id, to: lead.id, text: '/gocrazy design the landing page' })
    const rowsOf = (x: Chat) => h.openChat(x.id).items[lead.id] || []
    await until(() => rowsOf(crazy).some((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text)) && h.tasksOf(crazy.id).every((t) => t.status !== 'running' && t.status !== 'queued'), 150_000)
    const tasks = h.tasksOf(crazy.id)
    // A region is led by a teammate or by an agent the lead started; either way it runs a team of its own.
    const regions = [...new Set(tasks.filter((t) => /^Region:/.test(t.title)).map((t) => t.to))].filter((id) => (crazy.agents || []).some((x) => x.spawned?.by === id))
    c.check('the Go crazy demo still finishes with its regions, every task done', rowsOf(crazy).some((i) => i.kind === 'assistant' && /both judging rounds/.test(i.text)) && regions.length >= 3 && tasks.length > 0 && tasks.every((t) => t.status === 'done'), `${regions.length} regions; ${tasks.filter((t) => t.status !== 'done').map((t) => `${t.title}:${t.status}`).join(', ')}`)
    c.check('task durations are recorded by kind (a record only: no cap or decision reads them)', !!h.resources.taskTime(tasks[0].kind || 'other'))
  } finally {
    await h.dispose()
  }
}
