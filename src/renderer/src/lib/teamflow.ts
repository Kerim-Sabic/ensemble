// What passed between you and the team, and who was working when, worked out
// from the transcripts. Nothing here is stored: it is a reading of what is
// already on record, so it is always in step with the chats themselves.

import type { AgentState, Item, TaskStatus } from '@shared/types'

export type BeatKind = 'said' | 'reply' | 'task' | 'report' | 'note' | 'question' | 'answer' | 'joined'

/** One thing that went from someone to someone. `from` and `to` are account ids, or 'you'. */
export interface Beat {
  id: string
  ts: number
  kind: BeatKind
  from: string
  to: string
  title?: string
  text: string
  status?: TaskStatus
  taskId?: string
  /** Whose transcript shows it. */
  home: string
  /** A question nobody has answered yet. */
  open?: boolean
}

export const YOU = 'you'

/**
 * Everything that crossed between two parties in a chat, oldest first. A handoff
 * is recorded once, from the transcript of whoever sent it.
 */
export function teamBeats(byAccount: Record<string, Item[]>, leadId: string | undefined): Beat[] {
  const out: Beat[] = []
  for (const [me, items] of Object.entries(byAccount)) {
    let trigger: 'user' | 'task' | 'result' | 'message' | 'question' | '' = ''
    let said = ''
    for (const it of items) {
      switch (it.kind) {
        case 'user':
          trigger = 'user'
          said = ''
          if (it.text.trim()) out.push({ id: it.id, ts: it.ts, kind: 'said', from: YOU, to: me, text: it.text, home: me })
          break
        case 'peer':
          trigger = it.tag
          said = ''
          if (it.tag === 'result') out.push({ id: it.id, ts: it.ts, kind: 'report', from: it.from, to: me, title: it.title, text: it.text, status: it.status, taskId: it.taskId, home: me })
          else if (it.tag === 'message') out.push({ id: it.id, ts: it.ts, kind: 'note', from: it.from, to: me, text: it.text, home: me })
          break
        case 'delegate':
          out.push({ id: it.id, ts: it.ts, kind: 'task', from: me, to: it.to, title: it.title, text: it.brief, taskId: it.taskId, home: it.to })
          break
        case 'spawn':
          out.push({ id: it.id, ts: it.ts, kind: 'joined', from: me, to: it.agentId, title: it.name, text: it.role, home: me })
          break
        case 'ask':
          out.push({ id: it.id, ts: it.ts, kind: 'question', from: me, to: it.to, text: it.text, home: me, open: it.status === 'waiting' })
          if (it.status === 'answered' && it.answer) out.push({ id: `${it.id}-a`, ts: it.ts + (it.durationMs || 1), kind: 'answer', from: it.to, to: me, text: it.answer, home: me })
          break
        case 'assistant':
          if (it.text.trim()) said = it.text
          break
        case 'turn':
          // What an agent says at the end of a turn you started is its reply to you; so is the
          // lead's word after a report comes in. A teammate's last word on a task is its report.
          if (said && it.status !== 'error' && (trigger === 'user' || (me === leadId && trigger === 'result'))) {
            out.push({ id: it.id, ts: it.ts, kind: 'reply', from: me, to: YOU, text: said, home: me })
          }
          trigger = ''
          said = ''
          break
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

export interface Span {
  id: string
  accountId: string
  start: number
  end: number
  live?: boolean
  /** What the turn was for. */
  label: string
  kind: 'you' | 'task' | 'report' | 'talk'
}

/** Every stretch of work each agent did: one bar per turn, plus the one in progress. */
export function turnSpans(byAccount: Record<string, Item[]>, states: Record<string, AgentState | undefined>, now: number): Span[] {
  const out: Span[] = []
  for (const [me, items] of Object.entries(byAccount)) {
    let label = 'Working'
    let kind: Span['kind'] = 'you'
    for (const it of items) {
      if (it.kind === 'user') {
        label = 'Answering you'
        kind = 'you'
      } else if (it.kind === 'peer') {
        if (it.tag === 'task') {
          label = it.title || 'A task'
          kind = 'task'
        } else if (it.tag === 'result') {
          label = `Reading the report on "${it.title || 'a task'}"`
          kind = 'report'
        } else {
          label = it.tag === 'question' ? 'Answering a question' : 'Reading a note'
          kind = 'talk'
        }
      } else if (it.kind === 'turn' && it.durationMs > 0) {
        out.push({ id: it.id, accountId: me, start: it.ts - it.durationMs, end: it.ts, label, kind })
      }
    }
    const st = states[me]
    if (st?.turnStartedAt && st.phase !== 'idle' && st.phase !== 'error') {
      out.push({ id: `live-${me}`, accountId: me, start: st.turnStartedAt, end: Math.max(now, st.turnStartedAt + 500), live: true, label: st.activity || label, kind })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

export interface Timeline {
  width: number
  x(t: number): number
  /** Quiet stretches that were squeezed out, and how long each was. */
  breaks: { x: number; gap: number }[]
  /** The most agents that were ever working at one moment. */
  peak: number
}

/**
 * Lays work out left to right in time, squeezing out the quiet stretches so
 * that an hour's pause between two bursts does not push them off the screen.
 */
export function layoutTimeline(spans: Span[], room: number): Timeline | null {
  if (!spans.length) return null
  const GAP = 20_000
  const BREAK = 30
  const clusters: { start: number; end: number }[] = []
  for (const s of spans) {
    const last = clusters[clusters.length - 1]
    if (last && s.start <= last.end + GAP) last.end = Math.max(last.end, s.end)
    else clusters.push({ start: s.start, end: s.end })
  }
  const active = clusters.reduce((ms, c) => ms + (c.end - c.start), 0) / 1000
  const free = Math.max(120, room - 24 - (clusters.length - 1) * BREAK)
  // Fill the room when there is little to show; let long sessions scroll instead of shrinking to nothing.
  const pps = Math.min(16, Math.max(1.6, free / Math.max(active, 8)))
  const placed: { start: number; end: number; x: number; w: number }[] = []
  const breaks: Timeline['breaks'] = []
  let x = 12
  clusters.forEach((c, i) => {
    const w = Math.max(((c.end - c.start) / 1000) * pps, 18)
    placed.push({ ...c, x, w })
    x += w
    if (i < clusters.length - 1) {
      breaks.push({ x: x + BREAK / 2, gap: clusters[i + 1].start - c.end })
      x += BREAK
    }
  })
  // How many were at work at once, at most.
  const edges = spans.flatMap((s) => [
    [s.start, 1],
    [s.end, -1],
  ]) as [number, number][]
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let peak = 0
  let n = 0
  for (const [, d] of edges) {
    n += d
    peak = Math.max(peak, n)
  }
  return {
    width: x + 12,
    breaks,
    peak,
    x(t: number): number {
      for (const c of placed) {
        if (t <= c.end) return c.x + (Math.max(0, t - c.start) / Math.max(1, c.end - c.start)) * c.w
      }
      const last = placed[placed.length - 1]
      return last.x + last.w
    },
  }
}

export function gapLabel(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  return `${Math.round(h / 24)} d`
}
