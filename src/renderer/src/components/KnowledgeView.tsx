import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CornerLeftUp, ExternalLink, FileText, LibraryBig, Search } from 'lucide-react'
import type { VaultHit, VaultNote } from '@shared/types'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Button, Segmented, Spinner } from './ui'
import { Markdown } from './Markdown'
import { MemoryView } from './MemoryView'

/** Obsidian's own markup, turned into what the reader here understands. */
function readable(raw: string): { body: string; props: [string, string][] } {
  let body = raw.replace(/\r\n/g, '\n')
  const props: [string, string][] = []
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (fm) {
    body = body.slice(fm[0].length)
    for (const line of fm[1].split('\n')) {
      const m = /^(type|status|updated|created|area|next_action):\s*(.+)$/.exec(line)
      if (m) props.push([m[1], m[2].replace(/^["']|["']$/g, '')])
    }
  }
  // The note's name is already the page title; a first heading that repeats it is dropped.
  body = body.replace(/^\s*#\s+[^\n]*\n/, '')
  body = body
    // Pictures and notes embedded whole are named rather than shown.
    .replace(/!\[\[([^\]]+)\]\]/g, (_m, t: string) => `*${t.split('|')[0].split('/').pop()}*`)
    .replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\\?\|([^\]]*))?\]\]/g, (_m, target: string, _h: string | undefined, alias: string | undefined) => {
      const text = (alias || target.split('/').pop() || target).trim()
      return `[${text.replace(/[[\]]/g, '')}](vault:${encodeURIComponent(target.trim())})`
    })
    // A callout keeps its title and loses its marker.
    .replace(/^(>\s*)\[!(\w+)\][+-]?[ \t]*(.*)$/gm, (_m, lead: string, kind: string, title: string) => `${lead}**${title.trim() || kind[0].toUpperCase() + kind.slice(1)}**`)
  return { body, props }
}

const PROP_LABEL: Record<string, string> = { type: 'Type', status: 'Status', updated: 'Updated', created: 'Created', area: 'Area', next_action: 'Next' }

function Reader({ path, onOpen }: { path: string; onOpen(path: string): void }) {
  const [note, setNote] = useState<VaultNote | null | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setNote(undefined)
    void api.vaultRead(path).then(
      (n) => {
        if (!live) return
        setNote(n)
        scroller.current?.scrollTo({ top: 0 })
      },
      () => live && setNote(null),
    )
    return () => {
      live = false
    }
  }, [path])

  const shown = useMemo(() => (note ? readable(note.content) : null), [note])

  if (note === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-3">
        <Spinner /> Opening the note…
      </div>
    )
  }
  if (!note || !shown) return <div className="flex h-full items-center justify-center text-[13px] text-ink-3">That note could not be opened. It may have been moved or renamed.</div>

  const folder = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : ''
  return (
    <div ref={scroller} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-9 pt-7 pb-14">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {folder && <div className="truncate text-[12px] text-ink-3">{folder.replace(/\//g, ' › ')}</div>}
            <h1 className="selectable mt-0.5 text-[24px] leading-tight font-semibold tracking-[-0.022em]">{note.title}</h1>
          </div>
          <Button size="sm" onClick={() => void api.vaultOpen(note.path)}>
            <ExternalLink className="size-3.5" /> Open in Obsidian
          </Button>
        </div>
        {shown.props.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {shown.props.map(([k, v]) => (
              <span key={k} className="flex h-6 max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-[11.5px] shadow-[inset_0_0_0_1px_var(--line)]">
                <span className="text-ink-3">{PROP_LABEL[k] || k}</span>
                <span className="truncate text-ink-2">{v}</span>
              </span>
            ))}
          </div>
        )}
        <div className="mt-6">
          <Markdown text={shown.body} onNote={onOpen} />
        </div>
        {note.backlinks.length > 0 && (
          <div className="mt-10 border-t border-line pt-5">
            <div className="mb-2.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-3">
              <CornerLeftUp className="size-3.5" /> Linked from {note.backlinks.length} {note.backlinks.length === 1 ? 'note' : 'notes'}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {note.backlinks.map((b) => (
                <button key={b} onClick={() => onOpen(b)} className="h-7 max-w-full truncate rounded-full bg-surface-2 px-3 text-[12px] text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:bg-surface-3 hover:text-ink">
                  {b.replace(/\.md$/i, '').split('/').pop()}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function VaultBrowser() {
  const vault = useStore((s) => s.vault)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<VaultHit[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const n = ++seq.current
    const t = setTimeout(
      () =>
        void api.vaultSearch(query.trim()).then(
          (r) => n === seq.current && setHits(r),
          () => n === seq.current && setHits([]),
        ),
      query ? 150 : 0,
    )
    return () => clearTimeout(t)
  }, [query, vault?.path])

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[330px] shrink-0 flex-col border-r border-line">
        <div className="shrink-0 p-3 pb-2">
          <div className="flex h-9 items-center gap-2 rounded-[10px] bg-surface px-3 shadow-card focus-within:shadow-[0_0_0_1px_var(--line-2),0_0_0_3px_color-mix(in_oklab,var(--link)_16%,transparent)]">
            <Search className="size-[15px] shrink-0 text-ink-3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${vault?.name || 'the vault'}`}
              className="selectable min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
            />
          </div>
          <div className="px-1 pt-2.5 text-[11px] font-medium text-ink-3">{query.trim() ? (hits ? `${hits.length} ${hits.length === 1 ? 'note' : 'notes'}` : 'Searching…') : 'Changed most recently'}</div>
        </div>
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
          {(hits || []).map((h) => (
            <button key={h.path} onClick={() => setOpen(h.path)} className={cn('block w-full rounded-[10px] px-2.5 py-2 text-left transition-colors', open === h.path ? 'bg-active' : 'hover:bg-hover')}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{h.title}</span>
                {h.type && <span className="shrink-0 text-[10.5px] text-ink-4">{h.type}</span>}
              </div>
              {h.folder && <div className="truncate text-[11px] text-ink-3">{h.folder.replace(/\//g, ' › ')}</div>}
              {query.trim() && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-ink-3">{h.snippet}</div>}
            </button>
          ))}
          {hits && !hits.length && <p className="px-2.5 pt-3 text-[12.5px] leading-relaxed text-ink-3">{query.trim() ? 'No note mentions that. Try other words, or fewer.' : 'This vault has no notes yet.'}</p>}
        </div>
      </div>
      <div className="min-w-0 flex-1 bg-surface">
        {open ? (
          <Reader path={open} onOpen={setOpen} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-10 text-center">
            <FileText className="size-7 text-ink-4" strokeWidth={1.4} />
            <div className="mt-3 text-[14px] font-medium">{vault?.name}</div>
            <p className="mt-1 max-w-[380px] text-[12.5px] leading-relaxed text-ink-3">
              About {vault?.notes.toLocaleString()} notes. The team searches here before it researches or builds, and writes what it learns back{vault?.guide ? `, following the rules in ${vault.guide}` : ''}. Pick a note to read it.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function NoVault() {
  const setModal = useStore((s) => s.setModal)
  return (
    <div className="flex h-full flex-col items-center justify-center px-10 text-center">
      <LibraryBig className="size-7 text-ink-4" strokeWidth={1.4} />
      <div className="mt-3 text-[15px] font-semibold">Give the team a library</div>
      <p className="mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-ink-2">
        Point Ensemble at a folder of notes, such as an Obsidian vault. The team looks there before it researches or builds, and records what it learns so the next piece of work starts from it.
      </p>
      <Button variant="primary" className="mt-5" onClick={() => setModal({ kind: 'settings' })}>
        Choose a vault <ArrowUpRight className="size-3.5" />
      </Button>
    </div>
  )
}

/** What the team knows: its own short notebook, and the vault it shares with you. */
export function KnowledgeView() {
  const vault = useStore((s) => s.vault)
  const [tab, setTab] = useState<'vault' | 'notebook'>(vault ? 'vault' : 'notebook')
  return (
    <div className="flex h-full flex-col bg-surface-2">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <Segmented<'vault' | 'notebook'>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'vault', label: vault?.name || 'Vault' },
            { value: 'notebook', label: 'What I learned' },
          ]}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          {tab === 'vault' ? vault?.path || '' : 'What the team keeps between chats, each with where it came from.'}
        </span>
      </div>
      <div className="min-h-0 flex-1">{tab === 'notebook' ? <MemoryView /> : vault ? <VaultBrowser /> : <NoVault />}</div>
    </div>
  )
}
