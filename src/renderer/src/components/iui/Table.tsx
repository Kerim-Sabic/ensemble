import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from 'lucide-react'
import { formatValue, num, type Cell, type TableBlock, type TableColumn } from '@shared/iui'
import { cn } from '@/lib/util'
import { Card } from './kit'

function show(v: Cell, c: TableColumn): string {
  if (v == null || v === '') return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (c.format === 'text') return String(v)
  const n = typeof v === 'number' ? v : num(v)
  // A number column with a cell that is not a number keeps the words it was given.
  if (n == null) return String(v)
  return formatValue(n, c.format, c.unit)
}

function compare(a: Cell, b: Cell, c: TableColumn): number {
  const empty = (v: Cell): boolean => v == null || v === ''
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1
  if (c.format !== 'text') {
    const x = typeof a === 'number' ? a : num(a)
    const y = typeof b === 'number' ? b : num(b)
    if (x != null && y != null) return x - y
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function Table({ block }: { block: TableBlock }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    let out = block.rows
    const q = query.trim().toLowerCase()
    if (q) out = out.filter((r) => block.columns.some((c) => show(r[c.key], c).toLowerCase().includes(q)))
    if (sort) {
      const c = block.columns.find((x) => x.key === sort.key)
      if (c) out = [...out].sort((a, b) => compare(a[c.key], b[c.key], c) * sort.dir)
    }
    return out
  }, [block, sort, query])

  const cycle = (key: string): void =>
    setSort((s) => (!s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null))

  return (
    <Card
      title={block.title}
      label="Table"
      pad={false}
      aside={
        block.filter ? (
          <label className="flex h-7 w-[180px] items-center gap-1.5 rounded-[8px] bg-surface-2 px-2 shadow-[inset_0_0_0_1px_var(--line)] focus-within:shadow-[inset_0_0_0_1px_var(--line-2),0_0_0_3px_color-mix(in_oklab,var(--link)_18%,transparent)]">
            <Search className="size-3.5 shrink-0 text-ink-3" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter rows" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink-3" />
          </label>
        ) : undefined
      }
    >
      <div className={cn('max-h-[440px] overflow-auto', !block.title && !block.filter && 'rounded-[12px]')}>
        <table>
          <thead>
            <tr>
              {block.columns.map((c) => {
                const on = sort?.key === c.key
                const Icon = on ? (sort!.dir === 1 ? ArrowUp : ArrowDown) : ChevronsUpDown
                return (
                  <th key={c.key} style={{ textAlign: c.align }} aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : block.sortable ? 'none' : undefined}>
                    {block.sortable ? (
                      <button
                        onClick={() => cycle(c.key)}
                        className={cn('group/s -mx-1 inline-flex items-center gap-1 rounded-[5px] px-1 hover:text-ink', on && 'text-ink', c.align === 'right' && 'flex-row-reverse')}
                      >
                        {c.label}
                        <Icon className={cn('size-3 shrink-0', on ? 'opacity-90' : 'opacity-0 group-hover/s:opacity-60 group-focus-visible/s:opacity-60')} aria-hidden />
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {block.columns.map((c, j) => (
                  <td key={c.key} className={cn(c.format !== 'text' && 'tabular', j === 0 ? 'font-medium text-ink' : 'text-ink-2', 'max-w-[360px]')} style={{ textAlign: c.align }}>
                    {show(r[c.key], c)}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={block.columns.length} className="py-6 text-center text-ink-3">
                  {query ? 'No rows match' : 'No rows'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(query || block.rows.length > 12) && (
        <div className="border-t border-line px-4 py-1.5 text-[11.5px] text-ink-3">
          {query ? `${rows.length} of ${block.rows.length} rows` : `${block.rows.length} rows`}
        </div>
      )}
    </Card>
  )
}
