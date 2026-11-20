import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Link2, NotebookPen, Users, WifiOff } from 'lucide-react'
import { ROOM_LIMITS, readJoinCode, stateWords, type ChatShared, type RoomInfo } from '@shared/rooms'
import { useStore } from '@/store'
import { api, cn, relative } from '@/lib/util'
import { Button, Modal, Spinner, Tip } from '../ui'

// Shared projects in the window: "Share this project" (the chat's menu) and "Join a shared project"
// (the new-chat screen). Both dialogs live here; they are opened with a window event, so the rest of
// the app only needs a menu entry.

type Open = { kind: 'share'; chatId: string } | { kind: 'join' } | null
const EVENT = 'ensemble:rooms'
export const openShare = (chatId: string): void => void window.dispatchEvent(new CustomEvent<Open>(EVENT, { detail: { kind: 'share', chatId } }))
export const openJoin = (): void => void window.dispatchEvent(new CustomEvent<Open>(EVENT, { detail: { kind: 'join' } }))

const NAME_KEY = 'ensemble.rooms.name'
const savedName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) || ''
  } catch {
    return ''
  }
}
const keepName = (name: string): void => {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    /* private mode: asked again next time */
  }
}

const field = 'h-9 w-full rounded-[9px] bg-surface px-3 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--line-2)] outline-none placeholder:text-ink-4 focus:shadow-[inset_0_0_0_1.5px_var(--accent)]'
const label = 'mb-1.5 block text-[12px] font-medium text-ink-2'
const errorOf = (e: unknown): string => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** What both people should know before a project is shared: said plainly, once. */
function Reach({ on }: { on: boolean }) {
  return (
    <div className="rounded-[11px] bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-2">
      <p>
        The other person's computer connects straight to this one. It has to be able to reach it: on the same network, or on a private network such as Tailscale. Ensemble does not pass anything through the
        internet.
      </p>
      <p className="mt-1.5">What the two teams send is sealed with a key from the join code, so keep the code between the two of you. Each person works with their own accounts; nothing here can be approved or changed from the other side.</p>
      {!on && <p className="mt-1.5 font-medium text-ink">Sharing switches on "Phone and remote" (Settings), the small server other devices reach this computer through.</p>}
    </div>
  )
}

function People({ info, onRemove }: { info: RoomInfo; onRemove?(id: string, name: string): void }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
        <Users className="size-3.5 text-ink-3" />
        In this project
      </div>
      <ul className="divide-y divide-[var(--line)] rounded-[11px] bg-surface shadow-card">
        {info.people.map((p) => (
          <li key={p.id} className="flex h-10 items-center gap-2.5 px-3 text-[13px]">
            <span className={cn('size-2 shrink-0 rounded-full', p.me || p.online ? 'bg-ok' : 'bg-ink-4')} />
            <span className="min-w-0 flex-1 truncate">
              {p.name}
              {p.me && <span className="text-ink-3"> (you)</span>}
            </span>
            <span className="text-[12px] text-ink-3">{p.host ? 'Shares the project' : p.me || p.online ? 'Connected' : 'Not connected'}</span>
            {onRemove && !p.host && (
              <Button size="sm" variant="danger" onClick={() => onRemove(p.id, p.name)}>
                Remove
              </Button>
            )}
          </li>
        ))}
        {info.role === 'host' && info.people.length === 1 && <li className="px-3 py-2.5 text-[12.5px] text-ink-3">Nobody has joined yet. Send the code to the person you want to work with.</li>}
      </ul>
    </div>
  )
}

function Notes({ info, onChange }: { info: RoomInfo; onChange(): void }) {
  const toast = useStore((s) => s.toast)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const over = info.state === 'removed' || info.state === 'ended' || info.state === 'left'
  const save = async (): Promise<void> => {
    const said = await api.roomNote(info.chatId, title, body).catch(errorOf)
    if (/^(Saved|Kept)/.test(said)) {
      setTitle('')
      setBody('')
      setAdding(false)
      onChange()
    } else toast(said, 'warn')
  }
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
        <NotebookPen className="size-3.5 text-ink-3" />
        <span className="flex-1">Project memory, shared by both teams</span>
        {!over && !adding && (
          <button className="text-[12px] font-medium text-accent hover:underline" onClick={() => setAdding(true)}>
            Add a note
          </button>
        )}
      </div>
      {adding && (
        <div className="mb-2 rounded-[11px] bg-surface p-3 shadow-card">
          <input className={field} placeholder="Title, for example: API port" value={title} maxLength={ROOM_LIMITS.noteTitle} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            className={cn(field, 'mt-2 h-24 resize-none py-2 leading-relaxed')}
            placeholder="What both teams should know. No passwords or keys: it leaves this computer."
            value={body}
            maxLength={ROOM_LIMITS.noteBody}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!title.trim() || !body.trim()} onClick={() => void save()}>
              Save note
            </Button>
          </div>
        </div>
      )}
      {info.notes.length === 0 ? (
        <p className="rounded-[11px] bg-surface px-3 py-2.5 text-[12.5px] text-ink-3 shadow-card">No notes yet. Agents on both sides add decisions and findings here, and so can you.</p>
      ) : (
        <ul className="max-h-[220px] divide-y divide-[var(--line)] overflow-y-auto rounded-[11px] bg-surface shadow-card">
          {info.notes.map((n) => (
            <li key={n.id}>
              <button className="block w-full px-3 py-2 text-left hover:bg-hover" onClick={() => setOpen(open === n.id ? null : n.id)}>
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{n.title}</span>
                  <span className="shrink-0 text-[11.5px] text-ink-3">
                    {n.pending ? 'Waiting to be sent' : `${n.agent ? `${n.agent}, ` : ''}${n.by} · ${relative(n.at)}`}
                  </span>
                </span>
                <span className={cn('mt-0.5 block text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2', open !== n.id && 'line-clamp-2')}>{n.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CodeBox({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div>
      <div className={label}>Join code</div>
      <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1 rounded-[9px] bg-surface px-3 py-2 shadow-[inset_0_0_0_1px_var(--line-2)]">
          <code className="line-clamp-3 font-mono text-[11.5px] leading-[1.45] break-all text-ink-2 select-all">{code}</code>
        </div>
        <Button variant="primary" className="h-auto" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy code'}
        </Button>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-3">Send it to the person you want to work with. In their Ensemble: New chat, then "Join a shared project". Up to {ROOM_LIMITS.members} people can join.</p>
    </div>
  )
}

function ShareBody({ chatId, onClose }: { chatId: string; onClose(): void }) {
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId))
  const remoteOn = useStore((s) => s.settings.remote === true)
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const [info, setInfo] = useState<RoomInfo | null | undefined>(undefined)
  const [name, setName] = useState(savedName)
  const [project, setProject] = useState(chat?.title && chat.title !== 'New chat' ? chat.title : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const read = (): void => void api.roomInfo(chatId).then(setInfo, () => setInfo(null))
  // While the dialog is open, what it shows is read again every second and a half: someone joining, a note arriving.
  useEffect(() => {
    read()
    const t = setInterval(read, 1500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  if (info === undefined) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!info) {
    const share = async (): Promise<void> => {
      setBusy(true)
      setError('')
      keepName(name.trim())
      try {
        setInfo(await api.roomShare(chatId, name.trim(), project.trim() || undefined))
      } catch (e) {
        setError(errorOf(e))
      }
      setBusy(false)
    }
    return (
      <div className="space-y-4 px-6 pt-3 pb-5">
        <Reach on={remoteOn} />
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={label}>Your name, as the other person sees it</span>
            <input className={field} value={name} maxLength={ROOM_LIMITS.name} placeholder="For example: Kerim" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span className={label}>Project name</span>
            <input className={field} value={project} maxLength={80} placeholder="For example: Website relaunch" onChange={(e) => setProject(e.target.value)} />
          </label>
        </div>
        {error && <p className="text-[12.5px] text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void share()}>
            {busy ? <Spinner /> : <Link2 className="size-3.5" />}
            Share and get a code
          </Button>
        </div>
      </div>
    )
  }

  const host = info.role === 'host'
  const over = info.state === 'removed' || info.state === 'ended' || info.state === 'left'
  const away = !over && info.state !== 'connected'
  return (
    <div className="space-y-4 overflow-y-auto px-6 pt-3 pb-5">
      <div className={cn('flex items-center gap-2 text-[12.5px]', away || over ? 'text-warn' : 'text-ink-2')}>
        {away || over ? <WifiOff className="size-3.5" /> : <span className="size-2 rounded-full bg-ok" />}
        <span className="font-medium">{stateWords(info)}</span>
        {info.detail && <span className="min-w-0 flex-1 truncate text-ink-3">{info.detail}</span>}
        {info.waiting > 0 && <span className="text-ink-3">{info.waiting === 1 ? '1 write waits' : `${info.waiting} writes wait`} to be sent</span>}
      </div>
      {host && info.code && <CodeBox code={info.code} />}
      {host && !info.code && <p className="rounded-[11px] bg-surface-2 px-3.5 py-3 text-[12.5px] text-ink-2">Nobody can reach this computer right now: "Phone and remote" is off. Switch it on in Settings to share again.</p>}
      {!over && (
        <People
          info={info}
          onRemove={
            host
              ? (id, who) =>
                  setModal({
                    kind: 'confirm',
                    title: `Remove ${who}?`,
                    body: `${who}'s team is cut off at once and the join code changes. They keep the notes they already have.`,
                    action: 'Remove',
                    run: () => void api.roomRemove(chatId, id).then(setInfo, (e) => toast(errorOf(e), 'warn')),
                  })
              : undefined
          }
        />
      )}
      <Notes info={info} onChange={read} />
      <div className="flex items-center gap-2 pt-1">
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink-3">
          {host ? 'Each person uses their own accounts. Messages between the teams show up in the chat on both sides.' : over ? 'The notes you had stay readable here.' : `Shared by ${info.people.find((p) => p.host)?.name || 'the other person'}. Messages between the teams show up in the chat on both sides.`}
        </p>
        {host ? (
          <Button
            variant="danger"
            onClick={() =>
              setModal({
                kind: 'confirm',
                title: 'Stop sharing this project?',
                body: 'Everyone who joined is cut off at once. The notes stay in this chat. "Phone and remote" stays as it is.',
                action: 'Stop sharing',
                run: () => void api.roomStop(chatId).then(onClose, (e) => toast(errorOf(e), 'warn')),
              })
            }
          >
            Stop sharing
          </Button>
        ) : (
          !over && (
            <Button variant="danger" onClick={() => void api.roomLeave(chatId).then(read, (e) => toast(errorOf(e), 'warn'))}>
              Leave project
            </Button>
          )
        )}
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

function JoinBody({ onClose }: { onClose(): void }) {
  const openChat = useStore((s) => s.openChat)
  const [code, setCode] = useState('')
  const [name, setName] = useState(savedName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const read = useMemo(() => (code.trim() ? readJoinCode(code) : null), [code])
  const join = async (): Promise<void> => {
    setBusy(true)
    setError('')
    keepName(name.trim())
    try {
      const info = await api.roomJoin(code, name.trim())
      onClose()
      void openChat(info.chatId)
    } catch (e) {
      setError(errorOf(e))
    }
    setBusy(false)
  }
  return (
    <div className="space-y-4 px-6 pt-3 pb-5">
      <label className="block">
        <span className={label}>Join code</span>
        <textarea className={cn(field, 'h-[76px] resize-none py-2 font-mono text-[11.5px] leading-snug break-all')} placeholder="ensemble-join:…" value={code} spellCheck={false} onChange={(e) => setCode(e.target.value)} />
        {read && !read.ok && <span className="mt-1 block text-[12px] text-bad">{read.reason}</span>}
        {read?.ok && (
          <span className="mt-1 block text-[12px] text-ink-2">
            Project: <span className="font-medium text-ink">{read.code.n}</span>
          </span>
        )}
      </label>
      <label className="block">
        <span className={label}>Your name, as the other person sees it</span>
        <input className={field} value={name} maxLength={ROOM_LIMITS.name} placeholder="For example: Ana" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="rounded-[11px] bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-2">
        <p>Your Ensemble connects straight to the other person's computer, so it must be on, with Ensemble open, and reachable from here: the same network, or a private network such as Tailscale.</p>
        <p className="mt-1.5">You get a chat for the project with your own team and accounts. Both teams share the project's notes and can message each other. What arrives from the other side is shown in your chat and can never approve or change anything here.</p>
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !read?.ok || !name.trim()} onClick={() => void join()}>
          {busy ? <Spinner /> : <Link2 className="size-3.5" />}
          Join project
        </Button>
      </div>
    </div>
  )
}

/** Mounted once (in the title bar). Shows whichever of the two dialogs was asked for. */
export function RoomsDialogs() {
  const [open, setOpen] = useState<Open>(null)
  const name = useStore((s) => (open?.kind === 'share' ? s.chats.find((c) => c.id === open.chatId)?.shared?.name : undefined))
  useEffect(() => {
    const on = (e: Event): void => setOpen((e as CustomEvent<Open>).detail)
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  const close = (): void => setOpen(null)
  return (
    <>
      <Modal open={open?.kind === 'share'} onClose={close} width={600} title={name ? `Shared project: ${name}` : 'Share this project'} description={name ? 'Who is in it, the code to join, and the notes both teams keep.' : 'Work on this project with someone else: your team and theirs, each on their own computer.'}>
        {open?.kind === 'share' && <ShareBody chatId={open.chatId} onClose={close} />}
      </Modal>
      <Modal open={open?.kind === 'join'} onClose={close} width={520} title="Join a shared project" description="Paste the code the other person sent you.">
        {open?.kind === 'join' && <JoinBody onClose={close} />}
      </Modal>
    </>
  )
}

/** In the title bar of a chat that is in a shared project: who it is shared with, and whether it is connected. Opens the dialog. */
export function SharedBadge({ chat }: { chat: { id: string; shared?: ChatShared } }) {
  const s = chat.shared
  if (!s) return null
  const who = s.people.length ? s.people.join(', ') : s.role === 'host' ? 'nobody has joined yet' : ''
  return (
    <Tip label={s.connected ? `Shared project "${s.name}"${who ? `, with ${who}` : ''}` : s.role === 'host' ? 'Shared, but nobody can reach this computer right now' : 'Shared project: not connected right now. Ensemble keeps trying.'}>
      <button onClick={() => openShare(chat.id)} className={cn('no-drag flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-hover', s.connected ? 'text-ink-2' : 'text-warn')}>
        {s.connected ? <Users className="size-3 text-ink-3" /> : <WifiOff className="size-3" />}
        <span className="max-w-[180px] truncate">{s.connected ? `Shared${s.people.length ? ` with ${s.people.join(', ')}` : ''}` : 'Shared, not connected'}</span>
      </button>
    </Tip>
  )
}

/** The new-chat screen's way in. */
export function JoinStarter() {
  return (
    <Tip label="Someone shared a project with you: paste their code">
      <button onClick={openJoin} className="flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] transition-colors hover:bg-hover hover:text-ink">
        <Link2 className="size-3.5 text-ink-3" strokeWidth={1.9} />
        Join a shared project
      </button>
    </Tip>
  )
}
