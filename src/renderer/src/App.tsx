import { useEffect } from 'react'
import { Tooltip } from 'radix-ui'
import { isGlobalView, useStore } from './store'
import { api, cn } from './lib/util'
import { NowView } from './components/NowView'
import { ImportDialog } from './components/ImportDialog'
import { FolderDialog } from './components/FolderDialog'
import { ConnectorsDialog } from './components/ConnectorsDialog'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { ChatView } from './components/chat/ChatView'
import { TeamView } from './components/TeamView'
import { TeamFlow } from './components/TeamFlow'
import { KnowledgeView } from './components/KnowledgeView'
import { LiveView } from './components/screen/LiveView'
import { LibraryView } from './components/LibraryView'
import { DiffDialog, TaskDialog } from './components/Inspector'
import { AccountSheet, AddAccountDialog } from './components/Accounts'
import { ConfirmDialog, Palette, SettingsDialog, ShortcutsDialog, Toasts } from './components/Dialogs'
import { Onboarding } from './components/Onboarding'
import { Viewer } from './components/Viewer'

export function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const dark = useStore((s) => s.dark)
  const mica = useStore((s) => s.env.mica)
  const onboarded = useStore((s) => s.settings.onboarded)
  const view = useStore((s) => s.view)
  const chatId = useStore((s) => s.chatId)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  useEffect(() => {
    document.documentElement.classList.toggle('mica', mica)
  }, [mica])

  // Whether this is the window in use. The few things that have to be painted again and
  // again to look alive rest while it is not, so a team at work behind a game costs little.
  useEffect(() => {
    const mark = (): void => {
      document.documentElement.dataset.away = String(document.hidden || !document.hasFocus())
    }
    mark()
    window.addEventListener('focus', mark)
    window.addEventListener('blur', mark)
    document.addEventListener('visibilitychange', mark)
    return () => {
      window.removeEventListener('focus', mark)
      window.removeEventListener('blur', mark)
      document.removeEventListener('visibilitychange', mark)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return
      const s = useStore.getState()
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        s.setModal(s.modal?.kind === 'palette' ? null : { kind: 'palette' })
      } else if (k === 'n') {
        e.preventDefault()
        s.newChat()
      } else if (k === 'b') {
        e.preventDefault()
        void api.updateSettings({ sidebarCollapsed: !s.settings.sidebarCollapsed })
      } else if (k === 'i' && !e.shiftKey) {
        e.preventDefault()
        s.toggleInspector()
      } else if (k === ',') {
        e.preventDefault()
        s.setModal({ kind: 'settings' })
      } else if (k === '/') {
        e.preventDefault()
        s.setModal({ kind: 'shortcuts' })
      } else if (k === '0') {
        // Mission control: every chat that is being worked on, at once.
        e.preventDefault()
        s.setView(s.view === 'now' ? 'chat' : 'now')
      } else if (s.chatId && (k === '1' || k === '2' || k === '3' || k === '4')) {
        e.preventDefault()
        s.setView(k === '1' ? 'chat' : k === '2' ? 'flow' : k === '3' ? 'team' : 'live')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) return <div className="drag h-full" />

  const effectiveView = isGlobalView(view) || chatId ? view : 'chat'

  return (
    <Tooltip.Provider delayDuration={450} skipDelayDuration={200}>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TitleBar />
          <main className={cn('relative min-h-0 flex-1 overflow-hidden bg-surface shadow-panel', 'mr-1.5 mb-1.5 rounded-[12px]')}>
            <div key={effectiveView} className="h-full animate-fade-in">
              {effectiveView === 'chat' && <ChatView />}
              {effectiveView === 'flow' && <TeamFlow />}
              {effectiveView === 'team' && <TeamView />}
              {effectiveView === 'live' && <LiveView />}
              {effectiveView === 'memory' && <KnowledgeView />}
              {effectiveView === 'library' && <LibraryView />}
              {effectiveView === 'now' && <NowView />}
            </div>
          </main>
        </div>
      </div>
      {!onboarded && <Onboarding />}
      <AddAccountDialog />
      <AccountSheet />
      <SettingsDialog />
      <ShortcutsDialog />
      <ImportDialog />
      <FolderDialog />
      <ConnectorsDialog />
      <TaskDialog />
      <DiffDialog />
      <ConfirmDialog />
      <Palette />
      <Viewer />
      <Toasts />
    </Tooltip.Provider>
  )
}
