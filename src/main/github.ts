// Reads GitHub for "From GitHub": the repository behind a chat's folder (its git remote) or a pasted
// address, and its open issues, open pull requests and failed workflow runs. It uses the GitHub CLI
// (`gh`) when it is installed and signed in, and the public REST API without a token otherwise.
// It only ever reads: every `gh` command goes through ghReadOnly first, and every call is bounded in
// time, size and count. In the demo it answers from fixtures, so no account or network is needed.

import { execFile } from 'node:child_process'
import {
  GH_LIMITS,
  clip,
  failedLogs,
  ghReadOnly,
  issueFromGh,
  issuesFromRest,
  jobsOf,
  parseAddress,
  pullFromGh,
  pullsFromRest,
  refLabel,
  remoteFromList,
  runFromGh,
  runsFromRest,
  tail,
  type GhIssue,
  type GhItem,
  type GhPull,
  type GhList,
  type GhProblem,
  type GhRef,
  type GhRun,
} from '@shared/github'

export interface GithubQuery {
  /** The chat's folder, to find the repository from its git remote. */
  cwd?: string | null
  /** A pasted address: a repository, an issue, a pull request or a run. Wins over the folder. */
  address?: string | null
}

export interface GithubItemQuery {
  repo: string
  kind: 'issue' | 'pull' | 'run'
  number: number
}

class Problem extends Error {
  constructor(
    public kind: GhProblem,
    text: string,
  ) {
    super(text)
  }
}

const WORDS: Record<GhProblem, string> = {
  'no-repo': 'This folder is not a GitHub repository (no GitHub remote was found). Paste the address of a repository, an issue, a pull request or a run instead.',
  'no-access':
    'Ensemble cannot see this repository. If it is private, install the GitHub CLI (cli.github.com) and sign in with "gh auth login" in a terminal, then try again. Ensemble only reads; it never writes to GitHub.',
  'not-found': 'GitHub has nothing at that address. Check the owner, the repository name and the number.',
  rate: 'GitHub is limiting requests made without a sign-in. Wait a few minutes, or install the GitHub CLI and sign in with "gh auth login" to read without that limit.',
  offline: 'GitHub could not be reached. Check the internet connection and try again.',
  failed: 'Reading GitHub failed.',
}

function run(cmd: string, args: string[], cwd?: string | null): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: cwd || undefined, timeout: GH_LIMITS.timeoutMs, maxBuffer: GH_LIMITS.outputBytes, windowsHide: true, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } },
      (e, out, err) => resolve({ ok: !e, out: String(out || ''), err: String(err || (e ? e.message : '')) }),
    )
  })
}

export class Github {
  /** null until checked; then whether `gh` is installed and signed in. Checked again after a minute. */
  private cli: { ok: boolean; at: number } | null = null

  constructor(private demo = false) {}

  private async hasCli(): Promise<boolean> {
    if (this.cli && Date.now() - this.cli.at < 60_000) return this.cli.ok
    const r = await this.gh(['auth', 'status'])
    this.cli = { ok: r.ok, at: Date.now() }
    return r.ok
  }

  /** Runs a read-only `gh` command. Anything that could write is refused before it starts. */
  private async gh(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    if (!ghReadOnly(args)) throw new Error(`Refused a gh command that is not read-only: gh ${args.slice(0, 2).join(' ')}`)
    return run('gh', args)
  }

  private async ghJson(args: string[]): Promise<unknown> {
    const r = await this.gh(args)
    if (!r.ok) {
      const e = r.err
      if (/could not resolve to a (repository|issue|pull)|not found|HTTP 404/i.test(e)) throw new Problem('not-found', WORDS['not-found'])
      if (/HTTP 40[13]|permission|forbidden|SAML/i.test(e)) throw new Problem('no-access', WORDS['no-access'])
      if (/rate limit/i.test(e)) throw new Problem('rate', WORDS.rate)
      if (/timed? ?out|ETIMEDOUT|ENOTFOUND|error connecting|dial tcp/i.test(e)) throw new Problem('offline', WORDS.offline)
      throw new Problem('failed', `${WORDS.failed} ${clip(e.split('\n')[0], 200)}`)
    }
    try {
      return JSON.parse(r.out)
    } catch {
      throw new Problem('failed', `${WORDS.failed} The GitHub CLI answered with something unexpected.`)
    }
  }

  private async rest(path: string): Promise<unknown> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), GH_LIMITS.timeoutMs)
    try {
      const res = await fetch(`https://api.github.com${path}`, { signal: ac.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ensemble', 'X-GitHub-Api-Version': '2022-11-28' } })
      if (res.status === 404) throw new Problem('no-access', WORDS['no-access'])
      if (res.status === 403 || res.status === 429) throw new Problem(res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429 ? 'rate' : 'no-access', res.status === 429 ? WORDS.rate : res.headers.get('x-ratelimit-remaining') === '0' ? WORDS.rate : WORDS['no-access'])
      if (!res.ok) throw new Problem('failed', `${WORDS.failed} GitHub answered ${res.status}.`)
      const text = await res.text()
      if (text.length > GH_LIMITS.outputBytes) throw new Problem('failed', `${WORDS.failed} The answer was too large.`)
      return JSON.parse(text)
    } catch (e) {
      if (e instanceof Problem) throw e
      throw new Problem('offline', WORDS.offline)
    } finally {
      clearTimeout(t)
    }
  }

  /** The GitHub repository of a folder, from its git remotes. */
  async repoOf(cwd: string): Promise<{ owner: string; repo: string } | null> {
    const r = await run('git', ['remote', '-v'], cwd)
    return r.ok ? remoteFromList(r.out) : null
  }

  /** The repository, and its open issues, open pull requests and failed runs, each list short. */
  async list(q: GithubQuery): Promise<GhList> {
    const empty: GhList = { repo: null, via: null, issues: [], pulls: [], runs: [] }
    let ref: GhRef | null = null
    if (q.address?.trim()) {
      ref = parseAddress(q.address)
      if (!ref) return { ...empty, problem: { kind: 'not-found', text: 'That is not a GitHub address. Paste one like github.com/owner/repo, an issue or pull request link, or an Actions run link.' } }
    } else if (this.demo) {
      ref = { owner: 'acme', repo: 'pricing-site', kind: 'repo' }
    } else if (q.cwd) {
      const found = await this.repoOf(q.cwd)
      if (found) ref = { ...found, kind: 'repo' }
    }
    if (!ref) return { ...empty, problem: { kind: 'no-repo', text: WORDS['no-repo'] } }
    const repo = { owner: ref.owner, repo: ref.repo, url: `https://github.com/${refLabel(ref)}` }
    const focus = ref.kind !== 'repo' && ref.number ? { kind: ref.kind, number: ref.number } : undefined
    if (this.demo) return { ...demoList(ref), repo, ...(focus ? { focus } : {}) }
    try {
      const cli = await this.hasCli()
      const out = cli ? await this.listCli(refLabel(ref)) : await this.listRest(refLabel(ref))
      const list: GhList = { repo, via: cli ? 'gh' : 'rest', ...out, ...(focus ? { focus } : {}) }
      // An address that names something not in the short lists (closed, or older) still comes first.
      if (focus) {
        const have = focus.kind === 'issue' ? list.issues.some((i) => i.number === focus.number) : focus.kind === 'pull' ? list.pulls.some((p) => p.number === focus.number) : list.runs.some((r) => r.id === focus.number)
        if (!have) {
          const it = await this.item({ repo: refLabel(ref), kind: focus.kind, number: focus.number }).catch(() => null)
          if (it?.kind === 'issue') list.issues.unshift(it.issue)
          else if (it?.kind === 'pull') list.pulls.unshift(it.pull)
          else if (it?.kind === 'run') list.runs.unshift(it.run)
        }
      }
      return list
    } catch (e) {
      const p = e instanceof Problem ? e : new Problem('failed', WORDS.failed)
      return { ...empty, repo, problem: { kind: p.kind, text: p.message } }
    }
  }

  private async listCli(repo: string): Promise<Pick<GhList, 'issues' | 'pulls' | 'runs'>> {
    const n = String(GH_LIMITS.items)
    const [issues, pulls, runs] = await Promise.all([
      this.ghJson(['issue', 'list', '-R', repo, '--state', 'open', '--limit', n, '--json', 'number,title,url,author,labels,state,updatedAt']),
      this.ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--limit', n, '--json', 'number,title,url,author,isDraft,state,headRefName,baseRefName,updatedAt,additions,deletions,changedFiles,reviewDecision,statusCheckRollup']),
      this.ghJson(['run', 'list', '-R', repo, '--status', 'failure', '--limit', String(GH_LIMITS.runs), '--json', 'databaseId,workflowName,displayTitle,headBranch,event,conclusion,createdAt,url']),
    ])
    return {
      issues: (issues as unknown[]).map(issueFromGh).filter((v) => !!v).slice(0, GH_LIMITS.items) as GhList['issues'],
      pulls: (pulls as unknown[]).map(pullFromGh).filter((v) => !!v).slice(0, GH_LIMITS.items) as GhList['pulls'],
      runs: (runs as unknown[]).map(runFromGh).filter((v) => !!v).slice(0, GH_LIMITS.runs) as GhList['runs'],
    }
  }

  private async listRest(repo: string): Promise<Pick<GhList, 'issues' | 'pulls' | 'runs'>> {
    const [issues, pulls, runs] = await Promise.all([
      this.rest(`/repos/${repo}/issues?state=open&per_page=${GH_LIMITS.items + 10}`),
      this.rest(`/repos/${repo}/pulls?state=open&per_page=${GH_LIMITS.items}`),
      // Runs need Actions; a repository without them answers 404 here, which is not an error for the rest.
      this.rest(`/repos/${repo}/actions/runs?status=failure&per_page=${GH_LIMITS.runs}`).catch(() => ({ workflow_runs: [] })),
    ])
    return { issues: issuesFromRest(issues), pulls: pullsFromRest(pulls), runs: runsFromRest(runs) }
  }

  /** One issue, pull request or run in full (within the bounds), to build the request from. */
  async item(q: GithubItemQuery): Promise<GhItem> {
    const ref = parseAddress(q.repo)
    if (!ref || !(q.number > 0)) throw new Problem('not-found', WORDS['not-found'])
    const repo = refLabel(ref)
    const n = String(Math.floor(q.number))
    if (this.demo) return demoItem(repo, q.kind, q.number)
    if (await this.hasCli()) {
      if (q.kind === 'issue') {
        const issue = issueFromGh(await this.ghJson(['issue', 'view', n, '-R', repo, '--json', 'number,title,url,author,labels,state,updatedAt,body,comments']))
        if (!issue) throw new Problem('not-found', WORDS['not-found'])
        return { kind: 'issue', repo, issue }
      }
      if (q.kind === 'pull') {
        const pull = pullFromGh(await this.ghJson(['pr', 'view', n, '-R', repo, '--json', 'number,title,url,author,isDraft,state,headRefName,baseRefName,updatedAt,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,body,files,comments']))
        if (!pull) throw new Problem('not-found', WORDS['not-found'])
        return { kind: 'pull', repo, pull }
      }
      const run = runFromGh(await this.ghJson(['run', 'view', n, '-R', repo, '--json', 'databaseId,workflowName,displayTitle,headBranch,event,conclusion,attempt,createdAt,url,jobs']))
      if (!run) throw new Problem('not-found', WORDS['not-found'])
      const logs = await this.gh(['run', 'view', n, '-R', repo, '--log-failed'])
      attachLogs(run, logs.ok ? logs.out : '', logs.ok ? undefined : 'The logs of the failing jobs could not be read; open the run on GitHub to see them.')
      return { kind: 'run', repo, run }
    }
    if (q.kind === 'issue') {
      const [body, comments] = await Promise.all([this.rest(`/repos/${repo}/issues/${n}`), this.rest(`/repos/${repo}/issues/${n}/comments?per_page=30`).catch(() => [])])
      const o = body as Record<string, unknown>
      const issue = issueFromGh({ ...o, url: o.html_url, author: o.user, updatedAt: o.updated_at, comments: (comments as unknown[]).map((c) => ({ ...(c as object), author: (c as Record<string, unknown>).user })) })
      if (!issue) throw new Problem('not-found', WORDS['not-found'])
      return { kind: 'issue', repo, issue }
    }
    if (q.kind === 'pull') {
      const [body, files] = await Promise.all([this.rest(`/repos/${repo}/pulls/${n}`), this.rest(`/repos/${repo}/pulls/${n}/files?per_page=${GH_LIMITS.files}`).catch(() => [])])
      const o = body as Record<string, unknown>
      const head = (o.head || {}) as Record<string, unknown>
      const checks = head.sha ? ((await this.rest(`/repos/${repo}/commits/${String(head.sha)}/check-runs?per_page=${GH_LIMITS.checks}`).catch(() => ({}))) as Record<string, unknown>).check_runs : []
      const pull = pullFromGh({ ...o, url: o.html_url, author: o.user, isDraft: o.draft, headRefName: head.ref, baseRefName: (o.base as Record<string, unknown> | undefined)?.ref, updatedAt: o.updated_at, changedFiles: o.changed_files, files, statusCheckRollup: checks })
      if (!pull) throw new Problem('not-found', WORDS['not-found'])
      return { kind: 'pull', repo, pull }
    }
    const [body, jobs] = await Promise.all([this.rest(`/repos/${repo}/actions/runs/${n}`), this.rest(`/repos/${repo}/actions/runs/${n}/jobs?per_page=30`).catch(() => ({ jobs: [] }))])
    const o = body as Record<string, unknown>
    const run = runFromGh({ ...o, workflowName: o.name, displayTitle: o.display_title, headBranch: o.head_branch, createdAt: o.created_at, url: o.html_url })
    if (!run) throw new Problem('not-found', WORDS['not-found'])
    run.jobs = jobsOf((jobs as Record<string, unknown>).jobs)
    run.logNote = 'GitHub shares run logs only with a signed-in reader. Install the GitHub CLI and run "gh auth login" to include them.'
    return { kind: 'run', repo, run }
  }
}

/** Puts the end of each failing job's log on the run's jobs (jobs the run listed, or ones found only in the log). */
export function attachLogs(run: GhRun, text: string, note?: string): void {
  const logs = failedLogs(text)
  const jobs = run.jobs ?? []
  for (const l of logs) {
    let j = jobs.find((x) => x.name === l.job) || jobs.find((x) => l.job.startsWith(x.name) || x.name.startsWith(l.job))
    if (!j) {
      if (jobs.length >= GH_LIMITS.jobs) continue
      j = { name: l.job, conclusion: 'failure', failedSteps: [] }
      jobs.push(j)
    }
    if (l.step && !j.failedSteps.includes(l.step)) j.failedSteps.push(l.step)
    j.log = j.log ? tail(`${j.log}\n${l.log}`) : l.log
  }
  run.jobs = jobs
  if (note || (!logs.length && !jobs.some((j) => j.log))) run.logNote = note || 'No log lines of failed steps came back.'
}

// ───────────── the demo's GitHub (fixtures; no network) ─────────────

const DAY = 86_400_000
const ago = (d: number): string => new Date(Date.UTC(2026, 10, 19) - d * DAY).toISOString()
const REPO = 'https://github.com/acme/pricing-site'

const DEMO_ISSUES: GhIssue[] = [
  { number: 142, title: 'Annual toggle shows monthly prices after switching back', url: `${REPO}/issues/142`, author: 'mira-k', labels: ['bug', 'pricing'], state: 'open', updatedAt: ago(0.2), comments: 3 },
  { number: 139, title: 'Checkout button does nothing on Safari 18', url: `${REPO}/issues/139`, author: 'tdaniels', labels: ['bug'], state: 'open', updatedAt: ago(1), comments: 5 },
  { number: 131, title: 'Prices are not rounded for EUR (shows 9.989999)', url: `${REPO}/issues/131`, author: 'lenaw', labels: ['bug', 'i18n'], state: 'open', updatedAt: ago(3), comments: 1 },
  { number: 127, title: 'Add a FAQ section under the plans', url: `${REPO}/issues/127`, author: 'mira-k', labels: ['enhancement'], state: 'open', updatedAt: ago(6), comments: 0 },
]
/** Only reached by pasting its address: closed a week ago. */
const DEMO_CLOSED_ISSUE: GhIssue = { number: 118, title: 'Yearly price shows without the discount', url: `${REPO}/issues/118`, author: 'tdaniels', labels: ['bug', 'pricing'], state: 'closed', updatedAt: ago(8), comments: 2 }
const DEMO_PULLS: GhPull[] = [
  { number: 145, title: 'Fix annual toggle state when switching plans', url: `${REPO}/pull/145`, author: 'jo-park', draft: false, state: 'open', branch: 'fix/annual-toggle', base: 'main', updatedAt: ago(0.1), additions: 48, deletions: 12, changedFiles: 3, review: 'Review wanted', checks: [{ name: 'test', state: 'fail' }, { name: 'build', state: 'pass' }] },
  { number: 143, title: 'Move prices to a single config file', url: `${REPO}/pull/143`, author: 'lenaw', draft: true, state: 'open', branch: 'prices-config', base: 'main', updatedAt: ago(2), additions: 210, deletions: 164, changedFiles: 9, review: '', checks: [{ name: 'test', state: 'pass' }, { name: 'build', state: 'pass' }] },
]
/** Only reached by pasting its address: merged four days ago. */
const DEMO_MERGED_PULL: GhPull = { number: 140, title: 'Show prices with two decimals', url: `${REPO}/pull/140`, author: 'lenaw', draft: false, state: 'merged', branch: 'two-decimals', base: 'main', updatedAt: ago(4), additions: 22, deletions: 6, changedFiles: 2, review: 'Approved', checks: [{ name: 'test', state: 'pass' }, { name: 'build', state: 'pass' }] }
const DEMO_RUNS: GhRun[] = [
  { id: 11873402215, workflow: 'CI', title: 'Fix annual toggle state when switching plans', branch: 'fix/annual-toggle', event: 'pull_request', conclusion: 'failure', createdAt: ago(0.1), url: `${REPO}/actions/runs/11873402215` },
  { id: 11860011904, workflow: 'Deploy preview', title: 'Move prices to a single config file', branch: 'prices-config', event: 'push', conclusion: 'failure', createdAt: ago(2), url: `${REPO}/actions/runs/11860011904` },
]
/** Only reached by pasting its address: it failed, then passed when it was run again. */
const DEMO_RERUN: GhRun = { id: 11850000001, workflow: 'CI', title: 'Bump the test runner', branch: 'main', event: 'push', conclusion: 'success', attempt: 2, createdAt: ago(5), url: `${REPO}/actions/runs/11850000001` }

function demoList(ref: GhRef): Omit<GhList, 'repo'> {
  if (/private/i.test(ref.repo)) return { via: null, issues: [], pulls: [], runs: [], problem: { kind: 'no-access', text: WORDS['no-access'] } }
  if (/empty|quiet/i.test(ref.repo)) return { via: 'demo', issues: [], pulls: [], runs: [] }
  // A pasted address that names something not in the short lists comes first, as it does for real.
  const issues = [...DEMO_ISSUES]
  const pulls = [...DEMO_PULLS]
  const runs = [...DEMO_RUNS]
  if (ref.kind === 'issue' && ref.number === DEMO_CLOSED_ISSUE.number) issues.unshift(DEMO_CLOSED_ISSUE)
  if (ref.kind === 'pull' && ref.number === DEMO_MERGED_PULL.number) pulls.unshift(DEMO_MERGED_PULL)
  if (ref.kind === 'run' && ref.number === DEMO_RERUN.id) runs.unshift(DEMO_RERUN)
  return { via: 'demo', issues, pulls, runs }
}

function demoItem(repo: string, kind: 'issue' | 'pull' | 'run', number: number): GhItem {
  if (kind === 'issue') {
    const i = [DEMO_CLOSED_ISSUE, ...DEMO_ISSUES].find((x) => x.number === number) || DEMO_ISSUES[0]
    return {
      kind,
      repo,
      issue: {
        ...i,
        body: 'Steps: open /pricing, switch to Annual, then back to Monthly, then to Annual again. The cards show the monthly prices with "/year" after them.\n\nExpected: annual prices every time.',
        thread: [{ author: 'tdaniels', body: 'Same on Firefox. It looks like the toggle keeps the old state after the second switch.' }],
      },
    }
  }
  if (kind === 'pull') {
    const p = [DEMO_MERGED_PULL, ...DEMO_PULLS].find((x) => x.number === number) || DEMO_PULLS[0]
    return { kind, repo, pull: { ...p, body: 'The toggle now reads the plan period from one place. Fixes #142.', files: [{ path: 'src/pricing/Toggle.tsx', additions: 30, deletions: 9 }, { path: 'src/pricing/usePlan.ts', additions: 12, deletions: 3 }, { path: 'src/pricing/Toggle.test.tsx', additions: 6, deletions: 0 }] } }
  }
  const r = [DEMO_RERUN, ...DEMO_RUNS].find((x) => x.id === number) || DEMO_RUNS[0]
  const run: GhRun = { ...r, jobs: [{ name: 'test', conclusion: 'failure', failedSteps: [] }] }
  attachLogs(run, 'test\tRun pnpm test\t2026-11-19T09:12:01.1234567Z  FAIL  src/pricing/Toggle.test.tsx\ntest\tRun pnpm test\t2026-11-19T09:12:01.2234567Z   ● switches back to annual prices\ntest\tRun pnpm test\t2026-11-19T09:12:01.3234567Z     Expected: "$290/year"  Received: "$29/year"\ntest\tRun pnpm test\t2026-11-19T09:12:02.0000000Z ##[error]Process completed with exit code 1.')
  return { kind: 'run', repo, run }
}
