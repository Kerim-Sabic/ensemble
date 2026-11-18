import { Children, isValidElement, memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { IMAGE_EXT } from '@shared/tools'
import { api, baseName, cn } from '@/lib/util'
import { viewFrom } from './Viewer'
import { AppFence, IUI_LANGS, UiFence } from './iui/Block'
import { IuiContext } from './iui/kit'
import { MdTable, scopeOf, TaskBox, TaskScope } from './iui/MdTable'

const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\/)[^\n]*$/

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const child = Array.isArray(children) ? children[0] : children
  const className = (child as { props?: { className?: string } })?.props?.className || ''
  const lang = /language-([\w+-]+)/.exec(className)?.[1] || ''
  const copy = (): void => {
    void navigator.clipboard.writeText(textOf(children).replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-[11px] bg-[var(--code-bg)] shadow-[inset_0_0_0_1px_var(--line)]">
      <div className="flex h-8 items-center justify-between pr-1.5 pl-3.5">
        <span className="font-mono text-[11px] text-ink-3">{lang || 'text'}</span>
        <button
          onClick={copy}
          className="flex h-6 items-center gap-1.5 rounded-[6px] px-2 text-[11.5px] text-ink-3 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="!pt-0.5">{children}</pre>
    </div>
  )
}

type Hast = { type: string; tagName?: string; value?: string; children?: Hast[]; properties?: { className?: unknown }; data?: { meta?: string | null }; position?: { end?: { offset?: number } } }
const hastText = (n: Hast): string => (n.type === 'text' ? n.value || '' : (n.children || []).map(hastText).join(''))

/**
 * A fence whose language is `ui` or `app` is a Live answers block; anything
 * else is code. `open` is given while the text is still arriving and its last fence has not
 * been closed: the block reaching the end of the text is then still being written.
 */
function pre(open?: { end: number }): NonNullable<Components['pre']> {
  return function Pre({ children, node }) {
    const code = (node as Hast | undefined)?.children?.find((c) => c.type === 'element' && c.tagName === 'code')
    const cls = code?.properties?.className
    const lang = (Array.isArray(cls) ? cls : [cls]).map(String).find((c) => c.startsWith('language-'))?.slice(9).toLowerCase()
    if (code && lang && IUI_LANGS.has(lang)) {
      const source = hastText(code).replace(/\n$/, '')
      const writing = !!open && ((node as Hast).position?.end?.offset ?? 0) >= open.end
      return lang === 'ui' ? <UiFence source={source} open={writing} /> : <AppFence source={source} meta={code.data?.meta || undefined} open={writing} />
    }
    return <CodeBlock>{children}</CodeBlock>
  }
}

/** A task list item ([ ] or [x]): its box can be ticked. */
const li: NonNullable<Components['li']> = ({ node, className, children, ...rest }) => {
  if (!String(className || '').includes('task-list-item')) return <li className={className} {...rest}>{children}</li>
  const at = (node as { position?: { start?: { offset?: number } } } | undefined)?.position?.start?.offset ?? 0
  const kids = Children.toArray(children).map((c) => (isValidElement(c) && c.type === 'input' ? <TaskBox key="box" at={at} checked={!!(c.props as { checked?: boolean }).checked} /> : c))
  return (
    <li className={className} {...rest}>
      {kids}
    </li>
  )
}

const components: Components = {
  pre: pre(),
  // Every table is sortable, and one of labels and figures can be flipped to a chart.
  table: ({ children }) => <MdTable>{children}</MdTable>,
  li,
  a: ({ href, children }) => (
    <a
      onClick={(e) => {
        e.preventDefault()
        if (href && /^https?:/.test(href)) void api.openExternal(href)
      }}
      href={href}
      title={href}
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...rest }) => {
    const text = textOf(children)
    // A lone path to a picture becomes something you can open.
    if (!className && ABS_PATH.test(text) && IMAGE_EXT.test(text)) {
      return (
        <code
          {...rest}
          role="link"
          data-view-path={text}
          onClick={(e) => viewFrom(e.currentTarget, text)}
          className="cursor-pointer underline decoration-line-2 underline-offset-2 hover:decoration-ink-3"
          title="View image"
        >
          {baseName(text)}
        </code>
      )
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  },
  img: ({ src, alt }) => {
    const s = typeof src === 'string' ? src : ''
    const local = ABS_PATH.test(s)
    return <img src={local ? api.fileUrl(s) : s} alt={alt || ''} loading="lazy" />
  },
}

const NOTE = /^vault:/

const FENCE = /^ {0,3}(```|~~~)/
// A line that could belong to what came before it: part of a list, a quote, a table, or indented.
const CONTINUES = /^(\s|[-*+>|]|\d+[.)])/

/**
 * Where the settled part of a text that is still being written ends: after the last
 * blank line that is outside a code block and is followed by the start of something new.
 * Everything before it will not change again, so it need not be worked out again.
 */
function settledAt(text: string): number {
  let fenced = false
  let cut = 0
  let pos = 0
  let blank = false
  while (pos < text.length) {
    let end = text.indexOf('\n', pos)
    if (end < 0) end = text.length
    const line = text.slice(pos, end)
    if (FENCE.test(line)) {
      if (!fenced && blank) cut = pos
      fenced = !fenced
      blank = false
    } else if (!fenced) {
      if (!line.trim()) blank = true
      else {
        if (blank && !CONTINUES.test(line)) cut = pos
        blank = false
      }
    }
    pos = end + 1
  }
  return cut
}

const REMARK = [remarkGfm]
const REHYPE: [typeof rehypeHighlight, { detect: boolean; ignoreMissing: boolean }][] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]

/** Whether a text ends inside a fenced block that has not been closed yet. */
export function endsOpen(text: string): boolean {
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    if (!fence) fence = m[1]
    else if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null
  }
  return !!fence
}

/** One stretch of text turned into elements. Drawn again only when its own text changes. */
const Part = memo(function Part({ text, parts, writing }: { text: string; parts: Components; writing?: boolean }) {
  // The last stretch of a text still being written may end inside an interactive block.
  const open = writing && endsOpen(text)
  const end = text.trimEnd().length
  const own = useMemo<Components>(() => (open ? { ...parts, pre: pre({ end }) } : parts), [open, end, parts])
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={own}>
      {text}
    </ReactMarkdown>
  )
})

export const Markdown = memo(function Markdown({
  text,
  compact,
  className,
  onNote,
  streaming,
  replyTo,
}: {
  text: string
  compact?: boolean
  className?: string
  /** When given, links written as vault:<note> open that note instead of a web page. */
  onNote?(target: string): void
  /** The text is still being written: only the part that is still changing is worked out on each update. */
  streaming?: boolean
  /**
   * The agent who wrote the text. Choices, forms and mini apps in it send their answer to them.
   * Left out, an answer goes to whoever the chat is focused on.
   */
  replyTo?: string
}) {
  const parts = useMemo<Components>(() => {
    if (!onNote) return components
    return {
      ...components,
      a: ({ href, children }) => (
        <a
          onClick={(e) => {
            e.preventDefault()
            if (!href) return
            if (NOTE.test(href)) onNote(decodeURIComponent(href.replace(NOTE, '')))
            else if (/^https?:/.test(href)) void api.openExternal(href)
          }}
          href={href}
          title={href && NOTE.test(href) ? decodeURIComponent(href.replace(NOTE, '')) : href}
        >
          {children}
        </a>
      ),
    }
  }, [onNote])
  let out: ReactNode
  if (streaming) {
    const cut = settledAt(text)
    out = (
      <div className={cn('md streaming', compact && 'compact', className)}>
        {cut > 0 && <Part key="settled" text={text.slice(0, cut)} parts={parts} />}
        <Part key="writing" text={text.slice(cut)} parts={parts} writing />
      </div>
    )
  } else {
    out = (
      <div className={cn('md', compact && 'compact', className)}>
        <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={parts} urlTransform={onNote ? (u) => (NOTE.test(u) ? u : defaultUrlTransform(u)) : undefined}>
          {text}
        </ReactMarkdown>
      </div>
    )
  }
  out = <TaskScope.Provider value={streaming ? '' : scopeOf(text)}>{out}</TaskScope.Provider>
  return replyTo ? <IuiContext.Provider value={{ replyTo }}>{out}</IuiContext.Provider> : out
})
