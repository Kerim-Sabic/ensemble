import { useEffect, useState } from 'react'
import { ExternalLink, FolderOpen, Images, MessageSquare } from 'lucide-react'
import type { LibraryImage } from '@shared/types'
import { useStore } from '@/store'
import { api, baseName, relative } from '@/lib/util'
import { Spinner, Tip } from './ui'
import { Orb } from './Orb'

function Tile({ image }: { image: LibraryImage }) {
  const account = useStore((s) => s.members[image.accountId])
  const openChat = useStore((s) => s.openChat)
  const [gone, setGone] = useState(false)
  if (gone) return null
  return (
    <figure className="group/tile relative animate-rise overflow-hidden rounded-[14px] bg-surface shadow-card transition-shadow duration-200 hover:shadow-float">
      <button onClick={() => void api.openPath(image.path)} className="block aspect-[4/3] w-full overflow-hidden bg-surface-3" aria-label={`Open ${baseName(image.path)}`}>
        <img src={api.fileUrl(image.path)} alt="" loading="lazy" onError={() => setGone(true)} className="size-full object-cover transition-transform duration-500 ease-out group-hover/tile:scale-[1.03]" />
      </button>
      <figcaption className="flex items-center gap-2 px-3 py-2.5">
        <Orb account={account} size={15} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">{image.chatTitle}</span>
          <span className="block truncate text-[11.5px] text-ink-3">
            {account?.name || 'A teammate'} · {relative(image.ts)}
          </span>
        </span>
      </figcaption>
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover/tile:opacity-100">
        {[
          { label: 'Go to the chat', icon: MessageSquare, run: () => void openChat(image.chatId, image.accountId) },
          { label: 'Show in folder', icon: FolderOpen, run: () => void api.showInFolder(image.path) },
          { label: 'Open', icon: ExternalLink, run: () => void api.openPath(image.path) },
        ].map((b) => (
          <Tip key={b.label} label={b.label}>
            <button onClick={b.run} aria-label={b.label} className="flex size-7 items-center justify-center rounded-[8px] bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75">
              <b.icon className="size-3.5" />
            </button>
          </Tip>
        ))}
      </div>
    </figure>
  )
}

/** Every picture the team has made, across all chats. */
export function LibraryView() {
  const [images, setImages] = useState<LibraryImage[] | null>(null)
  const hasGpt = useStore((s) => s.accounts.some((a) => a.enabled && a.provider === 'chatgpt'))
  const setModal = useStore((s) => s.setModal)

  useEffect(() => {
    void api.listImages().then(setImages, () => setImages([]))
  }, [])

  if (images === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-3">
        <Spinner /> Gathering pictures…
      </div>
    )
  }

  if (!images.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <span className="flex size-12 items-center justify-center rounded-[14px] bg-surface-2 text-ink-3 shadow-[inset_0_0_0_1px_var(--line)]">
          <Images className="size-5" strokeWidth={1.75} />
        </span>
        <h2 className="mt-4 text-[15px] font-semibold">No pictures yet</h2>
        <p className="mt-1.5 max-w-[360px] text-[13px] leading-relaxed text-ink-3">
          {hasGpt ? 'Ask for an image in any chat and the lead hands it to a ChatGPT teammate. Everything they make is collected here.' : 'Pictures are made by ChatGPT teammates. Add a ChatGPT account and everything it draws is collected here.'}
        </p>
        {!hasGpt && (
          <button onClick={() => setModal({ kind: 'add-account' })} className="mt-5 h-9 rounded-[10px] bg-ink px-4 text-[13px] font-medium text-inverse hover:opacity-90">
            Add a ChatGPT account
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="mx-auto max-w-[1100px] px-7 py-6">
        <div className="mb-4 flex items-baseline gap-2">
          <h2 className="text-[15px] font-semibold">Pictures the team made</h2>
          <span className="tabular text-[12px] text-ink-3">{images.length}</span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {images.map((im) => (
            <Tile key={`${im.chatId}:${im.path}`} image={im} />
          ))}
        </div>
      </div>
    </div>
  )
}
