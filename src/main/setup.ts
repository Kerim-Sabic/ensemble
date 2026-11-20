import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import type { HubEvent, SetupStatus } from '@shared/types'
import { findClaude, findCodex } from './locate'
import { exists } from './util'
import { here, obsidianPlaces } from './platform'

/**
 * First-run checks and the one thing a new person may be missing: Claude Code itself.
 * The installer below follows Anthropic's own install scripts (claude.ai/install.ps1 on
 * Windows, claude.ai/install.sh on macOS): the same download location, the same checksum from
 * the release manifest, then the binary's own `install` step, which puts `claude` (`claude.exe`
 * on Windows) in ~/.local/bin. On a Mac that folder is on Ensemble's PATH (platform.ts, guiPath).
 */

const DOWNLOADS = 'https://downloads.claude.ai/claude-code-releases'

/** Set in demo mode to walk through the first run as someone who has nothing installed. */
export const NEW_USER = process.env.ENSEMBLE_DEMO_NEWUSER === '1'
let demoInstalled = false

function obsidianInstalled(): boolean {
  // Windows: the two install folders and %APPDATA%\obsidian; macOS: /Applications and Application Support (platform.ts).
  return obsidianPlaces(here()).some((p) => exists(p))
}

function gitBashFound(): boolean {
  if (process.platform !== 'win32') return true
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH && exists(process.env.CLAUDE_CODE_GIT_BASH_PATH)) return true
  const local = process.env.LOCALAPPDATA || ''
  return [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    local ? path.join(local, 'Programs', 'Git', 'bin', 'bash.exe') : '',
  ].some((p) => p && exists(p))
}

export function setupStatus(demo: boolean, claudePath: string | null): SetupStatus {
  if (demo) return { claude: NEW_USER ? demoInstalled : true, chatgpt: true, obsidian: !NEW_USER, gitBash: true }
  return { claude: !!findClaude(claudePath), chatgpt: !!findCodex(), obsidian: obsidianInstalled(), gitBash: gitBashFound() }
}

type Emit = (ev: HubEvent) => void
let running: Promise<boolean> | null = null

/** Downloads and installs Claude Code, reporting progress as `setup` events. Resolves true once `claude` can be found. */
export function installClaude(emit: Emit, demo: boolean, claudePath: string | null): Promise<boolean> {
  if (running) return running
  running = (demo ? fakeInstall(emit) : realInstall(emit, claudePath)).finally(() => (running = null))
  return running
}

async function fakeInstall(emit: Emit): Promise<boolean> {
  for (let pct = 0; pct <= 100; pct += 5) {
    emit({ type: 'setup', stage: 'download', pct })
    await new Promise((r) => setTimeout(r, 120))
  }
  emit({ type: 'setup', stage: 'install' })
  await new Promise((r) => setTimeout(r, 1200))
  demoInstalled = true
  emit({ type: 'setup', stage: 'done' })
  return true
}

function platformKey(): string | null {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  return null
}

async function realInstall(emit: Emit, claudePath: string | null): Promise<boolean> {
  const fail = (message: string): boolean => {
    emit({ type: 'setup', stage: 'failed', message })
    return false
  }
  const platform = platformKey()
  if (!platform) return fail('Claude Code is not available for this kind of computer.')
  emit({ type: 'setup', stage: 'download', pct: 0 })
  let file = ''
  try {
    const version = (await (await fetch(`${DOWNLOADS}/latest`)).text()).trim()
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return fail("Couldn't reach Claude's download service. Check your internet connection, or whether Claude is available in your country, and try again.")
    }
    const manifest = (await (await fetch(`${DOWNLOADS}/${version}/manifest.json`)).json()) as { platforms?: Record<string, { checksum?: string }> }
    const checksum = manifest.platforms?.[platform]?.checksum?.toLowerCase()
    if (!checksum) return fail('Claude Code has no download for this kind of computer yet.')

    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const dir = path.join(os.homedir(), '.claude', 'downloads')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, `claude-${version}-${platform}${process.platform === 'win32' ? '.exe' : ''}`)

    const res = await fetch(`${DOWNLOADS}/${version}/${platform}/${exe}`)
    if (!res.ok || !res.body) return fail(`The download failed (${res.status}). Try again in a minute.`)
    const total = Number(res.headers.get('content-length')) || 0
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(file)
    let got = 0
    let shown = -1
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      got += value.length
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      const pct = total ? Math.floor((got / total) * 100) : 0
      if (pct !== shown) {
        shown = pct
        emit({ type: 'setup', stage: 'download', pct })
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
    if (hash.digest('hex') !== checksum) return fail("The download didn't match Claude's published checksum, so it wasn't installed. Try again.")
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755)

    emit({ type: 'setup', stage: 'install' })
    const err = await new Promise<string | null>((resolve) =>
      execFile(file, ['install', 'latest'], { windowsHide: true, timeout: 5 * 60e3 }, (e, _stdout, stderr) => resolve(e ? String(stderr || e.message).trim().split('\n').pop() || e.message : null)),
    )
    if (err && !findClaude(claudePath)) return fail(`Claude Code couldn't finish installing: ${err}`)
    if (!findClaude(claudePath)) return fail('Claude Code installed, but Ensemble cannot find it. Restart Ensemble and try again.')
    emit({ type: 'setup', stage: 'done' })
    return true
  } catch (e) {
    return fail(`Couldn't download Claude Code: ${(e as Error).message}. Check your internet connection and try again.`)
  } finally {
    if (file) setTimeout(() => fs.rm(file, { force: true }, () => undefined), 1500)
  }
}
