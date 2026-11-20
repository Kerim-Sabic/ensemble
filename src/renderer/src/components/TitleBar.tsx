import { useState } from 'react'
import { ChevronDown, Download, Ellipsis, FolderOpen, FolderSymlink, GitBranch, Link2, PanelLeft, Pin, PinOff, ShieldCheck, Square, SquarePen, Trash2 } from 'lucide-react'
import { useStore, useTeam, workingIn, type View } from '@/store'
import { api, cn, folderLabel, PERMISSIONS, permissionLabel, tildify } from '@/lib/util'
import { IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Segmented, Tip } from './ui'
import { DemoBar } from './DemoBar'
import { RoomsDialogs, SharedBadge, openShare } from './rooms/Rooms'

export function TitleBar() {
  const collapsed = useStore((s) => s.settings.sidebarCollapsed)
  const chat = useStore((s) => s.chats.find((c) => c.id === s.chatId))
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const newChat = useStore((s) => s.newChat)
  const run = useStore((s) => s.run)
  const home = useStore((s) => s.env.home)
  const defaultPermission = useStore((s) => s.settings.defaultPermission)
  const branch = useStore((s) => (s.chatId ? s.changes[s.chatId]?.branch : undefined))
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const working = useStore((s) => workingIn(s, s.chatId))
  const onScreen = useStore((s) => (s.chatId ? Object.values(s.screens).filter((sc) => sc.chatId === s.chatId && sc.active).length : 0))
  const hands = useStore((s) => s.env.canBrowse || s.env.canControl)
  const inChat = view === 'chat' || view === 'flow' || view === 'team' || view === 'live'
  const agentCount = chat?.agents?.filter((a) => !a.spawned?.gone).length || 0
  // The same count as the strip, the network and the Inspector: everyone in the chat who has not been
  // sent home, accounts included. Shown once the lead has started agents, when the team is more than usual.
  const teamSize = useTeam().length
  const [renaming, setRenaming] = useState(false)

  const permission = chat?.permission || defaultPermission
  const setPermission = (p: typeof permission): void => {
    if (chat) void run(api.updateChat(chat.id, { permission: p }))
    else void run(api.updateSettings({ defaultPermission: p }))
  }

  return (
    <>
    <DemoBar />
    <RoomsDialogs />
    <header className="drag flex h-11 shrink-0 items-center gap-2 pr-[146px] pl-2">
      {collapsed && (
        <div className="flex items-center gap-0.5">
          <IconButton label="Show sidebar" kbd="Ctrl B" onClick={() => void api.updateSettings({ sidebarCollapsed: false })}>
            <PanelLeft className="size-[15px]" />
          </IconButton>
          <IconButton label="New chat" kbd="Ctrl N" onClick={() => newChat()}>
            <SquarePen className="size-[15px]" />
          </IconButton>
        </div>
      )}

      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5">
        {view === 'memory' || view === 'library' || view === 'now' ? (
          <span className="pl-1.5 text-[13px] font-semibold">{view === 'memory' ? 'Knowledge' : view === 'library' ? 'Library' : 'Mission control'}</span>
        ) : chat ? (
          <>
            {renaming ? (
              <input
                autoFocus
                defaultValue={chat.title}
                onBlur={(e) => {
                  setRenaming(false)
                  const t = e.target.value.trim()
                  if (t && t !== chat.title) void run(api.updateChat(chat.id, { title: t }))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setRenaming(false)
                }}
                className="no-drag selectable h-7 w-[280px] max-w-full rounded-[7px] bg-surface px-2 text-[13px] font-semibold shadow-[0_0_0_1.5px_var(--link)] outline-none"
              />
            ) : (
              <Tip label="Rename">
                <button onClick={() => setRenaming(true)} className="no-drag max-w-[38%] truncate rounded-[7px] px-1.5 py-1 text-[13px] font-semibold hover:bg-hover">
                  {chat.title}
                </button>
              </Tip>
            )}
            <SharedBadge chat={chat} />
            <Menu
              trigger={
                <button className="no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-[7px] px-1.5 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink">
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="truncate">{folderLabel(chat.cwd, home)}</span>
                </button>
              }
              width={260}
            >
              <MenuLabel>{tildify(chat.cwd, home)}</MenuLabel>
              {branch && (
                <MenuItem icon={<GitBranch className="size-3.5" />} disabled>
                  On branch {branch}
                </MenuItem>
              )}
              <MenuItem icon={<FolderOpen className="size-3.5" />} onSelect={() => void api.openPath(chat.cwd)}>
                Open in File Explorer
              </MenuItem>
              <MenuItem
                icon={<FolderSymlink className="size-3.5" />}
                hint="The team starts fresh in the new folder."
                onSelect={async () => {
                  const p = await api.pickFolder()
                  if (p) void run(api.updateChat(chat.id, { cwd: p }))
                }}
              >
                Work in a different folder…
              </MenuItem>
            </Menu>
            <Menu
              width={220}
              trigger={
                <button aria-label="Chat options" className="no-drag flex size-7 shrink-0 items-center justify-center rounded-[7px] text-ink-3 hover:bg-hover hover:text-ink">
                  <Ellipsis className="size-4" />
                </button>
              }
            >
              <MenuItem icon={chat.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />} onSelect={() => void run(api.updateChat(chat.id, { pinned: !chat.pinned }))}>
                {chat.pinned ? 'Unpin' : 'Pin to top'}
              </MenuItem>
              <MenuItem
                icon={<Download className="size-3.5" />}
                onSelect={() => void run(api.exportChat(chat.id)).then((p) => p && toast('Saved the chat as a document.'))}
              >
                Save as a document…
              </MenuItem>
              <MenuItem icon={<Link2 className="size-3.5" />} onSelect={() => openShare(chat.id)}>
                {chat.shared ? 'Shared project…' : 'Share this project…'}
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
                Delete chat
              </MenuItem>
            </Menu>
          </>
        ) : (
          <span className="pl-1.5 text-[13px] font-semibold">New chat</span>
        )}
      </div>

      {chat && inChat && working >= 1 && (
        <Tip label={working === 1 ? 'Stop the work in this chat' : `Stop all ${working} at work in this chat`}>
          <button
            onClick={() => void run(api.stop(chat.id))}
            className="no-drag flex h-7 animate-fade-in items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          >
            <Square className="size-2.5 fill-current" strokeWidth={0} />
            Stop all
          </button>
        </Tip>
      )}

      {chat && inChat && (
        <Segmented<View>
          value={view}
          onChange={setView}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'flow', label: 'Team', badge: agentCount ? teamSize : undefined },
            { value: 'team', label: 'Side by side' },
            ...(hands
              ? [
                  {
                    value: 'live' as View,
                    label: (
                      <>
                        {onScreen > 0 && <span className="size-1.5 animate-pulse-soft rounded-full bg-bad" />}
                        Live
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}

      {inChat && (
        <Menu
          align="end"
          width={300}
          trigger={
            <button
              className={cn(
                'no-drag flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] font-medium transition-colors hover:bg-hover',
                permission === 'full' ? 'text-warn' : 'text-ink-2 hover:text-ink',
              )}
            >
              <ShieldCheck className="size-3.5" />
              {permissionLabel(permission)}
              <ChevronDown className="size-3 opacity-60" />
            </button>
          }
        >
          <MenuLabel>How much the team can do on its own</MenuLabel>
          {PERMISSIONS.map((p) => (
            <MenuItem key={p.value} checked={p.value === permission} hint={p.hint} onSelect={() => setPermission(p.value)}>
              {p.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </header>
    </>
  )
}
