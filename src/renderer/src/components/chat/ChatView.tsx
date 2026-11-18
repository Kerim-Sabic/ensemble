import { useEffect, useMemo, useState } from 'react'
import { Bug, ChevronDown, ListChecks, Repeat, Target, UsersRound, CornerDownRight, Crown, FolderOpen, FolderPlus, GitCompareArrows, Globe, ImagePlus, ListTree, Map as MapIcon, Monitor, PanelRight, Search, ShieldQuestion, ScrollText, SlidersHorizontal, Sparkles, Telescope, UserMinus } from 'lucide-react'
import { adviseModel, budgetOf, modelForTier } from '@shared/budget'
import { agentKey, focusOf, isBusy, leadOf, useStore, useTeam } from '@/store'
import { accentVars, api, cn, folderLabel, tildify } from '@/lib/util'
import { IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from '../ui'
import { Orb } from '../Orb'
import { Inspector } from '../Inspector'
import { Transcript } from './Transcript'
import { Composer, seedComposer } from './Composer'
import { AutoBar } from './AutoBar'
import { NetworkStrip, UltraEdge, UltraMark, useStripShown } from '../ultra/Ultra'


/** True when the window is wide enough to show the panel beside the chat. */
function useWide(min: number): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= min)
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${min}px)`)
    const on = (): void => setWide(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [min])
  return wide
}

function AgentTabs({ canInspect }: { canInspect: boolean }) {
  const team = useTeam()
  const chatId = useStore((s) => s.chatId)
  const focusId = useStore(focusOf)
  const leadId = useStore((s) => leadOf(s)?.id)
  const agents = useStore((s) => s.agents)
  const unread = useStore((s) => s.unread)
  const statuses = useStore((s) => s.statuses)
  const inspector = useStore((s) => s.settings.inspector)
  const setFocus = useStore((s) => s.setFocus)
  const setModal = useStore((s) => s.setModal)
  const toggleInspector = useStore((s) => s.toggleInspector)
  const run = useStore((s) => s.run)
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === s.chatId)?.ultra)
  const focused = team.find((a) => a.id === focusId)

  if (!team.length) return null
  return (
    <div className="mx-auto flex w-full max-w-[780px] items-center gap-1 px-7 pt-3.5 pb-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {team.map((a) => {
          const on = a.id === focusId
          const st = chatId ? agents[agentKey(chatId, a.id)] : undefined
          const out = statuses[a.id]?.state === 'signed-out'
          const dot = chatId ? unread[agentKey(chatId, a.id)] : 0
          const tab = (
            <button
              key={a.id}
              onClick={() => (out && !a.spawned ? setModal({ kind: 'account', id: a.id }) : setFocus(a.id))}
              style={accentVars(a.accent)}
              className={cn(
                'relative flex h-8 shrink-0 items-center gap-2 rounded-full pr-3 pl-[7px] text-[13px] transition-all duration-150',
                on ? 'bg-surface-2 font-medium text-ink shadow-[inset_0_0_0_1px_var(--line)]' : 'text-ink-2 hover:bg-hover hover:text-ink',
                out && 'opacity-60',
              )}
            >
              {/* An agent that was started in the chat sits after whoever started it, marked as theirs. */}
              {a.spawned && <CornerDownRight className="-mr-1 size-3 shrink-0 text-ink-4" strokeWidth={2} />}
              <Orb account={a} size={a.spawned ? 16 : 18} phase={st?.phase} off={out} />
              {a.name}
              {a.id === leadId && <span className="text-[11px] font-normal text-ink-3">Lead</span>}
              {!!dot && !on && <span className="size-1.5 rounded-full bg-[var(--a2)]" />}
            </button>
          )
          if (!a.spawned) return tab
          const by = team.find((x) => x.id === a.spawned?.by)
          const base = team.find((x) => x.id === a.spawned?.base)
          return (
            <Tip key={a.id} label={`${a.role || 'Agent'} · started by ${by?.name || 'a teammate'}${base ? `, on ${base.name}'s account` : ''}`}>
              {tab}
            </Tip>
          )
        })}
      </div>
      {ultra && chatId && <UltraMark chatId={chatId} />}
      {focused && (
        <Menu
          align="end"
          width={248}
          trigger={
            <button aria-label={`${focused.name} options`} className="no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 transition-colors hover:bg-hover hover:text-ink">
              <SlidersHorizontal className="size-[15px]" />
            </button>
          }
        >
          <MenuLabel>{focused.name}</MenuLabel>
          {chatId && !focused.spawned && focused.id !== leadId && statuses[focused.id]?.state === 'ready' && (
            <MenuItem
              icon={<Crown className="size-3.5" />}
              hint="It is caught up on the chat so far and takes over planning."
              onSelect={() => void run(api.setChatLead(chatId, focused.id))}
            >
              Lead this chat
            </MenuItem>
          )}
          {focused.spawned ? (
            <>
              <MenuItem icon={<SlidersHorizontal className="size-3.5" />} hint="Its sign-in and allowance are this account's." onSelect={() => setModal({ kind: 'account', id: focused.spawned?.base || focused.id })}>
                The account it works on…
              </MenuItem>
              {chatId && (
                <MenuItem icon={<UserMinus className="size-3.5" />} hint="It stops and takes no more work. What it did stays in the chat." onSelect={() => void run(api.removeAgent(chatId, focused.id))}>
                  Send {focused.name} home
                </MenuItem>
              )}
            </>
          ) : (
            <MenuItem icon={<SlidersHorizontal className="size-3.5" />} onSelect={() => setModal({ kind: 'account', id: focused.id })}>
              Account, model and role…
            </MenuItem>
          )}
          {chatId && isBusy(agents[agentKey(chatId, focused.id)]) && (
            <>
              <MenuSeparator />
              <MenuItem danger onSelect={() => void api.stop(chatId, focused.id)}>
                Stop {focused.name}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      {canInspect && (
        <IconButton label={inspector ? 'Hide activity' : 'Show activity'} kbd="Ctrl I" onClick={toggleInspector} className={cn(inspector && 'bg-hover text-ink')}>
          <PanelRight className="size-[15px]" />
        </IconButton>
      )}
    </div>
  )
}

/** What the rest of the team is doing while you look at one of them. */
function LiveStrip() {
  const team = useTeam()
  const chatId = useStore((s) => s.chatId)
  const focusId = useStore(focusOf)
  const agents = useStore((s) => s.agents)
  const setFocus = useStore((s) => s.setFocus)
  // While the network at the top shows everyone at work, only those waiting for you stay here.
  const net = useStripShown(chatId)
  if (!chatId) return null
  const busy = team.filter((a) => isBusy(agents[agentKey(chatId, a.id)]))
  const others = busy
    .filter((a) => a.id !== focusId)
    .map((a) => ({ a, st: agents[agentKey(chatId, a.id)] }))
    .filter((x) => !net || x.st?.phase === 'waiting')
  if (!others.length) return null
  return (
    <div className="mx-auto flex w-full max-w-[780px] flex-wrap gap-1.5 px-7 pb-2.5">
      {others.map(({ a, st }) => {
        const waiting = st?.phase === 'waiting'
        return (
          <button
            key={a.id}
            onClick={() => setFocus(a.id)}
            style={accentVars(a.accent)}
            className={cn(
              'flex h-7 max-w-full animate-rise items-center gap-2 rounded-full pr-3 pl-1.5 text-[12px] transition-colors',
              waiting ? 'bg-warn-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_35%,transparent)]' : 'bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)] hover:bg-surface-3',
            )}
          >
            <Orb account={a} size={15} phase={st?.phase} />
            <span className="font-medium">{a.name}</span>
            {waiting ? (
              <span className="flex items-center gap-1 font-medium text-warn">
                <ShieldQuestion className="size-3" /> needs your OK
              </span>
            ) : (
              <span className="shimmer-text max-w-[260px] truncate">{st?.activity || 'Working'}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

const STARTERS = [
  { icon: ListTree, tone: 'clay', title: 'Build something', blurb: 'Plan it, split it across the team, check the result', text: 'Plan and build this. Split the independent parts across the team, then check the result yourself before telling me it is done:\n\n' },
  { icon: Bug, tone: 'rose', title: 'Fix a bug', blurb: 'Find the cause, fix it, show what was wrong', text: 'Find the cause of this bug, fix it, and show me what was wrong:\n\n' },
  { icon: GitCompareArrows, tone: 'violet', title: 'Get a second opinion', blurb: 'Two teammates review independently', text: 'Have two teammates review this project independently, one looking for bugs and one at design and maintainability. Then give me one combined list, most important first.' },
  { icon: Telescope, tone: 'blue', title: 'Research in parallel', blurb: 'One teammate per angle, one summary back', text: 'Research this from several angles at once, one teammate per angle, then give me one summary with sources:\n\n' },
  { icon: MapIcon, tone: 'teal', title: 'Explain this project', blurb: 'How it is organised and where things live', text: 'Walk me through how this project is organised: the main parts, how they fit together, and where I would look to change something.' },
  { icon: ImagePlus, tone: 'green', title: 'Make an image', blurb: 'ChatGPT draws, the lead puts it to use', text: 'Create an image of ', needs: 'gpt' },
  { icon: Globe, tone: 'amber', title: 'Work a website', blurb: 'Open it, click through it, report back. Watch live.', text: 'Open the browser and ', needs: 'browser' },
  { icon: Monitor, tone: 'slate', title: 'Use my computer', blurb: 'Do it in an app, with your OK', text: 'On my computer, ', needs: 'computer' },
] as const

/** Ways to start that the app runs itself: they put the command in the message box, ready to finish. */
const MODE_STARTERS = [
  { icon: Target, label: 'Set a goal', text: '/goal ', tip: 'The team keeps working until it is done, checked after every reply' },
  { icon: Repeat, label: 'Start a loop', text: '/loop 15m ', tip: 'A message sent again by itself, every 15 minutes or at its own pace' },
  { icon: UsersRound, label: 'Ask the council', text: '/council ', tip: 'Every model answers on its own, then the lead compares them' },
  { icon: ListChecks, label: 'Plan first', text: '/plan ', tip: 'You get a plan to approve before any work starts' },
] as const

/** Research is worth more when it is kept: with a vault, the starter asks for it to be filed. */
const RESEARCH_FILED = 'Research this in depth, one teammate per angle. Check the vault first for what we already know, then write what we learn into it and give me a summary with sources:\n\n'

function FolderPicker() {
  const cwd = useStore((s) => s.draftCwd)
  const home = useStore((s) => s.env.home)
  const chats = useStore((s) => s.chats)
  const setDraftCwd = useStore((s) => s.setDraftCwd)
  const recent = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const c of chats) {
      const k = c.cwd.toLowerCase()
      if (seen.has(k) || k === (cwd || '').toLowerCase()) continue
      seen.add(k)
      out.push(c.cwd)
      if (out.length >= 6) break
    }
    return out
  }, [chats, cwd])
  const here = cwd && folderLabel(cwd, home) !== 'Home folder' ? tildify(cwd, home) : 'your home folder'
  const pick = async (): Promise<void> => {
    const p = await api.pickFolder()
    if (p) setDraftCwd(p)
  }
  return (
    <Menu
      align="center"
      width={300}
      trigger={
        <button className="flex h-8 max-w-full items-center gap-2 rounded-full bg-surface-2 pr-2.5 pl-3.5 text-[12.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:bg-surface-3 hover:text-ink">
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate">
            Working in <span className="font-medium text-ink">{here}</span>
          </span>
          <ChevronDown className="size-3 shrink-0 text-ink-3" />
        </button>
      }
    >
      {recent.length > 0 && (
        <>
          <MenuLabel>Recent folders</MenuLabel>
          {recent.map((p) => (
            <MenuItem key={p} icon={<FolderOpen className="size-3.5" />} hint={tildify(p, home)} onSelect={() => setDraftCwd(p)}>
              {folderLabel(p, home)}
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuItem icon={<FolderPlus className="size-3.5" />} onSelect={() => void pick()}>
        Choose a folder…
      </MenuItem>
      {cwd && folderLabel(cwd, home) !== 'Home folder' && (
        <MenuItem icon={<Search className="size-3.5" />} onSelect={() => void api.openPath(cwd)}>
          Open in File Explorer
        </MenuItem>
      )}
    </Menu>
  )
}

/**
 * On the new-chat screen: when the usual lead is short of its strongest model and another
 * account has plenty, offers to let that account lead the chat about to start.
 */
function LeadHint() {
  const smart = useStore((s) => s.settings.smartModels)
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const statuses = useStore((s) => s.statuses)
  const usual = useStore((s) => leadOf(s, null, true))
  const draftLead = useStore((s) => s.draftLead)
  const setDraftLead = useStore((s) => s.setDraftLead)
  const hint = useMemo(() => {
    if (!smart || !usual || usual.provider !== 'claude' || usual.model) return null
    const mine = budgetOf(usage[usual.id])
    const advice = adviseModel(mine, 'lead')
    if (!advice || advice.tier === 'top') return null
    const better = accounts
      .filter((a) => a.enabled && a.id !== usual.id && a.provider === 'claude' && !a.model && statuses[a.id]?.state === 'ready')
      .map((a) => ({ a, b: budgetOf(usage[a.id]) }))
      .filter((x) => adviseModel(x.b, 'lead')?.tier === 'top' && x.b.weekly?.pace !== 'out' && x.b.weekly?.pace !== 'save' && x.b.session?.pace !== 'out')
      .sort((x, y) => (y.b.top?.left ?? 0) - (x.b.top?.left ?? 0))[0]
    if (!better) return null
    const models = statuses[usual.id]?.models || []
    return { other: better.a, left: better.b.top?.left, top: modelForTier(models, 'top')?.label || mine.top?.label || 'the strongest model', now: modelForTier(models, advice.tier)?.label || 'a lesser model', mine: mine.top?.left }
  }, [smart, usual, accounts, usage, statuses])
  if (!hint || !usual) return null
  const picked = draftLead === hint.other.id
  return (
    <div className="mt-4 flex max-w-[560px] animate-rise items-center gap-3 rounded-[14px] bg-surface py-2 pr-2 pl-3.5 text-[12.5px] shadow-card" style={accentVars(hint.other.accent)}>
      <Sparkles className="size-4 shrink-0 text-[var(--a2)]" strokeWidth={1.9} />
      <span className="min-w-0 flex-1 leading-snug text-ink-2">
        {picked ? (
          <>
            <span className="font-medium text-ink">{hint.other.name}</span> will lead this chat on {hint.top}.
          </>
        ) : (
          <>
            <span className="font-medium text-ink">{usual.name}</span> is on {hint.now} for now{hint.mine !== undefined ? `: ${Math.round(hint.mine * 100)}% of its ${hint.top} allowance is left` : ''}. <span className="font-medium text-ink">{hint.other.name}</span> has{' '}
            {hint.left !== undefined ? `${Math.round(hint.left * 100)}%` : 'plenty'}.
          </>
        )}
      </span>
      <button
        onClick={() => setDraftLead(picked ? null : hint.other.id)}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 font-medium shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:bg-surface-3"
      >
        {picked ? (
          `Keep ${usual.name}`
        ) : (
          <>
            <Orb account={hint.other} size={14} /> Let {hint.other.name} lead
          </>
        )}
      </button>
    </div>
  )
}

/** On the new-chat screen started from a folder: which folder the chat goes in, and whether it has instructions. */
function DraftFolder() {
  const folder = useStore((s) => s.folders.find((f) => f.id === s.draftFolder))
  const setModal = useStore((s) => s.setModal)
  if (!folder) return null
  return (
    <button
      onClick={() => setModal({ kind: 'folder', id: folder.id })}
      className="mt-3 flex h-7 max-w-full animate-rise items-center gap-1.5 rounded-full px-3 text-[12px] text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-hover hover:text-ink"
    >
      <ScrollText className="size-3.5 shrink-0" />
      <span className="truncate">
        Goes in <span className="font-medium text-ink">{folder.name}</span>
        {folder.instructions ? ' · follows its instructions' : ' · add instructions for this folder'}
      </span>
    </button>
  )
}

function EmptyState() {
  const team = useTeam()
  const lead = useStore((s) => leadOf(s))
  const setModal = useStore((s) => s.setModal)
  const others = team.filter((a) => a.id !== lead?.id)
  const env = useStore((s) => s.env)
  const settings = useStore((s) => s.settings)
  const hasVault = useStore((s) => !!s.vault)
  const can = { gpt: team.some((a) => a.provider === 'chatgpt'), browser: env.canBrowse && settings.browser, computer: env.canControl && settings.computer !== 'off' }

  if (!team.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <h1 className="text-[26px] font-semibold tracking-[-0.025em]">Bring your accounts together</h1>
        <p className="mt-2 max-w-[400px] text-[14px] leading-relaxed text-ink-2">Add the accounts you already use. One leads, the rest pitch in.</p>
        <button onClick={() => setModal({ kind: 'add-account' })} className="mt-6 h-10 rounded-[11px] bg-ink px-5 text-[14px] font-medium text-inverse hover:opacity-90">
          Add an account
        </button>
      </div>
    )
  }

  // With extra agents allowed, one account can split work as well as several.
  const solo = !others.length && settings.maxAgents === 0
  const starters = STARTERS.filter((s) => !('needs' in s) || can[s.needs]).slice(0, solo ? 4 : 8)

  return (
    <div className="hero flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 pb-4">
      <div className="flex min-h-[40px] flex-1" />
      <div className="relative flex animate-rise items-center">
        {team.slice(0, 5).map((a, i) => (
          <span key={a.id} className="animate-float" style={{ animationDelay: `${i * -1.3}s`, marginLeft: i ? -12 : 0, zIndex: 10 - i }}>
            <Orb account={a} size={i === 0 ? 56 : 44} className="hero-orb" />
          </span>
        ))}
      </div>
      <h1 className="mt-7 animate-rise text-center text-[30px] leading-tight font-semibold tracking-[-0.032em]" style={{ animationDelay: '40ms' }}>
        What should the team work on?
      </h1>
      <p className="mt-2.5 max-w-[480px] animate-rise text-center text-[14px] leading-relaxed text-ink-2" style={{ animationDelay: '80ms' }}>
        {others.length ? (
          <>
            <span className="font-medium text-ink">{lead?.name}</span> leads and can hand work to{' '}
            {others.map((a, i) => (
              <span key={a.id}>
                {i > 0 && (i === others.length - 1 ? ' and ' : ', ')}
                <span className="font-medium text-ink">{a.name}</span>
              </span>
            ))}
            .
          </>
        ) : (
          <>
            {settings.maxAgents !== 0 ? (
              <>
                <span className="font-medium text-ink">{lead?.name}</span> leads, and starts helper agents on your account whenever the work splits: a researcher per angle, a tester, a reviewer who has not seen its reasoning.
              </>
            ) : (
              <>
                <span className="font-medium text-ink">{lead?.name}</span> is on its own for now. Add another account, or allow extra agents in Settings, and it can share the work.
              </>
            )}
          </>
        )}
      </p>

      <LeadHint />
      <DraftFolder />

      <div className="mt-5 max-w-full animate-rise" style={{ animationDelay: '120ms' }}>
        <FolderPicker />
      </div>

      <div className={cn('mt-9 flex w-full animate-rise flex-wrap justify-center gap-2.5', starters.length > 6 ? 'max-w-[920px]' : 'max-w-[700px]')} style={{ animationDelay: '160ms' }}>
        {starters.map((s) => (
          <button
            key={s.title}
            onClick={() => seedComposer(hasVault && s.title === 'Research in parallel' ? RESEARCH_FILED : s.text)}
            style={accentVars(s.tone)}
            className={cn(
              'starter group relative flex w-[calc(50%-5px)] flex-col items-start overflow-hidden rounded-[16px] bg-surface px-4 pt-3.5 pb-4 text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-float',
              starters.length > 6 ? 'lg:w-[calc(25%-7.5px)]' : 'lg:w-[calc(33.333%-6.67px)]',
            )}
          >
            <span className="flex size-8 items-center justify-center rounded-[10px] bg-[var(--a-soft)] text-[var(--a2)] shadow-[inset_0_0_0_1px_var(--a-line)]">
              <s.icon className="size-4" strokeWidth={1.9} />
            </span>
            <span className="mt-3 block text-[13.5px] font-medium">{s.title}</span>
            <span className="mt-0.5 block text-[12px] leading-snug text-ink-3">{s.blurb}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex max-w-full animate-rise flex-wrap justify-center gap-1.5" style={{ animationDelay: '200ms' }}>
        {MODE_STARTERS.map((m) => (
          <Tip key={m.label} label={m.tip}>
            <button
              onClick={() => seedComposer(m.text)}
              className="flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)] transition-colors hover:bg-hover hover:text-ink"
            >
              <m.icon className="size-3.5 text-ink-3" strokeWidth={1.9} />
              {m.label}
            </button>
          </Tip>
        ))}
      </div>
      <div className="flex min-h-[24px] flex-[1.3]" />
    </div>
  )
}

export function ChatView() {
  const chatId = useStore((s) => s.chatId)
  const focusId = useStore(focusOf)
  const ultra = useStore((s) => !!s.chats.find((c) => c.id === s.chatId)?.ultra)
  const setFocus = useStore((s) => s.setFocus)
  const strip = useStripShown(chatId)
  const inspector = useStore((s) => s.settings.inspector)
  const wide = useWide(1180)
  const showPanel = !!chatId && inspector && wide
  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        {ultra && <UltraEdge />}
        <AgentTabs canInspect={!!chatId && wide} />
        {chatId && <NetworkStrip chatId={chatId} onOpen={setFocus} />}
        {chatId && focusId ? <Transcript chatId={chatId} accountId={focusId} fadeTop={strip} /> : <EmptyState />}
        <LiveStrip />
        {chatId && <AutoBar chatId={chatId} />}
        <Composer />
      </div>
      {showPanel && chatId && <Inspector chatId={chatId} />}
    </div>
  )
}
