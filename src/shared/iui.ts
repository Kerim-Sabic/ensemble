// Live answers (code name iui): the blocks an agent can put in a reply, how a block written by a model is
// read (forgivingly), and the small formula language of `calc`. Pure functions only: the
// window draws what comes out of here, and scripts/auto-test.ts checks it.
//
// Text from an agent is untrusted. Nothing here ever turns it into code: formulas are parsed
// into a tree and walked, never handed to eval or Function.

// ───────────── the blocks ─────────────

export type Format = 'text' | 'number' | 'integer' | 'money' | 'percent'
export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'scatter'

export interface ChartSeries {
  name: string
  /** One value per label in `x`, null where there is none. */
  data: (number | null)[]
  /** Scatter only: the points themselves. */
  points?: [number, number][]
}
export interface ChartBlock {
  type: 'chart'
  kind: ChartKind
  title?: string
  x: string[]
  series: ChartSeries[]
  unit?: string
  format?: Format
  stacked?: boolean
  horizontal?: boolean
  note?: string
  /** Scatter: what the two axes measure. */
  xLabel?: string
  yLabel?: string
  /** Set by the app, never read from a block: the labels are evenly spaced numbers (a calculator's sweep). */
  xNum?: { values: number[]; unit?: string }
}

export interface TableColumn {
  key: string
  label: string
  align: 'left' | 'right' | 'center'
  format: Format
  unit?: string
}
export type Cell = string | number | boolean | null
export interface TableBlock {
  type: 'table'
  title?: string
  columns: TableColumn[]
  rows: Record<string, Cell>[]
  sortable: boolean
  filter: boolean
}

export interface StatItem {
  label: string
  value: string
  delta?: string
  /** Which way the delta leans, and whether that is good news. */
  tone?: 'good' | 'bad' | 'flat'
  hint?: string
}
export interface StatsBlock {
  type: 'stats'
  title?: string
  items: StatItem[]
}

export interface CompareOption {
  name: string
  summary?: string
  pros: string[]
  cons: string[]
  score?: number
  pick?: boolean
}
export interface CompareBlock {
  type: 'compare'
  title?: string
  options: CompareOption[]
  /** The highest score seen, so scores can be drawn as a share of it. */
  scale?: number
}

export type StepStatus = 'done' | 'doing' | 'todo'
export interface StepsBlock {
  type: 'steps'
  title?: string
  items: { title: string; detail?: string; status: StepStatus }[]
}

export interface DiagramNode {
  id: string
  label: string
  group?: string
}
export interface DiagramBlock {
  type: 'diagram'
  kind: 'flow' | 'tree'
  title?: string
  direction: 'right' | 'down'
  nodes: DiagramNode[]
  edges: { from: string; to: string; label?: string }[]
}

export interface TabsBlock {
  type: 'tabs'
  tabs: { label: string; content: string }[]
}

export interface ChecklistBlock {
  type: 'checklist'
  title?: string
  items: { label: string; done: boolean }[]
}

export interface ChoicesBlock {
  type: 'choices'
  prompt?: string
  options: { label: string; value: string; detail?: string }[]
  multiple: boolean
}

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date' | 'range'
export interface FormField {
  name: string
  label: string
  type: FieldType
  options?: { label: string; value: string }[]
  default?: string | number | boolean
  min?: number
  max?: number
  step?: number
  required: boolean
  hint?: string
  placeholder?: string
}
export interface FormBlock {
  type: 'form'
  title?: string
  fields: FormField[]
  submit: string
}

export interface CalcInput {
  name: string
  label: string
  type: 'number' | 'range' | 'select'
  default: number
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { label: string; value: number }[]
}
export interface CalcOutput {
  name?: string
  label: string
  formula: string
  expr: Expr
  format: Format
  unit?: string
  digits?: number
  /** The answer that matters most: drawn larger. */
  main?: boolean
}
export interface CalcBlock {
  type: 'calc'
  title?: string
  inputs: CalcInput[]
  outputs: CalcOutput[]
  chart?: { kind: 'line' | 'bar' | 'area'; x: string; y: number; from: number; to: number }
}

export type Block = ChartBlock | TableBlock | StatsBlock | CompareBlock | StepsBlock | DiagramBlock | TabsBlock | ChecklistBlock | ChoicesBlock | FormBlock | CalcBlock
export type BlockType = Block['type']

export const BLOCK_TYPES: BlockType[] = ['chart', 'table', 'stats', 'compare', 'steps', 'diagram', 'tabs', 'checklist', 'choices', 'form', 'calc']

export type Parsed = { ok: true; block: Block; notes: string[] } | { ok: false; reason: string }

// Limits that keep one block from swamping the window.
export const LIMITS = { points: 200, series: 8, rows: 500, columns: 14, items: 40, options: 12, nodes: 60, fields: 20, tabs: 8, inputs: 12, outputs: 10, text: 4000 }

// ───────────── reading JSON the way models write it ─────────────

/**
 * JSON, forgivingly: trailing commas, comments, single quotes, unquoted keys, curly quotes,
 * a leading "json" word, text after the object. Returns the value or throws a readable Error.
 */
export function looseJson(src: string): unknown {
  let s = src.replace(/^﻿/, '').trim()
  // Some write ```ui json or put the word json on the first line.
  s = s.replace(/^json\s*\n/i, '')
  let i = 0
  const n = s.length
  const fail = (what: string): never => {
    const line = s.slice(0, i).split('\n').length
    throw new Error(`${what} on line ${line}`)
  }
  const space = (): void => {
    while (i < n) {
      const c = s[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++
      else if (c === '/' && s[i + 1] === '/') {
        while (i < n && s[i] !== '\n') i++
      } else if (c === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2)
        i = end < 0 ? n : end + 2
      } else break
    }
  }
  const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' }
  const str = (): string => {
    const close = QUOTES[s[i]]
    i++
    let out = ''
    while (i < n) {
      const c = s[i]
      if (c === close || (close === '"' && c === '”')) {
        i++
        return out
      }
      if (c === '\\') {
        const e = s[i + 1]
        i += 2
        if (e === 'n') out += '\n'
        else if (e === 't') out += '\t'
        else if (e === 'r') out += '\r'
        else if (e === 'b' || e === 'f') out += ''
        else if (e === 'u') {
          const hex = s.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('A broken \\u escape')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else if (e === undefined) fail('A text that never ends')
        else out += e
        continue
      }
      // A raw line break inside a string: keep it rather than refuse the block.
      out += c
      i++
    }
    return fail('A text that never ends')
  }
  const word = (): string => {
    const m = /^[A-Za-z_$][\w$-]*/.exec(s.slice(i, i + 200))
    if (!m) fail(`Unexpected "${s[i]}"`)
    i += m![0].length
    return m![0]
  }
  const value = (depth: number): unknown => {
    if (depth > 40) fail('Nested too deeply')
    space()
    if (i >= n) fail('The block ends too early')
    const c = s[i]
    if (c === '{') {
      i++
      const obj: Record<string, unknown> = {}
      for (;;) {
        space()
        if (s[i] === '}') {
          i++
          return obj
        }
        if (i >= n) fail('An object that is never closed')
        const key = QUOTES[s[i]] ? str() : word()
        space()
        if (s[i] !== ':' && s[i] !== '=') fail(`Expected ":" after "${key}"`)
        i++
        const v = value(depth + 1)
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') obj[key] = v
        space()
        if (s[i] === ',' || s[i] === ';') i++
        else if (s[i] !== '}') {
          // A missing comma between two entries on separate lines: forgive it.
          if (i < n && (QUOTES[s[i]] || /[A-Za-z_]/.test(s[i]))) continue
          fail('Expected "," or "}"')
        }
      }
    }
    if (c === '[') {
      i++
      const arr: unknown[] = []
      for (;;) {
        space()
        if (s[i] === ']') {
          i++
          return arr
        }
        if (i >= n) fail('A list that is never closed')
        arr.push(value(depth + 1))
        space()
        if (s[i] === ',') i++
        else if (s[i] !== ']') {
          if (i < n && /["'\d\-{[“]/.test(s[i])) continue
          fail('Expected "," or "]"')
        }
      }
    }
    if (QUOTES[c]) return str()
    const m = /^[-+]?(?:\d[\d_]*\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(s.slice(i, i + 64))
    if (m) {
      i += m[0].length
      return Number(m[0].replace(/_/g, ''))
    }
    const w = word()
    if (w === 'true') return true
    if (w === 'false') return false
    if (w === 'null' || w === 'undefined' || w === 'None') return null
    if (w === 'True') return true
    if (w === 'False') return false
    if (w === 'NaN') return null
    return fail(`Unexpected word "${w}"`)
  }
  const out = value(0)
  return out
}

// ───────────── small coercions ─────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** A label: any plain value becomes text, kept to a sane length. */
export function text(v: unknown, max = 300): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim().slice(0, max)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isObj(v) && ('label' in v || 'name' in v || 'title' in v)) return text(v.label ?? v.name ?? v.title, max)
  return ''
}
const opt = (v: unknown, max = 300): string | undefined => text(v, max) || undefined

const SUFFIX: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, bn: 1e9, t: 1e12, T: 1e12 }

/** A number from what a model wrote: 12, "12", "1,234.5", "$12", "45%", "1.2k", "-3". Null if it is not one. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v !== 'string') return null
  let s = v.trim().replace(/[−–]/g, '-').replace(/\s+/g, '')
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1)
  }
  s = s.replace(/^[+]/, '')
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  }
  s = s.replace(/^(?:[$€£¥₹]|USD|EUR|GBP|KM|BAM)/i, '').replace(/(?:[$€£¥₹%]|USD|EUR|GBP|KM|BAM)$/i, '')
  const m = /^(\d{1,3}(?:,\d{3})+|\d*)(\.\d+)?(k|K|m|M|bn|b|B|t|T)?$/.exec(s)
  if (!m || (!m[1] && !m[2])) return null
  const base = Number((m[1] || '0').replace(/,/g, '') + (m[2] || ''))
  if (!Number.isFinite(base)) return null
  const out = base * (m[3] ? SUFFIX[m[3]] : 1)
  return neg ? -out : out
}

const bool = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|1|done|x|checked)$/i.test(v.trim()))

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])

const strings = (v: unknown, max = 12): string[] =>
  list(v)
    .map((x) => text(x))
    .filter(Boolean)
    .slice(0, max)

const FORMATS: Format[] = ['text', 'number', 'integer', 'money', 'percent']
function format(v: unknown): Format | undefined {
  const s = text(v).toLowerCase()
  if (!s) return undefined
  if ((FORMATS as string[]).includes(s)) return s as Format
  if (/^(currency|usd|eur|price|dollars?|cost)$/.test(s)) return 'money'
  if (/^(%|pct|percentage)$/.test(s)) return 'percent'
  if (/^(int|count|whole)$/.test(s)) return 'integer'
  if (/^(float|decimal|numeric|num)$/.test(s)) return 'number'
  return undefined
}

/** A name a formula can use: letters, digits and underscores, starting with a letter. */
export function ident(v: unknown, fallback: string): string {
  const s = text(v)
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1')
  return s || fallback
}

// ───────────── number formatting (shared so tests can check it) ─────────────

const NF = new Map<string, Intl.NumberFormat>()
function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = JSON.stringify(opts)
  let f = NF.get(k)
  if (!f) {
    f = new Intl.NumberFormat('en-US', opts)
    NF.set(k, f)
  }
  return f
}

const CURRENCY_SIGN = /^[$€£¥₹]$/

/** How many decimals a value deserves: fewer as it grows. */
function digitsFor(n: number): number {
  const a = Math.abs(n)
  if (a === 0 || a >= 100) return 0
  if (a >= 10) return 1
  if (a >= 1) return 2
  return 3
}

/**
 * A value as a reader expects it. `unit` is a currency sign or code for money ("$", "EUR"),
 * and is otherwise put after the number ("12 kg"). Not a number: "n/a".
 */
export function formatValue(n: number | null | undefined, fmt: Format = 'number', unit?: string, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  const u = unit?.trim()
  if (fmt === 'percent') {
    const d = digits ?? (Math.abs(n) >= 10 ? 0 : 1)
    return `${nf({ maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n)}%`
  }
  if (fmt === 'money') {
    const d = digits ?? (Math.abs(n) >= 1000 ? 0 : 2)
    const body = nf({ maximumFractionDigits: d, minimumFractionDigits: d }).format(Math.abs(n))
    const sign = n < 0 ? '-' : ''
    if (!u || CURRENCY_SIGN.test(u)) return `${sign}${u || '$'}${body}`
    return `${sign}${body} ${u}`
  }
  const d = fmt === 'integer' ? 0 : digits ?? digitsFor(n)
  const body = nf({ maximumFractionDigits: d }).format(n)
  return u ? (u === '%' ? `${body}%` : CURRENCY_SIGN.test(u) ? (n < 0 ? `-${u}${body.slice(1)}` : `${u}${body}`) : `${body} ${u}`) : body
}

/**
 * A short form for axes and tight spaces: 950, 12.5K, 4.2M. `big`: other values on the same
 * axis reach 10,000, so thousands are shortened too and the axis reads in one style.
 */
export function formatCompact(n: number, fmt: Format = 'number', unit?: string, big = false): string {
  if (!Number.isFinite(n)) return 'n/a'
  const a = Math.abs(n)
  let body: string
  if (a >= 1e4 || (big && a >= 1e3)) body = nf({ notation: 'compact', maximumFractionDigits: a >= 1e5 && a < 1e6 ? 0 : 1 }).format(n)
  else body = nf({ maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 }).format(n)
  if (fmt === 'percent') return `${body}%`
  const u = unit?.trim()
  if (fmt === 'money' || (u && CURRENCY_SIGN.test(u))) {
    const sign = u && CURRENCY_SIGN.test(u) ? u : fmt === 'money' && !u ? '$' : ''
    if (sign) return n < 0 ? `-${sign}${body.replace('-', '')}` : `${sign}${body}`
    return `${body} ${u}`
  }
  if (u === '%') return `${body}%`
  return body
}

/** Round numbers for an axis: about `count` ticks that cover [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  if (lo === hi) {
    if (lo === 0) return [0, 1]
    const pad = Math.abs(lo) * 0.1
    lo -= pad
    hi += pad
  }
  if (lo > hi) [lo, hi] = [hi, lo]
  const raw = (hi - lo) / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  // The finest round step that needs no more than one interval over the count asked for.
  let step = 10 * mag
  for (const m of [1, 2, 2.5, 5, 10]) {
    const s = m * mag
    if (Math.ceil(hi / s - 1e-9) - Math.floor(lo / s + 1e-9) <= count + 1) {
      step = s
      break
    }
  }
  const start = Math.floor(lo / step + 1e-9) * step
  const end = Math.ceil(hi / step - 1e-9) * step
  const out: number[] = []
  for (let v = start; v <= end + step / 2 && out.length < 50; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)))
  return out
}

// ───────────── the formula language of calc ─────────────

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'un'; op: '-' | '+' | '!'; a: Expr }
  | { t: 'bin'; op: string; a: Expr; b: Expr }
  | { t: 'if'; c: Expr; a: Expr; b: Expr }
  | { t: 'call'; fn: string; args: Expr[] }

const FUNCS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  min: { min: 1, max: 50, fn: (...a) => Math.min(...a) },
  max: { min: 1, max: 50, fn: (...a) => Math.max(...a) },
  abs: { min: 1, max: 1, fn: Math.abs },
  round: { min: 1, max: 2, fn: (x, d = 0) => { const p = Math.pow(10, Math.round(d)); return Math.round(x * p) / p } },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  pow: { min: 2, max: 2, fn: Math.pow },
  log: { min: 1, max: 2, fn: (x, b) => (b === undefined ? Math.log(x) : Math.log(x) / Math.log(b)) },
  log10: { min: 1, max: 1, fn: Math.log10 },
  exp: { min: 1, max: 1, fn: Math.exp },
  clamp: { min: 3, max: 3, fn: (x, lo, hi) => Math.min(Math.max(x, lo), hi) },
}
export const FORMULA_FUNCTIONS = Object.keys(FUNCS)
const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E, true: 1, false: 0 }

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string }

function tokens(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const s = src.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/≠/g, '!=')
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const m = /^(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i))
    if (m) {
      out.push({ k: 'num', v: Number(m[0].replace(/_/g, '')) })
      i += m[0].length
      continue
    }
    const w = /^[A-Za-z_][\w]*/.exec(s.slice(i))
    if (w) {
      const v = w[0]
      if (v === 'and') out.push({ k: 'op', v: '&&' })
      else if (v === 'or') out.push({ k: 'op', v: '||' })
      else if (v === 'not') out.push({ k: 'op', v: '!' })
      else out.push({ k: 'id', v })
      i += v.length
      continue
    }
    const two = s.slice(i, i + 2)
    if (['<=', '>=', '==', '!=', '&&', '||', '**', '<>'].includes(two)) {
      out.push({ k: 'op', v: two === '**' ? '^' : two === '<>' ? '!=' : two })
      i += 2
      continue
    }
    if ('+-*/%^()?:,<>!='.includes(c)) {
      out.push({ k: 'op', v: c === '=' ? '==' : c })
      i++
      continue
    }
    throw new Error(`"${c}" is not something a formula can use`)
  }
  return out
}

/** Parse a formula into a tree. Throws a readable Error. */
export function parseFormula(src: string): Expr {
  if (src.length > 2000) throw new Error('The formula is too long')
  const t = tokens(src)
  let p = 0
  const peek = (): Tok | undefined => t[p]
  const isOp = (v: string): boolean => peek()?.k === 'op' && peek()!.v === v
  const eat = (v: string): void => {
    if (!isOp(v)) throw new Error(peek() ? `Expected "${v}" before "${String(peek()!.v)}"` : `Expected "${v}" at the end`)
    p++
  }
  let depth = 0
  const ternary = (): Expr => {
    if (++depth > 60) throw new Error('The formula is nested too deeply')
    const c = binary(0)
    let out = c
    if (isOp('?')) {
      p++
      const a = ternary()
      eat(':')
      const b = ternary()
      out = { t: 'if', c, a, b }
    }
    depth--
    return out
  }
  const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']]
  const binary = (level: number): Expr => {
    if (level >= LEVELS.length) return unary()
    let a = binary(level + 1)
    while (peek()?.k === 'op' && LEVELS[level].includes(peek()!.v as string)) {
      const op = t[p++].v as string
      const b = binary(level + 1)
      a = { t: 'bin', op, a, b }
    }
    return a
  }
  const unary = (): Expr => {
    if (isOp('-') || isOp('+') || isOp('!')) {
      const op = t[p++].v as '-' | '+' | '!'
      return { t: 'un', op, a: unary() }
    }
    return power()
  }
  const power = (): Expr => {
    const base = atom()
    if (isOp('^')) {
      p++
      // Right to left, and the exponent may carry its own sign: 2^-n.
      return { t: 'bin', op: '^', a: base, b: unary() }
    }
    return base
  }
  const atom = (): Expr => {
    const k = peek()
    if (!k) throw new Error('The formula ends too early')
    if (k.k === 'num') {
      p++
      return { t: 'num', v: k.v }
    }
    if (k.k === 'id') {
      p++
      if (isOp('(')) {
        const fn = k.v.toLowerCase()
        const def = FUNCS[fn]
        if (!def) throw new Error(`There is no function "${k.v}"`)
        p++
        const args: Expr[] = []
        if (!isOp(')')) {
          for (;;) {
            args.push(ternary())
            if (isOp(',')) p++
            else break
          }
        }
        eat(')')
        if (args.length < def.min || args.length > def.max) throw new Error(`${fn}() takes ${def.min === def.max ? def.min : `${def.min} to ${def.max}`} value${def.max === 1 ? '' : 's'}`)
        return { t: 'call', fn, args }
      }
      return { t: 'var', name: k.v }
    }
    if (k.v === '(') {
      p++
      const e = ternary()
      eat(')')
      return e
    }
    throw new Error(`Unexpected "${k.v}"`)
  }
  if (!t.length) throw new Error('The formula is empty')
  const e = ternary()
  if (p < t.length) throw new Error(`Unexpected "${String(t[p].v)}"`)
  return e
}

/** The names a formula reads. */
export function namesIn(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.t) {
    case 'var':
      out.add(e.name)
      break
    case 'un':
      namesIn(e.a, out)
      break
    case 'bin':
      namesIn(e.a, out)
      namesIn(e.b, out)
      break
    case 'if':
      namesIn(e.c, out)
      namesIn(e.a, out)
      namesIn(e.b, out)
      break
    case 'call':
      e.args.forEach((a) => namesIn(a, out))
  }
  return out
}

/** Work a formula out. Never throws: anything undefined (x/0, sqrt(-1), an unknown name) is NaN. */
export function evaluate(e: Expr, env: Record<string, number>): number {
  switch (e.t) {
    case 'num':
      return e.v
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(env, e.name)) return env[e.name]
      if (Object.prototype.hasOwnProperty.call(CONSTS, e.name)) return CONSTS[e.name]
      return NaN
    }
    case 'un': {
      const a = evaluate(e.a, env)
      return e.op === '-' ? -a : e.op === '!' ? (a ? 0 : 1) : a
    }
    case 'if': {
      const c = evaluate(e.c, env)
      if (Number.isNaN(c)) return NaN
      return c ? evaluate(e.a, env) : evaluate(e.b, env)
    }
    case 'call': {
      const args = e.args.map((a) => evaluate(a, env))
      const r = FUNCS[e.fn].fn(...args)
      return Number.isFinite(r) ? r : NaN
    }
    case 'bin': {
      const a = evaluate(e.a, env)
      if (e.op === '&&') return a ? (evaluate(e.b, env) ? 1 : 0) : 0
      if (e.op === '||') return a ? 1 : evaluate(e.b, env) ? 1 : 0
      const b = evaluate(e.b, env)
      let r: number
      switch (e.op) {
        case '+': r = a + b; break
        case '-': r = a - b; break
        case '*': r = a * b; break
        case '/': r = b === 0 ? NaN : a / b; break
        case '%': r = b === 0 ? NaN : a % b; break
        case '^': r = Math.pow(a, b); break
        case '<': r = a < b ? 1 : 0; break
        case '<=': r = a <= b ? 1 : 0; break
        case '>': r = a > b ? 1 : 0; break
        case '>=': r = a >= b ? 1 : 0; break
        case '==': r = Math.abs(a - b) < 1e-9 ? 1 : 0; break
        case '!=': r = Math.abs(a - b) >= 1e-9 ? 1 : 0; break
        default: r = NaN
      }
      return Number.isNaN(a) || Number.isNaN(b) || !Number.isFinite(r) ? NaN : r
    }
  }
}

/** A formula from text to a number in one go, for checks: NaN when it cannot be worked out. */
export function calcFormula(src: string, env: Record<string, number> = {}): number {
  try {
    return evaluate(parseFormula(src), env)
  } catch {
    return NaN
  }
}

/** Every output of a calc for the given inputs, in order. Later outputs may use earlier ones by name. */
export function runCalc(b: CalcBlock, values: Record<string, number>): number[] {
  const env: Record<string, number> = {}
  for (const i of b.inputs) env[i.name] = Number.isFinite(values[i.name]) ? values[i.name] : NaN
  return b.outputs.map((o) => {
    const v = evaluate(o.expr, env)
    if (o.name) env[o.name] = v
    return v
  })
}

// ───────────── reading one block ─────────────

class Unreadable extends Error {}
const need = (ok: unknown, reason: string): void => {
  if (!ok) throw new Unreadable(reason)
}

const KIND_ALIASES: Record<string, Partial<ChartBlock>> = {
  bar: { kind: 'bar' },
  bars: { kind: 'bar' },
  column: { kind: 'bar' },
  columns: { kind: 'bar' },
  hbar: { kind: 'bar', horizontal: true },
  horizontal: { kind: 'bar', horizontal: true },
  stacked: { kind: 'bar', stacked: true },
  line: { kind: 'line' },
  lines: { kind: 'line' },
  area: { kind: 'area' },
  pie: { kind: 'pie' },
  donut: { kind: 'donut' },
  doughnut: { kind: 'donut' },
  scatter: { kind: 'scatter' },
  dots: { kind: 'scatter' },
  points: { kind: 'scatter' },
}

function readChart(o: Obj, notes: string[]): ChartBlock {
  const kindText = text(o.kind ?? o.chart ?? o.chartType ?? 'bar').toLowerCase()
  const alias = KIND_ALIASES[kindText] || KIND_ALIASES[kindText.replace(/[^a-z]/g, '')]
  need(alias, `"${kindText}" is not a chart kind (bar, line, area, pie, donut or scatter)`)
  const kind = alias!.kind!
  let series = list(o.series ?? o.datasets ?? o.data)
  // A single series given as a bare list of numbers.
  if (series.length && series.every((s) => typeof s === 'number' || typeof s === 'string')) {
    series = [{ name: text(o.title) || 'Value', data: series }]
  }
  const x0 = list(o.x ?? o.labels ?? o.categories)
  const out: ChartSeries[] = []
  for (const [i, s] of series.entries()) {
    if (Array.isArray(s)) {
      out.push({ name: `Series ${i + 1}`, data: s.map(num) })
      continue
    }
    if (!isObj(s)) continue
    const raw = list(s.data ?? s.values ?? s.y ?? s.points)
    if (kind === 'scatter') {
      const pts: [number, number][] = []
      for (const [j, p] of raw.entries()) {
        if (Array.isArray(p)) {
          const a = num(p[0])
          const b = num(p[1])
          if (a != null && b != null) pts.push([a, b])
        } else if (isObj(p)) {
          const a = num(p.x)
          const b = num(p.y)
          if (a != null && b != null) pts.push([a, b])
        } else {
          const a = num(x0[j])
          const b = num(p)
          if (a != null && b != null) pts.push([a, b])
        }
      }
      out.push({ name: text(s.name ?? s.label) || `Series ${i + 1}`, data: [], points: pts.slice(0, LIMITS.points) })
      if (pts.length > LIMITS.points) notes.push(`Showing the first ${LIMITS.points} points`)
      continue
    }
    out.push({ name: text(s.name ?? s.label) || `Series ${i + 1}`, data: raw.map((v) => (isObj(v) ? num(v.y ?? v.value) : num(v))) })
  }
  need(out.length, 'A chart needs at least one series with numbers')
  if (out.length > LIMITS.series) {
    notes.push(`Showing the first ${LIMITS.series} of ${out.length} series`)
    out.length = LIMITS.series
  }
  let x = x0.map((v) => text(v, 80))
  if (kind !== 'scatter') {
    const longest = Math.max(...out.map((s) => s.data.length))
    need(longest > 0, 'The chart has no values')
    if (!x.length) x = Array.from({ length: longest }, (_, i) => String(i + 1))
    if (x.length > LIMITS.points) {
      notes.push(`Showing the first ${LIMITS.points} of ${x.length} points`)
      x = x.slice(0, LIMITS.points)
    }
    let uneven = false
    for (const s of out) {
      if (s.data.length !== x.length) uneven = true
      s.data = Array.from({ length: x.length }, (_, j) => s.data[j] ?? null)
    }
    if (uneven) notes.push('Some series were shorter or longer than the labels')
    need(
      out.some((s) => s.data.some((v) => v != null)),
      'The chart has no values that are numbers',
    )
  } else {
    need(
      out.some((s) => s.points!.length),
      'A scatter chart needs points as [x, y] pairs',
    )
  }
  const unit = opt(o.unit, 12)
  let fmt = format(o.format)
  if (!fmt && unit && CURRENCY_SIGN.test(unit)) fmt = 'money'
  if (!fmt && unit === '%') fmt = 'percent'
  const b: ChartBlock = {
    type: 'chart',
    kind,
    title: opt(o.title, 160),
    x,
    series: out,
    unit: fmt === 'percent' && unit === '%' ? undefined : unit,
    format: fmt,
    stacked: bool(o.stacked) || !!alias!.stacked,
    horizontal: bool(o.horizontal) || !!alias!.horizontal || text(o.orientation).toLowerCase() === 'horizontal',
    note: opt(o.note ?? o.caption ?? o.source, 400),
    xLabel: opt(o.xLabel ?? o.xlabel ?? o.xTitle, 60),
    yLabel: opt(o.yLabel ?? o.ylabel ?? o.yTitle, 60),
  }
  if (kind === 'pie' || kind === 'donut') {
    if (out.length > 1) notes.push('A pie shows one series: the first')
    b.series = [out[0]]
    if (out[0].data.some((v) => v != null && v < 0)) throw new Unreadable('A pie cannot show negative values')
  }
  return b
}

function readTable(o: Obj, notes: string[]): TableBlock {
  const rawRows = list(o.rows ?? o.data)
  let cols = list(o.columns ?? o.headers ?? o.header)
  if (!cols.length) {
    const first = rawRows.find(isObj)
    need(first, 'A table needs columns or rows')
    cols = Object.keys(first as Obj)
  }
  const columns: TableColumn[] = cols.slice(0, LIMITS.columns).map((c, i) => {
    if (isObj(c)) {
      const label = text(c.label ?? c.name ?? c.title ?? c.key, 80) || `Column ${i + 1}`
      const key = text(c.key ?? c.name ?? c.label, 80) || label
      const fmt = format(c.format ?? c.type)
      const align = text(c.align).toLowerCase()
      return { key, label, format: fmt || 'text', align: (align === 'right' || align === 'center' ? align : 'left') as TableColumn['align'], unit: opt(c.unit, 12), _auto: !fmt && !align } as TableColumn & { _auto?: boolean }
    }
    const label = text(c, 80) || `Column ${i + 1}`
    return { key: label, label, format: 'text', align: 'left', _auto: true } as TableColumn & { _auto?: boolean }
  })
  if (cols.length > LIMITS.columns) notes.push(`Showing the first ${LIMITS.columns} columns`)
  need(columns.length, 'A table needs at least one column')
  const rows: Record<string, Cell>[] = []
  for (const r of rawRows.slice(0, LIMITS.rows)) {
    const row: Record<string, Cell> = {}
    columns.forEach((c, j) => {
      let v: unknown
      if (Array.isArray(r)) v = r[j]
      else if (isObj(r)) v = c.key in r ? r[c.key] : c.label in r ? r[c.label] : r[Object.keys(r).find((k) => k.toLowerCase() === c.key.toLowerCase()) || '']
      else if (j === 0) v = r
      row[c.key] = v == null ? null : typeof v === 'number' || typeof v === 'boolean' ? v : text(v, 600)
    })
    rows.push(row)
  }
  if (rawRows.length > LIMITS.rows) notes.push(`Showing the first ${LIMITS.rows} rows`)
  // A column whose cells are all numbers is a number column, set to the right.
  for (const c of columns as (TableColumn & { _auto?: boolean })[]) {
    if (c._auto) {
      const vals = rows.map((r) => r[c.key]).filter((v) => v != null && v !== '')
      if (vals.length && vals.every((v) => num(v) != null)) {
        c.format = vals.some((v) => typeof v === 'string' && /^[-(]?[$€£]/.test(v.trim())) ? 'money' : vals.some((v) => typeof v === 'string' && /%$/.test(v.trim())) ? 'percent' : 'number'
        c.align = 'right'
      }
    } else if (c.format !== 'text' && c.align === 'left') c.align = 'right'
    delete c._auto
  }
  return { type: 'table', title: opt(o.title, 160), columns, rows, sortable: o.sortable === undefined ? rows.length > 3 : bool(o.sortable), filter: bool(o.filter) || (o.filter === undefined && rows.length > 12) }
}

function readStats(o: Obj): StatsBlock {
  const items: StatItem[] = []
  for (const it of list(o.items ?? o.stats).slice(0, 12)) {
    if (!isObj(it)) continue
    const label = text(it.label ?? it.name ?? it.title, 80)
    const raw = it.value
    const value = typeof raw === 'number' ? formatValue(raw, format(it.format) || 'number', opt(it.unit, 12)) : text(raw, 40)
    if (!label && !value) continue
    let delta: string | undefined
    let dir = 0
    if (typeof it.delta === 'number') {
      dir = Math.sign(it.delta)
      delta = `${it.delta > 0 ? '+' : ''}${formatValue(it.delta, 'number')}`
    } else if (it.delta != null && text(it.delta)) {
      delta = text(it.delta, 40)
      const n = num(delta.replace(/^([+-]?)[^\d.]*/, '$1').replace(/[^\d.,]+$/, ''))
      dir = /^\s*[-−–▼↓]/.test(delta) ? -1 : /^\s*[+▲↑]/.test(delta) ? 1 : n == null ? 0 : Math.sign(n)
    }
    const good = text(it.good ?? it.better).toLowerCase()
    const downGood = good === 'down' || good === 'lower' || good === 'less' || bool(it.invert)
    const tone: StatItem['tone'] = delta == null ? undefined : dir === 0 ? 'flat' : (dir > 0) !== downGood ? 'good' : 'bad'
    items.push({ label, value: value || 'n/a', delta, tone, hint: opt(it.hint ?? it.note ?? it.detail, 160) })
  }
  need(items.length, 'Stats need items with a label and a value')
  return { type: 'stats', title: opt(o.title, 160), items }
}

function readCompare(o: Obj): CompareBlock {
  const options: CompareOption[] = []
  for (const it of list(o.options ?? o.items).slice(0, 6)) {
    if (!isObj(it)) continue
    const name = text(it.name ?? it.label ?? it.title, 80)
    if (!name) continue
    let score: number | undefined
    if (it.score != null) {
      const s = text(it.score)
      const m = /^\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(s)
      score = m ? (Number(m[1]) / Number(m[2])) * 10 : num(it.score) ?? undefined
    }
    options.push({ name, summary: opt(it.summary ?? it.description ?? it.detail, 400), pros: strings(it.pros ?? it.good), cons: strings(it.cons ?? it.bad), score, pick: bool(it.pick ?? it.recommended ?? it.best) })
  }
  need(options.length >= 1, 'Compare needs options with a name')
  // At most one pick: the first one marked.
  let picked = false
  for (const op of options) {
    if (op.pick && picked) op.pick = false
    if (op.pick) picked = true
  }
  const scores = options.map((x) => x.score).filter((x): x is number => x != null)
  const top = scores.length ? Math.max(...scores) : undefined
  return { type: 'compare', title: opt(o.title, 160), options, scale: top == null ? undefined : top <= 1 ? 1 : top <= 5 ? 5 : top <= 10 ? 10 : 100 }
}

function stepStatus(v: unknown): StepStatus {
  const s = text(v).toLowerCase()
  if (/^(done|complete|completed|finished|ok|yes|true|x)$/.test(s)) return 'done'
  if (/^(doing|active|current|in.?progress|working|now|running|started)$/.test(s)) return 'doing'
  return 'todo'
}

function readSteps(o: Obj): StepsBlock {
  const items = list(o.items ?? o.steps)
    .slice(0, LIMITS.items)
    .map((it) => (isObj(it) ? { title: text(it.title ?? it.label ?? it.name, 200), detail: opt(it.detail ?? it.description ?? it.text, 600), status: it.status === undefined && it.done !== undefined ? (bool(it.done) ? 'done' : 'todo') : stepStatus(it.status) } : { title: text(it, 200), status: 'todo' as StepStatus }))
    .filter((x) => x.title)
  need(items.length, 'Steps need items with a title')
  return { type: 'steps', title: opt(o.title, 160), items }
}

function readDiagram(o: Obj, notes: string[]): DiagramBlock {
  const nodes: DiagramNode[] = []
  const seen = new Map<string, DiagramNode>()
  const add = (id: string, label?: string, group?: string): void => {
    if (!id || seen.has(id)) return
    const n = { id, label: label || id, group }
    seen.set(id, n)
    nodes.push(n)
  }
  for (const it of list(o.nodes)) {
    if (isObj(it)) add(text(it.id ?? it.name ?? it.label, 80), opt(it.label ?? it.name ?? it.title, 80), opt(it.group, 40))
    else add(text(it, 80))
  }
  const edges: DiagramBlock['edges'] = []
  for (const it of list(o.edges ?? o.links)) {
    let from: string, to: string, label: string | undefined
    if (Array.isArray(it)) [from, to, label] = [text(it[0], 80), text(it[1], 80), opt(it[2], 40)]
    else if (isObj(it)) [from, to, label] = [text(it.from ?? it.source, 80), text(it.to ?? it.target, 80), opt(it.label, 40)]
    else continue
    if (!from || !to || from === to) continue
    add(from)
    add(to)
    edges.push({ from, to, label })
  }
  need(nodes.length, 'A diagram needs nodes')
  if (nodes.length > LIMITS.nodes) {
    notes.push(`Showing the first ${LIMITS.nodes} nodes`)
    const keep = new Set(nodes.slice(0, LIMITS.nodes).map((n) => n.id))
    nodes.length = LIMITS.nodes
    for (let i = edges.length - 1; i >= 0; i--) if (!keep.has(edges[i].from) || !keep.has(edges[i].to)) edges.splice(i, 1)
  }
  const kind = text(o.kind).toLowerCase() === 'tree' ? 'tree' : 'flow'
  const dir = text(o.direction ?? o.dir).toLowerCase()
  const direction = /^(down|vertical|tb|top|td)/.test(dir) ? 'down' : /^(right|horizontal|lr|left)/.test(dir) ? 'right' : kind === 'tree' ? 'down' : 'right'
  return { type: 'diagram', kind, title: opt(o.title, 160), direction, nodes, edges }
}

function readTabs(o: Obj): TabsBlock {
  const tabs = list(o.tabs ?? o.items)
    .slice(0, LIMITS.tabs)
    .filter(isObj)
    .map((t, i) => ({ label: text(t.label ?? t.title ?? t.name, 60) || `Tab ${i + 1}`, content: typeof t.content === 'string' ? t.content.slice(0, 20000) : text(t.content ?? t.text ?? t.body, 20000) }))
  need(tabs.length, 'Tabs need at least one tab with a label and content')
  return { type: 'tabs', tabs }
}

function readChecklist(o: Obj): ChecklistBlock {
  const items = list(o.items)
    .slice(0, LIMITS.items)
    .map((it) => (isObj(it) ? { label: text(it.label ?? it.title ?? it.text, 300), done: bool(it.done ?? it.checked) } : { label: text(it, 300), done: false }))
    .filter((x) => x.label)
  need(items.length, 'A checklist needs items')
  return { type: 'checklist', title: opt(o.title, 160), items }
}

function readChoices(o: Obj): ChoicesBlock {
  const options = list(o.options ?? o.choices)
    .slice(0, LIMITS.options)
    .map((it) => (isObj(it) ? { label: text(it.label ?? it.name ?? it.title, 120), value: text(it.value ?? it.label ?? it.name, 300), detail: opt(it.detail ?? it.description ?? it.hint, 240) } : { label: text(it, 120), value: text(it, 300) }))
    .filter((x) => x.label)
    .map((x) => ({ ...x, value: x.value || x.label }))
  need(options.length, 'Choices need options')
  return { type: 'choices', prompt: opt(o.prompt ?? o.question ?? o.title, 300), options, multiple: bool(o.multiple ?? o.multi) }
}

const FIELD_TYPES: FieldType[] = ['text', 'textarea', 'number', 'select', 'checkbox', 'date', 'range']
function fieldType(v: unknown, hasOptions: boolean): FieldType {
  const s = text(v).toLowerCase()
  if ((FIELD_TYPES as string[]).includes(s)) return s as FieldType
  if (/^(string|email|url|tel|phone|input)$/.test(s)) return 'text'
  if (/^(long|longtext|paragraph|multiline|textbox)$/.test(s)) return 'textarea'
  if (/^(int|integer|float|decimal|money|currency)$/.test(s)) return 'number'
  if (/^(dropdown|radio|choice|enum|options)$/.test(s)) return 'select'
  if (/^(bool|boolean|toggle|switch|check)$/.test(s)) return 'checkbox'
  if (/^(slider)$/.test(s)) return 'range'
  return hasOptions ? 'select' : 'text'
}

function readOptions(v: unknown): { label: string; value: string }[] | undefined {
  const out = list(v)
    .slice(0, 40)
    .map((x) => (isObj(x) ? { label: text(x.label ?? x.name ?? x.value, 120), value: text(x.value ?? x.label ?? x.name, 200) } : { label: text(x, 120), value: text(x, 200) }))
    .filter((x) => x.label)
  return out.length ? out : undefined
}

function readForm(o: Obj): FormBlock {
  const fields: FormField[] = []
  const names = new Set<string>()
  for (const [i, f] of list(o.fields).slice(0, LIMITS.fields).entries()) {
    if (!isObj(f)) continue
    const label = text(f.label ?? f.name ?? f.title, 120) || `Field ${i + 1}`
    let name = text(f.name ?? f.id ?? f.key, 60) || ident(label.toLowerCase(), `field${i + 1}`)
    while (names.has(name)) name += '_'
    names.add(name)
    const options = readOptions(f.options ?? f.choices)
    const type = fieldType(f.type, !!options)
    const d = f.default ?? f.value
    fields.push({
      name,
      label,
      type: type === 'select' && !options ? 'text' : type,
      options,
      default: d == null ? undefined : typeof d === 'boolean' || typeof d === 'number' ? d : type === 'number' || type === 'range' ? num(d) ?? undefined : text(d, 2000),
      min: num(f.min) ?? undefined,
      max: num(f.max) ?? undefined,
      step: num(f.step) ?? undefined,
      required: bool(f.required),
      hint: opt(f.hint ?? f.help ?? f.description, 240),
      placeholder: opt(f.placeholder, 120),
    })
  }
  need(fields.length, 'A form needs fields')
  return { type: 'form', title: opt(o.title, 160), fields, submit: text(o.submit ?? o.button, 40) || 'Send' }
}

function readCalc(o: Obj, notes: string[]): CalcBlock {
  const inputs: CalcInput[] = []
  const names = new Set<string>()
  for (const [i, f] of list(o.inputs).slice(0, LIMITS.inputs).entries()) {
    if (!isObj(f)) continue
    const label = text(f.label ?? f.name, 80) || `Input ${i + 1}`
    const name = ident(f.name ?? f.id ?? label, `x${i + 1}`)
    need(!names.has(name), `Two inputs are both called "${name}"`)
    names.add(name)
    const options = list(f.options)
      .map((x) => (isObj(x) ? { label: text(x.label ?? x.value, 80), value: num(x.value) } : { label: text(x, 80), value: num(x) }))
      .filter((x): x is { label: string; value: number } => !!x.label && x.value != null)
    let type = text(f.type).toLowerCase() as CalcInput['type']
    if (type !== 'range' && type !== 'select') type = options.length ? 'select' : /^slider$/.test(text(f.type)) ? 'range' : 'number'
    if (type === 'select' && !options.length) type = 'number'
    const min = num(f.min) ?? undefined
    const max = num(f.max) ?? undefined
    if (type === 'range' && (min == null || max == null)) type = 'number'
    let def = num(f.default ?? f.value)
    if (def == null) def = type === 'select' ? options[0].value : min ?? 0
    inputs.push({ name, label, type, default: def, min, max, step: num(f.step) ?? undefined, unit: opt(f.unit, 16), options: type === 'select' ? options.slice(0, 40) : undefined })
  }
  need(inputs.length, 'A calculator needs inputs')
  const outputs: CalcOutput[] = []
  const known = new Set([...names, ...Object.keys(CONSTS)])
  for (const [i, f] of list(o.outputs).slice(0, LIMITS.outputs).entries()) {
    if (!isObj(f)) continue
    const label = text(f.label ?? f.name, 80) || `Result ${i + 1}`
    const formula = text(f.formula ?? f.expr ?? f.expression ?? f.value, 2000)
    need(formula, `"${label}" has no formula`)
    let expr: Expr
    try {
      expr = parseFormula(formula)
    } catch (e) {
      throw new Unreadable(`The formula of "${label}" cannot be read: ${(e as Error).message}`)
    }
    for (const n of namesIn(expr)) need(known.has(n), `The formula of "${label}" uses "${n}", which is not an input`)
    const name = f.name ? ident(f.name, '') || undefined : undefined
    if (name) known.add(name)
    const unit = opt(f.unit, 16)
    let fmt = format(f.format)
    if (!fmt && unit && CURRENCY_SIGN.test(unit)) fmt = 'money'
    if (!fmt && unit === '%') fmt = 'percent'
    outputs.push({ name, label, formula, expr, format: fmt || 'number', unit: fmt === 'percent' && unit === '%' ? undefined : unit, digits: num(f.digits ?? f.decimals) ?? undefined, main: bool(f.main ?? f.primary) || undefined })
  }
  need(outputs.length, 'A calculator needs outputs with formulas')
  if (!outputs.some((x) => x.main)) outputs[0].main = true
  let chart: CalcBlock['chart']
  if (isObj(o.chart)) {
    const xName = text(o.chart.x)
    const input = inputs.find((x) => x.name === xName || x.label === xName)
    const yRaw = o.chart.y ?? 0
    const yi = typeof yRaw === 'number' ? yRaw : outputs.findIndex((x) => x.name === text(yRaw) || x.label === text(yRaw))
    if (input && yi >= 0 && yi < outputs.length) {
      const from = num(o.chart.from) ?? input.min ?? (input.options ? Math.min(...input.options.map((x) => x.value)) : 0)
      const to = num(o.chart.to) ?? input.max ?? (input.options ? Math.max(...input.options.map((x) => x.value)) : input.default * 2 || 10)
      const k = text(o.chart.kind).toLowerCase()
      if (to > from) chart = { kind: k === 'bar' ? 'bar' : k === 'area' ? 'area' : 'line', x: input.name, y: yi, from, to }
      else notes.push('The chart was left out: its range is empty')
    } else notes.push('The chart was left out: it names an input or output that is not there')
  }
  return { type: 'calc', title: opt(o.title, 160), inputs, outputs, chart }
}

const READERS: Record<BlockType, (o: Obj, notes: string[]) => Block> = {
  chart: readChart,
  table: readTable,
  stats: readStats,
  compare: readCompare,
  steps: readSteps,
  diagram: readDiagram,
  tabs: readTabs,
  checklist: readChecklist,
  choices: readChoices,
  form: readForm,
  calc: readCalc,
}
const TYPE_ALIASES: Record<string, BlockType> = { graph: 'chart', plot: 'chart', grid: 'table', metrics: 'stats', kpi: 'stats', kpis: 'stats', comparison: 'compare', options: 'compare', plan: 'steps', timeline: 'steps', progress: 'steps', flow: 'diagram', flowchart: 'diagram', tree: 'diagram', graphviz: 'diagram', todo: 'checklist', todos: 'checklist', choice: 'choices', buttons: 'choices', question: 'choices', calculator: 'calc' }

/**
 * Read the inside of a ```ui fence. A model's slips (trailing commas, numbers as text, a
 * missing optional field, a series of the wrong length) are forgiven and noted; what cannot be
 * drawn comes back with one readable reason.
 */
export function parseBlock(src: string): Parsed {
  if (src.length > 400_000) return { ok: false, reason: 'The block is too large to draw' }
  let raw: unknown
  try {
    raw = looseJson(src)
  } catch (e) {
    return { ok: false, reason: `The block is not valid JSON: ${(e as Error).message}` }
  }
  if (Array.isArray(raw) && raw.length === 1) raw = raw[0]
  if (!isObj(raw)) return { ok: false, reason: 'The block should be one JSON object with a "type"' }
  const t = text(raw.type ?? raw.block ?? raw.kind).toLowerCase()
  let type = (BLOCK_TYPES as string[]).includes(t) ? (t as BlockType) : TYPE_ALIASES[t]
  // { "type": "bar", ... } reads as a bar chart.
  if (!type && KIND_ALIASES[t]) {
    type = 'chart'
    raw = { ...raw, kind: raw.kind && raw.kind !== raw.type ? raw.kind : t }
  }
  if (!type) return { ok: false, reason: t ? `"${t}" is not a block type (${BLOCK_TYPES.join(', ')})` : 'The block has no "type"' }
  const notes: string[] = []
  try {
    return { ok: true, block: READERS[type](raw as Obj, notes), notes }
  } catch (e) {
    if (e instanceof Unreadable) return { ok: false, reason: e.message }
    return { ok: false, reason: `The ${type} could not be read` }
  }
}

const CACHE = new Map<string, Parsed>()
/** parseBlock, remembered: a long chat draws the same blocks over and over. */
export function parseBlockCached(src: string): Parsed {
  const hit = CACHE.get(src)
  if (hit) return hit
  const r = parseBlock(src)
  if (CACHE.size > 400) CACHE.delete(CACHE.keys().next().value as string)
  CACHE.set(src, r)
  return r
}

// ───────────── mini apps ─────────────

export const APP_LIMITS = { html: 300_000, minHeight: 120, maxHeight: 900, defaultHeight: 360, pageHeight: 520, propose: 2000, title: 80 }

/**
 * A complete page (its own <html>, <head> or <body>) rather than a fragment. Such a page keeps
 * its own design, and its frame keeps a set height (520 unless the fence gives one) and scrolls,
 * since pages often size themselves by the window (100vh) and would otherwise grow without end.
 */
export const isWholePage = (html: string): boolean => /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html.slice(0, 4000))

/** The words after ```app: title="Snake" height=420 (both optional). */
export function parseAppMeta(meta: string | undefined): { title: string; height: number } {
  const m = meta || ''
  const title = /title\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(m)
  const height = /height\s*=\s*"?(\d+)/.exec(m)
  const h = height ? Number(height[1]) : APP_LIMITS.defaultHeight
  return {
    title: (title ? title[1] ?? title[2] ?? title[3] : '').trim().slice(0, APP_LIMITS.title) || 'Mini app',
    height: Math.min(APP_LIMITS.maxHeight, Math.max(APP_LIMITS.minHeight, h)),
  }
}
