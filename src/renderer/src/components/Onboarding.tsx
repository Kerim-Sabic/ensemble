import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, Download, ExternalLink, FolderGit2, FolderOpen, Plus, Sparkles, X } from 'lucide-react'
import type { Account, AccountCandidate, Provider, SetupStatus } from '@shared/types'
import { firstTasks, projectKind, startFolder, unsafeFolder, type FirstFolders, type FirstTask, type FolderProbe } from '@shared/firstrun'
import { leadOf, useStore } from '@/store'
import { api, cn, tildify } from '@/lib/util'
import { Button, IconButton, Spinner } from './ui'
import { Orb } from './Orb'
import { Logo } from './Sidebar'
import { SignInPanel } from './Accounts'

/**
 * First run, in two screens: connect an AI account (installing Claude Code if it is missing), then
 * one real task to start. The memory vault no longer asks: one is made quietly (or the one already
 * chosen is kept), and Settings changes it.
 */

type Step = 'connect' | 'task'

const PROVIDERS: Record<Provider, { name: string; blurb: string; accent: 'clay' | 'green' }> = {
  claude: { name: 'Claude', blurb: 'Plans, builds and checks the work. Uses your Claude Pro or Max plan.', accent: 'clay' },
  chatgpt: { name: 'ChatGPT', blurb: 'Plans, builds and checks the work too, and draws images. Uses your ChatGPT plan.', accent: 'green' },
}


const keyOf = (c: AccountCandidate): string => `${c.provider}:${c.configDir || ''}`

export function Onboarding() {
  const [step, setStep] = useState<Step>('connect')
  const [status, setStatus] = useState<SetupStatus | null>(null)
  useEffect(() => {
    void api.setupStatus().then(setStatus, () => setStatus({ claude: true, chatgpt: true, obsidian: true, gitBash: true }))
  }, [step])

  const index = step === 'connect' ? 0 : 1
  return (
    <div className="fixed inset-0 z-40 flex justify-center overflow-y-auto bg-window">
      <div className="drag absolute inset-x-0 top-0 h-11" />
      <div className="w-[560px] max-w-[92vw] animate-rise py-12">
        <div className="mb-8 flex items-center justify-center gap-3">
          <Logo size={26} />
          <div className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of 2`}>
            {[0, 1].map((i) => (
              <span key={i} className={cn('h-1.5 rounded-full transition-all duration-300', i === index ? 'w-6 bg-ink' : i < index ? 'w-1.5 bg-ink-3' : 'w-1.5 bg-line-2')} />
            ))}
          </div>
        </div>
        {step === 'connect' && <ConnectStep status={status} onStatus={setStatus} onNext={() => setStep('task')} />}
        {step === 'task' && <TaskStep status={status} onBack={() => setStep('connect')} />}
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

  const vaultPath = useStore((s) => s.settings.vaultPath)
  const next = async (): Promise<void> => {
    setBusy(true)
    for (const c of chosen) await run(api.addAccount({ name: c.suggestedName, provider: c.provider, configDir: c.configDir }))
    // The memory no longer asks: keep the one already chosen, or make one quietly. Settings changes it.
    if (!vaultPath) void run(api.createVault())
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

// ───────────── 2. the first task ─────────────

const andList = (n: string[]): string => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`)

/** "Ensemble in Documents": a folder said by its name and where it is, without the whole path. */
const placeOf = (p: string): string => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.length > 1 ? `${parts[parts.length - 1]} in ${parts[parts.length - 2]}` : p
}

/**
 * Straight to one real task. First, where the team works: a project folder chosen here (one click
 * opens the picker, or a recent project), or else a new folder of the app's own, made when the task
 * starts. Never the home folder, a personal folder itself or a drive root. The three tasks offered
 * fit that folder: about the project when it is code, ones that need no files when it is empty.
 */
function TaskStep({ status, onBack }: { status: SetupStatus | null; onBack(): void }) {
  const run = useStore((s) => s.run)
  const accounts = useStore((s) => s.accounts)
  const vault = useStore((s) => s.vault)
  const send = useStore((s) => s.send)
  const newChat = useStore((s) => s.newChat)
  const draftCwd = useStore((s) => s.draftCwd)
  const home = useStore((s) => s.env.home)
  const demo = useStore((s) => s.env.demo)
  const setDraftCwd = useStore((s) => s.setDraftCwd)
  const lead = useStore((s) => leadOf(s))
  const [busy, setBusy] = useState<string | null>(null)
  const [probe, setProbe] = useState<FolderProbe | null>(null)
  const [folders, setFolders] = useState<FirstFolders | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const team = useMemo(() => accounts.filter((a) => a.enabled), [accounts])
  // The folder set before this screen counts only when it is safe; the home folder never does.
  const chosen = startFolder(draftCwd, home)

  useEffect(() => {
    void api.firstFolders().then(setFolders, () => setFolders({ app: '', recent: [] }))
  }, [])
  useEffect(() => {
    let live = true
    setProbe(null)
    if (!chosen) return
    void api.folderProbe(chosen).then(
      (p) => live && setProbe(p),
      () => live && setProbe({ path: chosen, name: '', entries: [], git: false, missing: true }),
    )
    return () => {
      live = false
    }
  }, [chosen])
  const ready = !chosen || !!probe
  const tasks = useMemo(() => firstTasks(chosen ? probe : null), [chosen, probe])
  const kind = chosen && probe && !probe.missing ? projectKind(probe) : null

  /** A folder the person chose: kept when it is safe, refused in one sentence when it is not. */
  const choose = (p: string | null): void => {
    if (!p) return
    const why = unsafeFolder(p, home)
    setRefused(why)
    if (!why) setDraftCwd(p)
  }
  // Screenshot runs cannot drive the system's folder picker; the demo lets them hand in a path.
  useEffect(() => {
    if (!demo) return
    const w = window as unknown as { __pickFolder?: (p: string) => void }
    w.__pickFolder = choose
    return () => {
      delete w.__pickFolder
    }
  })
  const pick = async (): Promise<void> => choose(await api.pickFolder())

  const start = async (task?: FirstTask): Promise<void> => {
    setBusy(task?.title || 'empty')
    // No folder chosen: the app's own, made now.
    const dir = chosen || (await api.makeFirstFolder().catch(() => null))
    if (!dir || unsafeFolder(dir, home)) {
      setBusy(null)
      setRefused('The new folder could not be made, so choose a project folder.')
      return
    }
    await run(api.updateSettings({ onboarded: true, leadId: lead?.id || null }))
    newChat()
    setDraftCwd(dir)
    if (task) await send(task.text)
  }
  const helpers = team.filter((a) => a.id !== lead?.id)
  const recent = (folders?.recent || []).filter((r) => r.path !== chosen).slice(0, 4)
  const appPlace = folders?.app ? placeOf(folders.app) : 'Ensemble in Documents'

  return (
    <>
      <Heading title="Start with one real task">
        Pick one and {lead?.name || 'your lead'} starts on it now{helpers.length ? `, with ${andList(helpers.map((a) => a.name))} on the team` : ''}. You can watch it work and steer it as it goes.
      </Heading>

      <div className="mt-7 rounded-[16px] bg-surface p-4 shadow-card">
        <div className="flex items-center gap-3">
          <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[10px]', chosen ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-ink-2')}>
            {chosen && probe?.git ? <FolderGit2 className="size-[18px]" /> : <FolderOpen className="size-[18px]" />}
          </span>
          <div className="min-w-0 flex-1">
            {chosen ? (
              <>
                <div className="truncate text-[14px] font-semibold" title={chosen}>
                  {probe?.name || placeOf(chosen)}
                </div>
                <div className="truncate text-[12.5px] text-ink-3" title={chosen}>
                  {[kind?.code ? `${kind.kind ? `${kind.kind} project` : 'Code project'}` : probe && !probe.missing ? (probe.entries.length ? 'Folder' : 'Empty folder') : null, probe?.git ? 'git' : null, tildify(chosen, home)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </>
            ) : (
              <>
                <div className="text-[14px] font-semibold">Where should the team work?</div>
                <div className="text-[12.5px] leading-snug text-ink-3">
                  Choose your project folder. Without one, the team works in a new folder, <span className="font-medium text-ink-2" title={folders?.app || undefined}>{appPlace}</span>.
                </div>
              </>
            )}
          </div>
          {chosen ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void pick()}>
                Change
              </Button>
              <IconButton label="Use a new folder instead" disabled={!!busy} onClick={() => {
                  setRefused(null)
                  setDraftCwd(null)
                }}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          ) : (
            <Button variant="primary" size="md" disabled={!!busy} onClick={() => void pick()}>
              Choose a project folder
            </Button>
          )}
        </div>

        {recent.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
            <span className="mr-1 text-[12px] text-ink-3">{chosen ? 'Or another recent project' : 'Recent projects'}</span>
            {recent.map((r) => (
              <button
                key={r.path}
                title={r.path}
                disabled={!!busy}
                onClick={() => choose(r.path)}
                className="flex max-w-[180px] items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
              >
                <FolderGit2 className="size-3.5 shrink-0 text-ink-3" />
                <span className="truncate">{r.name}</span>
              </button>
            ))}
          </div>
        )}

        {refused && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] leading-snug text-bad">
            <CircleAlert className="mt-px size-4 shrink-0" />
            <span>{refused}</span>
          </div>
        )}
      </div>

      <div className="mt-5 mb-2 px-1 text-[12px] font-medium text-ink-3">{chosen ? `Then pick a task for ${probe?.name || 'this folder'}` : 'Then pick a task'}</div>
      <div className="space-y-2">
        {(ready ? tasks : [null, null, null]).map((t, i) =>
          t ? (
            <button
              key={t.title}
              disabled={!!busy}
              onClick={() => void start(t)}
              className="group flex w-full items-center gap-3.5 rounded-[14px] bg-surface px-4 py-3.5 text-left shadow-card transition-all duration-150 hover:-translate-y-px hover:shadow-float disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold">{t.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{t.blurb}</span>
              </span>
              {busy === t.title ? <Spinner /> : <ArrowRight className="size-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink" />}
            </button>
          ) : (
            <div key={i} className="h-[66px] animate-pulse-soft rounded-[14px] bg-surface-2" />
          ),
        )}
      </div>

      <p className="mt-4 text-center text-[12px] leading-relaxed text-ink-3">
        {vault ? `Your team keeps its notes in ${vault.name}. Change that any time in Settings.` : 'Your team keeps its notes in a vault made for you. Change that any time in Settings.'}
      </p>
      {status && !status.gitBash && team.some((a) => a.provider === 'claude') && (
        <p className="mt-1.5 text-center text-[12px] leading-relaxed text-ink-3">
          Claude runs commands best with Git for Windows.{' '}
          <button onClick={() => void api.openExternal('https://git-scm.com/downloads/win')} className="inline-flex items-center gap-1 font-medium text-link hover:underline">
            Get it (free) <ExternalLink className="size-3" />
          </button>
        </p>
      )}

      <div className="mt-6 flex items-center justify-center gap-2">
        <Button variant="ghost" onClick={onBack} disabled={!!busy}>
          <ArrowLeft className="size-4" /> Accounts
        </Button>
        <Button variant="ghost" disabled={!!busy} onClick={() => void start()}>
          {busy === 'empty' ? <Spinner /> : null}
          Start with an empty chat
        </Button>
      </div>
    </>
  )
}
