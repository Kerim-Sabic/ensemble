// Making or changing a watch, in plain questions on one screen. Ready-made ones that fit the open
// chat's folder come first; the command trigger, which runs with the user's own rights, waits
// under "Advanced" with a warning.
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, Eye, FolderOpen } from 'lucide-react'
import type { WatchInput } from '@shared/watches'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Button, Modal, Segmented, Toggle, inputClass } from '../ui'
import { nameFrom, problemOf, readyMade, triggerOf, whenOf, type When } from './words'
import { closeWatchEditor, useWatches, watchApi } from './state'

type Source = 'every' | 'daily' | 'github' | 'url' | 'path' | 'command'
const label = 'mb-1.5 block text-[12.5px] font-semibold text-ink'
// inputClass is full width; the selects here sit in a sentence, so they take their own width.
const field = inputClass.replace('w-full', '')
const select = cn(field, 'h-8 py-0 pr-7')

function blank(cwd?: string | null): WatchInput {
  return { name: '', prompt: '', trigger: { kind: 'schedule', at: '08:00', days: [1, 2, 3, 4, 5] }, onFind: 'tell', account: 'auto', cwd: cwd || undefined }
}

/** The folder's GitHub repository, when it has one (for the ready-made watches). */
export function useRepo(cwd: string | null | undefined, on: boolean): string | null {
  const [repo, setRepo] = useState<string | null>(null)
  useEffect(() => {
    if (!on || !cwd) return
    let live = true
    api.githubList({ cwd }).then(
      (l) => live && setRepo(l.repo ? `${l.repo.owner}/${l.repo.repo}` : null),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [cwd, on])
  return repo
}

export function WatchEditor() {
  const editing = useWatches((s) => s.editing)
  const available = useWatches((s) => s.available)
  const accounts = useStore((s) => s.accounts)
  const cwd = useStore((s) => s.chats.find((c) => c.id === s.chatId)?.cwd || s.draftCwd || s.settings.defaultCwd)
  const open = editing.open
  const existing = editing.open ? editing.watch : undefined
  const repo = useRepo(cwd, open && !existing)
  const start = useMemo<WatchInput>(() => (existing ? { ...existing } : { ...blank(cwd), ...(editing.open ? editing.draft : {}) }), [open, existing]) // eslint-disable-line react-hooks/exhaustive-deps
  const [w, setW] = useState<WatchInput>(start)
  const [when, setWhen] = useState<When>(whenOf(start.trigger))
  const [hoursOn, setHoursOn] = useState(!!start.hours)
  const [advanced, setAdvanced] = useState(start.trigger.kind === 'command')
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setW(start)
    setWhen(whenOf(start.trigger))
    setHoursOn(!!start.hours)
    setAdvanced(start.trigger.kind === 'command')
    setTried(false)
  }, [start])

  const hours = (w.hours || [8, 20]) as [number, number]
  const problem = problemOf({ prompt: w.prompt, when, hours: hoursOn ? hours : null })
  const source: Source = when.kind
  const byClock = source === 'every' || source === 'daily'
  const setSource = (s: Source): void => {
    if (s === when.kind) return
    if (s === 'every') setWhen({ kind: 'every', minutes: 60 })
    else if (s === 'daily') setWhen({ kind: 'daily', at: '08:00', days: 'weekdays' })
    else if (s === 'github') setWhen({ kind: 'github', repo: repo || '', on: 'ci-failed' })
    else if (s === 'url') setWhen({ kind: 'url', url: '' })
    else if (s === 'path') setWhen({ kind: 'path', path: cwd || '' })
    else setWhen({ kind: 'command', command: '' })
  }

  const save = async (): Promise<void> => {
    setTried(true)
    if (problem) return
    setSaving(true)
    try {
      await watchApi.save({ ...w, name: w.name.trim() || nameFrom(w.prompt), prompt: w.prompt.trim(), trigger: triggerOf(when), hours: hoursOn ? hours : undefined, status: existing?.status || 'active' })
      closeWatchEditor()
    } finally {
      setSaving(false)
    }
  }

  const ready = !existing && !w.prompt ? readyMade({ repo, cwd }) : []
  const hourOptions = Array.from({ length: 25 }, (_, i) => i)

  return (
    <Modal open={open} onClose={closeWatchEditor} title={existing ? 'Change the watch' : 'New watch'} description="It looks by itself and stays silent until it finds something worth telling you." width={560}>
      <div className="min-h-0 overflow-y-auto px-6 pt-3 pb-2">
        {ready.length > 0 && (
          <div className="mb-5">
            <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">Ready to use{repo ? ` for ${repo}` : ''}</div>
            <div className="grid gap-1.5">
              {ready.map((r) => (
                <button
                  key={r.name}
                  onClick={() => {
                    setW({ ...w, ...r })
                    setWhen(whenOf(r.trigger))
                  }}
                  className="flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:bg-hover"
                >
                  <Eye className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{r.name}</span>
                  <span className="hidden shrink-0 text-[11.5px] text-ink-3 sm:inline">{r.why}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-ink-4" />
                </button>
              ))}
            </div>
          </div>
        )}

        <label className={label} htmlFor="watch-prompt">
          What should I keep an eye on?
        </label>
        <textarea
          id="watch-prompt"
          autoFocus
          rows={3}
          value={w.prompt}
          onChange={(e) => setW({ ...w, prompt: e.target.value })}
          placeholder="For example: when a CI run fails, tell me which test broke and why"
          className={cn(inputClass, 'h-auto resize-none py-2 leading-snug', tried && !w.prompt.trim() && 'shadow-[inset_0_0_0_1px_var(--bad)]')}
        />
        <input value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} placeholder={w.prompt ? `Name: ${nameFrom(w.prompt)}` : 'Name (optional)'} aria-label="Name" className={cn(inputClass, 'mt-2 h-8')} />

        <div className="mt-5">
          <span className={label}>When?</span>
          <Segmented<'clock' | 'change'>
            value={byClock ? 'clock' : 'change'}
            onChange={(v) => setSource(v === 'clock' ? 'daily' : repo ? 'github' : 'url')}
            options={[
              { value: 'clock', label: 'By the clock' },
              { value: 'change', label: 'When something changes' },
            ]}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            {byClock ? (
              <>
                <select aria-label="How often" value={source === 'every' ? 'every' : when.kind === 'daily' && when.days === 'weekdays' ? 'weekdays' : 'daily'} onChange={(e) => (e.target.value === 'every' ? setSource('every') : setWhen({ kind: 'daily', at: when.kind === 'daily' ? when.at : '08:00', days: e.target.value === 'weekdays' ? 'weekdays' : 'all' }))} className={select}>
                  <option value="every">Every few minutes or hours</option>
                  <option value="daily">Every day</option>
                  <option value="weekdays">On weekdays</option>
                </select>
                {when.kind === 'every' ? (
                  <>
                    every
                    <select aria-label="Every" value={when.minutes} onChange={(e) => setWhen({ kind: 'every', minutes: Number(e.target.value) })} className={select}>
                      {[5, 10, 15, 30, 60, 120, 240, 360, 720].map((m) => (
                        <option key={m} value={m}>
                          {m < 60 ? `${m} minutes` : m === 60 ? 'hour' : `${m / 60} hours`}
                        </option>
                      ))}
                    </select>
                  </>
                ) : when.kind === 'daily' ? (
                  <>
                    at
                    <input type="time" aria-label="At" value={when.at} onChange={(e) => setWhen({ ...when, at: e.target.value })} className={cn(field, 'tabular h-8 w-[104px]')} />
                  </>
                ) : null}
              </>
            ) : (
              <>
                <select aria-label="What changes" value={source} onChange={(e) => setSource(e.target.value as Source)} className={select}>
                  <option value="github">A GitHub repository</option>
                  <option value="url">A web page</option>
                  <option value="path">A folder on this computer</option>
                  {advanced && <option value="command">What a command prints</option>}
                </select>
                {when.kind === 'github' && (
                  <>
                    <input value={when.repo} onChange={(e) => setWhen({ ...when, repo: e.target.value })} placeholder="owner/name" aria-label="Repository" className={cn(field, 'h-8 w-[200px] font-mono text-[12px]')} />
                    <select aria-label="On" value={when.on} onChange={(e) => setWhen({ ...when, on: e.target.value as 'ci-failed' | 'issue' | 'pr' })} className={select}>
                      <option value="ci-failed">when checks fail</option>
                      <option value="issue">when an issue is opened</option>
                      <option value="pr">when a pull request is opened</option>
                    </select>
                  </>
                )}
                {when.kind === 'url' && <input value={when.url} onChange={(e) => setWhen({ ...when, url: e.target.value })} placeholder="https://" aria-label="Page address" className={cn(field, 'h-8 min-w-[240px] flex-1')} />}
                {when.kind === 'path' && (
                  <>
                    <input value={when.path} onChange={(e) => setWhen({ ...when, path: e.target.value })} aria-label="Folder" className={cn(field, 'h-8 min-w-[200px] flex-1 font-mono text-[12px]')} />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        const p = await api.pickFolder()
                        if (p) setWhen({ kind: 'path', path: p })
                      }}
                    >
                      <FolderOpen className="size-3.5" /> Choose
                    </Button>
                  </>
                )}
                {when.kind === 'command' && <input value={when.command} onChange={(e) => setWhen({ ...when, command: e.target.value })} placeholder="git status --short" aria-label="Command" className={cn(field, 'h-8 min-w-[240px] flex-1 font-mono text-[12px]')} />}
              </>
            )}
          </div>
          <div className="mt-3 flex min-h-8 flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <Toggle checked={hoursOn} onChange={setHoursOn} label="Only at certain hours" />
            <button type="button" onClick={() => setHoursOn((v) => !v)} className="text-left">
              {hoursOn ? 'Only between' : 'At any hour'}
            </button>
            {hoursOn && (
              <>
            <select aria-label="From" value={hours[0]} onChange={(e) => setW({ ...w, hours: [Number(e.target.value), hours[1]] })} className={cn(select, 'tabular')}>
              {hourOptions.slice(0, 24).map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
              ))}
            </select>
            and
            <select aria-label="To" value={hours[1]} onChange={(e) => setW({ ...w, hours: [hours[0], Number(e.target.value)] })} className={cn(select, 'tabular')}>
              {hourOptions.slice(1).map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
              ))}
            </select>
              </>
            )}
          </div>
        </div>

        <div className="mt-5">
          <span className={label}>If I find something</span>
          <Segmented<'tell' | 'team'>
            value={w.onFind || 'tell'}
            onChange={(onFind) => setW({ ...w, onFind })}
            options={[
              { value: 'tell', label: 'Tell me' },
              { value: 'team', label: 'Hand it to the team as Verified work' },
            ]}
          />
        </div>

        <div className="mt-5">
          <label className={label} htmlFor="watch-account">
            Which account pays?
          </label>
          <select id="watch-account" value={w.account || 'auto'} onChange={(e) => setW({ ...w, account: e.target.value })} className={select}>
            <option value="auto">Automatic: ChatGPT accounts first, never one running low</option>
            {accounts
              .filter((a) => a.enabled)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
          <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-ink-3">A look that finds nothing changed costs nothing: a model is asked only when there is something new.</p>
        </div>

        <div className="mt-5 border-t border-line pt-3">
          <button onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced} className="flex h-7 items-center gap-1.5 rounded-[8px] px-1 text-[12px] text-ink-3 hover:text-ink">
            <ChevronRight className={cn('size-3.5 transition-transform', advanced && 'rotate-90')} /> Advanced
          </button>
          {advanced && (
            <div className="mt-2 flex gap-2.5 rounded-[10px] bg-warn-soft px-3 py-2.5 text-[12px] leading-snug text-ink-2">
              <AlertTriangle className="mt-[1px] size-3.5 shrink-0 text-warn" />
              <span>
                <span className="font-medium text-ink">A watch can run a command and notice when what it prints changes.</span> The command runs with your own rights on this computer, every time the watch looks. Only use commands you would run yourself.
                {when.kind !== 'command' && (
                  <button onClick={() => setSource('command')} className="ml-1 font-medium text-ink underline decoration-line-2 underline-offset-2 hover:decoration-ink">
                    Use a command
                  </button>
                )}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-6 py-3.5">
        <span className={cn('min-w-0 flex-1 text-[12px] leading-snug', tried && problem ? 'text-bad' : 'text-ink-3')}>{tried && problem ? problem : !available ? 'Watches are not running in this build yet, so this cannot be saved.' : ''}</span>
        <Button variant="ghost" onClick={closeWatchEditor}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving || !available} onClick={() => void save()}>
          {existing ? 'Save' : 'Start watching'}
        </Button>
      </div>
    </Modal>
  )
}
