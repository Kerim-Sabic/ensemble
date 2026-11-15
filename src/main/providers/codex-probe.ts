import { spawn } from 'node:child_process'
import type { AccountUsage, ModelOption, UsageWindow } from '@shared/types'
import { codexEnv } from './codex'

export interface CodexProbe {
  email?: string
  plan?: string
  models: ModelOption[]
  usage: Omit<AccountUsage, 'accountId' | 'updatedAt'> | null
}

const PLAN: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

interface RateWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

interface RateLimits {
  primary?: RateWindow | null
  secondary?: RateWindow | null
  rateLimitReachedType?: string | null
  planType?: string | null
}

interface ModelRow {
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: { reasoningEffort: string }[]
}

/**
 * Asks the ChatGPT runtime's own app server who is signed in, which models the
 * plan offers and how much allowance is left. Nothing is sent to a model, so it
 * costs no usage. `what: 'usage'` asks for the allowance alone.
 */
export function probeCodex(executable: string, configDir: string | null, what: 'all' | 'usage' = 'all'): Promise<CodexProbe> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server'], { env: codexEnv(configDir), windowsHide: true })
    const pending = new Map<number, (m: { result?: unknown; error?: { message?: string } }) => void>()
    let seq = 1
    let buf = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('Timed out asking ChatGPT for the account details'))), 25000)
    child.on('error', (e) => finish(() => reject(e)))
    child.on('exit', () => finish(() => reject(new Error('The ChatGPT runtime closed before answering'))))
    child.stderr?.on('data', () => undefined)
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
          if (typeof m.id === 'number') pending.get(m.id)?.(m)
        } catch {
          /* a log line, not a reply */
        }
      }
    })
    const call = <T>(method: string, params?: unknown): Promise<T> =>
      new Promise<T>((res, rej) => {
        const id = seq++
        pending.set(id, (m) => (m.error ? rej(new Error(m.error.message || `${method} failed`)) : res(m.result as T)))
        child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`)
      })

    const win = (w: RateWindow | null | undefined, reached: boolean): UsageWindow | undefined =>
      w && typeof w.usedPercent === 'number'
        ? {
            utilization: Math.min(1, Math.max(0, w.usedPercent / 100)),
            resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
            status: reached && w.usedPercent >= 100 ? 'rejected' : w.usedPercent >= 85 ? 'allowed_warning' : 'allowed',
          }
        : undefined

    void (async () => {
      try {
        await call('initialize', { clientInfo: { name: 'ensemble', title: 'Ensemble', version: '3.0.0' }, capabilities: null })
        child.stdin?.write(`${JSON.stringify({ method: 'initialized' })}\n`)
        const out: CodexProbe = { models: [], usage: null }
        const jobs: Promise<void>[] = [
          call<{ rateLimits?: RateLimits }>('account/rateLimits/read').then(
            (r) => {
              const rl = r.rateLimits
              if (!rl) return
              const reached = !!rl.rateLimitReachedType
              // The shorter window is the "session"; the longer one is the week.
              const wins = [rl.primary, rl.secondary].filter((w): w is RateWindow => !!w)
              const short = wins.find((w) => (w.windowDurationMins ?? 0) <= 24 * 60)
              const long = wins.find((w) => (w.windowDurationMins ?? 0) > 24 * 60)
              const usage = { session: win(short, reached), weekly: win(long, reached) }
              if (usage.session || usage.weekly) out.usage = usage
              if (rl.planType && !out.plan) out.plan = PLAN[rl.planType]
            },
            () => undefined,
          ),
        ]
        if (what === 'all') {
          jobs.push(
            call<{ account?: { type?: string; email?: string | null; planType?: string } | null }>('account/read', { refreshToken: false }).then(
              (r) => {
                if (r.account?.type !== 'chatgpt') return
                out.email = r.account.email || undefined
                out.plan = PLAN[r.account.planType || ''] || out.plan
              },
              () => undefined,
            ),
            call<{ data?: ModelRow[] }>('model/list', { includeHidden: false }).then(
              (r) => {
                out.models = (r.data || [])
                  .filter((m) => !m.hidden)
                  .map((m) => ({
                    value: m.model,
                    label: m.displayName,
                    description: m.description,
                    efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
                    defaultEffort: m.defaultReasoningEffort || undefined,
                    isDefault: m.isDefault || undefined,
                  }))
              },
              () => undefined,
            ),
          )
        }
        await Promise.all(jobs)
        finish(() => resolve(out))
      } catch (e) {
        finish(() => reject(e as Error))
      }
    })()
  })
}
