// The execution trace: what the team actually did in a chat, written down as it happens so a
// result can be reproduced and a failure diagnosed. And the evidence drawn from it: what changed,
// what ran, what passed and what is still uncertain, which is what the window shows under a result
// instead of somebody's word for it. Everything here is pure, so the engine and the checks share it.

import type { PermissionLevel } from './types'

/** One line of a chat's trace file. `ts` is when it happened; `agent` is who did it. */
export type TraceRecord =
  | {
      t: 'turn-start'
      ts: number
      agent: string
      name: string
      /** Who started this agent (an account or another agent), when it was started inside the chat. */
      by?: string
      /** 0 for an account, 1 for an agent the lead started, and so on. */
      depth: number
      /** What set the turn off: the person, a task, a teammate's note or question, a goal round or loop run. */
      kind: 'user' | 'task' | 'team' | 'ask' | 'auto'
      task?: string
      /** The exact model the turn was asked to run on, when one was chosen for it. */
      model?: string
      effort?: string
      permission: PermissionLevel
      /** The provider's own id of the conversation, so it can be found again. */
      session?: string
      provider: string
    }
  | {
      t: 'turn-end'
      ts: number
      agent: string
      /** The id of the "turn" row in the transcript this ended with. */
      item: string
      status: 'done' | 'interrupted' | 'error'
      ms?: number
      steps?: number
      tokens?: number
      /** The model that actually answered. */
      model?: string
      /** The start of what was said last, clipped. */
      said?: string
      /** For a turn that ended with an error: what the app told the person, clipped. */
      error?: string
    }
  | {
      t: 'tool'
      ts: number
      agent: string
      id: string
      name: string
      /** The input in a line, clipped and with anything secret-looking taken out. */
      input: string
      ok: boolean
      ms?: number
      /** For a shell step: the command. */
      command?: string
      /** For a file step: the files it wrote or changed. */
      paths?: string[]
      /** A short hash of each file after the step, in the order of `paths`, when it could be read. */
      hashes?: (string | null)[]
      /** A test or build run recognised from the command, and whether it passed. */
      run?: { what: string; passed: boolean; summary?: string }
      /** A page it opened or searched. */
      url?: string
      /** The end of the output of a failed step, clipped. */
      tail?: string
    }
  | {
      t: 'task'
      ts: number
      id: string
      from: string
      to: string
      title: string
      status: string
      waitingOn?: string[]
      model?: string
      effort?: string
      retried?: boolean
      /** Started by this task's owner for part of its own work. */
      parent?: string
      /** What its owner reported, for a task that finished, clipped and with secrets taken out. */
      result?: string
    }
  | { t: 'auto'; ts: number; agent: string; of: 'goal' | 'loop'; event: string; title: string; text?: string; round?: number; max?: number }
  | { t: 'made'; ts: number; agent: string; path: string; media?: string }
  | { t: 'ask'; ts: number; agent: string; what: 'permission' | 'question'; title: string; answer?: string }
  | {
      /** A decision of the guard in a run nobody is watching (src/main/guard.ts). */
      t: 'guard'
      ts: number
      agent?: string
      tool?: string
      /** The class the tool was sorted into, or what the run was marked with. */
      c?: string
      /** allowed, asked, denied; an approval allowed, denied, expired, revoked; the run marked or stopped. */
      v: string
      why?: string
      /** The approval this belongs to, the start of the digest of the call it covers, and when it lapses. */
      approval?: string
      digest?: string
      summary?: string
      expires?: number
    }

/** What the evidence is asked about. */
export type EvidenceRef =
  /** A finished reply: everything the team did since the person's message that it answers. */
  | { kind: 'turn'; accountId: string; itemId: string }
  /** One task: what its owner (and the agents it started) did while it ran. */
  | { kind: 'task'; taskId: string }
  /** The chat's goal: from when it was set until now, or until it ended. */
  | { kind: 'goal' }

export interface Evidence {
  /** The stretch of time it covers. */
  from: number
  to: number
  /** Files written or changed, with how often and by whom. */
  changed: { path: string; edits: number; by: string[]; hash?: string }[]
  /** Commands that were run, in order, with how each ended. */
  ran: { command: string; ok: boolean; ms?: number; by: string; ts: number }[]
  /** What was seen to pass: test and build runs, and a checker's verdict. Only what was observed. */
  passed: { what: string; detail?: string; by?: string; ts: number }[]
  /** What nobody showed: failed steps not put right, changes with no run after them, what the reply itself says was not checked. */
  uncertain: { what: string; detail?: string }[]
  /**
   * Reviews of the work by someone who did not do it: a reviewer's or judge's task, and each round
   * of a goal's check. `ok`: nothing in it stands in the way. `earlier`: a later round settled it,
   * so it is history, not the state the work is in now.
   */
  reviewed: { by: string; what: string; verdict: string; ok: boolean; ts: number; earlier?: boolean }[]
  /** Who worked on it, for the record. */
  agents: string[]
  models: string[]
}

export const NO_EVIDENCE: Evidence = { from: 0, to: 0, changed: [], ran: [], passed: [], uncertain: [], reviewed: [], agents: [], models: [] }

// ───────────── reading a step ─────────────

/** Tools that run a command. */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell', 'BashOutput'])
/** Tools that write or change files. */
export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'FileChange'])

const RUNNERS: { what: string; match: RegExp }[] = [
  { what: 'Type check', match: /\b(tsc|typecheck|type-check|mypy|pyright)\b/i },
  { what: 'Tests', match: /\b(vitest|jest|mocha|ava|playwright test|cypress run|pytest|py\.test|unittest|tox|nox|go test|cargo test|dotnet test|mvn (?:\S+ )*test|gradle\w* (?:\S+ )*test|rspec|phpunit|ctest|deno test|bun test)\b/i },
  { what: 'Tests', match: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|test:\S+|auto-test|e2e|check)\b/i },
  { what: 'Lint', match: /\b(eslint|biome (check|lint)|ruff( check)?|flake8|pylint|clippy|golangci-lint|stylelint)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b/i },
  { what: 'Build', match: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(vite build|next build|webpack|rollup -c|cargo build|go build|dotnet build|mvn (?:\S+ )*package|gradle\w* (?:\S+ )*build|make( all)?|cmake --build|msbuild)\b/i },
]

/** A test, build, lint or type-check run, told from its command. null for any other command. */
export function runOf(command: string): string | null {
  const c = command.replace(/\s+/g, ' ')
  // Looking at a tool is not running it.
  if (/^\s*(cat|type|less|more|head|tail|grep|rg|findstr|ls|dir|echo|which|where|Get-Content|Select-String)\b/i.test(c) && !/[;&|]\s*(npm|pnpm|yarn|bun|npx|pytest|cargo|go|tsc)\b/i.test(c)) return null
  return RUNNERS.find((r) => r.match.test(c))?.what || null
}

/** The line of a run's output that says how it went ("12 passed", "3 failed", "0 errors"), when there is one. */
export function runSummary(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
    const l = lines[i]
    if (/\b\d+\s+(passed|passing|failed|failing|errors?|tests?)\b/i.test(l) || /\b(passed|failed)[, ]+\d+/i.test(l) || /^(ok|FAIL|PASS)\b/.test(l) || /\bFound \d+ errors?\b/i.test(l)) return l.length > 140 ? `${l.slice(0, 139)}…` : l
  }
  return undefined
}

const SECRET_PAIR = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|passwd|password|pwd|authorization|credential|private[_-]?key|access[_-]?key|session[_-]?id|cookie)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(?:bearer\s+)?("[^"]*"|'[^']*'|[^\s"',;&|]+)/gi
const SECRET_SHAPES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]
/** A long run of letters and digits with no spaces: a key far more often than prose, unless it reads as words (see readable). */
const LONG_RUN = /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}\b/g

/**
 * A branch name or a path, such as fix/issue-142-annual-toggle-shows-monthly-prices: three or more
 * parts between separators, each a word (perhaps ending in a short number, like utf8 or v2) or a
 * short number. A key is one jumble of letters and digits, so it never reads this way.
 */
function readable(run: string): boolean {
  const parts = run.replace(/=+$/, '').split(/[-_/+]+/).filter(Boolean)
  return parts.length >= 3 && parts.every((p) => p.length <= 24 && /^(?:[A-Za-z]+\d{0,3}|\d{1,4})$/.test(p))
}

/** Text made safe to write down: anything that looks like a key, token or password is taken out. */
export function redact(text: string): string {
  let s = text.replace(SECRET_PAIR, (_m, k: string, sep: string) => `${k}${sep}[hidden]`)
  for (const re of SECRET_SHAPES) s = s.replace(re, '[hidden]')
  return s.replace(LONG_RUN, (m) => (readable(m) ? m : '[hidden]'))
}

const clipLine = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A step's input in one safe line. */
export function inputLine(name: string, input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return clipLine(redact(input), 300)
  const o = input as Record<string, unknown>
  const pick = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description', 'summary', 'title', 'to', 'name'].filter((k) => typeof o[k] === 'string' && o[k])
  const text = pick.length ? pick.map((k) => (pick.length === 1 || k === 'command' ? String(o[k]) : `${k}: ${String(o[k])}`)).join(' · ') : JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : k === 'content' || k === 'new_string' || k === 'old_string' ? undefined : v))
  return clipLine(redact(text || name), 300)
}

/** The command of a shell step, or undefined when it is not one. */
export function commandOf(name: string, input: unknown): string | undefined {
  if (!SHELL_TOOLS.has(name)) return undefined
  const c = (input as { command?: unknown } | null)?.command
  return typeof c === 'string' && c.trim() ? clipLine(redact(c), 600) : undefined
}

/** The files a step wrote or changed. */
export function pathsOf(name: string, input: unknown): string[] {
  if (!FILE_TOOLS.has(name) || !input || typeof input !== 'object') return []
  const o = input as Record<string, unknown>
  const out: string[] = []
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof o[k] === 'string' && o[k]) out.push(o[k] as string)
  if (Array.isArray(o.changes)) for (const c of o.changes as Record<string, unknown>[]) if (typeof c?.path === 'string') out.push(c.path)
  return [...new Set(out)].slice(0, 40)
}

/** The page a step opened or the search it made. */
export function urlOf(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  if (typeof o.url === 'string' && /^https?:/i.test(o.url)) return clipLine(redact(o.url), 300)
  if (/search/i.test(name) && typeof o.query === 'string') return `search: ${clipLine(redact(o.query), 200)}`
  return undefined
}

// ───────────── drawing the evidence ─────────────

const same = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/** What a reply itself says it did not check: sentences after "Not checked:", and plain admissions. */
export function admitted(said: string): string[] {
  const out: string[] = []
  const text = said.replace(/\*\*/g, '')
  // Up to the end of the sentence: a full stop followed by a new sentence, or the end of the line.
  for (const m of text.matchAll(/\bnot (?:checked|verified|tested)\s*:\s*([^\n]+?)(?=\.\s+[A-Z]|\.?\s*(?:\n|$))/gi)) {
    const s = m[1].trim().replace(/[.;]\s*$/, '')
    if (s && !/^(nothing|none|n\/a|-)\b/i.test(s)) out.push(s)
  }
  for (const m of text.matchAll(/[^.\n]*\b(?:could not|couldn't|was not able to|wasn't able to|unable to|did not|didn't|have not|haven't)\s+(?:run|test|verify|check|reproduce|open|build)[^.\n]*/gi)) {
    const s = m[0].trim()
    if (s.length > 12 && !out.some((x) => x.includes(s) || s.includes(x))) out.push(s)
  }
  for (const m of text.matchAll(/[^.\n]*\b(?:should (?:now )?(?:work|pass|be fixed)|untested|not been tested)\b[^.\n]*/gi)) {
    const s = m[0].trim()
    if (s.length > 12 && !out.some((x) => x.includes(s) || s.includes(x))) out.push(s)
  }
  return out.slice(0, 6).map((s) => (s.length > 220 ? `${s.slice(0, 219)}…` : s))
}

/** A task that reviews or judges work its owner did not do: its report is evidence of its own. */
export const REVIEW_TASK = /\b(review|judge|judging|critique|critic|verify|verification|audit|fact-check|second opinion|assess|evaluate|inspect)/i

/**
 * What a review names as open: gaps, missing tests, problems, risks, plus what it admits it did
 * not check. Lines that say there is nothing ("no problems found") do not count.
 */
export function gapsIn(report: string): string[] {
  const out: string[] = []
  const text = report.replace(/\*\*/g, '').replace(/`/g, '')
  const pieces = text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)
  for (const p of pieces) {
    if (!/\b(gaps?|missing|no tests?|not covered|uncovered|untested|not tested|(?:does not|doesn't|do not|don't) handle|fails? to|issues?|bugs?|risks?|concerns?|problems?|could break|breaks|wrong|incorrect|edge case)\b/i.test(p)) continue
    if (/\b(no|nothing|none|zero|without)\b[^.:]{0,40}\b(issues?|problems?|concerns?|bugs?|risks?|gaps?|blockers?|block)\b(?![^.]*:)/i.test(p) && !/:/.test(p)) continue
    const s = p.replace(/^(?:one |a |another )?(?:gap|issue|problem|risk|concern)\s*:\s*/i, '').replace(/[.;]\s*$/, '')
    if (s.length > 8 && !out.some((x) => x === s)) out.push(s.length > 220 ? `${s.slice(0, 219)}…` : s)
  }
  for (const a of admitted(report)) if (!out.some((x) => x.includes(a) || a.includes(x))) out.push(a)
  return out.slice(0, 6)
}

/** The first sentence of a report: what it concluded. */
function verdictOf(report: string): string {
  const first = report.replace(/\*\*/g, '').replace(/`/g, '').split(/\n/).map((x) => x.trim()).find((x) => x && !/^#/.test(x)) || ''
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] || first
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence
}

/**
 * The evidence in a stretch of a chat's trace. `records` are the chat's records in the order they
 * were written; `from` and `to` bound the stretch; `agents`, when given, keeps only what those did.
 * `nameOf` turns an agent's id into the name the person knows.
 */
export function evidenceOf(records: TraceRecord[], from: number, to: number, nameOf: (id: string) => string = (id) => id, agents?: Set<string>, opts: { reply?: string } = {}): Evidence {
  const inScope = (r: TraceRecord): boolean => r.ts >= from && r.ts <= to && (!agents || !('agent' in r) || !r.agent || agents.has(r.agent))
  const recs = records.filter(inScope)
  const changed: Evidence['changed'] = []
  const ran: Evidence['ran'] = []
  const passed: Evidence['passed'] = []
  const uncertain: Evidence['uncertain'] = []
  const who = new Set<string>()
  const models = new Set<string>()
  /** The latest run of each kind, and when files last changed. */
  const lastRun = new Map<string, { passed: boolean; ts: number; command: string; summary?: string; by: string }>()
  let lastChange = 0
  const failedSteps: { name: string; input: string; tail?: string; by: string; agent: string; ts: number; command?: string }[] = []
  let lastSaid = ''
  /** Turns that were stopped, and tasks that did not finish: told together, after the records are read. */
  const stops: { agent: string; self: boolean; ts: number }[] = []
  const unfinished: { id: string; to: string; title: string; status: string }[] = []
  /** Tasks that were seen running: one that never ran was called off, not stopped part way. */
  const began = new Set<string>()
  /** Each round of a goal's check, in order. */
  const checks: { met: boolean; text?: string; round?: number; ts: number }[] = []
  /** Each reviewer's or judge's finished task, the last record of it. */
  const reviews = new Map<string, { by: string; title: string; result: string; ts: number }>()

  for (const r of recs) {
    if (r.t === 'turn-start') {
      who.add(nameOf(r.agent))
      if (r.model) models.add(r.model)
    } else if (r.t === 'turn-end') {
      if (r.model) models.add(r.model)
      if (r.said) lastSaid = r.said
      // The reply itself is told plainly; a teammate's turn by its name.
      const self = !!opts.reply && r.item === opts.reply
      if (r.status === 'error') uncertain.push(self ? { what: r.error ? `Ended with an error: ${r.error}` : 'Ended with an error before finishing' } : { what: `${nameOf(r.agent)} stopped with a problem before finishing`, detail: r.error })
      else if (r.status === 'interrupted') stops.push({ agent: r.agent, self, ts: r.ts })
    } else if (r.t === 'tool') {
      const by = nameOf(r.agent)
      if (r.paths?.length && r.ok) {
        lastChange = r.ts
        r.paths.forEach((p, i) => {
          const e = changed.find((c) => same(c.path, p))
          const hash = r.hashes?.[i] || undefined
          if (e) {
            e.edits++
            if (!e.by.includes(by)) e.by.push(by)
            if (hash) e.hash = hash
          } else changed.push({ path: p, edits: 1, by: [by], hash })
        })
      }
      if (r.command) {
        ran.push({ command: r.command, ok: r.ok, ms: r.ms, by, ts: r.ts })
        if (r.run) lastRun.set(r.run.what, { passed: r.run.passed, ts: r.ts, command: r.command, summary: r.run.summary, by })
      }
      if (!r.ok) failedSteps.push({ name: r.name, input: r.input, tail: r.tail, by, agent: r.agent, ts: r.ts, command: r.command })
    } else if (r.t === 'auto' && r.of === 'goal') {
      if (r.event === 'met') checks.push({ met: true, text: r.text, round: r.round, ts: r.ts })
      else if (r.event === 'check' && r.text) checks.push({ met: false, text: r.text, round: r.round, ts: r.ts })
    } else if (r.t === 'task') {
      if (r.status === 'running') began.add(r.id)
      if (r.status === 'failed' || r.status === 'interrupted' || r.status === 'cancelled') {
        const i = unfinished.findIndex((u) => u.id === r.id)
        if (i >= 0) unfinished.splice(i, 1)
        unfinished.push({ id: r.id, to: r.to, title: r.title, status: r.status })
      }
      else if (r.status === 'done' && r.result && REVIEW_TASK.test(r.title)) reviews.set(r.id, { by: nameOf(r.to), title: r.title, result: r.result, ts: r.ts })
    }
  }

  // Every round of the goal's check is a review of its own; only the latest says where things
  // stand now. An earlier "not there yet" stays, as an earlier round.
  const reviewed: Evidence['reviewed'] = []
  checks.forEach((ch, i) => {
    const last = i === checks.length - 1
    const round = ch.round ?? i + 1
    reviewed.push({ by: 'Goal checker', what: `Round ${round}`, verdict: ch.met ? `Met${ch.text ? `. ${ch.text}` : ''}` : `Not there yet${ch.text ? `. ${ch.text}` : ''}`, ok: ch.met, ts: ch.ts, earlier: !last || undefined })
    if (last && ch.met) passed.push({ what: 'The goal was checked and is met', detail: ch.text, ts: ch.ts })
    else if (last) uncertain.push({ what: 'The checker said it is not there yet', detail: ch.text })
  })
  // A reviewer or judge who did none of the work: who, what they concluded, and the gaps they named.
  for (const rv of reviews.values()) {
    const gaps = gapsIn(rv.result)
    reviewed.push({ by: rv.by, what: rv.title, verdict: verdictOf(rv.result), ok: !gaps.length, ts: rv.ts })
    for (const g of gaps) uncertain.push({ what: `${rv.by}'s review named a gap`, detail: g })
  }

  for (const [what, run] of lastRun) {
    if (run.passed) passed.push({ what: `${what} passed`, detail: run.summary || run.command, by: run.by, ts: run.ts })
    else uncertain.push({ what: `${what} failed on the last run`, detail: run.summary || run.command })
    if (run.passed && lastChange > run.ts) uncertain.push({ what: `Files changed after the last ${what.toLowerCase()} run`, detail: 'It was not run again on the final state.' })
  }
  if (changed.length && !lastRun.size) uncertain.push({ what: 'Files changed, and no test, build or check was run', detail: 'Nothing in the record shows the change working.' })

  // A step that was under way when its agent was stopped did not fail: it was cut short. It is told
  // with the stop ("while: Write src/a.ts"), not as a failure.
  const cut = new Map<string, string>()
  const stoppedAfter = (f: { agent: string; ts: number }): boolean => {
    const end = recs.find((r) => r.t === 'turn-end' && r.agent === f.agent && r.ts >= f.ts)
    return !!end && end.t === 'turn-end' && end.status === 'interrupted'
  }
  const kept = failedSteps.filter((f) => {
    if (f.tail || !stoppedAfter(f)) return true
    if (!cut.has(f.agent)) cut.set(f.agent, `while: ${f.command || `${f.name}${f.input ? ` ${f.input.length > 80 ? `${f.input.slice(0, 79)}…` : f.input}` : ''}`}`)
    return false
  })
  // A task that did not finish says what it was; its owner's stop is then not said again.
  const told = new Set<string>()
  for (const u of unfinished) {
    const stopped = u.status === 'interrupted' || u.status === 'cancelled'
    if (stopped && !began.has(u.id)) {
      uncertain.push({ what: `"${u.title}" was called off before it started (${nameOf(u.to)})` })
      continue
    }
    uncertain.push({ what: stopped ? `"${u.title}" was stopped before finishing (${nameOf(u.to)})` : `"${u.title}" did not finish (${nameOf(u.to)})`, detail: cut.get(u.to) })
    told.add(u.to)
  }
  for (const st of stops) {
    if (st.self) uncertain.push({ what: 'Stopped before finishing', detail: cut.get(st.agent) })
    else if (!told.has(st.agent)) uncertain.push({ what: `${nameOf(st.agent)} was stopped before finishing`, detail: cut.get(st.agent) })
    told.add(st.agent)
  }

  // A failed step counts unless the same command, or the same kind of run, went through later.
  for (const f of kept) {
    const kind = f.command ? runOf(f.command) : null
    if (kind) continue // already said by the run lines above
    const retried = f.command ? ran.some((x) => x.ok && x.ts > f.ts && x.command === f.command) : false
    if (retried) continue
    uncertain.push({ what: f.command ? `A command failed: ${f.command.length > 120 ? `${f.command.slice(0, 119)}…` : f.command}` : `A step failed: ${f.name}${f.input ? ` (${f.input.length > 80 ? `${f.input.slice(0, 79)}…` : f.input})` : ''}`, detail: f.tail })
  }
  for (const s of admitted(lastSaid)) uncertain.push({ what: 'The reply says', detail: s })

  // The same thing said twice helps nobody.
  const seen = new Set<string>()
  const uniq = uncertain.filter((u) => {
    const k = `${u.what}|${u.detail || ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { from, to, changed, ran, passed: passed.sort((a, b) => a.ts - b.ts), uncertain: uniq.slice(0, 12), reviewed: reviewed.sort((a, b) => a.ts - b.ts), agents: [...who], models: [...models] }
}

/**
 * The stretch of the trace a finished reply answers: from the message or task that set it off to
 * the reply's end. `own` says it was a task, so only that agent's work (and its helpers') counts.
 */
export function replySpan(records: TraceRecord[], accountId: string, itemId: string): { from: number; to: number; own: boolean } | null {
  const end = records.findIndex((r) => r.t === 'turn-end' && r.agent === accountId && r.item === itemId)
  if (end < 0) return null
  let from = records[end].ts
  let own = false
  for (let i = end; i >= 0; i--) {
    const r = records[i]
    if (r.t === 'turn-start' && r.agent === accountId) {
      from = r.ts
      // The person's message, or the task it was handed, is where this piece of work began. Turns
      // in between (reports coming in, a teammate's question, a goal's next round) belong to it.
      if (r.kind === 'user' || r.kind === 'task') {
        own = r.kind === 'task'
        break
      }
    }
  }
  return { from, to: records[end].ts, own }
}

/** Evidence in one line, for the collapsed block. Empty when there is nothing to show. */
export function evidenceLine(e: Evidence): string {
  const parts: string[] = []
  if (e.changed.length) parts.push(`${e.changed.length} ${e.changed.length === 1 ? 'file' : 'files'} changed`)
  if (e.ran.length) parts.push(`${e.ran.length} ${e.ran.length === 1 ? 'command' : 'commands'} ran`)
  for (const p of e.passed) parts.push(p.what.charAt(0).toLowerCase() + p.what.slice(1))
  // Reviewers by name (the goal's checker is already said by "the goal was checked").
  const by = [...new Set((e.reviewed || []).filter((r) => r.by !== 'Goal checker').map((r) => r.by))]
  if (by.length) parts.push(`reviewed by ${by.length > 2 ? `${by.slice(0, 2).join(', ')} and ${by.length - 2} more` : by.join(' and ')}`)
  if (e.uncertain.length) parts.push(`${e.uncertain.length} ${e.uncertain.length === 1 ? 'thing' : 'things'} unverified`)
  return parts.slice(0, 5).join(' · ')
}

// ───────────── what the window decides ─────────────

/** How a reply ended, as its row in the transcript says. */
export type ReplyEnd = { status: 'done' | 'interrupted' | 'error'; steps?: number; durationMs: number }

/**
 * Whether the window should read the evidence for a reply at all. A finished reply that took no
 * step did nothing there could be evidence of; a stopped or failed one is always read, since what
 * it changed before it ended is exactly what needs seeing.
 */
export function evidenceWanted(end: ReplyEnd): boolean {
  if (end.status !== 'done') return true
  return (end.steps || 0) > 0 || end.durationMs >= 4000
}

/**
 * Whether the block is shown. A finished reply shows it when there is anything to say; a stopped
 * or failed one only when it changed or ran something (its "Stopped before finishing" alone is
 * already said by the transcript).
 */
export function evidenceShown(end: ReplyEnd, e: Evidence | null): boolean {
  if (!e) return false
  if (end.status !== 'done') return e.changed.length > 0 || e.ran.length > 0
  return evidenceLine(e) !== ''
}

/**
 * What the evidence of a chat's latest work depends on, as one string: when it changes (a goal's
 * check, a task's result, more records), the window reads the evidence again instead of keeping
 * what it read when the reply ended.
 */
export function evidenceStamp(s: { goal?: { status: string; checking?: boolean; log?: unknown[] } | null; tasks: { id: string; status: string }[]; records: number }): string {
  const g = s.goal ? `${s.goal.status}:${s.goal.checking ? 1 : 0}:${s.goal.log?.length || 0}` : '-'
  const t = s.tasks.map((x) => `${x.id}=${x.status}`).join(',')
  return `${g}|${t}|${s.records}`
}
