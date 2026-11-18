import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { Codex, type CodexOptions, type Input, type Thread, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk'
import type { PermissionLevel } from '@shared/types'
import { IMAGE_EXT } from '@shared/tools'
import { cleanEnv, clip, uid } from '../util'
import type { AgentRuntime, RuntimeEvent, RuntimeOptions, TurnInput } from './types'

export function codexEnv(configDir: string | null): Record<string, string> {
  return cleanEnv({ CODEX_HOME: configDir ?? undefined })
}

export const codexHome = (configDir: string | null): string => configDir || path.join(os.homedir(), '.codex')

/**
 * The model an account's own settings file names, when it names one. That is what the account
 * runs when nothing is chosen for it, whatever the provider calls its default.
 */
export function codexOwnModel(configDir: string | null): string | undefined {
  try {
    const text = fs.readFileSync(path.join(codexHome(configDir), 'config.toml'), 'utf8')
    // Only the top of the file, before the first [section], holds the account-wide setting.
    const top = text.split(/^\s*\[/m)[0]
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] || undefined
  } catch {
    return undefined
  }
}

/**
 * What every ChatGPT agent's program is started with: the team's tool server and connectors, and
 * none of the program's own agent tools. Codex has helpers of its own (`collaboration.spawn_agent`
 * and the rest, its "multi_agent" feature) that a model reaches for before the team's
 * `spawn_agent`: agents started that way are invisible to the app, so a ChatGPT lead in Go crazy
 * looked as if it had started only one or two. `[agents].enabled = false` takes those tools away
 * (as the program's own config docs say), and the old `[features].multi_agent` switch covers its
 * fallback. The sleep tool goes too: reports are handed over between turns, so waiting holds them back.
 */
export function codexConfig(servers: Record<string, unknown>): Record<string, unknown> {
  return { ...(Object.keys(servers).length ? { mcp_servers: servers } : {}), features: { sleep_tool: false, multi_agent: false }, agents: { enabled: false } }
}

function threadOptions(o: RuntimeOptions, level: PermissionLevel): ThreadOptions {
  // Codex has no way to ask for approval when driven from another app, so the
  // permission level is expressed purely as how tight the sandbox is.
  const opts: ThreadOptions = {
    workingDirectory: o.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandboxMode: level === 'ask' ? 'read-only' : level === 'full' ? 'danger-full-access' : 'workspace-write',
    networkAccessEnabled: level === 'auto' || level === 'full',
    // Codex otherwise searches a cached index (live only at full access). Live search runs on
    // OpenAI's side, so it works at every sandbox level and gives current results.
    webSearchMode: 'live',
  }
  if (o.model) opts.model = o.model
  if (o.effort) opts.modelReasoningEffort = o.effort as ThreadOptions['modelReasoningEffort']
  if (o.extraDirs?.length) opts.additionalDirectories = o.extraDirs
  return opts
}

/** Codex wraps every command in a PowerShell invocation on Windows. Show the inner command. */
function prettyCommand(cmd: string): string {
  const m = /powershell(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(.*)$/is.exec(cmd)
  let inner = m ? m[1].trim() : cmd
  if (inner.length > 1 && ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'")))) {
    inner = inner.slice(1, -1)
  }
  return inner.replace(/\\"/g, '"')
}

export class CodexRuntime implements AgentRuntime {
  private codex: Codex
  private thread: Thread
  private abort: AbortController | null = null
  private disposed = false
  private interrupted = false
  /**
   * Words the person sent while a turn ran. A ChatGPT turn takes no input once it has started, so
   * the run is stopped at the next safe point and the same conversation carries on at once with
   * them: one piece of work for the app, two runs underneath.
   */
  private steerQueue: TurnInput[] = []
  /** The run under way was stopped to take in steered words, not by the person. */
  private steering = false
  private briefed: boolean
  private level: PermissionLevel
  private threadId: string | null

  constructor(private o: RuntimeOptions) {
    this.level = o.permission
    this.threadId = o.resumeId || null
    // A resumed conversation already has its briefing, unless the role or the team changed since.
    this.briefed = !!o.resumeId && o.briefed !== false
    // The team tools are ours and only touch the hub, so they never need a prompt
    // (Codex cannot show one when driven from another app anyway).
    // A tool call can wait on the person (the OK to use the computer), so it gets a long leash.
    const servers: Record<string, unknown> = { ...(o.connectors || {}), ...(o.toolsUrl ? { team: { url: o.toolsUrl, default_tools_approval_mode: 'approve', tool_timeout_sec: 900 } } : {}) }
    // Codex gives its models a sleep tool, and they use it to wait for a teammate's report. Reports
    // are only handed over between turns, so that waiting holds back the very thing it waits for.
    const config = codexConfig(servers) as unknown as CodexOptions['config']
    this.codex = new Codex({
      env: codexEnv(o.configDir),
      ...(o.executable ? { codexPathOverride: o.executable } : {}),
      config,
    })
    this.thread = this.makeThread()
  }

  private makeThread(): Thread {
    const opts = threadOptions(this.o, this.level)
    return this.threadId ? this.codex.resumeThread(this.threadId, opts) : this.codex.startThread(opts)
  }

  private emit(ev: RuntimeEvent): void {
    if (!this.disposed) this.o.host.emit(ev)
  }

  send(input: TurnInput): void {
    void this.run(input)
  }

  private async run(first: TurnInput): Promise<void> {
    const started = Date.now()
    this.interrupted = false
    this.steering = false
    this.abort = new AbortController()
    let input: TurnInput = first
    const ids = new Map<string, string>()
    const idFor = (raw: string): string => {
      let id = ids.get(raw)
      if (!id) ids.set(raw, (id = uid('x')))
      return id
    }
    const open = new Set<string>()
    let last = ''
    let steps = 0
    let error: string | undefined
    let ended = false
    let tokens: number | undefined

    for (;;) {
      let text = input.text
      if (!this.briefed) {
        const again = this.threadId ? 'Your role or the team has changed. This briefing replaces the one you were given earlier.\n\n' : ''
        text = `<team-briefing>\n${again}${this.o.briefing}\n</team-briefing>\n\n${text}`
        this.briefed = true
      }
      const payload: Input = input.images?.length
        ? [{ type: 'text', text }, ...input.images.map((p) => ({ type: 'local_image' as const, path: p }))]
        : text

      const onItem = (phase: 'started' | 'updated' | 'completed', item: ThreadItem): void => {
        const id = idFor(item.id)
        const begin = (name: string, inp: unknown): void => {
          if (open.has(id)) this.emit({ type: 'tool-input', id, input: inp })
          else {
            open.add(id)
            steps++
            this.emit({ type: 'tool-start', id, name, input: inp })
          }
        }
        const finish = (output: string, isError: boolean): void => {
          if (!open.has(id)) return
          open.delete(id)
          this.emit({ type: 'tool-end', id, output: clip(output, 16000), isError })
        }
        switch (item.type) {
          case 'agent_message':
            if (phase !== 'completed') return
            last = item.text
            this.emit({ type: 'text-start', id })
            this.emit({ type: 'text-end', id, text: item.text })
            return
          case 'reasoning':
            if (phase !== 'completed') return
            this.emit({ type: 'thinking-start', id })
            this.emit({ type: 'thinking-end', id, text: item.text })
            return
          case 'command_execution':
            begin('Shell', { command: prettyCommand(item.command) })
            if (phase === 'completed') finish(item.aggregated_output || '', item.status === 'failed' || (item.exit_code ?? 0) !== 0)
            return
          case 'file_change': {
            const names = item.changes.map((c) => path.basename(c.path))
            const summary = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ')
            begin('FileChange', { summary, changes: item.changes })
            finish(item.changes.map((c) => `${c.kind}  ${c.path}`).join('\n'), item.status === 'failed')
            return
          }
          case 'mcp_tool_call':
            begin(`mcp__${item.server}__${item.tool}`, item.arguments)
            if (phase === 'completed') {
              const out = item.error
                ? item.error.message
                : (item.result?.content || []).map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('\n')
              finish(out, item.status === 'failed')
            }
            return
          case 'web_search':
            begin('WebSearch', { query: item.query })
            if (phase === 'completed') finish('', false)
            return
          case 'todo_list':
            begin('Todo', { todos: item.items.map((t) => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) })
            if (phase === 'completed') finish('', false)
            return
          case 'error':
            // A task may ask for another model than the one before it: that is the app's doing, not a problem to report.
            if (phase === 'completed' && !/recorded with model .+ but is resuming with/i.test(item.message)) this.emit({ type: 'notice', level: 'warn', text: item.message })
            return
        }
      }

      try {
        const { events } = await this.thread.runStreamed(payload, { signal: this.abort.signal })
        for await (const ev of events) {
          if (ev.type === 'thread.started') {
            this.threadId = ev.thread_id
            this.emit({ type: 'session', sessionId: ev.thread_id, model: this.o.model || this.o.defaultModel || undefined })
          } else if (ev.type === 'item.started') onItem('started', ev.item)
          else if (ev.type === 'item.updated') onItem('updated', ev.item)
          else if (ev.type === 'item.completed') onItem('completed', ev.item)
          else if (ev.type === 'turn.failed') {
            error = ev.error.message
            ended = true
            break
          } else if (ev.type === 'error') {
            error = ev.message
          } else if (ev.type === 'turn.completed') {
            ended = true
            tokens = ev.usage?.output_tokens || undefined
            // The process can linger after the turn (it does after image
            // generation), so the event is the signal, not the exit.
            break
          }
        }
      } catch (e) {
        if (!this.interrupted && !this.steering) error = (e as Error).message
      } finally {
        try {
          this.abort?.abort()
        } catch {
          /* nothing left to stop */
        }
        this.abort = null
      }
      if (this.disposed) return
      // Stopped to take in what the person just said: the same conversation carries on at once.
      const more = this.steerQueue.splice(0)
      if (!more.length || this.interrupted || (error && !this.steering)) break
      for (const id of open) this.emit({ type: 'tool-end', id, output: 'Stopped here to read your new message.', isError: false })
      open.clear()
      error = undefined
      ended = false
      this.steering = false
      this.abort = new AbortController()
      input = {
        text: `${more.map((m) => m.text).join('\n\n')}\n\n(The person sent this while you were working, so your last step was stopped to let you read it. Carry on from where you were, taking it into account.)`,
        images: more.flatMap((m) => m.images || []),
        origin: { kind: 'human' },
      }
    }
    if (this.disposed) return

    for (const id of open) this.emit({ type: 'tool-end', id, output: '', isError: false })
    for (const p of this.newImages(started)) this.emit({ type: 'image', path: p })

    const limit = !!error && /usage limit|rate limit|quota|too many requests/i.test(error)
    const auth = !!error && /not logged in|login|unauthorized|401/i.test(error)
    this.emit({
      type: 'turn-end',
      status: this.interrupted ? 'interrupted' : error || !ended ? 'error' : 'done',
      resultText: last,
      durationMs: Date.now() - started,
      steps,
      tokens,
      reason: error ? (limit ? 'limit' : auth ? 'auth' : 'other') : undefined,
      error: this.interrupted ? undefined : error || (!ended ? 'The agent stopped before finishing.' : undefined),
    })
  }

  /** Images the built-in generator saved during this turn. */
  private newImages(since: number): string[] {
    if (!this.threadId) return []
    const dir = path.join(codexHome(this.o.configDir), 'generated_images', this.threadId)
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => IMAGE_EXT.test(f))
        .map((f) => path.join(dir, f))
        .filter((f) => fs.statSync(f).mtimeMs >= since - 1000)
    } catch {
      return []
    }
  }

  steer(input: TurnInput): boolean {
    if (this.disposed || !this.abort || this.interrupted) return false
    this.steerQueue.push(input)
    // A ChatGPT run takes no input once started: stop it where it is (a command or search is cut
    // short; files already written stay written) and carry on with the new words.
    if (!this.steering) {
      this.steering = true
      this.abort.abort()
    }
    return true
  }

  async interrupt(): Promise<void> {
    if (!this.abort) return
    this.interrupted = true
    // What was steered in and not yet read goes with the stopped work.
    this.steerQueue = []
    this.abort.abort()
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    this.level = level
    this.o.permission = level
    if (!this.abort) this.thread = this.makeThread()
  }

  dispose(): void {
    this.disposed = true
    try {
      this.abort?.abort()
    } catch {
      /* nothing running */
    }
  }
}

/**
 * One answer from a ChatGPT account that knows nothing of any chat: a check, a rewrite, a title.
 * It runs the account's program directly for one turn: read-only, on no settings but the app's
 * own (so none of the user's connectors are started for it), and leaving no session behind in
 * the account's history. This is what lets a team with no Claude account have a fresh checker,
 * titles and the improver.
 */
export function askCodexOnce(o: {
  configDir: string | null
  cwd: string
  executable?: string | null
  system: string
  prompt: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error('Cancelled.'))
    if (!o.executable) return reject(new Error('The ChatGPT runtime was not found.'))
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--json', '-s', 'read-only', '-c', `model_reasoning_effort=${o.effort || 'low'}`, '-c', 'features.sleep_tool=false']
    if (o.model) args.push('-m', o.model)
    // The message itself comes in on standard input, so its length is never a problem.
    args.push('-')
    const child = spawn(o.executable, args, { cwd: o.cwd, env: codexEnv(o.configDir), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let error: string | undefined
    let settled = false
    let buffer = ''
    let stderr = ''
    const finish = (fail?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      // The process can linger after its turn; this ends it.
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      if (fail) reject(fail)
      // An error is thrown, never passed off as the answer.
      else if (!out.trim()) reject(new Error(error || stderr.trim().split('\n').pop() || 'No answer came back.'))
      else resolve(out.trim())
    }
    const onAbort = (): void => finish(new Error('Cancelled.'))
    o.signal?.addEventListener('abort', onAbort)
    const timer = o.timeoutMs ? setTimeout(() => finish(new Error('Timed out.')), o.timeoutMs) : null
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('{')) continue
        try {
          const ev = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string }
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') out = ev.item.text
          else if (ev.type === 'turn.failed') {
            error = ev.error?.message || 'The reply failed.'
            finish()
          } else if (ev.type === 'error') error = ev.message
          else if (ev.type === 'turn.completed') finish()
        } catch {
          /* not an event line */
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk
    })
    child.on('error', (e) => finish(e))
    child.on('close', () => finish())
    const text = `<instructions>\n${o.system}\n\nAnswer from what is written in this message alone, in one reply. Do not run commands, read files or search: there is nothing to look at.\n</instructions>\n\n${o.prompt}`
    child.stdin.on('error', () => undefined)
    child.stdin.end(text, 'utf8')
  })
}

export function codexLoginStatus(executable: string, configDir: string | null): Promise<{ signedIn: boolean; method?: string }> {
  return new Promise((resolve) => {
    execFile(executable, ['login', 'status'], { env: codexEnv(configDir), windowsHide: true, timeout: 15000 }, (_err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`
      const m = /Logged in using (.+)/i.exec(out)
      resolve(m ? { signedIn: true, method: m[1].trim() } : { signedIn: false })
    })
  })
}
