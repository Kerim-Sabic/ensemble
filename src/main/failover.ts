// Watches every account's usage and moves work on before an account fails, or as soon as it has.
//
// It decides *when* and *whether*; the hub does the moving (who takes over, what is passed on).
// The rules that keep it calm:
// - An account counts as running low near the end of its session or weekly window, and as out once
//   it is used up (shared/failover.ts). Both come from the usage the providers report, the periodic
//   refresh, and a timer at each refill.
// - A lead that is out hands over at once to the best placed teammate. One that is only running low
//   hands over at a turn boundary, only while something is under way, and only to a teammate that
//   is itself fine. A lead in the middle of a reply is never cut off: the end of that reply decides.
// - Never twice in quick succession for a lead that is only low, never to an account that is out,
//   and when everyone is out the chat is told once, with the earliest refill.
// - Handing back to the old lead when it refills is offered with one click, never done silently:
//   the new lead has the chat's context by then, and switching back costs it.

import type { Account, Chat, Settings, Supply } from '@shared/types'

export interface FailoverHost {
  settings(): Settings
  chats(): Iterable<Chat>
  lead(chat: Chat): Account | null
  supply(id: string): Supply
  /** Works an account's state out again and tells the window if it changed. */
  recheck(id: string): Supply
  /** The agent is in the middle of a reply. */
  busy(chat: Chat, a: Account): boolean
  /** Something is under way for the lead in this chat: tasks out, reports waiting, a queued message, a goal in play. */
  underWay(chat: Chat, a: Account): boolean
  /** The teammate best placed to take over. `strict`: only one that is itself fine. */
  successor(chat: Chat, lead: Account, strict: boolean): Account | null
  handOver(chat: Chat, from: Account, to: Account, why: 'out' | 'low', until: number | null): void
  /** Everyone is out: one line in the chat, with when the first account refills. */
  allOut(chat: Chat, lead: Account): void
  /** The old lead has allowance again: the handover row offers to hand back. */
  coverBack(chat: Chat): void
  /** A wait in the engine's own time (scaled in demo mode). */
  wait(ms: number): number
}

/** A lead that is only running low does not hand over again within this long of the last handover. */
const LOW_GAP_MS = 2 * 60_000

export class Failover {
  /** The last state seen for each account. */
  private last = new Map<string, Supply['state']>()
  /** A timer at each account's refill, so its state changes back without anything being reported. */
  private timers = new Map<string, NodeJS.Timeout>()
  /** Chats already told that everyone is out, until something refills. */
  private told = new Set<string>()
  /** When each chat last handed over by itself. */
  private lastAt = new Map<string, number>()

  constructor(private host: FailoverHost) {}

  private get on(): boolean {
    return this.host.settings().handover !== false
  }

  /** An account's usage changed (a report from a provider, a refresh, a refill). */
  observe(id: string): void {
    const s = this.host.supply(id)
    const was = this.last.get(id) || 'ok'
    this.last.set(id, s.state)
    this.arm(id, s)
    if (was === s.state) return
    if (s.state === 'ok') return this.refilled(id)
    for (const chat of this.host.chats()) if (this.host.lead(chat)?.id === id) this.considerLead(chat)
  }

  /** Looks at every account again: windows refill with nothing reported. */
  sweep(ids: string[]): void {
    for (const id of ids) {
      this.host.recheck(id)
      this.observe(id)
    }
  }

  private arm(id: string, s: Supply): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    if (s.state === 'ok' || !s.until) return
    const ms = Math.min(2 ** 31 - 1, Math.max(1000, s.until - Date.now() + 1000))
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        this.host.recheck(id)
        this.observe(id)
      }, ms),
    )
  }

  /**
   * Whether the chat's lead should hand over now, and if so to whom; does it. `hit`: a reply just
   * ended on the usage limit, so the lead is out whatever was last reported. `need`: there is work
   * for the lead right now (a message, a report). Returns true when it handed over.
   */
  considerLead(chat: Chat, o: { hit?: boolean; need?: boolean } = {}): boolean {
    if (!this.on) return false
    const lead = this.host.lead(chat)
    if (!lead) return false
    let s = this.host.supply(lead.id)
    if (o.hit && s.state !== 'out') s = { state: 'out', until: s.until }
    if (s.state === 'ok') return false
    // Never cut a reply off: the end of it decides.
    if (this.host.busy(chat, lead)) return false
    if (!o.need && !this.host.underWay(chat, lead)) return false
    const at = this.lastAt.get(chat.id)
    if (s.state === 'low' && at && Date.now() - at < this.host.wait(LOW_GAP_MS)) return false
    const next = this.host.successor(chat, lead, s.state === 'low')
    if (!next) {
      if (s.state === 'out' && !this.told.has(chat.id)) {
        this.told.add(chat.id)
        this.host.allOut(chat, lead)
      }
      return false
    }
    this.lastAt.set(chat.id, Date.now())
    this.told.delete(chat.id)
    this.host.handOver(chat, lead, next, s.state, s.until)
    return true
  }

  /** The lead is about to be given a message: hand over first if it is out or running low. */
  beforeSend(chat: Chat, lead: Account): Account | null {
    if (!this.on || this.host.supply(lead.id).state === 'ok') return null
    return this.considerLead(chat, { need: true }) ? this.host.lead(chat) : null
  }

  private refilled(id: string): void {
    // Something has allowance again: a later outage is worth telling about.
    this.told.clear()
    for (const chat of this.host.chats()) {
      const c = chat.cover
      if (c && c.from === id && !c.back && this.host.lead(chat)?.id === c.to) this.host.coverBack(chat)
      // A chat whose lead is still out, with work waiting on it: whoever refilled takes over.
      const lead = this.host.lead(chat)
      if (lead && lead.id !== id && this.host.supply(lead.id).state === 'out') this.considerLead(chat)
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
