import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, FolderInput, History, Minus } from 'lucide-react'
import type { ImportScan, ImportSession } from '@shared/types'
import { useStore } from '@/store'
import { api, cn, errorText, folderLabel, relative } from '@/lib/util'
import { Button, Modal, Segmented, Spinner } from './ui'

/** A box that is ticked, empty, or part-way when only some of what it covers is chosen. */
function Tick({ state, onClick, label }: { state: 'on' | 'off' | 'some'; onClick(): void; label: string }) {
  return (
    <button
      role="checkbox"
      aria-checked={state === 'on' ? true : state === 'some' ? 'mixed' : false}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn('flex size-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors', state === 'off' ? 'border-ink-4 hover:border-ink-3' : 'border-ink bg-ink text-inverse')}
    >
      {state === 'on' && <Check className="size-3" strokeWidth={3} />}
      {state === 'some' && <Minus className="size-3" strokeWidth={3} />}
    </button>
  )
}

function SessionRow({ s, on, toggle, home }: { s: ImportSession; on: boolean; toggle(): void; home: string }) {
  return (
    <div onClick={() => !s.imported && toggle()} className={cn('flex items-center gap-2.5 rounded-[9px] py-1.5 pr-2.5 pl-9 text-[12.5px]', s.imported ? 'opacity-45' : 'hover:bg-hover')}>
      {s.imported ? <Check className="size-[17px] shrink-0 p-[2px] text-ok" strokeWidth={2.75} /> : <Tick state={on ? 'on' : 'off'} onClick={toggle} label={`Bring in ${s.title}`} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{s.title}</span>
        <span className="block truncate text-[11px] text-ink-3">
          {folderLabel(s.cwd, home)}
          {s.imported ? ' · already here' : s.resumable ? '' : ' · comes in as a summary'}
        </span>
      </span>
      <span className="tabular shrink-0 text-[11px] text-ink-4">{s.updatedAt ? relative(s.updatedAt) : ''}</span>
    </div>
  )
}

type Mode = 'continue' | 'summary'

/** Brings the Claude desktop app's Code conversations in, each under a folder named after its section there. */
export function ImportDialog() {
  const open = useStore((s) => s.modal?.kind === 'import')
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const home = useStore((s) => s.env.home)
  const [scan, setScan] = useState<ImportScan | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('continue')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setScan(null)
    setError('')
    setBusy(false)
    let live = true
    void api.importScan().then(
      (r) => {
        if (!live) return
        setScan(r)
        // Everything that is filed under a section and not here yet starts ticked: sections are what people ask for.
        setPicked(new Set(r.sections.flatMap((sec) => sec.sessions.filter((s) => !s.imported).map((s) => s.id))))
        setShown(new Set())
      },
      (e) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [open])

  const groups = useMemo(() => {
    if (!scan) return []
    return [...scan.sections.filter((sec) => sec.sessions.length), ...(scan.loose.length ? [{ id: '__loose', name: 'Not in a section', sessions: scan.loose }] : [])]
  }, [scan])

  const toggle = (ids: string[], on: boolean): void =>
    setPicked((p) => {
      const next = new Set(p)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.importRun([...picked], mode)
      toast(r.chats ? `Brought in ${r.chats} ${r.chats === 1 ? 'chat' : 'chats'}${r.folders ? ` and made ${r.folders} ${r.folders === 1 ? 'folder' : 'folders'}` : ''}.` : 'Everything chosen was already here.')
      setModal(null)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  const count = picked.size

  return (
    <Modal
      open={open}
      onClose={() => setModal(null)}
      title="Bring chats in from Claude Code"
      description="Your Code conversations from the Claude desktop app, with the sections you filed them under. Each section becomes a folder here. Nothing in Claude Code is changed."
      width={600}
    >
      <div className="min-h-[220px] overflow-y-auto px-4 pt-3 pb-2">
        {error ? (
          <div className="selectable mx-2 rounded-[12px] bg-bad-soft px-3.5 py-3 text-[13px]">{error}</div>
        ) : !scan ? (
          <div className="flex h-[200px] items-center justify-center gap-2.5 text-[13px] text-ink-3">
            <Spinner /> Looking for your Claude Code conversations…
          </div>
        ) : !scan.found || !groups.length ? (
          <div className="flex h-[200px] flex-col items-center justify-center gap-2 px-10 text-center">
            <FolderInput className="size-6 text-ink-4" strokeWidth={1.5} />
            <div className="text-[13.5px] font-medium">{scan.found ? 'No conversations to bring in' : 'The Claude desktop app was not found here'}</div>
            <p className="text-[12.5px] leading-relaxed text-ink-3">{scan.found ? 'There are no Code conversations in the Claude desktop app on this computer yet.' : 'This looks for the Code tab of the Claude desktop app on this computer. Open it once and try again.'}</p>
          </div>
        ) : (
          groups.map((g) => {
            const free = g.sessions.filter((s) => !s.imported)
            const chosen = free.filter((s) => picked.has(s.id)).length
            const state = !free.length || !chosen ? 'off' : chosen === free.length ? 'on' : 'some'
            const isOpen = shown.has(g.id)
            return (
              <div key={g.id} className="mb-0.5">
                <div
                  onClick={() => setShown((s) => {
                    const n = new Set(s)
                    if (n.has(g.id)) n.delete(g.id)
                    else n.add(g.id)
                    return n
                  })}
                  className="flex h-9 items-center gap-2.5 rounded-[9px] px-2.5 hover:bg-hover"
                >
                  <ChevronRight className={cn('size-3.5 shrink-0 text-ink-4 transition-transform duration-200', isOpen && 'rotate-90')} />
                  {free.length ? <Tick state={state} onClick={() => toggle(free.map((s) => s.id), state !== 'on')} label={`Bring in everything under ${g.name}`} /> : <Check className="size-[17px] shrink-0 p-[2px] text-ok" strokeWidth={2.75} />}
                  <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', g.id === '__loose' && 'font-normal text-ink-2')}>{g.name}</span>
                  <span className="tabular shrink-0 text-[11.5px] text-ink-3">{free.length ? `${chosen} of ${free.length}` : 'all here'}</span>
                </div>
                {isOpen && g.sessions.map((s) => <SessionRow key={s.id} s={s} on={picked.has(s.id)} toggle={() => toggle([s.id], !picked.has(s.id))} home={home} />)}
              </div>
            )
          })
        )}
      </div>
      {scan?.found && groups.length > 0 && !error && (
        <div className="border-t border-line px-6 pt-3.5 pb-5">
          <div className="flex items-start gap-3">
            <History className="mt-0.5 size-4 shrink-0 text-ink-3" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-[13px] font-medium">What the lead knows</span>
                <Segmented<Mode>
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'continue', label: 'Everything' },
                    { value: 'summary', label: 'A summary' },
                  ]}
                />
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
                {mode === 'continue'
                  ? 'The lead carries on in a copy of each conversation and remembers all of it. The first message in a long one uses more allowance.'
                  : 'The lead starts fresh and is told what was said in each conversation. Cheaper, but details are lost.'}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!count || busy} onClick={() => void run()}>
              {busy && <Spinner className="text-inverse" />}
              {count ? `Bring in ${count} ${count === 1 ? 'chat' : 'chats'}` : 'Nothing chosen'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
