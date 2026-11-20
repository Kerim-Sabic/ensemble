import { memo, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  Blocks,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  FileText,
  FilePen,
  FilePlus2,
  Globe,
  Image as ImageIcon,
  ListChecks,
  MousePointerClick,
  NotebookPen,
  NotebookText,
  Search,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench,
} from 'lucide-react'
import type { Item } from '@shared/types'
import { describeTool, type ToolIcon } from '@shared/tools'
import { cn, duration } from '@/lib/util'
import { Spinner } from '../ui'
import { Markdown } from '../Markdown'
import { useStreamed } from '@/lib/streams'
import { ScreenRow } from '../screen/ScreenCard'
import { rendered } from '@/lib/perf'

type ToolItem = Extract<Item, { kind: 'tool' }>
type ThinkingItem = Extract<Item, { kind: 'thinking' }>
type ScreenItem = Extract<Item, { kind: 'screen' }>
export type ActivityItem = ToolItem | ThinkingItem | ScreenItem

const ICONS: Record<ToolIcon, typeof FileText> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  terminal: SquareTerminal,
  search: Search,
  web: Globe,
  agent: Bot,
  todo: ListChecks,
  team: Users,
  memory: NotebookPen,
  image: ImageIcon,
  plug: Blocks,
  skill: Sparkles,
  note: NotebookText,
  screen: MousePointerClick,
  tool: Wrench,
}

function Mono({ children, tone }: { children: ReactNode; tone?: 'bad' }) {
  return (
    <pre
      className={cn(
        'selectable max-h-[260px] overflow-auto rounded-[9px] bg-[var(--code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--line)]',
        tone === 'bad' ? 'text-bad' : 'text-ink-2',
      )}
    >
      {children}
    </pre>
  )
}

function DiffLines({ before, after }: { before: string; after: string }) {
  const a = before.split('\n').slice(0, 40)
  const b = after.split('\n').slice(0, 40)
  return (
    <pre className="selectable max-h-[260px] overflow-auto rounded-[9px] bg-[var(--code-bg)] py-2 font-mono text-[12px] leading-[1.55] shadow-[inset_0_0_0_1px_var(--line)]">
      {a.map((l, i) => (
        <div key={`a${i}`} className="bg-bad-soft px-3 whitespace-pre-wrap text-bad">
          <span className="mr-2 opacity-60 select-none">−</span>
          {l || ' '}
        </div>
      ))}
      {b.map((l, i) => (
        <div key={`b${i}`} className="bg-ok-soft px-3 whitespace-pre-wrap text-ok">
          <span className="mr-2 opacity-60 select-none">+</span>
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

function Todos({ todos }: { todos: { content?: string; status?: string; activeForm?: string }[] }) {
  return (
    <div className="space-y-1 py-0.5">
      {todos.map((t, i) => (
        <div key={i} className="flex items-start gap-2 text-[13px]">
          {t.status === 'completed' ? (
            <Check className="mt-[3px] size-3.5 shrink-0 text-ok" strokeWidth={2.5} />
          ) : t.status === 'in_progress' ? (
            <CircleDot className="mt-[3px] size-3.5 shrink-0 text-ink" />
          ) : (
            <Circle className="mt-[3px] size-3.5 shrink-0 text-ink-4" />
          )}
          <span className={cn(t.status === 'completed' ? 'text-ink-3 line-through decoration-ink-4' : t.status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-2')}>
            {t.content}
          </span>
        </div>
      ))}
    </div>
  )
}

function ToolDetail({ item }: { item: ToolItem }) {
  const input = (item.input && typeof item.input === 'object' ? item.input : {}) as Record<string, unknown>
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const out = item.output?.trim()
  const isError = item.status === 'error'
  const blocks: ReactNode[] = []

  if (Array.isArray(input.todos)) {
    blocks.push(<Todos key="todos" todos={input.todos as { content?: string; status?: string }[]} />)
  } else if (s('command')) {
    blocks.push(<Mono key="cmd">{s('command')}</Mono>)
  } else if (s('old_string') || s('new_string')) {
    blocks.push(
      <div key="path" className="selectable font-mono text-[11.5px] text-ink-3">
        {s('file_path')}
      </div>,
      <DiffLines key="diff" before={s('old_string')} after={s('new_string')} />,
    )
  } else if (s('content') && s('file_path')) {
    blocks.push(
      <div key="path" className="selectable font-mono text-[11.5px] text-ink-3">
        {s('file_path')}
      </div>,
      <Mono key="content">{s('content').split('\n').slice(0, 60).join('\n')}</Mono>,
    )
  } else if (s('prompt')) {
    blocks.push(<Mono key="prompt">{s('prompt')}</Mono>)
  } else if (Object.keys(input).length) {
    const shown = s('file_path') || s('path') || s('url') || s('query') || s('pattern')
    blocks.push(<Mono key="in">{shown && Object.keys(input).length <= 2 ? shown : JSON.stringify(input, null, 2)}</Mono>)
  }
  if (out) blocks.push(<Mono key="out" tone={isError ? 'bad' : undefined}>{out}</Mono>)
  if (!blocks.length) return null
  return <div className="mt-1.5 mb-2 ml-[26px] space-y-1.5">{blocks}</div>
}

export const ToolRow = memo(function ToolRow({ item, childCount }: { item: ToolItem; childCount?: number }) {
  const [open, setOpen] = useState(false)
  const s = describeTool(item.name, item.input)
  const Icon = ICONS[s.icon]
  const running = item.status === 'running'
  const todos = Array.isArray((item.input as { todos?: unknown[] } | undefined)?.todos)
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2 rounded-[7px] px-1.5 text-left text-[13px] transition-colors hover:bg-hover"
      >
        <Icon className={cn('size-[15px] shrink-0', item.status === 'error' ? 'text-bad' : 'text-ink-3')} strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn(running ? 'shimmer-text' : 'text-ink-2')}>{running ? s.doing : s.done}</span>
          {s.target && <span className={cn('ml-1.5', running ? 'text-ink' : 'text-ink-2', s.icon === 'terminal' && 'font-mono text-[12px]')}>{s.target}</span>}
          {!!childCount && <span className="ml-2 text-[12px] text-ink-3">{childCount} steps</span>}
        </span>
        {running ? (
          <Spinner className="size-3" />
        ) : item.status === 'error' ? (
          <AlertCircle className="size-3.5 text-bad" />
        ) : (
          item.durationMs !== undefined && item.durationMs > 1500 && <span className="tabular text-[11.5px] text-ink-4 opacity-0 group-hover/row:opacity-100">{duration(item.durationMs)}</span>
        )}
        <ChevronRight className={cn('size-3.5 shrink-0 text-ink-4 opacity-0 transition-transform group-hover/row:opacity-100', open && 'rotate-90 opacity-100')} />
      </button>
      {(open || (todos && running)) && <ToolDetail item={item} />}
    </div>
  )
})

export const ThinkingRow = memo(function ThinkingRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false)
  const text = useStreamed(item.id, item.text, item.streaming)
  const has = !!text.trim()
  const label = item.streaming ? 'Thinking' : item.durationMs && item.durationMs >= 1000 ? `Thought for ${duration(item.durationMs)}` : 'Thought'
  return (
    <div>
      <button
        onClick={() => has && setOpen((o) => !o)}
        className={cn('group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2 rounded-[7px] px-1.5 text-left text-[13px]', has && 'hover:bg-hover')}
      >
        <Brain className="size-[15px] shrink-0 text-ink-3" strokeWidth={1.75} />
        <span className={cn('flex-1', item.streaming ? 'shimmer-text' : 'text-ink-2')}>{label}</span>
        {has && <ChevronRight className={cn('size-3.5 text-ink-4 opacity-0 transition-transform group-hover/row:opacity-100', open && 'rotate-90 opacity-100')} />}
      </button>
      {open && has && (
        <div className="mt-1 mb-2 ml-[26px] border-l-2 border-line pl-3">
          <Markdown text={text} compact streaming={item.streaming} className="!text-ink-2" />
        </div>
      )}
    </div>
  )
})

function summarize(items: ActivityItem[]): string {
  const counts = new Map<string, number>()
  for (const it of items) {
    if (it.kind === 'thinking') continue
    if (it.kind === 'screen') {
      counts.set(it.surface, (counts.get(it.surface) || 0) + 1)
      continue
    }
    const icon = describeTool(it.name, it.input).icon
    counts.set(icon, (counts.get(icon) || 0) + 1)
  }
  const n = (k: string): number => counts.get(k) || 0
  const parts: string[] = []
  const plural = (c: number, one: string, many: string): string => (c === 1 ? one : many.replace('#', String(c)))
  if (n('read')) parts.push(plural(n('read'), 'read a file', 'read # files'))
  if (n('edit') + n('write')) parts.push(plural(n('edit') + n('write'), 'edited a file', 'edited # files'))
  if (n('terminal')) parts.push(plural(n('terminal'), 'ran a command', 'ran # commands'))
  if (n('search')) parts.push(plural(n('search'), 'searched the project', 'searched # times'))
  if (n('web')) parts.push(plural(n('web'), 'looked something up', 'looked up # things'))
  if (n('agent')) parts.push(plural(n('agent'), 'ran a helper', 'ran # helpers'))
  if (n('image')) parts.push(plural(n('image'), 'created an image', 'created # images'))
  if (n('browser')) parts.push(plural(n('browser'), 'used the browser', 'took # steps in the browser'))
  if (n('desktop')) parts.push(plural(n('desktop'), 'used the computer', 'took # steps on the computer'))
  if (n('note')) parts.push(plural(n('note'), 'used the vault', 'used the vault # times'))
  const other = n('todo') + n('team') + n('memory') + n('plug') + n('skill') + n('tool')
  if (other) parts.push(plural(other, 'used a tool', 'used # tools'))
  if (!parts.length) return 'Thought it through'
  const text = parts.slice(0, 3).join(', ') + (parts.length > 3 ? ' and more' : '')
  return text[0].toUpperCase() + text.slice(1)
}

/** Runs someone opened or folded by hand, by their first row. */
const opened = new Map<string, boolean | null>()

/** A run of thinking and tool use, folded into one line once it is over. */
export const ActivityGroup = memo(function ActivityGroup({
  items,
  children,
  active,
  chatId,
  accountId,
}: {
  items: ActivityItem[]
  children: Map<string, number>
  active: boolean
  chatId: string
  accountId: string
}) {
  rendered('ActivityGroup')
  // Kept by the run's first row, so scrolling it out of view and back does not fold it again.
  const [open, setOpenNow] = useState<boolean | null>(() => opened.get(items[0]?.id) ?? null)
  const setOpen = (v: boolean | null): void => {
    if (items[0]) opened.set(items[0].id, v)
    setOpenNow(v)
  }
  const running = items.some((i) => (i.kind === 'thinking' ? i.streaming : i.status === 'running'))
  const failed = items.filter((i) => i.kind !== 'thinking' && i.status === 'error').length
  const foldable = items.length > 3
  const expanded = open ?? (!foldable || active || running)
  const total = items.reduce((ms, i) => ms + (i.durationMs || 0), 0)

  return (
    <div className="my-1.5">
      {foldable && !(active || running) && (
        <button
          onClick={() => setOpen(!expanded)}
          className="group/sum -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2 rounded-[7px] px-1.5 text-left text-[13px] text-ink-2 hover:bg-hover"
        >
          <ChevronRight className={cn('size-[15px] shrink-0 text-ink-3 transition-transform duration-200', expanded && 'rotate-90')} strokeWidth={1.75} />
          <span className="flex-1 truncate">{summarize(items)}</span>
          {failed > 0 && <span className="text-[11.5px] text-bad">{failed} failed</span>}
          {total > 2000 && <span className="tabular text-[11.5px] text-ink-4">{duration(total)}</span>}
        </button>
      )}
      {expanded && (
        <div className={cn(foldable && !(active || running) && 'ml-[7px] border-l border-line pl-[15px]')}>
          {items.map((it) =>
            it.kind === 'tool' ? (
              <ToolRow key={it.id} item={it} childCount={children.get(it.id)} />
            ) : it.kind === 'screen' ? (
              <ScreenRow key={it.id} item={it} chatId={chatId} accountId={accountId} />
            ) : (
              <ThinkingRow key={it.id} item={it} />
            ),
          )}
        </div>
      )}
    </div>
  )
})
