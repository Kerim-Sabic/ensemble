import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Check, CornerUpLeft, ExternalLink, EyeOff, X } from 'lucide-react'
import type { MemoryCore, MemoryNote } from '@shared/types'
import { dayLabel, receiptLine, type NoteKind } from '@shared/memory'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Button, Tip } from '../ui'
import { revealItem } from '../chat/Transcript'

const KIND: Record<NoteKind, string> = { preference: 'How you like it', fact: 'Fact', decision: 'Decision', lesson: 'Lesson' }

/** "Today", "Yesterday" or "20 Nov". */
function dayGroup(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= start) return 'Today'
  if (ts >= start - 86_400_000) return 'Yesterday'
  return d.getFullYear() === now.getFullYear() ? dayLabel(ts) : `${dayLabel(ts)} ${d.getFullYear()}`
}

/** When a note was learned: the moment its source is from, else when it was saved. */
const learnedAt = (n: MemoryNote): number => (n.status === 'forgotten' ? n.forgottenAt || n.updatedAt : n.source?.at || n.createdAt)

/** The last part of a folder path, for the project filter. */
const folderName = (scope: string): string => scope.split('/').filter(Boolean).pop() || scope

/** One note: what it says, where it came from, and what can be done with it. */
export function LearnedEntry({ note, inCore }: { note: MemoryNote; inCore: boolean }) {
  const members = useStore((s) => s.members)
  const chats = useStore((s) => s.chats)
  const run = useStore((s) => s.run)
  const openChat = useStore((s) => s.openChat)
  const setView = useStore((s) => s.setView)
  const [sure, setSure] = useState(false)
  const nameOf = (id: string): string => members[id]?.name || (id === 'review' ? 'The look back' : 'an agent')

  if (note.status === 'forgotten') {
    return <div className="px-1 py-1.5 text-[12px] text-ink-4">Something was forgotten on {dayLabel(note.forgottenAt || note.updatedAt)}. Its words are gone from Ensemble.</div>
  }
  const waiting = note.status === 'waiting'
  const replaced = note.status === 'replaced'
  const chatThere = note.source?.chatId && chats.some((c) => c.id === note.source!.chatId)
  const target = note.replaces ? useStore.getState().memory.find((n) => n.id === note.replaces) : undefined

  return (
    <div className={cn('group/learned rounded-[14px] bg-surface px-4 py-3.5 shadow-card', replaced && 'opacity-60', waiting && 'ring-1 ring-warn')}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <span className="rounded-full bg-hover px-2 py-0.5 font-medium text-ink-2">{KIND[note.kind || 'fact']}</span>
        {note.scope ? <span className="rounded-full bg-hover px-2 py-0.5 text-ink-3">{folderName(note.scope)} only</span> : <span className="rounded-full bg-hover px-2 py-0.5 text-ink-3">Every project</span>}
        {waiting && <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn">Waiting for your yes</span>}
        {replaced && <span className="rounded-full bg-hover px-2 py-0.5 text-ink-3">No longer used</span>}
        {inCore && <span className="rounded-full bg-ok-soft px-2 py-0.5 font-medium text-ok">In every chat</span>}
      </div>
      <div className="mt-2 text-[13.5px] font-semibold">{note.title}</div>
      <p className="selectable mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">{note.body}</p>
      {target && waiting && <p className="mt-1.5 text-[12px] text-ink-3">{note.retires ? 'Saying yes retires' : 'Saying yes replaces'} "{target.title}".</p>}
      {note.source?.quote && (
        <blockquote className="selectable mt-2 border-l-2 border-line-2 pl-2.5 text-[12.5px] leading-relaxed text-ink-3 italic">"{note.source.quote}"</blockquote>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 flex-1 text-[12px] text-ink-3">{receiptLine(note, nameOf)}</span>
        <div className="flex items-center gap-1">
          {waiting && (
            <>
              <Button size="sm" variant="primary" onClick={() => void run(api.decideMemory(note.id, true))}>
                <Check className="size-3.5" /> Yes, keep it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void run(api.decideMemory(note.id, false))}>
                <X className="size-3.5" /> No
              </Button>
            </>
          )}
          {chatThere && (
            <Tip label={note.source?.itemId ? 'Open the chat at the row it came from' : 'Open the chat it came from'}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const from = note.source!
                  void openChat(from.chatId!, from.accountId)
                  // Jumps to the exact row and flashes it; it waits while the chat's rows are still being read.
                  if (from.accountId && from.itemId) revealItem(from.chatId!, from.accountId, from.itemId)
                  setView('chat')
                }}
              >
                <ExternalLink className="size-3.5" /> Open chat
              </Button>
            </Tip>
          )}
          {!!note.versions?.length && (
            <Tip label="Back to how it was before the last change">
              <Button size="sm" variant="ghost" onClick={() => void run(api.undoMemory(note.id))}>
                <CornerUpLeft className="size-3.5" /> Undo
              </Button>
            </Tip>
          )}
          {sure ? (
            <>
              <Button size="sm" variant="danger" onClick={() => void run(api.forgetMemory(note.id))}>
                Forget for good
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSure(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Tip label="Remove its words from Ensemble everywhere">
              <Button size="sm" variant="ghost" onClick={() => setSure(true)}>
                <EyeOff className="size-3.5" /> Forget
              </Button>
            </Tip>
          )}
        </div>
      </div>
    </div>
  )
}

/** What every chat starts with from memory right now, and how full that is. */
export function CoreCard({ core, notes }: { core: MemoryCore | null; notes: MemoryNote[] }) {
  if (!core) return null
  const share = Math.min(1, core.words / Math.max(1, core.budget))
  const picked = core.ids.map((id) => notes.find((n) => n.id === id)).filter((n): n is MemoryNote => !!n)
  return (
    <div className="rounded-[14px] bg-surface px-4 py-3.5 shadow-card">
      <div className="flex items-baseline gap-2">
        <div className="text-[13px] font-medium">In every chat right now</div>
        <div className="ml-auto text-[12px] text-ink-3 tabular-nums">
          {core.words} of {core.budget} words
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
        <div className={cn('h-full rounded-full', core.leftOut ? 'bg-warn' : 'bg-ok')} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
        {picked.length ? `${picked.map((n) => n.title).join(' · ')}.` : 'Nothing yet.'} Only what you said or confirmed, or what a check proved, goes in. Everything else is looked up when it is needed.
      </p>
      {core.leftOut > 0 && (
        <p className="mt-1.5 text-[12px] font-medium text-warn">
          Full: {core.leftOut} {core.leftOut === 1 ? 'note does' : 'notes do'} not fit. They are still found when the team searches; forget or merge some to make room.
        </p>
      )}
      {core.waiting > 0 && <p className="mt-1.5 text-[12px] text-ink-3">{core.waiting} waiting for your yes before they can go in.</p>}
    </div>
  )
}

/** The feed of what the team learned, newest first, grouped by day, with a filter by project. */
export function LearnedFeed({ notes }: { notes: MemoryNote[] }) {
  const chatId = useStore((s) => s.chatId)
  const [project, setProject] = useState<string>('all')
  const [only, setOnly] = useState<'all' | 'waiting'>('all')
  const [core, setCore] = useState<MemoryCore | null>(null)

  useEffect(() => {
    let live = true
    void api.memoryCore(chatId).then((c) => live && setCore(c))
    return () => {
      live = false
    }
  }, [notes, chatId])

  const scopes = useMemo(() => [...new Set(notes.map((n) => n.scope).filter((s): s is string => !!s))].sort(), [notes])
  const waiting = notes.filter((n) => n.status === 'waiting').length
  const shown = notes
    .filter((n) => (only === 'waiting' ? n.status === 'waiting' : true))
    .filter((n) => (project === 'all' ? true : project === 'everywhere' ? !n.scope && n.status !== 'forgotten' : n.scope === project))
      .sort((a, b) => learnedAt(b) - learnedAt(a))
  const groups: [string, MemoryNote[]][] = []
  for (const n of shown) {
    const g = dayGroup(learnedAt(n))
    const last = groups.at(-1)
    if (last && last[0] === g) last[1].push(n)
    else groups.push([g, [n]])
  }
  const inCore = new Set(core?.ids || [])

  return (
    <div className="space-y-4">
      <CoreCard core={core} notes={notes} />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          aria-label="Project"
          className="h-7 rounded-[8px] bg-surface px-2 text-[12.5px] text-ink shadow-card outline-none"
        >
          <option value="all">Every project</option>
          <option value="everywhere">General (every project)</option>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {folderName(s)}
            </option>
          ))}
        </select>
        <Button size="sm" variant={only === 'waiting' ? 'soft' : 'ghost'} onClick={() => setOnly(only === 'waiting' ? 'all' : 'waiting')} disabled={!waiting && only !== 'waiting'}>
          Waiting for you{waiting ? ` (${waiting})` : ''}
        </Button>
      </div>
      {groups.map(([label, list]) => (
        <section key={label}>
          <h2 className="mb-2 px-1 text-[12px] font-medium text-ink-3">{label}</h2>
          <div className="space-y-2.5">
            {list.map((n) => (
              <LearnedEntry key={n.id} note={n} inCore={inCore.has(n.id)} />
            ))}
          </div>
        </section>
      ))}
      {!shown.length && (
        <div className="flex flex-col items-center rounded-[14px] border border-dashed border-line-2 px-8 py-12 text-center">
          <BookOpen className="size-6 text-ink-4" strokeWidth={1.5} />
          <div className="mt-3 text-[13.5px] font-medium">{notes.length ? 'Nothing here with this filter' : 'Nothing learned yet'}</div>
          <p className="mt-1 max-w-[340px] text-[12.5px] leading-relaxed text-ink-3">
            {notes.length
              ? 'Pick another project or show everything.'
              : 'When a chat goes quiet, the team looks back at it and keeps what will still matter, with the words it rests on. You can also tell the lead "remember that I prefer TypeScript".'}
          </p>
        </div>
      )}
    </div>
  )
}
