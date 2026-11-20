// The guard: what a run nobody is watching may do. The pure part: sorting tools by what they can
// do, the rule that turns a tool and the run's state into allowed / asks / refused, the daily caps
// and the choice of account. The engine side (src/main/guard.ts) holds the state and enforces it.
//
// The idea is Meta's "Rule of Two" made concrete: a run may read untrusted text, may hold private
// data and may change things inside its own folder, but anything that reaches outward or cannot be
// undone waits for the user, and the app enforces that, not the prompt. Telling injected text from
// honest text is not attempted anywhere here: detection keeps being bypassed, structure holds.
import { DEFAULT_CAPS, type UnattendedCaps } from './watches'

/**
 * What a tool can do, which is all the rule goes by.
 * - read: looks at files inside the chat's folder.
 * - write: changes files inside the chat's folder.
 * - team: the team's own tools (hand out a task, message a teammate, the board, tell the user).
 * - untrusted: reads text someone else wrote (the web, GitHub, another person's team).
 * - private: reads the user's own things outside the folder (the vault, memory, other chats, other files).
 * - store: writes to long-term memory or the vault.
 * - persist: starts something that keeps running by itself (a goal, a loop).
 * - outward: reaches out or cannot be undone (send, post, push, publish, write or delete outside the folder, a connector tool that changes something, acting on a web page).
 * - shell: runs commands. Cannot be sorted by reading the command, so it is safe only inside an OS sandbox.
 * - never: not for a run nobody watches (control of the computer, sign-in and key folders, a question to a user who is not there).
 * - unknown: a tool the guard has no entry for.
 */
export type ToolClass = 'connector' | 'read' | 'write' | 'team' | 'untrusted' | 'private' | 'store' | 'persist' | 'outward' | 'shell' | 'never' | 'unknown'

export interface Sorted {
  cls: ToolClass
  /** One plain line: what will happen, and to whom or where. Shown on the approval. */
  summary: string
  /** Where it goes or what it touches (a host, a path, a person), when there is one. */
  dest?: string
  /** Reading this makes the run one that has read untrusted content: where from. */
  untrusted?: string
  /** Reading this makes the run one that holds private data. */
  private?: boolean
  /** For a request to the web: what the user would be letting the run read (a host, or one of the *_GRANT names). */
  web?: string
}

/** What the run has done so far that the rule depends on. Never goes back to clean. */
export interface RunState {
  /** Sources of untrusted text it has read (the first few), empty when none. */
  untrusted: string[]
  /** It has read private data (the vault, memory, other chats, files outside its folder). */
  private: boolean
  /** Where the user let this run go on the web after it read untrusted content: host names, and SEARCH_GRANT for web search. */
  grants?: string[]
}

/**
 * What every unattended run starts out having read: the files in its folder. Nobody checked who
 * wrote them (a cloned README, a dependency's docs, a downloaded file), so a run nobody is watching
 * is never treated as one that has read only the user's own words.
 */
export const FOLDER_SOURCE = 'the files in its folder, which other people may have written'

/** The grant that stands for web search as a whole. */
export const SEARCH_GRANT = 'web search'
/** The grant for looking at whatever page the team's browser has open. */
export const PAGE_GRANT = 'the page open in the browser'
/** The grant for the notes of a shared project. */
export const SHARED_GRANT = "the shared project's notes"

export type Verdict = 'allow' | 'ask' | 'refuse'

export interface Where {
  /** The chat's folder. */
  cwd: string
  home: string
  /** Folders that hold sign-ins and keys (the app's own data, the accounts' config folders). Never read by an unattended run. */
  secrets: string[]
  /** The provider runs shell commands inside its own sandbox (writes kept to the folder, network off). */
  sandboxedShell: boolean
  windows: boolean
}

// ----- paths (no Node here: this file is also loaded by the window) -----

/** A path as one comparable string: forward slashes, no `.` or `..`, lower case on Windows. */
export function normPath(p: string, cwd: string, windows: boolean): string {
  let s = String(p || '').replace(/\\/g, '/')
  const abs = /^([a-zA-Z]:)?\//.test(s) || /^[a-zA-Z]:$/.test(s) || s.startsWith('//')
  if (!abs) s = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${s}`
  const lead = s.startsWith('//') ? '//' : /^[a-zA-Z]:/.test(s) ? s.slice(0, 2) : ''
  const rest = lead === '//' ? s.slice(2) : lead ? s.slice(2) : s
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  const joined = `${lead}${lead === '//' ? '' : '/'}${out.join('/')}`
  return windows ? joined.toLowerCase() : joined
}

export function inside(p: string, dir: string, cwd: string, windows: boolean): boolean {
  const a = normPath(p, cwd, windows)
  const b = normPath(dir, cwd, windows).replace(/\/+$/, '')
  return a === b || a.startsWith(`${b}/`)
}

/** Files and folders that hold keys and sign-ins wherever they are. */
const SECRET_NAMES = /(^|\/)(\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)[^/]*|[^/]*\.(pem|pfx|p12|key|kdbx|keystore|jks)|\.?credentials(\.json)?|auth\.json|secrets?\.(json|ya?ml|toml|env)|login data|cookies|wallet\.dat)$/i
/** `.env` and `.env.<anything>` hold keys; the samples that are meant to be shared do not. */
const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$/i
const ENV_SAMPLE = /\.(example|sample|template|dist|defaults)$/i
/** Sign-in folders of the agent programs, whatever the account is called: ~/.claude, ~/.claude-account3, ~/.codex-work. */
const AGENT_HOME = /^\.(claude|codex)/i
const SECRET_HOME = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.config/gh', '.config/gcloud', '.claude', '.codex', 'AppData/Roaming/Ensemble', 'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data', 'AppData/Local/BraveSoftware', 'AppData/Roaming/Mozilla', 'Library/Keychains', 'Library/Application Support/Ensemble']

export function isSecret(p: string, w: Where): boolean {
  const n = normPath(p, w.cwd, w.windows)
  if (SECRET_NAMES.test(n)) return true
  if (ENV_FILE.test(n) && !ENV_SAMPLE.test(n)) return true
  const home = normPath(w.home, w.cwd, w.windows).replace(/\/+$/, '')
  if (home && n.startsWith(`${home}/`) && AGENT_HOME.test(n.slice(home.length + 1).split('/')[0])) return true
  // The chat's own folder can lie inside one of these (a folder the app made for it in its data):
  // what is in the chat's folder is then the chat's, the rest of that folder is still off limits.
  const own = (d: string): boolean => inside(n, w.cwd, w.cwd, w.windows) && inside(w.cwd, d, w.cwd, w.windows) && normPath(w.cwd, w.cwd, w.windows) !== normPath(d, w.cwd, w.windows)
  if (w.secrets.some((d) => d && inside(n, d, w.cwd, w.windows) && !own(d))) return true
  return SECRET_HOME.some((d) => inside(n, `${w.home}/${d}`, w.cwd, w.windows) && !own(`${w.home}/${d}`))
}

/**
 * Files inside a folder that run commands by themselves later, outside any sandbox: Git's own
 * (hooks, config), and the settings of tools that start things on their own (agent hooks, commit
 * hooks, editor tasks, CI). Changing one is not an ordinary edit.
 */
const SELF_RUNNING = /(^|\/)(\.git|\.claude|\.codex|\.husky|\.vscode|\.github\/workflows)(\/|$)/i
export function runsLater(p: string, w: Where): string | null {
  const n = normPath(p, w.cwd, w.windows)
  const m = SELF_RUNNING.exec(n)
  if (!m) return null
  return /^\.git$/i.test(m[2]) ? "Git's own files, which can run commands at your next commit" : `${m[2]}, which can run commands by itself later`
}

const short = (s: unknown, n = 90): string => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const hostOf = (url: unknown): string => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(String(url || ''))
  return m ? m[1].replace(/^[^@]*@/, '').toLowerCase() : ''
}

// ----- sorting tools -----

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'View'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell', 'Monitor', 'BashOutput', 'KillShell', 'KillBash', 'shell', 'command_execution', 'local_shell', 'exec_command'])
/** The model's own bookkeeping: nothing leaves, nothing outside the conversation changes. */
const QUIET_TOOLS = new Set(['TodoWrite', 'TodoRead', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode', 'ToolSearch', 'todo_list', 'reasoning', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch', 'web_search', 'web_fetch'])

/** The hub's own tools, by what each can do. One that is not listed is unknown. */
const TEAM: Record<string, ToolClass> = {
  roster: 'team',
  ask: 'team',
  message: 'team',
  assign_task: 'team',
  cancel_task: 'team',
  task_status: 'team',
  spawn_agent: 'team',
  dismiss_agent: 'team',
  rate_work: 'team',
  resume_work: 'team',
  board_read: 'team',
  board_post: 'team',
  notify_user: 'team',
  goal_report: 'team',
  loop_update: 'team',
  shared_project_people: 'team',
  chat_history_search: 'private',
  memory_search: 'private',
  vault_search: 'private',
  vault_read: 'private',
  shared_memory_search: 'untrusted',
  memory_save: 'store',
  vault_save: 'store',
  memory_delete: 'outward',
  goal_set: 'persist',
  loop_start: 'persist',
  shared_memory_save: 'outward',
  shared_project_message: 'outward',
  computer: 'never',
}
/** What the browser tool does with a page: looking is reading untrusted text, the rest acts on it. */
const BROWSER_LOOKS = new Set(['open', 'read', 'find', 'look', 'scroll', 'back', 'forward', 'reload', 'wait', 'close'])
/** A connector tool whose name starts with one of these only reads. Anything else is taken to change something. */
const READS = /^(get|list|search|read|fetch|find|query|describe|show|view|retrieve|lookup|check|count|whoami|status|export|download|inspect)(?![a-z])/i

const pathOf = (input: Record<string, unknown>): string => String(input.file_path ?? input.path ?? input.notebook_path ?? input.filePath ?? '')

/** Sorts one tool call by what it can do. `tool` is the name as the provider reports it. */
export function sortTool(tool: string, input: unknown, w: Where): Sorted {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const team = /^mcp__team__(.+)$/.exec(tool)?.[1]
  if (team !== undefined) return sortTeam(team, i)
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool)
  if (mcp) {
    const [, server, name] = mcp
    // A connector holds the user's own data at some service, and what it returns was written by other people.
    // The name is all there is to go by, and it proves nothing: see `decide`.
    if (READS.test(name)) return { cls: 'connector', summary: `Read from ${server}: ${name}${short(JSON.stringify(i), 60) !== '{}' ? ` ${short(JSON.stringify(i), 60)}` : ''}`, dest: server, untrusted: server, private: true }
    return { cls: 'outward', summary: `Use ${server}: ${name}${short(JSON.stringify(i), 60) !== '{}' ? ` ${short(JSON.stringify(i), 60)}` : ''}`, dest: server }
  }
  if (tool === 'AskUserQuestion') return { cls: 'never', summary: 'Ask the user a question and wait for the answer' }
  if (QUIET_TOOLS.has(tool)) return { cls: 'team', summary: tool }
  if (WEB_TOOLS.has(tool)) {
    const site = hostOf(i.url)
    if (site) return { cls: 'untrusted', summary: `Read ${short(i.url, 100)}`, dest: site, untrusted: site, web: site }
    if (i.query !== undefined && i.url === undefined) return { cls: 'untrusted', summary: `Search the web for "${short(i.query, 70)}"`, dest: SEARCH_GRANT, untrusted: SEARCH_GRANT, web: SEARCH_GRANT }
    // No address it can be held to: asked for call by call once the run has read untrusted content.
    return { cls: 'untrusted', summary: `Read ${short(i.url ?? 'the web', 100)}`, untrusted: 'the web' }
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = short(i.command ?? i.cmd ?? '', 120)
    // Inside the provider's sandbox a command can read the whole disk, so the run then holds private data.
    return { cls: 'shell', summary: `Run a command${cmd ? `: ${cmd}` : ''}`, private: true }
  }
  if (READ_TOOLS.has(tool)) {
    const p = pathOf(i)
    if (!p) return { cls: 'read', summary: `${tool} in the folder` }
    if (isSecret(p, w)) return { cls: 'never', summary: `Read ${short(p)}, where sign-ins or keys are kept`, dest: p }
    if (inside(p, w.cwd, w.cwd, w.windows)) return { cls: 'read', summary: `Read ${short(p)}` }
    // A file outside the folder is both: the user's own, and possibly written by someone else.
    return { cls: 'private', summary: `Read ${short(p)}, outside this chat's folder`, dest: p, private: true, untrusted: `a file outside the folder (${short(p, 50)})` }
  }
  if (WRITE_TOOLS.has(tool)) {
    const p = pathOf(i)
    if (!p) return { cls: 'unknown', summary: `${tool} with no file named` }
    if (isSecret(p, w)) return { cls: 'never', summary: `Change ${short(p)}, where sign-ins or keys are kept`, dest: p }
    const later = runsLater(p, w)
    if (later) return { cls: 'outward', summary: `Change ${short(p)}: ${later}`, dest: p }
    if (inside(p, w.cwd, w.cwd, w.windows)) return { cls: 'write', summary: `Change ${short(p)}` }
    return { cls: 'outward', summary: `Change ${short(p)}, outside this chat's folder`, dest: p }
  }
  return { cls: 'unknown', summary: `Use the tool ${short(tool, 60)}` }
}

const STORE_OF = (name: string): string => (name.startsWith('vault') ? 'the vault' : name.startsWith('memory') ? "the team's memory" : 'earlier chats')

function sortTeam(name: string, i: Record<string, unknown>): Sorted {
  if (name === 'browser') {
    const action = String(i.action || '')
    const where = hostOf(i.url) || 'the page that is open'
    if (BROWSER_LOOKS.has(action)) {
      const site = hostOf(i.url)
      return site ? { cls: 'untrusted', summary: `Open ${short(i.url, 100)} in the browser`, dest: site, untrusted: site, web: site } : { cls: 'untrusted', summary: `Look at ${where} in the browser`, dest: where, untrusted: where, web: PAGE_GRANT }
    }
    return { cls: 'outward', summary: `${action === 'type' ? `Type "${short(i.text, 50)}" into` : action === 'sign_in' ? 'Sign in on' : `${action || 'Act'} on`} ${where} in the browser`, dest: where }
  }
  const cls = TEAM[name]
  if (!cls) return { cls: 'unknown', summary: `Use the tool ${short(name, 60)}` }
  switch (name) {
    case 'shared_project_message':
      return { cls, summary: `Send the other person's team a message: "${short(i.text, 70)}"`, dest: "the other person's team" }
    case 'shared_memory_save':
      return { cls, summary: `Save a note the other person's team can read: "${short(i.title, 60)}"`, dest: "the other person's team" }
    case 'shared_memory_search':
      return { cls, summary: `Search the shared project's notes for "${short(i.query, 60)}"`, untrusted: "another person's team", web: SHARED_GRANT }
    case 'memory_save':
      return { cls, summary: `Save to the team's memory: "${short(i.title, 60)}"`, dest: 'memory' }
    case 'memory_delete':
      return { cls, summary: `Delete a note from the team's memory (${short(i.id, 30)})`, dest: 'memory' }
    case 'vault_save':
      return { cls, summary: `Write to the vault: ${short(i.path, 70)}`, dest: 'the vault' }
    case 'goal_set':
      return { cls, summary: `Set a goal the team keeps working on by itself: "${short(i.text ?? i.goal, 70)}"` }
    case 'loop_start':
      return { cls, summary: `Start a loop that sends itself again: "${short(i.prompt ?? i.text, 70)}"` }
    case 'computer':
      return { cls, summary: 'Control the mouse and keyboard of this computer' }
    case 'chat_history_search':
    case 'memory_search':
    case 'vault_search':
    case 'vault_read':
      // The vault, memory and earlier chats are the user's own, and they also hold what other people
      // wrote: clipped pages, imported material, quotes from the web. So reading them makes the run
      // both one that holds private data and one that has read untrusted content.
      return { cls, summary: `Read ${STORE_OF(name)}`, private: true, untrusted: STORE_OF(name) }
    default:
      return { cls, summary: name }
  }
}

// ----- the rule -----

export interface Decision {
  verdict: Verdict
  /** Why, in plain words. For a refusal this is what the agent is told. */
  why: string
}

/**
 * The rule, in one place. An unattended run may read and may change files inside its folder.
 * Anything outward or irreversible waits for the user, whatever the run has read. While the run may
 * have read text other people wrote, three more things wait: any request to the web (unless the
 * user already let this run read that host), any call to an outside service, and writing to
 * long-term memory; and a tool the guard does not know is refused outright (in a clean state it
 * asks). Some things are never for a run nobody watches.
 *
 * A run nobody is watching is never in the clean state: src/main/guard.ts starts every one as
 * having read FOLDER_SOURCE. The clean branches below are for the state as such, and are what
 * the checks of the rule itself exercise.
 */
export function decide(s: Sorted, state: RunState, w: Pick<Where, 'sandboxedShell' | 'windows'>): Decision {
  const tainted = state.untrusted.length > 0
  switch (s.cls) {
    case 'read':
    case 'write':
    case 'team':
    case 'private':
      return { verdict: 'allow', why: '' }
    case 'untrusted':
      // The web is a way out as well as a way in: an address or a search can carry what the run
      // has read. So once it has read untrusted content it reaches only where the user said it may.
      if (!tainted) return { verdict: 'allow', why: '' }
      if (s.web && (state.grants || []).includes(s.web)) return { verdict: 'allow', why: '' }
      return { verdict: 'ask', why: 'Nobody is watching this run and it may have read text other people wrote; a request to the web can carry out what it has read, so it needs your OK first.' }
    case 'connector':
      // Told apart from a tool that acts only by its name, which proves nothing, and its arguments leave this computer.
      return tainted ? { verdict: 'ask', why: 'Nobody is watching this run and it may have read text other people wrote; a call to an outside service carries its arguments there, so it needs your OK first.' } : { verdict: 'allow', why: '' }
    case 'store':
      return tainted ? { verdict: 'ask', why: 'Nobody is watching this run and it may have read text other people wrote, so what it saves to long-term memory needs your OK first.' } : { verdict: 'allow', why: '' }
    case 'persist':
      return { verdict: 'ask', why: 'A run nobody is watching does not start work that keeps going by itself without your OK.' }
    case 'outward':
      return { verdict: 'ask', why: 'It reaches outside this chat or cannot be undone, and nobody is watching this run.' }
    case 'shell':
      return w.sandboxedShell
        ? { verdict: 'allow', why: '' }
        : { verdict: 'refuse', why: `Shell commands are not available in a run nobody is watching${w.windows ? ' on Windows' : ''}: there is no sandbox to hold them to this folder and keep them off the network. Use the file tools, and say in your report what should be run.` }
    case 'never':
      return { verdict: 'refuse', why: `Not available in a run nobody is watching: ${s.summary.charAt(0).toLowerCase()}${s.summary.slice(1)}. Say in your report what you need instead.` }
    default:
      return tainted || state.private
        ? { verdict: 'refuse', why: `The guard does not know the tool behind "${s.summary}", and this run ${tainted ? 'may have read text other people wrote' : 'has read private data'}, so it is not used. Say in your report what you need.` }
        : { verdict: 'ask', why: 'The guard does not know what this tool can do, so it waits for your OK.' }
  }
}

/** What saying yes to a web request lets the run do until it ends, in words for the card. Null when the yes covers that one call only. */
export function grantLine(s: Sorted, state: RunState): string | null {
  if (s.cls !== 'untrusted' || !s.web || !state.untrusted.length) return null
  return s.web === SEARCH_GRANT ? 'Lets this run search the web until it ends.' : s.web === PAGE_GRANT ? 'Lets this run look at the page its browser has open until it ends.' : s.web === SHARED_GRANT ? "Lets this run search the shared project's notes until it ends." : `Lets this run read pages on ${s.web} until it ends.`
}

/**
 * Where a watch's finding came from, when other people could have written it: a page, a
 * repository's issues and runs, a changed file, a command's output. It is named on the approval
 * card as what the run has read. Null for a watch that only goes by the clock: that run still
 * starts untrusted, from FOLDER_SOURCE (src/main/guard.ts).
 */
export function watchSource(trigger: { kind: string; url?: string; repo?: string; path?: string; command?: string }): string | null {
  switch (trigger.kind) {
    case 'schedule':
      return null
    case 'url':
      return hostOf(trigger.url) || 'a watched page'
    case 'github':
      return `GitHub (${short(trigger.repo, 60) || 'a repository'})`
    case 'path':
      return `a watched file (${short(trigger.path, 50)})`
    case 'command':
      return `the output of a watched command (${short(trigger.command, 40)})`
    default:
      return 'what a watch found'
  }
}

/** What the approval says about the run, so the user sees the risk before saying yes. */
export function riskLines(state: RunState): string[] {
  const out: string[] = []
  if (state.untrusted.length) out.push(`This run may have read text other people wrote: ${state.untrusted.slice(0, 3).join('; ')}${state.untrusted.length > 3 ? ' and more' : ''}. That text could be steering it.`)
  if (state.private) out.push('This run has read private data (your vault, memory, other chats or files outside its folder).')
  return out
}

/** A value as one stable string, so the same input always gives the same digest whatever order its keys came in. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

// ----- caps and the choice of account -----

export const APPROVAL_MS = 12 * 60 * 60 * 1000
/** Approvals one run may have open at once, and ask for in all. Beyond that it is refused: a run that keeps asking is not working. */
export const MAX_OPEN_ASKS = 5
export const MAX_ASKS_PER_RUN = 20

export function cleanCaps(c: Partial<UnattendedCaps> | undefined | null): UnattendedCaps {
  const n = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
  return { runsPerDay: n(c?.runsPerDay, DEFAULT_CAPS.runsPerDay, 0, 1000), runsPerAccount: n(c?.runsPerAccount, DEFAULT_CAPS.runsPerAccount, 0, 1000), keepFree: n(c?.keepFree, DEFAULT_CAPS.keepFree, 0, 100) }
}

/** The local calendar day a moment falls on. The counters start again when it changes. */
export function dayOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface PickAccount {
  id: string
  name: string
  provider: 'claude' | 'chatgpt'
  /** Switched on, signed in, and not out of allowance or running low. */
  usable: boolean
  /** Why not, when it is not usable. */
  unusable?: string
  /** Share (0 to 100) of the session window and of the week that is left. Undefined when not known. */
  sessionLeft?: number
  weekLeft?: number
}

/**
 * The account an unattended run may use: ChatGPT accounts first, then Claude, the one with the
 * most left first. Never one below the keep-free line, never past the day's caps. With no
 * account that may, the reason, in words the user can act on.
 */
export function pickAccount(accounts: PickAccount[], prefer: 'auto' | string | undefined, used: { runs: number; byAccount: Record<string, number> }, caps: UnattendedCaps): { accountId: string | null; why?: string } {
  if (caps.runsPerDay <= 0 || caps.runsPerAccount <= 0) return { accountId: null, why: 'Unattended runs are switched off (the daily limit is 0).' }
  if (used.runs >= caps.runsPerDay) return { accountId: null, why: `Today's limit of ${caps.runsPerDay} unattended runs is reached. It starts again at midnight.` }
  const named = prefer && prefer !== 'auto' ? accounts.filter((a) => a.id === prefer || a.name.toLowerCase() === prefer.toLowerCase()) : null
  if (named && !named.length) return { accountId: null, why: `There is no account called "${prefer}".` }
  const refusals: string[] = []
  // A window the provider does not report is not held against the account; one with neither known is.
  const left = (a: PickAccount): number => Math.min(a.sessionLeft ?? 100, a.weekLeft ?? 100)
  const ok = (named || accounts).filter((a) => {
    let why = ''
    if (!a.usable) why = a.unusable || 'cannot take work right now'
    else if ((used.byAccount[a.id] || 0) >= caps.runsPerAccount) why = `has done its ${caps.runsPerAccount} unattended runs for today`
    else if (a.sessionLeft === undefined && a.weekLeft === undefined) why = 'how much of its allowance is left is not known yet'
    else if (a.sessionLeft !== undefined && a.sessionLeft < caps.keepFree) why = `has ${Math.round(a.sessionLeft)}% of its session left, below the ${caps.keepFree}% kept free for you`
    else if (a.weekLeft !== undefined && a.weekLeft < caps.keepFree) why = `has ${Math.round(a.weekLeft)}% of its week left, below the ${caps.keepFree}% kept free for you`
    if (why) refusals.push(`${a.name} ${why}`)
    return !why
  })
  if (!ok.length) return { accountId: null, why: refusals.length ? `No account may run unattended work right now: ${refusals.join('; ')}.` : 'No account is connected.' }
  ok.sort((a, b) => Number(b.provider === 'chatgpt') - Number(a.provider === 'chatgpt') || left(b) - left(a))
  return { accountId: ok[0].id }
}
