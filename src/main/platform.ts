// What differs between Windows and macOS, in one place. Every function here takes the platform
// as a parameter instead of reading process.platform, so the checks can try 'darwin' and 'win32'
// on any computer (scripts/checks/platform.ts). Windows behaviour is exactly what it was before
// these helpers existed; macOS is new and lightly tested.
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface Plat {
  platform: NodeJS.Platform
  arch: string
  home: string
  env: Record<string, string | undefined>
}

/** This computer. */
export function here(): Plat {
  return { platform: process.platform, arch: process.arch, home: os.homedir(), env: process.env }
}

const joiner = (p: Plat): ((...parts: string[]) => string) => (p.platform === 'win32' ? path.win32.join : path.posix.join)

/** A program's file name: `claude.exe` on Windows, `claude` elsewhere. */
export function exeName(base: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${base}.exe` : base
}

/** The folders on PATH, in order. */
export function pathDirs(p: Plat): string[] {
  return (p.env.PATH || p.env.Path || '').split(p.platform === 'win32' ? ';' : ':').filter(Boolean)
}

/**
 * Where command-line tools live on a Mac besides the system folders. An app opened from Finder
 * or the Dock gets only /usr/bin:/bin:/usr/sbin:/sbin as its PATH, so tools installed with
 * Homebrew or the official installers would otherwise be invisible to it and to every agent.
 */
export function macToolDirs(home: string): string[] {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.posix.join(home, '.local', 'bin')]
}

/**
 * The places to look for the person's own Claude Code, best first. On Windows: the chosen path,
 * ~/.local/bin, each folder on PATH, then ~/.claude/local (the order Ensemble always used).
 * On a Mac the Homebrew and /usr/local folders follow, for an app started without a shell's PATH.
 */
export function claudePlaces(p: Plat, custom?: string | null): string[] {
  const j = joiner(p)
  const exe = exeName('claude', p.platform)
  const list = [custom || '', j(p.home, '.local', 'bin', exe), ...pathDirs(p).map((d) => j(d, exe)), j(p.home, '.claude', 'local', exe)]
  if (p.platform === 'darwin') list.push(...macToolDirs(p.home).map((d) => j(d, exe)))
  return dedupe(list.filter(Boolean))
}

/** Folders to try for a `codex` the person installed themselves, after the copy that ships with Ensemble. */
export function codexPlaces(p: Plat): string[] {
  const j = joiner(p)
  const exe = exeName('codex', p.platform)
  const list = pathDirs(p).map((d) => j(d, exe))
  if (p.platform === 'darwin') list.push(...macToolDirs(p.home).map((d) => j(d, exe)))
  return dedupe(list)
}

/** The npm package that carries the ChatGPT runtime for this computer, e.g. `@openai/codex-darwin-arm64`. */
export function codexPackage(p: Pick<Plat, 'platform' | 'arch'>): string {
  return `@openai/codex-${p.platform}-${p.arch}`
}

/**
 * The PATH Ensemble and its agents should use. Windows: unchanged. macOS: the login shell's PATH
 * first (what the person sees in Terminal), then what the app was started with, then the usual
 * tool folders, without repeats.
 */
export function guiPath(p: Plat, shellPath?: string | null): string {
  const current = p.env.PATH || ''
  if (p.platform !== 'darwin') return current
  const parts = [...(shellPath || '').split(':'), ...current.split(':'), ...macToolDirs(p.home)]
  return dedupe(parts.map((s) => s.trim()).filter((s) => s.startsWith('/'))).join(':')
}

const MARK = '__ENSEMBLE_PATH__'

/** The PATH printed between two markers by a login shell, ignoring whatever the shell's start-up files print around it. */
export function parseShellPath(output: string): string | null {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(output)
  const v = m?.[1]?.trim()
  return v && v.includes('/') ? v : null
}

/** Asks the person's login shell for its PATH. macOS only; a few seconds at most; null when it cannot be read. */
export function loginShellPath(p: Plat = here()): string | null {
  if (p.platform !== 'darwin') return null
  const shell = p.env.SHELL && p.env.SHELL.startsWith('/') ? p.env.SHELL : '/bin/zsh'
  try {
    const out = execFileSync(shell, ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    return parseShellPath(out)
  } catch {
    return null
  }
}

/** Where Obsidian keeps its list of vaults, and where the app itself is installed. */
export function obsidianPlaces(p: Plat): string[] {
  const j = joiner(p)
  if (p.platform === 'win32') {
    const local = p.env.LOCALAPPDATA || j(p.home, 'AppData', 'Local')
    return [
      j(local, 'Programs', 'Obsidian', 'Obsidian.exe'),
      j(local, 'Obsidian', 'Obsidian.exe'),
      p.env.APPDATA ? j(p.env.APPDATA, 'obsidian', 'obsidian.json') : '',
      '/Applications/Obsidian.app',
    ].filter(Boolean)
  }
  if (p.platform === 'darwin') return ['/Applications/Obsidian.app', j(p.home, 'Applications', 'Obsidian.app'), j(p.home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')]
  return [j(p.home, '.config', 'obsidian', 'obsidian.json')]
}

export interface Chrome {
  titleBarStyle: 'hidden' | 'default'
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
  backgroundMaterial?: 'mica'
}

/**
 * The window frame. Windows: Ensemble draws its own title bar and Windows draws the three
 * buttons over it (and Mica behind it on Windows 11). macOS: the standard title bar with the
 * traffic lights, so nothing of Ensemble's own top bar sits under them.
 */
export function windowChrome(platform: NodeJS.Platform, mica: boolean, symbolColor: string): Chrome {
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor, height: 44 }, ...(mica ? { backgroundMaterial: 'mica' as const } : {}) }
  return { titleBarStyle: 'default' }
}

/** The icon file for windows and the tray: Windows picks each size out of the .ico; elsewhere a PNG. */
export function iconFile(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'icon.ico' : 'icon.png'
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}
