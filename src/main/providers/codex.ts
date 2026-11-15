import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { Codex, type CodexOptions, type Input, type Thread, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk'
import type { PermissionLevel } from '@shared/types'
import { IMAGE_EXT } from '@shared/tools'
import { cleanEnv, clip, uid } from '../util'
import type { AgentRuntime, RuntimeEvent, RuntimeOptions, TurnInput } from './types'

export function codexEnv(configDir: string | null): Record<string, string> {
  return cleanEnv({ CODEX_HOME: configDir ?? undefined })
}

export const codexHome = (configDir: string | null): string => configDir || path.join(os.homedir(), '.codex')

function threadOptions(o: RuntimeOptions, level: PermissionLevel): ThreadOptions {
  // Codex has no way to ask for approval when driven from another app, so the
  // permission level is expressed purely as how tight the sandbox is.
  const opts: ThreadOptions = {
    workingDirectory: o.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandboxMode: level === 'ask' ? 'read-only' : level === 'full' ? 'danger-full-access' : 'workspace-write',
    networkAccessEnabled: level === 'auto' || level === 'full',
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
  private briefed: boolean
  private level: PermissionLevel
  private threadId: string | null

  constructor(private o: RuntimeOptions) {
    this.level = o.permission
    this.threadId = o.resumeId || null
    this.briefed = !!o.resumeId
    // The team tools are ours and only touch the hub, so they never need a prompt
    // (Codex cannot show one when driven from another app anyway).
    // A tool call can wait on the person (the OK to use the computer), so it gets a long leash.
    const servers: Record<string, unknown> = { ...(o.connectors || {}), ...(o.toolsUrl ? { team: { url: o.toolsUrl, default_tools_approval_mode: 'approve', tool_timeout_sec: 900 } } : {}) }
    const config = Object.keys(servers).length ? ({ mcp_servers: servers } as unknown as CodexOptions['config']) : undefined
    this.codex = new Codex({
      env: codexEnv(o.configDir),
      ...(o.executable ? { codexPathOverride: o.executable } : {}),
      ...(config ? { config } : {}),
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

  private async run(input: TurnInput): Promise<void> {
    const started = Date.now()
    this.interrupted = false
    this.abort = new AbortController()
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

    let text = input.text
    if (!this.briefed) {
      text = `<team-briefing>\n${this.o.briefing}\n</team-briefing>\n\n${text}`
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
          if (phase === 'completed') this.emit({ type: 'notice', level: 'warn', text: item.message })
          return
      }
    }

    try {
      const { events } = await this.thread.runStreamed(payload, { signal: this.abort.signal })
      for await (const ev of events) {
        if (ev.type === 'thread.started') {
          this.threadId = ev.thread_id
          this.emit({ type: 'session', sessionId: ev.thread_id, model: this.o.model || undefined })
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
      if (!this.interrupted) error = (e as Error).message
    } finally {
      try {
        this.abort?.abort()
      } catch {
        /* nothing left to stop */
      }
      this.abort = null
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

  async interrupt(): Promise<void> {
    if (!this.abort) return
    this.interrupted = true
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

export function codexLoginStatus(executable: string, configDir: string | null): Promise<{ signedIn: boolean; method?: string }> {
  return new Promise((resolve) => {
    execFile(executable, ['login', 'status'], { env: codexEnv(configDir), windowsHide: true, timeout: 15000 }, (_err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`
      const m = /Logged in using (.+)/i.exec(out)
      resolve(m ? { signedIn: true, method: m[1].trim() } : { signedIn: false })
    })
  })
}
