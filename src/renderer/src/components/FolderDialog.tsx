import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { api, cn } from '@/lib/util'
import { Button, Modal, inputClass } from './ui'

const EXAMPLES = ['Answer in Bosnian.', 'This is a React + Supabase app. Run the tests before saying something works.', 'Keep prices exactly as they are in the menu file.', 'Write for a non-technical owner: short sentences, no jargon.']

/** A folder's name and the instructions every agent in its chats follows, like a project's. */
export function FolderDialog() {
  const id = useStore((s) => (s.modal?.kind === 'folder' ? s.modal.id : null))
  const folder = useStore((s) => s.folders.find((f) => f.id === id))
  const count = useStore((s) => (id ? s.chats.filter((c) => c.folderId === id).length : 0))
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState('')
  const [text, setText] = useState('')

  useEffect(() => {
    setName(folder?.name || '')
    setText(folder?.instructions || '')
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = (): void => setModal(null)
  if (!folder) return <Modal open={false} onClose={close} title="Folder" children={null} />
  const changed = name.trim() !== folder.name || text.trim() !== (folder.instructions || '').trim()

  const save = async (): Promise<void> => {
    const r = await run(api.updateFolder(folder.id, { name: name.trim() || folder.name, instructions: text }))
    if (!r) return
    if (text.trim() !== (folder.instructions || '').trim()) toast(text.trim() ? `Every agent in ${r.name} follows these from its next message.` : `${r.name} no longer has instructions.`)
    close()
  }

  return (
    <Modal open onClose={close} title={folder.name} description="Instructions here go to every agent in every chat in this folder, the way a project's instructions do. Chats keep their own conversations." width={560}>
      <div className="space-y-4 overflow-y-auto px-6 pt-3 pb-5">
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-ink-3">Name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} className={inputClass} aria-label="Folder name" />
        </div>
        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
            <span className="font-medium text-ink-3">Instructions</span>
            <span className="tabular text-ink-4">{count ? `${count} ${count === 1 ? 'chat' : 'chats'} follow these` : 'No chats here yet'}</span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={9}
            maxLength={20000}
            placeholder="What every agent here should know or keep to: what the project is, how to run and test it, the tone to write in, things never to change…"
            className={cn(inputClass, 'h-auto min-h-[180px] resize-y py-2.5 leading-relaxed')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && changed) void save()
            }}
          />
          {!text.trim() && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => setText((t) => (t ? `${t}\n${ex}` : ex))} className="h-6 rounded-full px-2.5 text-[11.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-hover hover:text-ink">
                  {ex}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!changed} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}
