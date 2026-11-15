import { useState } from 'react'
import { BookOpen, Pencil, Plus, Trash2 } from 'lucide-react'
import type { MemoryNote } from '@shared/types'
import { useStore } from '@/store'
import { api, cn, relative } from '@/lib/util'
import { Button, IconButton, Toggle, inputClass } from './ui'
import { Orb } from './Orb'

function Editor({ note, onDone }: { note?: MemoryNote; onDone(): void }) {
  const run = useStore((s) => s.run)
  const [title, setTitle] = useState(note?.title || '')
  const [body, setBody] = useState(note?.body || '')
  const save = async (): Promise<void> => {
    if (!body.trim()) return
    await run(api.saveMemory({ id: note?.id, title: title.trim() || body.trim().split('\n')[0].slice(0, 60), body }))
    onDone()
  }
  return (
    <div className="animate-rise rounded-[14px] bg-surface p-4 shadow-float">
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short label, for example: Code style" className={inputClass} />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What should the team know next time? For example: Always use pnpm in this project, never npm."
        rows={4}
        className={cn(inputClass, 'mt-2 h-auto resize-none py-2.5 leading-relaxed')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save()
        }}
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!body.trim()} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  )
}

function Note({ note }: { note: MemoryNote }) {
  const author = useStore((s) => s.members[note.author])
  const run = useStore((s) => s.run)
  const [editing, setEditing] = useState(false)
  if (editing) return <Editor note={note} onDone={() => setEditing(false)} />
  return (
    <div className="group/note rounded-[14px] bg-surface px-4 py-3.5 shadow-card">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">{note.title}</div>
          <p className="selectable mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">{note.body}</p>
        </div>
        <div className="-mt-1 -mr-1.5 flex opacity-0 transition-opacity group-hover/note:opacity-100">
          <IconButton label="Edit" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton label="Forget this" onClick={() => void run(api.deleteMemory(note.id))}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
        {author ? (
          <>
            <Orb account={author} size={12} /> Saved by {author.name}
          </>
        ) : (
          'Added by you'
        )}
        <span>·</span>
        {relative(note.updatedAt)}
      </div>
    </div>
  )
}

/** What the team carries from one chat to the next. */
export function MemoryView() {
  const notes = useStore((s) => s.memory)
  const enabled = useStore((s) => s.settings.memoryEnabled)
  const run = useStore((s) => s.run)
  const [adding, setAdding] = useState(false)

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="mx-auto max-w-[680px] px-7 py-8">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Team notebook</h1>
            <p className="mt-1.5 max-w-[480px] text-[13.5px] leading-relaxed text-ink-2">
              Short facts the whole team starts every chat with. Agents add notes as they learn how you like to work, and you can add, edit or remove anything here.
            </p>
          </div>
          <Button variant="primary" onClick={() => setAdding(true)} disabled={adding}>
            <Plus className="size-3.5" /> Add a note
          </Button>
        </div>

        <div className="mt-5 flex items-center gap-4 rounded-[14px] bg-surface px-4 py-3 shadow-card">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Use the notebook</div>
            <div className="mt-0.5 text-[12px] text-ink-3">When off, agents neither read nor save notes. Your notes are kept.</div>
          </div>
          <Toggle checked={enabled} onChange={(v) => void run(api.updateSettings({ memoryEnabled: v }))} label="Use the notebook" />
        </div>

        <div className={cn('mt-5 space-y-2.5 transition-opacity', !enabled && 'opacity-55')}>
          {adding && <Editor onDone={() => setAdding(false)} />}
          {notes.map((n) => (
            <Note key={n.id} note={n} />
          ))}
          {!notes.length && !adding && (
            <div className="flex flex-col items-center rounded-[14px] border border-dashed border-line-2 px-8 py-12 text-center">
              <BookOpen className="size-6 text-ink-4" strokeWidth={1.5} />
              <div className="mt-3 text-[13.5px] font-medium">Nothing remembered yet</div>
              <p className="mt-1 max-w-[320px] text-[12.5px] leading-relaxed text-ink-3">Tell the lead something like "remember that I prefer TypeScript", or add a note yourself.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
