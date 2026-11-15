import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, CircleAlert, ExternalLink, LogIn, LogOut, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { ACCENTS, type AccentKey, type Account, type AccountCandidate, type Provider } from '@shared/types'
import { adviseModel, budgetOf, modelForTier } from '@shared/budget'
import { leadOf, useStore } from '@/store'
import { ACCENT, accentVars, api, cn, tildify, until } from '@/lib/util'
import { Button, IconButton, Menu, MenuItem, Modal, Row, Spinner, Toggle, inputClass } from './ui'
import { Orb, UsageBar } from './Orb'

const PROVIDER: Record<Provider, { name: string; blurb: string; accent: AccentKey }> = {
  claude: { name: 'Claude', blurb: 'Claude Code, on your Claude plan', accent: 'clay' },
  chatgpt: { name: 'ChatGPT', blurb: 'Codex, on your ChatGPT plan. Can make images.', accent: 'green' },
}

export function Picker<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  width,
}: {
  value: T | null
  options: { value: T; label: string; hint?: string }[]
  onChange(v: T): void
  placeholder?: string
  width?: number
}) {
  const current = options.find((o) => o.value === value)
  return (
    <Menu
      align="end"
      width={width || 220}
      trigger={
        <button className="flex h-8 max-w-[240px] items-center gap-2 rounded-[9px] bg-surface-2 pr-2 pl-3 text-[13px] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-surface-3">
          <span className="truncate">{current?.label || placeholder || 'Choose'}</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        </button>
      }
    >
      {options.map((o) => (
        <MenuItem key={o.value} checked={o.value === value} hint={o.hint} onSelect={() => onChange(o.value)}>
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

/** The waiting room while the provider's own sign-in runs in the browser. */
export function SignInPanel({ account, onDone }: { account: Account; onDone?(): void }) {
  const progress = useStore((s) => s.logins[account.id])
  const [code, setCode] = useState('')
  const state = progress?.state || 'starting'

  if (state === 'success') {
    return (
      <div className="flex flex-col items-center px-6 py-8 text-center">
        <span className="flex size-11 animate-pop items-center justify-center rounded-full bg-ok-soft text-ok">
          <Check className="size-5" strokeWidth={2.5} />
        </span>
        <div className="mt-3.5 text-[15px] font-semibold">{account.name} is signed in</div>
        <p className="mt-1 text-[13px] text-ink-2">It is on the team and ready to work.</p>
        {onDone && (
          <Button variant="primary" className="mt-5" onClick={onDone}>
            Done
          </Button>
        )}
      </div>
    )
  }

  if (state === 'failed' || state === 'cancelled') {
    return (
      <div className="flex flex-col items-center px-6 py-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-bad-soft text-bad">
          <CircleAlert className="size-5" />
        </span>
        <div className="mt-3.5 text-[15px] font-semibold">{state === 'cancelled' ? 'Sign-in cancelled' : 'Sign-in did not finish'}</div>
        {progress?.message && <p className="selectable mt-1 max-w-[340px] text-[13px] text-ink-2">{progress.message}</p>}
        <Button variant="primary" className="mt-5" onClick={() => void api.login(account.id)}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center px-6 py-7 text-center" style={accentVars(account.accent)}>
      <Orb account={account} size={44} live />
      <div className="mt-4 text-[15px] font-semibold">Finish signing in in your browser</div>
      <p className="mt-1.5 max-w-[340px] text-[13px] leading-relaxed text-ink-2">
        A {PROVIDER[account.provider].name} sign-in page just opened. Choose the account you want for <span className="font-medium text-ink">{account.name}</span>, then come back here.
      </p>
      <div className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-3">
        <Spinner /> Waiting for you…
      </div>
      {progress?.url && (
        <button onClick={() => void api.openExternal(progress.url as string)} className="mt-4 flex items-center gap-1.5 text-[12.5px] font-medium text-link hover:underline">
          <ExternalLink className="size-3.5" /> Open the sign-in page again
        </button>
      )}
      {account.provider === 'claude' && (
        <div className="mt-5 w-full max-w-[340px]">
          <div className="mb-1.5 text-left text-[11.5px] text-ink-3">If the page shows you a code instead, paste it here:</div>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code" className={inputClass} />
            <Button
              disabled={!code.trim()}
              onClick={() => {
                void api.submitLoginCode(account.id, code)
                setCode('')
              }}
            >
              Submit
            </Button>
          </div>
        </div>
      )}
      <Button variant="ghost" size="sm" className="mt-5" onClick={() => void api.cancelLogin(account.id)}>
        Cancel
      </Button>
    </div>
  )
}

function CandidateRow({ c, onAdd, busy }: { c: AccountCandidate; onAdd(): void; busy: boolean }) {
  const home = useStore((s) => s.env.home)
  return (
    <div className="flex items-center gap-3 rounded-[12px] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
      <Orb account={{ accent: PROVIDER[c.provider].accent }} size={26} off={!c.signedIn} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13.5px] font-medium">{c.suggestedName}</span>
          <span className="text-[11.5px] text-ink-3">
            {PROVIDER[c.provider].name}
            {c.plan ? ` · ${c.plan}` : ''}
          </span>
        </div>
        <div className="truncate text-[12px] text-ink-3">{c.signedIn ? c.email || tildify(c.configDir || (c.provider === 'claude' ? '~/.claude' : '~/.codex'), home) : 'Signed out'}</div>
      </div>
      <Button size="sm" variant={c.signedIn ? 'primary' : 'secondary'} disabled={busy} onClick={onAdd}>
        {c.signedIn ? 'Add' : 'Sign in'}
      </Button>
    </div>
  )
}

export function AddAccountDialog() {
  const open = useStore((s) => s.modal?.kind === 'add-account')
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const accounts = useStore((s) => s.accounts)
  const [candidates, setCandidates] = useState<AccountCandidate[] | null>(null)
  const [step, setStep] = useState<{ kind: 'pick' } | { kind: 'name'; provider: Provider } | { kind: 'signin'; id: string }>({ kind: 'pick' })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep({ kind: 'pick' })
    setName('')
    setCandidates(null)
    void api.discoverAccounts().then(setCandidates, () => setCandidates([]))
  }, [open])

  const close = (): void => setModal(null)
  const signingIn = step.kind === 'signin' ? accounts.find((a) => a.id === step.id) : undefined

  const addExisting = async (c: AccountCandidate): Promise<void> => {
    setBusy(true)
    const a = await run(api.addAccount({ name: c.suggestedName, provider: c.provider, configDir: c.configDir }))
    setBusy(false)
    if (!a) return
    if (c.signedIn) {
      setCandidates((list) => (list || []).filter((x) => x !== c))
    } else {
      await run(api.login(a.id))
      setStep({ kind: 'signin', id: a.id })
    }
  }

  const createNew = async (provider: Provider): Promise<void> => {
    setBusy(true)
    const a = await run(api.addAccount({ name: name.trim() || PROVIDER[provider].name, provider, create: true }))
    setBusy(false)
    if (!a) return
    await run(api.login(a.id))
    setStep({ kind: 'signin', id: a.id })
  }

  return (
    <Modal
      open={open}
      onClose={close}
      width={500}
      title={step.kind === 'signin' ? 'Sign in' : step.kind === 'name' ? `New ${PROVIDER[step.provider].name} account` : 'Add an account'}
      description={step.kind === 'pick' ? 'Each account joins the team with its own allowance.' : undefined}
    >
      {step.kind === 'pick' && (
        <div className="space-y-5 overflow-y-auto px-6 pt-3 pb-6">
          {candidates === null ? (
            <div className="flex items-center gap-2 py-3 text-[13px] text-ink-3">
              <Spinner /> Looking for accounts on this computer…
            </div>
          ) : (
            candidates.length > 0 && (
              <section>
                <div className="mb-2 text-[12px] font-medium text-ink-3">Already on this computer</div>
                <div className="space-y-1.5">
                  {candidates.map((c) => (
                    <CandidateRow key={`${c.provider}:${c.configDir}`} c={c} busy={busy} onAdd={() => void addExisting(c)} />
                  ))}
                </div>
              </section>
            )
          )}
          <section>
            <div className="mb-2 text-[12px] font-medium text-ink-3">Sign in to another account</div>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PROVIDER) as Provider[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setStep({ kind: 'name', provider: p })}
                  className="flex flex-col items-start rounded-[14px] px-4 py-3.5 text-left shadow-[inset_0_0_0_1px_var(--line)] transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--line-2)]"
                >
                  <Orb account={{ accent: PROVIDER[p].accent }} size={28} />
                  <span className="mt-3 text-[14px] font-semibold">{PROVIDER[p].name}</span>
                  <span className="mt-0.5 text-[12px] leading-snug text-ink-3">{PROVIDER[p].blurb}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {step.kind === 'name' && (
        <div className="px-6 pt-3 pb-6">
          <label className="mb-1.5 block text-[12px] font-medium text-ink-2">What should this teammate be called?</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && void createNew(step.provider)}
            placeholder={step.provider === 'claude' ? 'For example: Work, Claude 4' : 'For example: ChatGPT, Images'}
            className={inputClass}
          />
          <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
            Next, a {PROVIDER[step.provider].name} sign-in page opens in your browser. Sign in with the account you want here. Its sign-in is kept in its own folder, separate from your other accounts.
          </p>
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStep({ kind: 'pick' })}>
              <ArrowLeft className="size-3.5" /> Back
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void createNew(step.provider)}>
              {busy ? <Spinner className="text-inverse" /> : <LogIn className="size-3.5" />} Continue to sign-in
            </Button>
          </div>
        </div>
      )}

      {step.kind === 'signin' && signingIn && <SignInPanel account={signingIn} onDone={close} />}
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[12px] font-medium text-ink-3">{title}</div>
      {children}
    </section>
  )
}

export function AccountSheet() {
  const id = useStore((s) => (s.modal?.kind === 'account' ? s.modal.id : null))
  const account = useStore((s) => s.accounts.find((a) => a.id === id))
  const status = useStore((s) => (id ? s.statuses[id] : undefined))
  const usage = useStore((s) => (id ? s.usage[id] : undefined))
  const login = useStore((s) => (id ? s.logins[id] : undefined))
  const isLead = useStore((s) => leadOf(s)?.id === id)
  const home = useStore((s) => s.env.home)
  const smart = useStore((s) => s.settings.smartModels)
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const [refreshing, setRefreshing] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  // How the allowance stands against the time it has to last, and what the app runs because of it.
  const budget = useMemo(() => budgetOf(usage), [usage])
  const advice = smart && account?.provider === 'claude' && !account.model ? adviseModel(budget, isLead ? 'lead' : 'worker') : null

  useEffect(() => setSigningIn(false), [id])

  if (!account) return <Modal open={false} onClose={() => setModal(null)} title="Account" children={null} />

  const close = (): void => setModal(null)
  const out = status?.state === 'signed-out'
  const auto = smart && account.provider === 'claude'
  const models = [
    { value: '', label: auto ? 'Best for the allowance' : 'Account default', hint: auto ? 'The strongest model the allowance can afford, chosen each time it starts' : 'Whatever this account is set to use' },
    ...(status?.models || []).filter((m) => m.value).map((m) => ({ value: m.value, label: m.label, hint: m.description })),
  ]
  const efforts =
    (status?.models?.find((m) => m.value === (account.model || 'default')) || status?.models?.find((m) => m.isDefault) || status?.models?.find((m) => m.efforts?.length))?.efforts?.filter((e) => e !== 'ultra') ||
    (account.provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'])
  const inFlight = signingIn && login && login.state !== 'cancelled'

  return (
    <Modal open onClose={close} title={account.name} bare width={480}>
      <div className="overflow-y-auto" style={accentVars(account.accent)}>
        <div className="relative flex flex-col items-center px-6 pt-8 pb-5">
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[var(--a-soft)] to-transparent" />
          <Orb account={account} size={56} off={out || !account.enabled} className="relative" />
          <input
            key={account.id}
            defaultValue={account.name}
            aria-label="Name"
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== account.name && void run(api.updateAccount(account.id, { name: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className="selectable relative mt-3 w-full rounded-[8px] bg-transparent py-0.5 text-center text-[18px] font-semibold tracking-[-0.015em] outline-none hover:bg-hover focus:bg-surface-2"
          />
          <div className="relative mt-0.5 text-[12.5px] text-ink-3">
            {PROVIDER[account.provider].name}
            {status?.plan && status.plan !== 'ChatGPT' ? ` · ${status.plan.replace(/^ChatGPT\s+/, '')}` : ''}
            {isLead ? ' · Team lead' : ''}
          </div>
          {status?.email && <div className="selectable relative mt-0.5 text-[12px] text-ink-3">{status.email}</div>}
        </div>

        {inFlight ? (
          <div className="border-t border-line">
            <SignInPanel account={account} onDone={() => setSigningIn(false)} />
          </div>
        ) : (
          <div className="space-y-6 px-6 pb-6">
            {out && (
              <div className="flex items-center gap-3 rounded-[12px] bg-warn-soft px-3.5 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_30%,transparent)]">
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="font-medium">This account is signed out</div>
                  <div className="text-[12px] text-ink-2">Sign in to put it back on the team.</div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setSigningIn(true)
                    void run(api.login(account.id))
                  }}
                >
                  <LogIn className="size-3.5" /> Sign in
                </Button>
              </div>
            )}
            {status?.state === 'error' && (
              <div className="selectable rounded-[12px] bg-bad-soft px-3.5 py-3 text-[13px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--bad)_25%,transparent)]">{status.error}</div>
            )}

            {!out && (account.provider === 'claude' || usage?.session || usage?.weekly) && (
              <Section title="Allowance">
                <div className="space-y-3.5 rounded-[12px] px-3.5 py-3.5 shadow-[inset_0_0_0_1px_var(--line)]">
                  <UsageBar label="Current session" window={usage?.session} sub={usage?.session?.resetsAt ? `refills in ${until(usage.session.resetsAt)}` : undefined} />
                  <UsageBar label="This week" window={usage?.weekly} pace={budget.weekly?.pace} sub={usage?.weekly?.resetsAt ? `refills in ${until(usage.weekly.resetsAt)}` : undefined} />
                  {usage?.scoped?.map((sc) => (
                    <UsageBar
                      key={sc.label}
                      label={`${sc.label} this week`}
                      window={{ utilization: sc.utilization, resetsAt: sc.resetsAt }}
                      pace={budget.top?.label === sc.label ? budget.top.pace : undefined}
                      sub={sc.resetsAt && sc.resetsAt > Date.now() ? `refills in ${until(sc.resetsAt)}` : undefined}
                    />
                  ))}
                  {advice && (
                    <div className="flex items-start gap-2 rounded-[9px] bg-surface-2 px-2.5 py-2 text-[12px] leading-snug text-ink-2">
                      <Sparkles className="mt-px size-3.5 shrink-0 text-ink-3" strokeWidth={1.9} />
                      <span>
                        <span className="font-medium text-ink">
                          Runs {modelForTier(status?.models || [], advice.tier)?.label || (advice.tier === 'top' ? budget.top?.label || 'its strongest model' : advice.tier === 'strong' ? 'the next model down' : 'its everyday model')}
                          {advice.effort ? ' at high effort' : ''} for now.
                        </span>{' '}
                        {advice.why}.
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-0.5 text-[11.5px] text-ink-3">
                    <span>Reading this costs nothing.</span>
                    <button
                      className="flex items-center gap-1 font-medium hover:text-ink"
                      onClick={async () => {
                        setRefreshing(true)
                        await run(api.refreshAccounts(account.id))
                        setRefreshing(false)
                      }}
                    >
                      <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} /> Refresh
                    </button>
                  </div>
                </div>
              </Section>
            )}

            <Section title="Best at">
              <input
                key={`${account.id}:${account.role || ''}`}
                defaultValue={account.role || ''}
                placeholder={account.provider === 'chatgpt' ? 'For example: images and a second opinion' : 'For example: frontend and visual polish'}
                aria-label="What this teammate is best at"
                maxLength={160}
                onBlur={(e) => (e.target.value.trim() || '') !== (account.role || '') && void run(api.updateAccount(account.id, { role: e.target.value.trim() || null }))}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                className={inputClass}
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(account.provider === 'chatgpt' ? ['Images and a second opinion', 'Research'] : ['Frontend and design', 'Backend and data', 'Tests and review', 'Research and writing']).map((r) => (
                  <button
                    key={r}
                    onClick={() => void run(api.updateAccount(account.id, { role: r }))}
                    className={cn(
                      'h-6 rounded-full px-2.5 text-[11.5px] transition-colors',
                      account.role === r ? 'bg-ink text-inverse' : 'text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-hover hover:text-ink',
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">The lead sees this and sends matching work here first. Leave it empty for a generalist.</p>
            </Section>

            <Section title="How it works">
              <div className="divide-y divide-line rounded-[12px] px-3.5 shadow-[inset_0_0_0_1px_var(--line)]">
                {models.length > 1 && (
                  <Row label="Model">
                    <Picker value={account.model || ''} options={models} width={280} onChange={(v) => void run(api.updateAccount(account.id, { model: v || null }))} />
                  </Row>
                )}
                <Row label="Effort" hint="Higher thinks longer and uses more allowance.">
                  <Picker
                    value={account.effort || ''}
                    options={[{ value: '', label: 'Default' }, ...efforts.map((e) => ({ value: e, label: e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1) }))]}
                    onChange={(v) => void run(api.updateAccount(account.id, { effort: v || null }))}
                  />
                </Row>
                <Row label="Team lead" hint="The lead plans the work and hands parts of it to the others.">
                  {isLead ? (
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2">
                      <Check className="size-3.5 text-ok" strokeWidth={2.5} /> Leading
                    </span>
                  ) : (
                    <Button size="sm" disabled={out || !account.enabled} onClick={() => void run(api.updateSettings({ leadId: account.id }))}>
                      Make lead
                    </Button>
                  )}
                </Row>
                <Row label="On the team" hint="Turn off to keep the account but leave it out of the work.">
                  <Toggle checked={account.enabled} onChange={(v) => void run(api.updateAccount(account.id, { enabled: v }))} label="On the team" />
                </Row>
              </div>
            </Section>

            <Section title="Colour">
              <div className="flex gap-2">
                {ACCENTS.map((k) => (
                  <button
                    key={k}
                    aria-label={ACCENT[k].label}
                    onClick={() => void run(api.updateAccount(account.id, { accent: k }))}
                    className={cn('rounded-full p-[3px] transition-shadow', account.accent === k ? 'shadow-[0_0_0_2px_var(--ink)]' : 'hover:shadow-[0_0_0_2px_var(--line-2)]')}
                  >
                    <Orb account={{ accent: k }} size={22} />
                  </button>
                ))}
              </div>
            </Section>

            <div className="flex items-center gap-2 border-t border-line pt-4">
              <span className="selectable min-w-0 flex-1 truncate font-mono text-[11px] text-ink-4" title="Where this account's sign-in lives">
                {tildify(account.configDir || (account.provider === 'claude' ? `${home}\\.claude` : `${home}\\.codex`), home)}
              </span>
              {!out && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setModal({
                      kind: 'confirm',
                      title: `Sign ${account.name} out?`,
                      body: account.configDir ? 'It stays on the team list, but cannot work until you sign in again.' : 'This is the account your regular Claude Code or Codex app uses, so signing out here signs that out too.',
                      action: 'Sign out',
                      run: () => void run(api.logout(account.id)),
                    })
                  }
                >
                  <LogOut className="size-3.5" /> Sign out
                </Button>
              )}
              <IconButton
                label="Remove from Ensemble"
                side="top"
                className="hover:bg-bad-soft hover:text-bad"
                onClick={() =>
                  setModal({
                    kind: 'confirm',
                    title: `Remove ${account.name}?`,
                    body: 'It leaves the team here. The account itself and its sign-in are not touched, so you can add it back any time.',
                    action: 'Remove',
                    run: () => void run(api.removeAccount(account.id)),
                  })
                }
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
