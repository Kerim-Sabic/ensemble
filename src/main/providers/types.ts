import type { z } from 'zod'
import type { Account, AccountUsage, PermissionDecision, PermissionLevel, QuestionSpec, RewindPreview } from '@shared/types'

/** One thing to hand an agent: a typed message, a task brief, or a teammate's note. */
export interface TurnInput {
  text: string
  images?: string[]
  /** Who is speaking. Agents treat a person and a teammate differently. */
  origin: { kind: 'human' } | { kind: 'peer'; name: string }
}

export interface PermissionAsk {
  toolName: string
  title: string
  detail?: string
  input: unknown
  canRemember: boolean
  signal: AbortSignal
}

/** Provider-neutral events. Both runtimes speak only this to the rest of the app. */
export type RuntimeEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'status'; text: string }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; text: string }
  | { type: 'text-end'; id: string; text: string }
  | { type: 'thinking-start'; id: string }
  | { type: 'thinking-delta'; id: string; text: string }
  | { type: 'thinking-end'; id: string; text?: string }
  | { type: 'tool-start'; id: string; name: string; input?: unknown; parentId?: string }
  | { type: 'tool-input'; id: string; input: unknown }
  | { type: 'tool-end'; id: string; output: string; isError: boolean }
  | { type: 'image'; path: string }
  | { type: 'usage'; usage: Omit<AccountUsage, 'accountId' | 'updatedAt'> }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  /** How full the agent's context window is after the latest reply. */
  | { type: 'context'; used: number; max: number }
  /** A likely next message from the person, offered after a reply. */
  | { type: 'suggestion'; text: string }
  | {
      type: 'turn-end'
      status: 'done' | 'interrupted' | 'error'
      resultText: string
      durationMs: number
      steps?: number
      /** Top-level tool steps the session counted this turn (set by the session, not the provider). */
      tools?: number
      /** Tokens the model wrote this turn. */
      tokens?: number
      /** Set when the turn changed files and the provider can put them back. */
      checkpoint?: string
      /** Why it failed, when we can tell. */
      reason?: 'limit' | 'auth' | 'other'
      error?: string
    }
  | { type: 'exit'; error?: string }

export interface RuntimeHost {
  emit(ev: RuntimeEvent): void
  askPermission(ask: PermissionAsk): Promise<{ decision: PermissionDecision; note?: string }>
  askQuestion(questions: QuestionSpec[], signal: AbortSignal): Promise<Record<string, string> | null>
}

/** What a tool hands back: words, and sometimes pictures for the model to look at. */
export interface ToolOutput {
  text: string
  images?: { data: string; mime: string }[]
  isError?: boolean
}

/** A tool the team hub offers to an agent, independent of how it is delivered. */
export interface TeamTool {
  name: string
  description: string
  schema: z.ZodRawShape
  run(args: Record<string, unknown>): Promise<string | ToolOutput>
}

export const toolText = (r: string | ToolOutput): string => (typeof r === 'string' ? r : r.text)

/** Tool output in the shape agents expect: text first, then any pictures. */
export function toolContent(r: string | ToolOutput): { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean } {
  if (typeof r === 'string') return { content: [{ type: 'text', text: r }] }
  return {
    content: [{ type: 'text', text: r.text }, ...(r.images || []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mime }))],
    ...(r.isError ? { isError: true } : {}),
  }
}

export interface RuntimeOptions {
  account: Account
  /** Resolved config folder, or null for the provider default. */
  configDir: string | null
  cwd: string
  permission: PermissionLevel
  /** The model and effort for this run. null means the account's own default. */
  model?: string | null
  /** What the account runs when no model is chosen, when that is known. Only for showing it. */
  defaultModel?: string
  effort?: string | null
  /** Folders besides the working one that the agent may read and write (the knowledge vault). */
  extraDirs?: string[]
  resumeId?: string
  /** Outside services, by name, in the shape this provider takes them. */
  connectors?: Record<string, Record<string, unknown>>
  /** Carry the resumed conversation on in a copy of its own, leaving the original as it is. */
  forkSession?: boolean
  /** Role and team briefing appended to the agent's own instructions. */
  briefing: string
  /**
   * For a resumed conversation: false when the briefing has changed since it was last given
   * (a new role, a new team), so a provider that sends it as a message sends it again.
   */
  briefed?: boolean
  tools: TeamTool[]
  executable?: string | null
  /** URL of the local team-tools endpoint, for providers that reach tools over HTTP. */
  toolsUrl?: string
  /** Ask the provider to predict the person's next message after each reply. */
  suggestions?: boolean
  host: RuntimeHost
}

export interface AgentRuntime {
  /** Begin a turn. The caller guarantees the previous turn has ended. */
  send(input: TurnInput): void
  interrupt(): Promise<void>
  setPermission(level: PermissionLevel): Promise<void>
  /** Puts files back to how they were before the turn a checkpoint belongs to. */
  rewind?(checkpoint: string, apply: boolean): Promise<RewindPreview>
  dispose(): void
}
