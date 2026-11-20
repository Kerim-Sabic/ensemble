// The first task a new user is offered, chosen from what the app can see in the chosen folder:
// tasks about the project when it is a code project, ordinary ones otherwise. Pure, so it can be
// checked with a made-up folder.

/** What the app saw in a folder: its name, the names at its top level, and whether it is a git repository. */
export interface FolderProbe {
  path: string
  name: string
  /** File and folder names at the top level (folders end with "/"). A few hundred at most. */
  entries: string[]
  git: boolean
  /** Set when the folder could not be read. */
  missing?: boolean
}

export interface FirstTask {
  title: string
  /** One plain line: what you get. */
  blurb: string
  /** The message sent to the lead. */
  text: string
}

/** Files that mark a folder as a code project, and the kind they say it is. */
const MARKERS: [RegExp, string][] = [
  // TypeScript first: a TypeScript project has a package.json too.
  [/^tsconfig(\..+)?\.json$/i, 'TypeScript'],
  [/^package\.json$/i, 'JavaScript'],
  [/^(pyproject\.toml|setup\.py|requirements\.txt|pipfile)$/i, 'Python'],
  [/^cargo\.toml$/i, 'Rust'],
  [/^go\.mod$/i, 'Go'],
  [/^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/i, 'Java'],
  [/^.+\.(csproj|sln|fsproj)$/i, '.NET'],
  [/^gemfile$/i, 'Ruby'],
  [/^composer\.json$/i, 'PHP'],
  [/^(cmakelists\.txt|makefile|meson\.build)$/i, 'C or C++'],
  [/^package\.swift$/i, 'Swift'],
  [/^pubspec\.yaml$/i, 'Dart'],
  [/^(deno\.json|deno\.jsonc|bun\.lockb)$/i, 'JavaScript'],
]

/** Folder names that hold tests. */
const TEST_DIRS = /^(tests?|__tests__|spec|specs)\/$/i

/** Whether the folder looks like a code project, and what kind. */
export function projectKind(p: Pick<FolderProbe, 'entries' | 'git'>): { code: boolean; kind?: string; tests: boolean } {
  const kind = MARKERS.find(([re]) => p.entries.some((e) => re.test(e)))?.[1]
  const src = p.entries.some((e) => /^(src|lib|app|cmd|pkg)\/$/i.test(e))
  const tests = p.entries.some((e) => TEST_DIRS.test(e)) || p.entries.some((e) => /\.(test|spec)\.[a-z]+$/i.test(e))
  return { code: !!kind || (p.git && src), kind, tests }
}

/**
 * Three first tasks that fit the folder. A code project gets tasks about that project; any other
 * folder (or none) gets ordinary ones. Every text stands on its own as a first message.
 */
export function firstTasks(p: FolderProbe | null): FirstTask[] {
  const k = p && !p.missing ? projectKind(p) : { code: false, tests: false }
  if (p && k.code) {
    const name = p.name || 'this project'
    const what = 'kind' in k && k.kind ? ` (${k.kind})` : ''
    return [
      {
        title: 'Explain this project',
        blurb: 'How it is put together, and its riskiest part',
        text: `Explain how ${name}${what} is put together: the main parts, how they fit, and where I would look to change something. Then name the single riskiest part of the code and say why, with the files.`,
      },
      {
        title: k.tests ? 'Find and fix a failing test' : 'Run it and fix what breaks',
        blurb: k.tests ? 'Run the tests, fix one that fails, show it passing' : 'Build or run it, fix the first thing that breaks',
        text: k.tests
          ? `Run the tests in ${name}. If one fails, find the cause, fix it, and show the test passing. If they all pass, say so and point out the weakest-tested part.`
          : `Build or run ${name} the way its README or config says. Fix the first thing that breaks, and show it working. If nothing breaks, say what you checked.`,
      },
      {
        title: p.git ? 'Review the last change' : 'Review the code',
        blurb: p.git ? 'What changed, what could go wrong, what to fix first' : 'The three things most worth fixing',
        text: p.git
          ? `Review the most recent change in ${name} (the last commit, and anything not yet committed): what it does, what could go wrong, and what to fix first. Have someone who did not write it check your review.`
          : `Review the code in ${name} and list the three things most worth fixing, most important first, each with the files and a suggested fix.`,
      },
    ]
  }
  // No folder chosen (the app's own new folder), or an empty one: only tasks that need no files.
  const files = !!p && !p.missing && p.entries.some((e) => !e.startsWith('.'))
  return [
    {
      title: 'Research and compare',
      blurb: 'Several sources, one table, a recommendation',
      text: 'Research the three best project management tools for a small team and compare them in a table: price, strengths, weaknesses. End with which one you would pick and why, with sources.',
    },
    {
      title: 'Plan something',
      blurb: 'A clear plan, day by day, with who does what',
      text: 'Plan a two-week launch for a new mobile app: what happens each day, who does it, and what could go wrong. Ask me first for anything you need to know.',
    },
    files
      ? {
          title: 'Explain what is here',
          blurb: 'What these files are and what to do with them',
          text: `Look at the files in ${p?.name || 'this folder'} and explain what they are, how they relate, and what I could do with them. Keep it short and plain.`,
        }
      : {
          title: 'Make a small tool',
          blurb: 'A working page, built, opened and checked',
          text: 'Make a small web page that converts a meeting time between time zones: pick a time in one city and see it in five others. Save it in this folder, open it, and show me it working.',
        },
  ]
}

// ───────────── where the first task runs ─────────────

/** A path in one shape for comparing: forward slashes, no trailing slash, lower case for Windows paths. */
export function pathKey(p: string): string {
  const raw = String(p || '').trim()
  let s = raw.replace(/\\/g, '/')
  const win = /^[a-z]:/i.test(s) || s.startsWith('//')
  s = s.replace(/\/+$/, '')
  if (/^[a-z]:$/i.test(s)) s += '/'
  if (!s && /^[\\/]/.test(raw)) s = '/'
  return win ? s.toLowerCase() : s
}

const isRoot = (k: string): boolean => k === '/' || /^[a-z]:\/$/i.test(k) || /^\/\/[^/]+(\/[^/]+)?$/.test(k)

/** Folders of a person's own that hold their files, never a working folder by themselves. */
const PERSONAL = /^(desktop|documents|downloads|pictures|music|videos|movies|library|appdata|onedrive|onedrive - .+|icloud drive)$/i

const baseName = (p: string): string => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''

/**
 * Why a folder must not be where a first task runs, in one plain sentence, or null when it is fine:
 * a drive root, the home folder, a folder that holds the home folder, or a personal folder such as
 * Documents itself. The team can change any file in the folder it works in.
 */
export function unsafeFolder(dir: string | null | undefined, home: string): string | null {
  const k = pathKey(dir || '')
  if (!k) return null
  const h = pathKey(home)
  const why = 'the team can change any file in the folder it works in'
  if (isRoot(k)) return `Not the top of a drive: ${why}, so choose a project folder.`
  if (h && k === h) return `Not your home folder: ${why}, so choose a project folder inside it.`
  if (h && h.startsWith(`${k}/`)) return `Not a folder that holds your home folder: ${why}, so choose a project folder.`
  const parent = k.slice(0, k.lastIndexOf('/')) || '/'
  const grand = parent.slice(0, parent.lastIndexOf('/')) || '/'
  const name = baseName(String(dir))
  // Documents, Desktop and the like, right in the home folder or in its OneDrive.
  if (PERSONAL.test(name) && (parent === h || (grand === h && /^onedrive/i.test(baseName(parent)))))
    return `Not your ${name} folder itself: ${why}, so choose a project folder inside it.`
  return null
}

/**
 * Where a first task runs when nobody chose a folder: a new folder of the app's own, "Ensemble" in
 * Documents (or in the home folder when there is no Documents). Never the home folder, a personal
 * folder itself or a drive root. Pure: the caller creates it.
 */
export function appFolder(home: string, documents?: string | null): string {
  const sep = /^[a-z]:/i.test(home) || home.includes('\\') ? '\\' : '/'
  const join = (a: string, b: string): string => `${a.replace(/[\\/]+$/, '')}${sep}${b}`
  const docs = documents && !isRoot(pathKey(documents)) && pathKey(documents) !== pathKey(home) ? documents : ''
  const first = join(docs || home, 'Ensemble')
  return unsafeFolder(first, home) ? join(home, 'Ensemble') : first
}

/** The folder a first-run screen starts with: the one already set when it is safe, otherwise none (the app's own). */
export function startFolder(draft: string | null | undefined, home: string): string | null {
  return draft && !unsafeFolder(draft, home) ? draft : null
}

/** A recent project found on this computer: a git folder that Claude Code or Codex worked in. */
export interface RecentProject {
  path: string
  name: string
  /** When it was last worked in (ms), as far as the app can tell. */
  at: number
}

/** What the first-run screen offers for the folder: the app's own folder and recent projects. */
export interface FirstFolders {
  app: string
  recent: RecentProject[]
}
