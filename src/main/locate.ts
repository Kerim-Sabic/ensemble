import path from 'node:path'
import { createRequire } from 'node:module'
import { exists } from './util'
import { claudePlaces, codexPackage, codexPlaces, exeName, here } from './platform'

// Named so it cannot clash with the `require` shim the bundler adds to ESM output.
const resolver = createRequire(import.meta.url)

/** Code inside an asar archive cannot be executed; its unpacked twin can. */
const unpacked = (p: string): string => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

/**
 * The Claude Code the person already has installed, so the app always runs the
 * same version as their terminal. Falls back to the copy bundled with the SDK.
 */
export function findClaude(custom?: string | null): string | null {
  const exe = exeName('claude', process.platform)
  // The chosen path, ~/.local/bin, PATH, ~/.claude/local, and on a Mac the Homebrew folders (platform.ts).
  for (const c of claudePlaces(here(), custom)) if (exists(c)) return c
  try {
    const pkg = resolver.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const bundled = unpacked(path.join(path.dirname(pkg), exe))
    if (exists(bundled)) return bundled
  } catch {
    /* not bundled */
  }
  return null
}

const CODEX_TRIPLE: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

export function findCodex(): string | null {
  const exe = exeName('codex', process.platform)
  const key = `${process.platform}-${process.arch}`
  const triple = CODEX_TRIPLE[key]
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'codex', 'bin', exe))
  if (triple) {
    try {
      const pkg = resolver.resolve(`${codexPackage(process)}/package.json`)
      candidates.push(unpacked(path.join(path.dirname(pkg), 'vendor', triple, 'bin', exe)))
    } catch {
      /* not installed */
    }
  }
  // Then one the person installed: PATH, and on a Mac the Homebrew folders (platform.ts).
  candidates.push(...codexPlaces(here()))
  for (const c of candidates) if (c && exists(c)) return c
  return null
}
