import type { Ctx } from './ctx'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { checkDownloaded, sha256File, signatureFor, updateMessage, updatePolicy, verifyUpdate } from '../../src/main/updatesig'
import { UPDATE_PUBLIC_KEY } from '../../src/main/release-key'
import { claudePlaces, codexPackage, codexPlaces, exeName, guiPath, iconFile, obsidianPlaces, parseShellPath, windowChrome, type Plat } from '../../src/main/platform'
import { embeddedKey, readPrivateKey, signOne, signRelease, updateMessage as scriptMessage, withSignatures } from '../update-sign.mjs'
import { embedKey, makeKeys } from '../update-keys.mjs'
import { mergeMacFeeds } from '../mac-feed.mjs'

// Signed distribution, update verification, CI and macOS support (Launch, t71).
export default async function (c: Ctx): Promise<void> {
  // The checks run from the repository root (pnpm auto-test); bundled, __dirname would point at out/test.
  const root = process.cwd()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-platform-'))
  try {
    await updateChecks(c, tmp, root)
    platformChecks(c)
    configChecks(c, root)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function updateChecks(c: Ctx, tmp: string, root: string): Promise<void> {
  // A real key pair, made here, as the release would use it.
  const { publicPem, privatePem } = makeKeys()
  const other = makeKeys()
  const file = 'Ensemble-Setup-9.9.9.exe'
  const installer = path.join(tmp, file)
  fs.writeFileSync(installer, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31) % 256)))
  const sha = await sha256File(installer)
  const priv = readPrivateKey(privatePem)
  const sig = signOne(priv, file, '9.9.9', sha)

  c.same('update: the app and the signing script sign the same text', updateMessage(file, '9.9.9', sha), scriptMessage(file, '9.9.9', sha))
  c.check('update: a good signature is accepted', verifyUpdate({ publicKey: publicPem, file, version: '9.9.9', sha256: sha, signature: sig }).ok)
  c.check('update: a signature made with another key is refused', !verifyUpdate({ publicKey: other.publicPem, file, version: '9.9.9', sha256: sha, signature: sig }).ok)
  fs.appendFileSync(installer, 'x')
  const changed = await sha256File(installer)
  c.check('update: a changed file is refused', !verifyUpdate({ publicKey: publicPem, file, version: '9.9.9', sha256: changed, signature: sig }).ok)
  fs.writeFileSync(installer, fs.readFileSync(installer).subarray(0, 4096))
  const missing = verifyUpdate({ publicKey: publicPem, file, version: '9.9.9', sha256: sha, signature: null })
  c.check('update: a missing signature is refused, with the reason', !missing.ok && /no signature/.test(missing.why))
  c.check('update: the same file under another version is refused', !verifyUpdate({ publicKey: publicPem, file, version: '9.9.8', sha256: sha, signature: sig }).ok)
  c.check('update: the signature cannot be moved to another file name', !verifyUpdate({ publicKey: publicPem, file: 'Ensemble-Setup-9.9.9-evil.exe', version: '9.9.9', sha256: sha, signature: sig }).ok)
  c.check('update: a malformed signature is refused', !verifyUpdate({ publicKey: publicPem, file, version: '9.9.9', sha256: sha, signature: 'bm90IGEgc2lnbmF0dXJl' }).ok)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
  c.check('update: a key that is not Ed25519 is refused', !verifyUpdate({ publicKey: rsa, file, version: '9.9.9', sha256: sha, signature: sig }).ok)
  c.check('update: an unreadable key is refused', !verifyUpdate({ publicKey: 'not a key', file, version: '9.9.9', sha256: sha, signature: sig }).ok)

  // The release workflow's script, end to end: sign a fake release folder, read the feed back the way electron-updater does.
  const dist = path.join(tmp, 'dist')
  fs.mkdirSync(dist)
  fs.copyFileSync(installer, path.join(dist, file))
  fs.writeFileSync(path.join(dist, 'Ensemble-Setup-9.9.8.exe'), 'an older installer that must not be signed')
  fs.writeFileSync(path.join(dist, 'latest.yml'), `version: 9.9.9\nfiles:\n  - url: ${file}\n    sha512: abc\n    size: 4096\npath: ${file}\nsha512: abc\nreleaseDate: '2026-11-20T00:00:00.000Z'\n`)
  c.same('update: no key in the app and no secret means signing is off', (await signRelease({ dir: dist, version: '9.9.9', secret: '', publicKey: '' })).state, 'off')
  c.check('update: a key in the app without the secret stops the release', await rejects(() => signRelease({ dir: dist, version: '9.9.9', secret: '', publicKey: publicPem })))
  c.check('update: a secret that does not match the app key stops the release', await rejects(() => signRelease({ dir: dist, version: '9.9.9', secret: other.privatePem, publicKey: publicPem })))
  c.check('update: a secret without a key in the app stops the release', await rejects(() => signRelease({ dir: dist, version: '9.9.9', secret: privatePem, publicKey: '' })))
  const signed = await signRelease({ dir: dist, version: '9.9.9', secret: Buffer.from(privatePem).toString('base64'), publicKey: publicPem })
  c.same('update: the script signs only this version\'s installers (secret given as base64)', signed.files, [file])
  c.check('update: a .sig file is written next to the installer', fs.existsSync(path.join(dist, `${file}.sig`)))
  await signRelease({ dir: dist, version: '9.9.9', secret: privatePem, publicKey: publicPem })
  const feedText = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8')
  c.same('update: signing twice leaves one signature block in the feed', feedText.match(/ensembleSignatures:/g)?.length, 1)
  const info = yaml.load(feedText) as Record<string, unknown>
  c.same('update: the feed still reads as electron-updater reads it', info.version, '9.9.9')
  c.check('update: the published signature is found for the file', !!signatureFor(info, file))
  const downloaded = path.join(tmp, 'pending', file)
  fs.mkdirSync(path.dirname(downloaded))
  fs.copyFileSync(path.join(dist, file), downloaded)
  const ok = await checkDownloaded(publicPem, { ...(info as object), version: '9.9.9', downloadedFile: downloaded })
  c.check('update: the app accepts the release the script signed', ok.ok, ok.ok ? '' : ok.why)
  fs.appendFileSync(downloaded, 'tampered')
  c.check('update: the app refuses that download once it is changed', !(await checkDownloaded(publicPem, { ...(info as object), version: '9.9.9', downloadedFile: downloaded })).ok)
  c.check('update: the app refuses a feed with no signatures', !(await checkDownloaded(publicPem, { version: '9.9.9', downloadedFile: path.join(dist, file) })).ok)
  c.same('update: a feed without matching files gets no signature block', withSignatures('version: 1\nfiles:\n  - url: a.exe\n', { 'b.exe': 'x' }).includes('ensembleSignatures'), false)

  // What the updater does on each platform.
  c.same('update policy: macOS does not update itself until the Mac build is signed', updatePolicy('darwin', publicPem, false).run, false)
  const noKey = updatePolicy('win32', '', false)
  c.check('update policy: no key in the build means updates as before, with a log line', noKey.run && !noKey.verify && /no project signing key/.test(noKey.log))
  const withKey = updatePolicy('win32', publicPem, false)
  c.check('update policy: with a key, every update is verified', withKey.run && withKey.verify)
  c.check('update policy: a signed Mac build would verify too', updatePolicy('darwin', publicPem, true).verify)

  // The key script writes the public key where the signing script and the app both find it.
  const keySource = 'export const UPDATE_PUBLIC_KEY = ``\nexport const MAC_SELF_UPDATE = false\n'
  c.same('keys: the key script writes the public key where the release script reads it', embeddedKey(embedKey(keySource, publicPem)), publicPem.trim())
  const realSource = fs.readFileSync(path.join(root, 'src', 'main', 'release-key.ts'), 'utf8')
  c.same('keys: the release script reads the same key the app is built with', embeddedKey(realSource), UPDATE_PUBLIC_KEY.trim())
}

function platformChecks(c: Ctx): void {
  const win: Plat = { platform: 'win32', arch: 'x64', home: 'C:\\Users\\kim', env: { PATH: 'C:\\Windows\\system32;C:\\Users\\kim\\.local\\bin;D:\\tools', LOCALAPPDATA: 'C:\\Users\\kim\\AppData\\Local', APPDATA: 'C:\\Users\\kim\\AppData\\Roaming' } }
  const mac: Plat = { platform: 'darwin', arch: 'arm64', home: '/Users/kim', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' } }

  c.same('windows: Claude Code is looked for in the same places, in the same order, as before', claudePlaces(win, 'E:\\claude.exe'), [
    'E:\\claude.exe',
    'C:\\Users\\kim\\.local\\bin\\claude.exe',
    'C:\\Windows\\system32\\claude.exe',
    'D:\\tools\\claude.exe',
    'C:\\Users\\kim\\.claude\\local\\claude.exe',
  ])
  const macClaude = claudePlaces(mac)
  c.same('macOS: Claude Code is looked for in ~/.local/bin first', macClaude[0], '/Users/kim/.local/bin/claude')
  c.check('macOS: and in the Homebrew folders an app opened from Finder cannot see on PATH', macClaude.includes('/opt/homebrew/bin/claude') && macClaude.includes('/usr/local/bin/claude'))
  c.check('macOS: no Windows paths or .exe names', macClaude.every((p) => p.startsWith('/') && !p.endsWith('.exe')))
  c.check('macOS: the ChatGPT runtime is looked for in Homebrew too', codexPlaces(mac).includes('/opt/homebrew/bin/codex'))
  c.same('windows: the ChatGPT runtime is looked for on PATH only, as before', codexPlaces(win), ['C:\\Windows\\system32\\codex.exe', 'C:\\Users\\kim\\.local\\bin\\codex.exe', 'D:\\tools\\codex.exe'])
  c.same('the ChatGPT runtime package matches the computer', [codexPackage({ platform: 'darwin', arch: 'arm64' }), codexPackage({ platform: 'win32', arch: 'x64' })], ['@openai/codex-darwin-arm64', '@openai/codex-win32-x64'])
  c.same('program names', [exeName('claude', 'win32'), exeName('claude', 'darwin')], ['claude.exe', 'claude'])

  c.same('windows: PATH is left exactly as it is', guiPath(win, '/should/not/be/used'), win.env.PATH)
  const macPath = guiPath(mac, '/Users/kim/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin').split(':')
  c.same('macOS: the login shell\'s PATH comes first', macPath[0], '/Users/kim/.nvm/versions/node/v22/bin')
  c.check('macOS: the tool folders are added once each', macPath.filter((d) => d === '/opt/homebrew/bin').length === 1 && macPath.includes('/Users/kim/.local/bin') && macPath.includes('/usr/local/bin'))
  c.check('macOS: without a login shell PATH the tool folders are still added', guiPath(mac, null).split(':').includes('/opt/homebrew/bin'))
  c.same('macOS: the PATH printed by a chatty login shell is still found', parseShellPath('Welcome!\n__ENSEMBLE_PATH__/opt/homebrew/bin:/usr/bin__ENSEMBLE_PATH__\nbye'), '/opt/homebrew/bin:/usr/bin')
  c.same('macOS: no PATH in the output gives nothing', parseShellPath('zsh: command not found'), null)

  c.same('windows: the window frame is exactly as before (own title bar, Windows buttons over it, Mica)', windowChrome('win32', true, '#fff'), { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#fff', height: 44 }, backgroundMaterial: 'mica' })
  c.same('windows: without Mica, no material', windowChrome('win32', false, '#000'), { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#000', height: 44 } })
  c.same('macOS: the standard frame with the traffic lights, no overlay', windowChrome('darwin', true, '#fff'), { titleBarStyle: 'default' })
  c.same('icons: .ico on Windows, .png elsewhere', [iconFile('win32'), iconFile('darwin')], ['icon.ico', 'icon.png'])

  c.same('windows: Obsidian is looked for in the same places as before', obsidianPlaces(win), [
    'C:\\Users\\kim\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe',
    'C:\\Users\\kim\\AppData\\Local\\Obsidian\\Obsidian.exe',
    'C:\\Users\\kim\\AppData\\Roaming\\obsidian\\obsidian.json',
    '/Applications/Obsidian.app',
  ])
  c.check('macOS: Obsidian is found in /Applications or by its vault list', obsidianPlaces(mac).includes('/Applications/Obsidian.app') && obsidianPlaces(mac).includes('/Users/kim/Library/Application Support/obsidian/obsidian.json'))
}

function configChecks(c: Ctx, root: string): void {
  type Cfg = { files: string[]; win: Record<string, unknown> & { files: string[]; asarUnpack: string[]; extraResources: { from: string }[] }; mac: Record<string, unknown> & { files: string[]; asarUnpack: string[]; target: { target: string }[] } }
  const cfg = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')) as Cfg
  const shared = ((cfg as unknown as { extraResources?: { from: string; to?: string }[] }).extraResources || [])
  c.check('build: hands.exe ships with the Windows build only', cfg.win.extraResources.some((r) => r.from === 'resources/hands.exe') && !('extraResources' in cfg.mac) && !shared.some((r) => /hands\.exe/.test(r.from)))
  // remote.ts looks for the phone page in resources/remote: without it, a paired phone gets "The phone page is missing from this build".
  c.check('build: the phone page ships on every system (Phone and remote)', shared.some((r) => r.from === 'resources/remote' && r.to === 'remote') && fs.existsSync(path.join(root, 'resources', 'remote', 'index.html')))
  c.check('build: each platform unpacks its own ChatGPT runtime', cfg.win.asarUnpack.includes('node_modules/@openai/codex-win32-x64/**') && cfg.mac.asarUnpack.includes('node_modules/@openai/codex-darwin-*/**'))
  c.check('build: Windows leaves out the Mac runtimes and the Mac build the Windows ones', cfg.win.files.includes('!node_modules/@openai/codex-darwin-*/**') && cfg.mac.files.includes('!node_modules/@openai/codex-win32-*/**'))
  c.check('build: the shared file list excludes neither platform\'s runtime', !cfg.files.some((f) => /codex-(darwin|win32)/.test(f)))
  c.same('build: the Mac targets are a dmg and a zip (the zip feeds updates)', cfg.mac.target.map((t) => t.target), ['dmg', 'zip'])
  c.same('build: the Mac app is ad-hoc signed until there is a Developer ID', cfg.mac.identity, '-')
  c.check('build: no signing settings are kept in the file (the release passes them only when secrets exist)', !('signtoolOptions' in cfg.win) && !('azureSignOptions' in cfg.win))

  const dir = path.join(root, '.github', 'workflows')
  const flows = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  c.check('workflows: CI, release and CodeQL are there', ['ci.yml', 'release.yml', 'codeql.yml'].every((f) => flows.includes(f)))
  for (const f of flows) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    const wf = yaml.load(text) as { permissions?: unknown; jobs: Record<string, { permissions?: Record<string, string>; steps?: { uses?: string }[] }> }
    const uses = Object.values(wf.jobs).flatMap((j) => (j.steps || []).map((s) => s.uses).filter(Boolean) as string[])
    c.check(`workflows: ${f} pins every action to a full commit`, uses.every((u) => /@[0-9a-f]{40}$/.test(u)), uses.filter((u) => !/@[0-9a-f]{40}$/.test(u)).join(', '))
    c.check(`workflows: ${f} sets its permissions`, wf.permissions !== undefined)
    if (f === 'release.yml') {
      const writers = Object.entries(wf.jobs).filter(([, j]) => j.permissions && Object.values(j.permissions).includes('write')).map(([n]) => n)
      c.same('workflows: only the publish job can write, sign attestations or see the update key', writers, ['publish'])
      c.same('workflows: the publish job asks for exactly what it needs', wf.jobs.publish.permissions, { contents: 'write', 'id-token': 'write', attestations: 'write' })
      c.check('workflows: the update key is read in the publish job only', text.split('ENSEMBLE_UPDATE_KEY: ${{').length === 2 && text.indexOf('ENSEMBLE_UPDATE_KEY: ${{') > text.indexOf('\n  publish:'))
    }
  }
  const dependabot = yaml.load(fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8')) as { updates: { 'package-ecosystem': string }[] }
  c.same('dependabot: npm packages and GitHub Actions are watched', dependabot.updates.map((u) => u['package-ecosystem']).sort(), ['github-actions', 'npm'])

  const arm = `version: 9.9.9\nfiles:\n  - url: Ensemble-9.9.9-arm64-mac.zip\n    sha512: a1\n    size: 10\n  - url: Ensemble-9.9.9-arm64.dmg\n    sha512: a2\n    size: 11\npath: Ensemble-9.9.9-arm64-mac.zip\nsha512: a1\nreleaseDate: '2026-11-20T00:00:00.000Z'\n`
  const x64 = arm.replace(/arm64/g, 'x64').replace(/a1/g, 'b1').replace(/a2/g, 'b2')
  const merged = yaml.load(mergeMacFeeds(arm, x64)) as { files: { url: string }[]; path: string }
  c.same('mac feed: one feed lists the files for both processors', merged.files.map((f) => f.url), ['Ensemble-9.9.9-arm64-mac.zip', 'Ensemble-9.9.9-arm64.dmg', 'Ensemble-9.9.9-x64-mac.zip', 'Ensemble-9.9.9-x64.dmg'])
  c.same('mac feed: the rest of the feed is unchanged', merged.path, 'Ensemble-9.9.9-arm64-mac.zip')
  c.same('mac feed: merging the same feed twice adds nothing', (yaml.load(mergeMacFeeds(arm, arm)) as { files: unknown[] }).files.length, 2)
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
