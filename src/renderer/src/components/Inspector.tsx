import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Ban, Check, ChevronRight, CircleAlert, CircleDashed, ExternalLink, FilePen, FileText, FolderOpen, Gauge, GitBranch, Globe, Pause, RefreshCw, Search, ShieldQuestion } from 'lucide-react'
import type { Account, AgentState, ChangedFile, Item, Task } from '@shared/types'
import { agentKey, focusOf, isBusy, leadOf, useStore, useTeam } from '@/store'
import { accentVars, api, cn, duration, prettyModel, runLabel, siteOf, until } from '@/lib/util'
import { compactNumber, planFrom, samePath, splitPath, touchedFiles, vaultTouches, type PlanStep } from '@/lib/derive'
import { LiveFrame, Pointer, SurfaceIcon } from './screen/Screen'
import { useScreens, type ScreenEntry } from './screen/LiveView'
import { Button, IconButton, Modal, Spinner, Tip } from './ui'
import { Orb, OrbStack } from './Orb'
import { Markdown } from './Markdown'
import { useElapsed, waitingLabel } from './chat/Cards'
import { MediaTile } from './Media'
import { mediaKind } from '@shared/tools'
import { tierOfModel } from '@shared/budget'

const EMPTY: Item[] = []
const NO_TASKS: Task[] = []

function Section({ title, right, children, startOpen = true }: { title: ReactNode; right?: ReactNode; children: ReactNode; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <section className="border-b border-line last:border-b-0">
      <div className="flex h-10 items-center gap-1 pr-2.5 pl-2">
        <button onClick={() => setOpen((o) => !o)} className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[7px] px-1.5 text-left text-[12px] font-medium text-ink-2 hover:text-ink">
          <ChevronRight className={cn('size-3.5 shrink-0 text-ink-4 transition-transform duration-200', open && 'rotate-90')} />
          <span className="truncate">{title}</span>
        </button>
        {right}
      </div>
      {open && <div className="animate-fade-in px-3.5 pb-3.5">{children}</div>}
    </section>
  )
}

// ───────────── plan ─────────────

function StepRow({ step, live }: { step: PlanStep; live: boolean }) {
  const doing = step.status === 'in_progress'
  return (
    <li className="flex items-start gap-2.5 py-[3px] text-[12.5px] leading-snug">
      <span className="mt-[2px] flex size-[15px] shrink-0 items-center justify-center">
        {step.status === 'completed' ? (
          <span className="flex size-[15px] items-center justify-center rounded-full bg-ok text-white">
            <Check className="size-2.5" strokeWidth={3.5} />
          </span>
        ) : doing ? (
          live ? (
            <span className="plan-doing size-[15px] rounded-full" />
          ) : (
            <span className="flex size-[15px] items-center justify-center rounded-full border-[1.5px] border-ink-2">
              <span className="size-[5px] rounded-full bg-ink-2" />
            </span>
          )
        ) : (
          <span className="size-[15px] rounded-full border-[1.5px] border-ink-4" />
        )}
      </span>
      <span className={cn('min-w-0', step.status === 'completed' ? 'text-ink-3' : doing ? 'font-medium text-ink' : 'text-ink-2')}>
        {doing && live && step.active ? <span className="shimmer-text">{step.active}</span> : step.text}
      </span>
    </li>
  )
}

function PlanSection({ chatId, account, isLead }: { chatId: string; account: Account; isLead: boolean }) {
  const items = useStore((s) => s.items[agentKey(chatId, account.id)] ?? EMPTY)
  const live = useStore((s) => isBusy(s.agents[agentKey(chatId, account.id)]))
  const steps = useMemo(() => planFrom(items), [items])
  if (!steps.length) return null
  const done = steps.filter((s) => s.status === 'completed').length
  return (
    <Section
      title={isLead ? 'Plan' : `${account.name}'s plan`}
      right={
        <span className="tabular flex items-center gap-2 text-[11.5px] text-ink-3">
          {done} of {steps.length}
          <span className="h-1 w-10 overflow-hidden rounded-full bg-line-2">
            <span className="block h-full rounded-full bg-ok transition-[width] duration-500 ease-out" style={{ width: `${(done / steps.length) * 100}%` }} />
          </span>
        </span>
      }
    >
      <ol style={accentVars(account.accent)}>
        {steps.map((s, i) => (
          <StepRow key={i} step={s} live={live} />
        ))}
      </ol>
    </Section>
  )
}

// ───────────── who is doing what ─────────────

const TeamRow = memo(function TeamRow({ chatId, account, lead, focused }: { chatId: string; account: Account; lead: boolean; focused: boolean }) {
  const st = useStore((s): AgentState | undefined => s.agents[agentKey(chatId, account.id)])
  const out = useStore((s) => s.statuses[account.id]?.state === 'signed-out')
  const task = useStore((s) => (st?.taskId ? s.tasks[chatId]?.find((t) => t.id === st.taskId) : undefined))
  const setFocus = useStore((s) => s.setFocus)
  const dry = useStore((s) => {
    const u = s.usage[account.id]
    return [u?.session, u?.weekly].find((w) => w && (w.status === 'rejected' || w.utilization >= 1) && w.resetsAt && w.resetsAt > Date.now())?.resetsAt
  })
  const busy = isBusy(st)
  const elapsed = useElapsed(busy ? st?.turnStartedAt : undefined)
  const waiting = st?.phase === 'waiting'
  return (
    <button
      onClick={() => setFocus(account.id)}
      style={accentVars(account.accent)}
      className={cn('flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors', focused ? 'bg-active' : 'hover:bg-hover')}
    >
      {/* A sub-agent is set in a little, under whoever started it. */}
      {account.spawned && <span className={cn('shrink-0 border-b border-l border-line-2', account.spawned.depth > 1 ? 'ml-3.5 h-3 w-2.5' : 'ml-0.5 h-3 w-1.5', '-mt-2 rounded-bl-[5px]')} />}
      <Orb account={account} size={account.spawned ? 17 : 20} phase={st?.phase} off={out} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className={cn('text-[12.5px] font-medium', account.spawned ? 'shrink-0' : 'truncate')}>{account.name}</span>
          {lead && <span className="text-[10.5px] text-ink-3">Lead</span>}
          {account.spawned && <span className="min-w-0 truncate text-[10.5px] text-ink-4">{account.role}</span>}
        </span>
        <span className="block truncate text-[11.5px] leading-[15px]">
          {out ? (
            <span className="text-warn">Signed out</span>
          ) : waiting ? (
            <span className="flex items-center gap-1 font-medium text-warn">
              <ShieldQuestion className="size-3" /> {st?.activity || 'Needs your OK'}
            </span>
          ) : busy ? (
            <span className="shimmer-text">{st?.activity || 'Working'}</span>
          ) : dry ? (
            <span className="text-warn">Out of allowance · back in {until(dry)}</span>
          ) : st?.phase === 'error' ? (
            <span className="text-bad">Stopped with a problem</span>
          ) : (
            <span className="text-ink-3">{task ? task.title : 'Free'}</span>
          )}
        </span>
      </span>
      {busy && !waiting && elapsed > 3000 && <span className="tabular shrink-0 text-[11px] text-ink-4">{duration(elapsed)}</span>}
    </button>
  )
})

// ───────────── screens in use ─────────────

function MiniScreen({ entry }: { entry: ScreenEntry }) {
  const watch = useStore((s) => s.watch)
  const sc = entry.screen as NonNullable<ScreenEntry['screen']>
  const last = entry.steps[entry.steps.length - 1]
  const shot = [...entry.steps].reverse().find((s) => s.shot)?.shot
  return (
    <button
      onClick={() => watch(entry.key)}
      style={accentVars(entry.account.accent)}
      className={cn(
        'group/ms block w-full overflow-hidden rounded-[11px] bg-surface text-left shadow-card transition-shadow hover:shadow-float',
        sc.active && 'shadow-[0_0_0_1px_color-mix(in_oklab,var(--a2)_45%,var(--line)),0_10px_26px_-14px_color-mix(in_oklab,var(--a2)_55%,transparent)]',
      )}
    >
      <div className="relative w-full overflow-hidden bg-surface-3" style={{ aspectRatio: String(sc.width / sc.height) }}>
        <LiveFrame screenKey={entry.key} still={shot} className="absolute inset-0 size-full object-fill" />
        {sc.pointer && <Pointer pointer={sc.pointer} account={entry.account} small />}
        {sc.active && (
          <span className="absolute top-1.5 left-1.5 flex h-[18px] items-center gap-1 rounded-full bg-black/60 pr-2 pl-1.5 text-[10px] font-medium text-white">
            <span className="size-1.5 animate-pulse-soft rounded-full bg-[#ff5b4f]" /> Live
          </span>
        )}
      </div>
      <div className="flex h-8 items-center gap-1.5 px-2.5 text-[11.5px]">
        <Orb account={entry.account} size={13} live={sc.active} />
        <span className="shrink-0 font-medium">{entry.account.name}</span>
        <span className={cn('min-w-0 flex-1 truncate', sc.active && last?.status === 'running' ? 'shimmer-text' : 'text-ink-3')}>
          {sc.active && last ? last.label : entry.kind === 'browser' ? siteOf(sc.url) || 'Browser' : 'This computer'}
        </span>
        <SurfaceIcon kind={entry.kind} className="size-3 shrink-0 text-ink-4" />
      </div>
    </button>
  )
}

function ScreensSection({ chatId }: { chatId: string }) {
  const entries = useScreens(chatId)
  const watch = useStore((s) => s.watch)
  if (!entries.length) return null
  const open = entries.filter((e) => e.screen)
  const live = open.filter((e) => e.screen?.active).length
  const recorded = entries.filter((e) => !e.screen)
  return (
    <Section title="Screens" right={<span className="tabular text-[11.5px] text-ink-3">{live ? `${live} live` : open.length ? `${open.length} open` : ''}</span>}>
      <div className="space-y-2">
        {open.map((e) => (
          <MiniScreen key={e.key} entry={e} />
        ))}
        {recorded.map((e) => (
          <button key={e.key} onClick={() => watch(e.key, e.steps[e.steps.length - 1]?.id)} className="-mx-2 flex w-[calc(100%+16px)] items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-hover">
            <SurfaceIcon kind={e.kind} className="size-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">
              {e.account.name}'s {e.kind === 'browser' ? 'browser' : 'time on the computer'}
            </span>
            <span className="tabular shrink-0 text-[11px] text-ink-4">{e.steps.length} steps</span>
          </button>
        ))}
      </div>
    </Section>
  )
}

// ───────────── notes in the vault ─────────────

function NotesSection({ chatId }: { chatId: string }) {
  const team = useTeam()
  const vault = useStore((s) => s.vault)
  const setView = useStore((s) => s.setView)
  const sig = useStore((s) => team.map((a) => `${s.items[agentKey(chatId, a.id)]?.length || 0}${s.agents[agentKey(chatId, a.id)]?.phase || ''}`).join('|'))
  const notes = useMemo(() => {
    if (!vault) return []
    const st = useStore.getState()
    const all = new Map<string, { path: string; how: 'read' | 'wrote'; ts: number; who: Account[] }>()
    for (const a of team) {
      for (const t of vaultTouches(st.items[agentKey(chatId, a.id)] || EMPTY, vault.path)) {
        const k = t.path.toLowerCase()
        const e = all.get(k) || { path: t.path, how: t.how, ts: 0, who: [] }
        if (t.how === 'wrote') e.how = 'wrote'
        e.ts = Math.max(e.ts, t.ts)
        if (!e.who.includes(a)) e.who.push(a)
        all.set(k, e)
      }
    }
    // What was written matters more than what was only looked at.
    return [...all.values()].sort((x, y) => Number(y.how === 'wrote') - Number(x.how === 'wrote') || y.ts - x.ts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, chatId, team, vault])
  const [all, setAll] = useState(false)
  if (!vault || !notes.length) return null
  const wrote = notes.filter((n) => n.how === 'wrote').length
  return (
    <Section
      title={vault.name}
      right={
        <button onClick={() => setView('memory')} className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink">
          {wrote ? `${wrote} written` : `${notes.length} read`}
        </button>
      }
    >
      <div className="-mx-2 space-y-px">
        {(all ? notes : notes.slice(0, 8)).map((n) => {
          const { dir, name } = splitPath(n.path.replace(/\.md$/i, ''))
          return (
            <button key={n.path} onClick={() => void api.vaultOpen(n.path)} className="flex w-full items-center gap-2 rounded-[9px] px-2 py-[5px] text-left transition-colors hover:bg-hover">
              <Tip label={n.how === 'wrote' ? 'Written to' : 'Read'} side="left">
                <span className="flex w-3.5 shrink-0 justify-center">{n.how === 'wrote' ? <FilePen className="size-3.5 text-ok" strokeWidth={1.9} /> : <FileText className="size-3.5 text-ink-4" strokeWidth={1.75} />}</span>
              </Tip>
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {name}
                {dir && <span className="ml-1.5 text-[11.5px] text-ink-4">{dir}</span>}
              </span>
              <span className="flex shrink-0">
                <OrbStack accounts={n.who} size={12} max={3} />
              </span>
            </button>
          )
        })}
      </div>
      {notes.length > 8 && (
        <button onClick={() => setAll((a) => !a)} className="mt-1 text-[11.5px] font-medium text-ink-3 hover:text-ink">
          {all ? 'Show fewer' : `Show all ${notes.length}`}
        </button>
      )}
    </Section>
  )
}

// ───────────── what this chat has spent ─────────────

/** Rough relative cost of a token at each tier, from the usual price steps between model sizes. */
const WEIGHT: Record<string, number> = { top: 1, strong: 0.6, mid: 0.2, light: 0.067 }

function SpendSection({ chatId }: { chatId: string }) {
  const team = useTeam(true)
  const sig = useStore((s) => team.map((a) => s.items[agentKey(chatId, a.id)]?.length || 0).join('|'))
  const spend = useMemo(() => {
    const st = useStore.getState()
    const by = new Map<string, { label: string; tier: string; tokens: number; turns: number }>()
    for (const a of team) {
      for (const it of st.items[agentKey(chatId, a.id)] || EMPTY) {
        if (it.kind !== 'turn' || !it.tokens || !it.model) continue
        const label = prettyModel(it.model) || it.model
        const tier = tierOfModel(it.model) || 'mid'
        const e = by.get(label) || { label, tier, tokens: 0, turns: 0 }
        e.tokens += it.tokens
        e.turns++
        by.set(label, e)
      }
    }
    const rows = [...by.values()].sort((x, y) => (WEIGHT[y.tier] || 0) - (WEIGHT[x.tier] || 0) || y.tokens - x.tokens)
    const total = rows.reduce((n, r) => n + r.tokens, 0)
    const cost = rows.reduce((n, r) => n + r.tokens * (WEIGHT[r.tier] || 0.2), 0)
    const saved = total ? 1 - cost / total : 0
    return { rows, total, saved }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, chatId, team])
  if (!spend.total) return null
  const max = Math.max(...spend.rows.map((r) => r.tokens))
  return (
    <Section title="Spent in this chat" right={<span className="tabular text-[11.5px] text-ink-3">{compactNumber(spend.total)} tokens written</span>}>
      <div className="space-y-1.5">
        {spend.rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-[12px]">
            <span className="w-[74px] shrink-0 truncate">{r.label}</span>
            <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-line">
              <span className={cn('block h-full rounded-full', r.tier === 'top' ? 'bg-[#d97757]' : r.tier === 'strong' ? 'bg-[#8b6cf0]' : r.tier === 'mid' ? 'bg-[#2ea89a]' : 'bg-ink-4')} style={{ width: `${(r.tokens / max) * 100}%` }} />
            </span>
            <span className="tabular w-10 shrink-0 text-right text-[11px] text-ink-3">{compactNumber(r.tokens)}</span>
          </div>
        ))}
      </div>
      {spend.saved >= 0.05 && (
        <Tip side="top" label="A rough estimate from the usual price steps between model sizes: what this chat's work would have used had every reply run the strongest model.">
          <div className="mt-2.5 rounded-[9px] bg-ok-soft px-2.5 py-1.5 text-[12px] text-ok">About {Math.round(spend.saved * 100)}% less than if every agent had run the strongest model</div>
        </Tip>
      )}
    </Section>
  )
}

// ───────────── what was searched and read on the web ─────────────

function WebSection({ chatId }: { chatId: string }) {
  const team = useTeam(true)
  const sig = useStore((s) => team.map((a) => s.items[agentKey(chatId, a.id)]?.length || 0).join('|'))
  const rows = useMemo(() => {
    const st = useStore.getState()
    const out: { id: string; kind: 'search' | 'page'; text: string; url?: string; ts: number; who: Account; running: boolean }[] = []
    for (const a of team) {
      for (const it of st.items[agentKey(chatId, a.id)] || EMPTY) {
        if (it.kind === 'tool' && (it.name === 'WebSearch' || it.name === 'WebFetch')) {
          const inp = (it.input && typeof it.input === 'object' ? it.input : {}) as Record<string, unknown>
          if (it.name === 'WebSearch' && typeof inp.query === 'string') out.push({ id: it.id, kind: 'search', text: inp.query, ts: it.ts, who: a, running: it.status === 'running' })
          else if (typeof inp.url === 'string') out.push({ id: it.id, kind: 'page', text: siteOf(inp.url) || inp.url, url: inp.url, ts: it.ts, who: a, running: it.status === 'running' })
        } else if (it.kind === 'screen' && it.surface === 'browser' && it.url && it.action === 'open') {
          out.push({ id: it.id, kind: 'page', text: siteOf(it.url) || it.url, url: it.url, ts: it.ts, who: a, running: it.status === 'running' })
        }
      }
    }
    return out.sort((x, y) => y.ts - x.ts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, chatId, team])
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const searches = rows.filter((r) => r.kind === 'search').length
  return (
    <Section title="Searched and read" right={<span className="tabular text-[11.5px] text-ink-3">{searches ? `${searches} searches · ` : ''}{rows.length - searches} pages</span>}>
      <div className="-mx-2 space-y-px">
        {(all ? rows : rows.slice(0, 10)).map((r) => (
          <button
            key={r.id}
            onClick={() => (r.url ? void api.openExternal(r.url) : undefined)}
            title={r.url || r.text}
            className={cn('flex w-full items-center gap-2 rounded-[9px] px-2 py-[5px] text-left transition-colors', r.url ? 'hover:bg-hover' : 'cursor-default')}
          >
            {r.kind === 'search' ? <Search className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.9} /> : <Globe className="size-3.5 shrink-0 text-ink-4" strokeWidth={1.75} />}
            <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', r.running && 'shimmer-text')}>{r.kind === 'search' ? `“${r.text}”` : r.text}</span>
            <Orb account={r.who} size={12} live={r.running} />
          </button>
        ))}
      </div>
      {rows.length > 10 && (
        <button onClick={() => setAll((a) => !a)} className="mt-1 text-[11.5px] font-medium text-ink-3 hover:text-ink">
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </Section>
  )
}

// ───────────── what was made ─────────────

function MadeSection({ chatId }: { chatId: string }) {
  const team = useTeam(true)
  const sig = useStore((s) => team.map((a) => s.items[agentKey(chatId, a.id)]?.length || 0).join('|'))
  const made = useMemo(() => {
    const st = useStore.getState()
    const all: { path: string; ts: number; who: Account }[] = []
    for (const a of team) for (const it of st.items[agentKey(chatId, a.id)] || EMPTY) if (it.kind === 'image') all.push({ path: it.path, ts: it.ts, who: a })
    const seen = new Set<string>()
    return all.sort((x, y) => y.ts - x.ts).filter((m) => !seen.has(m.path.toLowerCase()) && !!seen.add(m.path.toLowerCase()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, chatId, team])
  const [all, setAll] = useState(false)
  if (!made.length) return null
  const sounds = made.filter((m) => mediaKind(m.path) === 'audio')
  const tiles = made.filter((m) => mediaKind(m.path) !== 'audio')
  return (
    <Section title="Made in this chat" right={<span className="tabular text-[11.5px] text-ink-3">{made.length}</span>}>
      {tiles.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5">
          {(all ? tiles : tiles.slice(0, 9)).map((m) => (
            <MediaTile key={m.path} path={m.path} />
          ))}
        </div>
      )}
      {sounds.length > 0 && (
        <div className={cn('space-y-1.5', tiles.length > 0 && 'mt-2')}>
          {(all ? sounds : sounds.slice(0, 4)).map((m) => (
            <MediaTile key={m.path} path={m.path} />
          ))}
        </div>
      )}
      {(tiles.length > 9 || sounds.length > 4) && (
        <button onClick={() => setAll((a) => !a)} className="mt-1.5 text-[11.5px] font-medium text-ink-3 hover:text-ink">
          {all ? 'Show fewer' : `Show all ${made.length}`}
        </button>
      )}
    </Section>
  )
}

// ───────────── tasks ─────────────

export function TaskStatusIcon({ status, className }: { status: Task['status']; className?: string }) {
  if (status === 'running') return <Spinner className={cn('size-3.5 text-[var(--a2)]', className)} />
  if (status === 'queued') return <CircleDashed className={cn('size-3.5 text-ink-3', className)} />
  if (status === 'done') return <Check className={cn('size-3.5 text-ok', className)} strokeWidth={2.75} />
  if (status === 'failed') return <CircleAlert className={cn('size-3.5 text-bad', className)} />
  if (status === 'interrupted') return <Pause className={cn('size-3.5 text-warn', className)} />
  return <Ban className={cn('size-3.5 text-ink-3', className)} />
}

const TaskLine = memo(function TaskLine({ task }: { task: Task }) {
  const to = useStore((s) => s.members[task.to])
  const setModal = useStore((s) => s.setModal)
  const live = task.status === 'running'
  const elapsed = useElapsed(live ? task.startedAt : undefined)
  const took = task.startedAt && task.finishedAt ? task.finishedAt - task.startedAt : 0
  return (
    <button
      onClick={() => setModal({ kind: 'task', taskId: task.id })}
      style={accentVars(to?.accent)}
      className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-hover"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <TaskStatusIcon status={task.status} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', task.status === 'done' || task.status === 'cancelled' ? 'text-ink-2' : 'text-ink')}>{task.title}</span>
      <span className="tabular shrink-0 text-[11px] text-ink-4">{live ? duration(elapsed) : took > 1500 ? duration(took) : task.status === 'queued' && task.waitingOn?.length ? `after ${task.waitingOn.join(', ')}` : ''}</span>
      <Tip label={[to?.name || 'Teammate', runLabel(task)].filter(Boolean).join(' · ')} side="left">
        <span className="flex">
          <Orb account={to} size={14} live={live} />
        </span>
      </Tip>
    </button>
  )
})

function TasksSection({ chatId }: { chatId: string }) {
  const tasks = useStore((s) => s.tasks[chatId] ?? NO_TASKS)
  const [all, setAll] = useState(false)
  const ordered = useMemo(() => {
    const open = tasks.filter((t) => t.status === 'running' || t.status === 'queued')
    const closed = tasks.filter((t) => t.status !== 'running' && t.status !== 'queued').reverse()
    return [...open, ...closed]
  }, [tasks])
  if (!tasks.length) return null
  const open = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length
  const shown = all ? ordered : ordered.slice(0, 6)
  return (
    <Section title="Handed out" right={<span className="tabular text-[11.5px] text-ink-3">{open ? `${open} in progress` : `${tasks.length} done`}</span>}>
      <div className="-mx-2 space-y-px">
        {shown.map((t) => (
          <TaskLine key={t.id} task={t} />
        ))}
      </div>
      {ordered.length > 6 && (
        <button onClick={() => setAll((a) => !a)} className="mt-1 text-[11.5px] font-medium text-ink-3 hover:text-ink">
          {all ? 'Show fewer' : `Show all ${ordered.length}`}
        </button>
      )}
    </Section>
  )
}

// ───────────── changed files ─────────────

const LETTER: Record<ChangedFile['status'], { letter: string; tone: string; label: string }> = {
  modified: { letter: 'M', tone: 'text-warn', label: 'Changed' },
  added: { letter: 'A', tone: 'text-ok', label: 'New' },
  untracked: { letter: 'N', tone: 'text-ok', label: 'New' },
  deleted: { letter: 'D', tone: 'text-bad', label: 'Deleted' },
  renamed: { letter: 'R', tone: 'text-link', label: 'Renamed' },
}

function FileRow({ file, who, onOpen }: { file: { path: string; status?: ChangedFile['status']; added?: number; removed?: number }; who: Account[]; onOpen(): void }) {
  const { dir, name } = splitPath(file.path)
  const tag = file.status ? LETTER[file.status] : null
  return (
    <button onClick={onOpen} className="group/f flex w-full items-center gap-2 rounded-[9px] px-2 py-[5px] text-left transition-colors hover:bg-hover">
      {tag && (
        <Tip label={tag.label} side="left">
          <span className={cn('w-3 shrink-0 text-center font-mono text-[10.5px] font-semibold', tag.tone)}>{tag.letter}</span>
        </Tip>
      )}
      <span className="min-w-0 flex-1 truncate text-[12.5px]">
        <span className={cn(file.status === 'deleted' && 'text-ink-3 line-through')}>{name}</span>
        {dir && <span className="ml-1.5 text-[11.5px] text-ink-4">{dir}</span>}
      </span>
      {(file.added || file.removed) !== undefined && !!((file.added || 0) + (file.removed || 0)) && (
        <span className="tabular shrink-0 font-mono text-[10.5px]">
          {!!file.added && <span className="text-ok">+{file.added}</span>}
          {!!file.removed && <span className="ml-1 text-bad">−{file.removed}</span>}
        </span>
      )}
      {who.length > 0 && (
        <Tip label={who.length > 1 ? `Edited by ${who.map((a) => a.name).join(' and ')}` : `Edited by ${who[0].name}`} side="left">
          <span className="flex shrink-0">
            <OrbStack accounts={who} size={12} max={3} />
          </span>
        </Tip>
      )}
    </button>
  )
}

function ChangesSection({ chatId }: { chatId: string }) {
  const team = useTeam()
  const changes = useStore((s) => s.changes[chatId])
  const cwd = useStore((s) => s.chats.find((c) => c.id === chatId)?.cwd || '')
  const refresh = useStore((s) => s.refreshChanges)
  const setModal = useStore((s) => s.setModal)
  const [all, setAll] = useState(false)
  // Recomputed when a transcript grows or an agent changes phase, not on every streamed word.
  const sig = useStore((s) => team.map((a) => `${s.items[agentKey(chatId, a.id)]?.length || 0}${s.agents[agentKey(chatId, a.id)]?.phase || ''}`).join('|'))
  const touched = useMemo(() => {
    const st = useStore.getState()
    return team.map((a) => ({ account: a, files: touchedFiles(st.items[agentKey(chatId, a.id)] || EMPTY) })).filter((x) => x.files.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, chatId, team])

  const whoTouched = (rel: string): Account[] => touched.filter((t) => t.files.some((f) => samePath(f.path, rel))).map((t) => t.account)

  let rows: ReactNode[] = []
  let count = 0
  if (changes?.repo) {
    count = changes.files.length
    rows = (all ? changes.files : changes.files.slice(0, 12)).map((f) => (
      <FileRow key={f.path} file={f} who={whoTouched(f.path)} onOpen={() => setModal({ kind: 'diff', chatId, path: f.path })} />
    ))
  } else {
    // Not a git folder: list what the agents said they changed.
    const seen = new Map<string, { path: string; who: Account[]; ts: number }>()
    for (const t of touched) {
      for (const f of t.files) {
        const k = f.path.toLowerCase()
        const e = seen.get(k) || { path: f.path, who: [], ts: 0 }
        e.who.push(t.account)
        e.ts = Math.max(e.ts, f.ts)
        seen.set(k, e)
      }
    }
    const list = [...seen.values()].sort((a, b) => b.ts - a.ts)
    count = list.length
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    rows = (all ? list : list.slice(0, 12)).map((f) => {
      const p = f.path.replace(/\\/g, '/')
      const rel = base && p.toLowerCase().startsWith(`${base}/`) ? p.slice(base.length + 1) : p
      return <FileRow key={f.path} file={{ path: rel }} who={f.who} onOpen={() => void api.openPath(f.path)} />
    })
  }

  return (
    <Section
      title="Changes"
      right={
        <span className="flex items-center gap-1">
          {changes?.branch && (
            <Tip label="Current branch">
              <span className="flex max-w-[120px] items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11px] text-ink-2">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{changes.branch}</span>
              </span>
            </Tip>
          )}
          <IconButton label="Check again" side="left" className="size-6" onClick={() => refresh(chatId)}>
            <RefreshCw className="size-3" />
          </IconButton>
        </span>
      }
    >
      {count === 0 ? (
        <p className="py-1 text-[12px] leading-relaxed text-ink-3">{changes?.repo ? 'Nothing has changed since the last commit.' : 'Files the team creates or edits will be listed here.'}</p>
      ) : (
        <>
          <div className="-mx-2 space-y-px">{rows}</div>
          {count > 12 && (
            <button onClick={() => setAll((a) => !a)} className="mt-1 text-[11.5px] font-medium text-ink-3 hover:text-ink">
              {all ? 'Show fewer' : `Show all ${count}`}
            </button>
          )}
        </>
      )}
    </Section>
  )
}

// ───────────── working memory ─────────────

export function ContextMeter({ context, className }: { context: { used: number; max: number }; className?: string }) {
  const pct = Math.min(1, context.used / context.max)
  const tone = pct >= 0.85 ? 'bg-warn' : 'bg-ink-3'
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between text-[11.5px]">
        <span className="text-ink-2">Working memory</span>
        <span className="tabular text-ink-3">
          {compactNumber(context.used)} of {compactNumber(context.max)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-line-2">
        <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', tone)} style={{ width: `${Math.max(pct * 100, 1.5)}%` }} />
      </div>
    </div>
  )
}

/** The panel beside the chat: the plan, who is doing what, and what changed. */
export function Inspector({ chatId }: { chatId: string }) {
  const team = useTeam()
  const focusId = useStore(focusOf)
  const leadId = useStore((s) => leadOf(s)?.id)
  const focused = team.find((a) => a.id === focusId)
  const context = useStore((s) => (focusId ? s.agents[agentKey(chatId, focusId)]?.context : undefined))
  return (
    <aside className="flex h-full w-[296px] shrink-0 flex-col border-l border-line bg-surface-2/60">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {focused && <PlanSection chatId={chatId} account={focused} isLead={focused.id === leadId} />}
        <Section title="In this chat">
          <div className="-mx-2 space-y-px">
            {team.map((a) => (
              <TeamRow key={a.id} chatId={chatId} account={a} lead={a.id === leadId} focused={a.id === focusId} />
            ))}
          </div>
        </Section>
        <ScreensSection chatId={chatId} />
        <MadeSection chatId={chatId} />
        <SpendSection chatId={chatId} />
        <WebSection chatId={chatId} />
        <TasksSection chatId={chatId} />
        <ChangesSection chatId={chatId} />
        <NotesSection chatId={chatId} />
      </div>
      {context && focused && (
        <Tip side="top" label={`How much of ${focused.name}'s working memory this chat fills. It tidies itself up when it gets full.`}>
          <div className="shrink-0 border-t border-line px-4 py-3">
            <ContextMeter context={context} />
          </div>
        </Tip>
      )}
    </aside>
  )
}

// ───────────── one task, in full ─────────────

export function TaskDialog() {
  const taskId = useStore((s) => (s.modal?.kind === 'task' ? s.modal.taskId : null))
  const task = useStore((s) => (taskId && s.chatId ? s.tasks[s.chatId]?.find((t) => t.id === taskId) : undefined))
  const from = useStore((s) => (task ? s.members[task.from] : undefined))
  const to = useStore((s) => (task ? s.members[task.to] : undefined))
  const moved = useStore((s) => (task?.movedFrom ? s.members[task.movedFrom] : undefined))
  const setModal = useStore((s) => s.setModal)
  const setFocus = useStore((s) => s.setFocus)
  const setView = useStore((s) => s.setView)
  const live = task?.status === 'running'
  const elapsed = useElapsed(live ? task?.startedAt : undefined)
  const close = (): void => setModal(null)
  if (!task) return <Modal open={false} onClose={close} title="Task" children={null} />
  const took = task.startedAt && task.finishedAt ? task.finishedAt - task.startedAt : 0
  const label = waitingLabel(task) || { queued: 'Waiting to start', running: 'In progress', done: 'Done', failed: 'Did not finish', cancelled: 'Stopped', interrupted: 'Cut short when the app closed' }[task.status]
  return (
    <Modal open onClose={close} title={task.title} width={620}>
      <div className="overflow-y-auto px-6 pt-2 pb-6" style={accentVars(to?.accent)}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-2">
          <Orb account={from} size={15} />
          <span>{from?.name || 'You'}</span>
          <ArrowRight className="size-3.5 text-ink-4" />
          <Orb account={to} size={15} live={live} />
          <span className="font-medium text-ink">{to?.name}</span>
          <span className="mx-1 text-ink-4">·</span>
          <span className="flex items-center gap-1.5">
            <TaskStatusIcon status={task.status} />
            {label}
            <span className="tabular text-ink-3">{live ? duration(elapsed) : took ? duration(took) : ''}</span>
          </span>
          {runLabel(task) && (
            <>
              <span className="mx-1 text-ink-4">·</span>
              <Tip label={task.modelWhy || 'Chosen for this task by whoever handed it out'}>
                <span className="flex items-center gap-1.5">
                  <Gauge className="size-3.5 text-ink-3" strokeWidth={1.9} /> {runLabel(task)}
                </span>
              </Tip>
            </>
          )}
        </div>
        {moved && (
          <p className="mt-2 text-[12px] text-ink-3">
            {moved.name} started this and ran out of allowance, so {to?.name} picked it up.
          </p>
        )}
        {!!task.after?.length && (
          <p className="mt-2 text-[12px] text-ink-3">
            {task.waitingOn?.length
              ? `Lined up behind ${task.after.join(' and ')}. It starts by itself when ${task.waitingOn.join(' and ')} ${task.waitingOn.length === 1 ? 'is' : 'are'} done, and gets their reports with the brief.`
              : `Started by itself once ${task.after.join(' and ')} ${task.after.length === 1 ? 'was' : 'were'} done, with ${task.after.length === 1 ? 'its report' : 'their reports'} attached to the brief.`}
          </p>
        )}
        <div className="mt-5">
          <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">What was asked</div>
          <div className="rounded-[12px] bg-surface-2 px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
            <Markdown text={task.brief} compact />
          </div>
        </div>
        {task.result && (
          <div className="mt-5">
            <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">{task.status === 'done' ? 'Report' : 'What happened'}</div>
            <Markdown text={task.result} compact />
          </div>
        )}
        <div className="mt-6 flex gap-2">
          <Button
            variant="primary"
            onClick={() => {
              close()
              setFocus(task.to)
              setView('chat')
            }}
          >
            {to ? `See ${to.name}'s work` : 'See the work'}
          </Button>
          {(task.status === 'running' || task.status === 'queued') && (
            <Button variant="ghost" onClick={() => void api.cancelTask(task.chatId, task.id)}>
              Cancel task
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ───────────── one file's changes ─────────────

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
  a?: number
  b?: number
}

function parseDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = []
  let a = 0
  let b = 0
  let body = false
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
      a = m ? Number(m[1]) : 0
      b = m ? Number(m[2]) : 0
      body = true
      out.push({ kind: 'hunk', text: line.replace(/^@@[^@]*@@ ?/, '') })
    } else if (!body) continue
    else if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), b: b++ })
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), a: a++ })
    else if (line.startsWith('\\')) continue
    else out.push({ kind: 'ctx', text: line.slice(1), a: a++, b: b++ })
  }
  return out
}

export function DiffDialog() {
  const target = useStore((s) => (s.modal?.kind === 'diff' ? s.modal : null))
  const cwd = useStore((s) => s.chats.find((c) => c.id === target?.chatId)?.cwd)
  const setModal = useStore((s) => s.setModal)
  const [raw, setRaw] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    setRaw(null)
    let live = true
    void api.fileDiff(target.chatId, target.path).then(
      (d) => live && setRaw(d),
      () => live && setRaw(''),
    )
    return () => {
      live = false
    }
  }, [target])

  const lines = useMemo(() => (raw ? parseDiff(raw) : []), [raw])
  const close = (): void => setModal(null)
  if (!target) return <Modal open={false} onClose={close} title="Changes" children={null} />
  const { dir, name } = splitPath(target.path)
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  const full = cwd ? `${cwd.replace(/[\\/]+$/, '')}/${target.path}` : target.path

  return (
    <Modal open onClose={close} title={name} bare width={880}>
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line pr-3 pl-5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">
            {name}
            {dir && <span className="ml-2 font-normal text-ink-3">{dir}</span>}
          </div>
        </div>
        {raw !== null && (added > 0 || removed > 0) && (
          <span className="tabular shrink-0 font-mono text-[11.5px]">
            <span className="text-ok">+{added}</span>
            <span className="ml-1.5 text-bad">−{removed}</span>
          </span>
        )}
        <IconButton label="Open the file" onClick={() => void api.openPath(full)}>
          <ExternalLink className="size-[14px]" />
        </IconButton>
        <IconButton label="Show in folder" onClick={() => void api.showInFolder(full)}>
          <FolderOpen className="size-[14px]" />
        </IconButton>
      </div>
      <div className="min-h-[200px] flex-1 overflow-auto bg-[var(--code-bg)]">
        {raw === null ? (
          <div className="flex h-[200px] items-center justify-center gap-2 text-[13px] text-ink-3">
            <Spinner /> Reading the changes…
          </div>
        ) : !lines.length ? (
          <div className="flex h-[200px] items-center justify-center px-8 text-center text-[13px] text-ink-3">There is nothing to show for this file. It may be unchanged, binary, or too large.</div>
        ) : (
          <table className="selectable w-full border-collapse font-mono text-[12px] leading-[1.6]">
            <tbody>
              {lines.map((l, i) =>
                l.kind === 'hunk' ? (
                  <tr key={i} className="bg-hover text-ink-3">
                    <td colSpan={3} className="px-4 py-1 text-[11.5px]">
                      {l.text || '…'}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={cn(l.kind === 'add' && 'bg-ok-soft', l.kind === 'del' && 'bg-bad-soft')}>
                    <td className="tabular w-[1%] min-w-10 px-2 text-right text-[11px] whitespace-nowrap text-ink-4 select-none">{l.a ?? ''}</td>
                    <td className="tabular w-[1%] min-w-10 px-2 text-right text-[11px] whitespace-nowrap text-ink-4 select-none">{l.b ?? ''}</td>
                    <td className="pr-4 pl-2 whitespace-pre">
                      <span className={cn('mr-2 inline-block w-2 select-none', l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-bad' : 'text-transparent')}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                      {l.text || ' '}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  )
}
