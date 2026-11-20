import path from 'node:path'
import { execFile } from 'node:child_process'
import { AGENT_MB, AGENTS_PER_CORE } from '@shared/auto'
import { readJson, writeJson } from './util'

/**
 * What the team's agents really cost this computer, measured instead of assumed.
 *
 * Every agent runs as a program of its own (Claude Code, or Codex for a ChatGPT agent), started
 * by the app, plus whatever that program starts (connector servers). A sample lists the app's
 * child processes once, adds up each agent's tree (memory in use, processor time) and keeps a
 * rolling record per provider. The caps on how many agents may be started read from it: the high
 * figure (90th percentile) of memory per agent, and the processor share of an agent at work.
 *
 * What a sample costs: on Windows one short PowerShell call that lists the processes through CIM
 * (about 1 to 4 s of wall time, under a second of processor time and a few tens of MB while it
 * runs), on macOS and Linux one `ps` call (a few ms). It is taken once a minute, and only while
 * agents are running.
 */

export type Provider = 'claude' | 'chatgpt'

/** One process, as the system lists it. */
export interface ProcRow {
  pid: number
  ppid: number
  name: string
  /** Resident memory, MB. */
  mb: number
  /** Processor time used since it started, seconds. */
  cpu: number
}

/** One agent's program and everything it started, added up. */
export interface AgentReading {
  /** The agent's own program, by process id. */
  root: number
  provider: Provider
  mb: number
  cpu: number
  procs: number
}

/** What the caps work from. */
export interface Estimate {
  /** The high figure (90th percentile) of memory per agent, MB, within MB_RANGE. */
  mb: number
  /** The typical figure (median), MB. */
  typical: number
  /** Share of one processor core an agent at work takes, within CORE_RANGE. */
  core: number
  /** False until there are enough samples: then the figures are the old fixed ones. */
  measured: boolean
  /** Whether the processor share was measured too (it needs agents at work across two samples). */
  coreMeasured: boolean
  /** Agent readings the memory figure rests on. */
  readings: number
}

/** The sane range for the memory figure, MB: below it a reading is a program still starting, above it a leak. */
export const MB_RANGE: [number, number] = [150, 2000]
/** The sane range for the processor share of an agent at work. */
export const CORE_RANGE: [number, number] = [0.02, 1.5]
/** Readings needed before the measured figures replace the fixed ones. */
export const MIN_READINGS = 12
/** Separate samples the measured memory figure needs, besides MIN_READINGS readings. */
export const MIN_MEM_SAMPLES = 3
/** How often samples are taken once the figures are measured (they change slowly). */
export const SETTLED_EVERY_MS = 10 * 60_000
/** How many readings of each kind are kept. */
const KEEP = 400
/** Programs the app starts for itself, never an agent. */
const NOT_AGENTS = /^(git|powershell|pwsh|cmd|conhost|werfault|tasklist|ps|sh|bash)(\.exe)?$/i

interface Record_ {
  v: 1
  /** MB per agent, per provider, newest last. */
  mem: Record<Provider, number[]>
  /** Share of a core per agent at work, per provider, newest last. */
  cpu: Record<Provider, number[]>
  /**
   * How long tasks ran, ms, by kind of work, newest last. Kept as a record only: no cap or
   * decision reads it yet.
   */
  tasks: Record<string, number[]>
  samples: number
  /** Samples that brought at least one memory reading: the measured figure needs several, not one burst. */
  memSamples?: number
  /** What the last sample cost, ms of wall time. */
  costMs?: number
  updatedAt: number
}

const empty = (): Record_ => ({ v: 1, mem: { claude: [], chatgpt: [] }, cpu: { claude: [], chatgpt: [] }, tasks: {}, samples: 0, updatedAt: 0 })

const clamp = (n: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, n))

/** The value below which `q` of the list falls (0.5 the median, 0.9 the high figure). */
export function quantile(list: number[], q: number): number {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

/**
 * The agents among the app's processes: each direct child of the app that is not one of the app's
 * own windows or helpers, with everything under it. Codex is a ChatGPT agent; anything else is Claude Code.
 */
export function agentsIn(rows: ProcRow[], appPid: number, appName: string): AgentReading[] {
  const kids = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const list = kids.get(r.ppid) || []
    list.push(r)
    kids.set(r.ppid, list)
  }
  const own = appName.toLowerCase().replace(/\.exe$/, '')
  const out: AgentReading[] = []
  for (const root of kids.get(appPid) || []) {
    const name = root.name.toLowerCase().replace(/\.exe$/, '')
    if (name === own || name === 'electron' || NOT_AGENTS.test(root.name)) continue
    let mb = 0
    let cpu = 0
    let procs = 0
    const stack = [root]
    const seen = new Set<number>()
    while (stack.length) {
      const p = stack.pop() as ProcRow
      if (seen.has(p.pid)) continue
      seen.add(p.pid)
      mb += p.mb
      cpu += p.cpu
      procs++
      for (const k of kids.get(p.pid) || []) stack.push(k)
    }
    out.push({ root: root.pid, provider: /codex/i.test(root.name) ? 'chatgpt' : 'claude', mb, cpu, procs })
  }
  return out
}

/** Lists this computer's processes with one system call: CIM through PowerShell on Windows, `ps` elsewhere. */
export function readProcesses(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime | ForEach-Object { '{0},{1},{2},{3},{4}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,($_.KernelModeTime+$_.UserModeTime),$_.Name }"
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([])
        const rows: ProcRow[] = []
        for (const line of out.split(/\r?\n/)) {
          const m = /^(\d+),(\d+),(\d+),(\d+),(.+)$/.exec(line.trim())
          if (m) rows.push({ pid: +m[1], ppid: +m[2], mb: +m[3] / 1024 ** 2, cpu: +m[4] / 1e7, name: m[5] })
        }
        resolve(rows)
      })
      return
    }
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,comm='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([])
      const rows: ProcRow[] = []
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.+)$/.exec(line)
        if (!m) continue
        const cpu = (+(m[4] || 0)) * 86400 + (+(m[5] || 0)) * 3600 + +m[6] * 60 + +m[7]
        rows.push({ pid: +m[1], ppid: +m[2], mb: +m[3] / 1024, cpu, name: path.basename(m[8].trim()) })
      }
      resolve(rows)
    })
  })
}

export interface ResourcesOptions {
  /** Where the record is kept (resources.json in the data folder). */
  file: string
  /** How processes are listed. Checks pass their own numbers here. */
  read?: () => Promise<ProcRow[]>
  /** The app's own process, under which the agents run. */
  appPid?: number
  /** The app's program name, whose other processes are its windows and helpers, not agents. */
  appName?: string
  /** How many agents of each provider are at work right now (for the processor share of an agent at work). */
  busy?: () => Record<Provider, number>
  now?: () => number
  /** Told after each sample, to pass the new figures on. */
  onSample?: () => void
}

export class Resources {
  private rec: Record_
  private prev = new Map<number, { cpu: number; at: number }>()
  private timer: NodeJS.Timeout | null = null
  private sampling = false

  constructor(private o: ResourcesOptions) {
    const saved = readJson<Partial<Record_>>(o.file, {})
    this.rec = saved && saved.v === 1 ? { ...empty(), ...saved, mem: { ...empty().mem, ...saved.mem }, cpu: { ...empty().cpu, ...saved.cpu }, tasks: { ...saved.tasks } } : empty()
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now()
  }

  /** Takes one sample and adds it to the record. The readings, or null when the system could not be read. */
  async sample(): Promise<AgentReading[] | null> {
    if (this.sampling) return null
    this.sampling = true
    try {
      const t0 = Date.now()
      const rows = await (this.o.read || readProcesses)()
      if (!rows.length) return null
      const readings = agentsIn(rows, this.o.appPid ?? process.pid, this.o.appName ?? path.basename(process.execPath))
      this.rec.costMs = Date.now() - t0
      this.add(readings, this.o.busy?.())
      this.o.onSample?.()
      return readings
    } finally {
      this.sampling = false
    }
  }

  /** Adds one sample's readings: memory per agent, and the processor share of each agent at work since the last sample. */
  add(readings: AgentReading[], busy?: Record<Provider, number>): void {
    const at = this.now()
    const used: Record<Provider, number> = { claude: 0, chatgpt: 0 }
    let span = 0
    const next = new Map<number, { cpu: number; at: number }>()
    if (readings.some((r) => r.mb > 0)) this.rec.memSamples = (this.rec.memSamples || 0) + 1
    for (const r of readings) {
      if (r.mb > 0) this.push(this.rec.mem[r.provider], r.mb)
      const before = this.prev.get(r.root)
      if (before && at > before.at && r.cpu >= before.cpu) {
        used[r.provider] += r.cpu - before.cpu
        span = Math.max(span, (at - before.at) / 1000)
      }
      next.set(r.root, { cpu: r.cpu, at })
    }
    this.prev = next
    if (span > 0 && busy) {
      for (const p of ['claude', 'chatgpt'] as const) if (busy[p] > 0 && used[p] > 0) this.push(this.rec.cpu[p], used[p] / span / busy[p])
    }
    this.rec.samples++
    this.rec.updatedAt = at
    this.save()
  }

  /** A task ended after `ms` of work. */
  task(kind: string, ms: number): void {
    if (!(ms > 0)) return
    const list = (this.rec.tasks[kind] ||= [])
    this.push(list, ms, 200)
    this.save()
  }

  private push(list: number[], v: number, keep = KEEP): void {
    list.push(Math.round(v * 1000) / 1000)
    if (list.length > keep) list.splice(0, list.length - keep)
  }

  private saveTimer: NodeJS.Timeout | null = null
  private save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 2000)
  }

  /** Puts the record on disk now. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    writeJson(this.o.file, this.rec)
  }

  /**
   * The figures the caps use: the high memory figure and the processor share of an agent at work,
   * across providers (the costlier one counts). Until there are MIN_READINGS memory readings, the
   * old fixed figures: AGENT_MB, and a core shared by AGENTS_PER_CORE agents.
   */
  estimate(): Estimate {
    const all = [...this.rec.mem.claude, ...this.rec.mem.chatgpt]
    const cpu = [...this.rec.cpu.claude, ...this.rec.cpu.chatgpt]
    // Enough readings, and from several samples a minute apart: twelve agents read once, while they are
    // still starting up, would put the figure far below what they use at work.
    const measured = all.length >= MIN_READINGS && (this.rec.memSamples || 0) >= MIN_MEM_SAMPLES
    const coreMeasured = cpu.length >= MIN_READINGS / 2
    const high = measured ? Math.max(...(['claude', 'chatgpt'] as const).filter((p) => this.rec.mem[p].length >= MIN_READINGS / 2).map((p) => quantile(this.rec.mem[p], 0.9)), quantile(all, 0.9)) : AGENT_MB
    return {
      mb: Math.round(clamp(high, MB_RANGE)),
      typical: Math.round(measured ? clamp(quantile(all, 0.5), MB_RANGE) : AGENT_MB),
      core: coreMeasured ? clamp(quantile(cpu, 0.9), CORE_RANGE) : 1 / AGENTS_PER_CORE,
      measured,
      coreMeasured,
      readings: all.length,
    }
  }

  /** How long tasks of a kind usually run (median, ms), when there are any. A record only: nothing decides on it yet. */
  taskTime(kind: string): number | undefined {
    const list = this.rec.tasks[kind]
    return list?.length ? quantile(list, 0.5) : undefined
  }

  /** What the last sample cost, ms of wall time. */
  get cost(): number | undefined {
    return this.rec.costMs
  }

  /** Samples once a minute while `live()` says agents are running (the first one 20 s in). */
  start(live: () => boolean, everyMs = 60_000): void {
    this.stop()
    // Each sample on Windows starts a PowerShell (about 1 to 4 s, 2026-11-20). Once the figures
    // rest on enough readings they change slowly, so later samples come every SETTLED_EVERY_MS.
    const tick = (): void => {
      this.timer = setTimeout(
        () => {
          if (live()) void this.sample().finally(tick)
          else tick()
        },
        this.estimate().measured ? Math.max(everyMs, SETTLED_EVERY_MS) : everyMs,
      )
    }
    this.timer = setTimeout(() => {
      if (live()) void this.sample().finally(tick)
      else tick()
    }, Math.min(everyMs, 20_000))
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.stop()
    this.flush()
  }
}

/** The plain line the user sees: how many more agents this computer can carry now, and what each costs. */
export function capacityLine(more: number, e: Estimate): string {
  const each = `about ${e.mb} MB${e.coreMeasured ? ` and ${Math.max(1, Math.round(e.core * 100))}% of a core` : ''} each`
  return `This computer can carry about ${more} more ${more === 1 ? 'agent' : 'agents'} now (${each}, ${e.measured ? 'measured' : 'estimated until there are measurements'}).`
}
