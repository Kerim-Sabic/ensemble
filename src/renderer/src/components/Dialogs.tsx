import { useEffect, useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { Dialog } from 'radix-ui'
import { Activity, Plug, BookOpen, Check, CircleAlert, Download, FolderInput, Images, Info, Keyboard, LayoutGrid, MessageSquare, Moon, MousePointerClick, PanelRight, Search, Settings2, SquarePen, Sun, UserPlus, Waypoints, X } from 'lucide-react'
import type { AccountCandidate, ModelRecord, PermissionLevel, SearchHit, Settings, VaultInfo } from '@shared/types'
import { leadOf, useStore } from '@/store'
import { api, baseName, cn, PERMISSIONS, relative, tildify } from '@/lib/util'
import { Button, Kbd, Modal, Row, Segmented, Spinner, Toggle, inputClass } from './ui'
import { Orb } from './Orb'
import { Logo } from './Sidebar'
import { Picker } from './Accounts'

/** Which folder of notes the team treats as its library. */
function VaultPicker() {
  const vault = useStore((s) => s.vault)
  const path = useStore((s) => s.settings.vaultPath)
  const home = useStore((s) => s.env.home)
  const run = useStore((s) => s.run)
  const [found, setFound] = useState<VaultInfo[]>([])
  useEffect(() => {
    void api.vaultList().then(setFound, () => undefined)
  }, [path])
  const options = [
    ...found.map((v) => ({ value: v.path, label: v.name, hint: tildify(v.path, home) })),
    { value: '__pick', label: 'Choose a folder…', hint: 'Any folder of Markdown notes works' },
    { value: '__new', label: 'Make a vault for Ensemble', hint: 'A new folder in Documents that Obsidian can open' },
    ...(path ? [{ value: '__none', label: 'No vault', hint: 'The team keeps only its own notebook' }] : []),
  ]
  const choose = async (v: string): Promise<void> => {
    if (v === '__none') await run(api.updateSettings({ vaultPath: null }))
    else if (v === '__new') await run(api.createVault())
    else if (v === '__pick') {
      const picked = await api.pickFolder()
      if (picked) await run(api.updateSettings({ vaultPath: picked }))
    } else await run(api.updateSettings({ vaultPath: v }))
  }
  return <Picker value={vault?.path || null} options={options} width={300} placeholder={path ? 'Folder not found' : 'None'} onChange={(v) => void choose(v)} />
}

/** What the team has learned about which models are good enough, with a way to start over. */
function LearnedRow() {
  const open = useStore((s) => s.modal?.kind === 'settings')
  const run = useStore((s) => s.run)
  const [list, setList] = useState<ModelRecord[]>([])
  useEffect(() => {
    if (open) void api.learning().then(setList, () => undefined)
  }, [open])
  const rows = list.filter((r) => r.done + r.failed + r.enough + r.weak + r.more > 0)
  return (
    <div className="py-3">
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">What it has learned</div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-3">After each task, whoever handed it out says whether the model was right for it. A model that keeps falling short stops getting that work; one that is always more than enough is swapped for a cheaper one.</div>
        </div>
        {rows.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run(api.resetLearning()).then(() => setList([]))}
          >
            Start over
          </Button>
        )}
      </div>
      {rows.length ? (
        <div className="mt-2.5 divide-y divide-line rounded-[11px] px-3 shadow-[inset_0_0_0_1px_var(--line)]">
          {rows.map((r) => {
            const votes = r.enough + r.weak + r.more
            return (
              <div key={r.family} className="flex items-center gap-3 py-2 text-[12.5px]">
                <span className="w-16 shrink-0 font-medium">{r.family}</span>
                <span className="tabular min-w-0 flex-1 text-ink-3">
                  finished {r.done} of {r.done + r.failed}
                  {votes ? ` · ${r.enough} right, ${r.weak} too weak, ${r.more} more than needed` : ''}
                  {Object.entries(r.kinds || {}).length > 0 && (
                    <span className="mt-0.5 block text-[11px] text-ink-4">
                      {Object.entries(r.kinds || {})
                        .map(([k, v]) => `${k}: ${v.enough} right${v.weak ? `, ${v.weak} too weak` : ''}${v.more ? `, ${v.more} more than needed` : ''}`)
                        .join(' · ')}
                    </span>
                  )}
                </span>
                {votes > 0 && (
                  <span className="flex h-[5px] w-16 shrink-0 overflow-hidden rounded-full bg-line">
                    <span className="h-full bg-ok" style={{ width: `${(r.enough / votes) * 100}%` }} />
                    <span className="h-full bg-bad" style={{ width: `${(r.weak / votes) * 100}%` }} />
                    <span className="h-full bg-warn" style={{ width: `${(r.more / votes) * 100}%` }} />
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-ink-4">Nothing yet. It fills in as the team finishes tasks.</div>
      )}
    </div>
  )
}

/** The sites the team's browser holds sign-ins for, each with a way to sign out of it. */
function SignedInSites() {
  const open = useStore((s) => s.modal?.kind === 'settings')
  const run = useStore((s) => s.run)
  const [sites, setSites] = useState<{ site: string; cookies: number }[] | null>(null)
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (open) void api.browserSites().then(setSites, () => setSites([]))
  }, [open])
  if (!sites) return null
  const shown = all ? sites : sites.slice(0, 8)
  return (
    <div className="border-t border-line py-3">
      <div className="text-[13px] font-medium">Sites the team is signed in to</div>
      <div className="mt-0.5 text-[12px] leading-snug text-ink-3">
        Every teammate's browser shares these sign-ins. Sign in ahead of time from the Live view, or when an agent asks. Forgetting a site signs the team out of it.
      </div>
      {sites.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {shown.map((s) => (
            <span key={s.site} className="flex h-7 items-center gap-1.5 rounded-full bg-surface-2 pr-1 pl-3 text-[12px] shadow-[inset_0_0_0_1px_var(--line)]">
              {s.site}
              <button
                aria-label={`Forget ${s.site}`}
                title="Sign the team out of this site"
                onClick={() => void run(api.browserForget(s.site)).then(() => setSites((l) => (l || []).filter((x) => x.site !== s.site)))}
                className="flex size-5 items-center justify-center rounded-full text-ink-3 hover:bg-active hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {sites.length > 8 && (
            <button onClick={() => setAll((a) => !a)} className="h-7 px-2 text-[12px] font-medium text-ink-3 hover:text-ink">
              {all ? 'Fewer' : `${sites.length - 8} more`}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-ink-4">None yet.</div>
      )}
    </div>
  )
}

export function SettingsDialog() {
  const open = useStore((s) => s.modal?.kind === 'settings')
  const vault = useStore((s) => s.vault)
  const settings = useStore((s) => s.settings)
  const accounts = useStore((s) => s.accounts)
  const lead = useStore((s) => leadOf(s))
  const env = useStore((s) => s.env)
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const set = (patch: Partial<Settings>): void => void run(api.updateSettings(patch))

  return (
    <Modal open={open} onClose={() => setModal(null)} title="Settings" width={540}>
      <div className="overflow-y-auto px-6 pt-2 pb-6">
        <div className="divide-y divide-line">
          <Row label="Appearance">
            <Segmented<Settings['theme']>
              value={settings.theme}
              onChange={(theme) => set({ theme })}
              options={[
                { value: 'system', label: 'Auto' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Row>
          <Row label="Team lead" hint="Who you talk to by default. The lead plans and hands work to the others.">
            <Picker value={lead?.id || null} options={accounts.filter((a) => a.enabled).map((a) => ({ value: a.id, label: a.name }))} onChange={(leadId) => set({ leadId })} placeholder="Nobody yet" />
          </Row>
          <Row label="New chats start with" hint="How much the team may do without checking with you.">
            <Picker<PermissionLevel> value={settings.defaultPermission} width={300} options={PERMISSIONS.map((p) => ({ value: p.value, label: p.label, hint: p.hint }))} onChange={(defaultPermission) => set({ defaultPermission })} />
          </Row>
          <Row label="Default folder" hint={settings.defaultCwd ? tildify(settings.defaultCwd, env.home) : 'New chats start in the folder you used last.'}>
            {settings.defaultCwd && (
              <Button size="sm" variant="ghost" onClick={() => set({ defaultCwd: null })}>
                Clear
              </Button>
            )}
            <Button
              size="sm"
              onClick={async () => {
                const p = await api.pickFolder()
                if (p) set({ defaultCwd: p })
              }}
            >
              Choose…
            </Button>
          </Row>
          <Row label="Name chats automatically" hint="A quick, tiny request to the lead account writes a short title.">
            <Toggle checked={settings.smartTitles} onChange={(smartTitles) => set({ smartTitles })} label="Name chats automatically" />
          </Row>
          <Row label="Shared memory" hint="Let the team keep notes between chats.">
            <Toggle checked={settings.memoryEnabled} onChange={(memoryEnabled) => set({ memoryEnabled })} label="Shared memory" />
          </Row>
          <Row label="Keep team talk light" hint="Quick questions between teammates are answered on each one's lightest model, and notes and finished reports wait to be read together instead of waking someone each time. Saves allowance; the work itself is not affected.">
            <Toggle checked={settings.lightTalk} onChange={(lightTalk) => set({ lightTalk })} label="Keep team talk light" />
          </Row>
          <Row
            label="Choose models by allowance"
            hint="Each account runs the strongest model it can afford: the top model while there is allowance to spare before it refills, a step down when it is running short or the top model's own allowance is used up. An account with a model picked by hand keeps it."
          >
            <Toggle checked={settings.smartModels} onChange={(smartModels) => set({ smartModels })} label="Choose models by allowance" />
          </Row>
          <Row
            label="Saving allowance"
            hint={
              settings.economy === 'quality'
                ? 'Every agent runs the strongest model its allowance can afford. Best results, fastest use of allowance.'
                : settings.economy === 'saver'
                  ? 'The lead keeps the strongest model; agents it hands work to run the mid-sized model, and their sub-agents the smallest. Uses the least allowance.'
                  : 'The lead gets the strongest model; agents it hands work to run a step below, their sub-agents a step further. Ensemble adjusts the steps from what it learns.'
            }
          >
            <Segmented<Settings['economy']>
              value={settings.smartModels ? settings.economy : 'quality'}
              onChange={(economy) => set({ economy, smartModels: true })}
              options={[
                { value: 'saver', label: 'Save most' },
                { value: 'auto', label: 'Ensemble decides' },
                { value: 'quality', label: 'Best quality' },
              ]}
            />
          </Row>
          <Row label="Extra agents per chat" hint="The lead can start more agents inside a chat, and those can start sub-agents for parts of their work. They share the accounts' allowance.">
            <Picker<string>
              value={String(settings.maxAgents)}
              width={230}
              options={[
                { value: '-1', label: 'Ensemble decides', hint: 'More when accounts have allowance to spare, fewer when they are short' },
                { value: '0', label: 'None', hint: 'Only the accounts work' },
                { value: '4', label: 'Up to 4' },
                { value: '8', label: 'Up to 8' },
                { value: '12', label: 'Up to 12' },
                { value: '16', label: 'Up to 16', hint: 'Uses allowance quickly' },
              ]}
              onChange={(v) => set({ maxAgents: Number(v) })}
            />
          </Row>
          <Row label="Agents one agent may start" hint="Keeps any single agent from fanning out too far. Sub-agents never start agents of their own.">
            <Picker<string>
              value={String(settings.maxPerAgent)}
              width={170}
              options={['1', '2', '3', '4', '6', '8'].map((v) => ({ value: v, label: v === '1' ? '1 agent' : `${v} agents` }))}
              onChange={(v) => set({ maxPerAgent: Number(v) })}
            />
          </Row>
          <LearnedRow />
          <Row label="Suggest my next message" hint="After a reply, the lead offers a likely follow-up. Press Tab to take it.">
            <Toggle checked={settings.suggestions} onChange={(suggestions) => set({ suggestions })} label="Suggest my next message" />
          </Row>
          <Row label="Notifications" hint="Tell me when work finishes or needs my OK while I am in another window.">
            <Toggle checked={settings.notifications} onChange={(notifications) => set({ notifications })} label="Notifications" />
          </Row>
        </div>

        <div className="mt-5 mb-1 text-[12px] font-medium text-ink-3">Browser and computer</div>
        <div className="divide-y divide-line">
          <Row label="Give the team a browser" hint={env.canBrowse ? 'Each teammate gets a browser of its own for sites that need clicking, typing or signing in. You can watch it live and take the mouse.' : 'Not available in this build.'}>
            <Toggle checked={settings.browser && env.canBrowse} onChange={(browser) => set({ browser })} label="Give the team a browser" />
          </Row>
          <Row label="Let the team use this computer" hint={env.canControl ? 'Your real mouse, keyboard and screen. A notice stays up while a teammate is in control, and Esc stops it.' : 'Not available on this computer.'}>
            <Segmented<Settings['computer']>
              value={env.canControl ? settings.computer : 'off'}
              onChange={(computer) => env.canControl && set({ computer })}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'ask', label: 'Ask first' },
                { value: 'on', label: 'Always' },
              ]}
            />
          </Row>
        </div>

        {env.canBrowse && settings.browser && <SignedInSites />}

        <div className="mt-5 mb-1 text-[12px] font-medium text-ink-3">Knowledge</div>
        <div className="divide-y divide-line">
          <Row
            label="Vault"
            hint={vault ? `About ${vault.notes.toLocaleString()} notes. The team searches it before it works${vault.guide ? ` and follows the rules in ${vault.guide}` : ''}.` : 'A folder of notes, such as an Obsidian vault, that the team reads before it researches or builds.'}
          >
            <VaultPicker />
          </Row>
          <Row label="Recall from the vault" hint="Before the lead starts on a request, and before any task, the vault is searched and the notes that bear on it are put in front of the agent. Earlier work is found without anyone having to remember it.">
            <Toggle checked={!!vault && settings.recall} onChange={(recall) => vault && set({ recall })} label="Recall from the vault" />
          </Row>
          <Row label="Keep a note of every chat" hint="After the work goes quiet, each substantial chat gets a note under Ensemble/Chats: what was asked, where it ended, who did what, what was agreed and which files changed. Written from the record, so it costs no allowance.">
            <Toggle checked={!!vault && settings.chatNotes} onChange={(chatNotes) => vault && set({ chatNotes })} label="Keep a note of every chat" />
          </Row>
          <Row label="Write down what it learns" hint="After substantial work the team records research and decisions in the vault. When off, it writes there only when you ask.">
            <Toggle checked={!!vault && settings.vaultNotes === 'auto'} onChange={(on) => vault && set({ vaultNotes: on ? 'auto' : 'ask' })} label="Write down what it learns" />
          </Row>
        </div>

        <div className="mt-5 mb-1 text-[12px] font-medium text-ink-3">On this computer</div>
        <div className="divide-y divide-line">
          <Row label="Keep working when the window is closed" hint="Ensemble stays in the system tray so the team can finish. Quit from the tray icon.">
            <Toggle checked={settings.keepRunning} onChange={(keepRunning) => set({ keepRunning })} label="Keep working when the window is closed" />
          </Row>
          <Row label="Bring Ensemble up from anywhere" hint="Alt + Shift + Space shows the window, ready to type.">
            <Toggle checked={settings.globalHotkey} onChange={(globalHotkey) => set({ globalHotkey })} label="Bring Ensemble up from anywhere" />
          </Row>
          <Row label="Open when I sign in to Windows" hint="Starts with your computer.">
            <Toggle checked={settings.launchAtLogin} onChange={(launchAtLogin) => set({ launchAtLogin })} label="Open when I sign in to Windows" />
          </Row>
        </div>

        <div className="mt-4 flex items-center gap-2.5 text-[12px] text-ink-3">
          <Logo size={16} />
          Ensemble {env.version}
          {env.demo && <span className="rounded-full bg-warn-soft px-2 py-px text-warn">Demo mode</span>}
          <span className="flex-1" />
          <button onClick={() => setModal({ kind: 'shortcuts' })} className="flex items-center gap-1.5 font-medium hover:text-ink">
            <Keyboard className="size-3.5" /> Keyboard shortcuts
          </button>
        </div>
      </div>
    </Modal>
  )
}

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ['Ctrl', 'K'], what: 'Search chats and commands' },
  { keys: ['Ctrl', 'N'], what: 'New chat' },
  { keys: ['Ctrl', 'B'], what: 'Show or hide the sidebar' },
  { keys: ['Ctrl', 'I'], what: 'Show or hide the activity panel' },
  { keys: ['Ctrl', '1'], what: 'Chat' },
  { keys: ['Ctrl', '2'], what: 'Team: who is talking to whom' },
  { keys: ['Ctrl', '3'], what: 'Everyone side by side' },
  { keys: ['Ctrl', '4'], what: 'Live: watch the team work a screen' },
  { keys: ['Ctrl', '0'], what: 'Mission control: every chat being worked on' },
  { keys: ['←', '→'], what: 'Step through what was done on a screen' },
  { keys: ['Ctrl', ','], what: 'Settings' },
  { keys: ['Enter'], what: 'Send' },
  { keys: ['Shift', 'Enter'], what: 'New line' },
  { keys: ['Tab'], what: 'Take the suggested message' },
  { keys: ['Esc'], what: 'Stop the current reply' },
  { keys: ['@'], what: 'Message one teammate directly' },
  { keys: ['/'], what: 'Run a command the teammate knows' },
  { keys: ['Alt', 'Shift', 'Space'], what: 'Bring Ensemble up from anywhere' },
  { keys: ['Esc'], what: 'Anywhere on the computer: stop a teammate who has the mouse' },
]

export function ShortcutsDialog() {
  const open = useStore((s) => s.modal?.kind === 'shortcuts')
  const setModal = useStore((s) => s.setModal)
  return (
    <Modal open={open} onClose={() => setModal(null)} title="Keyboard shortcuts" width={440}>
      <div className="overflow-y-auto px-6 pt-2 pb-5">
        <div className="divide-y divide-line">
          {SHORTCUTS.map((s) => (
            <div key={s.what} className="flex items-center gap-4 py-2 text-[13px]">
              <span className="flex-1 text-ink-2">{s.what}</span>
              <span className="flex gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k} className="px-2 py-0.5 text-[11.5px]">
                    {k}
                  </Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

export function ConfirmDialog() {
  const modal = useStore((s) => (s.modal?.kind === 'confirm' ? s.modal : null))
  const setModal = useStore((s) => s.setModal)
  return (
    <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.title || ''} description={modal?.body} width={420}>
      <div className="flex justify-end gap-2 px-6 pt-4 pb-5">
        <Button variant="ghost" onClick={() => setModal(null)}>
          Cancel
        </Button>
        <Button
          autoFocus
          className="bg-bad text-white hover:opacity-90"
          onClick={() => {
            modal?.run()
            setModal(null)
          }}
        >
          {modal?.action}
        </Button>
      </div>
    </Modal>
  )
}

const itemClass =
  'flex h-10 cursor-default items-center gap-3 rounded-[10px] px-3 text-[13.5px] text-ink outline-none data-[selected=true]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3'

/** Ctrl+K: jump to any chat, search what was said, or run a command. */
export function Palette() {
  const open = useStore((s) => s.modal?.kind === 'palette')
  const setModal = useStore((s) => s.setModal)
  const chats = useStore((s) => s.chats)
  const accounts = useStore((s) => s.accounts)
  const members = useStore((s) => s.members)
  const dark = useStore((s) => s.dark)
  const home = useStore((s) => s.env.home)
  const openChat = useStore((s) => s.openChat)
  const newChat = useStore((s) => s.newChat)
  const setView = useStore((s) => s.setView)
  const chatId = useStore((s) => s.chatId)
  const toggleInspector = useStore((s) => s.toggleInspector)
  const toast = useStore((s) => s.toast)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const seq = useRef(0)

  useEffect(() => {
    if (open) return
    setQuery('')
    setHits([])
  }, [open])

  useEffect(() => {
    if (!open) return
    document.documentElement.dataset.modal = 'true'
    return () => {
      delete document.documentElement.dataset.modal
    }
  }, [open])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      return
    }
    const n = ++seq.current
    const t = setTimeout(() => {
      void api.searchChats(q).then((r) => n === seq.current && setHits(r.filter((h) => h.accountId)))
    }, 140)
    return () => clearTimeout(t)
  }, [query])

  const go = (fn: () => void) => (): void => {
    setModal(null)
    fn()
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => !o && setModal(null)}
      label="Search and commands"
      overlayClassName="fixed inset-0 z-50 animate-fade-in bg-black/22 backdrop-blur-[3px] dark:bg-black/50"
      contentClassName="no-drag fixed top-[14vh] left-1/2 z-[60] w-[600px] max-w-[92vw] -translate-x-1/2 animate-pop overflow-hidden rounded-[18px] bg-raised shadow-pop outline-none"
    >
      <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
      <Dialog.Description className="sr-only">Find a chat or run a command</Dialog.Description>
      <div className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <Search className="size-[17px] text-ink-3" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search chats or type a command"
          className="selectable h-full flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-3"
        />
      </div>
      <Command.List className="max-h-[52vh] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3">
        <Command.Empty className="px-3 py-8 text-center text-[13px] text-ink-3">Nothing matches that.</Command.Empty>

        <Command.Group heading="Go to">
          <Command.Item className={itemClass} value="new chat" onSelect={go(() => newChat())}>
            <SquarePen /> New chat
          </Command.Item>
          <Command.Item className={itemClass} value="mission control now working overview all chats dashboard" onSelect={go(() => setView('now'))}>
            <Activity /> Mission control: every chat being worked on
          </Command.Item>
          <Command.Item className={itemClass} value="connectors mcp github supabase stripe search integrations services tools" onSelect={() => setModal({ kind: 'connectors' })}>
            <Plug /> Connectors
          </Command.Item>
          <Command.Item className={itemClass} value="import claude code sections folders conversations bring in" onSelect={() => setModal({ kind: 'import' })}>
            <FolderInput /> Bring chats in from Claude Code
          </Command.Item>
          {chatId && (
            <>
              <Command.Item className={itemClass} value="team map flow communication who is talking to whom handoffs timeline" onSelect={go(() => setView('flow'))}>
                <Waypoints /> Team: see how they work together
              </Command.Item>
              <Command.Item className={itemClass} value="team view everyone side by side" onSelect={go(() => setView('team'))}>
                <LayoutGrid /> Everyone side by side
              </Command.Item>
              <Command.Item className={itemClass} value="live view watch screen browser computer replay" onSelect={go(() => setView('live'))}>
                <MousePointerClick /> Live: watch the team work a screen
              </Command.Item>
              <Command.Item className={itemClass} value="activity panel plan tasks changes files" onSelect={go(toggleInspector)}>
                <PanelRight /> Show or hide the activity panel
              </Command.Item>
              <Command.Item className={itemClass} value="save export chat document markdown" onSelect={go(() => void api.exportChat(chatId).then((p) => p && toast('Saved the chat as a document.')))}>
                <Download /> Save this chat as a document
              </Command.Item>
            </>
          )}
          <Command.Item className={itemClass} value="library pictures images gallery" onSelect={go(() => setView('library'))}>
            <Images /> Library
          </Command.Item>
          <Command.Item className={itemClass} value="knowledge vault notes memory notebook obsidian" onSelect={go(() => setView('memory'))}>
            <BookOpen /> Knowledge
          </Command.Item>
          <Command.Item className={itemClass} value="add account sign in" onSelect={() => setModal({ kind: 'add-account' })}>
            <UserPlus /> Add an account
          </Command.Item>
          <Command.Item className={itemClass} value="settings preferences" onSelect={() => setModal({ kind: 'settings' })}>
            <Settings2 /> Settings
          </Command.Item>
          <Command.Item className={itemClass} value="theme dark light appearance" onSelect={go(() => void api.updateSettings({ theme: dark ? 'light' : 'dark' }))}>
            {dark ? <Sun /> : <Moon />} Switch to {dark ? 'light' : 'dark'} appearance
          </Command.Item>
          <Command.Item className={itemClass} value="keyboard shortcuts keys help" onSelect={() => setModal({ kind: 'shortcuts' })}>
            <Keyboard /> Keyboard shortcuts
          </Command.Item>
        </Command.Group>

        {accounts.length > 0 && (
          <Command.Group heading="Team">
            {accounts.map((a) => (
              <Command.Item key={a.id} className={itemClass} value={`teammate ${a.name}`} onSelect={() => setModal({ kind: 'account', id: a.id })}>
                <Orb account={a} size={16} /> {a.name}
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {chats.length > 0 && (
          <Command.Group heading="Chats">
            {chats.slice(0, query ? 50 : 8).map((c) => (
              <Command.Item key={c.id} className={itemClass} value={`chat ${c.title} ${baseName(c.cwd)} ${c.id}`} onSelect={go(() => void openChat(c.id))}>
                <MessageSquare />
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-[12px] text-ink-3">
                  {tildify(c.cwd, home).split(/[\\/]/).slice(-1)[0]} · {relative(c.updatedAt)}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {hits.length > 0 && (
          <Command.Group heading="Mentioned in chats" forceMount>
            {hits.slice(0, 12).map((h, i) => {
              const a = h.accountId ? members[h.accountId] : undefined
              return (
                <Command.Item
                  key={`${h.chatId}-${i}`}
                  forceMount
                  className={cn(itemClass, 'h-auto items-start py-2')}
                  value={`hit ${i} ${h.snippet}`}
                  onSelect={go(() => void openChat(h.chatId, h.accountId))}
                >
                  <Orb account={a} size={16} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-ink-3">
                      {h.title} · {relative(h.ts)}
                    </span>
                    <span className="line-clamp-2 block text-[13px] leading-snug">{h.snippet}</span>
                  </span>
                </Command.Item>
              )
            })}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[90] flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="no-drag pointer-events-auto flex max-w-[480px] animate-pop items-start gap-2.5 rounded-[12px] bg-ink py-2.5 pr-2 pl-3.5 text-[13px] text-inverse shadow-pop">
          {t.level === 'error' ? <CircleAlert className="mt-px size-4 shrink-0 text-[#ff8b80]" /> : t.level === 'warn' ? <Info className="mt-px size-4 shrink-0 text-[#f2c063]" /> : <Check className="mt-px size-4 shrink-0 opacity-70" />}
          <span className="selectable min-w-0 flex-1 leading-snug">{t.text}</span>
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="flex size-5 shrink-0 items-center justify-center rounded-[5px] opacity-60 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** First run: find the accounts already on this computer and form the team. */
export function Onboarding() {
  const run = useStore((s) => s.run)
  const setModal = useStore((s) => s.setModal)
  const existing = useStore((s) => s.accounts)
  const [found, setFound] = useState<AccountCandidate[] | null>(null)
  const [picked, setPicked] = useState<Record<number, boolean>>({})
  const [names, setNames] = useState<Record<number, string>>({})
  const [lead, setLead] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.discoverAccounts().then(
      (list) => {
        setFound(list)
        setPicked(Object.fromEntries(list.map((c, i) => [i, c.signedIn])))
        const first = list.findIndex((c) => c.signedIn && c.provider === 'claude')
        setLead(first >= 0 ? first : null)
      },
      () => setFound([]),
    )
  }, [])

  const chosen = useMemo(() => (found || []).map((c, i) => ({ c, i })).filter((x) => picked[x.i] && x.c.signedIn), [found, picked])

  const start = async (): Promise<void> => {
    setBusy(true)
    let leadId: string | null = null
    for (const { c, i } of chosen) {
      const a = await run(api.addAccount({ name: names[i]?.trim() || c.suggestedName, provider: c.provider, configDir: c.configDir }))
      if (a && i === lead) leadId = a.id
    }
    await run(api.updateSettings({ onboarded: true, leadId }))
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-window">
      <div className="drag absolute inset-x-0 top-0 h-11" />
      <div className="w-[520px] max-w-[92vw] animate-rise py-10">
        <div className="flex flex-col items-center text-center">
          <Logo size={56} />
          <h1 className="mt-6 text-[30px] leading-tight font-semibold tracking-[-0.03em]">Welcome to Ensemble</h1>
          <p className="mt-2.5 max-w-[400px] text-[14.5px] leading-relaxed text-ink-2">Your AI accounts, working as one team. One leads, the others pitch in, and you talk to all of them from here.</p>
        </div>

        <div className="mt-9 rounded-[18px] bg-surface p-2 shadow-float">
          {found === null ? (
            <div className="flex items-center justify-center gap-2.5 py-10 text-[13px] text-ink-3">
              <Spinner /> Looking for accounts on this computer…
            </div>
          ) : found.length === 0 && existing.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <div className="text-[14px] font-medium">No signed-in accounts found yet</div>
              <p className="mt-1 text-[13px] text-ink-3">Sign in to your first account to begin.</p>
              <Button variant="primary" size="lg" className="mt-5" onClick={() => setModal({ kind: 'add-account' })}>
                Add an account
              </Button>
            </div>
          ) : (
            <>
              <div className="px-3 pt-2.5 pb-2 text-[12px] font-medium text-ink-3">Found on this computer</div>
              {found.map((c, i) => {
                const on = !!picked[i] && c.signedIn
                return (
                  <div key={`${c.provider}:${c.configDir}`} className={cn('flex items-center gap-3 rounded-[12px] px-3 py-2.5 transition-colors', c.signedIn ? 'hover:bg-hover' : 'opacity-55')}>
                    <button
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`Include ${c.suggestedName}`}
                      disabled={!c.signedIn}
                      onClick={() => setPicked((p) => ({ ...p, [i]: !p[i] }))}
                      className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors', on ? 'border-ink bg-ink text-inverse' : 'border-ink-4')}
                    >
                      {on && <Check className="size-3" strokeWidth={3} />}
                    </button>
                    <Orb account={{ accent: c.provider === 'chatgpt' ? 'green' : (['clay', 'violet', 'teal', 'blue', 'amber', 'rose'] as const)[i % 6] }} size={26} off={!c.signedIn} />
                    <div className="min-w-0 flex-1">
                      <input
                        value={names[i] ?? c.suggestedName}
                        disabled={!c.signedIn}
                        onChange={(e) => setNames((n) => ({ ...n, [i]: e.target.value }))}
                        aria-label="Name"
                        className="selectable -ml-1.5 w-full rounded-[6px] bg-transparent px-1.5 py-px text-[13.5px] font-medium outline-none hover:bg-active focus:bg-surface-2"
                      />
                      <div className="truncate text-[12px] text-ink-3">
                        {c.provider === 'claude' ? 'Claude' : 'ChatGPT'}
                        {c.plan ? ` · ${c.plan}` : ''}
                        {c.signedIn ? (c.email ? ` · ${c.email}` : '') : ' · signed out, add it later'}
                      </div>
                    </div>
                    {c.signedIn && c.provider === 'claude' && on && (
                      <button
                        onClick={() => setLead(i)}
                        className={cn(
                          'h-7 shrink-0 rounded-full px-3 text-[12px] font-medium transition-all',
                          lead === i ? 'bg-ink text-inverse' : 'text-ink-3 shadow-[inset_0_0_0_1px_var(--line-2)] hover:text-ink',
                        )}
                      >
                        {lead === i ? 'Lead' : 'Make lead'}
                      </button>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>

        {found !== null && (found.length > 0 || existing.length > 0) && (
          <div className="mt-6 flex flex-col items-center gap-3">
            <Button variant="primary" size="lg" className="w-[220px]" disabled={busy || (!chosen.length && !existing.length)} onClick={() => void start()}>
              {busy ? <Spinner className="text-inverse" /> : null}
              {chosen.length > 1 ? `Start with ${chosen.length} accounts` : 'Get started'}
            </Button>
            <p className="max-w-[380px] text-center text-[12px] leading-relaxed text-ink-3">The lead is who you talk to. It plans the work and hands parts of it to the others. You can add more accounts or change the lead any time.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export { inputClass }
