import { memo, useEffect, useMemo, useState, type DragEvent } from 'react'
import { Activity, BookOpen, ChevronRight, Plug, ScrollText, Download, Ellipsis, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, Images, PanelLeft, Pencil, Pin, PinOff, Plus, Repeat, Search, Settings2, SquarePen, Target, Trash2 } from 'lucide-react'
import { goalLine, goalOpen, liveLoops } from '@shared/auto'
import type { Account, AgentState, Chat, Folder } from '@shared/types'
import { adviseModel, budgetOf, hoursLabel, paceWord, type WindowBudget } from '@shared/budget'
import { supplyNow, supplyWords } from '@shared/failover'
import { leadOf, useAccounts, useLiveByChat, useStore, useWorkByAccount, useWorkSummary } from '@/store'
import { accentVars, api, cn, dayBucket, folderLabel, relative } from '@/lib/util'
import { IconButton, Kbd, Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from './ui'
import { BudgetMeter, Orb, OrbStack } from './Orb'
import { UltraGlyph } from './ultra/Ultra'

/** The app's mark, the same drawing as its icon: three lights that add up to white where they meet. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="lg-t" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#40309A" />
          <stop offset="0.5" stopColor="#201852" />
          <stop offset="1" stopColor="#0C0922" />
        </linearGradient>
        <radialGradient id="lg-a">
          <stop offset="0" stopColor="#FFCDAB" />
          <stop offset="0.68" stopColor="#FF7240" />
          <stop offset="1" stopColor="#EE4E1C" />
        </radialGradient>
        <radialGradient id="lg-b">
          <stop offset="0" stopColor="#D2C4FF" />
          <stop offset="0.68" stopColor="#7E5EFF" />
          <stop offset="1" stopColor="#5836EE" />
        </radialGradient>
        <radialGradient id="lg-c">
          <stop offset="0" stopColor="#B0FFF1" />
          <stop offset="0.68" stopColor="#1BCBB8" />
          <stop offset="1" stopColor="#0AA394" />
        </radialGradient>
        <radialGradient id="lg-w">
          <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <clipPath id="lg-clip">
          <rect x="1" y="1" width="62" height="62" rx="15" />
        </clipPath>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="15" fill="url(#lg-t)" />
      <g clipPath="url(#lg-clip)">
        <g style={{ isolation: 'isolate' }}>
          <circle cx="32" cy="24.5" r="16.5" fill="url(#lg-a)" style={{ mixBlendMode: 'screen' }} />
          <circle cx="22.7" cy="40.5" r="16.5" fill="url(#lg-b)" style={{ mixBlendMode: 'screen' }} />
          <circle cx="41.3" cy="40.5" r="16.5" fill="url(#lg-c)" style={{ mixBlendMode: 'screen' }} />
        </g>
        <circle cx="32" cy="35.2" r="9" fill="url(#lg-w)" />
      </g>
    </svg>
  )
}

const busy = (s: AgentState): boolean => s.phase !== 'idle' && s.phase !== 'error'

/** What is being dragged, when it is a chat on its way to a folder. */
const DRAG = 'application/x-ensemble-chat'

const draggedChat = (e: DragEvent): boolean => e.dataTransfer.types.includes(DRAG)

/** A small mark on a chat row for what runs there by itself: a goal, loops, or both. Fixed width, so the row does not move. */
function AutoMarks({ chat }: { chat: Chat }) {
  const goal = goalOpen(chat.goal) ? chat.goal : null
  const loops = liveLoops(chat.loops)
  const ultra = !!chat.ultra
  if (!goal && !loops.length && !ultra) return null
  const blocked = goal?.status === 'blocked'
  const paused = (!goal || goal.status === 'paused') && loops.every((l) => l.status === 'paused')
  const tip = [
    goal ? `Goal: ${goalLine(goal)}` : '',
    loops.length ? (loops.length === 1 ? `Loop${loops[0].status === 'paused' ? ', paused' : ''}` : `${loops.length} loops`) : '',
    ultra ? 'Ultra is on' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Tip label={tip} side="right">
      <span className={cn('flex h-3 shrink-0 items-center gap-0.5', blocked ? 'text-warn' : paused ? 'text-ink-4' : 'text-ink-3')}>
        {goal && <Target className="size-3" strokeWidth={2.2} />}
        {loops.length > 0 && <Repeat className={cn('size-3', blocked && 'text-ink-3')} strokeWidth={2.2} />}
        {ultra && <UltraGlyph size={12} />}
      </span>
    </Tip>
  )
}

/** How many of the lead's replies each chat had when you last had it open. */
const seenReplies = new Map<string, number>()

const NO_LIVE: Account[] = []

const ChatRow = memo(function ChatRow({ chat, active, live, waiting, folders, onNewFolder }: { chat: Chat; active: boolean; live: Account[]; waiting: boolean; folders: Folder[]; onNewFolder(chat: Chat): void }) {
  // Replies from the lead that arrived while you were elsewhere: a dot until you open the chat.
  const replies = useStore((s) => s.unread[`${chat.id}:${leadOf(s, chat.id)?.id}`] || 0)
  useEffect(() => {
    if (active) seenReplies.set(chat.id, replies)
  }, [active, chat.id, replies])
  const unread = !active && replies > (seenReplies.get(chat.id) ?? 0)
  const openChat = useStore((s) => s.openChat)
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const toast = useStore((s) => s.toast)
  const home = useStore((s) => s.env.home)
  const [renaming, setRenaming] = useState(false)
  const [menu, setMenu] = useState(false)

  const save = (title: string): void => {
    setRenaming(false)
    if (title.trim() && title.trim() !== chat.title) void run(api.updateChat(chat.id, { title }))
  }

  return (
    <div
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG, chat.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => !renaming && void openChat(chat.id)}
      onMouseLeave={() => setMenu(false)}
      className={cn(
        'group/chat relative flex cursor-default flex-col rounded-[9px] px-2.5 py-[7px] transition-colors duration-100',
        active ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      <div className="flex h-[19px] items-center gap-2">
        {chat.pinned && <Pin className="size-3 shrink-0 text-ink-3" />}
        {renaming ? (
          <input
            autoFocus
            defaultValue={chat.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => save(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(e.currentTarget.value)
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="selectable -mx-1 min-w-0 flex-1 rounded-[5px] bg-surface px-1 text-[13px] shadow-[0_0_0_1.5px_var(--link)] outline-none"
          />
        ) : (
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', active || unread ? 'font-medium text-ink' : 'text-ink')}>{chat.title}</span>
        )}
        {!renaming && (
          <span className="flex shrink-0 items-center gap-1.5">
            <AutoMarks chat={chat} />
            {waiting && <span className="size-[7px] animate-pulse-soft rounded-full bg-warn" title="Needs your OK" />}
            {unread && !waiting && (
              <Tip label="New reply" side="right">
                <span className="size-[7px] rounded-full bg-link" aria-label="New reply" />
              </Tip>
            )}
            {live.length > 0 ? (
              <span className={cn(menu ? 'hidden' : 'group-hover/chat:hidden')}>
                <OrbStack accounts={live.map((a) => ({ ...a, live: true }))} size={12} max={3} />
              </span>
            ) : (
              <span className={cn('tabular text-[11px] text-ink-3', menu ? 'hidden' : 'group-hover/chat:hidden')}>{relative(chat.updatedAt)}</span>
            )}
            <span className={cn(menu ? 'block' : 'hidden group-hover/chat:block')} onClick={(e) => e.stopPropagation()}>
              <Menu
                align="start"
                width={220}
                trigger={
                  <button
                    aria-label="Chat options"
                    onClick={() => setMenu(true)}
                    className="-my-1 -mr-1 flex size-6 items-center justify-center rounded-[6px] text-ink-3 hover:bg-active hover:text-ink"
                  >
                    <Ellipsis className="size-4" />
                  </button>
                }
              >
                <MenuItem icon={<Pencil className="size-3.5" />} onSelect={() => setRenaming(true)}>
                  Rename
                </MenuItem>
                <MenuItem
                  icon={chat.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  onSelect={() => void run(api.updateChat(chat.id, { pinned: !chat.pinned }))}
                >
                  {chat.pinned ? 'Unpin' : 'Pin to top'}
                </MenuItem>
                <MenuItem icon={<FolderOpen className="size-3.5" />} onSelect={() => void api.openPath(chat.cwd)}>
                  Open folder
                </MenuItem>
                <MenuItem icon={<Download className="size-3.5" />} onSelect={() => void run(api.exportChat(chat.id)).then((p) => p && toast('Saved the chat as a document.'))}>
                  Save as a document…
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>File under</MenuLabel>
                {folders.map((f) => (
                  <MenuItem key={f.id} icon={<FolderIcon className="size-3.5" />} checked={chat.folderId === f.id} onSelect={() => void run(api.updateChat(chat.id, { folderId: chat.folderId === f.id ? null : f.id }))}>
                    {f.name}
                  </MenuItem>
                ))}
                <MenuItem icon={<FolderPlus className="size-3.5" />} onSelect={() => onNewFolder(chat)}>
                  New folder…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 className="size-3.5" />}
                  onSelect={() =>
                    setModal({
                      kind: 'confirm',
                      title: 'Delete this chat?',
                      body: `"${chat.title}" and everything the team said in it will be removed from Ensemble. Files the team created stay where they are.`,
                      action: 'Delete chat',
                      run: () => void run(api.deleteChat(chat.id)),
                    })
                  }
                >
                  Delete
                </MenuItem>
              </Menu>
            </span>
          </span>
        )}
      </div>
      <div className="mt-px truncate text-[11.5px] leading-[16px] text-ink-3">{folderLabel(chat.cwd, home)}</div>
    </div>
  )
})

type Live = Map<string, { live: Account[]; waiting: boolean }>

/** One folder: a heading that opens and closes, and the chats filed under it. A chat can be dropped on it. */
function FolderSection({
  folder,
  chats,
  chatId,
  live,
  folders,
  renaming,
  setRenaming,
  onNewFolder,
}: {
  folder: Folder
  chats: Chat[]
  chatId: string | null
  live: Live
  folders: Folder[]
  renaming: boolean
  setRenaming(id: string | null): void
  onNewFolder(chat: Chat): void
}) {
  const run = useStore((s) => s.run)
  const newChat = useStore((s) => s.newChat)
  const setModal = useStore((s) => s.setModal)
  const [over, setOver] = useState(false)
  const [menu, setMenu] = useState(false)
  const open = !folder.collapsed
  // Closed, the folder still shows that something inside it is being worked on.
  const working = useMemo(() => chats.flatMap((c) => live.get(c.id)?.live || []), [chats, live])
  const waiting = chats.some((c) => live.get(c.id)?.waiting)

  const save = (name: string): void => {
    setRenaming(null)
    if (name.trim() && name.trim() !== folder.name) void run(api.updateFolder(folder.id, { name }))
  }

  return (
    <div
      onDragOver={(e) => {
        if (!draggedChat(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG)
        setOver(false)
        if (!id) return
        e.preventDefault()
        e.stopPropagation()
        void run(api.updateChat(id, { folderId: folder.id }))
      }}
      className={cn('rounded-[10px] transition-shadow', over && 'shadow-[inset_0_0_0_1.5px_var(--link)]')}
    >
      <div onMouseLeave={() => setMenu(false)} className="group/folder flex h-7 items-center gap-1 rounded-[8px] pr-1 pl-1 transition-colors hover:bg-hover">
        <button onClick={() => !renaming && void run(api.updateFolder(folder.id, { collapsed: open }))} className="flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRight className={cn('size-3.5 shrink-0 text-ink-4 transition-transform duration-200', open && 'rotate-90')} />
          {renaming ? (
            <input
              autoFocus
              defaultValue={folder.name}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => save(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save(e.currentTarget.value)
                if (e.key === 'Escape') setRenaming(null)
              }}
              className="selectable min-w-0 flex-1 rounded-[5px] bg-surface px-1 text-[12.5px] font-medium shadow-[0_0_0_1.5px_var(--link)] outline-none"
            />
          ) : (
            <>
              <span className="min-w-0 truncate text-[12.5px] font-medium text-ink-2 group-hover/folder:text-ink">{folder.name}</span>
              {folder.instructions && (
                <Tip label="Has instructions every agent here follows" side="top">
                  <ScrollText className="size-3 shrink-0 text-ink-4" />
                </Tip>
              )}
              <span className="tabular shrink-0 text-[11px] text-ink-4">{chats.length || ''}</span>
            </>
          )}
        </button>
        {!renaming && (
          <>
            {waiting && <span className="mr-1 size-[7px] shrink-0 animate-pulse-soft rounded-full bg-warn" title="Needs your OK" />}
            {working.length > 0 && (
              <span className={cn('mr-1 shrink-0', menu ? 'hidden' : 'group-hover/folder:hidden')}>
                <OrbStack accounts={working.map((a) => ({ ...a, live: true }))} size={12} max={3} />
              </span>
            )}
            <span className={cn('shrink-0 items-center', menu ? 'flex' : 'hidden group-hover/folder:flex')}>
              <Tip label={`New chat in ${folder.name}`} side="top">
                <button aria-label={`New chat in ${folder.name}`} onClick={() => newChat(folder.id)} className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 hover:bg-active hover:text-ink">
                  <Plus className="size-3.5" />
                </button>
              </Tip>
              <Menu
                align="start"
                trigger={
                  <button aria-label="Folder options" onClick={() => setMenu(true)} className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 hover:bg-active hover:text-ink">
                    <Ellipsis className="size-4" />
                  </button>
                }
              >
                <MenuItem icon={<SquarePen className="size-3.5" />} onSelect={() => newChat(folder.id)}>
                  New chat here
                </MenuItem>
                <MenuItem icon={<ScrollText className="size-3.5" />} hint={folder.instructions ? 'Every agent here follows them' : 'Tell every agent here what to know or keep to'} onSelect={() => setModal({ kind: 'folder', id: folder.id })}>
                  {folder.instructions ? 'Edit instructions…' : 'Add instructions…'}
                </MenuItem>
                <MenuItem icon={<Pencil className="size-3.5" />} onSelect={() => setRenaming(folder.id)}>
                  Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 className="size-3.5" />}
                  onSelect={() =>
                    setModal({
                      kind: 'confirm',
                      title: `Remove the folder "${folder.name}"?`,
                      body: chats.length ? `Its ${chats.length === 1 ? 'chat is' : `${chats.length} chats are`} kept and ${chats.length === 1 ? 'goes' : 'go'} back to the list below.` : 'It is empty, so nothing else changes.',
                      action: 'Remove folder',
                      run: () => void run(api.deleteFolder(folder.id)),
                    })
                  }
                >
                  Remove folder
                </MenuItem>
              </Menu>
            </span>
          </>
        )}
      </div>
      {open && (
        <div className="space-y-px pb-1 pl-2.5">
          {chats.map((c) => {
            const l = live.get(c.id)
            return <ChatRow key={c.id} chat={c} active={c.id === chatId} live={l?.live || NO_LIVE} waiting={!!l?.waiting} folders={folders} onNewFolder={onNewFolder} />
          })}
          {!chats.length && <div className="px-2.5 py-1.5 text-[11.5px] text-ink-4">Drop a chat here, or start one with +</div>}
        </div>
      )}
    </div>
  )
}

function ChatList() {
  const chats = useStore((s) => s.chats)
  const chatId = useStore((s) => s.chatId)
  const members = useStore((s) => s.members)
  const folders = useStore((s) => s.folders)
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const home = useStore((s) => s.env.home)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [overLoose, setOverLoose] = useState(false)

  // Changes only when who is busy in which chat changes, not on every move an agent makes.
  const live: Live = useLiveByChat()

  const { pinned, filed, days } = useMemo(() => {
    const known = new Set(folders.map((f) => f.id))
    const filed = new Map<string, Chat[]>()
    const days: { label: string; chats: Chat[] }[] = []
    const pinned: Chat[] = []
    for (const c of chats) {
      if (c.pinned) pinned.push(c)
      else if (c.folderId && known.has(c.folderId)) filed.set(c.folderId, [...(filed.get(c.folderId) || []), c])
      else {
        const label = dayBucket(c.updatedAt)
        const g = days.find((x) => x.label === label)
        if (g) g.chats.push(c)
        else days.push({ label, chats: [c] })
      }
    }
    return { pinned, filed, days }
  }, [chats, folders])

  const addFolder = async (chat?: Chat): Promise<void> => {
    // A folder made for a chat starts out named after the project that chat works in.
    const f = await run(api.createFolder(chat ? folderLabel(chat.cwd, home).replace(/^Home folder$/, 'New folder') : 'New folder'))
    if (!f) return
    if (chat) await run(api.updateChat(chat.id, { folderId: f.id }))
    setRenaming(f.id)
  }
  const onNewFolder = (chat: Chat): void => void addFolder(chat)

  const row = (c: Chat) => {
    const l = live.get(c.id)
    return <ChatRow key={c.id} chat={c} active={c.id === chatId} live={l?.live || NO_LIVE} waiting={!!l?.waiting} folders={folders} onNewFolder={onNewFolder} />
  }

  return (
    <div className="space-y-3 pb-3">
      {pinned.length > 0 && (
        <div>
          <div className="px-2.5 pb-1 text-[11px] font-medium text-ink-3">Pinned</div>
          <div className="space-y-px">{pinned.map(row)}</div>
        </div>
      )}

      <div>
        <div className="flex h-6 items-center justify-between pr-1 pl-2.5">
          <span className="text-[11px] font-medium text-ink-3">Folders</span>
          <span className="flex items-center">
            <IconButton label="Bring chats in from Claude Code" side="top" className="size-6" onClick={() => setModal({ kind: 'import' })}>
              <FolderInput className="size-3.5" />
            </IconButton>
            <IconButton label="New folder" side="top" className="size-6" onClick={() => void addFolder()}>
              <FolderPlus className="size-3.5" />
            </IconButton>
          </span>
        </div>
        {folders.length > 0 ? (
          <div className="mt-0.5 space-y-px">
            {folders.map((f) => (
              <FolderSection key={f.id} folder={f} chats={filed.get(f.id) || []} chatId={chatId} live={live} folders={folders} renaming={renaming === f.id} setRenaming={setRenaming} onNewFolder={onNewFolder} />
            ))}
          </div>
        ) : (
          <div className="px-2.5 pt-0.5 text-[11.5px] leading-relaxed text-ink-4">Group chats by project. Make a folder, or bring your sections in from Claude Code.</div>
        )}
      </div>

      {/* Dropping a chat here takes it out of its folder. */}
      <div
        onDragOver={(e) => {
          if (!draggedChat(e)) return
          e.preventDefault()
          setOverLoose(true)
        }}
        onDragLeave={() => setOverLoose(false)}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(DRAG)
          setOverLoose(false)
          if (id) void run(api.updateChat(id, { folderId: null }))
        }}
        className={cn('space-y-3 rounded-[10px] transition-shadow', overLoose && 'shadow-[inset_0_0_0_1.5px_var(--line-2)]')}
      >
        {days.map((g) => (
          <div key={g.label}>
            <div className="px-2.5 pb-1 text-[11px] font-medium text-ink-3">{g.label}</div>
            <div className="space-y-px">{g.chats.map(row)}</div>
          </div>
        ))}
        {!chats.length && <div className="px-3 pt-4 text-center text-[12.5px] leading-relaxed text-ink-3">Your chats will appear here.</div>}
      </div>
    </div>
  )
}

/** A newer version, downloading or ready. It installs by itself when Ensemble next closes; this restarts sooner. */
function UpdatePill() {
  const update = useStore((s) => s.update)
  const { working } = useWorkSummary()
  const setModal = useStore((s) => s.setModal)
  if (!update) return null
  if (update.state === 'downloading') {
    return <div className="mt-1.5 flex h-7 items-center gap-2 rounded-[9px] px-3 text-[11.5px] text-ink-3"><Download className="size-3.5 shrink-0" /> Downloading version {update.version}…</div>
  }
  const install = (): void => void api.installUpdate()
  return (
    <button
      onClick={() =>
        working
          ? setModal({
              kind: 'confirm',
              title: `Restart to update to ${update.version}?`,
              body: `${working} ${working === 1 ? 'agent is' : 'agents are'} working and would be stopped; Ensemble offers to pick up where they left off. Or leave it: the update installs by itself the next time you close Ensemble.`,
              action: 'Restart now',
              run: install,
            })
          : install()
      }
      className="mt-1.5 flex h-8 w-full items-center gap-2.5 rounded-[10px] bg-ok-soft px-3 text-left text-[12.5px] font-medium text-ok transition-colors hover:brightness-95"
    >
      <Download className="size-[15px] shrink-0" />
      <span className="min-w-0 flex-1 truncate">Version {update.version} is ready</span>
      <span className="shrink-0 text-[11px] font-normal">Restart</span>
    </button>
  )
}

/** Opens mission control, and says at a glance how much is going on across every chat. */
function NowButton() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const { working, chats, waiting } = useWorkSummary()
  const on = view === 'now'
  return (
    <button
      onClick={() => setView(on ? 'chat' : 'now')}
      className={cn('no-drag mt-1.5 flex h-8 w-full items-center gap-2.5 rounded-[10px] px-3 text-[12.5px] transition-colors', on ? 'bg-active text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink')}
    >
      <Activity className={cn('size-[15px] shrink-0', working > 0 && 'text-ok')} strokeWidth={1.9} />
      <span className="min-w-0 flex-1 truncate text-left font-medium whitespace-nowrap">Mission control</span>
      {waiting && <span className="size-[7px] animate-pulse-soft rounded-full bg-warn" title="Something needs your OK" />}
      <span title={working ? `${working} working in ${chats} ${chats === 1 ? 'chat' : 'chats'}` : undefined} className={cn('tabular shrink-0 text-[11px] whitespace-nowrap', working ? 'text-ink-2' : 'text-ink-4')}>
        {working ? (chats > 1 ? `${working} in ${chats} chats` : `${working} working`) : 'All quiet'}
      </span>
    </button>
  )
}

function TeamDock() {
  const team = useAccounts()
  const leadId = useStore((s) => leadOf(s)?.id)
  const statuses = useStore((s) => s.statuses)
  const usage = useStore((s) => s.usage)
  // What each sign-in is doing; redraws only when that changes.
  const work = useWorkByAccount()
  const smart = useStore((s) => s.settings.smartModels)
  const setModal = useStore((s) => s.setModal)
  const accounts = useStore((s) => s.accounts)
  const disabled = useMemo(() => accounts.filter((a) => !a.enabled), [accounts])
  // In the open chat, a lead that ran out may be covered by the teammate who took over.
  const cover = useStore((s) => s.chats.find((c) => c.id === s.chatId)?.cover)
  const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const row = (a: Account) => {
    const st = statuses[a.id]
    const u = usage[a.id]
    // Work done on this account's sign-in: its own, and that of agents started on it.
    const w = work[a.id]
    const working = w ? { phase: w.phase, activity: w.activity } : undefined
    const on = { length: w?.count || 0 }
    const out = st?.state === 'signed-out'
    const failed = st?.state === 'error'
    // Fine, running low, or out until a time; and who covers for it in this chat.
    const supply = supplyNow(u)
    const coveredBy = cover && cover.from === a.id ? accounts.find((x) => x.id === cover.to)?.name : undefined
    const state = supplyWords(supply, clock)
    const budget = budgetOf(u)
    const advice = smart && a.provider === 'claude' && !a.model ? adviseModel(budget, a.id === leadId ? 'lead' : 'worker') : null
    let sub: React.ReactNode
    if (!a.enabled) sub = 'Paused'
    else if (out) sub = <span className="text-warn">Signed out</span>
    else if (failed) sub = <span className="text-bad">Needs attention</span>
    else if (supply.state === 'out') sub = <span className="text-warn">{state}</span>
    else if (supply.state === 'low' && !working) sub = <span className="text-warn">{state}</span>
    else if (working) sub = <span className="shimmer-text">{supply.state === 'low' ? 'Running low · ' : ''}{working.phase === 'waiting' ? 'Needs your OK' : on.length > 1 ? `${on.length} agents working` : working.activity || 'Working'}</span>
    else if (st?.state === 'checking' || !st) sub = 'Checking…'
    else sub = a.role?.trim() || (a.provider === 'chatgpt' ? st.plan || 'ChatGPT' : `Claude${st.plan ? ` · ${st.plan}` : ''}`)
    const line = (label: string, w: WindowBudget | undefined) =>
      w && (
        <span className="flex items-baseline justify-between gap-4">
          <span>{label}</span>
          <span className="opacity-80">
            {Math.round(w.left * 100)}% left{w.hours !== null ? ` · refills in ${hoursLabel(w.hours)}` : ''} · {paceWord(w.pace)}
          </span>
        </span>
      )
    return (
      <button
        key={a.id}
        onClick={() => setModal({ kind: 'account', id: a.id })}
        style={accentVars(a.accent)}
        className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <Orb account={a} size={22} phase={working?.phase} off={out || failed || !a.enabled} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium">{a.name}</span>
            {a.id === leadId && <span className="text-[11px] text-ink-3">Lead</span>}
            {coveredBy && <span className="truncate text-[11px] text-ink-3">covered by {coveredBy}</span>}
          </span>
          <span className="block truncate text-[11.5px] leading-[15px] text-ink-3">{sub}</span>
        </span>
        {a.enabled && !out && (budget.session || budget.weekly) && (
          <Tip
            side="right"
            label={
              <span className="tabular block min-w-[250px] space-y-0.5 py-0.5 text-left leading-relaxed">
                {line('This session', budget.session)}
                {line('This week', budget.weekly)}
                {budget.top && line(budget.top.label, budget.top)}
                {advice && <span className="mt-1 block border-t border-white/15 pt-1 font-normal whitespace-normal opacity-80">{advice.why}.</span>}
              </span>
            }
          >
            <span>
              <BudgetMeter budget={budget} />
            </span>
          </Tip>
        )}
      </button>
    )
  }

  return (
    <div className="px-2 pt-2.5">
      <div className="flex h-6 items-center justify-between pr-1 pl-2.5">
        <span className="text-[11px] font-medium text-ink-3">Team</span>
        <IconButton label="Add an account" side="right" className="size-6" onClick={() => setModal({ kind: 'add-account' })}>
          <Plus className="size-3.5" />
        </IconButton>
      </div>
      <div className="mt-0.5 space-y-px">
        {team.map(row)}
        {disabled.map(row)}
        {!team.length && !disabled.length && (
          <button onClick={() => setModal({ kind: 'add-account' })} className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[12.5px] text-ink-2 hover:bg-hover">
            <span className="flex size-[22px] items-center justify-center rounded-full border border-dashed border-ink-4">
              <Plus className="size-3" />
            </span>
            Add your first account
          </button>
        )}
      </div>
    </div>
  )
}

export function Sidebar() {
  const collapsed = useStore((s) => s.settings.sidebarCollapsed)
  const newChat = useStore((s) => s.newChat)
  const setModal = useStore((s) => s.setModal)
  const setView = useStore((s) => s.setView)
  const view = useStore((s) => s.view)

  return (
    <aside
      className={cn('flex h-full shrink-0 flex-col overflow-hidden transition-[width,opacity] duration-300 ease-out', collapsed ? 'w-0 opacity-0' : 'w-[268px] opacity-100')}
      aria-hidden={collapsed}
    >
      <div className="flex w-[268px] flex-1 flex-col overflow-hidden">
        <div className="drag flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
          <Logo size={19} />
          <span className="flex-1 text-[13.5px] font-semibold tracking-[-0.01em]">Ensemble</span>
          <IconButton label="Search" kbd="Ctrl K" onClick={() => setModal({ kind: 'palette' })}>
            <Search className="size-[15px]" />
          </IconButton>
          <IconButton label="Hide sidebar" kbd="Ctrl B" onClick={() => void api.updateSettings({ sidebarCollapsed: true })}>
            <PanelLeft className="size-[15px]" />
          </IconButton>
        </div>

        <div className="px-2 pt-1 pb-2.5">
          <button
            onClick={() => newChat()}
            className="no-drag flex h-9 w-full items-center gap-2.5 rounded-[10px] bg-glass px-3 text-[13px] font-medium shadow-card transition-all duration-150 hover:bg-surface active:scale-[0.99]"
          >
            <SquarePen className="size-[15px] text-ink-2" />
            <span className="flex-1 text-left">New chat</span>
            <Kbd className="bg-transparent">Ctrl N</Kbd>
          </button>
          <NowButton />
          <UpdatePill />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <ChatList />
        </div>

        <div className="shrink-0 border-t border-line">
          <TeamDock />
          <div className="flex gap-1 px-2 pt-1.5 pb-2">
            <button
              onClick={() => setView(view === 'memory' ? 'chat' : 'memory')}
              className={cn(
                'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[9px] px-2 text-[12.5px] transition-colors',
                view === 'memory' ? 'bg-active text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
              )}
            >
              <BookOpen className="size-[15px]" />
              Knowledge
            </button>
            <button
              onClick={() => setView(view === 'library' ? 'chat' : 'library')}
              className={cn(
                'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[9px] px-2 text-[12.5px] transition-colors',
                view === 'library' ? 'bg-active text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
              )}
            >
              <Images className="size-[15px]" />
              Library
            </button>
            <Tip label="Connectors: GitHub, databases, search and more" side="top">
              <button
                aria-label="Connectors"
                onClick={() => setModal({ kind: 'connectors' })}
                className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
              >
                <Plug className="size-[15px]" />
              </button>
            </Tip>
            <Tip label="Settings" kbd="Ctrl ," side="top">
              <button
                aria-label="Settings"
                onClick={() => setModal({ kind: 'settings' })}
                className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
              >
                <Settings2 className="size-[15px]" />
              </button>
            </Tip>
          </div>
        </div>
      </div>
    </aside>
  )
}
