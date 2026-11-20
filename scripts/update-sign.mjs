// Signs a release's installers with the project's update key (Ed25519) and publishes the
// signatures where installed copies look for them. Run by .github/workflows/release.yml:
//
//   ENSEMBLE_UPDATE_KEY=<private key PEM> node scripts/update-sign.mjs dist 3.8.0
//
// For each Ensemble-*-<version>.(exe|zip|dmg) in the folder it writes <file>.sig (base64) and adds
// an `ensembleSignatures:` map to latest.yml / latest-mac.yml. The app checks that signature
// before an update installs (src/main/updatesig.ts). The signed text is built by updateMessage()
// below and by the same-named function in updatesig.ts; scripts/checks/platform.ts proves they agree.
//
// Rules, so a release can never ship that installed copies would refuse:
// - no key in the app and no secret: nothing to do (updates work as before);
// - a key in the app but no secret: fail (installed copies would refuse the update);
// - a secret but no key in the app, or a secret that does not match the app's key: fail.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function updateMessage(file, version, sha256) {
  return `ensemble-update v1\nfile ${file}\nversion ${version}\nsha256 ${sha256.toLowerCase()}\n`
}

/** A private key from the secret: PEM text, or the same PEM base64-encoded on one line. */
export function readPrivateKey(secret) {
  const text = secret.trim().startsWith('-----BEGIN') ? secret : Buffer.from(secret.trim(), 'base64').toString('utf8')
  return createPrivateKey(text)
}

export function publicPemOf(privateKey) {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
}

const squash = (pem) => pem.replace(/\s+/g, '')

/** The public key written into src/main/release-key.ts, or '' when there is none. */
export function embeddedKey(source) {
  return (/UPDATE_PUBLIC_KEY\s*=\s*`([^`]*)`/.exec(source)?.[1] || '').trim()
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

export function signOne(privateKey, file, version, sha256) {
  return sign(null, Buffer.from(updateMessage(file, version, sha256)), privateKey).toString('base64')
}

/** The update feed with an `ensembleSignatures:` map for the files it names (any earlier map replaced). */
export function withSignatures(yml, signatures) {
  const lines = yml.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let skipping = false
  for (const line of lines) {
    if (/^ensembleSignatures:/.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s+/.test(line)) continue
    skipping = false
    out.push(line)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  const named = Object.entries(signatures).filter(([file]) => yml.includes(file))
  if (!named.length) return `${out.join('\n')}\n`
  return `${out.join('\n')}\nensembleSignatures:\n${named.map(([file, sig]) => `  '${file}': '${sig}'`).join('\n')}\n`
}

const INSTALLER = /^Ensemble-.*\.(exe|zip|dmg)$/

/**
 * Signs every installer of `version` in `dir`. Returns { state: 'off' } when signing is not set up,
 * { state: 'signed', files } when done; throws with a plain reason when the setup is inconsistent.
 */
export async function signRelease({ dir, version, secret, publicKey }) {
  const hasSecret = !!(secret && secret.trim())
  const hasKey = !!(publicKey && publicKey.trim())
  if (!hasSecret && !hasKey) return { state: 'off' }
  if (hasKey && !hasSecret) {
    throw new Error('This app has a project update key (src/main/release-key.ts) but the ENSEMBLE_UPDATE_KEY secret is missing: installed copies would refuse this update.')
  }
  if (!hasKey) throw new Error('ENSEMBLE_UPDATE_KEY is set but the app has no public key. Run `node scripts/update-keys.mjs` or put the public key in src/main/release-key.ts.')
  const privateKey = readPrivateKey(secret)
  if (squash(publicPemOf(privateKey)) !== squash(publicKey)) {
    throw new Error('ENSEMBLE_UPDATE_KEY does not match the public key in src/main/release-key.ts: installed copies would refuse this update.')
  }
  const files = fs.readdirSync(dir).filter((f) => INSTALLER.test(f) && f.includes(version)).sort()
  if (!files.length) throw new Error(`No installers for ${version} in ${dir}.`)
  const signatures = {}
  for (const f of files) {
    const sig = signOne(privateKey, f, version, await sha256File(path.join(dir, f)))
    fs.writeFileSync(path.join(dir, `${f}.sig`), `${sig}\n`)
    signatures[f] = sig
  }
  for (const feed of fs.readdirSync(dir).filter((f) => /^latest(-mac)?\.yml$/.test(f))) {
    const p = path.join(dir, feed)
    fs.writeFileSync(p, withSignatures(fs.readFileSync(p, 'utf8'), signatures))
  }
  return { state: 'signed', files }
}

// Run only as `node scripts/update-sign.mjs`, never when bundled into the checks (where import.meta.url is the bundle's).
const isMain = !!process.argv[1] && path.basename(process.argv[1]) === 'update-sign.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dir = path.resolve(process.argv[2] || 'dist')
  const version = process.argv[3] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const publicKey = embeddedKey(fs.readFileSync(path.join(root, 'src', 'main', 'release-key.ts'), 'utf8'))
  signRelease({ dir, version, secret: process.env.ENSEMBLE_UPDATE_KEY || '', publicKey })
    .then((r) => console.log(r.state === 'off' ? 'Update signing: not set up (no key in the app, no secret). Updates work as before.' : `Update signing: signed ${r.files.join(', ')}`))
    .catch((e) => {
      console.error(`Update signing failed: ${e.message}`)
      process.exit(1)
    })
}
