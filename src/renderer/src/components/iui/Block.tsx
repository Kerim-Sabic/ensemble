// Where a ```ui or ```app fence in any Markdown becomes a live block. Parsed once per text,
// drawn only when it comes near the view, guarded so a bad block shows its source instead.
import './iui.css'
import { memo, type ReactNode } from 'react'
import { APP_LIMITS, isWholePage, parseAppMeta, parseBlockCached, type Block } from '@shared/iui'
import { Chart } from './Chart'
import { Table } from './Table'
import { Checklist, Compare, Stats, Steps, Tabs } from './Bits'
import { Choices, Form } from './Interactive'
import { Calc } from './Calc'
import { Diagram } from './Diagram'
import { AppFrame } from './AppFrame'
import { Fallback, Guard, useNear, Waiting } from './kit'

export const IUI_LANGS = new Set(['ui', 'app'])

/** A guess at what a half-written block will be, for the words on its placeholder. */
function guessKind(src: string): string | undefined {
  return /"?type"?\s*:\s*["']?(\w+)/.exec(src)?.[1]?.toLowerCase()
}

const HEIGHT: Record<string, number> = { chart: 300, table: 220, stats: 96, compare: 220, steps: 180, diagram: 220, tabs: 180, checklist: 160, choices: 160, form: 260, calc: 280 }

function draw(b: Block, source: string): ReactNode {
  switch (b.type) {
    case 'chart':
      return <Chart block={b} />
    case 'table':
      return <Table block={b} />
    case 'stats':
      return <Stats block={b} />
    case 'compare':
      return <Compare block={b} />
    case 'steps':
      return <Steps block={b} />
    case 'diagram':
      return <Diagram block={b} />
    case 'tabs':
      return <Tabs block={b} />
    case 'checklist':
      return <Checklist block={b} source={source} />
    case 'choices':
      return <Choices block={b} source={source} />
    case 'form':
      return <Form block={b} source={source} />
    case 'calc':
      return <Calc block={b} />
  }
}

function Lazy({ height, children }: { height: number; children: ReactNode }) {
  const [ref, near] = useNear<HTMLDivElement>(700)
  if (near) return <>{children}</>
  return <div ref={ref} className="my-3" style={{ height }} aria-hidden />
}

/** A ```ui fence. `open`: it is still being written. */
export const UiFence = memo(function UiFence({ source, open }: { source: string; open?: boolean }) {
  if (open) return <Waiting kind={guessKind(source)} height={Math.min(HEIGHT[guessKind(source) || ''] || 140, 200)} />
  const parsed = parseBlockCached(source)
  if (!parsed.ok) return <Fallback source={source} lang="ui" reason={parsed.reason} />
  return (
    <Guard source={source} lang="ui">
      <Lazy height={HEIGHT[parsed.block.type] || 160}>{draw(parsed.block, source)}</Lazy>
    </Guard>
  )
})

/** A ```app fence: a mini app in the locked box. */
export const AppFence = memo(function AppFence({ source, meta, open }: { source: string; meta?: string; open?: boolean }) {
  const m = parseAppMeta(meta)
  if (open) return <Waiting kind="app" height={Math.min(m.height, 220)} />
  if (!/<[a-z!]/i.test(source)) return <Fallback source={source} lang="app" reason="it holds no HTML" />
  const given = /height\s*=/.test(meta || '')
  // A complete page keeps a set height and scrolls inside; a fragment grows to fit what it shows.
  const whole = isWholePage(source)
  return (
    <Guard source={source} lang="app">
      <AppFrame html={source} title={m.title} height={given || !whole ? m.height : APP_LIMITS.pageHeight} fixedHeight={given || whole} />
    </Guard>
  )
})
