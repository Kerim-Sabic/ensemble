import { memo, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronRight, CircleDot, CircleHelp, ClipboardCopy, FileText, FolderOpen, ShieldCheck, SquareTerminal, UserCheck, X } from 'lucide-react'
import type { Item } from '@shared/types'
import { evidenceLine, evidenceShown, evidenceStamp, evidenceWanted, type Evidence, type EvidenceRef, type ReplyEnd } from '@shared/trace'
import { agentKey, useStore } from '@/store'
import { api, cn, duration } from '@/lib/util'
import { rendered } from '@/lib/perf'

// Evidence: what changed, what ran, what passed and what is still uncertain, drawn from the
// record of what the team actually did. One quiet line under a result; it opens in place.

const cache = new Map<string, Evidence>()
const keyOf = (chatId: string, ref: EvidenceRef): string => `${chatId}|${JSON.stringify(ref)}`

/**
 * The evidence for a reply, a task or the goal. null until it has been read. `stamp` is what it
 * depends on (see evidenceStamp): when it changes, because a goal was checked, a task reported or
 * more was done, it is read again. What was read before stays on screen until the new one is in.
 */
export function useEvidence(chatId: string, ref: EvidenceRef | null, on = true, stamp = ''): Evidence | null {
  const k = ref ? `${keyOf(chatId, ref)}|${stamp}` : ''
  const [ev, setEv] = useState<Evidence | null>(() => (k ? cache.get(k) || null : null))
  useEffect(() => {
    if (!ref || !on) return
    const hit = cache.get(k)
    if (hit) {
      setEv(hit)
      return
    }
    let live = true
    // A burst of records (a team at work) is read once, a moment after it settles.
    const t = setTimeout(
      () =>
        api.evidence(chatId, ref).then(
          (e) => {
            cache.set(k, e)
            if (cache.size > 200) cache.delete(cache.keys().next().value as string)
            if (live) setEv(e)
          },
          () => undefined,
        ),
      stamp ? 350 : 0,
    )
    return () => {
      live = false
      clearTimeout(t)
    }
    // The ref is rebuilt on every render; its text is what identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, k, on])
  return ev
}

/** How many transcript rows a chat has across everyone in it: one more means more was recorded. */
function rowsIn(items: Record<string, Item[]>, chatId: string): number {
  let n = 0
  const pre = `${chatId}:`
  for (const k in items) if (k.startsWith(pre)) n += items[k].length
  return n
}

/** A path as the person knows it: inside the chat's folder it is shown from there. */
function shortPath(p: string, cwd: string | undefined): { shown: string; rel: string | null } {
  const norm = (s: string): string => s.replace(/\\/g, '/')
  const a = norm(p)
  const c = cwd ? norm(cwd).replace(/\/+$/, '') : ''
  if (c && a.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return { shown: a.slice(c.length + 1), rel: a.slice(c.length + 1) }
  if (!/^([a-zA-Z]:)?\//.test(a)) return { shown: a, rel: a }
  return { shown: a, rel: null }
}

function Section({ icon, title, count, tone, children }: { icon: React.ReactNode; title: string; count: number; tone?: 'ok' | 'warn'; children: React.ReactNode }) {
  if (!count) return null
  return (
    <div className="py-2">
      <div className="flex items-center gap-1.5 pb-1 text-[11.5px] font-semibold text-ink-2">
        <span className={cn('flex size-4 items-center justify-center', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-ink-3')}>{icon}</span>
        {title}
        <span className="tabular font-normal text-ink-4">{count}</span>
      </div>
      <div className="space-y-0.5 pl-[22px]">{children}</div>
    </div>
  )
}

/** The four lists, opened. */
export function EvidenceDetail({ chatId, ev }: { chatId: string; ev: Evidence }) {
  const cwd = useStore((s) => s.chats.find((c) => c.id === chatId)?.cwd)
  const changes = useStore((s) => s.changes[chatId]?.files)
  const setModal = useStore((s) => s.setModal)
  const toast = useStore((s) => s.toast)
  const many = ev.agents.length > 1
  const stat = (rel: string | null): { added?: number; removed?: number } | undefined => (rel ? changes?.find((f) => f.path.replace(/\\/g, '/').toLowerCase() === rel.toLowerCase()) : undefined)
  const copy = async (): Promise<void> => {
    try {
      const recs = await api.trace(chatId, { since: ev.from, until: ev.to })
      await navigator.clipboard.writeText(recs.map((r) => JSON.stringify(r)).join('\n'))
      toast(`Copied ${recs.length} trace records.`)
    } catch {
      toast('The trace could not be copied.', 'warn')
    }
  }
  return (
    <div className="divide-y divide-line px-3 pb-1 text-[12.5px]">
      <Section icon={<FileText className="size-3.5" strokeWidth={1.9} />} title="Changed" count={ev.changed.length}>
        {ev.changed.slice(0, 40).map((f) => {
          const sp = shortPath(f.path, cwd)
          const st = stat(sp.rel) as { added?: number; removed?: number } | undefined
          return (
            <button
              key={f.path}
              disabled={!sp.rel || !st}
              onClick={() => sp.rel && setModal({ kind: 'diff', chatId, path: sp.rel })}
              title={st ? 'Show what changed in this file' : undefined}
              className="flex w-full items-baseline gap-2 rounded-[6px] px-1 py-0.5 text-left enabled:hover:bg-hover"
            >
              <span className="min-w-0 truncate font-mono text-[12px] text-ink">{sp.shown}</span>
              {st && (st.added || st.removed) ? (
                <span className="tabular shrink-0 text-[11px]">
                  <span className="text-ok">+{st.added || 0}</span> <span className="text-bad">-{st.removed || 0}</span>
                </span>
              ) : null}
              <span className="ml-auto shrink-0 text-[11px] text-ink-4">
                {[f.edits > 1 ? `${f.edits} edits` : '', many ? f.by.join(', ') : ''].filter(Boolean).join(' · ')}
              </span>
            </button>
          )
        })}
        {ev.changed.length > 40 && <div className="px-1 text-[11.5px] text-ink-4">and {ev.changed.length - 40} more</div>}
      </Section>
      <Section icon={<SquareTerminal className="size-3.5" strokeWidth={1.9} />} title="Ran" count={ev.ran.length}>
        {ev.ran.slice(-30).map((r, i) => (
          <div key={`${r.ts}:${i}`} className="flex items-baseline gap-2 px-1 py-0.5">
            <span className={cn('flex size-3 shrink-0 translate-y-[1px] items-center justify-center', r.ok ? 'text-ok' : 'text-bad')}>{r.ok ? <Check className="size-3" strokeWidth={2.6} /> : <X className="size-3" strokeWidth={2.6} />}</span>
            <span className="selectable min-w-0 truncate font-mono text-[12px] text-ink" title={r.command}>
              {r.command}
            </span>
            <span className="tabular ml-auto shrink-0 text-[11px] text-ink-4">
              {[r.ok ? '' : 'failed', r.ms && r.ms >= 1000 ? duration(r.ms) : '', many ? r.by : ''].filter(Boolean).join(' · ')}
            </span>
          </div>
        ))}
        {ev.ran.length > 30 && <div className="px-1 text-[11.5px] text-ink-4">the last 30 of {ev.ran.length}</div>}
      </Section>
      <Section icon={<Check className="size-3.5" strokeWidth={2.4} />} title="Passed" count={ev.passed.length} tone="ok">
        {ev.passed.map((p, i) => (
          <div key={`${p.ts}:${i}`} className="px-1 py-0.5">
            <span className="text-ink">{p.what}</span>
            {p.detail && <span className="selectable ml-2 text-[11.5px] text-ink-3">{p.detail}</span>}
          </div>
        ))}
      </Section>
      <Section icon={<UserCheck className="size-3.5" strokeWidth={1.9} />} title="Reviewed" count={(ev.reviewed || []).length}>
        {(ev.reviewed || []).map((r, i) => (
          <div key={`${r.ts}:${i}`} className={cn('flex items-baseline gap-2 px-1 py-0.5', r.earlier && 'opacity-70')}>
            <span className={cn('flex size-3 shrink-0 translate-y-[1px] items-center justify-center', r.ok ? 'text-ok' : r.earlier ? 'text-ink-4' : 'text-warn')}>{r.ok ? <Check className="size-3" strokeWidth={2.6} /> : <CircleDot className="size-3" strokeWidth={2.2} />}</span>
            <span className="min-w-0">
              <span className="text-ink">
                {r.by}
                <span className="text-ink-3"> · {r.what}{r.earlier ? ' · earlier round' : ''}</span>
              </span>
              <span className="selectable block text-[11.5px] leading-snug text-ink-3">{r.verdict}</span>
            </span>
          </div>
        ))}
      </Section>
      <Section icon={<CircleHelp className="size-3.5" strokeWidth={1.9} />} title="Uncertain" count={ev.uncertain.length} tone="warn">
        {ev.uncertain.map((u, i) => (
          <div key={i} className="px-1 py-0.5">
            <span className="text-ink">{u.what}</span>
            {u.detail && <span className="selectable ml-2 text-[11.5px] text-ink-3">{u.detail}</span>}
          </div>
        ))}
      </Section>
      <div className="flex items-center gap-1 pt-1.5 pb-1 text-[11.5px] text-ink-3">
        <span className="min-w-0 flex-1 truncate">From the record of what was done, not from what was said{ev.models.length ? ` · ${ev.models.length === 1 ? ev.models[0] : `${ev.models.length} models`}` : ''}</span>
        <button onClick={() => void copy()} className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 hover:bg-hover hover:text-ink">
          <ClipboardCopy className="size-3" /> Copy trace
        </button>
        <button onClick={() => void api.tracePath(chatId).then((p) => api.showInFolder(p))} className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 hover:bg-hover hover:text-ink">
          <FolderOpen className="size-3" /> Open trace file
        </button>
      </div>
    </div>
  )
}

/** One line of evidence that opens in place. Shows nothing while there is nothing to show. */
export const EvidenceBlock = memo(function EvidenceBlock({ chatId, evidenceRef, className, defaultOpen, end, stamp }: { chatId: string; evidenceRef: EvidenceRef; className?: string; defaultOpen?: boolean; end?: ReplyEnd; stamp?: string }) {
  const ev = useEvidence(chatId, evidenceRef, true, stamp)
  const [open, setOpen] = useState(!!defaultOpen)
  const line = ev ? evidenceLine(ev) : ''
  if (!ev || !line || (end && !evidenceShown(end, ev))) return null
  const unsure = ev.uncertain.length
  return (
    <div data-evidence className={cn('animate-fade-in overflow-hidden rounded-[12px] bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]', className)}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-8 w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-hover">
        <ShieldCheck className={cn('size-3.5 shrink-0', unsure ? 'text-ink-3' : 'text-ok')} strokeWidth={1.9} />
        <span className="shrink-0 font-semibold text-ink-2">Evidence</span>
        <span className="min-w-0 flex-1 truncate text-ink-3">
          {line.split(' · ').map((part, i) => (
            <span key={i}>
              {i > 0 && <span className="text-ink-4"> · </span>}
              <span className={cn(/unverified$/.test(part) ? 'font-medium text-warn' : / passed$| is met$|^reviewed by /.test(part) ? 'text-ok' : undefined)}>{part}</span>
            </span>
          ))}
        </span>
        <ChevronRight className={cn('size-3.5 shrink-0 text-ink-4 transition-transform duration-200', open && 'rotate-90')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <EvidenceDetail chatId={chatId} ev={ev} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

/**
 * Evidence under a finished reply. Read by itself for an agent's latest reply; for older replies
 * it is read when asked for, so a long chat does not read its trace a hundred times.
 */
/** Older replies whose evidence was asked for. */
const askedFor = new Set<string>()

export const TurnEvidence = memo(function TurnEvidence({ item, chatId, accountId }: { item: Extract<Item, { kind: 'turn' }>; chatId: string; accountId: string }) {
  rendered('TurnEvidence')
  const latest = useStore((s) => {
    const list = s.items[agentKey(chatId, accountId)]
    if (!list) return false
    for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === 'turn') return list[i].id === item.id
    return false
  })
  // Kept by the reply, so scrolling it out of view and back does not close it again.
  const [asked, setAskedNow] = useState(() => askedFor.has(item.id))
  const setAsked = (v: boolean): void => {
    if (v) askedFor.add(item.id)
    setAskedNow(v)
  }
  // The latest reply's evidence follows what happens after it: the goal's check, reports coming
  // in, more work recorded. An older reply's is read once, when asked for.
  const stamp = useStore((s) => (latest ? evidenceStamp({ goal: s.chats.find((c) => c.id === chatId)?.goal, tasks: s.tasks[chatId] || [], records: rowsIn(s.items, chatId) }) : ''))
  // A finished reply with no steps did nothing there could be evidence of; a stopped or failed one is always looked at.
  if (!evidenceWanted(item)) return null
  if (!latest && !asked) {
    return (
      <button onClick={() => setAsked(true)} className="-mt-2 mb-3 flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] text-ink-4 transition-colors hover:bg-hover hover:text-ink">
        <ShieldCheck className="size-3" /> Evidence
      </button>
    )
  }
  return <EvidenceBlock chatId={chatId} evidenceRef={{ kind: 'turn', accountId, itemId: item.id }} className="-mt-1 mb-4" defaultOpen={asked} end={item} stamp={stamp} />
})
