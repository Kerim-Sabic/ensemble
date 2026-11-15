import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, CircleAlert, ExternalLink, FolderOpen, Import, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { CATALOG, fillSpec, secretKeys, toSlug, type CatalogEntry, type ConnectorSpec, type ConnectorView, type FoundConnector } from '@shared/connectors'
import { useStore } from '@/store'
import { api, cn, errorText, relative } from '@/lib/util'
import { Button, Modal, Segmented, Spinner, Toggle, inputClass } from './ui'

type Step = { kind: 'list' } | { kind: 'catalog'; entry: CatalogEntry } | { kind: 'custom'; edit?: ConnectorView }

const SOURCE: Record<string, string> = { catalog: 'Added here', custom: 'Added by hand', 'claude-code': 'From Claude Code', codex: 'From Codex', desktop: 'From the Claude desktop app' }

/** Lines of KEY=VALUE, as people paste them from a README. */
const toPairs = (text: string): Record<string, string> | undefined => {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line)
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return Object.keys(out).length ? out : undefined
}
const fromPairs = (m?: Record<string, string>): string => Object.entries(m || {}).map(([k, v]) => `${k}=${v}`).join('\n')

function TestBadge({ c }: { c: ConnectorView }) {
  if (!c.test) return <span className="text-[11.5px] text-ink-4">Not tried yet</span>
  return c.test.ok ? (
    <span className="flex items-center gap-1 text-[11.5px] text-ok" title={c.test.tools.join(', ')}>
      <Check className="size-3" strokeWidth={2.75} /> Works · {c.test.tools.length} {c.test.tools.length === 1 ? 'tool' : 'tools'}
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-bad" title={c.test.error}>
      <CircleAlert className="size-3 shrink-0" /> <span className="truncate">{c.test.error || 'Did not connect'}</span>
    </span>
  )
}

function ConnectorRow({ c, onChange, onEdit }: { c: ConnectorView; onChange(): void; onEdit(): void }) {
  const run = useStore((s) => s.run)
  const accounts = useStore((s) => s.accounts)
  const [testing, setTesting] = useState(false)
  const test = async (): Promise<void> => {
    setTesting(true)
    await run(api.connectorTest(c.id))
    setTesting(false)
    onChange()
  }
  const who = c.accounts === 'all' ? 'Every account' : accounts.filter((a) => (c.accounts as string[]).includes(a.id)).map((a) => a.name).join(', ') || 'No account'
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-[10px] shadow-[inset_0_0_0_1px_var(--line)]', c.enabled ? 'bg-surface-2 text-ink-2' : 'bg-hover text-ink-4')}>
        <Plug className="size-4" strokeWidth={1.8} />
      </span>
      <button onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline gap-2">
          <span className={cn('truncate text-[13px] font-medium', !c.enabled && 'text-ink-3')}>{c.name}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-ink-4">{c.slug}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <TestBadge c={c} />
          <span className="truncate text-[11.5px] text-ink-4">
            · {who} · {SOURCE[c.source]}
            {c.test ? ` · tried ${relative(c.test.at)}` : ''}
          </span>
        </span>
      </button>
      <Button size="sm" variant="ghost" disabled={testing} onClick={() => void test()}>
        {testing ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />} {testing ? 'Trying' : 'Try it'}
      </Button>
      <Toggle checked={c.enabled} onChange={(enabled) => void run(api.connectorSave({ ...c, enabled, spec: c.spec })).then(onChange)} label={`Use ${c.name}`} />
    </div>
  )
}

/** The form for one connector from the catalog: only the fields it needs. */
function CatalogForm({ entry, onDone }: { entry: CatalogEntry; onDone(): void }) {
  const run = useStore((s) => s.run)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const ready = entry.fields.every((f) => f.optional || values[f.key]?.trim())
  const save = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    const c = await run(api.connectorSave({ name: entry.name, slug: entry.slug, blurb: entry.blurb, spec: fillSpec(entry.spec, values), secrets: secretKeys(entry), source: 'catalog', catalogId: entry.id }))
    if (!c) return setBusy(false)
    const t = await run(api.connectorTest(c.id))
    setBusy(false)
    if (t?.ok) onDone()
    else setResult(t?.error || 'It did not connect.')
  }
  return (
    <div className="space-y-4 px-6 pt-2 pb-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]">
          <Plug className="size-5 text-ink-2" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{entry.name}</div>
          <div className="text-[12.5px] text-ink-3">{entry.blurb}</div>
          {entry.needs && <div className="mt-1 text-[11.5px] text-ink-4">Runs on this computer and needs {entry.needs === 'node' ? 'Node.js' : 'uv (astral.sh/uv)'} installed.</div>}
        </div>
        {entry.docs && (
          <Button size="sm" variant="ghost" onClick={() => void api.openExternal(entry.docs as string)}>
            <ExternalLink className="size-3" /> About it
          </Button>
        )}
      </div>
      {entry.fields.map((f) => (
        <div key={f.key}>
          <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
            <span className="font-medium text-ink-2">
              {f.label}
              {f.optional && <span className="font-normal text-ink-4"> · optional</span>}
            </span>
            {f.link && (
              <button onClick={() => void api.openExternal(f.link as string)} className="flex items-center gap-1 text-link hover:underline">
                Get one <ExternalLink className="size-3" />
              </button>
            )}
          </div>
          {f.folder ? (
            <div className="flex gap-2">
              <input readOnly value={values[f.key] || ''} placeholder="No folder chosen" className={inputClass} />
              <Button
                onClick={async () => {
                  const p = await api.pickFolder()
                  if (p) setValues((v) => ({ ...v, [f.key]: p }))
                }}
              >
                <FolderOpen className="size-3.5" /> Choose…
              </Button>
            </div>
          ) : (
            <input
              type={f.secret ? 'password' : 'text'}
              value={values[f.key] || ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              spellCheck={false}
              autoComplete="off"
              className={inputClass}
            />
          )}
          {f.help && <div className="mt-1 text-[11.5px] text-ink-4">{f.help}</div>}
        </div>
      ))}
      {entry.fields.some((f) => f.secret) && <div className="text-[11.5px] leading-snug text-ink-4">Keys are encrypted with your Windows account and stay on this computer. Agents use them through the connector; they are never put in a chat.</div>}
      {result && <div className="selectable rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{result} It is saved, so you can fix it and try again from the list.</div>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void save()}>
          {busy && <Spinner className="text-inverse" />} {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </div>
  )
}

/** Any connector, by hand: a program to run or an address, with its settings. */
function CustomForm({ edit, onDone }: { edit?: ConnectorView; onDone(): void }) {
  const run = useStore((s) => s.run)
  const accounts = useStore((s) => s.accounts)
  const [name, setName] = useState(edit?.name || '')
  const [kind, setKind] = useState<ConnectorSpec['kind']>(edit?.spec.kind || 'stdio')
  const [command, setCommand] = useState(edit?.spec.command || '')
  const [args, setArgs] = useState((edit?.spec.args || []).join('\n'))
  const [url, setUrl] = useState(edit?.spec.url || '')
  const [env, setEnv] = useState(fromPairs(edit?.spec.env))
  const [headers, setHeaders] = useState(fromPairs(edit?.spec.headers))
  const [who, setWho] = useState<'all' | string[]>(edit?.accounts || 'all')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const ready = name.trim() && (kind === 'stdio' ? command.trim() : /^https?:\/\//.test(url.trim()))
  const save = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    // Arguments go one per line; a single line is split on spaces, the way it is usually pasted.
    const list = args.includes('\n') ? args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean) : args.trim().split(/\s+/).filter(Boolean)
    const c = await run(
      api.connectorSave({
        id: edit?.id,
        name,
        slug: edit?.slug || toSlug(name),
        blurb: edit?.blurb,
        spec: kind === 'stdio' ? { kind, command: command.trim(), args: list, env: toPairs(env) } : { kind, url: url.trim(), headers: toPairs(headers) },
        secrets: edit?.secrets,
        accounts: who,
        enabled: edit?.enabled ?? true,
        source: edit?.source || 'custom',
        catalogId: edit?.catalogId,
      }),
    )
    if (!c) return setBusy(false)
    const t = await run(api.connectorTest(c.id))
    setBusy(false)
    if (t?.ok) onDone()
    else setResult(t?.error || 'It did not connect.')
  }
  const secretNote = edit && edit.secrets.length ? `Saved secrets (${edit.secrets.join(', ')}) show empty: leave them empty to keep them, or type a new value.` : ''
  return (
    <div className="space-y-3.5 px-6 pt-2 pb-5">
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 text-[12px] font-medium text-ink-2">Name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Notion" className={inputClass} />
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-ink-2">Runs as</div>
          <Segmented<ConnectorSpec['kind']>
            value={kind}
            onChange={setKind}
            options={[
              { value: 'stdio', label: 'A program' },
              { value: 'http', label: 'An address' },
            ]}
          />
        </div>
      </div>
      {kind === 'stdio' ? (
        <>
          <div className="grid grid-cols-[160px_1fr] gap-3">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Command</div>
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} className={cn(inputClass, 'font-mono text-[12px]')} />
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Arguments</div>
              <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @some/mcp-server" spellCheck={false} className={cn(inputClass, 'font-mono text-[12px]')} />
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-2">Settings (one KEY=value per line)</div>
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} placeholder="API_KEY=…" spellCheck={false} className={cn(inputClass, 'h-auto py-2 font-mono text-[12px]')} />
          </div>
        </>
      ) : (
        <>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-2">Address</div>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" spellCheck={false} className={cn(inputClass, 'font-mono text-[12px]')} />
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-2">Headers (one Name: value per line)</div>
            <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} placeholder="Authorization: Bearer …" spellCheck={false} className={cn(inputClass, 'h-auto py-2 font-mono text-[12px]')} />
          </div>
        </>
      )}
      {secretNote && <div className="text-[11.5px] text-ink-4">{secretNote}</div>}
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-ink-2">Which accounts' agents get it</div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setWho('all')} className={cn('h-7 rounded-full px-3 text-[12px]', who === 'all' ? 'bg-ink text-inverse' : 'shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-hover')}>
            Every account
          </button>
          {accounts.map((a) => {
            const on = who !== 'all' && who.includes(a.id)
            return (
              <button
                key={a.id}
                onClick={() => setWho((w) => (w === 'all' ? [a.id] : on ? w.filter((x) => x !== a.id) : [...w, a.id]))}
                className={cn('h-7 rounded-full px-3 text-[12px]', on ? 'bg-ink text-inverse' : 'shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-hover')}
              >
                {a.name}
              </button>
            )
          })}
        </div>
      </div>
      {result && <div className="selectable rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{result} It is saved, so you can fix it and try again.</div>}
      <div className="flex items-center gap-2 pt-1">
        {edit && (
          <Button
            variant="ghost"
            className="text-bad hover:bg-bad-soft"
            onClick={() => void run(api.connectorRemove(edit.id)).then(onDone)}
          >
            <Trash2 className="size-3.5" /> Remove
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void save()}>
          {busy && <Spinner className="text-inverse" />} {busy ? 'Connecting…' : 'Save and try it'}
        </Button>
      </div>
    </div>
  )
}

/** Outside services every agent on the team can use: the ones connected, a catalog, and what other apps already have. */
export function ConnectorsDialog() {
  const open = useStore((s) => s.modal?.kind === 'connectors')
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const toast = useStore((s) => s.toast)
  const [list, setList] = useState<ConnectorView[]>([])
  const [found, setFound] = useState<FoundConnector[]>([])
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const [error, setError] = useState('')

  const load = (): void => {
    void api.connectors().then(setList, (e) => setError(errorText(e)))
    void api.connectorsFound().then(setFound, () => setFound([]))
  }
  useEffect(() => {
    if (!open) return
    setStep({ kind: 'list' })
    load()
  }, [open])

  const have = useMemo(() => new Set(list.map((c) => c.catalogId).filter(Boolean)), [list])
  const fresh = found.filter((f) => !f.added)
  const back = (): void => {
    setStep({ kind: 'list' })
    load()
  }
  const bring = async (f: FoundConnector): Promise<void> => {
    const c = await run(api.connectorSave({ name: f.name, slug: f.slug, spec: f.spec, source: f.source }))
    if (!c) return
    load()
    const t = await run(api.connectorTest(c.id))
    load()
    toast(t?.ok ? `${f.name} works: ${t.tools.length} tools for the whole team.` : `${f.name} was added but did not connect${f.mayNeedSignIn ? ': it probably needs a sign-in in its own app' : ''}.`, t?.ok ? 'info' : 'warn')
  }

  const title = step.kind === 'catalog' ? `Connect ${step.entry.name}` : step.kind === 'custom' ? (step.edit ? step.edit.name : 'Add a connector by hand') : 'Connectors'
  return (
    <Modal open={open} onClose={() => setModal(null)} title={title} description={step.kind === 'list' ? 'Services every agent on the team can use: code hosts, databases, search, voices, folders. Set one up once and every account gets it.' : undefined} width={640}>
      {step.kind !== 'list' && (
        <button onClick={back} className="mx-6 mb-1 flex w-fit items-center gap-1 text-[12px] font-medium text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> All connectors
        </button>
      )}
      <div className="overflow-y-auto">
        {step.kind === 'catalog' && <CatalogForm entry={step.entry} onDone={back} />}
        {step.kind === 'custom' && <CustomForm edit={step.edit} onDone={back} />}
        {step.kind === 'list' && (
          <div className="px-6 pt-2 pb-6">
            {error && <div className="selectable mb-3 rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>}
            {list.length > 0 && (
              <>
                <div className="mb-0.5 text-[12px] font-medium text-ink-3">Connected</div>
                <div className="divide-y divide-line">
                  {list.map((c) => (
                    <ConnectorRow key={c.id} c={c} onChange={load} onEdit={() => setStep({ kind: 'custom', edit: c })} />
                  ))}
                </div>
              </>
            )}
            {fresh.length > 0 && (
              <div className="mt-5">
                <div className="mb-1.5 text-[12px] font-medium text-ink-3">Already set up in your other apps</div>
                <div className="divide-y divide-line rounded-[12px] px-3 shadow-[inset_0_0_0_1px_var(--line)]">
                  {fresh.map((f) => (
                    <div key={f.key} className="flex items-center gap-3 py-2">
                      <Import className="size-4 shrink-0 text-ink-3" strokeWidth={1.8} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{f.name}</span>
                        <span className="block truncate text-[11.5px] text-ink-4">
                          {f.where} · {f.spec.kind === 'stdio' ? 'a program' : 'an address'}
                          {f.mayNeedSignIn ? ' · may need a sign-in Ensemble cannot do yet' : ''}
                        </span>
                      </span>
                      <Button size="sm" onClick={() => void bring(f)}>
                        <Plus className="size-3" /> Bring in
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-5 mb-1.5 flex items-baseline justify-between">
              <span className="text-[12px] font-medium text-ink-3">Add a connector</span>
              <button onClick={() => setStep({ kind: 'custom' })} className="text-[12px] font-medium text-link hover:underline">
                Add one by hand…
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CATALOG.map((e) => (
                <button
                  key={e.id}
                  disabled={have.has(e.id)}
                  onClick={() => setStep({ kind: 'catalog', entry: e })}
                  className="group/c flex min-w-0 flex-col items-start rounded-[12px] bg-surface px-3 py-2.5 text-left shadow-card transition-shadow hover:shadow-float disabled:opacity-50 disabled:hover:shadow-card"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{e.name}</span>
                    {have.has(e.id) ? <Check className="size-3.5 text-ok" strokeWidth={2.5} /> : <span className="text-[10.5px] text-ink-4">{e.fields.some((f) => !f.optional) ? (e.fields.some((f) => f.secret) ? 'key' : 'folder') : 'free'}</span>}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-ink-3">{e.blurb}</span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-4">
              Services that need a browser sign-in (Notion, Slack, Linear and the like) can be added by hand with a token for now. Agents ask before anything a connector does that sends, pays, publishes or deletes, as they do everywhere else.
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}
