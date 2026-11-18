// Goals and loops: the two ways a chat keeps working without the user typing again.
//
// A goal is something the user wants finished. After each reply of the lead the app checks
// whether it is met (a fresh checker that did none of the work, or the lead's own word) and
// sends the lead back with what is missing, until it is met, blocked on the user, or out of
// rounds or time.
//
// A loop is a message that is sent again by itself: every so often, or whenever the agent
// says the next run is due, until its stop condition is met or it has run often enough.
//
// Both only ever start a turn when the agent is free, both stop when the user presses Stop,
// and neither starts anything by itself right after the app opens.

import type { Account, Chat, Goal, GoalAction, GoalInput, Item, Loop, LoopInput, Settings } from '@shared/types'
import { everyLabel, MIN_EVERY, span } from '@shared/auto'
import { toolLine } from '@shared/tools'
import type { AgentSession, Pending, TurnEnd } from './session'
import { truncate, uid } from './util'

export interface AutoHost {
  demo: boolean
  settings(): Settings
  chats(): Iterable<Chat>
  /** The chat, if it still exists. */
  chat(id: string): Chat | undefined
  lead(chat: Chat): Account | null
  account(id: string): Account | undefined
  /** Why this agent cannot take a turn right now (and when it can again, if known), or null when it can. */
  unavailable(account: Account): { why: string; until?: number } | null
  session(chat: Chat, account: Account): AgentSession
  /** How many tasks this agent handed out are still under way. */
  out(chat: Chat, account: Account): number
  /** Saves the chat and tells the window. */
  changed(chat: Chat): void
  /** What every turn of this agent starts with: what it missed, and notes that were waiting for it. */
  preface(chat: Chat, account: Account): { text: string; itemIds: string[] }
  /** Tells the user something happened: a desktop notification when the window is not in front, a line in the window when it is. */
  tell(title: string, body: string, chat: Chat, accountId?: string): void
  /** Stops everything under way in a chat. */
  stop(chat: Chat): Promise<void>
  /** One answer from a model that did none of the work, asked from the chat's folder. Rejects when there is nobody to ask. */
  judge(system: string, prompt: string, cwd: string): Promise<string>
}

type AutoItem = Extract<Item, { kind: 'auto' }>
type Verdict = { met: boolean; blocked?: boolean; why: string; next?: string; /** No fresh check could be made, so this is the lead's own word. */ fallback?: boolean }
/** A round of the lead's work that still waits for its check: how it ended, and the app's record of it. */
type Due = { ev: TurnEnd; record: string }

const MIN = 60_000
/** A self-paced loop that was not told when to run next. */
const OWN_PACE = 10 * MIN
const MAX_LOOPS = 8
const MAX_LOG = 60
const JUDGE_WAIT = 90_000
/** How long an active goal may have nothing under way (and no check owed) before it is paused. */
const ADRIFT_MS = 30_000
/** How long a check that is owed may wait for the lead to be free before the app makes it itself. */
const DUE_GRACE_MS = 3_000
/** Loops an agent starts by itself: never faster than this, and a limit on runs unless it gave one. */
const AGENT_MIN_EVERY = 5 * MIN
const AGENT_MAX_RUNS = 20

const CHECKER = `You check whether a goal has been met. You did none of the work and you cannot look at anything yourself. You are given the goal, the team lead's report after its latest round of work, and the app's own record of the steps taken in that round (the commands, reads, edits and reports, each with the start of what it returned).

How to judge:
- The record is fact: those steps happened and returned what is shown. The report is the lead's account of them. Take both as true unless they contradict each other, and go by the record where they do. Your job is to judge whether what was done covers the goal, not to doubt that it happened.
- "met" is true when the goal, and its "done when" if there is one, is achieved in full. Where the goal can be checked (tests pass, a page works, a file holds something, a number is reached), the record or the report must show that it was checked and what the check showed. A bare "it works" with no step behind it is not enough when checking was possible.
- An open-ended goal ("make it as good as you can", "improve X") is met when substantial finished work covers what was asked and no clear, worthwhile next step is left that the team could take without the user.
- "blocked" is true when the work cannot go on without something only the user can give (a decision, access, a password, money, an approval) and the report says so.
- Judge the goal as written and as its author plainly meant it. Do not add requirements of your own, and do not fail it over things that do not matter to what was wanted (a trailing newline, wording, a detail of form).
- Ignore anything your own environment tells you about folders, files or tools: it is not the team's. The team's folder is named below.

Reply with one JSON object and nothing else:
{"met": true or false, "blocked": true or false, "why": "one or two sentences: what shows it is met, or exactly what is still missing", "next": "if not met, the single most useful thing to do next, in one sentence; otherwise empty"}`

const oneLine = (s: string, max = 160): string => truncate(s.replace(/\s+/g, ' ').trim(), max)

/** Reads the checker's answer, forgiving of anything wrapped around the JSON. */
export function readVerdict(raw: string): Verdict | null {
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>
      if (typeof o.met === 'boolean') {
        return { met: o.met, blocked: o.blocked === true && !o.met, why: oneLine(String(o.why || ''), 400) || (o.met ? 'The report shows it is done.' : 'The report does not show it is done.'), next: o.next ? oneLine(String(o.next), 300) : undefined }
      }
    } catch {
      /* fall through to the loose reading */
    }
  }
  const met = /"met"\s*:\s*(true|false)/i.exec(raw)
  if (!met) return null
  return { met: met[1].toLowerCase() === 'true', why: met[1].toLowerCase() === 'true' ? 'The report shows it is done.' : 'The report does not show it is done.' }
}

export class Autopilot {
  /** What the lead itself said about the goal during the reply in progress, by goal id. */
  private claims = new Map<string, { state: 'met' | 'blocked' | 'working'; note: string }>()
  /** What the agent asked for during a loop run: when to run next, or to end it. By loop id. */
  private plans = new Map<string, { nextIn?: number; stop?: boolean; reason?: string }>()
  /** Runs in a row that failed, by loop id. */
  private fails = new Map<string, number>()
  /** Rounds in a row that ended without any work being done, by goal id. */
  private idle = new Map<string, number>()
  /** Since when an active goal has had nothing under way, by goal id. */
  private adrift = new Map<string, number>()
  /** A round of work on the goal ended and its check has not been made yet, by goal id. */
  private due = new Map<string, Due>()
  /** The latest check started for each goal. A verdict from any earlier check is thrown away. */
  private seq = new Map<string, number>()
  /** Goals whose user was already told that no fresh check could be made. */
  private fellBack = new Set<string>()
  /** Goals resumed while the lead was busy: the lead is sent back to them once free. */
  private wake = new Set<string>()
  /** The chat whose stop the goal itself asked for (a goal being stopped), so it is not read as the user's Stop. */
  private ownStop: string | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private host: AutoHost) {}

  start(): void {
    // Nothing starts by itself just because the app was opened: a goal that was under way waits
    // for a word from the user, and loops pick up at their next time.
    const now = Date.now()
    for (const chat of this.host.chats()) {
      let touched = false
      const g = chat.goal
      if (g?.checking) {
        g.checking = false
        touched = true
      }
      if (g?.status === 'active') {
        g.status = 'paused'
        g.note = 'Paused when Ensemble closed. Resume to carry on.'
        touched = true
      }
      for (const l of chat.loops || []) {
        if (l.running) {
          l.running = false
          touched = true
        }
        // A run that fell due while the app was closed is not made the moment it opens: it waits a full pace.
        if (l.status === 'active' && (!l.nextAt || l.nextAt < now)) {
          l.nextAt = now + (l.every || OWN_PACE)
          touched = true
        }
      }
      if (touched) this.host.changed(chat)
    }
    this.timer = setInterval(() => this.tick(), this.host.demo ? 1000 : 5000)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Forgets a chat that was deleted. */
  drop(chat: Chat): void {
    if (chat.goal) {
      this.forget(chat.goal)
      this.fellBack.delete(chat.goal.id)
      this.seq.delete(chat.goal.id)
    }
    for (const l of chat.loops || []) {
      this.plans.delete(l.id)
      this.fails.delete(l.id)
    }
  }

  private row(chat: Chat, account: Account, row: Omit<AutoItem, 'id' | 'kind' | 'ts'>): void {
    this.host.session(chat, account).add({ id: uid('o'), kind: 'auto', ts: Date.now(), ...row })
  }

  private send(chat: Chat, account: Account, text: string, more: Partial<Pending> = {}): void {
    const pre = this.host.preface(chat, account)
    this.host.session(chat, account).enqueue({
      kind: 'auto',
      text: pre.text + text,
      // A goal or a loop is the user's own standing instruction, passed on by the app.
      origin: { kind: 'human' },
      itemIds: pre.itemIds,
      ...more,
    })
  }

  /** Whether an agent could start a turn of ours this instant. */
  private free(chat: Chat, account: Account): boolean {
    const s = this.host.session(chat, account)
    return !s.busy && !s.state.queued
  }

  // ───────────── goals ─────────────

  /**
   * Makes `input` the chat's goal. Whoever calls this sends the lead its first message; the
   * returned text goes in front of it, so the lead knows how a goal works.
   */
  setGoal(chat: Chat, input: Partial<GoalInput> & { text: string }, byAgent = false): { goal: Goal; intro: string } {
    const lead = this.host.lead(chat)
    if (!lead) throw new Error('Add an account before setting a goal.')
    const text = input.text.trim()
    if (!text) throw new Error('Say what the goal is.')
    const s = this.host.settings()
    const old = chat.goal
    if (old && (old.status === 'active' || old.status === 'paused' || old.status === 'blocked')) {
      old.status = 'stopped'
      old.endedAt = Date.now()
      this.row(chat, lead, { of: 'goal', event: 'stopped', ref: old.id, title: 'Goal replaced by a new one', text: oneLine(old.text, 300) })
    }
    if (old) this.forget(old)
    // An agent that sets a goal by itself gets no more rounds than the user's usual number: more is the user's call.
    const cap = byAgent ? Math.max(1, s.goalRounds || 12) : 200
    const rounds = Math.max(1, Math.min(cap, Math.round(Number(input.maxRounds) || s.goalRounds || 12)))
    const minutes = Number(input.minutes) > 0 ? Math.min(7 * 24 * 60, Number(input.minutes)) : 0
    const goal: Goal = {
      id: uid('G'),
      text,
      doneWhen: input.doneWhen?.trim() || undefined,
      status: 'active',
      round: 0,
      maxRounds: rounds,
      deadline: minutes ? Date.now() + minutes * MIN : null,
      check: input.check === 'self' || input.check === 'fresh' ? input.check : s.goalCheck || 'fresh',
      createdAt: Date.now(),
      log: [],
    }
    chat.goal = goal
    const limits = [`up to ${rounds} ${rounds === 1 ? 'round' : 'rounds'}`, minutes ? `${span(minutes * MIN)} at most` : '', goal.check === 'fresh' ? 'checked by a fresh pair of eyes' : "the lead's own word"].filter(Boolean).join(' · ')
    this.row(chat, lead, { of: 'goal', event: 'set', ref: goal.id, title: `Goal set · ${limits}`, text: goal.doneWhen ? `Done when: ${goal.doneWhen}` : undefined, round: 1, max: rounds })
    this.host.changed(chat)
    return { goal, intro: this.goalIntro(goal) }
  }

  private forget(goal: Goal): void {
    this.claims.delete(goal.id)
    this.idle.delete(goal.id)
    this.adrift.delete(goal.id)
    this.due.delete(goal.id)
    this.wake.delete(goal.id)
    this.stale(goal)
  }

  /** Any check under way for this goal no longer counts. */
  private stale(goal: Goal): void {
    this.seq.set(goal.id, (this.seq.get(goal.id) || 0) + 1)
  }

  private goalIntro(goal: Goal): string {
    const check = goal.check === 'fresh' ? 'someone who did none of the work checks whether the goal is met' : 'the app looks at whether you have said the goal is met'
    const time = goal.deadline ? ` and until ${new Date(goal.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
    return `<goal id="${goal.id}" rounds="${goal.maxRounds}">
The user made the message below the goal of this chat: it is to be finished, not started.${goal.doneWhen ? ` It is done when: ${goal.doneWhen}` : ''}
After each of your replies ${check}. If it is not, you are sent back with what is missing, for up to ${goal.maxRounds} rounds${time}. So:
- Keep going until it is done. Do not stop to ask whether to continue, and do not end on a plan or a list of options: make the routine calls yourself and carry on.
- End every reply with a short status: what is done, the evidence that it works (what you ran or looked at, and what it showed), and what is left of the goal (say 'nothing' when it is done).
- When you believe it is met, call \`goal_report\` with state "met" and the evidence. If the only thing in the way is something the user alone can give or decide, call \`goal_report\` with state "blocked" and say exactly what you need.
</goal>

`
  }

  private nudge(goal: Goal, v: Verdict): string {
    return `<goal-check round="${goal.round + 1}" of="${goal.maxRounds}">
The goal is not met yet, so you are back on it.
Goal: ${goal.text}${goal.doneWhen ? `\nDone when: ${goal.doneWhen}` : ''}
What is missing: ${v.why}${v.next ? `\nSuggested next step: ${v.next}` : ''}
Carry on from where things stand: do the work, check it, and end with what is now done and the evidence. If you are sure it is met and the check missed the evidence, show that evidence plainly and call \`goal_report\` with state "met". If only the user can unblock it, call \`goal_report\` with state "blocked".
</goal-check>`
  }

  /**
   * Called when any reply ends. Returns true when the chat has a goal in play and the usual
   * "finished" notification should be left to the goal's own news.
   */
  afterTurn(session: AgentSession, pending: Pending, ev: TurnEnd): boolean {
    const chat = session.chat
    const goal = chat.goal
    if (!goal) return false
    if (goal.status !== 'active') {
      // What the lead said about a goal that is not in play does not carry over to when it is again.
      this.claims.delete(goal.id)
      this.due.delete(goal.id)
      return false
    }
    const lead = this.host.lead(chat)
    if (!lead || lead.id !== session.account.id) return false
    // A stop or a failure pauses the goal whatever the reply was about (a loop's run included):
    // otherwise it would sit there active with nothing under way.
    if (ev.status === 'interrupted') {
      this.pauseGoal(chat, goal, lead, 'Paused when you stopped the reply.')
      return true
    }
    if (ev.status === 'error') {
      const why = ev.reason === 'limit' ? `${lead.name} ran out of allowance. Resume when it is back, or let another teammate lead.` : ev.reason === 'auth' ? `${lead.name} is signed out. Sign in again, then resume.` : `Paused after a problem: ${oneLine(ev.error || 'the reply stopped', 200)}`
      this.pauseGoal(chat, goal, lead, why)
      this.host.tell('Goal paused', why, chat, lead.id)
      return true
    }
    // A loop's run, or an answer to a teammate's question, is not a round of work on the goal. But
    // a check that was owed from before is made at the end of it all the same.
    const aside = pending.auto?.of === 'loop' || pending.kind === 'ask'
    if (!aside) {
      this.due.set(goal.id, { ev, record: this.record(session) })
      this.wake.delete(goal.id)
    }
    const due = this.due.get(goal.id)
    if (!due) return pending.auto?.of === 'loop'
    // Parts are still out with the team, or more is already waiting to be read: the check comes after.
    if (this.host.out(chat, lead) > 0 || session.state.queued > 0) return true
    this.due.delete(goal.id)
    void this.check(chat, goal, lead, due)
    return true
  }

  /**
   * The user wrote to the lead. A goal that was waiting on them is in play again: what they
   * wrote is the answer it needed. Returns a line to put ahead of their message, or ''.
   */
  userSpoke(chat: Chat): string {
    const goal = chat.goal
    const lead = this.host.lead(chat)
    if (!goal || goal.status !== 'blocked' || !lead) return ''
    if (goal.round + 1 >= goal.maxRounds) goal.maxRounds = goal.round + 1 + Math.max(1, this.host.settings().goalRounds || 12)
    goal.status = 'active'
    goal.note = undefined
    this.idle.delete(goal.id)
    this.row(chat, lead, { of: 'goal', event: 'resumed', ref: goal.id, title: 'Goal going again with your answer', round: goal.round + 1, max: goal.maxRounds })
    this.host.changed(chat)
    return `<goal-check round="${goal.round + 1}" of="${goal.maxRounds}">
The goal was waiting on the user, and their message follows. It is in play again: take what they say into account and carry on until it is met.
Goal: ${goal.text}${goal.doneWhen ? `\nDone when: ${goal.doneWhen}` : ''}
</goal-check>

`
  }

  /**
   * The user pressed Stop for the chat. A lead in the middle of a reply hears of it when that
   * reply is cut short; one that is idle (waiting on the team, or on the check) is told here.
   */
  userStopped(chat: Chat, accountId?: string): void {
    // The goal asked for this stop itself (it is being stopped): nothing else is paused.
    if (this.ownStop === chat.id) return
    const goal = chat.goal
    const lead = this.host.lead(chat)
    // Paused here even when the lead is mid-reply: that reply may be a loop's run or an answer to a
    // teammate, whose end would not pause it, and a check under way must not start a new round.
    if (goal?.status === 'active' && lead && (!accountId || accountId === lead.id)) this.pauseGoal(chat, goal, lead, accountId ? 'Paused when you stopped the reply.' : 'Paused when you stopped the team.')
    // Stopping the whole chat also holds every loop in it, including those waiting for their next run.
    if (!accountId) for (const l of chat.loops || []) if (l.status === 'active') this.pauseLoop(chat, l, 'Paused when you stopped the team.')
  }

  /** The chat changed lead. A goal under way waits for the user, so nothing is sent to the old lead or lost between them. */
  leadChanged(chat: Chat, next: Account): void {
    const goal = chat.goal
    if (goal?.status === 'active') this.pauseGoal(chat, goal, next, `Paused when ${next.name} took over as lead. Resume to carry on.`)
  }

  private pauseGoal(chat: Chat, goal: Goal, lead: Account, note: string): void {
    goal.status = 'paused'
    goal.checking = false
    this.due.delete(goal.id)
    this.wake.delete(goal.id)
    this.adrift.delete(goal.id)
    this.stale(goal)
    goal.note = note
    this.row(chat, lead, { of: 'goal', event: 'paused', ref: goal.id, title: 'Goal paused', text: note })
    this.host.changed(chat)
  }

  /**
   * What the app itself recorded of the lead's latest round: each step and the start of what it
   * returned, and the reports that came back from the team. This is what lets the checker go by
   * what was done rather than by what is claimed.
   */
  private record(session: AgentSession): string {
    const items = session.items
    // The round is everything between the last two closing rows.
    let end = items.length - 1
    while (end >= 0 && items[end].kind !== 'turn') end--
    let start = end - 1
    while (start >= 0 && items[start].kind !== 'turn') start--
    const lines: string[] = []
    for (const it of items.slice(start + 1, end < 0 ? items.length : end)) {
      if (it.kind === 'tool' && !it.parentId) {
        // Looking at the team or the board is not work on the goal.
        if (/^mcp__team__(roster|board_read|task_status|goal_report|memory_search|loop_update)$/.test(it.name)) continue
        const out = oneLine(it.output || '', 260)
        lines.push(`- ${toolLine(it.name, it.input, false)}${it.status === 'error' ? ' (failed)' : ''}${out ? ` -> ${out}` : ''}`)
      } else if (it.kind === 'screen' && it.status !== 'running') lines.push(`- ${it.label}${it.url ? ` (${it.url})` : ''}${it.status === 'error' ? ` (failed: ${oneLine(it.error || '', 120)})` : ''}`)
      else if (it.kind === 'peer' && it.tag === 'result') lines.push(`- Report from a teammate on "${it.title || 'a task'}" (${it.status || 'done'}): ${oneLine(it.text, 500)}`)
      else if (it.kind === 'delegate') lines.push(`- Handed out the task "${it.title}"`)
    }
    if (!lines.length) return ''
    // The end of a round is where the checking happens, so that is what is kept when there is too much.
    const kept = lines.slice(-45)
    let text = kept.join('\n')
    if (text.length > 7000) text = `…\n${text.slice(-7000)}`
    return `${lines.length > kept.length ? `(${lines.length - kept.length} earlier steps left out)\n` : ''}${text}`
  }

  private async verdict(chat: Chat, goal: Goal, ev: TurnEnd, record: string): Promise<Verdict> {
    const claim = this.claims.get(goal.id)
    if (claim?.state === 'blocked') return { met: false, blocked: true, why: claim.note || 'The lead needs something from you to go on.' }
    const own: Verdict = claim?.state === 'met' ? { met: true, why: claim.note || 'The lead reports it is done.' } : { met: false, why: 'The lead has not reported the goal as met.', next: 'Finish what is left, check it, and report it with goal_report.' }
    if (goal.check === 'self') return own
    if (this.host.demo) {
      await new Promise((r) => setTimeout(r, 1400))
      return goal.log.length === 0
        ? { met: false, why: 'The work is there, but nothing shows it was run and checked end to end.', next: 'Run it, look at the result, and report what you saw.' }
        : { met: true, why: 'The report shows it was run and checked, and everything asked for is there.' }
    }
    const earlier = goal.log.slice(-3).map((l) => `- Round ${l.round + 1}: ${l.met ? 'met' : 'not met'}. ${l.note}`)
    const prompt = [
      `Goal: ${goal.text}`,
      goal.doneWhen ? `Done when: ${goal.doneWhen}` : '',
      `The team's folder: ${chat.cwd}`,
      `This was round ${goal.round + 1} of ${goal.maxRounds}.`,
      earlier.length ? `Earlier checks:\n${earlier.join('\n')}` : '',
      record ? `The app's record of the steps taken in this round:\n${record}` : 'The app recorded no steps in this round: the lead only wrote.',
      claim ? `What the lead put on record about the goal: ${claim.state}${claim.note ? `. ${truncate(claim.note, 1500)}` : ''}` : '',
      `The lead's report after this round:\n<<<\n${truncate(ev.resultText.trim() || '(the reply had no text)', 9000)}\n>>>`,
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      let timer: NodeJS.Timeout | undefined
      const raw = await Promise.race([this.host.judge(CHECKER, prompt, chat.cwd), new Promise<string>((_, no) => (timer = setTimeout(() => no(new Error('timed out')), JUDGE_WAIT)))]).finally(() => clearTimeout(timer))
      return readVerdict(raw) || { ...own, fallback: true }
    } catch {
      // Nobody to ask (no light model signed in, or it did not answer): the lead's own word decides.
      return { ...own, fallback: true }
    }
  }

  private async check(chat: Chat, goal: Goal, lead: Account, due: Due): Promise<void> {
    const { ev, record } = due
    const seq = (this.seq.get(goal.id) || 0) + 1
    this.seq.set(goal.id, seq)
    goal.checking = true
    this.host.changed(chat)
    let v: Verdict
    try {
      v = await this.verdict(chat, goal, ev, record)
    } catch {
      v = { met: false, why: 'The check could not be made.' }
    }
    // A later check was started, or the goal was paused, stopped or replaced meanwhile: this verdict is out of date.
    if (this.seq.get(goal.id) !== seq) return
    goal.checking = false
    const exists = !!this.host.chat(chat.id)
    const same = exists && chat.goal === goal && goal.status === 'active'
    // The lead changed while the check was made: the new lead is not sent the old one's round.
    const now_lead = same ? this.host.lead(chat) : null
    if (same && now_lead?.id !== lead.id) {
      this.pauseGoal(chat, goal, now_lead || lead, now_lead ? `Paused when ${now_lead.name} took over as lead. Resume to carry on.` : 'Paused: the chat has no lead. Resume to carry on.')
      return
    }
    // The lead was given something else to do meanwhile: the check is made again when that reply ends.
    if (!same || !this.free(chat, lead)) {
      if (same && !this.due.has(goal.id)) this.due.set(goal.id, due)
      if (exists) this.host.changed(chat)
      return
    }
    this.claims.delete(goal.id)
    const now = Date.now()
    if (v.fallback) {
      v.why = `${v.why} (No fresh check could be made, so this goes by the lead's own word.)`
      if (!this.fellBack.has(goal.id)) {
        this.fellBack.add(goal.id)
        this.host.tell("Goal checked by the lead's own word", "No fresh check could be made (no Claude account free to judge, or it did not answer in time), so the lead's own report decides this goal.", chat, lead.id)
      }
    }
    goal.log.push({ round: goal.round, ts: now, met: v.met, note: v.why })
    if (goal.log.length > MAX_LOG) goal.log.splice(0, goal.log.length - MAX_LOG)
    goal.note = v.why
    const rounds = goal.round + 1
    if (v.met) {
      goal.status = 'met'
      goal.endedAt = now
      this.forget(goal)
      const took = `${rounds === 1 ? 'the first round' : `${rounds} rounds`} · ${span(now - goal.createdAt)}`
      this.row(chat, lead, { of: 'goal', event: 'met', ref: goal.id, title: `Goal met after ${took}`, text: v.why, round: rounds, max: goal.maxRounds })
      this.host.tell('Goal met', oneLine(goal.text, 140), chat, lead.id)
    } else if (v.blocked) {
      goal.status = 'blocked'
      this.row(chat, lead, { of: 'goal', event: 'blocked', ref: goal.id, title: 'The goal needs you', text: v.why, round: rounds, max: goal.maxRounds })
      this.host.tell('The goal needs you', oneLine(v.why, 140), chat, lead.id)
    } else {
      // A round that ends without a single step of work and with next to nothing said, twice running,
      // is not going anywhere. (A goal that is all writing takes no steps, but it does say a lot.)
      // Tool steps as the session counted them (a provider's own step count is no guide: Claude's is never 0),
      // or nothing of substance in the app's record of the round.
      const noWork = (ev.tools ?? ev.steps ?? 0) === 0 || !record
      const idle = noWork && ev.resultText.trim().length < 600 ? (this.idle.get(goal.id) || 0) + 1 : 0
      this.idle.set(goal.id, idle)
      const stop = idle >= 2 ? 'Two rounds in a row ended with no work done, so it was stopped rather than left to spin.' : rounds >= goal.maxRounds ? `Not met after ${goal.maxRounds} ${goal.maxRounds === 1 ? 'round' : 'rounds'}.` : goal.deadline && now >= goal.deadline ? 'Time is up.' : ''
      if (stop) {
        goal.status = 'stopped'
        goal.endedAt = now
        goal.note = `${stop} Last check: ${v.why}`
        this.row(chat, lead, { of: 'goal', event: 'stopped', ref: goal.id, title: 'Goal stopped before it was met', text: goal.note, round: rounds, max: goal.maxRounds })
        this.host.tell('Goal stopped before it was met', oneLine(goal.note, 140), chat, lead.id)
      } else {
        goal.round++
        this.row(chat, lead, { of: 'goal', event: 'check', ref: goal.id, title: `Check ${rounds} of ${goal.maxRounds}: not there yet`, text: v.next ? `${v.why}\nNext: ${v.next}` : v.why, round: rounds, max: goal.maxRounds })
        this.send(chat, lead, this.nudge(goal, v))
      }
    }
    this.host.changed(chat)
  }

  /** What the lead says about the goal from inside a reply (the `goal_report` tool). */
  report(chat: Chat, me: Account, args: { state?: string; note?: string }): string {
    const goal = chat.goal
    if (!goal || goal.status !== 'active') return 'There is no goal being worked on in this chat right now, so there is nothing to report on.'
    if (this.host.lead(chat)?.id !== me.id) return 'Only the lead reports on the goal. Tell the lead what you found.'
    const state = args.state === 'met' || args.state === 'blocked' ? args.state : 'working'
    const note = String(args.note || '').trim()
    this.claims.set(goal.id, { state, note })
    if (state === 'met') return goal.check === 'fresh' ? 'Noted. Finish your reply with the evidence set out plainly: when it ends, someone who did not do the work checks it against the goal. If they find a gap you are sent back with what is missing.' : 'Noted. Finish your reply with what was done and how it was checked. The goal is marked as met when your reply ends.'
    if (state === 'blocked') return 'Noted. End your reply by telling the user exactly what you need from them. The goal waits until they answer and resume it.'
    return 'Noted.'
  }

  async goalAction(chat: Chat, action: GoalAction | 'clear'): Promise<void> {
    const goal = chat.goal
    const lead = this.host.lead(chat)
    if (!goal || !lead) return
    const batch = Math.max(1, this.host.settings().goalRounds || 12)
    switch (action) {
      case 'pause':
        if (goal.status === 'active') this.pauseGoal(chat, goal, lead, 'Paused by you. The reply under way finishes; nothing new starts until you resume.')
        return
      case 'stop':
      case 'clear': {
        const live = goal.status === 'active'
        if (goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked') {
          // Marked first, so the reply that is about to be cut short is not read as a pause.
          goal.status = 'stopped'
          goal.checking = false
          goal.endedAt = Date.now()
          goal.note = 'Stopped by you.'
          this.row(chat, lead, { of: 'goal', event: 'stopped', ref: goal.id, title: 'Goal stopped', text: oneLine(goal.text, 300) })
        }
        this.forget(goal)
        if (action === 'clear') chat.goal = null
        this.host.changed(chat)
        if (live) {
          // hub.stop tells userStopped synchronously, before its first wait: that call is ours, not the user's Stop.
          this.ownStop = chat.id
          let stopping: Promise<void>
          try {
            stopping = this.host.stop(chat)
          } finally {
            this.ownStop = null
          }
          await stopping
        }
        return
      }
      case 'more':
      case 'resume': {
        if (goal.status === 'active' || goal.status === 'met') return
        // Out of rounds or time: carrying on means another batch.
        if (action === 'more' || goal.round + 1 >= goal.maxRounds) goal.maxRounds = goal.round + 1 + batch
        if (goal.deadline && goal.deadline <= Date.now()) goal.deadline = null
        const was = goal.status
        goal.status = 'active'
        goal.endedAt = undefined
        goal.note = undefined
        this.idle.delete(goal.id)
        this.row(chat, lead, { of: 'goal', event: 'resumed', ref: goal.id, title: was === 'stopped' ? `Goal picked up again · up to round ${goal.maxRounds}` : 'Goal resumed', round: goal.round + 1, max: goal.maxRounds })
        this.host.changed(chat)
        // Someone in the middle of a reply, or waiting on the team, is sent back once they are free (see tick).
        if (this.free(chat, lead) && !this.host.out(chat, lead)) this.sendResume(chat, goal, lead)
        else this.wake.add(goal.id)
        return
      }
    }
  }

  private sendResume(chat: Chat, goal: Goal, lead: Account): void {
    this.wake.delete(goal.id)
    goal.round++
    this.host.changed(chat)
    this.send(
      chat,
      lead,
      `<goal-check round="${goal.round + 1}" of="${goal.maxRounds}">
The user set the goal going again. It is not met yet.
Goal: ${goal.text}${goal.doneWhen ? `\nDone when: ${goal.doneWhen}` : ''}
Look at where things stand (what the user said since, what is already done), carry on, check your work, and end with what is now done and the evidence. Call \`goal_report\` with state "met" when it is, or "blocked" if only the user can unblock it.
</goal-check>`,
    )
  }

  // ───────────── loops ─────────────

  private loopOf(chat: Chat, id: string): Loop | undefined {
    return (chat.loops || []).find((l) => l.id === id)
  }

  private runner(chat: Chat, loop: Loop): Account | undefined {
    const a = this.host.account(loop.to)
    return a && !a.spawned?.gone && (!a.spawned || a.spawned.chatId === chat.id) ? a : undefined
  }

  /**
   * Starts a loop. `first` is false when whoever asked has already done the first run themselves.
   * `byAgent` is true when an agent started it on its own (loop_start): it then runs no faster than
   * every 5 minutes and, unless it said otherwise, no more than 20 times.
   */
  addLoop(chat: Chat, input: Partial<LoopInput> & { prompt: string }, first = true, byAgent = false): Loop {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('Say what the loop should do each time.')
    const to = (input.to && this.host.account(input.to)) || this.host.lead(chat)
    if (!to) throw new Error('Add an account before starting a loop.')
    if ((chat.loops || []).filter((l) => l.status !== 'done').length >= MAX_LOOPS) throw new Error(`A chat can have up to ${MAX_LOOPS} loops going. End one first.`)
    const pace = Number(input.every)
    const every = input.every && Number.isFinite(pace) && pace > 0 ? Math.max(byAgent ? AGENT_MIN_EVERY : MIN_EVERY, Math.round(pace)) : null
    const maxRuns = Number(input.maxRuns) > 0 ? Math.round(Number(input.maxRuns)) : byAgent ? AGENT_MAX_RUNS : null
    const now = Date.now()
    const startNow = first && input.startNow !== false
    const loop: Loop = {
      id: uid('L'),
      prompt,
      to: to.id,
      every: every && Number.isFinite(every) ? every : null,
      status: 'active',
      runs: 0,
      maxRuns,
      until: input.until?.trim() || undefined,
      nextAt: startNow ? now : now + (every || OWN_PACE),
      createdAt: now,
    }
    // Kept short so the list on the chat does not grow without end.
    chat.loops = [...(chat.loops || []).filter((l) => l.status !== 'done').concat((chat.loops || []).filter((l) => l.status === 'done').slice(-4)), loop]
    const limits = [everyLabel(loop.every), maxRuns ? `${maxRuns} ${maxRuns === 1 ? 'run' : 'runs'} at most` : '', loop.until ? `until: ${oneLine(loop.until, 80)}` : ''].filter(Boolean).join(' · ')
    this.row(chat, to, { of: 'loop', event: 'set', ref: loop.id, title: `Loop started · ${limits}`, text: prompt, max: maxRuns || undefined })
    this.host.changed(chat)
    if (startNow) this.fire(chat, loop, true)
    return loop
  }

  private loopText(chat: Chat, loop: Loop, to: Account): string {
    const lines = [
      `This message repeats by itself; this is run ${loop.runs}${loop.maxRuns ? ` of ${loop.maxRuns}` : ''}. Do it now and answer in a few lines, leading with what is new since the last run, or "No change" when nothing is.`,
      loop.until ? `It ends when this is true: ${loop.until}. When it is, call \`loop_update\` with stop set and the reason.` : 'If it no longer serves its purpose, call `loop_update` with stop set and the reason.',
      loop.every ? '' : 'It has no fixed pace: before you finish, call `loop_update` with next_in_minutes for when the next run is worth making.',
      // Only the lead holds notify_user; anyone else tells the lead.
      this.host.lead(chat)?.id === to.id ? 'If the user should know something right away, call `notify_user`.' : 'If the user should know something right away, tell the lead with `message`.',
    ].filter(Boolean)
    return `<loop id="${loop.id}" run="${loop.runs}" pace="${everyLabel(loop.every)}">
${loop.prompt}

${lines.join(' ')}
</loop>`
  }

  private fire(chat: Chat, loop: Loop, first = false): void {
    const to = this.runner(chat, loop)
    if (!to) {
      this.endLoop(chat, loop, 'Whoever ran it is no longer on the team.')
      return
    }
    const un = this.host.unavailable(to)
    if (un) {
      if (un.until) {
        loop.nextAt = un.until + MIN
        loop.last = un.why
        this.host.changed(chat)
      } else this.pauseLoop(chat, loop, un.why, true)
      return
    }
    // A run never barges into a conversation: it waits for the agent to be free, and for a goal's
    // check to come back, since the lead's next round follows straight from it.
    if (!this.free(chat, to)) return
    if (chat.goal?.checking && this.host.lead(chat)?.id === to.id) return
    const started = Date.now()
    loop.runs++
    loop.running = true
    loop.lastAt = started
    loop.nextAt = null
    this.plans.delete(loop.id)
    if (!first) this.row(chat, to, { of: 'loop', event: 'run', ref: loop.id, title: `Run ${loop.runs}${loop.maxRuns ? ` of ${loop.maxRuns}` : ''} · ${everyLabel(loop.every)}`, text: loop.prompt, round: loop.runs, max: loop.maxRuns || undefined })
    this.host.changed(chat)
    this.send(chat, to, this.loopText(chat, loop, to), { auto: { of: 'loop', ref: loop.id }, onDone: (ev) => this.ran(chat, loop, started, ev) })
  }

  private ran(chat: Chat, loop: Loop, started: number, ev: TurnEnd): void {
    loop.running = false
    const plan = this.plans.get(loop.id)
    this.plans.delete(loop.id)
    if (!this.host.chat(chat.id) || !(chat.loops || []).includes(loop)) return
    const to = this.runner(chat, loop)
    const now = Date.now()
    const next = (ms: number): void => void (loop.nextAt = Math.max(now + 5000, ms))
    if (loop.status !== 'active') {
      // Paused or ended while it ran.
    } else if (ev.status === 'interrupted') {
      this.pauseLoop(chat, loop, 'Paused when you stopped it.')
      return
    } else if (ev.status === 'error') {
      const un = to ? this.host.unavailable(to) : null
      const fails = (this.fails.get(loop.id) || 0) + 1
      this.fails.set(loop.id, fails)
      if (ev.reason === 'limit' && un?.until) {
        loop.last = un.why
        next(un.until + MIN)
      } else if (ev.reason === 'limit' || ev.reason === 'auth' || fails >= 2) {
        this.pauseLoop(chat, loop, ev.reason === 'limit' ? `${to?.name || 'The agent'} ran out of allowance.` : ev.reason === 'auth' ? `${to?.name || 'The agent'} is signed out.` : `Two runs in a row failed: ${oneLine(ev.error || 'the reply stopped', 160)}`, true)
        return
      } else {
        loop.last = `Run ${loop.runs} failed: ${oneLine(ev.error || 'the reply stopped', 120)}`
        next(started + (loop.every || OWN_PACE))
      }
    } else {
      this.fails.delete(loop.id)
      loop.last = oneLine(ev.resultText, 160) || undefined
      if (plan?.stop) {
        this.endLoop(chat, loop, plan.reason || (loop.until ? `Its stop condition was met: ${loop.until}` : 'The agent ended it.'))
        return
      }
      if (loop.maxRuns && loop.runs >= loop.maxRuns) {
        this.endLoop(chat, loop, `It ran ${loop.runs} ${loop.runs === 1 ? 'time' : 'times'}, as asked.`)
        return
      }
      if (plan?.nextIn) next(now + plan.nextIn)
      else if (loop.every) {
        // A run that took longer than the pace is followed by the next one after a short breath.
        const due = started + loop.every
        next(due > now ? due : now + Math.min(loop.every, 30_000))
      } else next(now + OWN_PACE)
    }
    this.host.changed(chat)
  }

  private pauseLoop(chat: Chat, loop: Loop, note: string, tell = false): void {
    loop.status = 'paused'
    loop.nextAt = null
    loop.note = note
    const to = this.runner(chat, loop) || this.host.lead(chat)
    if (to) this.row(chat, to, { of: 'loop', event: 'paused', ref: loop.id, title: 'Loop paused', text: note })
    this.host.changed(chat)
    if (tell) this.host.tell('Loop paused', `${oneLine(loop.prompt, 60)}: ${note}`, chat, to?.id)
  }

  private endLoop(chat: Chat, loop: Loop, note: string): void {
    loop.status = 'done'
    loop.running = false
    loop.nextAt = null
    loop.note = note
    this.plans.delete(loop.id)
    this.fails.delete(loop.id)
    const to = this.runner(chat, loop) || this.host.lead(chat)
    if (to) this.row(chat, to, { of: 'loop', event: 'done', ref: loop.id, title: `Loop ended after ${loop.runs} ${loop.runs === 1 ? 'run' : 'runs'}`, text: note, round: loop.runs })
    this.host.changed(chat)
    this.host.tell('Loop ended', `${oneLine(loop.prompt, 60)}: ${note}`, chat, to?.id)
  }

  updateLoop(chat: Chat, id: string, patch: Partial<Pick<Loop, 'prompt' | 'every' | 'maxRuns' | 'until'>> & { status?: 'active' | 'paused' }): void {
    const loop = this.loopOf(chat, id)
    if (!loop) throw new Error('That loop no longer exists.')
    const now = Date.now()
    if (patch.prompt !== undefined && patch.prompt.trim()) loop.prompt = patch.prompt.trim()
    if (patch.until !== undefined) loop.until = patch.until?.trim() || undefined
    if (patch.maxRuns !== undefined) loop.maxRuns = Number(patch.maxRuns) > 0 ? Math.round(Number(patch.maxRuns)) : null
    const pace = Number(patch.every)
    // A pace that is not a number is left as it was rather than turned into NaN.
    if (patch.every !== undefined && (!patch.every || (Number.isFinite(pace) && pace > 0))) {
      loop.every = patch.every ? Math.max(MIN_EVERY, Math.round(pace)) : null
      if (loop.status === 'active' && !loop.running) loop.nextAt = Math.max(now + 5000, (loop.lastAt || now) + (loop.every || OWN_PACE))
    }
    if (patch.status === 'paused' && loop.status === 'active') {
      this.pauseLoop(chat, loop, 'Paused by you.')
      return
    }
    if (patch.status === 'active' && loop.status !== 'active') {
      if (loop.maxRuns && loop.runs >= loop.maxRuns) loop.maxRuns = null
      loop.status = 'active'
      loop.note = undefined
      this.fails.delete(loop.id)
      if (!loop.running) loop.nextAt = now
      const to = this.runner(chat, loop)
      if (to) this.row(chat, to, { of: 'loop', event: 'resumed', ref: loop.id, title: `Loop going again · ${everyLabel(loop.every)}` })
    }
    this.host.changed(chat)
  }

  removeLoop(chat: Chat, id: string): void {
    const loop = this.loopOf(chat, id)
    if (!loop) return
    chat.loops = (chat.loops || []).filter((l) => l !== loop)
    this.plans.delete(id)
    this.fails.delete(id)
    this.host.changed(chat)
  }

  /** Ends every loop that is still going in a chat. Returns how many there were. */
  stopLoops(chat: Chat): number {
    const live = (chat.loops || []).filter((l) => l.status !== 'done')
    for (const l of live) this.endLoop(chat, l, 'Ended by you.')
    return live.length
  }

  runLoop(chat: Chat, id: string): void {
    const loop = this.loopOf(chat, id)
    if (!loop) throw new Error('That loop no longer exists.')
    if (loop.running) return
    if (loop.status !== 'active') {
      if (loop.maxRuns && loop.runs >= loop.maxRuns) loop.maxRuns = null
      loop.status = 'active'
      loop.note = undefined
    }
    loop.nextAt = Date.now()
    this.host.changed(chat)
    this.fire(chat, loop)
  }

  /** What an agent says about a loop from inside a run (the `loop_update` tool). */
  loopUpdate(chat: Chat, me: Account, args: { id?: string; next_in_minutes?: number; stop?: boolean; reason?: string }): string {
    const live = (chat.loops || []).filter((l) => l.status === 'active')
    // Without an id only a loop that runs on the caller is meant: never someone else's.
    const mine = live.filter((l) => l.to === me.id)
    const loop = args.id ? live.find((l) => l.id === args.id) : mine.find((l) => l.running) || (mine.length === 1 ? mine[0] : undefined)
    if (!loop) return args.id ? `There is no loop ${args.id} going in this chat.` : mine.length ? `Say which loop by id: ${mine.map((l) => `${l.id} ("${oneLine(l.prompt, 50)}")`).join(', ')}.` : 'No loop of yours is going in this chat. Pass the id to mean another one.'
    const reason = String(args.reason || '').trim()
    if (args.stop) {
      // During a run the ending waits for the reply to finish, so its last words are kept.
      if (loop.running) this.plans.set(loop.id, { stop: true, reason: reason || undefined })
      else this.endLoop(chat, loop, reason || 'The agent ended it.')
      return `Loop ${loop.id} ends${loop.running ? ' when this reply does' : ' now'}. Say in your reply why it ended.`
    }
    const mins = Number(args.next_in_minutes)
    if (!Number.isFinite(mins) || mins <= 0) return 'Pass next_in_minutes (1 to 1440) for when the next run is due, or stop to end the loop.'
    const ms = Math.max(MIN, Math.min(24 * 60 * MIN, Math.round(mins * MIN)))
    if (loop.running) this.plans.set(loop.id, { nextIn: ms })
    else {
      loop.nextAt = Date.now() + ms
      this.host.changed(chat)
    }
    return `The next run of loop ${loop.id} is in ${span(ms)}.`
  }

  /** The loops of a chat in a few lines, for an agent that asks. */
  loopsText(chat: Chat): string {
    const live = (chat.loops || []).filter((l) => l.status !== 'done')
    if (!live.length) return 'No loop is going in this chat.'
    return live.map((l) => `${l.id} · ${l.status}${l.running ? ', running now' : ''} · ${everyLabel(l.every)} · run ${l.runs}${l.maxRuns ? ` of ${l.maxRuns}` : ''}${l.until ? ` · until: ${l.until}` : ''} · "${oneLine(l.prompt, 120)}"`).join('\n')
  }

  private tick(): void {
    const now = Date.now()
    for (const chat of this.host.chats()) {
      const goal = chat.goal
      if (goal?.status === 'active' && !goal.checking) {
        const lead = this.host.lead(chat)
        // An active goal always has something under way: the lead replying, the team working, a check
        // being made, or one owed. One with none of those has fallen through a crack and would sit
        // there for ever, looking busy: it is paused, never sent back by itself.
        const still = !!lead && this.free(chat, lead) && !this.host.out(chat, lead)
        if (!still) this.adrift.delete(goal.id)
        else if (goal.deadline && now >= goal.deadline) {
          // Time ran out between rounds.
          this.adrift.delete(goal.id)
          this.due.delete(goal.id)
          goal.status = 'stopped'
          goal.endedAt = now
          goal.note = 'Time is up.'
          this.row(chat, lead, { of: 'goal', event: 'stopped', ref: goal.id, title: 'Goal stopped before it was met', text: goal.note })
          this.host.changed(chat)
          this.host.tell('Goal stopped before it was met', 'Time is up.', chat, lead.id)
        } else if (this.wake.has(goal.id)) {
          // Resumed while the lead was busy, and now it is free.
          this.adrift.delete(goal.id)
          this.sendResume(chat, goal, lead)
        } else if (!this.adrift.has(goal.id)) this.adrift.set(goal.id, now)
        else if (this.due.has(goal.id)) {
          // A check is owed and the lead is free with nothing out: make it (normally the end of the
          // lead's next reply does this; this is the safety net).
          if (now - (this.adrift.get(goal.id) || now) > DUE_GRACE_MS) {
            const due = this.due.get(goal.id)!
            this.adrift.delete(goal.id)
            this.due.delete(goal.id)
            void this.check(chat, goal, lead, due)
          }
        } else if (now - (this.adrift.get(goal.id) || now) > ADRIFT_MS) {
          this.adrift.delete(goal.id)
          this.pauseGoal(chat, goal, lead, 'Paused because nothing was under way on it. Resume to carry on.')
          this.host.tell('Goal paused', 'Nothing was under way on the goal, so it was paused rather than left looking busy. Resume to carry on.', chat, lead.id)
        }
      } else if (goal) this.adrift.delete(goal.id)
      if (!chat.loops?.length) continue
      for (const loop of chat.loops) {
        if (loop.status !== 'active' || loop.running || !loop.nextAt || loop.nextAt > now) continue
        try {
          this.fire(chat, loop)
        } catch (e) {
          console.error('[loop]', (e as Error).message)
        }
      }
    }
  }
}
