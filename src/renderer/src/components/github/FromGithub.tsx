// "From GitHub" on the new-chat screen: pick an open issue, an open pull request or a failed run of
// the folder's repository (or of a pasted address), and start it as verified work: a goal in the
// Verified way of working, checked by a fresh pair of eyes. Ensemble only reads GitHub; the team
// prepares the work and stops before pushing or posting anything.

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, CircleDot, CircleX, GitBranch, GitMerge, GitPullRequest, RotateCw } from 'lucide-react'
import type { GhIssue, GhKind, GhList, GhPull, GhRun } from '@shared/github'
import { refLabel, requestFor, startWarning, stateWords } from '@shared/github'
import { leadOf, useStore } from '@/store'
import { api, cn, tildify } from '@/lib/util'
import { Button, Modal, Segmented, Spinner, Tip, inputClass } from '../ui'

type Tab = Exclude<GhKind, 'repo'>

/** Opens the dialog from anywhere (a typed "/github <address>" can use this too). */
export const OPEN_GITHUB = 'ensemble:github'
let pending: string | null = null
export function openGithub(address?: string): void {
  // Starting from GitHub makes a new chat in the folder, so from inside a chat it opens on a new
  // chat in the same folder; the starter there picks the address up once it is on screen.
  pending = address || ''
  if (useStore.getState().chatId) useStore.getState().newChat()
  window.dispatchEvent(new CustomEvent(OPEN_GITHUB, { detail: { address: pending } }))
}

function ago(iso: string): string {
  const t = Date.parse(iso)
  if (!t) return ''
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (m < 60) return m <= 1 ? 'just now' : `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : d < 31 ? `${d} days ago` : new Date(t).toLocaleDateString()
}

const Sep = () => <span className="text-ink-4">·</span>

function Row({ icon, title, meta, focus, busy, disabled, onStart }: { icon: ReactNode; title: string; meta: ReactNode; focus?: boolean; busy: boolean; disabled: boolean; onStart(): void }) {
  return (
    <div className={cn('group flex items-center gap-3 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-hover', focus && 'bg-hover')}>
      <span className="flex size-5 shrink-0 items-center justify-center self-start pt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-[18px] font-medium" title={title}>
          {title}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11.5px] leading-[16px] text-ink-3">{meta}</div>
      </div>
      <Button size="sm" variant={focus ? 'primary' : 'soft'} disabled={disabled} onClick={onStart} className={cn('shrink-0', !focus && !busy && 'opacity-80 group-hover:opacity-100')}>
        {busy ? <Spinner className="text-current" /> : 'Start'}
      </Button>
    </div>
  )
}

function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-12 text-center">
      {icon && <span className="mb-3 flex size-9 items-center justify-center rounded-full bg-hover text-ink-3">{icon}</span>}
      <div className="max-w-[400px] text-[13px] leading-relaxed text-ink-2">{children}</div>
    </div>
  )
}

export function GithubDialog({ open, onClose, initial }: { open: boolean; onClose(): void; initial?: string }) {
  const cwd = useStore((s) => s.draftCwd)
  const home = useStore((s) => s.env.home)
  const leadId = useStore((s) => leadOf(s)?.id)
  const send = useStore((s) => s.send)
  const toast = useStore((s) => s.toast)
  const [address, setAddress] = useState(initial || '')
  const [asked, setAsked] = useState(initial || '')
  const [list, setList] = useState<GhList | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('issue')
  const [starting, setStarting] = useState<string | null>(null)
  /** Said before starting from a closed issue, a merged or closed pull request, or a run that has passed since. */
  const [warn, setWarn] = useState<{ kind: Tab; number: number; text: string } | null>(null)

  const load = useCallback(
    async (addr: string) => {
      setLoading(true)
      try {
        const l = await api.githubList({ cwd, address: addr || null })
        setList(l)
        if (l.focus) setTab(l.focus.kind)
        else if (!l.issues.length && l.pulls.length) setTab('pull')
        else if (!l.issues.length && !l.pulls.length && l.runs.length) setTab('run')
      } catch (e) {
        setList({ repo: null, via: null, issues: [], pulls: [], runs: [], problem: { kind: 'failed', text: (e as Error).message || 'Reading GitHub failed.' } })
      } finally {
        setLoading(false)
      }
    },
    [cwd],
  )

  useEffect(() => {
    if (!open) return
    setAddress(initial || '')
    setAsked(initial || '')
    setList(null)
    setWarn(null)
    setTab('issue')
    void load(initial || '')
  }, [open, initial, load])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    setAsked(address.trim())
    void load(address.trim())
  }

  const start = async (kind: Tab, number: number, sure = false): Promise<void> => {
    if (!list?.repo || starting) return
    if (!sure) {
      const row =
        kind === 'issue'
          ? list.issues.find((i) => i.number === number)
          : kind === 'pull'
            ? list.pulls.find((p) => p.number === number)
            : list.runs.find((r) => r.id === number)
      const w = row ? startWarning(kind === 'issue' ? { kind, issue: row as GhIssue } : kind === 'pull' ? { kind, pull: row as GhPull } : { kind, run: row as GhRun }) : null
      if (w) {
        setWarn({ kind, number, text: w })
        return
      }
    }
    setWarn(null)
    const key = `${kind}:${number}`
    setStarting(key)
    try {
      const item = await api.githubItem({ repo: refLabel(list.repo), kind, number })
      const req = requestFor(item)
      const ok = await send(req.text, undefined, leadId, { mode: req.mode, goal: req.goal })
      if (ok) {
        const id = useStore.getState().chatId
        if (id) void api.updateChat(id, { title: req.title }).catch(() => undefined)
        onClose()
      }
    } catch (e) {
      toast((e as Error).message || 'Could not read that from GitHub.', 'error')
    } finally {
      setStarting(null)
    }
  }

  const counts = { issue: list?.issues.length || 0, pull: list?.pulls.length || 0, run: list?.runs.length || 0 }
  const focus = list?.focus
  const folder = cwd ? tildify(cwd, home) : 'this folder'
  const busy = !!starting

  const rows = useMemo(() => {
    if (!list) return null
    const isFocus = (k: Tab, n: number): boolean => focus?.kind === k && focus.number === n
    if (tab === 'issue')
      return list.issues.map((i: GhIssue) => (
        <Row
          key={i.number}
          icon={i.state === 'closed' ? <CircleCheck className="size-4 text-ink-3" strokeWidth={2} /> : <CircleDot className="size-4 text-ok" strokeWidth={2} />}
          title={i.title}
          focus={isFocus('issue', i.number)}
          busy={starting === `issue:${i.number}`}
          disabled={busy}
          onStart={() => void start('issue', i.number)}
          meta={
            <>
              <span className="tabular">#{i.number}</span>
              {i.state === 'closed' && (
                <>
                  <Sep />
                  <span className="font-medium text-ink-2">Closed</span>
                </>
              )}
              {i.labels.length > 0 && (
                <>
                  <Sep />
                  <span className="truncate">{i.labels.join(', ')}</span>
                </>
              )}
              {i.author && (
                <>
                  <Sep />
                  <span>{i.author}</span>
                </>
              )}
              {i.updatedAt && (
                <>
                  <Sep />
                  <span>{ago(i.updatedAt)}</span>
                </>
              )}
            </>
          }
        />
      ))
    if (tab === 'pull')
      return list.pulls.map((p: GhPull) => {
        const failing = p.checks.filter((c) => c.state === 'fail').length
        return (
          <Row
            key={p.number}
            icon={p.state === 'merged' ? <GitMerge className="size-4 text-ink-3" strokeWidth={2} /> : <GitPullRequest className={cn('size-4', p.draft || p.state === 'closed' ? 'text-ink-3' : 'text-ok')} strokeWidth={2} />}
            title={p.title}
            focus={isFocus('pull', p.number)}
            busy={starting === `pull:${p.number}`}
            disabled={busy}
            onStart={() => void start('pull', p.number)}
            meta={
              <>
                <span className="tabular">#{p.number}</span>
                {stateWords({ kind: 'pull', pull: p }) && (
                  <>
                    <Sep />
                    <span className={cn(p.state !== 'open' && 'font-medium text-ink-2')}>{stateWords({ kind: 'pull', pull: p })}</span>
                  </>
                )}
                {p.changedFiles > 0 && (
                  <>
                    <Sep />
                    <span className="tabular">
                      {p.changedFiles} {p.changedFiles === 1 ? 'file' : 'files'}, <span className="text-ok">+{p.additions}</span> <span className="text-bad">-{p.deletions}</span>
                    </span>
                  </>
                )}
                {p.review && (
                  <>
                    <Sep />
                    <span>{p.review}</span>
                  </>
                )}
                {p.checks.length > 0 && (
                  <>
                    <Sep />
                    <span className={cn(failing && 'text-bad')}>{failing ? `${failing} ${failing === 1 ? 'check fails' : 'checks fail'}` : 'Checks pass'}</span>
                  </>
                )}
                {p.author && (
                  <>
                    <Sep />
                    <span>{p.author}</span>
                  </>
                )}
              </>
            }
          />
        )
      })
    return list.runs.map((r: GhRun) => (
      <Row
        key={r.id}
        icon={r.conclusion === 'success' ? <CircleCheck className="size-4 text-ok" strokeWidth={2} /> : <CircleX className="size-4 text-bad" strokeWidth={2} />}
        title={r.title || r.workflow}
        focus={isFocus('run', r.id)}
        busy={starting === `run:${r.id}`}
        disabled={busy}
        onStart={() => void start('run', r.id)}
        meta={
          <>
            {stateWords({ kind: 'run', run: r }) && (
              <>
                <span className="font-medium text-ink-2">{stateWords({ kind: 'run', run: r })}</span>
                <Sep />
              </>
            )}
            <span>{r.workflow}</span>
            <Sep />
            <span className="flex items-center gap-1">
              <GitBranch className="size-3" />
              {r.branch}
            </span>
            {r.event && (
              <>
                <Sep />
                <span>{r.event.replace(/_/g, ' ')}</span>
              </>
            )}
            {r.createdAt && (
              <>
                <Sep />
                <span>{ago(r.createdAt)}</span>
              </>
            )}
          </>
        }
      />
    ))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, tab, starting, focus])

  const nothing: Record<Tab, string> = { issue: 'No open issues.', pull: 'No open pull requests.', run: 'No failed runs. Every recent workflow run passed.' }
  const problem = list?.problem

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title="From GitHub"
      description="Pick an issue, a pull request or a failed run. The team works on it here and checks the result. Nothing is posted to GitHub."
    >
      <div className="px-6 pt-3">
        <form onSubmit={submit} className="flex items-center gap-2">
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Paste a GitHub address, or leave empty for this folder's repository" title={`This folder: ${folder}`} className={inputClass} spellCheck={false} aria-label="GitHub address" />
          <Button type="submit" variant="secondary" disabled={loading} className="h-9 shrink-0">
            {asked !== address.trim() && address.trim() ? 'Look up' : 'Refresh'}
          </Button>
        </form>
        <div className="mt-3 flex min-h-7 flex-wrap items-center justify-between gap-2">
          {list?.repo ? (
            <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
              <span className="truncate font-medium text-ink">{refLabel(list.repo)}</span>
              {list.via && (
                <>
                  <Sep />
                  <span>{list.via === 'gh' ? 'read with the GitHub CLI' : list.via === 'rest' ? 'read from the public GitHub API' : 'sample data in the demo'}</span>
                </>
              )}
            </div>
          ) : (
            <span />
          )}
          {list && !problem && (
            <Segmented<Tab>
              value={tab}
              onChange={(t) => {
                setWarn(null)
                setTab(t)
              }}
              options={[
                { value: 'issue', label: 'Issues', badge: counts.issue },
                { value: 'pull', label: 'Pull requests', badge: counts.pull },
                { value: 'run', label: 'Failed runs', badge: counts.run },
              ]}
            />
          )}
        </div>
      </div>
      <div className="mt-2 min-h-[220px] overflow-y-auto border-t border-line px-3 py-2 [scrollbar-width:thin]" style={{ maxHeight: 360 }}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-ink-3">
            <Spinner /> Reading GitHub…
          </div>
        ) : problem ? (
          <Empty icon={<CircleAlert className="size-4.5" />}>
            <div>{problem.text}</div>
            {problem.kind !== 'no-repo' && (
              <Button size="sm" variant="soft" className="mt-4" onClick={() => void load(asked)}>
                <RotateCw className="size-3.5" /> Try again
              </Button>
            )}
          </Empty>
        ) : rows && rows.length ? (
          rows
        ) : list ? (
          <Empty>{nothing[tab]}</Empty>
        ) : null}
      </div>
      {warn && (
        <div className="flex items-center gap-3 border-t border-line bg-warn-soft px-6 py-3" role="alert">
          <CircleAlert className="size-4 shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink">{warn.text}</span>
          <Button size="sm" variant="ghost" onClick={() => setWarn(null)}>
            Pick another
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void start(warn.kind, warn.number, true)}>
            {busy ? <Spinner className="text-current" /> : 'Start anyway'}
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-line px-6 py-3 text-[11.5px] leading-snug text-ink-3">
        <span className="min-w-0 flex-1">Starts in Verified, as a goal a fresh pair of eyes checks. The team prepares the work and stops before pushing, opening a pull request or commenting.</span>
      </div>
    </Modal>
  )
}

/** The starter on the new-chat screen, and the dialog it opens. */
export function GithubStarter() {
  const [open, setOpen] = useState(false)
  const [initial, setInitial] = useState('')
  useEffect(() => {
    const on = (e: Event): void => {
      pending = null
      setInitial(String((e as CustomEvent<{ address?: string }>).detail?.address || ''))
      setOpen(true)
    }
    window.addEventListener(OPEN_GITHUB, on)
    // Opened by "/github" from inside a chat: this screen came up just now, after the event.
    if (pending !== null) {
      setInitial(pending)
      pending = null
      setOpen(true)
    }
    return () => window.removeEventListener(OPEN_GITHUB, on)
  }, [])
  return (
    <>
      <Tip label="Turn an open issue, a pull request or a failed CI run into checked work">
        <button
          onClick={() => {
            setInitial('')
            setOpen(true)
          }}
          className="flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] transition-colors hover:bg-hover hover:text-ink"
        >
          <GitPullRequest className="size-3.5 text-ink-3" strokeWidth={1.9} />
          From GitHub
        </button>
      </Tip>
      <GithubDialog open={open} onClose={() => setOpen(false)} initial={initial} />
    </>
  )
}

