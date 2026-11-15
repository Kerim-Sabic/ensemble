// Renders the app icon (build/icon.png, build/icon.ico) from the artwork below.
//   node_modules\electron\dist\electron.exe scripts/make-icon.mjs [--sizes=<folder>]
// With --sizes it also saves each size as its own picture, for checking by eye.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'build')
fs.mkdirSync(out, { recursive: true })

// Three lights, one per teammate, that add up to white where they meet: several
// accounts, one team. They sit on a deep indigo tile so the icon holds its own
// on a dark taskbar and on a light desktop alike.
//
// `small` is the drawing used for taskbar sizes: the tile runs to the edge and
// the lights are larger and crisper, because at 16 to 32 pixels a soft glow is
// only blur.
const svg = (size, small = false) => {
  const t = small ? { x: 20, r: 232 } : { x: 64, r: 206 }
  const side = 1024 - 2 * t.x
  const tile = `x="${t.x}" y="${t.x}" width="${side}" height="${side}" rx="${t.r}"`
  const R = small ? 262 : 224
  const top = small ? [512, 392] : [512, 404]
  const left = small ? [364, 648] : [380, 634]
  const right = small ? [660, 648] : [644, 634]
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="plate" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#40309A"/><stop offset="0.5" stop-color="#201852"/><stop offset="1" stop-color="#0C0922"/></linearGradient>
    <radialGradient id="sheen" cx="50%" cy="0%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity="0.2"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.4"/><stop offset="0.4" stop-color="#fff" stop-opacity="0.04"/><stop offset="1" stop-color="#fff" stop-opacity="0.14"/></linearGradient>
    <radialGradient id="a" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#FFCDAB"/><stop offset="0.68" stop-color="#FF7240"/><stop offset="1" stop-color="#EE4E1C"/></radialGradient>
    <radialGradient id="b" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#D2C4FF"/><stop offset="0.68" stop-color="#7E5EFF"/><stop offset="1" stop-color="#5836EE"/></radialGradient>
    <radialGradient id="c" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#B0FFF1"/><stop offset="0.68" stop-color="#1BCBB8"/><stop offset="1" stop-color="#0AA394"/></radialGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="56"/></filter>
    <filter id="core" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="${small ? 22 : 30}"/></filter>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="126%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.34"/></filter>
    <clipPath id="clip"><rect ${tile}/></clipPath>
  </defs>
  <rect ${tile} fill="url(#plate)" ${small ? '' : 'filter="url(#shadow)"'}/>
  <g clip-path="url(#clip)">
    <rect ${tile} fill="url(#sheen)"/>
    ${
      small
        ? ''
        : `<g opacity="0.72">
      <circle cx="${top[0]}" cy="${top[1]}" r="252" fill="#FF7240" filter="url(#glow)"/>
      <circle cx="${left[0]}" cy="${left[1]}" r="252" fill="#7E5EFF" filter="url(#glow)"/>
      <circle cx="${right[0]}" cy="${right[1]}" r="252" fill="#1BCBB8" filter="url(#glow)"/>
    </g>`
    }
    <g style="isolation:isolate">
      <circle cx="${top[0]}" cy="${top[1]}" r="${R}" fill="url(#a)" style="mix-blend-mode:screen"/>
      <circle cx="${left[0]}" cy="${left[1]}" r="${R}" fill="url(#b)" style="mix-blend-mode:screen"/>
      <circle cx="${right[0]}" cy="${right[1]}" r="${R}" fill="url(#c)" style="mix-blend-mode:screen"/>
    </g>
    <circle cx="512" cy="${small ? 562 : 557}" r="${small ? 84 : 74}" fill="#fff" opacity="0.9" filter="url(#core)"/>
  </g>
  <rect x="${t.x + 2}" y="${t.x + 2}" width="${side - 4}" height="${side - 4}" rx="${t.r - 2}" fill="none" stroke="url(#rim)" stroke-width="${small ? 10 : 4}"/>
</svg>`
}

async function capture(html, width, height) {
  const win = new BrowserWindow({ width, height, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } })
  const page = path.join(out, `.icon-${Date.now()}.html`)
  fs.writeFileSync(page, html)
  await win.loadFile(page)
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage()
  win.destroy()
  fs.rmSync(page, { force: true })
  return img
}

function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach(({ size, png }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2)
    dir.writeUInt8(0, e + 3)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(png.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  try {
    // Both versions are drawn once, large and side by side in a single picture (a second
    // capture in the same run is unreliable), then cut apart and scaled down for each size.
    const ids = (art, p) => art.replace(/id="(\w+)"/g, `id="${p}$1"`).replace(/url\(#(\w+)\)/g, `url(#${p}$1)`)
    // Each drawing is exactly half the window wide and as tall as it is wide, whatever size the window ends up.
    const cell = (art) => `<div style="width:50vw;height:50vw;flex:none">${art.replace(/ width="\d+" height="\d+"/, ' width="100%" height="100%"')}</div>`
    const both = await capture(`<html><body style="margin:0;background:transparent;overflow:hidden;display:flex;align-items:flex-start">${cell(ids(svg(1024), 'm'))}${cell(ids(svg(1024, true), 's'))}</body></html>`, 1600, 800)
    const side = Math.floor(both.getSize().width / 2)
    const cut = (i) => both.crop({ x: i * side, y: 0, width: side, height: side })
    const master = cut(0)
    const compact = cut(1)
    const at = (size) => (size <= 32 ? compact : master).resize({ width: size, height: size, quality: 'best' }).toPNG()
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    const images = sizes.map((size) => ({ size, png: at(size) }))
    fs.writeFileSync(path.join(out, 'icon.ico'), ico(images))
    fs.writeFileSync(path.join(out, 'icon.png'), master.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
    console.log('icon written', sizes.join(','), 'master', JSON.stringify(master.getSize()))

    const dir = process.argv.find((a) => a.startsWith('--sizes='))?.slice('--sizes='.length)
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
      for (const i of images) fs.writeFileSync(path.join(dir, `${i.size}.png`), i.png)
      // Small sizes again, enlarged without smoothing, so the pixels can be judged.
      for (const s of [16, 24, 32]) fs.writeFileSync(path.join(dir, `${s}-x8.png`), compact.resize({ width: s, height: s, quality: 'best' }).resize({ width: s * 8, height: s * 8, quality: 'good' }).toPNG())
      console.log('sizes written')
    }
  } catch (e) {
    console.log('icon Error', e.message)
  }
  app.quit()
})
