// Update verification that does not depend on a Windows code-signing certificate.
//
// The release workflow signs each installer with the project's Ed25519 key (scripts/update-sign.mjs)
// and publishes the signatures in latest.yml / latest-mac.yml under `ensembleSignatures`. Before an
// update may install, the app hashes the downloaded file and checks that signature against the
// public key built into it (release-key.ts). The signed text names the file, the version and the
// file's SHA-256, so a signature cannot be moved to another file or another version.
//
// verifyUpdate and updatePolicy are pure (no files, no network) and checked in scripts/checks/platform.ts.
import { createHash, createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The exact text that is signed. scripts/update-sign.mjs builds the same text; the checks prove they agree. */
export function updateMessage(file: string, version: string, sha256: string): string {
  return `ensemble-update v1\nfile ${file}\nversion ${version}\nsha256 ${sha256.toLowerCase()}\n`
}

export type Verdict = { ok: true } | { ok: false; why: string }

export interface UpdateEvidence {
  /** The public key built into the app (PEM). */
  publicKey: string
  /** The installer's file name, as published. */
  file: string
  version: string
  /** SHA-256 of the downloaded file, hex. */
  sha256: string
  /** Base64 Ed25519 signature from the release, if one was published. */
  signature?: string | null
}

export function verifyUpdate(e: UpdateEvidence): Verdict {
  if (!e.signature) return { ok: false, why: `no signature was published for ${e.file}` }
  let key
  try {
    key = createPublicKey(e.publicKey)
  } catch {
    return { ok: false, why: 'the public key built into this copy cannot be read' }
  }
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, why: 'the public key built into this copy is not an Ed25519 key' }
  const sig = Buffer.from(e.signature, 'base64')
  if (sig.length !== 64) return { ok: false, why: 'the published signature is malformed' }
  let good = false
  try {
    good = verify(null, Buffer.from(updateMessage(e.file, e.version, e.sha256)), key, sig)
  } catch {
    good = false
  }
  return good ? { ok: true } : { ok: false, why: `the signature does not match ${e.file} ${e.version}` }
}

/** The signature published for one file in the update info (latest.yml's `ensembleSignatures`). */
export function signatureFor(info: unknown, file: string): string | null {
  const map = (info as { ensembleSignatures?: unknown } | null)?.ensembleSignatures
  if (!map || typeof map !== 'object') return null
  const v = (map as Record<string, unknown>)[file]
  return typeof v === 'string' && v ? v : null
}

export interface UpdatePolicy {
  /** Whether the app checks for updates at all. */
  run: boolean
  /** Whether a downloaded update must pass verifyUpdate before it may install. */
  verify: boolean
  /** One line for the log explaining the choice. */
  log: string
}

/** What the updater does on this platform with this build's key. */
export function updatePolicy(platform: NodeJS.Platform, publicKey: string, macSelfUpdate: boolean): UpdatePolicy {
  if (platform === 'darwin' && !macSelfUpdate) {
    return { run: false, verify: false, log: 'updates: off on macOS until the Mac build is signed with an Apple Developer ID; new versions are on the releases page' }
  }
  if (!publicKey.trim()) {
    return { run: true, verify: false, log: 'updates: no project signing key in this build, so updates are checked by HTTPS and their SHA-512 only' }
  }
  return { run: true, verify: true, log: 'updates: each update must carry a valid project signature before it installs' }
}

/** SHA-256 of a file, hex, read in pieces. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

/** Hashes the downloaded installer and checks it. Used by the updater in index.ts. */
export async function checkDownloaded(publicKey: string, info: { version: string; downloadedFile: string }): Promise<Verdict> {
  const file = path.basename(info.downloadedFile)
  let sha256 = ''
  try {
    sha256 = await sha256File(info.downloadedFile)
  } catch (e) {
    return { ok: false, why: `the downloaded file cannot be read: ${(e as Error).message}` }
  }
  return verifyUpdate({ publicKey, file, version: info.version, sha256, signature: signatureFor(info, file) })
}
