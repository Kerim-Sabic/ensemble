// Ordinary Markdown, upgraded where there is no doubt about what it is: any table becomes
// sortable, with numbers set right, and one with a label column and number columns can be
// flipped to a chart. A task list ([ ] and [x]) becomes tickable. It still looks like plain
// Markdown until touched, so it works for any model, whether or not it writes Live answer blocks.
import { Children, createContext, isValidElement, useContext, useMemo, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, BarChart3, Check, Table2 } from 'lucide-react'
import { num, type ChartBlock, type Format } from '@shared/iui'
import { cn } from '@/lib/util'
import { ChartPlot } from './Chart'
import { hash, useKept } from './kit'

type El = ReactElement<{ children?: ReactNode; style?: CSSProperties; className?: string }>

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as El).props.children)
  return ''
}

const elements = (n: ReactNode): El[] => Children.toArray(n).filter(isValidElement) as El[]

/** A cell that says "nothing here" rather than a value. */
const EMPTY = /^(|-|–|—|n\/a|na|none|null|\?)$/i
const YEAR = /^(19|20)\d{2}$/
const TIME = /^((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+'?\d{2,4})?|q[1-4](\s+'?\d{2,4})?|(19|20)\d{2}([-/]\d{1,2}([-/]\d{1,2})?)?|w(eek)?\s?\d{1,2}|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|h[12](\s+\d{2,4})?|\d{1,2}:\d{2})$/i

type Col = { label: string; numeric: boolean; format: Format; unit?: string; top: number }

/** What a column holds, from its cells alone. */
function columnOf(label: string, cells: string[], first: boolean): Col {
  const vals = cells.map((c) => c.trim()).filter((c) => !EMPTY.test(c))
  const nums = vals.map(num)
  // A first column of years is the row labels, not figures.
  const numeric = vals.length > 0 && nums.every((n) => n != null) && !(first && vals.every((v) => YEAR.test(v)))
  const cur = vals.map((v) => /[$€£¥₹]/.exec(v)?.[0]).find(Boolean)
  const format: Format = !numeric ? 'text' : cur ? 'money' : vals.every((v) => /%\s*$/.test(v)) ? 'percent' : 'number'
  return { label, numeric, format, unit: cur, top: numeric ? Math.max(...nums.map((n) => Math.abs(n as number))) : 0 }
}

export function MdTable({ children }: { children?: ReactNode }) {
  const parts = elements(children)
  const head = parts.find((p) => p.type === 'thead')
  const body = parts.find((p) => p.type === 'tbody')
  const headRow = head ? elements(head.props.children)[0] : undefined
  const headCells = headRow ? elements(headRow.props.children) : []
  const rows = body ? elements(body.props.children) : []
  const cells = rows.map((r) => elements(r.props.children))
  const texts = cells.map((r) => r.map((c) => textOf(c.props.children)))
  const labels = headCells.map((c) => textOf(c.props.children).trim())
  const key = labels.join('|') + texts.length
  const cols = useMemo(() => labels.map((l, j) => columnOf(l, texts.map((r) => r[j] ?? ''), j === 0)), [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [chart, setChart] = useState(false)
  const [only, setOnly] = useState<number | null>(null)

  // A chart needs a label column first and at least one column of figures, and a few rows.
  const figures = cols.map((c, j) => (j > 0 && c.numeric ? j : -1)).filter((j) => j > 0)
  const chartable = cols.length >= 2 && !cols[0].numeric && figures.length > 0 && rows.length >= 2 && rows.length <= 200
  // Columns that can share one axis go together: the same kind of figure, of a similar size.
  // Each group is one chart; with more than one group, the reader picks.
  const groups: number[][] = []
  for (const j of figures) {
    const g = groups.find((g) => cols[g[0]].format === cols[j].format && cols[g[0]].unit === cols[j].unit && Math.max(cols[g[0]].top, cols[j].top) <= 20 * Math.max(1e-9, Math.min(cols[g[0]].top, cols[j].top)))
    if (g) g.push(j)
    else groups.push([j])
  }
  const shown = groups[only ?? 0] || groups[0] || []

  const block = useMemo<ChartBlock | null>(() => {
    if (!chart || !chartable) return null
    const x = texts.map((r) => (r[0] ?? '').trim())
    const time = x.length >= 3 && x.every((v) => TIME.test(v.replace(/\*\*/g, '')))
    const c0 = cols[shown[0]]
    return {
      type: 'chart',
      kind: time ? 'line' : 'bar',
      x,
      series: shown.map((j) => ({ name: cols[j].label || `Column ${j + 1}`, data: texts.map((r) => (EMPTY.test((r[j] ?? '').trim()) ? null : num(r[j]))) })),
      format: c0.format === 'text' ? 'number' : c0.format,
      unit: c0.format === 'money' ? c0.unit : undefined,
    }
  }, [chart, chartable, key, shown.join()]) // eslint-disable-line react-hooks/exhaustive-deps

  const order = useMemo(() => {
    const idx = rows.map((_, i) => i)
    if (!sort) return idx
    const c = cols[sort.col]
    const val = (i: number): string => (texts[i][sort.col] ?? '').trim()
    return idx.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      if (EMPTY.test(x) || EMPTY.test(y)) return EMPTY.test(x) === EMPTY.test(y) ? 0 : EMPTY.test(x) ? 1 : -1
      if (c.numeric) return ((num(x) as number) - (num(y) as number)) * sort.dir
      return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) * sort.dir
    })
  }, [sort, key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Not the shape of a table we understand: leave it exactly as it was.
  if (!headCells.length) return <table>{children}</table>

  const align = (j: number, style?: CSSProperties): CSSProperties | undefined => (style?.textAlign ? style : cols[j]?.numeric ? { ...style, textAlign: 'right' } : style)
  const cycle = (j: number): void => setSort((s) => (!s || s.col !== j ? { col: j, dir: 1 } : s.dir === 1 ? { col: j, dir: -1 } : null))

  const toggle = chartable && (
    <button
      onClick={() => setChart((c) => !c)}
      aria-pressed={chart}
      title={chart ? 'Show as a table' : 'Show as a chart'}
      aria-label={chart ? 'Show as a table' : 'Show as a chart'}
      className={cn('absolute right-0 flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] font-medium text-ink-3 transition-[opacity,color,background] hover:bg-hover hover:text-ink focus-visible:opacity-100', chart ? 'top-0 opacity-100' : 'top-[5px] opacity-50 group-hover/t:opacity-100')}
    >
      {chart ? <Table2 className="size-3.5" /> : <BarChart3 className="size-3.5" />}
      {chart ? 'Table' : <span className="sr-only">Chart</span>}
    </button>
  )

  if (block) {
    return (
      <div className="iui group/t relative my-[0.9em] max-w-full">
        <div className="mb-1 flex min-h-6 flex-wrap items-center gap-1 pr-16">
          {groups.length > 1
            ? groups.map((g, i) => (
                <button
                  key={g.join()}
                  onClick={() => setOnly(i)}
                  aria-pressed={shown === g}
                  className={cn('h-6 rounded-[6px] px-2 text-[11.5px] font-medium transition-colors', shown === g ? 'bg-hover text-ink' : 'text-ink-3 hover:text-ink')}
                >
                  {g.map((j) => cols[j].label).join(' and ')}
                </button>
              ))
            : shown.length === 1 && <span className="text-[11.5px] font-medium text-ink-3">{cols[shown[0]].label}</span>}
        </div>
        {toggle}
        <ChartPlot block={block} />
      </div>
    )
  }

  return (
    <div className="group/t relative my-[0.9em] w-fit max-w-full">
      <table style={{ margin: 0 }}>
        <thead>
          <tr>
            {headCells.map((c, j) => {
              const on = sort?.col === j
              const Icon = on && sort!.dir === -1 ? ArrowDown : ArrowUp
              const last = j === headCells.length - 1
              return (
                <th key={j} style={{ ...align(j, c.props.style), ...(last && chartable ? { paddingRight: 34 } : null) }} aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : rows.length > 1 ? 'none' : undefined}>
                  {rows.length > 1 ? (
                    <button onClick={() => cycle(j)} className={cn('group/s inline-flex items-center gap-1 font-[inherit] text-[length:inherit] hover:text-ink', on && 'text-ink', cols[j]?.numeric && 'flex-row-reverse')}>
                      {c.props.children}
                      <Icon className={cn('size-3 shrink-0', on ? 'opacity-80' : 'opacity-0 group-hover/s:opacity-40')} aria-hidden />
                    </button>
                  ) : (
                    c.props.children
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {order.map((i) => (
            <tr key={i}>
              {cells[i].map((c, j) => (
                <td key={j} style={align(j, c.props.style)} className={cols[j]?.numeric ? 'tabular' : undefined}>
                  {c.props.children}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {toggle}
    </div>
  )
}

/** The text a task list lives in, so a tick is remembered while the app is open. */
export const TaskScope = createContext('')

/** A [ ] or [x] in a task list, tickable. A tick is for the reader; nothing is sent. */
export function TaskBox({ checked, at }: { checked?: boolean; at: number }) {
  const scope = useContext(TaskScope)
  const [on, setOn] = useKept<boolean>(`task:${scope}:${at}`, !!checked)
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? 'Done' : 'Not done'}
      onClick={() => setOn((v) => !v)}
      className={cn(
        'relative top-[2px] mr-2 inline-flex size-[15px] items-center justify-center rounded-[4px] align-baseline transition-colors',
        on ? 'bg-ok text-white' : 'shadow-[inset_0_0_0_1.25px_var(--ink-4)] hover:shadow-[inset_0_0_0_1.25px_var(--ink-3)]',
      )}
    >
      {on && <Check className="size-[11px]" strokeWidth={3} />}
    </button>
  )
}

export const scopeOf = (text: string): string => hash(text)
