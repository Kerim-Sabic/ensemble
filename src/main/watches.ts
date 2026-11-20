// Watches: small jobs Ensemble runs by itself, by the clock or when something changes, and the
// inbox where what they find (and anything that needs the user) arrives.
//
// What this is built around, from what went wrong elsewhere (OpenClaw):
//  - A look costs nothing when nothing changed. Each run first takes a fingerprint of what its
//    trigger sees and compares it with the last one, with no model at all. Only a change (or a
//    scheduled look whose prompt needs thinking) leads to ONE short, tool-less answer from the
//    cheapest model of one account, with a small fixed context that never grows with the runs.
//  - Nothing fails silently: every run is recorded with its outcome; three failures in a row
//    pause the watch and put a 'failed' item in the inbox.
//  - Nothing runs twice: one timer for all watches, a run claims its due time before it starts,
//    a watch already running is not started again, and a run that began under an older version of
//    a watch (changed or removed meanwhile) is thrown away.
//  - Missed runs (the app closed, the computer asleep) are recorded as missed; one run is made on
//    return if one was due, never a burst.
//  - Limits: the watch's hours, the user's own work coming first, the unattended caps of the gate
//    (daily runs, accounts running low), a hard time limit per run, and a bounded team chat.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { HubEvent } from '@shared/types'
import type { GhList } from '@shared/github'
import { parseAddress } from '@shared/github'
import {
  DEFAULT_CAPS,
  LOCAL_ZONE,
  MIN_EVERY_MINUTES,
  WATCH_CONTEXT,
  WATCH_FAILURES_PAUSE,
  WATCH_RUN_MS,
  WATCH_RUNS_KEPT,
  WATCH_SYSTEM,
  dueTimes,
  fingerprint,
  inHours,
  nextDue,
  parseAt,
  readAnswer,
  steadyText,
  triggerLine,
  watchPrompt,
  type InboxItem,
  type UnattendedCaps,
  type UnattendedGate,
  type Watch,
  type WatchInput,
  type WatchOutcome,
  type WatchRun,
  type WatchTrigger,
  type Zone,
} from '@shared/watches'
import { readJson, uid, writeJson } from './util'

export interface WatchHost {
  dataDir: string
  demo: boolean
  now(): number
  /** The local clock; the computer's own unless a check sets one. */
  zone?: Zone
  emit(ev: HubEvent): void
  /** A desktop notice for new inbox items. The hub decides on the settings switch and the window being in front. */
  notify(title: string, body: string, chatId?: string): void
  /** Who may pay for an unattended run, and the daily caps. */
  gate(): UnattendedGate
  /** One short answer from the cheapest model of that account, with no tools and no history. */
  ask(accountId: string, system: string, prompt: string, signal: AbortSignal): Promise<{ text: string; model?: string }>
  /** The user's own work is running (a reply under way in a chat no watch started). */
  busy(): boolean
  /** Hands a finding to the team: a new chat in Verified, with a bounded goal and chat.watchId set. Returns its id. */
  handTo(w: Watch, title: string, body: string, accountId: string): Promise<string | undefined>
  /** A team chat a watch started is still working: watches hand over one at a time, so the next finding is told, not handed. */
  teamBusy?(): boolean
  /** GitHub, read only (src/main/github.ts). */
  github: { list(q: { cwd?: string | null; address?: string | null }): Promise<GhList> }
  /** Overrides for the demo and the checks. */
  fetchText?(url: string, signal: AbortSignal): Promise<string>
  runCommand?(command: string, cwd: string | undefined, signal: AbortSignal): Promise<string>
}

interface Store {
  watches: Watch[]
  clock?: number
  teamStarts?: number[]
}

/** The most kept in the inbox; done items go first. */
const INBOX_KEPT = 300
/** How late a due time may be before it counts as missed. */
const LATE_MS = 10 * 60_000
/** When the user's own work is running, a run waits this long and tries again (a few times at most). */
const BUSY_WAIT_MS = 10 * 60_000
const BUSY_TRIES = 3
/** Read at most this much of a page or a command's output. */
const LOOK_BYTES = 400_000
/** Lines remembered from a page or an output, as fingerprints, to tell what is new. */
const ITEMS_KEPT = 600
/** The audit file of runs, before it is started afresh. */
const AUDIT_BYTES = 1_000_000

const now0 = (): number => Date.now()

export class Watches {
  private watches: Watch[] = []
  private inboxItems: InboxItem[] = []
  /** Watches with a run under way, and since when: a watch is never run twice at once. */
  private running = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private notes: InboxItem[] = []
  private noteTimer: NodeJS.Timeout | null = null
  private busyTries = new Map<string, number>()
  private started = false
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false
  private ticks = 0
  private checkpointed = false
  private lastClock = 0
  private teamStarts: number[] = []
  private handing = false
  private slots = 0
  private slotQueue: (() => void)[] = []
  private aborts = new Set<AbortController>()
  /** Model calls made, for the checks and the window: zero on a quiet day. */
  calls = 0
  /** The size of the last context a model was given, in characters. */
  lastContext = 0

  constructor(
    private host: WatchHost,
    /** Off in checks that drive the clock themselves. */
    private timers = true,
  ) {}

  private get zone(): Zone {
    return this.host.zone || LOCAL_ZONE
  }
  private get now(): number {
    return this.host.now()
  }
  private file(name: string): string {
    return path.join(this.host.dataDir, name)
  }

  // ───────────── the store ─────────────

  /** Reads the watches and the inbox, puts right what a restart leaves, and sets the timer. */
  start(): void {
    const s = readJson<Store>(this.file('watches.json'), { watches: [] })
    this.watches = Array.isArray(s.watches) ? s.watches : []
    this.inboxItems = readJson<{ items: InboxItem[] }>(this.file('inbox.json'), { items: [] }).items || []
    const t = this.now
    this.lastClock = s.clock || t
    this.teamStarts = Array.isArray(s.teamStarts) ? s.teamStarts.filter(Number.isFinite) : []
    this.correctClock(t)
    for (const w of this.watches) {
      // A run that was under way when the app went never finished: its watch is due again now.
      if (w.status === 'active' && w.nextAt == null) w.nextAt = t
      if (w.status !== 'active') w.nextAt = null
    }
    // Approvals do not outlive the app: the request that asked is gone.
    for (const i of this.inboxItems) if (i.approval && !i.done && i.ref?.startsWith('perm:')) i.done = true
    this.started = true
    this.save()
    this.schedule()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.timer = null
    this.flushNotes()
    this.started = false
    for (const abort of this.aborts) abort.abort()
    this.flushSave()
  }

  private save(): void {
    this.dirty = true
    if (this.ticks && this.checkpointed) return
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flushSave(), 50)
    this.saveTimer.unref?.()
  }
  private flushSave(): boolean {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.dirty) return true
    const saved = writeJson(this.file('watches.json'), { watches: this.watches, clock: this.lastClock, teamStarts: this.teamStarts } satisfies Store)
    if (saved) { this.dirty = false; if (this.ticks) this.checkpointed = true }
    return saved
  }
  private correctClock(t: number): void {
    if (t < this.lastClock) {
      for (const w of this.watches) {
        if (w.status !== 'active' || w.nextAt == null) continue
        w.nextAt = Math.min(w.nextAt, nextDue(w.trigger, t, t, this.zone))
        if (w.lastDue != null && w.lastDue > t) w.lastDue = undefined
      }
      this.save()
    }
    this.lastClock = t
  }
  private async enter(): Promise<void> {
    if (this.slots < 4) { this.slots++; return }
    await new Promise<void>(resolve => this.slotQueue.push(resolve))
  }
  private leave(): void {
    const next = this.slotQueue.shift()
    if (next) next()
    else this.slots--
  }
  private saveInbox(): void {
    if (this.inboxItems.length > INBOX_KEPT) {
      const done = this.inboxItems.filter((i) => i.done)
      const cut = new Set(done.slice(INBOX_KEPT / 2).map((i) => i.id))
      this.inboxItems = this.inboxItems.filter((i) => !cut.has(i.id)).slice(0, INBOX_KEPT)
    }
    writeJson(this.file('inbox.json'), { items: this.inboxItems })
  }
  private changed(): void {
    this.save()
    this.host.emit({ type: 'watches', watches: this.list() })
  }
  private inboxChanged(): void {
    this.saveInbox()
    this.host.emit({ type: 'inbox', items: this.inbox() })
  }

  list(): Watch[] {
    return this.watches.map((w) => ({ ...w, runs: [...w.runs] }))
  }
  get(id: string): Watch | undefined {
    return this.watches.find((w) => w.id === id)
  }
  inbox(): InboxItem[] {
    return [...this.inboxItems]
  }

  // ───────────── making and changing watches ─────────────

  /**
   * Makes a watch, or changes one (`input.id`). `by` is who asks: only the user may make a
   * 'command' watch, and a watch an agent makes starts paused until the user confirms it.
   */
  saveWatch(input: WatchInput, by: 'user' | 'agent' = 'user', madeIn?: { chatId: string; accountId: string }): Watch {
    const trigger = checkTrigger(input.trigger, by)
    const name = String(input.name || '').trim().slice(0, 80) || triggerLine(trigger)
    const prompt = String(input.prompt || '').trim().slice(0, WATCH_CONTEXT.prompt)
    if (!prompt) throw new Error('Say what the watch should look for and what is worth telling.')
    const hours = input.hours && input.hours.length === 2 && input.hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 24) ? (input.hours as [number, number]) : undefined
    const t = this.now
    const old = input.id ? this.get(input.id) : undefined
    if (input.id && !old) throw new Error('That watch is not there any more.')
    if (old) {
      if (by === 'agent' && old.madeBy !== 'agent') throw new Error('An agent may change only the watches agents made.')
      const sameTrigger = JSON.stringify(old.trigger) === JSON.stringify(trigger)
      const turningOn = old.status !== 'active' && (input.status ?? old.status) === 'active'
      // An agent cannot turn on what the user has not confirmed.
      const status = by === 'agent' && old.status !== 'active' ? 'paused' : (input.status ?? old.status)
      Object.assign(old, {
        name,
        prompt,
        trigger,
        cwd: input.cwd ?? old.cwd,
        account: input.account ?? old.account,
        hours: input.hours === undefined ? old.hours : hours,
        onFind: input.onFind ?? old.onFind,
        status,
        rev: (old.rev || 0) + 1,
      })
      if (!sameTrigger) {
        old.seen = undefined
        old.seenItems = undefined
        old.lastDue = undefined
      }
      if (turningOn && status === 'active') {
        old.failures = 0
        this.done(`confirm:${old.id}`)
      }
      old.nextAt = old.status === 'active' ? nextDue(old.trigger, t, t, this.zone) : null
      this.changed()
      this.schedule()
      return { ...old }
    }
    const w: Watch = {
      id: uid('w'),
      name,
      prompt,
      trigger,
      cwd: input.cwd || undefined,
      account: input.account || 'auto',
      hours,
      onFind: input.onFind === 'team' ? 'team' : 'tell',
      status: by === 'agent' ? 'paused' : input.status === 'paused' ? 'paused' : 'active',
      createdAt: t,
      nextAt: null,
      runs: [],
      failures: 0,
      rev: 1,
      madeBy: by,
      ...(madeIn ? { madeIn } : {}),
    }
    w.nextAt = w.status === 'active' ? nextDue(w.trigger, t, t, this.zone) : null
    this.watches.push(w)
    if (by === 'agent') {
      this.add({
        kind: 'needs-you',
        ref: `confirm:${w.id}`,
        confirmWatch: w.id,
        watchId: w.id,
        chatId: madeIn?.chatId,
        title: `Turn on the watch "${w.name}"?`,
        body: `An agent set it up: ${triggerLine(w.trigger)}. ${w.prompt}\n\nIt runs by itself and spends allowance when something changes, so it waits for your OK.${w.onFind === 'team' ? ' If it finds something, it may start a team chat. All watches together may start at most three team chats a day, one at a time.' : ''}`,
      })
    }
    this.changed()
    this.schedule()
    return { ...w }
  }

  remove(id: string): void {
    const before = this.watches.length
    this.watches = this.watches.filter((w) => w.id !== id)
    if (this.watches.length === before) return
    this.done(`confirm:${id}`)
    this.changed()
    this.schedule()
  }

  // ───────────── the clock ─────────────

  /** One timer for all watches, set for the earliest due one; none at all when no watch is active. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.timers || !this.started) return
    const due = this.watches.filter((w) => w.status === 'active' && w.nextAt != null).map((w) => w.nextAt as number)
    if (!due.length) return
    const wait = Math.max(1000, Math.min(Math.min(...due) - now0(), 60_000))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick().finally(() => this.schedule())
    }, wait)
    this.timer.unref?.()
  }

  /** Runs every watch that is due. Safe to call from two places at once: a due time is claimed once. */
  async tick(): Promise<void> {
    const t = this.now
    this.correctClock(t)
    const due = this.watches.filter((w) => w.status === 'active' && w.nextAt != null && w.nextAt <= t && !this.running.has(w.id))
    if (this.ticks++ === 0) this.checkpointed = false
    try {
      await Promise.all(due.map((w) => this.runDue(w, false)))
    } finally {
      if (--this.ticks === 0 && this.started) this.flushSave()
    }
  }

  /** Runs a watch now, whatever its schedule (the user asked). Its hours and the caps still hold. */
  async runNow(id: string): Promise<Watch> {
    const w = this.get(id)
    if (!w) throw new Error('That watch is not there any more.')
    if (this.running.has(id)) throw new Error('It is running already.')
    await this.runDue(w, true)
    return { ...(this.get(id) || w) }
  }

  private record(w: Watch, run: Omit<WatchRun, 'id'>): WatchRun {
    const r: WatchRun = { id: uid('r'), ...run }
    w.runs = [r, ...w.runs].slice(0, WATCH_RUNS_KEPT)
    this.audit(w, r)
    return r
  }

  /** One line per run in watches/runs.jsonl: the audit trail of everything the watches did. */
  private audit(w: Watch, r: WatchRun): void {
    try {
      const file = this.file(path.join('watches', 'runs.jsonl'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        if (fs.statSync(file).size > AUDIT_BYTES) fs.renameSync(file, `${file}.1`)
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, `${JSON.stringify({ t: 'watch', ts: r.at, watch: w.id, name: w.name, trigger: w.trigger.kind, outcome: r.outcome, ms: r.ms, model: r.model, account: r.accountId, tokens: r.tokens, chatId: r.chatId, note: r.note })}\n`)
    } catch {
      /* the audit never stops a run */
    }
  }

  private async runDue(w: Watch, byHand: boolean): Promise<void> {
    if (this.running.has(w.id)) return
    const t = this.now
    const due = byHand ? t : (w.nextAt as number)
    // A due time is run once: whoever claims it first runs it.
    if (!byHand && w.lastDue === due) {
      w.nextAt = nextDue(w.trigger, t, due, this.zone)
      return
    }
    this.running.set(w.id, t)
    const rev = w.rev || 0
    await this.enter()
    try {
      if (!this.started || this.get(w.id) !== w || (w.rev || 0) !== rev) return
      if (!byHand) {
        // Missed due times (the app was closed, the computer slept): recorded, and one run now for them all.
        const missed = t - due > LATE_MS ? [due, ...dueTimes(w.trigger, due, t, due, this.zone, 200)].filter((d) => d < t - LATE_MS) : []
        if (missed.length) {
          const shown = missed.slice(-10)
          for (const d of shown) this.record(w, { at: d, ms: 0, outcome: 'missed', note: 'Ensemble was closed or the computer was asleep.' })
          if (missed.length > shown.length) this.record(w, { at: missed[0], ms: 0, outcome: 'missed', note: `${missed.length} looks in all were missed while Ensemble was closed or the computer was asleep.` })
        }
        w.lastDue = due
      }
      w.nextAt = null
      this.save()
      const outcome = await this.runOnce(w, byHand, rev)
      if (outcome === 'stale') return
    } finally {
      this.running.delete(w.id)
      this.leave()
      const live = this.get(w.id)
      if (this.started && live && (live.rev || 0) === rev) {
        if (live.status === 'active' && live.nextAt == null) live.nextAt = nextDue(live.trigger, this.now, live.lastDue ?? live.createdAt, this.zone)
        this.changed()
      }
      this.schedule()
    }
  }

  /** The run itself. Returns 'stale' when the watch was changed or removed while it ran. */
  private async runOnce(w: Watch, byHand: boolean, rev: number): Promise<WatchOutcome | 'stale'> {
    const t0 = this.now
    const stale = (): boolean => !this.started || this.get(w.id) !== w || (w.rev || 0) !== rev
    if (!byHand && !inHours(w.hours, t0, this.zone)) {
      this.record(w, { at: t0, ms: 0, outcome: 'skipped', note: `Outside its hours (${w.hours?.[0]}:00 to ${w.hours?.[1]}:00).` })
      return 'skipped'
    }
    if (!byHand && this.host.busy()) {
      const tries = (this.busyTries.get(w.id) || 0) + 1
      if (tries <= BUSY_TRIES) {
        this.busyTries.set(w.id, tries)
        this.record(w, { at: t0, ms: 0, outcome: 'skipped', note: 'Your own work was running; it tries again in 10 minutes.' })
        w.nextAt = Math.min(t0 + BUSY_WAIT_MS, nextDue(w.trigger, t0, w.lastDue ?? w.createdAt, this.zone))
        return 'skipped'
      }
    }
    this.busyTries.delete(w.id)
    const abort = new AbortController()
    this.aborts.add(abort)
    const limit = setTimeout(() => abort.abort(), WATCH_RUN_MS)
    limit.unref?.()
    try {
      // First step: look and compare, with no model.
      const look = await this.look(w, abort.signal)
      if (stale()) return 'stale'
      const unchanged = look.fp !== undefined && look.fp === w.seen
      if (unchanged || (look.changed !== null && !look.changed.trim() && w.trigger.kind !== 'schedule')) {
        w.seen = look.fp
        if (look.items) w.seenItems = look.items.slice(0, ITEMS_KEPT)
        w.failures = 0
        this.record(w, { at: t0, ms: this.now - t0, outcome: 'quiet', note: unchanged ? 'No change since the last look.' : 'Nothing new since the last look.' })
        return 'quiet'
      }
      // Second step: one short answer from the cheapest model, with a small fixed context.
      const gate = this.host.gate()
      const pick = gate.pick(w.account)
      if (!pick.accountId) {
        this.record(w, { at: t0, ms: this.now - t0, outcome: 'capped', note: pick.why || 'No account may take unattended work right now.' })
        this.cappedNote(pick.why)
        return 'capped'
      }
      const prompt = watchPrompt(w, look.changed || '', this.findings(w))
      this.lastContext = WATCH_SYSTEM.length + prompt.length
      this.calls++
      let answer: { text: string; model?: string } | undefined
      let tokens = Math.ceil((WATCH_SYSTEM.length + prompt.length) / 4)
      try {
        answer = await this.host.ask(pick.accountId, WATCH_SYSTEM, prompt, abort.signal)
        tokens += Math.ceil(answer.text.length / 4)
      } finally {
        // Allowance was spent even if the watch changed, was removed, or the model failed.
        gate.record(pick.accountId, { ms: this.now - t0, turns: 1, tokens })
      }
      if (stale()) return 'stale'
      const ms = this.now - t0
      const read = readAnswer(answer.text)
      if (!read) throw new Error('The answer could not be read (it was neither QUIET nor a finding).')
      w.seen = look.fp
      if (look.items) w.seenItems = look.items.slice(0, ITEMS_KEPT)
      w.failures = 0
      const base = { at: t0, ms, model: answer.model, accountId: pick.accountId, tokens }
      if (read.quiet) {
        this.record(w, { ...base, outcome: 'quiet', note: 'Looked: nothing worth telling.' })
        return 'quiet'
      }
      const fresh = this.add({ kind: 'found', ref: `found:${w.id}:${read.title.toLowerCase()}`, watchId: w.id, title: read.title, body: read.body })
      let chatId: string | undefined
      let teamAccountId: string | undefined
      // Asked before the handoff is tried: was another watch's team chat still working?
      const teamWasBusy = !!fresh && w.onFind === 'team' && (this.handing || !!this.host.teamBusy?.())
      if (fresh && w.onFind === 'team') {
        const handoff = await this.handTo(w, read.title, read.body)
        chatId = handoff?.chatId
        teamAccountId = handoff?.accountId
        if (chatId) {
          fresh.chatId = chatId
          this.inboxChanged()
        }
      }
      this.record(w, { ...base, outcome: chatId ? 'handed' : 'found', note: fresh ? `${read.title}${teamWasBusy && !chatId ? ' (told, not handed to the team: another team chat a watch started was still working)' : ''}` : `${read.title} (already in the inbox)`, ...(chatId ? { chatId, teamAccountId } : {}) })
      return chatId ? 'handed' : 'found'
    } catch (e) {
      if (stale()) return 'stale'
      const why = abort.signal.aborted ? `It took longer than ${Math.round(WATCH_RUN_MS / 1000)} s and was stopped.` : oneLine((e as Error).message || 'It failed.')
      w.failures = (w.failures || 0) + 1
      this.record(w, { at: t0, ms: this.now - t0, outcome: 'failed', note: why })
      if (w.failures >= WATCH_FAILURES_PAUSE) {
        w.status = 'paused'
        w.nextAt = null
        this.add({ kind: 'failed', ref: `failed:${w.id}`, watchId: w.id, title: `The watch "${w.name}" stopped`, body: `It failed ${w.failures} times in a row, so it is paused. Last reason: ${why}\n\nFix what it needs, then turn it on again.` })
      }
      return 'failed'
    } finally {
      clearTimeout(limit)
      this.aborts.delete(abort)
    }
  }

  private async handTo(w: Watch, title: string, body: string): Promise<{ chatId: string; accountId: string } | undefined> {
    const now = this.now
    const day = (t: number): string => new Date(t + this.zone.offset(t) * 60_000).toISOString().slice(0, 10)
    // Keep future timestamps after a clock correction, so turning the clock back cannot
    // reset admission. Only starts on an earlier local date expire.
    this.teamStarts = this.teamStarts.filter(t => day(t) >= day(now))
    // One at a time: while a team chat a watch started is still working, the finding is told in the
    // inbox and none of the day's three handoffs is used for it.
    if (this.handing || this.host.teamBusy?.()) return
    if (this.teamStarts.length >= 3) {
      this.cappedNote('Today\'s three watch team handoffs are used up.')
      return
    }
    const gate = this.host.gate()
    const pick = gate.pick(w.account)
    if (!pick.accountId) { this.cappedNote(pick.why); return }
    this.handing = true
    this.teamStarts.push(now)
    this.save()
    try {
      // Commit admission before starting external work. Count it immediately so a crash
      // or an unfinished team goal cannot return this allowance to the daily budget.
      gate.record(pick.accountId, { ms: 0, turns: 1 })
      if (!this.flushSave()) return
      const chatId = await this.host.handTo(w, title, body, pick.accountId)
      if (chatId) return { chatId, accountId: pick.accountId }
      // No chat was started (the account went away, or the team was busy after all): the day's three are for chats that did start.
      this.teamStarts.pop()
      this.save()
      return
    } catch {
      return
    } finally {
      this.handing = false
    }
  }

  /** The last few findings of a watch, one line each, so the model does not tell the same thing twice. */
  private findings(w: Watch): string[] {
    return w.runs
      .filter((r) => (r.outcome === 'found' || r.outcome === 'handed') && r.note)
      .slice(0, WATCH_CONTEXT.findings)
      .map((r) => r.note as string)
  }

  /** At most one note a day that the caps held watches back. */
  private cappedNote(why?: string): void {
    const day = new Date(this.now + this.zone.offset(this.now) * 60_000).toISOString().slice(0, 10)
    if (this.inboxItems.some((i) => i.ref === `capped:${day}`)) return
    this.add({ kind: 'needs-you', ref: `capped:${day}`, title: 'Watches were held back today', body: `${why || 'The daily limit on unattended work was reached.'} They carry on when there is room again. You can change the limits in Settings.` })
  }

  // ───────────── looking (no model) ─────────────

  /**
   * What the trigger sees now: a fingerprint, the items it is made of, and in words what is new
   * since the last look (bounded). `changed` is null for a scheduled look, which has nothing to compare.
   */
  private async look(w: Watch, signal: AbortSignal): Promise<{ fp?: string; items?: string[]; changed: string | null }> {
    const tr = w.trigger
    if (tr.kind === 'schedule') return { changed: null }
    let keyed: { key: string; line: string }[]
    if (tr.kind === 'github') {
      const list = await this.host.github.list({ address: tr.repo })
      if (list.problem) throw new Error(list.problem.text)
      keyed =
        tr.on === 'ci-failed'
          ? list.runs.filter((r) => r.conclusion === 'failure' || !r.conclusion).map((r) => ({ key: `run:${r.id}`, line: `Failed run: ${r.workflow} on ${r.branch} (${r.event}), "${r.title}" ${r.url}` }))
          : tr.on === 'issue'
            ? list.issues.map((i) => ({ key: `issue:${i.number}`, line: `New issue #${i.number}: ${i.title} by ${i.author}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''} ${i.url}` }))
            : list.pulls.map((p) => ({ key: `pr:${p.number}`, line: `New pull request #${p.number}: ${p.title} by ${p.author}${p.draft ? ' (draft)' : ''} ${p.url}` }))
    } else if (tr.kind === 'url') {
      const text = steadyText(await (this.host.fetchText || fetchText)(tr.url, signal))
      keyed = text.split('\n').map((l) => ({ key: fingerprint(l), line: l }))
    } else if (tr.kind === 'path') {
      keyed = pathItems(tr.path)
    } else {
      const out = await (this.host.runCommand || runCommand)(tr.command, w.cwd, signal)
      keyed = steadyText(out)
        .split('\n')
        .map((l) => ({ key: fingerprint(l), line: l }))
    }
    keyed = keyed.slice(0, ITEMS_KEPT)
    const items = keyed.map((k) => k.key)
    const fp = fingerprint(items.join('|'))
    const had = new Set(w.seenItems || [])
    const fresh = keyed.filter((k) => !had.has(k.key)).map((k) => k.line)
    const gone = tr.kind === 'path' && w.seenItems ? w.seenItems.filter((k) => !items.includes(k)).map((k) => `No longer there or changed: ${k.split('|')[0]}`) : []
    let changed = [...fresh, ...gone].join('\n')
    if (changed.length > WATCH_CONTEXT.changed) changed = `${changed.slice(0, WATCH_CONTEXT.changed)}\n[…${changed.length - WATCH_CONTEXT.changed} more characters]`
    return { fp, items, changed }
  }

  // ───────────── the inbox ─────────────

  /** Adds an item, unless one for the same thing is there and not done. Returns it when it was added. */
  private add(i: Omit<InboxItem, 'id' | 'at' | 'read' | 'done'>): InboxItem | null {
    if (i.ref && this.inboxItems.some((x) => x.ref === i.ref && !x.done)) return null
    const item: InboxItem = { id: uid('in'), at: this.now, read: false, done: false, ...i }
    this.inboxItems.unshift(item)
    this.inboxChanged()
    if (item.kind === 'needs-you' || item.kind === 'found') this.queueNote(item)
    return item
  }

  /** Marks the item for `ref` done, when there is one open. */
  private done(ref: string): void {
    let any = false
    for (const i of this.inboxItems) if (i.ref === ref && !i.done) (i.done = true), (any = true)
    if (any) this.inboxChanged()
  }

  mark(id: string, patch: { read?: boolean; done?: boolean }): InboxItem[] {
    const i = this.inboxItems.find((x) => x.id === id)
    if (i) {
      if (patch.read !== undefined) i.read = !!patch.read
      if (patch.done !== undefined) i.done = !!patch.done
      this.inboxChanged()
    }
    return this.inbox()
  }

  /** New items are told as one desktop notice, however many arrive together. */
  private queueNote(item: InboxItem): void {
    this.notes.push(item)
    if (this.noteTimer) return
    this.noteTimer = setTimeout(() => this.flushNotes(), this.timers ? 1500 : 0)
    this.noteTimer.unref?.()
  }

  /** Sends the waiting notice now (also used by the checks). */
  flushNotes(): void {
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.noteTimer = null
    const list = this.notes.filter((n) => !n.done)
    this.notes = []
    if (!list.length) return
    if (list.length === 1) this.host.notify(list[0].kind === 'found' ? `Found for you: ${list[0].title}` : list[0].title, oneLine(list[0].body, 160), list[0].chatId)
    else {
      const needs = list.filter((n) => n.kind === 'needs-you').length
      const title = needs ? `${list.length} new in your inbox, ${needs} ${needs === 1 ? 'needs' : 'need'} you` : `${list.length} new in your inbox`
      this.host.notify(title, oneLine(list.map((n) => n.title).join(' · '), 160))
    }
  }

  /**
   * Every event the hub sends passes here: a permission request that waits in any chat becomes a
   * 'needs-you' item, and goes when it is answered; so does a goal that waits on the user.
   */
  observe(ev: HubEvent): void {
    if (!this.started) return
    if (ev.type === 'item' && ev.item.kind === 'permission') {
      const ref = `perm:${ev.item.id}`
      if (ev.item.status === 'pending')
        // An approval the guard asked for in an unattended run has its own one-line summary and a time it lapses.
        this.add({
          kind: 'needs-you',
          ref,
          chatId: ev.chatId,
          approval: { chatId: ev.chatId, requestId: ev.item.requestId, ...(ev.item.expiresAt ? { expiresAt: ev.item.expiresAt } : {}) },
          title: ev.item.unattended ? oneLine(ev.item.title, 120) : 'Waiting for your OK',
          body: ev.item.unattended ? oneLine(ev.item.detail || 'A run nobody is watching asks before it goes on.', 300) : oneLine(`${ev.item.title}${ev.item.detail ? `: ${ev.item.detail}` : ''}`, 240),
        })
      else this.done(ref)
    } else if (ev.type === 'item-patch' && 'status' in ev.patch && ev.patch.status !== 'pending') {
      this.done(`perm:${ev.id}`)
    } else if (ev.type === 'chat') {
      const g = ev.chat.goal
      for (const i of this.inboxItems) if (!i.done && i.ref?.startsWith('goal:') && i.chatId === ev.chat.id && (!g || g.status !== 'blocked' || i.ref !== `goal:${g.id}`)) this.done(i.ref)
      if (g?.status === 'blocked') this.add({ kind: 'needs-you', ref: `goal:${g.id}`, chatId: ev.chat.id, title: 'The goal needs you', body: oneLine(`${g.text}${g.note ? ` · ${g.note}` : ''}`, 240) })
    } else if (ev.type === 'chat-removed') {
      for (const i of this.inboxItems) if (!i.done && i.chatId === ev.chatId && (i.ref?.startsWith('perm:') || i.ref?.startsWith('goal:'))) this.done(i.ref)
    }
  }

  /** For the agents' watch_list tool: the watches in a few lines each. */
  describe(): string {
    if (!this.watches.length) return 'There are no watches.'
    return this.watches
      .map((w) => {
        const last = w.runs[0]
        return `- ${w.id} "${w.name}" (${w.status}${w.madeBy === 'agent' && w.status === 'paused' && !w.runs.length ? ', waiting for the user to confirm' : ''}): ${triggerLine(w.trigger)}${w.nextAt ? `; next look ${new Date(w.nextAt).toISOString()}` : ''}${last ? `; last: ${last.outcome}${last.note ? `, ${last.note}` : ''}` : ''}`
      })
      .join('\n')
  }
}

// ───────────── triggers ─────────────

/** Checks and tidies a trigger. Only the user may make a 'command' watch: it runs with their own rights. */
export function checkTrigger(t: WatchTrigger, by: 'user' | 'agent'): WatchTrigger {
  if (!t || typeof t !== 'object') throw new Error('Say what sets the watch off.')
  switch (t.kind) {
    case 'schedule': {
      if (t.at !== undefined) {
        if (!parseAt(t.at)) throw new Error('A time is written like 07:00.')
        const days = (t.days || []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        return { kind: 'schedule', at: t.at.padStart(5, '0'), ...(days.length ? { days: [...new Set(days)].sort() } : {}) }
      }
      const every = Math.round(Number(t.every) || 0)
      if (every < MIN_EVERY_MINUTES) throw new Error(`A watch looks at most every ${MIN_EVERY_MINUTES} minutes.`)
      return { kind: 'schedule', every }
    }
    case 'github': {
      const ref = parseAddress(String(t.repo || ''))
      if (!ref) throw new Error('That is not a GitHub repository.')
      if (!['ci-failed', 'issue', 'pr'].includes(t.on)) throw new Error('A GitHub watch looks for failed CI runs, new issues or new pull requests.')
      return { kind: 'github', repo: `${ref.owner}/${ref.repo}`, on: t.on }
    }
    case 'url': {
      const url = String(t.url || '').trim()
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('A web address starts with http:// or https://.')
      return { kind: 'url', url }
    }
    case 'path': {
      const p = String(t.path || '').trim()
      if (!p || !path.isAbsolute(p)) throw new Error('Give the full path of the file or folder.')
      return { kind: 'path', path: p }
    }
    case 'command':
      if (by !== 'user') throw new Error('Only you can set a watch that runs a command: it runs with your own rights.')
      if (!String(t.command || '').trim()) throw new Error('Say which command to run.')
      return { kind: 'command', command: String(t.command).trim().slice(0, 500) }
    default:
      throw new Error('That kind of watch is not known.')
  }
}

/** A file, or a folder's entries (not its subfolders' contents), as items "name|size|modified". */
function pathItems(p: string): { key: string; line: string }[] {
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch {
    throw new Error(`${p} cannot be found.`)
  }
  if (!st.isDirectory()) return [{ key: `${path.basename(p)}|${st.size}|${Math.round(st.mtimeMs)}`, line: `Changed: ${path.basename(p)} (${st.size} bytes)` }]
  const out: { key: string; line: string }[] = []
  for (const name of fs.readdirSync(p).sort().slice(0, ITEMS_KEPT)) {
    try {
      const s = fs.statSync(path.join(p, name))
      out.push({ key: `${name}|${s.isDirectory() ? 'dir' : s.size}|${Math.round(s.mtimeMs)}`, line: `New or changed: ${name}${s.isDirectory() ? '/' : ` (${s.size} bytes)`}` })
    } catch {
      /* gone while being read */
    }
  }
  return out
}

/** Reads a page, at most LOOK_BYTES of it. */
async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'Ensemble watch', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } })
  if (!res.ok) throw new Error(`The page answered ${res.status}.`)
  const reader = res.body?.getReader()
  if (!reader) return ''
  let got = 0
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done || !value) break
    parts.push(value)
    got += value.length
    if (got > LOOK_BYTES) {
      void reader.cancel().catch(() => undefined)
      break
    }
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8').slice(0, LOOK_BYTES)
}

/** Runs the user's own command for a 'command' watch, bounded in time and output. */
function runCommand(command: string, cwd: string | undefined, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
    const child = execFile(shell, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : undefined, timeout: 60_000, maxBuffer: LOOK_BYTES, windowsHide: true, encoding: 'utf8' }, (e, out, err) => {
      if (e && !out) reject(new Error(oneLine(String(err || e.message), 200)))
      else resolve(String(out || ''))
    })
    signal.addEventListener('abort', () => child.kill())
  })
}

// ───────────── the caps, until the unattended-safety piece (guard.ts) offers its own ─────────────

export interface GateAccount {
  id: string
  provider: string
  /** Signed in and switched on. */
  ready: boolean
  /** The share (0 to 100) of the session or the week left, whichever is lower; null when unknown. */
  left: number | null
}

/**
 * A simple gate: the daily caps (DEFAULT_CAPS unless given), ChatGPT accounts first, never an
 * account below its free share. Its counts are kept in a file so a restart does not reset them.
 */
export function fallbackGate(o: { file: string; now(): number; zone?: Zone; caps?(): UnattendedCaps; accounts(): GateAccount[] }): UnattendedGate {
  const caps = (): UnattendedCaps => ({ ...DEFAULT_CAPS, ...(o.caps?.() || {}) })
  const day = (): string => {
    const t = o.now()
    return new Date(t + (o.zone || LOCAL_ZONE).offset(t) * 60_000).toISOString().slice(0, 10)
  }
  let counts = readJson<{ day: string; runs: number; byAccount: Record<string, number> }>(o.file, { day: '', runs: 0, byAccount: {} })
  const fresh = (): void => {
    if (counts.day !== day()) counts = { day: day(), runs: 0, byAccount: {} }
  }
  return {
    pick(prefer = 'auto') {
      fresh()
      const c = caps()
      if (counts.runs >= c.runsPerDay) return { accountId: null, why: `Today's ${c.runsPerDay} unattended looks are used up.` }
      const ok = (a: GateAccount): boolean => a.ready && (a.left === null || a.left >= c.keepFree) && (counts.byAccount[a.id] || 0) < c.runsPerAccount
      const all = o.accounts()
      if (prefer !== 'auto') {
        const a = all.find((x) => x.id === prefer)
        if (!a) return { accountId: null, why: 'The account this watch uses is not there any more.' }
        if (!a.ready) return { accountId: null, why: 'The account this watch uses is signed out or switched off.' }
        if (!ok(a)) return { accountId: null, why: (counts.byAccount[a.id] || 0) >= c.runsPerAccount ? `Today's ${c.runsPerAccount} unattended looks on this account are used up.` : `The account this watch uses has less than ${c.keepFree}% left, which is kept for your own work.` }
        return { accountId: a.id }
      }
      const pick = [...all.filter((a) => a.provider === 'chatgpt' && ok(a)), ...all.filter((a) => a.provider !== 'chatgpt' && ok(a))].sort((a, b) => (a.provider === b.provider ? (b.left ?? 50) - (a.left ?? 50) : 0))[0]
      return pick ? { accountId: pick.id } : { accountId: null, why: all.some((a) => a.ready) ? `Every account has less than ${c.keepFree}% left or has used today's unattended looks.` : 'No account is signed in.' }
    },
    record(accountId) {
      fresh()
      counts.runs++
      counts.byAccount[accountId] = (counts.byAccount[accountId] || 0) + 1
      writeJson(o.file, counts)
    },
    today() {
      fresh()
      return { runs: counts.runs, byAccount: { ...counts.byAccount }, caps: caps() }
    },
  }
}

const oneLine = (s: string, max = 200): string => {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
