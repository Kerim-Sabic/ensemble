import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, ChevronDown, CornerDownLeft, FileText, Flame, Paperclip, Repeat, Rocket, Square, Target, TriangleAlert, WandSparkles, X } from 'lucide-react'
import type { Attachment, UsageWindow, WorkMode } from '@shared/types'
import { goalOpen, parseEvery } from '@shared/auto'
import { IMAGE_EXT } from '@shared/tools'
import { agentKey, focusOf, isBusy, leadOf, uiBus, useStore, useTeam, type SendOptions } from '@/store'
import { accentVars, api, baseName, cn, errorText, until } from '@/lib/util'
import { IconButton, Kbd, Menu, MenuItem, MenuLabel, Spinner, Tip } from '../ui'
import { Orb } from '../Orb'
import { ModelPill } from './composer/ModelPill'
import { GoalOptions, LoopOptions, ModePill } from './composer/Options'
import { ComposerPopup, popupFor } from './composer/Popup'
import { NudgeChip, PreviewChip, UndoChip } from './composer/Chips'
import { NO_EXTRAS, commandOf, goalOf, gocrazyAllowed, loopOf, nudgeOf, previewOf, type Extras } from './composer/extras'
import './composer/ultra'

/** Lets other parts of the screen put text into the message box. */
export const composerBus = new EventTarget()
export const seedComposer = (text: string): void => void composerBus.dispatchEvent(new CustomEvent('seed', { detail: text }))

// What you were typing in each chat survives switching away and back, with what goes with it.
type Draft = { text: string; attachments: Attachment[]; extras: Extras; undo: string | null }
const drafts = new Map<string, Draft>()

/** A message needs about this much to it before it is worth improving. */
const ENHANCE_MIN = 12

const limitedWindow = (u: { session?: UsageWindow; weekly?: UsageWindow } | undefined): UsageWindow | undefined =>
  [u?.session, u?.weekly].find((w) => w && (w.status === 'rejected' || w.utilization >= 1) && w.resetsAt && w.resetsAt > Date.now())

export function Composer() {
  const chatId = useStore((s) => s.chatId)
  const accounts = useStore((s) => s.accounts)
  // Everyone who can be written to here: the accounts, and the agents that were started in this chat.
  const team = useTeam()
  const statuses = useStore((s) => s.statuses)
  const usage = useStore((s) => s.usage)
  const focusId = useStore(focusOf)
  const leadId = useStore((s) => leadOf(s)?.id)
  const state = useStore((s) => (s.chatId && focusId ? s.agents[agentKey(s.chatId, focusId)] : undefined))
  const hasGoal = useStore((s) => goalOpen(s.chats.find((c) => c.id === s.chatId)?.goal))
  const chatUltra = useStore((s) => !!s.chats.find((c) => c.id === s.chatId)?.ultra)
  const storeUltra = useStore((s) => s.setUltra)
  const settings = useStore((s) => s.settings)
  const setFocus = useStore((s) => s.setFocus)
  const send = useStore((s) => s.send)
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)
  const toast = useStore((s) => s.toast)

  const slot = chatId || 'new'
  const [text, setText] = useState(() => drafts.get(slot)?.text || '')
  const [attachments, setAttachments] = useState<Attachment[]>(() => drafts.get(slot)?.attachments || [])
  const [extras, setExtras] = useState<Extras>(() => drafts.get(slot)?.extras || NO_EXTRAS)
  // Ultra belongs to the chat and stays on until turned off. Before the chat exists, the draft keeps it.
  const ultra = chatId ? chatUltra : extras.ultra
  // What was written before it was improved, while it can still be put back.
  const [undo, setUndo] = useState<string | null>(() => drafts.get(slot)?.undo ?? null)
  // The chat whose message is being improved right now. The result goes back to that chat's draft.
  const [improving, setImproving] = useState<string | null>(null)
  const enhancing = improving === slot
  const [dragging, setDragging] = useState(false)
  const [at, setAt] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const slotRef = useRef(slot)
  slotRef.current = slot

  const patch = useCallback((p: Partial<Extras>) => setExtras((x) => ({ ...x, ...p })), [])

  // An agent that was sent home is no longer on the team, but what it did can still be read.
  const former = useStore((s) => (focusId ? s.members[focusId] : undefined))
  const target = team.find((a) => a.id === focusId) || former
  const lead = team.find((a) => a.id === leadId)
  const gone = !!target?.spawned?.gone
  const busy = isBusy(state)
  const signedOut = target ? statuses[target.id]?.state === 'signed-out' : false
  const limited = target ? limitedWindow(usage[target.id]) : undefined
  const suggestion = !text && !busy && attachments.length === 0 && !extras.kind ? state?.suggestion : undefined

  const command = useMemo(() => commandOf(text), [text])
  const preview = useMemo(() => previewOf(command, ultra), [command, ultra])
  const nudge = useMemo(() => (extras.kind || extras.nudgeOff || command ? null : nudgeOf(text)), [text, extras.kind, extras.nudgeOff, command])
  // A goal is the lead's to carry: whoever is selected, it goes to them.
  const notLead = extras.kind === 'goal' && !!target && !!leadId && target.id !== leadId

  // When whoever you are writing to has run dry, the best person to take over.
  const standIn = useMemo(() => {
    if (!limited || !target) return undefined
    return accounts.find((a) => a.enabled && a.id !== target.id && a.provider === 'claude' && statuses[a.id]?.state === 'ready' && !limitedWindow(usage[a.id]))
  }, [limited, target, accounts, statuses, usage])

  // Swap drafts when the chat changes.
  const prevSlot = useRef(slot)
  useEffect(() => {
    if (prevSlot.current === slot) return
    prevSlot.current = slot
    const d = drafts.get(slot)
    setText(d?.text || '')
    setAttachments(d?.attachments || [])
    setExtras(d?.extras || NO_EXTRAS)
    setUndo(d?.undo ?? null)
    ref.current?.focus()
  }, [slot])
  useEffect(() => {
    drafts.set(slot, { text, attachments, extras, undo })
  }, [slot, text, attachments, extras, undo])

  const focusEnd = useCallback((): void => {
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [])

  useEffect(() => {
    const onSeed = (e: Event): void => {
      const seed = (e as CustomEvent<string>).detail
      // A bare "/goal ", "/loop 15m " or "/plan " from a starter turns the switch on instead,
      // so the options are there to see and the message is written in plain words.
      const bare = /^\/(goal|loop|plan|quick|thorough|council|research)(?:\s+(\S+))?\s*$/i.exec(seed)
      const pace = bare?.[2] ? parseEvery(bare[2]) : undefined
      if (bare && (!bare[2] || (bare[1].toLowerCase() === 'loop' && pace))) {
        const name = bare[1].toLowerCase()
        setExtras((x) =>
          name === 'goal' ? { ...x, kind: 'goal' } : name === 'loop' ? { ...x, kind: 'loop', every: pace ?? x.every } : { ...x, mode: name as WorkMode },
        )
        setText('')
      } else setText(seed)
      setUndo(null)
      focusEnd()
    }
    composerBus.addEventListener('seed', onSeed)
    uiBus.addEventListener('focus-composer', focusEnd)
    return () => {
      composerBus.removeEventListener('seed', onSeed)
      uiBus.removeEventListener('focus-composer', focusEnd)
    }
  }, [focusEnd])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const submit = useCallback(async () => {
    let body = text.trim()
    if (!body && !attachments.length) return
    // "/loop 15m" and nothing more would start a loop whose whole job is "15m"; "/gocrazy" needs Ultra on.
    if (previewOf(commandOf(body), ultra)?.incomplete) return
    // "@Name do this" sends straight to that teammate.
    let to: string | undefined
    if (body.startsWith('@')) {
      const lower = body.toLowerCase()
      const match = [...team].sort((a, b) => b.name.length - a.name.length).find((a) => lower.startsWith(`@${a.name.toLowerCase()}`) && /^[\s,:]/.test(body.slice(a.name.length + 1) || ' '))
      if (match) {
        to = match.id
        body = body.slice(match.name.length + 1).replace(/^[\s,:]+/, '')
      }
    }
    // A typed command says it all: the engine reads it, and the switches below stay out of its way.
    const opts: SendOptions = {}
    if (!commandOf(body)) {
      if (extras.mode !== 'chat' && extras.mode !== 'ultra' && (extras.mode !== 'gocrazy' || gocrazyAllowed(ultra))) opts.mode = extras.mode
      if (extras.kind === 'goal' && body) {
        opts.goal = goalOf(extras, { rounds: settings.goalRounds ?? 12, check: settings.goalCheck ?? 'fresh' })
        if (leadId) to = leadId
      } else if (extras.kind === 'loop' && body) opts.loop = loopOf(extras)
    }
    const sent: Draft = { text, attachments, extras, undo }
    setText('')
    setAttachments([])
    setExtras(NO_EXTRAS)
    setUndo(null)
    drafts.delete(slot)
    if (!chatId && extras.ultra) opts.ultra = true
    const ok = await send(body, sent.attachments, to, opts.mode || opts.goal || opts.loop || opts.ultra ? opts : undefined)
    if (!ok) {
      setText(sent.text)
      setAttachments(sent.attachments)
      setExtras(sent.extras)
      setUndo(sent.undo)
    }
  }, [text, attachments, extras, undo, team, send, slot, chatId, leadId, ultra, settings.goalRounds, settings.goalCheck])

  const stop = useCallback(() => {
    if (chatId && focusId) void api.stop(chatId, focusId)
  }, [chatId, focusId])

  const enhance = useCallback(async () => {
    const original = text
    if (improving || original.trim().length < ENHANCE_MIN) return
    const from = slot
    setImproving(from)
    try {
      const better = (await api.enhance(original, chatId))?.trim()
      if (!better || better === original.trim()) {
        toast('It already reads clearly.')
        return
      }
      if (slotRef.current === from) {
        setText(better)
        setUndo(original)
        focusEnd()
      } else {
        // The chat was switched while it worked: the result waits in that chat's draft.
        const d = drafts.get(from)
        if (d && d.text === original) drafts.set(from, { ...d, text: better, undo: original })
      }
    } catch (e) {
      const why = errorText(e)
      toast(/unknown method|not a function/i.test(why) ? 'Improving a message is not available in this version yet.' : why, /unknown method|not a function/i.test(why) ? 'warn' : 'error')
    } finally {
      setImproving(null)
    }
  }, [text, improving, slot, chatId, toast, focusEnd])

  const toggle = useCallback(
    (kind: 'goal' | 'loop') => {
      setExtras((x) => ({ ...x, kind: x.kind === kind ? null : kind }))
      ref.current?.focus()
    },
    [],
  )

  const flipUltra = useCallback(
    (on: boolean) => {
      if (chatId) void storeUltra(chatId, on)
      else patch({ ultra: on })
      ref.current?.focus()
    },
    [chatId, storeUltra, patch],
  )
  // Go crazy only goes out in Ultra: once Ultra is off, however that happened, it falls back.
  useEffect(() => {
    if (!ultra && extras.mode === 'gocrazy') patch({ mode: 'chat' })
  }, [ultra, extras.mode, patch])

  // Alt+G, Alt+L, Alt+U and Ctrl+Shift+E work wherever the focus is, as long as nothing is open on top.
  const keys = useRef({ toggle, enhance, ultra: () => flipUltra(!ultra) })
  keys.current = { toggle, enhance, ultra: () => flipUltra(!ultra) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (useStore.getState().modal || e.defaultPrevented) return
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyG' || e.code === 'KeyL')) {
        e.preventDefault()
        keys.current.toggle(e.code === 'KeyG' ? 'goal' : 'loop')
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyU') {
        e.preventDefault()
        keys.current.ultra()
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE') {
        e.preventDefault()
        void keys.current.enhance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const attach = (next: Attachment[]): void => {
    if (next.length) setAttachments((a) => [...a, ...next.filter((n) => !a.some((x) => x.path === n.path))])
  }

  const addFiles = (files: FileList | File[]): void => {
    const next: Attachment[] = []
    for (const f of Array.from(files)) {
      const p = api.pathForFile(f)
      if (p) next.push({ path: p, name: baseName(p), kind: IMAGE_EXT.test(p) ? 'image' : 'file' })
      // A screenshot pasted from the clipboard has no file behind it yet.
      else if (f.type.startsWith('image/')) void f.arrayBuffer().then((buf) => api.saveImage(buf, f.type)).then((a) => a && attach([a]), () => undefined)
    }
    attach(next)
  }

  const popup = useMemo(() => popupFor(text, team, target ? statuses[target.id]?.commands : undefined, ultra), [text, team, statuses, target, ultra])
  const count = popup?.items.length || 0
  const index = Math.min(at, Math.max(0, count - 1))

  const choose = (i: number): void => {
    if (!popup) return
    if (popup.kind === 'command' && popup.items[i].disabled) return
    if (popup.kind === 'mention') setText(`@${popup.items[i].name} `)
    else setText(`/${popup.items[i].name} `)
    setAt(0)
    ref.current?.focus()
  }

  const canSend = (!!text.trim() || attachments.length > 0) && !!target && !signedOut && !gone && !enhancing && !preview?.incomplete
  const canEnhance = text.trim().length >= ENHANCE_MIN && !!target && !gone
  const kind = command ? null : extras.kind
  const placeholder = !target
    ? 'Add an account to get started'
    : gone
      ? `${target.name} was sent home and takes no more messages`
      : signedOut
        ? `${target.name} is signed out`
        : extras.kind === 'goal'
          ? 'Describe what done looks like. The team keeps going until it is.'
          : extras.mode === 'gocrazy' && ultra
            ? 'Go crazy: describe what to make. Every top model builds its own version, then the best one wins.'
          : extras.kind === 'loop'
            ? 'What should happen each time? It runs now, then again by itself.'
            : suggestion
              ? suggestion
              : target.id === leadId
                ? ultra
                  ? `Ultra is on. Ask ${target.name} anything and the whole team goes all out.`
                  : `Ask ${target.name} anything. It can bring in the rest of the team.`
                : `Message ${target.name} directly`

  // One quiet thing at a time beside the buttons: what is happening, or what could.
  const status = enhancing ? (
    <span className="shimmer-text truncate text-[11.5px] font-medium">Improving your message</span>
  ) : undo !== null ? (
    <UndoChip
      onUndo={() => {
        setText(undo)
        setUndo(null)
        focusEnd()
      }}
    />
  ) : preview ? (
    <PreviewChip preview={preview} />
  ) : nudge ? (
    <NudgeChip
      kind={nudge.kind}
      onTake={() => {
        patch({ kind: nudge.kind, ...(nudge.every ? { every: nudge.every } : {}) })
        ref.current?.focus()
      }}
      onDismiss={() => {
        patch({ nudgeOff: true })
        ref.current?.focus()
      }}
    />
  ) : !text && !busy && !suggestion && !extras.kind ? (
    <span className="mr-1 hidden items-center gap-1 text-[11.5px] text-ink-4 lg:flex">
      <Kbd>@</Kbd> teammate <Kbd className="ml-1.5">/</Kbd> command
    </span>
  ) : null

  const crazy = !kind && !command && extras.mode === 'gocrazy' && gocrazyAllowed(ultra)
  const sendLabel = kind === 'goal' ? 'Start goal' : kind === 'loop' ? 'Start loop' : crazy ? 'Go crazy' : busy ? 'Send when the current reply ends' : ultra ? 'Send in Ultra' : 'Send'
  const SendIcon = kind === 'goal' ? Target : kind === 'loop' ? Repeat : ArrowUp

  return (
    <div className="mx-auto w-full max-w-[780px] px-7 pb-5">
      {/* Right after a failed reply the transcript already offers the way out. */}
      {limited && target && state?.phase !== 'error' && (
        <div className="mb-2 flex animate-rise items-center gap-2.5 rounded-[14px] bg-warn-soft py-2 pr-2 pl-3.5 text-[12.5px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_28%,transparent)]">
          <TriangleAlert className="size-4 shrink-0 text-warn" strokeWidth={1.9} />
          <span className="min-w-0 flex-1 leading-snug">
            <span className="font-medium">{target.name} has used up its allowance.</span> <span className="text-ink-2">It is back in {until(limited.resetsAt as number)}.</span>
          </span>
          {standIn && chatId && target.id === leadId ? (
            <button
              onClick={() => void run(api.setChatLead(chatId, standIn.id)).then((c) => c && setFocus(standIn.id))}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] bg-surface px-2.5 font-medium shadow-card transition-colors hover:bg-surface-2"
            >
              <Orb account={standIn} size={14} /> Let {standIn.name} lead
            </button>
          ) : (
            standIn && (
              <button onClick={() => setFocus(standIn.id)} className="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] bg-surface px-2.5 font-medium shadow-card transition-colors hover:bg-surface-2">
                <Orb account={standIn} size={14} /> Ask {standIn.name} instead
              </button>
            )
          )}
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addFiles(e.dataTransfer.files)
        }}
        style={accentVars((notLead ? lead : target)?.accent)}
        data-busy={busy ? 'true' : undefined}
        data-auto={extras.kind || undefined}
        data-ultra={ultra || undefined}
        className={cn('composer relative rounded-[22px] bg-surface shadow-float transition-shadow duration-200', ultra && 'cu-card', dragging && 'shadow-[0_0_0_2px_var(--a2)]')}
      >
        {ultra && (
          <span aria-hidden className="cu-ring">
            <span className="cu-spin" />
          </span>
        )}
        {popup && <ComposerPopup popup={popup} index={index} onPick={choose} onHover={setAt} who={target?.name} leadId={leadId} />}
        <AnimatePresence initial={false}>
          {extras.kind && (
            <motion.div
              key="auto"
              initial={{ height: 0, opacity: 0 }}
              // A typed command overrides the switches: the row stays, faded, until the command goes.
              animate={{ height: 'auto', opacity: command ? 0.45 : 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="pb-1">
                {extras.kind === 'goal' ? (
                  <GoalOptions x={extras} set={patch} onSubmit={() => void submit()} onDone={focusEnd} replaces={hasGoal} lead={lead} notLead={notLead} />
                ) : (
                  <LoopOptions x={extras} set={patch} onSubmit={() => void submit()} onDone={focusEnd} />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
            {attachments.map((a) => (
              <span key={a.path} className="group/att relative flex h-8 animate-pop items-center gap-1.5 overflow-hidden rounded-[9px] bg-surface-2 pr-2 text-[12px] shadow-[inset_0_0_0_1px_var(--line)]">
                {a.kind === 'image' ? <img src={api.fileUrl(a.path)} alt="" className="size-8 object-cover" /> : <FileText className="ml-2 size-3.5 text-ink-3" />}
                <span className="max-w-[160px] truncate">{a.name}</span>
                <button aria-label={`Remove ${a.name}`} onClick={() => setAttachments((x) => x.filter((y) => y.path !== a.path))} className="text-ink-3 hover:text-ink">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="relative">
          <textarea
            ref={ref}
            value={text}
            rows={1}
            autoFocus
            readOnly={enhancing}
            aria-busy={enhancing || undefined}
            disabled={!target || gone}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value)
              setAt(0)
              if (undo !== null) setUndo(null)
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault()
                addFiles(e.clipboardData.files)
              }
            }}
            onKeyDown={(e) => {
              if (popup && count) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setAt((index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  choose(index)
                  return
                }
              }
              if (e.key === 'Tab' && suggestion && !e.shiftKey) {
                e.preventDefault()
                setText(suggestion)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              } else if (e.key === 'Escape' && busy && !text) {
                stop()
              }
            }}
            className={cn(
              'selectable block max-h-[240px] w-full resize-none bg-transparent px-[18px] pb-1 text-[14.5px] leading-[1.5] text-ink outline-none transition-[color,padding] duration-200 placeholder:text-ink-3',
              extras.kind ? 'pt-[9px]' : 'pt-[15px]',
              suggestion && 'pr-[70px] placeholder:text-ink-4',
              enhancing && 'text-ink-3',
            )}
          />
          {suggestion && (
            <span className="pointer-events-none absolute top-[15px] right-4 flex animate-fade-in items-center gap-1 text-[11.5px] text-ink-4">
              <Kbd>Tab</Kbd>
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 px-2.5 pt-1 pb-2.5">
          <IconButton
            label="Attach files"
            side="top"
            onClick={async () => {
              attach(await api.pickFiles())
            }}
          >
            <Paperclip className="size-[15px]" />
          </IconButton>

          <Menu
            side="top"
            width={264}
            trigger={
              <button className="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] pr-1.5 pl-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink">
                <Orb account={target} size={15} />
                {target?.name || 'Nobody'}
                <ChevronDown className="size-3 text-ink-3" />
              </button>
            }
          >
            <MenuLabel>Send to</MenuLabel>
            {team.map((a) => {
              const out = statuses[a.id]?.state === 'signed-out'
              return (
                <MenuItem
                  key={a.id}
                  icon={<Orb account={a} size={15} off={out} />}
                  checked={a.id === focusId}
                  hint={out ? 'Signed out' : a.id === leadId ? 'Lead · plans and hands out work' : a.role?.trim() || (a.provider === 'chatgpt' ? 'ChatGPT · can make images' : 'Teammate')}
                  onSelect={() => (out && !a.spawned ? setModal({ kind: 'account', id: a.id }) : setFocus(a.id))}
                >
                  {a.name}
                </MenuItem>
              )
            })}
          </Menu>

          <ModePill
            ultra={ultra}
            onUltra={flipUltra}
            mode={extras.mode}
            onChange={(mode) => {
              patch({ mode })
              focusEnd()
            }}
          />

          {/* Ultra runs every agent on the strongest model at full effort, so a model picked here would not apply. */}
          {target && !signedOut && !ultra && <ModelPill account={target} />}

          {/* The model pill gives way first (down to its icon and a few letters), then this. */}
          <span className="flex min-w-0 flex-1 basis-auto items-center justify-end pl-1.5">{status}</span>
          {busy && canSend && !status && (
            <Tip label="Sends when the current reply ends" side="top">
              <span className="ml-1.5 flex shrink-0 items-center gap-1 text-[11.5px] text-ink-4">
                <CornerDownLeft className="size-3" /> queues
              </span>
            </Tip>
          )}

          <span className="ml-1 flex shrink-0 items-center gap-0.5">
            {ultra ? (
              <Tip label="Ultra is on for this chat. Click to turn it off" kbd="Alt+U" side="top">
                <button
                  type="button"
                  aria-pressed
                  aria-label="Ultra is on"
                  onClick={() => flipUltra(false)}
                  className="cu-pill mr-1 flex h-7 shrink-0 animate-pop items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[12.5px] font-semibold transition-colors"
                >
                  <Rocket className="cu-icon size-[14px]" strokeWidth={2} />
                  <span className="cu-text">Ultra</span>
                </button>
              </Tip>
            ) : (
              <Tip
                label={
                  <span>
                    <span className="font-semibold">Ultra.</span> Many agents on the strongest models at full effort. Uses allowance very fast.
                  </span>
                }
                kbd="Alt+U"
                side="top"
              >
                <button
                  type="button"
                  aria-pressed={false}
                  aria-label="Turn Ultra on"
                  onClick={() => flipUltra(true)}
                  className="no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink active:bg-active"
                >
                  <Rocket className="size-[15px]" strokeWidth={1.75} />
                </button>
              </Tip>
            )}
            <IconButton label="Improve this message" kbd="Ctrl+Shift+E" side="top" disabled={!canEnhance && !enhancing} aria-busy={enhancing || undefined} onClick={() => void enhance()}>
              {enhancing ? <Spinner className="text-accent" /> : <WandSparkles className="size-[15px]" strokeWidth={1.75} />}
            </IconButton>
            <IconButton
              label="Goal: keep working until it is done"
              kbd="Alt+G"
              side="top"
              aria-pressed={extras.kind === 'goal'}
              onClick={() => toggle('goal')}
              className={cn(extras.kind === 'goal' && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent')}
            >
              <Target className="size-[15px]" strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label="Loop: send this again by itself"
              kbd="Alt+L"
              side="top"
              aria-pressed={extras.kind === 'loop'}
              onClick={() => toggle('loop')}
              className={cn(extras.kind === 'loop' && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent')}
            >
              <Repeat className="size-[15px]" strokeWidth={1.75} />
            </IconButton>
          </span>

          {busy && !canSend ? (
            <Tip label="Stop" kbd="Esc" side="top">
              <button
                onClick={stop}
                aria-label="Stop"
                className="ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-inverse transition-transform duration-150 hover:scale-105 active:scale-95"
              >
                <Square className="size-3 fill-current" strokeWidth={0} />
              </button>
            </Tip>
          ) : (
            <Tip label={sendLabel} kbd="Enter" side="top">
              <button
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={sendLabel}
                className={cn(
                  'ml-1.5 flex h-8 shrink-0 items-center justify-center rounded-full transition-all duration-150 hover:scale-105 active:scale-95 disabled:scale-100 disabled:bg-active disabled:text-ink-4 disabled:shadow-none disabled:[background-image:none]',
                  crazy ? 'gap-1.5 pr-3.5 pl-3 text-[12.5px] font-semibold hover:scale-[1.03]' : 'w-8',
                  kind ? 'bg-accent text-white' : ultra ? 'cu-send' : 'bg-ink text-inverse',
                )}
              >
                {crazy ? (
                  <>
                    <Flame key="crazy" className="size-[15px] animate-pop" strokeWidth={2.2} />
                    Go crazy
                  </>
                ) : (
                  <SendIcon key={kind || 'send'} className="size-4 animate-pop" strokeWidth={kind ? 2.2 : 2.4} />
                )}
              </button>
            </Tip>
          )}
        </div>
      </div>
    </div>
  )
}
