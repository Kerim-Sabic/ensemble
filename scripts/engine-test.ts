// Dev-only: drives the real hub with real accounts from a terminal, no window.
//   node out/test/engine-test.mjs <scenario>
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Hub } from '../src/main/hub'
import { findHands, WindowsDesktop } from '../src/main/hands/desktop'
import type { HubEvent } from '../src/shared/types'
import { adviseModel, budgetLine, budgetOf, spendScore } from '../src/shared/budget'
import { scanClaudeCode } from '../src/main/importer'

const scenario = process.argv[2] || 'status'
const dataDir = path.join(os.tmpdir(), 'ensemble-engine-test')
if (process.argv.includes('--fresh')) fs.rmSync(dataDir, { recursive: true, force: true })
const work = path.join(os.tmpdir(), 'ensemble-engine-work')
fs.mkdirSync(work, { recursive: true })

const t0 = Date.now()
const log = (...a: unknown[]): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
const redact = (s?: string): string | undefined => (s ? s.replace(/[\w.+-]+@[\w.-]+/g, '<email>') : s)

const waiters: { test: (ev: HubEvent) => boolean; resolve: () => void }[] = []
const until = (test: (ev: HubEvent) => boolean, ms = 240000): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting')), ms)
    waiters.push({ test, resolve: () => (clearTimeout(t), resolve()) })
  })

const hub = new Hub({
  dataDir,
  version: 'test',
  demo: false,
  mica: false,
  isFocused: () => true,
  // Only the scenario that is about the computer gets to touch it.
  hands: scenario === 'computer' || scenario === 'hands' ? { desktop: new WindowsDesktop(findHands()) } : undefined,
  notify: (title, body) => log('NOTIFY', title, '|', body.slice(0, 80)),
  emit: (ev) => {
    switch (ev.type) {
      case 'account-status':
        log('status', ev.status.accountId, ev.status.state, redact(ev.status.email) ? '(email ok)' : '', ev.status.plan || '', ev.status.models ? `${ev.status.models.length} models` : '', ev.status.error || '')
        break
      case 'account-usage':
        log('usage', ev.usage.accountId, `session ${Math.round((ev.usage.session?.utilization ?? 0) * 100)}%`, `week ${Math.round((ev.usage.weekly?.utilization ?? 0) * 100)}%`)
        break
      case 'agent':
        log('agent', ev.state.accountId, ev.state.phase, ev.state.activity || '', ev.state.queued ? `q=${ev.state.queued}` : '', ev.state.model || '')
        break
      case 'item':
        if (ev.item.kind === 'assistant' || ev.item.kind === 'thinking') break
        log('item', ev.accountId, ev.item.kind, JSON.stringify(ev.item).slice(0, 260))
        break
      case 'item-patch':
        if ('text' in ev.patch && ev.patch.streaming === false) log('text', ev.accountId, JSON.stringify(String(ev.patch.text).slice(0, 300)))
        else if (ev.patch.status) log('patch', ev.accountId, ev.id, JSON.stringify(ev.patch).slice(0, 200))
        break
      case 'task':
        log('TASK', ev.task.id, ev.task.status, `${ev.task.from}→${ev.task.to}`, ev.task.title, ev.task.result ? `| ${ev.task.result.slice(0, 120)}` : '')
        break
      case 'chat':
        log('chat', ev.chat.title)
        break
      case 'item-delta':
      case 'screen':
        break
      default:
        log(ev.type)
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].test(ev)) waiters.splice(i, 1)[0].resolve()
    }
  },
})

const idle = (accountId: string): Promise<void> => until((ev) => ev.type === 'agent' && ev.state.accountId === accountId && (ev.state.phase === 'idle' || ev.state.phase === 'error') && ev.state.queued === 0)

async function ensureAccounts(): Promise<void> {
  if (hub.accounts.accounts.length) return
  const found = await hub.accounts.discover()
  log('discovered', found.map((c) => `${c.provider}:${c.suggestedName}:${c.signedIn ? 'in' : 'out'}`).join(', '))
  for (const c of found) if (c.signedIn) hub.accounts.add({ name: c.suggestedName, provider: c.provider, configDir: c.configDir })
}

await hub.start()
await ensureAccounts()
await hub.accounts.refresh()
log('accounts', hub.accounts.accounts.map((a) => `${a.id}(${a.provider})`).join(', '), 'lead=', hub.lead()?.id)

try {
  if (scenario === 'team') {
    // Lead on a cheap model hands one small task to a teammate.
    const leadId = process.argv[3] || 'hello'
    const memberId = process.argv[4] || 'claude-3'
    hub.updateSettings({ leadId, smartTitles: true })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const member = hub.accounts.get(memberId)
    const chat = hub.createChat({ cwd: work })
    hub.send({
      chatId: chat.id,
      to: leadId,
      text: `This is a quick end-to-end check of the team tools. Hand ${member?.name} a task: create a file named note.txt in the working folder containing exactly the word "ensemble", then report back. When their report arrives, read note.txt yourself to confirm, and tell me the result in one sentence.`,
    })
    await until((ev) => ev.type === 'task' && ev.task.status === 'done', 300000)
    await idle(leadId)
    await new Promise((r) => setTimeout(r, 1500))
    log('note.txt exists:', fs.existsSync(path.join(work, 'note.txt')), fs.existsSync(path.join(work, 'note.txt')) ? JSON.stringify(fs.readFileSync(path.join(work, 'note.txt'), 'utf8')) : '')
    log('chat title:', hub.chats.get(chat.id)?.title)
    log('provider sessions:', JSON.stringify(hub.chats.get(chat.id)?.sessions))
  } else if (scenario === 'image') {
    // A Claude lead asks the ChatGPT teammate for a picture.
    const leadId = process.argv[3] || 'hello'
    const gpt = hub.accounts.accounts.find((a) => a.provider === 'chatgpt')
    if (!gpt) throw new Error('no chatgpt account')
    hub.updateSettings({ leadId })
    hub.updateAccount(leadId, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: `Hand ${gpt.name} one task: generate a simple flat illustration of a blue circle on a white background and save it as circle.png in the working folder. When the report comes back, tell me the path in one sentence.` })
    await until((ev) => ev.type === 'task' && (ev.task.status === 'done' || ev.task.status === 'failed'), 400000)
    await idle(leadId)
    await new Promise((r) => setTimeout(r, 1000))
    log('circle.png exists:', fs.existsSync(path.join(work, 'circle.png')))
  } else if (scenario === 'stop') {
    // Interrupt a teammate in the middle of a long command.
    const id = process.argv[3] || 'hello'
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: id, text: 'Run this exact PowerShell command and then tell me what it printed: Start-Sleep -Seconds 40; "finished"' })
    await until((ev) => ev.type === 'agent' && ev.state.accountId === id && ev.state.phase === 'tool', 60000)
    await new Promise((r) => setTimeout(r, 2500))
    log('>>> stopping')
    const t = Date.now()
    await hub.stop(chat.id, id)
    await idle(id)
    log('>>> idle again after', Date.now() - t, 'ms')
    hub.send({ chatId: chat.id, to: id, text: 'Reply with exactly: STILL HERE' })
    await until((ev) => ev.type === 'item' && ev.item.kind === 'turn' && ev.accountId === id, 60000)
  } else if (scenario === 'question') {
    // A teammate asks the person a multiple-choice question; we answer it.
    const id = process.argv[3] || 'hello'
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    waiters.push({
      test: (ev) => ev.type === 'item' && ev.item.kind === 'question',
      resolve: () => {
        const snap = hub.openChat(chat.id)
        const q = snap.items[id].find((i) => i.kind === 'question')
        if (q?.kind !== 'question') return
        log('>>> question:', JSON.stringify(q.questions).slice(0, 300))
        setTimeout(() => hub.respondQuestion(q.requestId, { [q.questions[0].question]: q.questions[0].options[1].label }), 800)
      },
    })
    hub.send({ chatId: chat.id, to: id, text: 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee (two options, tea first). After I answer, reply with exactly: YOU CHOSE <my answer>.' })
    await idle(id)
  } else if (scenario === 'resume') {
    // After a restart, the newest chat should still know what was said in it.
    const chat = [...hub.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).find((c) => Object.keys(c.sessions).length)
    if (!chat) throw new Error('no earlier chat to resume')
    const id = process.argv[3] || Object.keys(chat.sessions)[0]
    log('resuming', chat.title, 'as', id, JSON.stringify(chat.sessions[id]))
    hub.openChat(chat.id)
    hub.send({ chatId: chat.id, to: id, text: 'Without using any tools: in one short sentence, what was the very first thing I asked you in this conversation?' })
    await idle(id)
  } else if (scenario === 'undo') {
    // A reply that creates a file can be undone; context and token counts are reported.
    const id = process.argv[3] || 'hello'
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    hub.updateChat(chat.id, { permission: 'edits' })
    const file = path.join(work, 'undo-me.txt')
    fs.rmSync(file, { force: true })
    hub.send({ chatId: chat.id, to: id, text: 'Create a file named undo-me.txt in the working folder containing exactly the word "alpha" using the Write tool, then reply with exactly: DONE' })
    await idle(id)
    await new Promise((r) => setTimeout(r, 1500))
    const turn = hub.openChat(chat.id).items[id].filter((i) => i.kind === 'turn').pop()
    log('turn row:', JSON.stringify(turn))
    log('file exists before undo:', fs.existsSync(file))
    log('context:', JSON.stringify(hub.openChat(chat.id).states.find((s) => s.accountId === id)?.context))
    if (turn) {
      const preview = await hub.rewind(chat.id, id, turn.id, false)
      log('preview:', JSON.stringify(preview))
      const done = await hub.rewind(chat.id, id, turn.id, true)
      log('applied:', JSON.stringify(done))
      log('file exists after undo:', fs.existsSync(file))
    }
  } else if (scenario === 'commands') {
    // Which typed commands an account reports, and whether one runs.
    const id = process.argv[3] || 'hello'
    log('commands:', (hub.accounts.statuses.get(id)?.commands || []).map((c) => c.name).join(', '))
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: id, text: process.argv[4] || '/context' })
    await idle(id)
    await new Promise((r) => setTimeout(r, 1500))
    log('context:', JSON.stringify(hub.openChat(chat.id).states.find((s) => s.accountId === id)?.context))
  } else if (scenario === 'handoff') {
    // A second teammate takes over as lead and knows what was said before.
    const first = process.argv[3] || 'hello'
    const second = process.argv[4] || 'claude-3'
    hub.updateSettings({ leadId: first })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: first, text: 'For this conversation, the code word is PINEAPPLE-42. Reply with exactly: NOTED' })
    await idle(first)
    await hub.setChatLead(chat.id, second)
    log('lead is now', hub.lead(hub.chats.get(chat.id))?.id, 'handoff pending:', JSON.stringify(hub.chats.get(chat.id)?.handoff))
    hub.send({ chatId: chat.id, to: second, text: 'Without using any tools: what is the code word, and are you the lead of this chat? One sentence.' })
    await idle(second)
    await new Promise((r) => setTimeout(r, 2500))
    log('suggestion:', JSON.stringify(hub.openChat(chat.id).states.find((s) => s.accountId === second)?.suggestion))
  } else if (scenario === 'auto') {
    // The lead lets the app choose who gets a task.
    const leadId = process.argv[3] || 'hello'
    hub.updateSettings({ leadId })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: leadId, text: 'This is a quick check of task routing. Call assign_task with to set to "auto", title "Say hi", and a brief asking the teammate to reply with exactly the word HI and nothing else. When the report arrives, tell me who did it in one sentence.' })
    await until((ev) => ev.type === 'task' && (ev.task.status === 'done' || ev.task.status === 'failed'), 300000)
    await idle(leadId)
    await new Promise((r) => setTimeout(r, 1500))
  } else if (scenario === 'parallel') {
    // Two teammates on different providers work at the same time; the lead checks both.
    const leadId = process.argv[3] || 'hello'
    const gpt = hub.accounts.accounts.find((a) => a.provider === 'chatgpt')
    hub.updateSettings({ leadId })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    for (const f of ['left.txt', 'right.txt']) fs.rmSync(path.join(work, f), { force: true })
    const chat = hub.createChat({ cwd: work })
    hub.updateChat(chat.id, { permission: 'auto' })
    hub.send({
      chatId: chat.id,
      to: leadId,
      text: `Quick check of parallel work. Hand out two tasks at the same time: Claude 3 creates left.txt containing exactly "L", and ${gpt?.name || 'another teammate'} creates right.txt containing exactly "R", both in the working folder. When both have reported, read the two files yourself and tell me their contents in one sentence.`,
    })
    let done = 0
    await until((ev) => ev.type === 'task' && (ev.task.status === 'done' || ev.task.status === 'failed') && ++done >= 2, 400000)
    await idle(leadId)
    await new Promise((r) => setTimeout(r, 2500))
    for (const f of ['left.txt', 'right.txt']) log(f, fs.existsSync(path.join(work, f)) ? JSON.stringify(fs.readFileSync(path.join(work, f), 'utf8')) : 'missing')
    const tasks = hub.tasksOf(chat.id)
    log('tasks:', tasks.map((t) => `${t.id} ${t.to} ${t.status} started+${((t.startedAt || 0) - tasks[0].createdAt) / 1000}s took ${(((t.finishedAt || 0) - (t.startedAt || 0)) / 1000).toFixed(1)}s`).join(' | '))
  } else if (scenario === 'suggest') {
    // After the second reply the lead offers a likely next message.
    const id = process.argv[3] || 'hello'
    hub.updateSettings({ leadId: id, suggestions: true })
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: id, text: 'Without using tools: name three fruits, one per line.' })
    await idle(id)
    hub.send({ chatId: chat.id, to: id, text: 'Now sort them alphabetically.' })
    await idle(id)
    await until((ev) => ev.type === 'agent' && ev.state.accountId === id && !!ev.state.suggestion, 20000).catch(() => log('no suggestion arrived within 20s'))
    log('suggestion:', JSON.stringify(hub.openChat(chat.id).states.find((s) => s.accountId === id)?.suggestion))
  } else if (scenario === 'changes') {
    const chat = hub.createChat({ cwd: process.argv[3] || process.cwd() })
    const c = await hub.folderChanges(chat.id)
    log('changes:', JSON.stringify({ repo: c.repo, branch: c.branch, count: c.files.length, first: c.files.slice(0, 5) }))
    if (c.files[0]) log('diff head:', JSON.stringify((await hub.fileDiff(chat.id, c.files[0].path)).slice(0, 300)))
    await hub.deleteChat(chat.id)
  } else if (scenario === 'vault') {
    // Read-only: is the vault found, and do search and reading work on it?
    log('vault:', JSON.stringify(hub.vaultInfo()))
    for (const q of process.argv.slice(3).length ? process.argv.slice(3) : ['pricing', 'decision discipline']) {
      const t = Date.now()
      const hits = hub.vaultSearch(q)
      log(`search "${q}": ${hits.length} hits in ${Date.now() - t} ms`)
      for (const h of hits.slice(0, 5)) log('  ', h.path, '|', h.type || '-', '|', h.snippet.slice(0, 70).replace(/\s+/g, ' '))
      if (hits[0]) {
        const n = hub.vaultRead(hits[0].path)
        log('   read:', n?.path, `${n?.content.length} chars, links ${n?.links.length}, backlinks ${n?.backlinks.length}`)
      }
    }
  } else if (scenario === 'usage') {
    // Allowance, plan and model menu for every account. Spends nothing.
    for (const a of hub.accounts.accounts) {
      const st = hub.accounts.statuses.get(a.id)
      const u = hub.accounts.usage.get(a.id)
      log(a.id, a.provider, st?.state, st?.plan || '', `session ${u?.session ? Math.round((1 - u.session.utilization) * 100) + '% left' : 'n/a'}`, `week ${u?.weekly ? Math.round((1 - u.weekly.utilization) * 100) + '% left' : 'n/a'}`, `models: ${(st?.models || []).map((m) => m.value || 'default').join(', ')}`)
    }
  } else if (scenario === 'briefing') {
    // What the lead and a teammate are told. Spends nothing.
    const leadId = process.argv[3] || 'main'
    hub.updateSettings({ leadId })
    const chat = hub.createChat({ cwd: process.argv[4] || work })
    const lead = hub.briefingFor(chat.id, leadId)
    const member = hub.briefingFor(chat.id, hub.accounts.accounts.find((a) => a.id !== leadId && a.provider === 'claude')?.id || leadId)
    const gpt = hub.accounts.accounts.find((a) => a.provider === 'chatgpt')
    console.log('\n===== LEAD =====\n' + lead)
    console.log('\n===== MEMBER =====\n' + member.split('## How to work')[1])
    if (gpt) console.log('\n===== CHATGPT MEMBER (vault part) =====\n' + (hub.briefingFor(chat.id, gpt.id).split('## The knowledge vault')[1] || '').split('\n## ')[0])
    log('lead briefing:', lead.length, 'chars, about', Math.round(lead.length / 4), 'tokens; member:', member.length, 'chars')
    await hub.deleteChat(chat.id)
  } else if (scenario === 'effort') {
    // The lead asks for a specific model and effort for one task; the teammate must actually run on it.
    const leadId = process.argv[3] || 'hello'
    const memberId = process.argv[4] || 'claude-3'
    hub.updateSettings({ leadId })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const chat = hub.createChat({ cwd: work })
    const member = hub.accounts.get(memberId)
    hub.send({ chatId: chat.id, to: leadId, text: `Quick check of per-task settings. Call assign_task once: to "${member?.name}", title "Say which model", model "sonnet", effort "low", and a brief asking them to reply with exactly the word READY. When the report arrives, tell me in one sentence what it said.` })
    await until((ev) => ev.type === 'task' && (ev.task.status === 'done' || ev.task.status === 'failed'), 300000)
    await idle(leadId)
    const t = hub.tasksOf(chat.id)[0]
    log('task asked for:', t?.modelLabel, t?.effort, '| teammate ran on:', hub.openChat(chat.id).states.find((x) => x.accountId === memberId)?.model)
  } else if (scenario === 'ask') {
    // One teammate asks another a question and gets the answer back inside the same turn.
    const leadId = process.argv[3] || 'hello'
    const memberId = process.argv[4] || 'claude-3'
    hub.updateSettings({ leadId, vaultPath: null })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const member = hub.accounts.get(memberId)
    const chat = hub.createChat({ cwd: work })
    const t = Date.now()
    hub.send({ chatId: chat.id, to: leadId, text: `Quick check of the ask tool. Use ask to put this question to ${member?.name}: "What is 17 + 25? Reply with the number only." Then tell me, in one sentence, exactly what they answered.` })
    await idle(leadId)
    const ask = hub.openChat(chat.id).items[leadId].find((i) => i.kind === 'ask')
    log('ask card:', JSON.stringify(ask && ask.kind === 'ask' ? { to: ask.to, status: ask.status, answer: ask.answer, ms: ask.durationMs } : null), '| whole exchange took', Date.now() - t, 'ms')
    log('what the teammate saw:', hub.openChat(chat.id).items[memberId].filter((i) => i.kind === 'peer').map((i) => (i.kind === 'peer' ? i.tag : '')).join(', '))
  } else if (scenario === 'chain') {
    // A task lined up behind another starts by itself and is handed the first one's report.
    const leadId = process.argv[3] || 'hello'
    const memberId = process.argv[4] || 'claude-3'
    hub.updateSettings({ leadId, vaultPath: null })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const member = hub.accounts.get(memberId)
    for (const f of ['first.txt', 'second.txt']) fs.rmSync(path.join(work, f), { force: true })
    const chat = hub.createChat({ cwd: work })
    hub.updateChat(chat.id, { permission: 'auto' })
    hub.send({
      chatId: chat.id,
      to: leadId,
      text: `Quick check of lining tasks up. In this one turn, call assign_task twice, both to ${member?.name}. First: title "Pick a number", brief: create first.txt in the working folder containing one number between 100 and 999 of your choosing, and report which number you chose. Second: title "Double it", with after set to the first task's id, brief: the earlier task's report says which number was chosen; without reading any file, create second.txt containing exactly double that number, and report both numbers. When both have reported, read the two files yourself and tell me the two numbers in one sentence.`,
    })
    let done = 0
    await until((ev) => ev.type === 'task' && (ev.task.status === 'done' || ev.task.status === 'failed' || ev.task.status === 'cancelled') && ++done >= 2, 400000)
    await idle(leadId)
    await new Promise((r) => setTimeout(r, 1500))
    const tasks = hub.tasksOf(chat.id)
    log('tasks:', tasks.map((x) => `${x.id} ${x.status}${x.after ? ` after ${x.after.join('+')}` : ''} started+${(((x.startedAt || 0) - tasks[0].createdAt) / 1000).toFixed(1)}s finished+${(((x.finishedAt || 0) - tasks[0].createdAt) / 1000).toFixed(1)}s`).join(' | '))
    const read = (f: string): string => (fs.existsSync(path.join(work, f)) ? fs.readFileSync(path.join(work, f), 'utf8').trim() : 'missing')
    log('first.txt:', read('first.txt'), '| second.txt:', read('second.txt'), '| doubled correctly:', Number(read('second.txt')) === 2 * Number(read('first.txt')))
    log('second task waited for the first:', (tasks[1]?.startedAt || 0) >= (tasks[0]?.finishedAt || Infinity))
  } else if (scenario === 'vaultwrite') {
    // Writing to a vault, tried on a throwaway one so no real notes are touched:
    // first the tool on its own, then a real teammate asked to record a decision.
    const id = process.argv[3] || 'hello'
    const root = path.join(os.tmpdir(), 'ensemble-test-vault')
    fs.rmSync(root, { recursive: true, force: true })
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    put('AGENTS.md', '# Rules for agents\n\n- Decisions go in `Decisions/`, one note each, named `YYYY-MM-DD Title.md`.\n- Every note starts with properties: `type`, `status`, `created`, `updated` (YYYY-MM-DD).\n- Link notes by full path with an alias: `[[Projects/Cache|Cache]]`.\n- After adding a note, link it from `Decisions/Decisions.md` and add one dated line to `log.md`.\n- A decision is `proposed` until the user accepts it.\n')
    put('Decisions/Decisions.md', '---\ntype: index\nstatus: active\ncreated: 2026-11-01\nupdated: 2026-11-01\n---\n\n# Decisions\n\n## List\n')
    put('Projects/Cache.md', '---\ntype: project\nstatus: active\ncreated: 2026-11-01\nupdated: 2026-11-01\n---\n\n# Cache\n\nA local cache for the app.\n\n## Decisions\n\n## Open questions\n- Which store?\n')
    put('log.md', '# Log\n\n- 2026-11-01 Vault created.\n')
    put('.obsidian/app.json', '{}')
    hub.updateSettings({ leadId: id, vaultPath: root, vaultNotes: 'ask' })
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    const account = hub.accounts.get(id)
    const session = (hub as unknown as { session(c: typeof chat, a: typeof account): unknown; toolsFor(s: unknown): { name: string; run(a: Record<string, unknown>): Promise<unknown> }[] }).session(chat, account)
    const save = (hub as unknown as { toolsFor(s: unknown): { name: string; run(a: Record<string, unknown>): Promise<unknown> }[] }).toolsFor(session).find((t) => t.name === 'vault_save')
    if (!save) throw new Error('vault_save was not offered')
    const tryIt = async (label: string, a: Record<string, unknown>): Promise<void> => log(`  ${label}:`, await save.run(a).then((r) => String(typeof r === 'string' ? r : (r as { text: string }).text).slice(0, 110), (e: Error) => `REFUSED: ${e.message.slice(0, 110)}`))
    await tryIt('create', { path: 'Knowledge/Test note', mode: 'create', content: '---\ntype: concept\nupdated: 2026-01-01\n---\n\n# Test note\n\nFirst line.' })
    await tryIt('create again', { path: 'Knowledge/Test note.md', mode: 'create', content: 'x' })
    await tryIt('append', { path: 'Knowledge/Test note.md', mode: 'append', content: 'Appended line.' })
    await tryIt('section (existing heading)', { path: 'Projects/Cache.md', mode: 'section', heading: 'Decisions', content: '- A test entry.' })
    await tryIt('section (new heading)', { path: 'Projects/Cache.md', mode: 'section', heading: 'How to run', content: 'Run it.' })
    await tryIt('settings folder', { path: '.obsidian/app.md', mode: 'create', content: 'x' })
    await tryIt('outside the vault', { path: '../escape.md', mode: 'create', content: 'x' })
    await tryIt('absolute outside', { path: path.join(os.tmpdir(), 'escape.md'), mode: 'create', content: 'x' })
    const note = fs.readFileSync(path.join(root, 'Knowledge/Test note.md'), 'utf8')
    const proj = fs.readFileSync(path.join(root, 'Projects/Cache.md'), 'utf8')
    log('  date bumped on append:', /updated: 20\d\d-\d\d-\d\d/.test(note) && !note.includes('updated: 2026-01-01'), '| appended at end:', note.trimEnd().endsWith('Appended line.'))
    log('  section entry sits under Decisions and before Open questions:', proj.indexOf('- A test entry.') > proj.indexOf('## Decisions') && proj.indexOf('- A test entry.') < proj.indexOf('## Open questions'), '| new heading added:', proj.includes('## How to run'))
    log('  nothing escaped:', !fs.existsSync(path.join(os.tmpdir(), 'escape.md')) && !fs.existsSync(path.join(root, '..', 'escape.md')))
    fs.rmSync(path.join(root, 'Knowledge'), { recursive: true, force: true })

    hub.send({ chatId: chat.id, to: id, text: 'We decided today that the Cache project will use SQLite as its store, because it needs no server and one file is easy to back up. I agree with this decision. Please record it in the vault properly.' })
    await idle(id)
    const used = hub.openChat(chat.id).items[id].filter((i) => i.kind === 'tool').map((i) => (i.kind === 'tool' ? i.name.replace('mcp__team__', '') : ''))
    log('tools used, in order:', used.join(', '))
    const walk = (dir: string, rel = ''): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name.startsWith('.') ? [] : walk(path.join(dir, d.name), `${rel}${d.name}/`)) : [`${rel}${d.name}`]))
    log('vault now holds:', walk(root).join(' | '))
    const made = walk(root).find((f) => /^Decisions\/\d{4}-\d{2}-\d{2} /.test(f))
    if (made) console.log(`\n----- ${made} -----\n${fs.readFileSync(path.join(root, made), 'utf8')}\n-----`)
    log('index links it:', /\[\[Decisions\/\d{4}/.test(fs.readFileSync(path.join(root, 'Decisions/Decisions.md'), 'utf8')), '| log has a new line:', fs.readFileSync(path.join(root, 'log.md'), 'utf8').trim().split('\n').length > 3)
    await hub.deleteChat(chat.id)
    fs.rmSync(root, { recursive: true, force: true })
  } else if (scenario === 'notes') {
    // A teammate looks something up in the vault and reports. Read-only on the vault.
    const id = process.argv[3] || 'hello'
    hub.updateSettings({ leadId: id, vaultNotes: 'ask' })
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: id, text: process.argv[4] || 'Use vault_search to find the note about decision discipline, read it with vault_read, and tell me in two sentences what it says. Do not change anything in the vault.' })
    await idle(id)
  } else if (scenario === 'hands') {
    // The computer tool called directly, with no model involved: looking only, never clicking or typing.
    const id = process.argv[3] || 'hello'
    hub.updateSettings({ computer: 'on' })
    const chat = hub.createChat({ cwd: work })
    const account = hub.accounts.get(id)
    const session = (hub as unknown as { session(c: typeof chat, a: typeof account): { key: string } }).session(chat, account)
    const tool = hub.hands.toolsFor(session as never).find((t) => t.name === 'computer')
    if (!tool) throw new Error('the computer tool was not offered')
    for (const action of ['windows', 'screenshot', 'nonsense']) {
      const t = Date.now()
      const r = await tool.run({ action })
      const text = typeof r === 'string' ? r : r.text
      const img = typeof r === 'string' ? undefined : r.images?.[0]
      log(`${action}: ${Date.now() - t} ms |`, text.replace(/Open windows, front first:.*/s, 'Open windows, front first: <titles hidden>').slice(0, 150), '| picture:', img ? `${Math.round((img.data.length * 3) / 4 / 1024)} KB ${img.mime}` : 'none')
    }
    const steps = hub.openChat(chat.id).items[id].filter((i) => i.kind === 'screen')
    log('steps:', steps.map((x) => (x.kind === 'screen' ? `${x.action}:${x.status}:${x.shot && fs.existsSync(x.shot) ? 'shot saved' : 'no shot'}:[${x.label}]` : '')).join(' | '))
    log('screen state:', JSON.stringify(hub.hands.states().map((s) => ({ kind: s.kind, active: s.active, size: `${s.width}x${s.height}`, pointer: !!s.pointer }))))
    hub.hands.release(session as never)
    log('after release:', JSON.stringify(hub.hands.states().map((s) => ({ kind: s.kind, active: s.active }))))
    await hub.deleteChat(chat.id)
    log('pictures removed with the chat:', !fs.existsSync(path.join(dataDir, 'chats', chat.id)))
  } else if (scenario === 'computer') {
    // The real screen: one picture, no clicks. The agent only looks.
    const id = process.argv[3] || 'hello'
    hub.updateSettings({ leadId: id, computer: 'on' })
    hub.updateAccount(id, { model: 'haiku' })
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: id, text: process.argv[4] || 'Use the computer tool once with action "windows" and tell me only how many windows are open. Do not click or type anything.' })
    await idle(id)
    const steps = hub.openChat(chat.id).items[id].filter((i) => i.kind === 'screen')
    log('steps:', steps.map((x) => (x.kind === 'screen' ? `${x.action}:${x.status}:${x.shot ? 'shot' : 'no shot'}` : '')).join(', '))
    await hub.deleteChat(chat.id)
  } else if (scenario === 'budget') {
    // How each account's allowance stands and which model the app would run on it. Spends nothing.
    // Earlier scenarios pin every account to haiku in this test folder; the choice is the app's here.
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: null })
    hub.updateSettings({ smartModels: true, economy: (process.argv[3] as 'auto' | 'saver' | 'quality') || 'auto' })
    const chat = hub.createChat({ cwd: work })
    const peek = hub as unknown as { smartRun(c: typeof chat, a: unknown): { model: string; effort?: string; why: string } | null; pick(c: typeof chat, o: { exclude: string[]; provider?: string; wantsTop?: boolean }): { id: string } | null }
    for (const a of hub.accounts.accounts) {
      const b = budgetOf(hub.accounts.usage.get(a.id))
      log(a.id, '|', budgetLine(b) || 'no allowance data')
      if (a.provider !== 'claude') continue
      hub.updateSettings({ leadId: a.id })
      const asLead = peek.smartRun(chat, a)
      hub.updateSettings({ leadId: hub.accounts.accounts.find((x) => x.id !== a.id)?.id || null })
      const asWorker = peek.smartRun(chat, a)
      log('   as lead:', asLead ? `${asLead.model}${asLead.effort ? `/${asLead.effort}` : ''}` : 'account default', '| as teammate:', asWorker ? `${asWorker.model}${asWorker.effort ? `/${asWorker.effort}` : ''}` : 'account default', '| score', spendScore(b).toFixed(2), '| advice:', JSON.stringify(adviseModel(b, 'worker')))
      if (asWorker) log('   why:', asWorker.why)
    }
    log('first pick for a new agent:', peek.pick(chat, { exclude: [], provider: 'claude' })?.id, '| when the strongest model is wanted:', peek.pick(chat, { exclude: [], provider: 'claude', wantsTop: true })?.id)
    await hub.deleteChat(chat.id)
  } else if (scenario === 'spawn') {
    // The lead starts an agent; a teammate it gives work to starts a sub-agent of its own; everything reports up the chain.
    const leadId = process.argv[3] || 'hello'
    const memberId = process.argv[4] || 'claude-3'
    hub.updateSettings({ leadId, vaultPath: null, smartModels: false, smartTitles: false })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const member = hub.accounts.get(memberId)
    for (const f of ['agent.txt', 'deep.txt']) fs.rmSync(path.join(work, f), { force: true })
    const chat = hub.createChat({ cwd: work })
    hub.updateChat(chat.id, { permission: 'auto' })
    hub.send({
      chatId: chat.id,
      to: leadId,
      text: `Quick check of starting agents. In this one turn make two calls. First, spawn_agent with name "Echo", role "writes one small file", model "haiku", title "Write agent.txt", and a brief asking it to create agent.txt in the working folder containing exactly the word "agent" and report. Second, assign_task to ${member?.name} with model "haiku", title "Get deep.txt written", and this brief: "Start a sub-agent of your own with spawn_agent (name Sub, role writes one small file, model haiku) whose brief is to create deep.txt in the working folder containing exactly the word deep and report. End your turn after starting it. When its report reaches you, check that deep.txt exists and report that." When both reports have reached you, read the two files yourself, rate each of your two tasks with rate_work, and tell me the two contents in one sentence.`,
    })
    let done = 0
    await until((ev) => ev.type === 'task' && (ev.task.status === 'done' || ev.task.status === 'failed' || ev.task.status === 'cancelled') && ++done >= 3, 480000)
    await idle(leadId)
    await new Promise((r) => setTimeout(r, 2000))
    const c = hub.chats.get(chat.id)
    log('agents:', (c?.agents || []).map((a) => `${a.name} by ${a.spawned?.by} on ${a.spawned?.base} depth ${a.spawned?.depth}`).join(' | '))
    const tasks = hub.tasksOf(chat.id)
    log('tasks:', tasks.map((t) => `${t.id} ${t.from}>${t.to} ${t.status} "${t.title}" finished+${(((t.finishedAt || 0) - tasks[0].createdAt) / 1000).toFixed(0)}s`).join(' | '))
    const sub = tasks.find((t) => /deep|sub/i.test(t.title) && t.from === memberId)
    const parent = tasks.find((t) => t.to === memberId)
    log('the teammate reported only after its sub-agent did:', !!sub && !!parent && (parent.finishedAt || 0) >= (sub.finishedAt || Infinity))
    log('rated:', hub.tasksOf(chat.id).filter((t) => t.rated).map((t) => `${t.id}=${t.rated} on ${t.ranOn}`).join(', ') || 'none', '| learned:', JSON.stringify(hub.learning.list().map((r) => `${r.family} ${r.done}/${r.done + r.failed} ok, ${r.enough} enough`)))
    for (const f of ['agent.txt', 'deep.txt']) log(f, fs.existsSync(path.join(work, f)) ? JSON.stringify(fs.readFileSync(path.join(work, f), 'utf8').trim()) : 'missing')
    const snap = hub.openChat(chat.id)
    log('ran on:', snap.states.map((s) => `${s.accountId}=${s.model || '?'}`).join(', '))
    log('lead said last:', JSON.stringify([...snap.items[leadId]].reverse().find((i) => i.kind === 'assistant')?.kind === 'assistant' ? ([...snap.items[leadId]].reverse().find((i) => i.kind === 'assistant') as { text: string }).text.slice(0, 240) : ''))
  } else if (scenario === 'import') {
    // What the Claude desktop app's Code tab holds on this computer. Reads only; spends nothing.
    const scan = hub.importScan()
    log('found:', scan.found, '| sections:', scan.sections.map((s) => `${s.name} ${s.sessions.length} (${s.sessions.filter((x) => x.resumable).length} can be carried on)`).join(', '), '| not in a section:', scan.loose.length)
    const all = [...scanClaudeCode().sections.flatMap((s) => s.sessions), ...scanClaudeCode().loose].filter((s) => s.transcript && fs.existsSync(s.cwd))
    const sized = all.map((s) => ({ s, kb: Math.round(fs.statSync(s.transcript!.file).size / 1024) })).sort((a, b) => a.kb - b.kb)
    log('smallest conversations that can be carried on:', sized.slice(0, 5).map((x) => `${x.s.id.slice(-6)} ${x.kb} KB`).join(', '))
    if (process.argv[3] === 'resume' && sized[0]) {
      // Carries the smallest one on in a copy, on the lightest model, and checks the original was not written to.
      const pick = sized[0]
      const file = pick.s.transcript!.file
      const before = fs.statSync(file)
      const r = hub.importRun([pick.s.id], 'continue')
      const chat = [...hub.chats.values()].find((x) => x.imported?.sessionId === pick.s.id)
      if (!chat) throw new Error(`nothing was brought in: ${JSON.stringify(r)}`)
      const lead = hub.lead(chat)
      if (!lead) throw new Error('nobody to lead the imported chat')
      hub.updateSettings({ smartModels: false, smartTitles: false, vaultPath: null })
      hub.updateAccount(lead.id, { model: 'haiku' })
      log('brought in as', JSON.stringify(chat.title.slice(0, 40)), 'resumed:', chat.imported?.resumed, 'lead:', lead.id, 'kept session:', JSON.stringify(chat.sessions[lead.id]), 'rows on show:', hub.openChat(chat.id).items[lead.id]?.length)
      hub.send({ chatId: chat.id, to: lead.id, text: 'Without using any tools: in one short sentence, what was this conversation about before this message?' })
      await idle(lead.id)
      await new Promise((r2) => setTimeout(r2, 1500))
      const after = fs.statSync(file)
      log('original untouched:', before.size === after.size && before.mtimeMs === after.mtimeMs, '| now carried on in:', JSON.stringify(hub.chats.get(chat.id)?.sessions[lead.id]))
      await hub.deleteChat(chat.id)
    }
  } else if (scenario === 'goal') {
    // A real goal on a cheap model: the lead works, a real checker judges, and the lead is sent back if it falls short.
    const leadId = process.argv[3] || 'hello'
    hub.updateSettings({ leadId, smartTitles: false, recall: false, chatNotes: false })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const chat = hub.createChat({ cwd: work })
    const file = path.join(work, 'goal-proof.txt')
    fs.rmSync(file, { force: true })
    hub.send({
      chatId: chat.id,
      to: leadId,
      text: 'In the working folder, create goal-proof.txt containing exactly the line "ensemble". Do it yourself and hand nothing off. In this first reply only create the file and say you created it; do not read it back yet.',
      goal: { doneWhen: 'the file exists and its contents have been read back and shown in the report', maxRounds: 4 },
    })
    await until((ev) => ev.type === 'chat' && ev.chat.id === chat.id && !!ev.chat.goal && ev.chat.goal.status !== 'active', 420000)
    const g = hub.chats.get(chat.id)?.goal
    log('GOAL', g?.status, '| rounds used:', (g?.round ?? 0) + 1, '| checks:', JSON.stringify(g?.log.map((l) => `${l.met ? 'met' : 'not met'}: ${l.note}`)))
    log('file:', fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : 'MISSING')
    log('used goal_report:', (hub.openChat(chat.id).items[leadId] || []).some((i) => i.kind === 'tool' && i.name === 'mcp__team__goal_report'))
  } else if (scenario === 'loop') {
    // A real self-paced loop: the agent sets its own next run, and ends the loop on the second run.
    const leadId = process.argv[3] || 'hello'
    hub.updateSettings({ leadId, smartTitles: false, recall: false, chatNotes: false })
    for (const a of hub.accounts.accounts) hub.updateAccount(a.id, { model: a.provider === 'claude' ? 'haiku' : null })
    const chat = hub.createChat({ cwd: work })
    const file = path.join(work, 'loop-count.txt')
    fs.rmSync(file, { force: true })
    hub.send({ chatId: chat.id, to: leadId, text: 'Append one line with the word "tick" to loop-count.txt in the working folder (create it if missing), then say how many lines it has now. Do it yourself.', loop: { every: null, until: 'loop-count.txt has 2 or more lines' } })
    const loop = hub.chats.get(chat.id)?.loops?.[0]
    await until((ev) => ev.type === 'chat' && ev.chat.id === chat.id && !ev.chat.loops?.[0]?.running, 240000)
    log('after run 1:', JSON.stringify({ status: loop?.status, nextAt: loop?.nextAt ? Math.round((loop.nextAt - Date.now()) / 1000) + ' s away' : null, last: loop?.last }))
    if (loop && loop.status === 'active') {
      hub.runLoop(chat.id, loop.id)
      await until((ev) => ev.type === 'chat' && ev.chat.id === chat.id && !ev.chat.loops?.[0]?.running, 240000)
    }
    log('LOOP', loop?.status, '| runs:', loop?.runs, '| note:', loop?.note, '| last:', loop?.last)
    log('file:', fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : 'MISSING')
  } else if (scenario === 'enhance') {
    const out = await hub.enhance(process.argv[3] || 'make the app better and smarter, add goal options and loop options, it should be really amazing', null)
    log('ENHANCED:', JSON.stringify(out))
  } else if (scenario === 'gpt') {
    const id = hub.accounts.accounts.find((a) => a.provider === 'chatgpt')?.id
    if (!id) throw new Error('no chatgpt account')
    const chat = hub.createChat({ cwd: work })
    hub.send({ chatId: chat.id, to: id, text: 'Call the roster tool from the team MCP server and tell me in one sentence who is on the team. If you have no such tool, say exactly: NO TEAM TOOLS.' })
    await idle(id)
  }
} catch (e) {
  log('ERROR', (e as Error).message)
}
await hub.dispose()
setTimeout(() => process.exit(0), 800)
