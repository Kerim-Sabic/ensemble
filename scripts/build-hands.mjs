// Compiles native/hands.cs into resources/hands.exe with the C# compiler that
// ships with Windows. Skipped when the program is already newer than its source.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = path.join(root, 'native', 'hands.cs')
const out = path.join(root, 'resources', 'hands.exe')

if (process.platform !== 'win32') {
  console.log('hands: only built on Windows, skipping')
  process.exit(0)
}
const fresh = fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs
if (fresh && !process.argv.includes('--force')) {
  console.log('hands: up to date')
  process.exit(0)
}
const windir = process.env.WINDIR || 'C:\\Windows'
const csc = ['Framework64', 'Framework'].map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p))
if (!csc) {
  console.error('hands: the .NET Framework C# compiler was not found; computer control will be unavailable in this build')
  process.exit(fs.existsSync(out) ? 0 : 1)
}
fs.mkdirSync(path.dirname(out), { recursive: true })
execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', '/r:System.Drawing.dll', `/out:${out}`, src], { stdio: 'inherit' })
console.log(`hands: built ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`)
