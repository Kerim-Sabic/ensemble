import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  query,
  createSdkMcpServer,
  tool,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AccountUsage, CommandInfo, ModelOption, PermissionLevel, QuestionSpec, RewindPreview, UsageWindow } from '@shared/types'
import { AsyncQueue, cleanEnv, clip, mimeOf, uid } from '../util'
import { toolContent, type AgentRuntime, type RuntimeEvent, type RuntimeOptions, type TeamTool, type TurnInput } from './types'

const MODE: Record<PermissionLevel, PermissionMode> = {
  ask: 'default',
  edits: 'acceptEdits',
  auto: 'auto',
  full: 'bypassPermissions',
}

export function claudeEnv(configDir: string | null): Record<string, string> {
  return cleanEnv({
    CLAUDE_CONFIG_DIR: configDir ?? undefined,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'ensemble/3.4.3',
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
  })
}

/** Tools that change files, which is what makes a turn worth an undo point. */
const EDITING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Commands that only make sense inside Claude Code's own terminal window.
const HIDDEN_COMMANDS = new Set(
  'login logout exit quit clear config theme vim terminal-setup ide doctor upgrade resume model effort permissions help status statusline install-github-app mobile desktop chrome bug feedback release-notes privacy-settings extra-usage rename export copy add-dir agents hooks mcp plugin memory output-style sandbox tasks todos rewind fast keybindings stickers passes think-back usage cost stats color btw voice remote-control teleport tag fork plan schedule loop workflows artifacts heapdump workflow-launch-exec design-consent design-revoke design-sync reload-plugins reload-skills auto-mode-setup autocompact usage-credits team-onboarding list-agents run-skill-generator import focus advisor update-config fewer-permission-prompts plugin-authoring workflow-authoring skill-doctor'.split(
    ' ',
  ),
)

function teamServer(tools: TeamTool[]) {
  return createSdkMcpServer({
    name: 'team',
    version: '1.0.0',
    alwaysLoad: true,
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.schema,
        async (args) => {
          try {
            return toolContent(await t.run(args as Record<string, unknown>))
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `Failed: ${(e as Error).message}` }], isError: true }
          }
        },
        { alwaysLoad: true },
      ),
    ),
  })
}

type Windows = Record<string, { utilization?: number | null; resetsAt?: number | null; status?: UsageWindow['status'] } | undefined>

/** Rate-limit events carry fractions and epoch seconds. */
function usageFromEvent(info: Record<string, unknown>): Omit<AccountUsage, 'accountId' | 'updatedAt'> | null {
  const out: Omit<AccountUsage, 'accountId' | 'updatedAt'> = {}
  const win = (w: Windows[string]): UsageWindow | undefined =>
    w && typeof w.utilization === 'number'
      ? { utilization: Math.min(1, Math.max(0, w.utilization)), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null, status: w.status }
      : undefined
  const unified = info.unifiedWindows as Windows | undefined
  if (unified) {
    out.session = win(unified.five_hour)
    out.weekly = win(unified.seven_day)
  } else if (typeof info.utilization === 'number') {
    const w = win({
      utilization: info.utilization as number,
      resetsAt: info.resetsAt as number | undefined,
      status: info.status as UsageWindow['status'],
    })
    if (info.rateLimitType === 'five_hour') out.session = w
    else if (info.rateLimitType === 'seven_day') out.weekly = w
  }
  return out.session || out.weekly ? out : null
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as Record<string, unknown>[]) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[picture]')
  }
  return parts.join('\n')
}

export class ClaudeRuntime implements AgentRuntime {
  private q: Query | null = null
  private input = new AsyncQueue<SDKUserMessage>()
  private disposed = false
  private interrupted = false
  private turnStart = 0
  private inTurn = false
  private lastError: string | null = null
  private pendingText: string[] = []
  private pendingThinking: string[] = []
  private blocks = new Map<number, { id: string; kind: 'text' | 'thinking' }>()
  private seenTools = new Set<string>()
  private level: PermissionLevel
  /** True once the current turn has touched a file, so there is something to undo. */
  private edited = false
  private turnId: ReturnType<typeof randomUUID> | null = null

  constructor(private o: RuntimeOptions) {
    this.level = o.permission
    this.start()
  }

  private emit(ev: RuntimeEvent): void {
    if (!this.disposed) this.o.host.emit(ev)
  }

  private start(): void {
    const { o } = this
    const options: Options = {
      cwd: o.cwd,
      env: claudeEnv(o.configDir),
      includePartialMessages: true,
      permissionMode: MODE[this.level],
      allowDangerouslySkipPermissions: this.level === 'full',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: o.briefing },
      thinking: { type: 'adaptive', display: 'summarized' },
      enableFileCheckpointing: true,
      promptSuggestions: !!o.suggestions,
      additionalDirectories: o.extraDirs?.length ? o.extraDirs : undefined,
      mcpServers: o.tools.length || Object.keys(o.connectors || {}).length ? { ...((o.connectors || {}) as Record<string, McpServerConfig>), ...(o.tools.length ? { team: teamServer(o.tools) } : {}) } : undefined,
      // Searching and reading the web only reads, so it never waits on a permission card:
      // without this, the 'ask' and 'edits' levels stop at every search and every new site.
      allowedTools: ['WebSearch', 'WebFetch', ...o.tools.map((t) => `mcp__team__${t.name}`)],
      stderr: () => {},
      canUseTool: async (toolName, input, opts) => {
        if (toolName === 'AskUserQuestion') {
          const questions = ((input.questions as QuestionSpec[]) || []).map((q) => ({
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect,
            options: (q.options || []).map((x) => ({ label: x.label, description: x.description })),
          }))
          const answers = await o.host.askQuestion(questions, opts.signal)
          if (!answers) return { behavior: 'deny', message: 'The user dismissed the question without answering.' }
          return { behavior: 'allow', updatedInput: { ...input, answers } }
        }
        const { decision, note } = await o.host.askPermission({
          toolName,
          title: opts.title || '',
          detail: opts.description || opts.decisionReason,
          input,
          canRemember: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
          signal: opts.signal,
        })
        if (decision === 'deny') {
          return {
            behavior: 'deny',
            message: note ? `The user declined this action and said: ${note}` : 'The user declined this action.',
            decisionClassification: 'user_reject',
          }
        }
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: decision === 'always' ? opts.suggestions : undefined,
          decisionClassification: decision === 'always' ? 'user_permanent' : 'user_temporary',
        }
      },
    }
    if (o.executable) options.pathToClaudeCodeExecutable = o.executable
    if (o.resumeId) {
      options.resume = o.resumeId
      if (o.forkSession) options.forkSession = true
    }
    if (o.model) options.model = o.model
    if (o.effort) options.effort = o.effort as Options['effort']

    this.q = query({ prompt: this.input, options })
    void this.consume(this.q)
  }

  private async consume(q: Query): Promise<void> {
    let error: string | undefined
    try {
      for await (const m of q) this.onMessage(m)
    } catch (e) {
      error = (e as Error).message
    }
    if (this.q !== q) return
    this.q = null
    if (this.inTurn) {
      this.inTurn = false
      this.emit({
        type: 'turn-end',
        status: this.interrupted ? 'interrupted' : 'error',
        resultText: '',
        durationMs: Date.now() - this.turnStart,
        reason: 'other',
        error: error || 'The agent process stopped unexpectedly.',
      })
    }
    this.emit({ type: 'exit', error })
  }

  private onMessage(m: SDKMessage): void {
    switch (m.type) {
      case 'stream_event': {
        if (m.parent_tool_use_id) return
        const e = m.event
        if (e.type === 'message_start') {
          this.blocks.clear()
        } else if (e.type === 'content_block_start') {
          const b = e.content_block as { type: string; id?: string; name?: string }
          if (b.type === 'text') {
            const id = uid('a')
            this.blocks.set(e.index, { id, kind: 'text' })
            this.pendingText.push(id)
            this.emit({ type: 'text-start', id })
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            const id = uid('r')
            this.blocks.set(e.index, { id, kind: 'thinking' })
            this.pendingThinking.push(id)
            this.emit({ type: 'thinking-start', id })
          } else if (b.id && b.name && /tool_use$/.test(b.type)) {
            this.seenTools.add(b.id)
            if (EDITING.has(b.name)) this.edited = true
            this.emit({ type: 'tool-start', id: b.id, name: b.name })
          }
        } else if (e.type === 'content_block_delta') {
          const blk = this.blocks.get(e.index)
          if (!blk) return
          const d = e.delta as { type: string; text?: string; thinking?: string }
          if (d.type === 'text_delta' && d.text) this.emit({ type: 'text-delta', id: blk.id, text: d.text })
          else if (d.type === 'thinking_delta' && d.thinking) this.emit({ type: 'thinking-delta', id: blk.id, text: d.thinking })
        } else if (e.type === 'content_block_stop') {
          const blk = this.blocks.get(e.index)
          if (blk?.kind === 'thinking') this.emit({ type: 'thinking-end', id: blk.id })
        }
        return
      }

      case 'assistant': {
        if (m.error) this.lastError = m.error
        const sub = m.parent_tool_use_id
        for (const b of m.message.content as unknown as Record<string, unknown>[]) {
          if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            const id = b.id as string
            if (EDITING.has(b.name as string)) this.edited = true
            if (!this.seenTools.has(id)) {
              this.seenTools.add(id)
              this.emit({ type: 'tool-start', id, name: b.name as string, input: b.input, parentId: sub || undefined })
            } else {
              this.emit({ type: 'tool-input', id, input: b.input })
            }
          } else if (sub) {
            continue
          } else if (b.type === 'text') {
            const text = (b.text as string) || ''
            let id = this.pendingText.shift()
            if (!id) {
              if (!text.trim()) continue
              id = uid('a')
              this.emit({ type: 'text-start', id })
            }
            this.emit({ type: 'text-end', id, text })
          } else if (b.type === 'thinking') {
            const text = (b.thinking as string) || ''
            const id = this.pendingThinking.shift()
            if (id) this.emit({ type: 'thinking-end', id, text })
          }
        }
        return
      }

      case 'user': {
        const content = m.message.content
        if (!Array.isArray(content)) return
        for (const b of content as unknown as Record<string, unknown>[]) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            this.emit({
              type: 'tool-end',
              id: b.tool_use_id,
              output: clip(resultText(b.content), 16000),
              isError: b.is_error === true,
            })
          }
        }
        return
      }

      case 'rate_limit_event': {
        const usage = usageFromEvent(m.rate_limit_info as unknown as Record<string, unknown>)
        if (usage) this.emit({ type: 'usage', usage })
        if (m.rate_limit_info.status === 'rejected') this.lastError = 'rate_limit'
        return
      }

      case 'result': {
        if (!this.inTurn) return
        this.inTurn = false
        const failed = m.is_error || m.subtype !== 'success'
        const text = m.subtype === 'success' ? m.result : (m.errors || []).join('\n')
        const limit = this.lastError === 'rate_limit' || (failed && /usage limit|rate limit|limit reached|out of .*usage/i.test(text))
        const auth =
          this.lastError === 'authentication_failed' || (failed && /not logged in|please run \/login|authentication|invalid api key/i.test(text))
        this.emit({
          type: 'turn-end',
          status: this.interrupted ? 'interrupted' : failed ? 'error' : 'done',
          resultText: text || '',
          durationMs: m.duration_ms || Date.now() - this.turnStart,
          steps: m.num_turns,
          tokens: m.usage?.output_tokens || undefined,
          checkpoint: this.edited ? m.user_message_uuid || this.turnId || undefined : undefined,
          reason: failed ? (limit ? 'limit' : auth ? 'auth' : 'other') : undefined,
          error: failed && !this.interrupted ? text || 'The turn ended with an error.' : undefined,
        })
        this.pendingText = []
        this.pendingThinking = []
        this.lastError = null
        this.interrupted = false
        this.edited = false
        void this.reportContext()
        return
      }

      case 'prompt_suggestion': {
        const text = (m.suggestion || '').trim()
        if (text && text.length <= 200 && !this.inTurn) this.emit({ type: 'suggestion', text })
        return
      }

      case 'system': {
        if (m.subtype === 'init') {
          // Once the copy exists it is ours: later restarts carry on in it rather than copying again.
          if (this.o.forkSession && this.o.resumeId && m.session_id !== this.o.resumeId) this.o.forkSession = false
          this.o.resumeId = m.session_id
          this.emit({ type: 'session', sessionId: m.session_id, model: m.model })
        } else if (m.subtype === 'status') {
          if (m.status === 'compacting') this.emit({ type: 'status', text: 'Tidying up the conversation' })
        } else if (m.subtype === 'api_retry') {
          this.emit({ type: 'status', text: `Connection hiccup, retrying (${m.attempt}/${m.max_retries})` })
        } else if (m.subtype === 'compact_boundary') {
          this.emit({ type: 'notice', level: 'info', text: 'Earlier messages were summarized to free up room.' })
        } else if (m.subtype === 'model_refusal_no_fallback') {
          this.emit({ type: 'notice', level: 'warn', text: m.content || 'The model declined this request.' })
        }
        return
      }

      case 'auth_status': {
        if (m.error) this.emit({ type: 'notice', level: 'error', text: m.error })
        return
      }
    }
  }

  /** Reads how full the context window is. Answered locally, so it costs nothing. */
  private async reportContext(): Promise<void> {
    const q = this.q
    if (!q) return
    try {
      const u = await q.getContextUsage({ detail: 'summary' })
      if (this.q === q && u.maxTokens > 0) this.emit({ type: 'context', used: u.totalTokens, max: u.maxTokens })
    } catch {
      /* a nice-to-have */
    }
  }

  async rewind(checkpoint: string, apply: boolean): Promise<RewindPreview> {
    const no = (error: string): RewindPreview => ({ ok: false, error, files: [], added: 0, removed: 0 })
    if (this.disposed) return no('This agent is no longer running.')
    if (this.inTurn) return no('Wait for the current reply to finish first.')
    if (!this.q) this.restart()
    try {
      const r = await (this.q as Query).rewindFiles(checkpoint, { dryRun: !apply })
      return { ok: r.canRewind, error: r.error, files: r.filesChanged || [], added: r.insertions || 0, removed: r.deletions || 0 }
    } catch (e) {
      return no((e as Error).message)
    }
  }

  send(input: TurnInput): void {
    if (this.disposed) return
    if (!this.q) this.restart()
    const content: unknown[] = []
    for (const p of input.images || []) {
      try {
        content.push({ type: 'image', source: { type: 'base64', media_type: mimeOf(p), data: fs.readFileSync(p).toString('base64') } })
      } catch {
        /* unreadable attachment: skip it rather than fail the turn */
      }
    }
    content.push({ type: 'text', text: input.text })
    this.inTurn = true
    this.interrupted = false
    this.edited = false
    this.turnStart = Date.now()
    // Text on its own goes as a plain string, the form the agent expects for
    // typed commands such as /compact.
    const plain = content.length === 1 && input.origin.kind === 'human'
    // Naming the message ourselves gives the turn an undo point we can refer to later.
    this.turnId = randomUUID()
    this.input.push({
      type: 'user',
      uuid: this.turnId,
      message: { role: 'user', content: (plain ? input.text : content) as never },
      parent_tool_use_id: null,
      origin: input.origin.kind === 'human' ? { kind: 'human' } : { kind: 'peer', from: input.origin.name, name: input.origin.name },
    })
  }

  private restart(): void {
    this.input = new AsyncQueue<SDKUserMessage>()
    this.start()
  }

  async interrupt(): Promise<void> {
    if (!this.q || !this.inTurn) return
    this.interrupted = true
    try {
      await this.q.interrupt()
    } catch {
      /* the process may already be gone */
    }
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    const wasFull = this.level === 'full'
    this.level = level
    this.o.permission = level
    if (!this.q) return
    // Full access has to be granted when the process starts, so crossing that
    // line means a fresh process that resumes the same conversation.
    if (level === 'full' || wasFull) {
      if (this.inTurn) {
        // Stepping down takes effect in the reply under way; the session replaces the process
        // once the reply ends, so the next turn starts without full access for certain.
        if (wasFull && level !== 'full') await this.q.setPermissionMode(MODE[level]).catch(() => {})
        return
      }
      const q = this.q
      this.q = null
      this.input.close()
      q.close()
      return
    }
    try {
      await this.q.setPermissionMode(MODE[level])
    } catch {
      /* applied on next start */
    }
  }

  dispose(): void {
    this.disposed = true
    this.input.close()
    const q = this.q
    this.q = null
    try {
      q?.close()
    } catch {
      /* already closed */
    }
  }
}

export interface ClaudeProbe {
  email?: string
  plan?: string
  organization?: string
  models: ModelOption[]
  commands: CommandInfo[]
  usage: Omit<AccountUsage, 'accountId' | 'updatedAt'> | null
}

const pct = (w: { utilization: number | null; resets_at: string | null } | null | undefined): UsageWindow | undefined =>
  w && typeof w.utilization === 'number'
    ? { utilization: Math.min(1, Math.max(0, w.utilization / 100)), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null }
    : undefined

/**
 * Starts a session without sending anything, reads the account, its models and
 * its plan usage, then closes. Costs no usage.
 */
export async function probeClaude(configDir: string | null, cwd: string, executable?: string | null): Promise<ClaudeProbe> {
  const input = new AsyncQueue<SDKUserMessage>()
  const q = query({
    prompt: input,
    options: {
      cwd,
      env: claudeEnv(configDir),
      persistSession: false,
      settingSources: [],
      mcpServers: {},
      stderr: () => {},
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  })
  const drain = (async () => {
    try {
      for await (const _ of q) void _
    } catch {
      /* closed */
    }
  })()
  try {
    const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('Timed out talking to Claude Code')), ms))])
    const init = await timeout(q.initializationResult(), 25000)
    let usage: ClaudeProbe['usage'] = null
    try {
      const u = await timeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 20000)
      if (u.rate_limits_available && u.rate_limits) {
        usage = {
          session: pct(u.rate_limits.five_hour),
          weekly: pct(u.rate_limits.seven_day),
          scoped: (u.rate_limits.model_scoped || [])
            .filter((s) => typeof s.utilization === 'number')
            .map((s) => ({ label: s.display_name, utilization: (s.utilization as number) / 100, resetsAt: s.resets_at ? Date.parse(s.resets_at) : null })),
        }
      }
    } catch {
      /* usage is a nice-to-have */
    }
    return {
      email: init.account?.email,
      plan: init.account?.subscriptionType,
      organization: init.account?.organization,
      models: (init.models || []).map((m) => ({
        value: m.value,
        label: m.displayName,
        description: m.description,
        efforts: m.supportedEffortLevels,
      })),
      commands: (init.commands || [])
        .filter((c) => c.name && !c.name.startsWith('_') && !HIDDEN_COMMANDS.has(c.name))
        .slice(0, 80)
        .map((c) => ({ name: c.name, description: (c.description || '').split('\n')[0].slice(0, 140), hint: c.argumentHint || undefined })),
      usage,
    }
  } finally {
    input.close()
    q.close()
    await Promise.race([drain, new Promise((r) => setTimeout(r, 1500))])
  }
}

/**
 * The answer in a one-shot call's result. An error (a usage limit, a failed request) can arrive
 * marked as a success with is_error set: it is thrown, never passed off as an answer.
 */
export function onceResult(m: { subtype: string; is_error?: boolean; result?: string; errors?: string[] }): string {
  if (m.is_error || m.subtype !== 'success') throw new Error((m.subtype === 'success' ? m.result : (m.errors || []).join('\n')) || 'The request failed.')
  return m.result || ''
}

/** One short, tool-less call: chat titles, rewrites, checks. Rejects on an error, on `timeoutMs`, or when `signal` aborts. */
export async function askClaudeOnce(o: {
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
  // Ending the wait also ends the call, so a stalled one does not keep running and spending.
  const abort = new AbortController()
  const stop = (): void => abort.abort()
  if (o.signal?.aborted) throw new Error('Cancelled.')
  o.signal?.addEventListener('abort', stop)
  const timer = o.timeoutMs ? setTimeout(stop, o.timeoutMs) : null
  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd,
      env: claudeEnv(o.configDir),
      model: o.model || 'haiku',
      systemPrompt: o.system,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      effort: o.effort || 'low',
      stderr: () => {},
      abortController: abort,
      ...(o.executable ? { pathToClaudeCodeExecutable: o.executable } : {}),
    },
  })
  const why = (): Error => new Error(o.signal?.aborted ? 'Cancelled.' : 'Timed out.')
  const read = (async (): Promise<string> => {
    let out = ''
    for await (const m of q) {
      if (m.type === 'result') out = onceResult(m)
    }
    return out
  })()
  // The caller hears at once; the process is shut down in the background, which can take a few seconds.
  const ended = new Promise<never>((_, no) => abort.signal.addEventListener('abort', () => no(why()), { once: true }))
  read.catch(() => {})
  ended.catch(() => {})
  try {
    const out = await Promise.race([read, ended])
    if (abort.signal.aborted) throw why()
    return out.trim()
  } catch (e) {
    throw abort.signal.aborted ? why() : e
  } finally {
    if (timer) clearTimeout(timer)
    o.signal?.removeEventListener('abort', stop)
  }
}
