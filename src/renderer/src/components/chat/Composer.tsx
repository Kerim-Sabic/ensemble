import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, CornerDownLeft, FileText, Gauge, Paperclip, Slash, Square, TriangleAlert, X } from 'lucide-react'
import type { Account, Attachment, UsageWindow } from '@shared/types'
import { IMAGE_EXT } from '@shared/tools'
import { agentKey, focusOf, isBusy, leadOf, uiBus, useStore, useTeam } from '@/store'
import { accentVars, api, baseName, cn, prettyModel, until } from '@/lib/util'
import { IconButton, Kbd, Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from '../ui'
import { Orb } from '../Orb'

/** Lets other parts of the screen put text into the message box. */
export const composerBus = new EventTarget()
export const seedComposer = (text: string): void => void composerBus.dispatchEvent(new CustomEvent('seed', { detail: text }))

// What you were typing in each chat survives switching away and back.
const drafts = new Map<string, { text: string; attachments: Attachment[] }>()

const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const EFFORT_HINT: Record<string, string> = {
  low: 'Quick answers, least allowance',
  medium: 'Balanced',
  high: 'Thinks things through',
  xhigh: 'Thinks hard about difficult work',
  max: 'Everything it has. Slow and costly.',
}

const limitedWindow = (u: { session?: UsageWindow; weekly?: UsageWindow } | undefined): UsageWindow | undefined =>
  [u?.session, u?.weekly].find((w) => w && (w.status === 'rejected' || w.utilization >= 1) && w.resetsAt && w.resetsAt > Date.now())

/** The model and effort the next message will run with, changeable in place. */
function ModelPill({ account }: { account: Account }) {
  const status = useStore((s) => s.statuses[account.id])
  const live = useStore((s) => (s.chatId ? s.agents[agentKey(s.chatId, account.id)]?.model : undefined))
  // Why the app chose the model it is running, when nobody picked one by hand.
  const why = useStore((s) => (s.chatId && !account.model ? s.agents[agentKey(s.chatId, account.id)]?.modelWhy : undefined))
  const smart = useStore((s) => s.settings.smartModels)
  const run = useStore((s) => s.run)
  // An agent started inside a chat has no settings of its own: it shows what it runs, and why.
  if (account.spawned) {
    const label = prettyModel(live) || 'Picked when it starts'
    return (
      <Tip side="top" label={why || 'The app picks the strongest model its account can afford each time it starts.'}>
        <span className="flex h-7 min-w-0 items-center gap-1.5 rounded-[8px] px-1.5 text-[12.5px] text-ink-3">
          <Gauge className="size-[14px] shrink-0" strokeWidth={1.75} />
          <span className="truncate">{label}</span>
        </span>
      </Tip>
    )
  }
  const models = (status?.models || []).filter((m) => m.value)
  const chosen = models.find((m) => m.value === account.model)
  const efforts = (chosen?.efforts || models.find((m) => m.value === 'default')?.efforts || models.find((m) => m.isDefault)?.efforts || (account.provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'])).filter((e) => e !== 'ultra')
  const name = chosen?.label.replace(/\s*\(.*\)$/, '') || prettyModel(live) || models.find((m) => m.isDefault)?.label || (account.provider === 'chatgpt' ? 'ChatGPT' : 'Default model')
  const set = (patch: { model?: string | null; effort?: string | null }): void => void run(api.updateAccount(account.id, patch))

  return (
    <Menu
      side="top"
      width={272}
      trigger={
        <button className="flex h-7 min-w-0 items-center gap-1.5 rounded-[8px] px-1.5 text-[12.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink">
          <Gauge className="size-[14px] shrink-0" strokeWidth={1.75} />
          <span className="truncate">
            {name}
            {account.effort && <span className="text-ink-4"> · {EFFORT_LABEL[account.effort] || account.effort}</span>}
          </span>
          <ChevronDown className="size-3 shrink-0 text-ink-4" />
        </button>
      }
    >
      {models.length > 0 && (
        <>
          <MenuLabel>Model for {account.name}</MenuLabel>
          <MenuItem
            checked={!account.model}
            hint={smart && account.provider === 'claude' ? why || 'The strongest model the allowance can afford, chosen each time it starts' : 'Whatever this account is set to use'}
            onSelect={() => set({ model: null })}
          >
            {smart && account.provider === 'claude' ? 'Best for the allowance' : 'Account default'}
          </MenuItem>
          {models
            .filter((m) => m.value !== 'default')
            .map((m) => (
              <MenuItem key={m.value} checked={m.value === account.model} hint={m.description} onSelect={() => set({ model: m.value })}>
                {m.label}
              </MenuItem>
            ))}
          <MenuSeparator />
        </>
      )}
      <MenuLabel>Effort</MenuLabel>
      <MenuItem checked={!account.effort} onSelect={() => set({ effort: null })}>
        Default
      </MenuItem>
      {efforts.map((e) => (
        <MenuItem key={e} checked={e === account.effort} hint={EFFORT_HINT[e]} onSelect={() => set({ effort: e })}>
          {EFFORT_LABEL[e] || e}
        </MenuItem>
      ))}
    </Menu>
  )
}

type Popup = { kind: 'mention'; items: Account[] } | { kind: 'command'; items: { name: string; description: string; hint?: string }[] } | null

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
  const setFocus = useStore((s) => s.setFocus)
  const send = useStore((s) => s.send)
  const setModal = useStore((s) => s.setModal)
  const run = useStore((s) => s.run)

  const slot = chatId || 'new'
  const [text, setText] = useState(() => drafts.get(slot)?.text || '')
  const [attachments, setAttachments] = useState<Attachment[]>(() => drafts.get(slot)?.attachments || [])
  const [dragging, setDragging] = useState(false)
  const [at, setAt] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  // An agent that was sent home is no longer on the team, but what it did can still be read.
  const former = useStore((s) => (focusId ? s.members[focusId] : undefined))
  const target = team.find((a) => a.id === focusId) || former
  const gone = !!target?.spawned?.gone
  const busy = isBusy(state)
  const signedOut = target ? statuses[target.id]?.state === 'signed-out' : false
  const limited = target ? limitedWindow(usage[target.id]) : undefined
  const suggestion = !text && !busy && attachments.length === 0 ? state?.suggestion : undefined

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
    ref.current?.focus()
  }, [slot])
  useEffect(() => {
    drafts.set(slot, { text, attachments })
  }, [slot, text, attachments])

  useEffect(() => {
    const focusEnd = (): void => {
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    }
    const onSeed = (e: Event): void => {
      setText((e as CustomEvent<string>).detail)
      focusEnd()
    }
    composerBus.addEventListener('seed', onSeed)
    uiBus.addEventListener('focus-composer', focusEnd)
    return () => {
      composerBus.removeEventListener('seed', onSeed)
      uiBus.removeEventListener('focus-composer', focusEnd)
    }
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const submit = useCallback(async () => {
    let body = text.trim()
    if (!body && !attachments.length) return
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
    const sentText = text
    const sentFiles = attachments
    setText('')
    setAttachments([])
    drafts.delete(slot)
    const ok = await send(body, sentFiles, to)
    if (!ok) {
      setText(sentText)
      setAttachments(sentFiles)
    }
  }, [text, attachments, team, send, slot])

  const stop = useCallback(() => {
    if (chatId && focusId) void api.stop(chatId, focusId)
  }, [chatId, focusId])

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

  // "@" at the start offers the team; "/" offers the commands the teammate knows.
  const popup: Popup = useMemo(() => {
    const mention = /^@([^\s]*)$/.exec(text)?.[1]
    if (mention !== undefined) {
      const items = team.filter((a) => a.name.toLowerCase().replace(/\s+/g, '').startsWith(mention.toLowerCase()))
      return items.length ? { kind: 'mention', items } : null
    }
    const cmd = /^\/([\w:-]*)$/.exec(text)?.[1]
    if (cmd !== undefined && target) {
      const all = statuses[target.id]?.commands || []
      const q = cmd.toLowerCase()
      const items = [...all.filter((c) => c.name.toLowerCase().startsWith(q)), ...all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))].slice(0, 8)
      return items.length ? { kind: 'command', items } : null
    }
    return null
  }, [text, team, statuses, target])
  const count = popup?.items.length || 0
  const index = Math.min(at, Math.max(0, count - 1))

  const choose = (i: number): void => {
    if (!popup) return
    if (popup.kind === 'mention') setText(`@${popup.items[i].name} `)
    else setText(`/${popup.items[i].name} `)
    setAt(0)
    ref.current?.focus()
  }

  const canSend = (!!text.trim() || attachments.length > 0) && !!target && !signedOut && !gone
  const placeholder = !target
    ? 'Add an account to get started'
    : gone
      ? `${target.name} was sent home and takes no more messages`
      : signedOut
      ? `${target.name} is signed out`
      : suggestion
        ? suggestion
        : target.id === leadId
          ? `Ask ${target.name} anything. It can bring in the rest of the team.`
          : `Message ${target.name} directly`

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
        style={accentVars(target?.accent)}
        data-busy={busy ? 'true' : undefined}
        className={cn('composer relative rounded-[22px] bg-surface shadow-float transition-shadow duration-200', dragging && 'shadow-[0_0_0_2px_var(--a2)]')}
      >
        {popup && (
          <div className={cn('absolute bottom-full left-3 z-20 mb-2 animate-pop rounded-[12px] bg-raised p-1 shadow-pop', popup.kind === 'mention' ? 'w-[240px]' : 'w-[420px] max-w-[calc(100%-24px)]')}>
            <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-ink-3">{popup.kind === 'mention' ? 'Send to' : `Commands ${target?.name} knows`}</div>
            {popup.kind === 'mention'
              ? popup.items.map((a, i) => (
                  <button
                    key={a.id}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(i)
                    }}
                    onMouseEnter={() => setAt(i)}
                    className={cn('flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px]', i === index && 'bg-hover')}
                  >
                    <Orb account={a} size={15} />
                    <span className="flex-1 truncate">{a.name}</span>
                    {a.id === leadId && <span className="text-[11px] text-ink-3">Lead</span>}
                  </button>
                ))
              : popup.items.map((c, i) => (
                  <button
                    key={c.name}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(i)
                    }}
                    onMouseEnter={() => setAt(i)}
                    className={cn('flex min-h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left', i === index && 'bg-hover')}
                  >
                    <Slash className="size-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px]">
                        {c.name}
                        {c.hint && <span className="ml-1.5 text-ink-4">{c.hint}</span>}
                      </span>
                      {c.description && <span className="block truncate text-[11.5px] text-ink-3">{c.description}</span>}
                    </span>
                  </button>
                ))}
          </div>
        )}
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
            disabled={!target || gone}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value)
              setAt(0)
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
              'selectable block max-h-[240px] w-full resize-none bg-transparent px-[18px] pt-[15px] pb-1 text-[14.5px] leading-[1.5] text-ink outline-none placeholder:text-ink-3',
              suggestion && 'pr-[70px] placeholder:text-ink-4',
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

          {target && !signedOut && <ModelPill account={target} />}

          <span className="flex-1" />
          {!text && !busy && !suggestion && (
            <span className="mr-2 hidden items-center gap-1 text-[11.5px] text-ink-4 lg:flex">
              <Kbd>@</Kbd> teammate <Kbd className="ml-1.5">/</Kbd> command
            </span>
          )}
          {busy && canSend && (
            <Tip label="Sends when the current reply ends" side="top">
              <span className="mr-2 flex items-center gap-1 text-[11.5px] text-ink-4">
                <CornerDownLeft className="size-3" /> queues
              </span>
            </Tip>
          )}
          {busy && !canSend ? (
            <Tip label="Stop" kbd="Esc" side="top">
              <button
                onClick={stop}
                aria-label="Stop"
                className="flex size-8 items-center justify-center rounded-full bg-ink text-inverse transition-transform duration-150 hover:scale-105 active:scale-95"
              >
                <Square className="size-3 fill-current" strokeWidth={0} />
              </button>
            </Tip>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="Send"
              className="flex size-8 items-center justify-center rounded-full bg-ink text-inverse transition-all duration-150 hover:scale-105 active:scale-95 disabled:scale-100 disabled:bg-active disabled:text-ink-4"
            >
              <ArrowUp className="size-4" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
