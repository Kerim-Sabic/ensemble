import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Ctx } from './ctx'
import { APP_COMMANDS, MODE_INFO, parseCommand } from '../../src/shared/auto'
import { appFolder, firstTasks, projectKind, startFolder, unsafeFolder, type FolderProbe } from '../../src/shared/firstrun'
import { appFolderPath, folderProbe, makeAppFolder, recentProjects } from '../../src/main/firstrun'

/**
 * The interface talks about delivered work, not head counts: no way of working may be described
 * by its agents. The words agent, agents and swarm are out, and so is any count of helpers.
 */
const COUNTS_AGENTS = /\b(agents?|agent's|swarms?)\b|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|dozens? of|hundreds of|many|several|lots of)\s+(helpers?|workers?|teammates?|scouts?)\b/i

// Quick, Team and Verified as the main ways of working; the first task chosen from the folder.
export default async function (c: Ctx): Promise<void> {
  // The names people see. Mode ids stay as they were.
  c.same('modes: chat is shown as Team', MODE_INFO.chat.label, 'Team')
  c.same('modes: thorough is shown as Verified', MODE_INFO.thorough.label, 'Verified')
  c.same('modes: quick is shown as Quick', MODE_INFO.quick.label, 'Quick')

  // The rule itself catches the texts it was written against.
  c.check(
    'modes: the agent rule catches the old texts',
    ['One agent answers now', 'Many agents on the strongest models at full effort', 'Ultra at full scale: a swarm of fast research agents', "at the agent's own pace", 'with 12 agents', 'several helpers'].every((t) => COUNTS_AGENTS.test(t)),
  )
  c.check('modes: the agent rule lets plain texts through', !['Answered now, without the team', 'Every model answers on its own, then the lead compares them'].some((t) => COUNTS_AGENTS.test(t)))
  const texts = [
    ...Object.entries(MODE_INFO).flatMap(([id, m]) => [`${id}.label: ${m.label}`, `${id}.hint: ${m.hint}`]),
    ...APP_COMMANDS.flatMap((x) => [`/${x.name}: ${x.description}`, `/${x.name} hint: ${x.hint || ''}`]),
  ]
  const bad = texts.filter((t) => COUNTS_AGENTS.test(t.slice(t.indexOf(':') + 1)))
  c.check('modes: no hint counts agents', bad.length === 0, bad.join(' | '))
  c.same('modes: Quick says what you get', MODE_INFO.quick.hint, 'Answered now, without the team')

  // Typed commands: the new names, and the old ones still working.
  c.same('modes: /verified is thorough', parseCommand('/verified add the pricing page'), { kind: 'mode', mode: 'thorough', text: 'add the pricing page' })
  c.same('modes: /team is the usual way', parseCommand('/team plan the launch'), { kind: 'mode', mode: 'chat', text: 'plan the launch' })
  c.same('modes: /thorough still works', parseCommand('/thorough add the pricing page'), { kind: 'mode', mode: 'thorough', text: 'add the pricing page' })
  c.same('modes: /quick still works', parseCommand('/QUICK what time is it in Tokyo'), { kind: 'mode', mode: 'quick', text: 'what time is it in Tokyo' })
  c.same('modes: /verified alone is not a command', parseCommand('/verified'), null)
  c.same('modes: /teamwork is not /team', parseCommand('/teamwork now'), null)
  c.same('modes: the "/" list starts with Quick, Team, Verified', APP_COMMANDS.slice(0, 3).map((x) => x.name), ['quick', 'team', 'verified'])
  c.check('modes: every listed command parses', APP_COMMANDS.every((x) => parseCommand(`/${x.name} something`) !== null), APP_COMMANDS.map((x) => x.name).join(','))

  // The first task, from what a folder holds (made-up folders, no disk).
  const probe = (entries: string[], git = false, name = 'shop'): FolderProbe => ({ path: `/x/${name}`, name, entries, git })
  const node = probe(['package.json', 'src/', 'tests/', 'README.md'], true)
  c.check('first run: a node project is code', projectKind(node).code && projectKind(node).kind === 'JavaScript' && projectKind(node).tests)
  const nt = firstTasks(node)
  c.same('first run: three tasks for a project', nt.length, 3)
  c.check('first run: project tasks name the project', nt.every((t) => t.text.includes('shop')), nt.map((t) => t.text).join(' | '))
  c.same('first run: project tasks', nt.map((t) => t.title), ['Explain this project', 'Find and fix a failing test', 'Review the last change'])
  c.same('first run: no tests and no git', firstTasks(probe(['Cargo.toml', 'src/'], false, 'tool')).map((t) => t.title), ['Explain this project', 'Run it and fix what breaks', 'Review the code'])
  c.check('first run: a git repo with src counts as code', projectKind(probe(['src/', 'notes.txt'], true)).code)
  c.check('first run: a folder of documents is not code', !projectKind(probe(['report.docx', 'photos/', 'budget.xlsx'], false)).code)
  c.same('first run: ordinary tasks for documents', firstTasks(probe(['report.docx', 'budget.xlsx'], false, 'Work')).map((t) => t.title), ['Research and compare', 'Plan something', 'Explain what is here'])

  // No folder chosen (the app's own new folder) or an empty one: only tasks that need no files.
  const noFiles = ['Research and compare', 'Plan something', 'Make a small tool']
  const empties: [string, FolderProbe | null][] = [
    ['no folder', null],
    ['an empty folder', probe([], false, 'Ensemble')],
    ['a folder with only the app mark', probe(['.ensemble-folder'], false, 'Ensemble')],
    ['a folder that cannot be read', { path: '/gone', name: 'gone', entries: [], git: false, missing: true }],
  ]
  for (const [what, p] of empties) {
    const t = firstTasks(p)
    c.same(`first run: tasks without files for ${what}`, t.map((x) => x.title), noFiles)
    c.check(`first run: no "explain what is here" for ${what}`, !t.some((x) => /explain what is here|look at the files|explain .*file/i.test(`${x.title} ${x.blurb} ${x.text}`)))
  }
  c.check('first run: no task text mentions agents', [...nt, ...firstTasks(null)].every((t) => !COUNTS_AGENTS.test(`${t.title} ${t.blurb} ${t.text}`)))

  // Where a first task may run: never a home folder, a personal folder itself or a drive root.
  const winHome = 'C:\\Users\\ana'
  const macHome = '/Users/ana'
  const refusedWin = ['C:\\Users\\ana', 'c:\\users\\ANA\\', 'C:\\', 'C:', 'D:\\', 'C:\\Users', 'C:\\Users\\ana\\Documents', 'C:\\Users\\ana\\Desktop\\', 'C:\\Users\\ana\\Downloads', 'C:\\Users\\ana\\OneDrive', 'C:\\Users\\ana\\OneDrive\\Documents', 'C:\\Users\\ana\\OneDrive - Contoso\\Desktop', '\\\\server\\share']
  const refusedMac = ['/', '/Users', '/Users/ana', '/Users/ana/', '/Users/ana/Desktop', '/Users/ana/Documents', '/Users/ana/Downloads', '/Users/ana/Library']
  const allowedWin = ['C:\\Users\\ana\\code\\shop', 'C:\\Users\\ana\\Documents\\shop', 'C:\\Users\\ana\\Documents\\Ensemble', 'D:\\work\\shop', 'C:\\Users\\ana\\ensemble']
  const allowedMac = ['/Users/ana/code/shop', '/Users/ana/Documents/shop', '/Users/ana/Documents/Ensemble', '/Volumes/Work/shop']
  const missedWin = refusedWin.filter((d) => !unsafeFolder(d, winHome))
  const missedMac = refusedMac.filter((d) => !unsafeFolder(d, macHome))
  c.check('first run: home, personal folders and drive roots are refused (Windows)', missedWin.length === 0, missedWin.join(' | '))
  c.check('first run: home, personal folders and drive roots are refused (Mac)', missedMac.length === 0, missedMac.join(' | '))
  c.check('first run: home on Linux is refused', !!unsafeFolder('/home/ana', '/home/ana') && !!unsafeFolder('/home', '/home/ana') && !unsafeFolder('/home/ana/shop', '/home/ana'))
  const wrongly = [...allowedWin.filter((d) => unsafeFolder(d, winHome)), ...allowedMac.filter((d) => unsafeFolder(d, macHome))]
  c.check('first run: project folders are allowed', wrongly.length === 0, wrongly.join(' | '))
  const why = unsafeFolder('C:\\Users\\ana', winHome) || ''
  c.check('first run: a picked home folder is refused in one plain sentence that says why', /^Not your home folder: [^.]*the team can change any file[^.]*\.$/.test(why), why)
  c.check('first run: every refusal is one sentence', [...refusedWin.map((d) => unsafeFolder(d, winHome)), ...refusedMac.map((d) => unsafeFolder(d, macHome))].every((s) => !!s && /^[^.]+\.$/.test(s) && !s.includes('\u2014')))

  // The default when nobody chose a folder: the app's own, never home, Documents itself or a root.
  const defaults: [string, string, string | null, string][] = [
    ['Windows', winHome, 'C:\\Users\\ana\\Documents', 'C:\\Users\\ana\\Documents\\Ensemble'],
    ['Windows, Documents in OneDrive', winHome, 'C:\\Users\\ana\\OneDrive\\Documents', 'C:\\Users\\ana\\OneDrive\\Documents\\Ensemble'],
    ['Windows, Documents moved to a drive root', winHome, 'D:\\', 'C:\\Users\\ana\\Ensemble'],
    ['Windows, no Documents', winHome, null, 'C:\\Users\\ana\\Ensemble'],
    ['Mac', macHome, '/Users/ana/Documents', '/Users/ana/Documents/Ensemble'],
    ['Mac, Documents is home', macHome, '/Users/ana', '/Users/ana/Ensemble'],
    ['Linux, no Documents', '/home/ana', '', '/home/ana/Ensemble'],
  ]
  for (const [what, home, docs, want] of defaults) {
    const got = appFolder(home, docs)
    c.same(`first run: default folder (${what})`, got, want)
    c.check(`first run: default folder is never unsafe (${what})`, !unsafeFolder(got, home), got)
  }
  c.same('first run: a home folder set before is not kept', startFolder(winHome, winHome), null)
  c.same('first run: a drive root set before is not kept', startFolder('/', macHome), null)
  c.same('first run: nothing set means the app folder', startFolder(null, macHome), null)
  c.same('first run: a project set before is kept', startFolder('/Users/ana/code/shop', macHome), '/Users/ana/code/shop')

  // The probe, the app's folder and recent projects, on real temporary folders.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-firstrun-'))
  try {
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n')
    fs.mkdirSync(path.join(dir, 'tests'))
    fs.mkdirSync(path.join(dir, '.git'))
    const p = await folderProbe(dir)
    c.check('first run: probe lists the top level, folders marked', p.entries.includes('pyproject.toml') && p.entries.includes('tests/') && p.git && !p.missing, JSON.stringify(p.entries))
    c.same('first run: probe makes Python tasks', firstTasks(p)[1].title, 'Find and fix a failing test')
    const gone = await folderProbe(path.join(dir, 'no-such-folder'))
    c.check('first run: probe of a missing folder says so', gone.missing === true && gone.entries.length === 0)
    c.check('first run: probe of nothing', (await folderProbe(null)).missing === true)

    // The app's own folder: made only when asked, reused, and never someone else's folder of the same name.
    const home = path.join(dir, 'home')
    const docs = path.join(home, 'Documents')
    fs.mkdirSync(docs, { recursive: true })
    const planned = appFolderPath(home, docs)
    c.check('first run: the app folder is not made before the task starts', planned === path.join(docs, 'Ensemble') && !fs.existsSync(planned), planned)
    const made = makeAppFolder(home, docs)
    c.check('first run: the app folder is made at the start', made === planned && fs.statSync(made).isDirectory())
    c.same('first run: the app folder is reused', makeAppFolder(home, docs), made)
    c.same('first run: its tasks need no files', firstTasks(await folderProbe(made)).map((t) => t.title), noFiles)
    const docs2 = path.join(dir, 'home2', 'Documents')
    fs.mkdirSync(path.join(docs2, 'Ensemble'), { recursive: true })
    fs.writeFileSync(path.join(docs2, 'Ensemble', 'score.musicxml'), '<score/>')
    c.same("first run: a person's own Ensemble folder is left alone", makeAppFolder(path.join(dir, 'home2'), docs2), path.join(docs2, 'Ensemble 2'))

    // Recent projects, from a made-up Claude Code and Codex history.
    const code = path.join(dir, 'code')
    for (const n of ['older', 'newer']) fs.mkdirSync(path.join(code, n, '.git'), { recursive: true })
    fs.mkdirSync(path.join(code, 'nogit'), { recursive: true })
    fs.mkdirSync(path.join(code, 'worktree'), { recursive: true })
    fs.writeFileSync(path.join(code, 'worktree', '.git'), 'gitdir: ../older/.git/worktrees/x\n')
    const fwd = (p: string): string => p.replace(/\\/g, '/')
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [fwd(path.join(code, 'older'))]: {}, [fwd(path.join(code, 'nogit'))]: {}, [fwd(home)]: {}, [fwd(path.join(code, 'gone'))]: {}, [fwd(path.join(code, 'worktree'))]: {} } }))
    const sessions = path.join(home, '.claude', 'projects', fwd(path.join(code, 'older')).replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(sessions, { recursive: true })
    const day = path.join(home, '.codex', 'sessions', '2026', '11', '20')
    fs.mkdirSync(day, { recursive: true })
    const log = path.join(day, 'rollout-1.jsonl')
    fs.writeFileSync(log, `${JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: path.join(code, 'newer') } })}\n{"type":"other"}\n`)
    const t = Date.now() / 1000
    fs.utimesSync(sessions, t - 3600, t - 3600)
    fs.utimesSync(log, t, t)
    const recent = await recentProjects(home, 4, '')
    c.same('first run: recent git projects, newest first', recent.map((r) => r.name), ['newer', 'older'])
    c.check('first run: recent projects never include home, worktrees or folders without git', recent.every((r) => !unsafeFolder(r.path, home) && fs.existsSync(path.join(r.path, '.git'))))
    c.same('first run: no history, no recent projects', await recentProjects(path.join(dir, 'nobody'), 4, ''), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
