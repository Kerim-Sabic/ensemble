// Merges the macOS update feeds of the two Mac builds (arm64 on Apple silicon, x64 on Intel) into
// one latest-mac.yml, because a release can carry only one. electron-updater on a Mac picks the
// file for its own processor from the merged `files:` list.
//
//   node scripts/mac-feed.mjs <arm64 latest-mac.yml> <x64 latest-mac.yml> <out latest-mac.yml>
//
// Plain text, no YAML library: the feed electron-builder writes is a fixed, simple shape.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The lines of the `files:` list (each item and its indented fields). */
function filesBlock(lines) {
  const start = lines.findIndex((l) => /^files:\s*$/.test(l))
  if (start < 0) return { start: -1, end: -1, items: [] }
  let end = start + 1
  while (end < lines.length && /^\s/.test(lines[end])) end++
  return { start, end, items: lines.slice(start + 1, end) }
}

/** Splits list lines into items, one per "- url:" entry. */
function entries(items) {
  const out = []
  for (const line of items) {
    if (/^\s*-\s/.test(line) || !out.length) out.push([line])
    else out[out.length - 1].push(line)
  }
  return out
}

const urlOf = (entry) => /url:\s*(\S+)/.exec(entry.join('\n'))?.[1] || entry.join('\n')

/** Feed `a` with the files of feed `b` added to its list (no duplicates). The rest of `a` stays as it is. */
export function mergeMacFeeds(a, b) {
  const la = a.replace(/\r\n/g, '\n').split('\n')
  const lb = b.replace(/\r\n/g, '\n').split('\n')
  const fa = filesBlock(la)
  const fb = filesBlock(lb)
  if (fa.start < 0) throw new Error('The first feed has no files: list.')
  const have = new Set(entries(fa.items).map(urlOf))
  const add = entries(fb.items).filter((e) => !have.has(urlOf(e)))
  return [...la.slice(0, fa.end), ...add.flat(), ...la.slice(fa.end)].join('\n')
}

// Run only as `node scripts/mac-feed.mjs`, never when bundled into the checks (where import.meta.url is the bundle's).
const isMain = !!process.argv[1] && path.basename(process.argv[1]) === 'mac-feed.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [arm, x64, out] = process.argv.slice(2)
  if (!arm || !out) {
    console.error('Usage: node scripts/mac-feed.mjs <arm64 feed> <x64 feed> <out>')
    process.exit(1)
  }
  const a = fs.readFileSync(arm, 'utf8')
  const merged = x64 && fs.existsSync(x64) ? mergeMacFeeds(a, fs.readFileSync(x64, 'utf8')) : a
  fs.writeFileSync(out, merged)
  console.log(`Wrote ${out}`)
}
