import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Check, CircleAlert, Download, ExternalLink, FolderOpen, Plus, Sparkles } from 'lucide-react'
import type { Account, AccountCandidate, Provider, SetupStatus, VaultInfo } from '@shared/types'
import { leadOf, useStore } from '@/store'
import { api, cn, tildify } from '@/lib/util'
import { Button, Spinner } from './ui'
import { Orb, OrbStack } from './Orb'
import { Logo } from './Sidebar'
import { SignInPanel } from './Accounts'

/**
 * First run, in three screens: connect an AI account (installing Claude Code if it is missing),
 * choose where the team keeps its memory, then a first request to try.
 */

type Step = 'connect' | 'memory' | 'ready'

const PROVIDERS: Record<Provider, { name: string; blurb: string; accent: 'clay' | 'green' }> = {
  claude: { name: 'Claude', blurb: 'Plans, builds and checks the work. Uses your Claude Pro or Max plan.', accent: 'clay' },
  chatgpt: { name: 'ChatGPT', blurb: 'Plans, builds and checks the work too, and draws images. Uses your ChatGPT plan.', accent: 'green' },
}

const IDEAS = [
  'Research the three best project management tools for a team of five and compare them in a table',
  'Plan a two-week launch for a new mobile app: what happens each day, and who on the team does it',
  'Explain how you and your teammates work together, and what kinds of things I should ask you to do',
]

const keyOf = (c: AccountCandidate): string => `${c.provider}:${c.configDir || ''}`

export function Onboarding() {
  const [step, setStep] = useState<Step>('connect')
  const [status, setStatus] = useState<SetupStatus | null>(null)
  useEffect(() => {
    void api.setupStatus().then(setStatus, () => setStatus({ claude: true, chatgpt: true, obsidian: true, gitBash: true }))
  }, [step])

  const index = step === 'connect' ? 0 : step === 'memory' ? 1 : 2
  return (
    <div className="fixed inset-0 z-40 flex justify-center overflow-y-auto bg-window">
      <div className="drag absolute inset-x-0 top-0 h-11" />
      <div className="w-[560px] max-w-[92vw] animate-rise py-12">
        <div className="mb-8 flex items-center justify-center gap-3">
          <Logo size={26} />
          <div className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of 3`}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={cn('h-1.5 rounded-full transition-all duration-300', i === index ? 'w-6 bg-ink' : i < index ? 'w-1.5 bg-ink-3' : 'w-1.5 bg-line-2')} />
            ))}
          </div>
        </div>
        {step === 'connect' && <ConnectStep status={status} onStatus={setStatus} onNext={() => setStep('memory')} />}
        {step === 'memory' && <MemoryStep status={status} onBack={() => setStep('connect')} onNext={() => setStep('ready')} />}
        {step === 'ready' && <ReadyStep status={status} onBack={() => setStep('memory')} />}
      </div>
    </div>
  )
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.03em]">{title}</h1>
      <p className="mx-auto mt-2.5 max-w-[440px] text-[14px] leading-relaxed text-ink-2">{children}</p>
    </div>
  )
}

// ───────────── 1. accounts ─────────────

function ConnectStep({ status, onStatus, onNext }: { status: SetupStatus | null; onStatus(s: SetupStatus): void; onNext(): void }) {
  const run = useStore((s) => s.run)
  const accounts = useStore((s) => s.accounts)
  const statuses = useStore((s) => s.statuses)
  const [found, setFound] = useState<AccountCandidate[] | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.discoverAccounts().then(
      (list) => {
        setFound(list)
        setPicked(Object.fromEntries(list.filter((c) => c.signedIn).map((c) => [keyOf(c), true])))
      },
      () => setFound([]),
    )
  }, [])

  const ready = accounts.filter((a) => statuses[a.id]?.state === 'ready')
  const chosen = (found || []).filter((c) => c.signedIn && picked[keyOf(c)])
  const count = ready.length + chosen.length

  const next = async (): Promise<void> => {
    setBusy(true)
    for (const c of chosen) await run(api.addAccount({ name: c.suggestedName, provider: c.provider, configDir: c.configDir }))
    setBusy(false)
    onNext()
  }

  return (
    <>
      <Heading title="Connect your AI">Sign in with the Claude or ChatGPT plan you already have. No API keys, nothing to configure. One account is enough; more make the team faster.</Heading>
      <div className="mt-8 space-y-3">
        {(['claude', 'chatgpt'] as Provider[]).map((p) => (
          <ProviderCard
            key={p}
            provider={p}
            status={status}
            onStatus={onStatus}
            found={found === null ? null : found.filter((c) => c.provider === p && c.signedIn)}
            signedOutFound={(found || []).filter((c) => c.provider === p && !c.signedIn)}
            picked={picked}
            onPick={(k) => setPicked((x) => ({ ...x, [k]: !x[k] }))}
          />
        ))}
      </div>
      <div className="mt-7 flex flex-col items-center gap-2.5">
        <Button variant="primary" size="lg" className="w-[240px]" disabled={busy || count === 0} onClick={() => void next()}>
          {busy ? <Spinner className="text-inverse" /> : null}
          Continue <ArrowRight className="size-4" />
        </Button>
        <p className="text-[12px] text-ink-3">{count === 0 ? 'Connect at least one account to continue.' : `${count} ${count === 1 ? 'account' : 'accounts'} on your team.`}</p>
      </div>
      <TryDemo />
    </>
  )
}

/** The second way in: watch a scripted team work before signing in to anything. */
function TryDemo() {
  const [going, setGoing] = useState(false)
  return (
    <div className="mt-7 flex items-center gap-3 rounded-[14px] border border-line px-4 py-3">
      <Sparkles className="size-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink">See it work first</div>
        <div className="text-[12px] text-ink-3">A scripted team: no account, no allowance, nothing sent anywhere.</div>
      </div>
      <Button
        size="sm"
        disabled={going}
        onClick={() => {
          setGoing(true)
          void api.switchDemo(true).catch(() => setGoing(false))
        }}
      >
        {going ? <Spinner /> : null}
        Try the demo team
      </Button>
    </div>
  )
}

function ProviderCard({
  provider,
  status,
  onStatus,
  found,
  signedOutFound,
  picked,
  onPick,
}: {
  provider: Provider
  status: SetupStatus | null
  onStatus(s: SetupStatus): void
  found: AccountCandidate[] | null
  signedOutFound: AccountCandidate[]
  picked: Record<string, boolean>
  onPick(key: string): void
}) {
  const meta = PROVIDERS[provider]
  const run = useStore((s) => s.run)
  const setModal = useStore((s) => s.setModal)
  const accounts = useStore((s) => s.accounts)
  const statuses = useStore((s) => s.statuses)
  const logins = useStore((s) => s.logins)
  const setup = useStore((s) => s.setup)
  const [signing, setSigning] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const mine = accounts.filter((a) => a.provider === provider)
  const connected = mine.filter((a) => statuses[a.id]?.state === 'ready')
  const signingAccount = signing ? accounts.find((a) => a.id === signing) : undefined
  const login = signing ? logins[signing] : undefined
  const needsInstall = provider === 'claude' && status !== null && !status.claude

  // A finished sign-in folds back into the connected list.
  useEffect(() => {
    if (signing && login?.state === 'success') setSigning(null)
  }, [signing, login?.state])

  const connect = async (): Promise<void> => {
    if (needsInstall) {
      setInstalling(true)
      const ok = await api.installClaude().catch(() => false)
      setInstalling(false)
      onStatus(await api.setupStatus())
      if (!ok) return
    }
    // Prefer the provider's usual folder (~/.claude, ~/.codex), so the account is the same one its own app uses.
    let account: Account | null | undefined = mine.find((a) => a.configDir === null && statuses[a.id]?.state !== 'ready')
    if (!account) {
      const usual = signedOutFound.find((c) => c.configDir === null)
      const usualTaken = mine.some((a) => a.configDir === null)
      account = await run(
        api.addAccount(
          usual || !usualTaken
            ? { name: meta.name, provider, configDir: null }
            : { name: `${meta.name} ${mine.length + 1}`, provider, create: true },
        ),
      )
    }
    if (!account) return
    await run(api.login(account.id))
    setSigning(account.id)
  }

  const showInstall = installing || (needsInstall && setup && setup.stage !== 'done')
  return (
    <div className="rounded-[18px] bg-surface p-4 shadow-float">
      <div className="flex items-start gap-3.5">
        <Orb account={{ accent: meta.accent }} size={34} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{meta.name}</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{meta.blurb}</div>
        </div>
      </div>

      {(connected.length > 0 || (found && found.length > 0)) && (
        <div className="mt-3 space-y-1">
          {connected.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-[11px] bg-ok-soft/60 px-3 py-2">
              <span className="flex size-[18px] items-center justify-center rounded-full bg-ok text-inverse">
                <Check className="size-3" strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">
                <span className="font-medium">{a.name}</span>
                <span className="text-ink-3">{statuses[a.id]?.email ? ` · ${statuses[a.id]?.email}` : ''} · connected</span>
              </span>
            </div>
          ))}
          {found?.map((c) => {
            const k = keyOf(c)
            const on = !!picked[k]
            return (
              <button key={k} role="checkbox" aria-checked={on} onClick={() => onPick(k)} className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2 text-left hover:bg-hover">
                <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors', on ? 'border-ink bg-ink text-inverse' : 'border-ink-4')}>
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="font-medium">{c.suggestedName}</span>
                  <span className="text-ink-3">
                    {c.email ? ` · ${c.email}` : ''}
                    {c.plan ? ` · ${c.plan}` : ''} · already signed in on this computer
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}

      {signingAccount && login?.state !== 'success' ? (
        <div className="mt-3 rounded-[14px] bg-surface-2">
          <SignInPanel account={signingAccount} />
          {(login?.state === 'failed' || login?.state === 'cancelled') && (
            <div className="-mt-3 pb-4 text-center">
              <Button variant="ghost" size="sm" onClick={() => setSigning(null)}>
                <ArrowLeft className="size-3.5" /> Back
              </Button>
            </div>
          )}
        </div>
      ) : showInstall ? (
        <InstallProgress />
      ) : (
        <div className="mt-3.5">
          {connected.length === 0 && !(found && found.some((c) => picked[keyOf(c)])) ? (
            <>
              {setup?.stage === 'failed' && provider === 'claude' && (
                <div className="mb-3 flex items-start gap-2 rounded-[11px] bg-bad-soft px-3 py-2.5 text-[12.5px] text-bad">
                  <CircleAlert className="mt-px size-4 shrink-0" />
                  <span className="selectable">{setup.message}</span>
                </div>
              )}
              <Button variant="primary" className="w-full" disabled={status === null || found === null} onClick={() => void connect()}>
                {needsInstall ? <Download className="size-4" /> : null}
                {needsInstall ? (setup?.stage === 'failed' ? 'Try again' : `Set up ${meta.name} and sign in`) : `Sign in with ${meta.name}`}
              </Button>
              {needsInstall && <p className="mt-2 text-center text-[11.5px] leading-relaxed text-ink-3">Ensemble downloads Claude Code from Anthropic (about 350 MB) and installs it for you. It takes a few minutes.</p>}
            </>
          ) : (
            <button onClick={() => (connected.length ? setModal({ kind: 'add-account' }) : void connect())} className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-3 hover:text-ink">
              <Plus className="size-3.5" /> Add another {meta.name} account
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function InstallProgress() {
  const setup = useStore((s) => s.setup)
  const pct = setup?.stage === 'download' ? setup.pct || 0 : setup?.stage === 'install' || setup?.stage === 'done' ? 100 : 0
  return (
    <div className="mt-3.5 rounded-[12px] bg-surface-2 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[12.5px]">
        <Spinner />
        <span className="flex-1">{setup?.stage === 'install' || setup?.stage === 'done' ? 'Setting up Claude Code…' : 'Downloading Claude Code…'}</span>
        {setup?.stage === 'download' && <span className="tabular text-ink-3">{pct}%</span>}
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ───────────── 2. memory ─────────────

type Choice = { kind: 'vault'; path: string } | { kind: 'new' } | { kind: 'pick' } | { kind: 'skip' }

function MemoryStep({ status, onBack, onNext }: { status: SetupStatus | null; onBack(): void; onNext(): void }) {
  const run = useStore((s) => s.run)
  const home = useStore((s) => s.env.home)
  const current = useStore((s) => s.settings.vaultPath)
  const [vaults, setVaults] = useState<VaultInfo[] | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.vaultList().then(
      (list) => {
        setVaults(list)
        const pre = list.find((v) => current && v.path.toLowerCase() === current.toLowerCase()) || list[0]
        setChoice(pre ? { kind: 'vault', path: pre.path } : { kind: 'new' })
      },
      () => {
        setVaults([])
        setChoice({ kind: 'new' })
      },
    )
    // Only on arrival: the preselection should not jump while the person is choosing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const next = async (): Promise<void> => {
    if (!choice) return
    setBusy(true)
    if (choice.kind === 'vault') await run(api.updateSettings({ vaultPath: choice.path }))
    else if (choice.kind === 'new') await run(api.createVault())
    else if (choice.kind === 'skip') await run(api.updateSettings({ vaultPath: null }))
    else {
      const picked = await api.pickFolder()
      if (!picked) return setBusy(false)
      await run(api.updateSettings({ vaultPath: picked }))
    }
    setBusy(false)
    onNext()
  }

  const same = (c: Choice): boolean => !!choice && choice.kind === c.kind && (c.kind !== 'vault' || (choice.kind === 'vault' && choice.path === c.path))
  const option = (c: Choice, icon: ReactNode, title: string, hint: string, tag?: string) => (
    <button
      key={c.kind === 'vault' ? c.path : c.kind}
      role="radio"
      aria-checked={same(c)}
      onClick={() => setChoice(c)}
      className={cn(
        'flex w-full items-center gap-3.5 rounded-[14px] px-4 py-3 text-left transition-all duration-150',
        same(c) ? 'bg-surface shadow-[inset_0_0_0_1.5px_var(--ink)]' : 'shadow-[inset_0_0_0_1px_var(--line)] hover:bg-surface-2',
      )}
    >
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[10px]', same(c) ? 'bg-ink text-inverse' : 'bg-surface-2 text-ink-2')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13.5px] font-medium">
          {title}
          {tag && <span className="rounded-full bg-ok-soft px-2 py-px text-[10.5px] font-medium text-ok">{tag}</span>}
        </span>
        <span className="block truncate text-[12px] text-ink-3">{hint}</span>
      </span>
      <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-full border', same(c) ? 'border-ink bg-ink text-inverse' : 'border-ink-4')}>{same(c) && <Check className="size-3" strokeWidth={3} />}</span>
    </button>
  )

  return (
    <>
      <Heading title="Give your team a memory">
        Ensemble keeps what your team learns in an Obsidian vault, a folder of plain notes you can read and edit. Every chat starts from what earlier chats found out.
      </Heading>
      <div className="mt-8 space-y-2">
        {vaults === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-3">
            <Spinner /> Looking for Obsidian vaults…
          </div>
        ) : (
          <>
            {vaults.map((v, i) => option({ kind: 'vault', path: v.path }, <BookOpen className="size-4" />, `Use ${v.name}`, tildify(v.path, home), i === 0 ? 'Found in Obsidian' : undefined))}
            {option({ kind: 'new' }, <Sparkles className="size-4" />, 'Make a new vault for me', 'A ready-to-use folder in Documents, with a short guide inside', vaults.length ? undefined : 'Recommended')}
            {option({ kind: 'pick' }, <FolderOpen className="size-4" />, 'Use another folder', 'Any folder of Markdown notes works')}
            {option({ kind: 'skip' }, <ArrowRight className="size-4" />, 'Skip for now', 'You can add a vault any time in Settings')}
          </>
        )}
      </div>
      {status && !status.obsidian && (
        <p className="mt-4 text-center text-[12px] leading-relaxed text-ink-3">
          You don't need Obsidian for this to work. To browse the notes yourself,{' '}
          <button onClick={() => void api.openExternal('https://obsidian.md/download')} className="inline-flex items-center gap-1 font-medium text-link hover:underline">
            get Obsidian (free) <ExternalLink className="size-3" />
          </button>
        </p>
      )}
      <div className="mt-7 flex items-center justify-center gap-2">
        <Button variant="ghost" size="lg" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button variant="primary" size="lg" className="w-[200px]" disabled={busy || !choice} onClick={() => void next()}>
          {busy ? <Spinner className="text-inverse" /> : null}
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </>
  )
}

// ───────────── 3. ready ─────────────

function ReadyStep({ status, onBack }: { status: SetupStatus | null; onBack(): void }) {
  const run = useStore((s) => s.run)
  const accounts = useStore((s) => s.accounts)
  const vault = useStore((s) => s.vault)
  const send = useStore((s) => s.send)
  const newChat = useStore((s) => s.newChat)
  const lead = useStore((s) => leadOf(s))
  const [busy, setBusy] = useState(false)
  const team = useMemo(() => accounts.filter((a) => a.enabled), [accounts])

  const finish = async (idea?: string): Promise<void> => {
    setBusy(true)
    await run(api.updateSettings({ onboarded: true, leadId: lead?.id || null }))
    newChat()
    if (idea) await send(idea)
  }

  const helpers = team.filter((a) => a.id !== lead?.id)
  return (
    <>
      <Heading title="Your team is ready">Ask for something real and watch the team split it up. Open the Team tab to see who is doing what.</Heading>
      <div className="mt-8 rounded-[18px] bg-surface p-4 shadow-float">
        <div className="flex items-center gap-3.5">
          <OrbStack accounts={team} size={30} max={5} />
          <div className="min-w-0 flex-1 text-[13px] leading-snug">
            <div>
              <span className="font-medium">{lead?.name || 'Your account'}</span> leads
              {helpers.length ? (
                <>
                  , with <span className="font-medium">{helpers.map((a) => a.name).join(', ')}</span> on the team
                </>
              ) : (
                ' and starts helper agents when the work splits'
              )}
              .
            </div>
            <div className="mt-0.5 text-ink-3">{vault ? `Memory: ${vault.name}` : 'No memory vault yet. Add one any time in Settings.'}</div>
          </div>
        </div>
        {status && !status.gitBash && team.some((a) => a.provider === 'claude') && (
          <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-3">
            Tip: Claude runs commands best with Git for Windows installed.{' '}
            <button onClick={() => void api.openExternal('https://git-scm.com/downloads/win')} className="inline-flex items-center gap-1 font-medium text-link hover:underline">
              Get it (free) <ExternalLink className="size-3" />
            </button>
          </p>
        )}
      </div>

      <div className="mt-6 text-[12px] font-medium text-ink-3">Try one</div>
      <div className="mt-2 space-y-2">
        {IDEAS.map((idea) => (
          <button
            key={idea}
            disabled={busy}
            onClick={() => void finish(idea)}
            className="group flex w-full items-center gap-3 rounded-[14px] px-4 py-3 text-left text-[13.5px] leading-snug shadow-[inset_0_0_0_1px_var(--line)] transition-all duration-150 hover:-translate-y-px hover:bg-surface hover:shadow-float disabled:opacity-50"
          >
            <span className="min-w-0 flex-1">{idea}</span>
            <ArrowRight className="size-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink" />
          </button>
        ))}
      </div>

      <div className="mt-7 flex items-center justify-center gap-2">
        <Button variant="ghost" size="lg" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button variant="primary" size="lg" className="w-[200px]" disabled={busy} onClick={() => void finish()}>
          {busy ? <Spinner className="text-inverse" /> : null}
          Start using Ensemble
        </Button>
      </div>
    </>
  )
}
