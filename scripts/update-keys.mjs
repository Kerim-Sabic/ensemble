// Makes the project's update-signing key pair (Ed25519), once.
//
//   node scripts/update-keys.mjs              writes the private key to ~/ensemble-update-key.pem
//   node scripts/update-keys.mjs --out <file> somewhere else
//   node scripts/update-keys.mjs --force      replace an existing key (read the warning first)
//
// The public half goes into src/main/release-key.ts (this script writes it there) and ships in
// every copy of the app. The private half goes into a GitHub secret and nowhere else in the repo.
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { embeddedKey } from './update-sign.mjs'

export function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** release-key.ts with the given public key in place of the old one. */
export function embedKey(source, publicPem) {
  if (!/UPDATE_PUBLIC_KEY\s*=\s*`[^`]*`/.test(source)) throw new Error('UPDATE_PUBLIC_KEY not found in release-key.ts')
  return source.replace(/UPDATE_PUBLIC_KEY\s*=\s*`[^`]*`/, `UPDATE_PUBLIC_KEY = \`${publicPem.trim()}\``)
}

// Run only as `node scripts/update-keys.mjs`, never when bundled into the checks (where import.meta.url is the bundle's).
const isMain = !!process.argv[1] && path.basename(process.argv[1]) === 'update-keys.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const outAt = args.indexOf('--out')
  const out = path.resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1] : path.join(os.homedir(), 'ensemble-update-key.pem'))
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const keyFile = path.join(root, 'src', 'main', 'release-key.ts')
  const source = fs.readFileSync(keyFile, 'utf8')

  if (embeddedKey(source) && !force) {
    console.error('src/main/release-key.ts already has a key. Replacing it means every copy installed with the old key refuses')
    console.error('updates signed with the new one: people would have to download the next version by hand. Run with --force only if')
    console.error('the old private key is lost or leaked.')
    process.exit(1)
  }
  if (fs.existsSync(out) && !force) {
    console.error(`${out} already exists. Use --out <file> or --force.`)
    process.exit(1)
  }
  if (path.resolve(out).startsWith(root + path.sep)) {
    console.error('Write the private key outside the repository (it must never be committed). Use --out <file>.')
    process.exit(1)
  }

  const { publicPem, privatePem } = makeKeys()
  fs.writeFileSync(out, privatePem, { mode: 0o600 })
  fs.writeFileSync(keyFile, embedKey(source, publicPem))

  console.log('Update-signing key pair made.\n')
  console.log(`  Public key  -> written into src/main/release-key.ts (commit it; it ships in the app).`)
  console.log(`  Private key -> ${out}\n`)
  console.log('Now:')
  console.log('  1. Put the private key in the repository\'s secrets (Settings > Secrets and variables > Actions), or:')
  console.log(`       gh secret set ENSEMBLE_UPDATE_KEY --repo Kerim-Sabic/ensemble < "${out}"`)
  console.log('  2. Keep a copy offline (a password manager). Lose it and installed copies can only be updated by a manual download.')
  console.log('  3. Delete the file above once both are done.')
  console.log('  4. From the next release on, every release is signed; the workflow refuses to publish one that is not.')
}
