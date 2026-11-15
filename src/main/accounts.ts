import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  ACCENTS,
  type AccentKey,
  type Account,
  type AccountCandidate,
  type AccountStatus,
  type AccountUsage,
  type HubEvent,
  type LoginProgress,
  type ModelOption,
  type Provider,
} from '@shared/types'
import { exists, readJson, slugify, writeJson } from './util'
import { claudeEnv, probeClaude } from './providers/claude'
import { codexEnv, codexLoginStatus } from './providers/codex'
import { probeCodex } from './providers/codex-probe'
import { findClaude, findCodex } from './locate'
import { NEW_USER } from './setup'

interface ClaudeAuthStatus {
  loggedIn?: boolean
  email?: string | null
  orgName?: string | null
  subscriptionType?: string | null
}

const PLAN_LABEL: Record<string, string> = {
  team: 'Team',
  max: 'Max',
  pro: 'Pro',
  free: 'Free',
  enterprise: 'Enterprise',
  ultra: 'Ultra',
}

function planLabel(raw?: string | null): string | undefined {
  if (!raw) return undefined
  const k = raw.toLowerCase().replace(/^claude\s+/, '')
  return PLAN_LABEL[k] || raw.replace(/^claude\s+/i, '')
}

// Offered until the account itself reports its list.
const CHATGPT_MODELS: ModelOption[] = [{ value: '', label: 'Default' }]

export interface AccountHost {
  dataDir: string
  /** Demo mode never touches real accounts: everything below is canned. */
  demo?: boolean
  emit(ev: HubEvent): void
  claudePath(): string | null
}

const DEMO_FOUND: AccountCandidate[] = [
  { provider: 'claude', configDir: null, suggestedName: 'Main', signedIn: true, email: 'you@example.com', plan: 'Max' },
  { provider: 'claude', configDir: 'demo://claude-3', suggestedName: 'Claude 3', signedIn: true, email: 'work@example.com', plan: 'Team' },
  { provider: 'claude', configDir: 'demo://hello', suggestedName: 'Hello', signedIn: true, email: 'hello@example.com', plan: 'Team' },
  { provider: 'chatgpt', configDir: null, suggestedName: 'ChatGPT', signedIn: true },
  { provider: 'claude', configDir: 'demo://claude-2', suggestedName: 'Claude 2', signedIn: false },
]

const DEMO_MODELS: ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { value: 'opus', label: 'Opus 5.5', description: 'For complex work and everyday tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'fable', label: 'Fable 5.2', description: 'For your toughest challenges', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', label: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', label: 'Haiku 5.5', description: 'Fastest for quick answers', efforts: ['low', 'medium', 'high'] },
]

const GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const DEMO_GPT_MODELS: ModelOption[] = [
  { value: '', label: 'Default', description: 'GPT-6.1-Sol' },
  { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', efforts: GPT_EFFORTS, isDefault: true },
  { value: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', efforts: GPT_EFFORTS },
  { value: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', efforts: GPT_EFFORTS },
]

const DEMO_COMMANDS = [
  { name: 'review', description: 'Review the changes on this branch' },
  { name: 'security-review', description: 'Look for security problems in the pending changes' },
  { name: 'compact', description: 'Summarize the conversation so far to free up room', hint: '[what to keep]' },
  { name: 'init', description: 'Write a CLAUDE.md that describes this project' },
  { name: 'simplify', description: 'Clean up the code that was just changed' },
]

/**
 * A map of accounts' details that also answers for agents started inside a chat:
 * such an agent has no sign-in or allowance of its own, so a lookup under its id
 * gives its account's entry.
 */
class ByAccount<V> extends Map<string, V> {
  constructor(private base: (id: string) => string) {
    super()
  }
  override get(id: string): V | undefined {
    return super.get(this.base(id))
  }
  override has(id: string): boolean {
    return super.has(this.base(id))
  }
}

export class AccountManager {
  accounts: Account[] = []
  /** Agents started inside chats, by id. They are kept with their chat; this is only for looking them up. */
  private spawned = new Map<string, Account>()
  /** The account behind an id: itself, or the account a spawned agent works on. */
  readonly baseId = (id: string): string => this.spawned.get(id)?.spawned?.base || id
  statuses = new ByAccount<AccountStatus>(this.baseId)
  usage = new ByAccount<AccountUsage>(this.baseId)
  private logins = new Map<string, ChildProcess>()
  private file: string
  private usageFile: string
  private probing = new Map<string, Promise<void>>()

  constructor(private host: AccountHost) {
    this.file = path.join(host.dataDir, 'accounts.json')
    this.usageFile = path.join(host.dataDir, 'usage.json')
    this.accounts = readJson<Account[]>(this.file, [])
    for (const u of readJson<AccountUsage[]>(this.usageFile, [])) this.usage.set(u.accountId, u)
  }

  private save(): void {
    writeJson(this.file, this.accounts)
    this.host.emit({ type: 'accounts', accounts: this.accounts })
  }

  /** An account, or an agent started inside a chat. */
  get(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id) || this.spawned.get(id)
  }

  /** Makes an agent started inside a chat findable by its id. */
  register(agent: Account): void {
    if (agent.spawned) this.spawned.set(agent.id, agent)
  }

  unregister(id: string): void {
    this.spawned.delete(id)
  }

  /** Everyone who can be named in a chat: the accounts, then the agents started in that chat. */
  private pool(chatId?: string): Account[] {
    if (!chatId) return this.accounts
    return [...this.accounts, ...[...this.spawned.values()].filter((a) => a.spawned?.chatId === chatId && !a.spawned.gone)]
  }

  byName(nameOrId: string, chatId?: string): Account | undefined {
    const k = nameOrId.trim().toLowerCase()
    const all = this.pool(chatId)
    return all.find((a) => a.id === k || a.name.toLowerCase() === k) || all.find((a) => a.name.toLowerCase().replace(/\s+/g, '') === k.replace(/\s+/g, ''))
  }

  defaultDir(provider: Provider): string {
    return path.join(os.homedir(), provider === 'claude' ? '.claude' : '.codex')
  }

  /** null when the account uses the provider's default folder. */
  configDir(a: Account): string | null {
    return a.configDir
  }

  isReady(id: string): boolean {
    const a = this.get(id)
    return !!a && a.enabled && !a.spawned?.gone && this.statuses.get(id)?.state === 'ready'
  }

  /** True while an account has run out of its current window. */
  limitedUntil(id: string): number | null {
    const u = this.usage.get(id)
    if (!u) return null
    const now = Date.now()
    for (const w of [u.session, u.weekly]) {
      if (w && (w.status === 'rejected' || w.utilization >= 1) && w.resetsAt && w.resetsAt > now) return w.resetsAt
    }
    return null
  }

  private nextAccent(): AccentKey {
    const used = new Set(this.accounts.map((a) => a.accent))
    return ACCENTS.find((a) => !used.has(a)) || ACCENTS[this.accounts.length % ACCENTS.length]
  }

  private uniqueId(name: string): string {
    const base = slugify(name)
    let id = base
    let n = 2
    while (this.accounts.some((a) => a.id === id)) id = `${base}-${n++}`
    return id
  }

  /** Folders on this machine that look like signed-in accounts we are not using yet. */
  async discover(): Promise<AccountCandidate[]> {
    const homeDir = os.homedir()
    const have = (provider: Provider, dir: string | null): boolean =>
      this.accounts.some((a) => a.provider === provider && (a.configDir || this.defaultDir(provider)).toLowerCase() === (dir || this.defaultDir(provider)).toLowerCase())
    if (this.host.demo && NEW_USER) return []
    if (this.host.demo) return DEMO_FOUND.filter((c) => !have(c.provider, c.configDir)).map((c) => ({ ...c }))
    let names: string[] = []
    try {
      names = fs.readdirSync(homeDir)
    } catch {
      /* unreadable home: nothing to suggest */
    }
    const out: AccountCandidate[] = []
    const jobs: Promise<void>[] = []
    for (const n of names) {
      const full = path.join(homeDir, n)
      const claude = /^\.claude(-[\w.-]+)?$/.exec(n)
      const codex = /^\.codex(-[\w.-]+)?$/.exec(n)
      if (claude && (exists(path.join(full, '.credentials.json')) || exists(path.join(full, '.claude.json')))) {
        const dir = n === '.claude' ? null : full
        if (have('claude', dir)) continue
        const suffix = (claude[1] || '').slice(1)
        const c: AccountCandidate = { provider: 'claude', configDir: dir, suggestedName: suffix ? prettyName(suffix) : 'Main', signedIn: false }
        out.push(c)
        jobs.push(
          this.claudeAuth(dir).then((s) => {
            c.signedIn = !!s.loggedIn
            c.email = s.email || undefined
            c.plan = planLabel(s.subscriptionType)
          }),
        )
      } else if (codex && exists(path.join(full, 'auth.json'))) {
        const dir = n === '.codex' ? null : full
        if (have('chatgpt', dir)) continue
        const suffix = (codex[1] || '').slice(1)
        const c: AccountCandidate = { provider: 'chatgpt', configDir: dir, suggestedName: suffix ? prettyName(suffix) : 'ChatGPT', signedIn: false }
        out.push(c)
        const exe = findCodex()
        if (exe) jobs.push(codexLoginStatus(exe, dir).then((s) => void (c.signedIn = s.signedIn)))
      }
    }
    await Promise.all(jobs)
    // The account Claude Code itself uses comes first, ChatGPT last.
    const rank = (c: AccountCandidate): number => (c.provider === 'claude' ? (c.configDir === null ? 0 : 1) : 2)
    return out.sort((a, b) => rank(a) - rank(b) || Number(b.signedIn) - Number(a.signedIn) || a.suggestedName.localeCompare(b.suggestedName, undefined, { numeric: true }))
  }

  add(input: { name: string; provider: Provider; configDir?: string | null; create?: boolean; accent?: AccentKey }): Account {
    const name = input.name.trim() || (input.provider === 'claude' ? 'Claude' : 'ChatGPT')
    const id = this.uniqueId(name)
    let configDir = input.configDir ?? null
    if (input.create && this.host.demo) {
      configDir = `demo://${id}`
    } else if (input.create) {
      const base = input.provider === 'claude' ? '.claude-' : '.codex-'
      let dir = path.join(os.homedir(), base + id)
      let n = 2
      while (exists(dir)) dir = path.join(os.homedir(), `${base}${id}-${n++}`)
      fs.mkdirSync(dir, { recursive: true })
      configDir = dir
    }
    const account: Account = {
      id,
      name,
      provider: input.provider,
      configDir,
      accent: input.accent || (input.provider === 'chatgpt' && !this.accounts.some((a) => a.accent === 'green') ? 'green' : this.nextAccent()),
      model: null,
      effort: null,
      role: input.provider === 'chatgpt' ? 'Images and a second opinion' : null,
      enabled: true,
      createdAt: Date.now(),
    }
    this.accounts.push(account)
    this.save()
    void this.refresh(id)
    return account
  }

  update(id: string, patch: Partial<Pick<Account, 'name' | 'accent' | 'model' | 'effort' | 'role' | 'enabled'>>): Account {
    const a = this.get(id)
    if (!a) throw new Error('No such account')
    if (patch.name !== undefined) a.name = patch.name.trim() || a.name
    if (patch.role !== undefined) a.role = patch.role?.trim().slice(0, 160) || null
    if (patch.accent !== undefined) a.accent = patch.accent
    if (patch.model !== undefined) a.model = patch.model || null
    if (patch.effort !== undefined) a.effort = patch.effort || null
    if (patch.enabled !== undefined) a.enabled = patch.enabled
    this.save()
    return a
  }

  /** Forgets the account here. The sign-in and its folder are left untouched. */
  remove(id: string): void {
    this.cancelLogin(id)
    this.accounts = this.accounts.filter((a) => a.id !== id)
    this.statuses.delete(id)
    this.usage.delete(id)
    this.save()
  }

  private setStatus(s: AccountStatus): void {
    this.statuses.set(s.accountId, s)
    this.host.emit({ type: 'account-status', status: s })
  }

  setUsage(id: string, partial: Omit<AccountUsage, 'accountId' | 'updatedAt'>): void {
    // What an agent started inside a chat uses comes out of its account's allowance.
    const accountId = this.baseId(id)
    const prev = this.usage.get(accountId)
    const next: AccountUsage = {
      accountId,
      session: partial.session ?? prev?.session,
      weekly: partial.weekly ?? prev?.weekly,
      scoped: partial.scoped ?? prev?.scoped,
      updatedAt: Date.now(),
    }
    this.usage.set(accountId, next)
    this.host.emit({ type: 'account-usage', usage: next })
    writeJson(this.usageFile, [...this.usage.values()])
  }

  private claudeAuth(configDir: string | null): Promise<ClaudeAuthStatus> {
    const exe = findClaude(this.host.claudePath())
    if (!exe) return Promise.resolve({})
    return new Promise((resolve) => {
      execFile(exe, ['auth', 'status', '--json'], { env: claudeEnv(configDir), windowsHide: true, timeout: 20000 }, (_err, stdout) => {
        try {
          resolve(JSON.parse(stdout) as ClaudeAuthStatus)
        } catch {
          resolve({})
        }
      })
    })
  }

  async refresh(id?: string): Promise<void> {
    const targets = id ? this.accounts.filter((a) => a.id === id) : this.accounts
    await Promise.all(targets.map((a) => this.refreshOne(a)))
  }

  private refreshOne(a: Account): Promise<void> {
    const running = this.probing.get(a.id)
    if (running) return running
    const p = this.doRefresh(a).finally(() => this.probing.delete(a.id))
    this.probing.set(a.id, p)
    return p
  }

  private async doRefresh(a: Account): Promise<void> {
    const prev = this.statuses.get(a.id)
    if (this.host.demo) {
      const known = NEW_USER ? undefined : DEMO_FOUND.find((c) => c.provider === a.provider && c.configDir === a.configDir)
      const signedIn = known ? known.signedIn : !!prev && prev.state === 'ready'
      this.setStatus({
        accountId: a.id,
        state: signedIn ? 'ready' : 'signed-out',
        email: signedIn ? known?.email : undefined,
        plan: signedIn ? known?.plan || (a.provider === 'chatgpt' ? 'ChatGPT Plus' : 'Pro') : undefined,
        models: a.provider === 'claude' ? DEMO_MODELS : DEMO_GPT_MODELS,
        commands: a.provider === 'claude' ? DEMO_COMMANDS : undefined,
        checkedAt: Date.now(),
      })
      if (signedIn && !this.usage.has(a.id)) {
        const seed = a.id.length * 0.11
        const h = 3600e3
        // Three accounts in three different spots, so the choice of model by allowance can be seen:
        // one on pace, one whose strongest model is used up, one with plenty left and a refill close.
        const shown: Record<string, [week: number, weekHours: number, top: number]> = { 'claude:': [0.68, 83, 0.86], 'claude:demo://claude-3': [0.55, 102, 1], 'claude:demo://hello': [0.45, 17, 0.4] }
        const fixed = shown[`${a.provider}:${a.configDir || ''}`]
        this.setUsage(a.id, {
          session: { utilization: 0.08 + (seed % 0.5), resetsAt: Date.now() + 2.6 * h },
          weekly: fixed ? { utilization: fixed[0], resetsAt: Date.now() + fixed[1] * h } : { utilization: 0.2 + ((seed * 1.7) % 0.6), resetsAt: Date.now() + 84 * h },
          scoped: a.provider === 'claude' ? [{ label: 'Fable', utilization: fixed ? fixed[2] : 0.12 + (seed % 0.3), resetsAt: Date.now() + (fixed ? fixed[1] : 84) * h }] : undefined,
        })
      }
      return
    }
    if (!prev) this.setStatus({ accountId: a.id, state: 'checking', checkedAt: Date.now() })
    try {
      if (a.provider === 'claude') {
        const exe = findClaude(this.host.claudePath())
        if (!exe) {
          this.setStatus({ accountId: a.id, state: 'error', error: 'Claude Code is not installed on this computer.', checkedAt: Date.now() })
          return
        }
        const auth = await this.claudeAuth(a.configDir)
        if (!auth.loggedIn) {
          this.setStatus({ accountId: a.id, state: 'signed-out', checkedAt: Date.now() })
          return
        }
        // Signed in: show that right away, then fill in models and usage.
        this.setStatus({
          accountId: a.id,
          state: 'ready',
          email: auth.email || prev?.email,
          plan: planLabel(auth.subscriptionType) || prev?.plan,
          organization: auth.orgName || prev?.organization,
          models: prev?.models,
          commands: prev?.commands,
          checkedAt: Date.now(),
        })
        const probe = await probeClaude(a.configDir, this.host.dataDir, exe)
        this.setStatus({
          accountId: a.id,
          state: 'ready',
          email: probe.email || auth.email || undefined,
          plan: planLabel(probe.plan) || planLabel(auth.subscriptionType),
          organization: probe.organization || auth.orgName || undefined,
          models: probe.models,
          commands: probe.commands,
          checkedAt: Date.now(),
        })
        if (probe.usage) this.setUsage(a.id, probe.usage)
      } else {
        const exe = findCodex()
        if (!exe) {
          this.setStatus({ accountId: a.id, state: 'error', error: 'The ChatGPT agent runtime is missing from this install.', checkedAt: Date.now() })
          return
        }
        const s = await codexLoginStatus(exe, a.configDir)
        if (!s.signedIn) {
          this.setStatus({ accountId: a.id, state: 'signed-out', checkedAt: Date.now() })
          return
        }
        // Signed in: show that right away, then fill in the plan, models and allowance.
        this.setStatus({
          accountId: a.id,
          state: 'ready',
          email: prev?.email,
          plan: prev?.plan || 'ChatGPT',
          models: prev?.models?.length ? prev.models : CHATGPT_MODELS,
          checkedAt: Date.now(),
        })
        try {
          const probe = await probeCodex(exe, a.configDir)
          this.setStatus({
            accountId: a.id,
            state: 'ready',
            email: probe.email || prev?.email,
            plan: probe.plan ? `ChatGPT ${probe.plan}` : prev?.plan || 'ChatGPT',
            models: probe.models.length ? [{ value: '', label: 'Default', description: probe.models.find((m) => m.isDefault)?.label }, ...probe.models] : CHATGPT_MODELS,
            checkedAt: Date.now(),
          })
          if (probe.usage) this.setUsage(a.id, probe.usage)
        } catch {
          /* the account works without these details */
        }
      }
    } catch (e) {
      // A failed refresh should not knock a working account offline.
      if (prev?.state === 'ready') this.setStatus({ ...prev, checkedAt: Date.now() })
      else this.setStatus({ accountId: a.id, state: 'error', error: (e as Error).message, checkedAt: Date.now() })
    }
  }

  /** Re-reads how much allowance a ChatGPT account has left. Claude accounts report theirs as they work. */
  async refreshUsage(id: string): Promise<void> {
    const a = this.get(id)
    if (!a || a.provider !== 'chatgpt' || this.host.demo) return
    const exe = findCodex()
    if (!exe) return
    try {
      const probe = await probeCodex(exe, a.configDir, 'usage')
      if (probe.usage) this.setUsage(id, probe.usage)
    } catch {
      /* try again after the next turn */
    }
  }

  private progress(p: LoginProgress): void {
    this.host.emit({ type: 'login', progress: p })
  }

  /** Runs the provider's own sign-in. It opens the browser and finishes by itself. */
  login(id: string): void {
    const a = this.get(id)
    if (!a) throw new Error('No such account')
    this.cancelLogin(id)
    if (this.host.demo) {
      this.progress({ accountId: id, state: 'waiting', url: 'https://example.com/sign-in' })
      setTimeout(() => {
        this.setStatus({ accountId: id, state: 'ready', email: 'new@example.com', plan: a.provider === 'chatgpt' ? 'ChatGPT Plus' : 'Pro', models: a.provider === 'claude' ? DEMO_MODELS : DEMO_GPT_MODELS, checkedAt: Date.now() })
        this.progress({ accountId: id, state: 'success' })
      }, 6000)
      return
    }
    const isClaude = a.provider === 'claude'
    const exe = isClaude ? findClaude(this.host.claudePath()) : findCodex()
    if (!exe) {
      this.progress({ accountId: id, state: 'failed', message: isClaude ? 'Claude Code is not installed.' : 'The ChatGPT runtime is missing.' })
      return
    }
    if (a.configDir) fs.mkdirSync(a.configDir, { recursive: true })
    this.progress({ accountId: id, state: 'starting' })
    const child = spawn(exe, isClaude ? ['auth', 'login'] : ['login'], {
      env: isClaude ? claudeEnv(a.configDir) : codexEnv(a.configDir),
      windowsHide: true,
    })
    this.logins.set(id, child)
    let url: string | undefined
    let tail = ''
    const onData = (d: Buffer): void => {
      const text = d.toString()
      tail = (tail + text).slice(-600)
      const m = /(https?:\/\/[^\s"']+)/.exec(text)
      if (m && !url) url = m[1]
      this.progress({ accountId: id, state: 'waiting', url })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      this.logins.delete(id)
      this.progress({ accountId: id, state: 'failed', message: e.message })
    })
    child.on('exit', (code) => {
      if (this.logins.get(id) !== child) return
      this.logins.delete(id)
      void this.refresh(id).then(() => {
        const ok = this.statuses.get(id)?.state === 'ready'
        this.progress(
          ok
            ? { accountId: id, state: 'success' }
            : { accountId: id, state: 'failed', message: code === 0 ? 'Sign-in did not complete.' : lastLine(tail) || 'Sign-in was not completed.' },
        )
      })
    })
  }

  /** Some sign-ins hand back a code to paste instead of redirecting. */
  submitLoginCode(id: string, code: string): void {
    this.logins.get(id)?.stdin?.write(code.trim() + '\n')
  }

  cancelLogin(id: string): void {
    const child = this.logins.get(id)
    if (!child) return
    this.logins.delete(id)
    child.kill()
    this.progress({ accountId: id, state: 'cancelled' })
  }

  async logout(id: string): Promise<void> {
    const a = this.get(id)
    if (!a) return
    const isClaude = a.provider === 'claude'
    const exe = isClaude ? findClaude(this.host.claudePath()) : findCodex()
    if (!exe) return
    await new Promise<void>((resolve) => {
      execFile(exe, isClaude ? ['auth', 'logout'] : ['logout'], { env: isClaude ? claudeEnv(a.configDir) : codexEnv(a.configDir), windowsHide: true, timeout: 20000 }, () => resolve())
    })
    this.usage.delete(id)
    await this.refresh(id)
  }

  dispose(): void {
    for (const c of this.logins.values()) c.kill()
    this.logins.clear()
  }
}

function prettyName(suffix: string): string {
  const m = /^account[-_]?(\d+)$/i.exec(suffix)
  if (m) return `Claude ${m[1]}`
  return suffix.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] || ''
}
