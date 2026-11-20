import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { MemoryNote } from '@shared/types'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Button, Toggle, inputClass } from './ui'
import { LearnedFeed } from './memory/Learned'


function Editor({ note, onDone }: { note?: MemoryNote; onDone(): void }) {
  const run = useStore((s) => s.run)
  const [title, setTitle] = useState(note?.title || '')
  const [body, setBody] = useState(note?.body || '')
  const [everywhere, setEverywhere] = useState(true)
  const cwd = useStore((s) => s.chats.find((c) => c.id === s.chatId)?.cwd || null)
  const save = async (): Promise<void> => {
    if (!body.trim()) return
    await run(api.saveMemory({ id: note?.id, title: title.trim() || body.trim().split('\n')[0].slice(0, 60), body, kind: 'preference', scope: everywhere ? null : cwd }))
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
      <div className="mt-3 flex items-center gap-2">
        {cwd && (
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Toggle checked={everywhere} onChange={setEverywhere} label="For every project" />
            {everywhere ? 'For every project' : 'Only for this chat’s folder'}
          </label>
        )}
        <div className="flex-1" />
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

/** What I learned: what the team keeps between chats, each note with where it came from. */
export function MemoryView() {
  const notes = useStore((s) => s.memory)
  const enabled = useStore((s) => s.settings.memoryEnabled)
  const review = useStore((s) => s.settings.memoryReview !== false)
  const perDay = useStore((s) => s.settings.memoryReviewsPerDay ?? 12)
  const run = useStore((s) => s.run)
  const [adding, setAdding] = useState(false)

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="mx-auto max-w-[680px] px-7 py-8">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">What I learned</h1>
            <p className="mt-1.5 max-w-[500px] text-[13.5px] leading-relaxed text-ink-2">
              What the team keeps from one chat to the next, each with where it came from. Only what you said or confirmed, or what a check proved, is used in every chat. Undo any change, or forget a note for good.
            </p>
          </div>
          <Button variant="primary" onClick={() => setAdding(true)} disabled={adding}>
            <Plus className="size-3.5" /> Add a note
          </Button>
        </div>

        <div className="mt-5 divide-y divide-line rounded-[14px] bg-surface shadow-card">
          <div className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Use memory</div>
              <div className="mt-0.5 text-[12px] text-ink-3">When off, agents neither read nor save notes. Your notes are kept.</div>
            </div>
            <Toggle checked={enabled} onChange={(v) => void run(api.updateSettings({ memoryEnabled: v }))} label="Use memory" />
          </div>
          <div className={cn('flex items-center gap-4 px-4 py-3', !enabled && 'opacity-55')}>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Look back at chats</div>
              <div className="mt-0.5 text-[12px] text-ink-3">
                When a chat has gone quiet, the fastest model reads what is new and keeps what will still matter, each with the words it rests on. Up to {perDay} a day, on an account with allowance to spare.
              </div>
            </div>
            <Toggle checked={review} onChange={(v) => void run(api.updateSettings({ memoryReview: v }))} label="Look back at chats" />
          </div>
        </div>

        <div className={cn('mt-5 space-y-2.5 transition-opacity', !enabled && 'opacity-55')}>
          {adding && <Editor onDone={() => setAdding(false)} />}
          <LearnedFeed notes={notes} />
        </div>
      </div>
    </div>
  )
}
