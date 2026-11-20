import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerSaveBlocker, protocol, safeStorage, screen, session, shell, Tray } from 'electron'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Attachment, HubEvent, RemoteReachPatch, ScreenInput, Settings } from '@shared/types'
import { IMAGE_EXT, MEDIA_EXT } from '@shared/tools'
import electronUpdater from 'electron-updater'
import { Hub } from './hub'
import { debounce, exists, readJson, writeJson } from './util'
import { electronBrowsers } from './hands/browser'
import { findHands, WindowsDesktop } from './hands/desktop'
import { DemoDesktop } from './hands/demo-desktop'
import { hudHtml, ScreenHud } from './hands/hud'
import { guardFrames, IUI_PRIVILEGES, registerIui } from './iui'
import { Github } from './github'
import { firstFolders, folderProbe, makeAppFolder } from './firstrun'
import { guiPath, here, iconFile, loginShellPath, windowChrome } from './platform'
import { checkDownloaded, updatePolicy } from './updatesig'
import { MAC_SELF_UPDATE, UPDATE_PUBLIC_KEY } from './release-key'

// `__dirname` is supplied by the bundler for the ESM build.

// "Try the demo team": the installed app restarted with --demo. A scripted team, a clean temp folder,
// and a bar that says so. ENSEMBLE_DEMO=1 is the same team for development and screenshot runs.
const TRIAL = process.argv.includes('--demo') || process.env.ENSEMBLE_DEMO_BAR === '1'
const DEMO = process.env.ENSEMBLE_DEMO === '1' || TRIAL
/** From GitHub reads only; in the demo it answers from fixtures. */
const github = new Github(DEMO)
const isDev = !app.isPackaged

// Windows 11 22H2 and later can draw the Mica material behind the window.
const build = Number(os.release().split('.')[2] || 0)
const MICA = process.platform === 'win32' && build >= 22621 && process.env.ENSEMBLE_NO_MICA !== '1'

// A test or demo run is its own world, kept apart from the installed app in every way that matters.
const TESTING = !!process.env.ENSEMBLE_DATA || DEMO

app.setName('Ensemble')
// Windows re-points Start Menu and taskbar shortcuts at whichever program last ran under an
// identity, so a test copy must not borrow the real one.
if (process.platform === 'win32') app.setAppUserModelId(TESTING ? 'app.ensemble.test' : 'app.ensemble.desktop')
// A Mac app opened from Finder or the Dock starts with a bare PATH: give it (and every agent it
// starts) the login shell's PATH plus the usual tool folders. Windows is left as it is.
if (process.platform === 'darwin') process.env.PATH = guiPath(here(), loginShellPath())

const dataDir =
  process.env.ENSEMBLE_DATA || (process.argv.includes('--demo') ? path.join(os.tmpdir(), 'ensemble-try-demo') : DEMO ? path.join(os.tmpdir(), 'ensemble-demo') : path.join(app.getPath('userData'), 'data'))
// Every demo started from the app begins clean. Only ever a folder in temp, never the real data.
if (process.argv.includes('--demo') && !process.env.ENSEMBLE_DATA && dataDir.startsWith(os.tmpdir())) fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
// A test or demo run keeps its own browser profile and never answers for the real app.
if (TESTING) app.setPath('userData', path.join(dataDir, 'profile'))
// Test runs can stay off the screen entirely: the window is drawn but never shown.
const HIDDEN = process.env.ENSEMBLE_HIDDEN === '1'

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }, IUI_PRIVILEGES])

// Voice checks without a person: a scripted test run can hear a recording as if it were the
// microphone (ENSEMBLE_FAKE_MIC names a WAV). Never in normal use.
if (process.env.ENSEMBLE_SCRIPT && process.env.ENSEMBLE_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${process.env.ENSEMBLE_FAKE_MIC}%noloop`)
}

// What went wrong, written where it can be read afterwards. Kept small.
const logFile = path.join(dataDir, 'ensemble.log')
function note(kind: string, detail: unknown): void {
  const text = detail instanceof Error ? detail.stack || detail.message : typeof detail === 'string' ? detail : JSON.stringify(detail)
  console.error(`[${kind}]`, text)
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, `${logFile}.old`)
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${kind} ${text.slice(0, 4000)}\n`)
  } catch {
    /* a log that cannot be written is not worth failing over */
  }
}

// An error nobody caught is written down and survived. The team's work lives in this
// process: stopping it over one bad moment would stop everyone.
process.on('uncaughtException', (e) => note('uncaught', e))
process.on('unhandledRejection', (e) => note('unhandled', e))

let win: BrowserWindow | null = null
let hub: Hub
/** Keeps Windows from suspending the app while anyone is in the middle of work. */
let awake: number | null = null
let tray: Tray | null = null
let quitting = false

const HOTKEY = 'Alt+Shift+Space'
// Windows picks the right drawing for each size out of the .ico; a single large picture scaled down is mush at 16 pixels.
const ICON = path.join(__dirname, '../../build', iconFile(process.platform))

// Pictures of screens that were sent to the window and not yet drawn, and screens with a newer one waiting.
const unseen = new Map<string, number>()
const skipped = new Set<string>()

// Which agents are mid-turn, so the taskbar button can show the team is working.
const working = new Set<string>()

const send = (ev: HubEvent): void => {
  if (ev.type === 'agent') {
    const key = `${ev.state.chatId}:${ev.state.accountId}`
    const before = working.size
    if (ev.state.phase === 'idle' || ev.state.phase === 'error') working.delete(key)
    else working.add(key)
    if ((before === 0) !== (working.size === 0)) showActivity()
  }
  if (win && !win.isDestroyed()) win.webContents.send('hub', ev)
}

function showActivity(): void {
  if (working.size && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension')
  else if (!working.size && awake !== null) {
    powerSaveBlocker.stop(awake)
    awake = null
  }
  if (!win || win.isDestroyed()) return
  // An indeterminate bar on the taskbar button while anyone is working.
  win.setProgressBar(working.size ? 2 : -1, { mode: working.size ? 'indeterminate' : 'none' })
  tray?.setToolTip(working.size ? `Ensemble · ${working.size} working` : 'Ensemble')
}

function reveal(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Tray icon, summon shortcut and start-up entry follow the settings. */
function applyDesktop(s: Settings): void {
  if (process.env.ENSEMBLE_SCRIPT) return
  if (s.keepRunning && !tray) {
    try {
      tray = new Tray(process.platform === 'win32' ? ICON : nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' }))
      tray.setToolTip('Ensemble')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open Ensemble', click: reveal },
          {
            label: 'New chat',
            click: () => {
              reveal()
              send({ type: 'summon', fresh: true })
            },
          },
          { type: 'separator' },
          {
            label: 'Quit Ensemble',
            click: () => {
              quitting = true
              app.quit()
            },
          },
        ]),
      )
      tray.on('click', reveal)
    } catch {
      tray = null
    }
  } else if (!s.keepRunning && tray) {
    tray.destroy()
    tray = null
  }

  // Only our own summon key: an agent in control of the computer may be holding Esc.
  globalShortcut.unregister(HOTKEY)
  // A test or demo run never takes the summon key or the start-up entry from the installed app.
  if (s.globalHotkey && !TESTING) {
    try {
      globalShortcut.register(HOTKEY, () => {
        if (win && win.isVisible() && win.isFocused()) win.minimize()
        else {
          reveal()
          send({ type: 'summon' })
        }
      })
    } catch {
      /* another app owns the shortcut */
    }
  }

  if (app.isPackaged && !TESTING) {
    try {
      app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: s.launchAtLogin ? ['--hidden'] : [] })
    } catch {
      /* not supported here */
    }
  }
}

function symbolColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#ECEBE8' : '#1A1917'
}

function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
}

interface Bounds {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

function createWindow(): void {
  const boundsFile = path.join(dataDir, 'window.json')
  const saved = readJson<Bounds>(boundsFile, { width: 1380, height: 880 })
  const dark = nativeTheme.shouldUseDarkColors

  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 960,
    minHeight: 620,
    show: false,
    skipTaskbar: HIDDEN,
    title: 'Ensemble',
    icon: ICON,
    // Windows: our own title bar with Windows' buttons drawn over it (and Mica); macOS: the standard frame.
    ...windowChrome(process.platform, MICA, symbolColor()),
    backgroundColor: MICA ? '#00000000' : dark ? '#151514' : '#F2F1EE',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      offscreen: HIDDEN,
    },
  })
  if (saved.maximized && !HIDDEN) win.maximize()
  guardFrames(win.webContents)

  const remember = debounce(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    const maximized = win.isMaximized()
    const b = maximized ? readJson<Bounds>(boundsFile, saved) : win.getBounds()
    writeJson(boundsFile, { ...b, maximized })
  }, 500)
  win.on('resize', remember)
  win.on('move', remember)
  win.on('close', (e) => {
    remember.flush()
    // With "keep running" on, closing the window leaves the team working in the tray.
    if (!quitting && tray && hub?.settings.keepRunning) {
      e.preventDefault()
      win?.hide()
    }
  })

  // The page is only the view: the team runs in this process. If the page dies or stops
  // answering, it is loaded again and picks up where things are. Not in a loop, though.
  const reloads: number[] = []
  const reload = (why: string): void => {
    const now = Date.now()
    while (reloads.length && now - reloads[0] > 10 * 60 * 1000) reloads.shift()
    note('window', `${why}; reloading (${reloads.length + 1})`)
    if (reloads.length >= 4 || !win || win.isDestroyed()) return
    reloads.push(now)
    setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), 400)
  }
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') reload(`the page stopped (${d.reason})`)
  })
  let hung: NodeJS.Timeout | null = null
  win.on('unresponsive', () => {
    if (hung) return
    // Give it a while to come back by itself before giving up on it.
    hung = setTimeout(() => {
      hung = null
      if (!win || win.isDestroyed()) return
      try {
        win.webContents.forcefullyCrashRenderer()
      } catch {
        reload('the page stopped answering')
      }
    }, 25000)
  })
  win.on('responsive', () => {
    if (hung) clearTimeout(hung)
    hung = null
  })

  // Agents' browsers are windows too, hidden ones. When ours is gone for good, so are they.
  win.on('closed', () => {
    win = null
    void hub?.dispose().finally(() => app.quit())
  })

  const startHidden = process.argv.includes('--hidden') && !!hub?.settings.keepRunning
  win.once('ready-to-show', () => {
    if (!startHidden && !HIDDEN) win?.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  if (process.env.ENSEMBLE_SCRIPT) {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log('[script]', `page ${e.level}:`, e.message.slice(0, 600))
    })
    win.webContents.on('render-process-gone', (_e, d) => console.log('[script]', 'renderer gone:', d.reason))
    void runScript(win, process.env.ENSEMBLE_SCRIPT)
  }
}

/**
 * Development aid: plays a list of steps against the window (run some script in
 * the page, wait, save a screenshot) so the interface can be checked unattended.
 */
async function runScript(w: BrowserWindow, file: string): Promise<void> {
  const steps = readJson<{ js?: string; wait?: number; shot?: string; screen?: string; hud?: string; size?: [number, number]; theme?: Settings['theme'] }[]>(file, [])
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()))
  const outDir = path.dirname(file)
  for (const s of steps) {
    try {
      if (s.size) w.setContentSize(s.size[0], s.size[1])
      if (s.theme) applyTheme(s.theme)
      if (s.js) {
        const r = await w.webContents.executeJavaScript(`(async () => { ${s.js} })()`, true)
        if (r !== undefined) console.log('[script]', typeof r === 'string' ? r : JSON.stringify(r))
      }
      if (s.wait) await new Promise((r) => setTimeout(r, s.wait))
      if (s.shot) {
        const img = await w.webContents.capturePage()
        fs.writeFileSync(path.join(outDir, s.shot), img.toPNG())
        console.log('[shot]', s.shot)
      }
      if (s.hud) {
        // The notice shown over the display during computer control, drawn off-screen for a look.
        const h = new BrowserWindow({ show: false, width: 1280, height: 720, transparent: true, frame: false, webPreferences: { offscreen: true, sandbox: true } })
        await h.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hudHtml('Claude 3', 'violet').replace('<body>', '<body style="background:linear-gradient(135deg,#31486b,#6b7f96)">'))}`)
        await h.webContents.executeJavaScript('say("Clicking Save")')
        await new Promise((r) => setTimeout(r, 500))
        fs.writeFileSync(path.join(outDir, s.hud), (await h.webContents.capturePage()).toPNG())
        h.destroy()
        console.log('[shot]', s.hud)
      }
      if (s.screen && !HIDDEN && process.platform === 'win32') {
        // A real grab of the screen, so window materials and the title bar show up too (PowerShell: Windows only).
        const b = w.getBounds()
        const k = screen.getDisplayMatching(b).scaleFactor
        const out = path.join(outDir, s.screen)
        const ps = `Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(${Math.round(b.width * k)}, ${Math.round(b.height * k)}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${Math.round(b.x * k)}, ${Math.round(b.y * k)}, 0, 0, $bmp.Size); $bmp.Save('${out.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`
        w.show()
        w.focus()
        w.moveTop()
        await new Promise((r) => setTimeout(r, 350))
        spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true })
        console.log('[shot]', s.screen)
      }
    } catch (e) {
      console.log('[script error]', (e as Error).message)
    }
  }
  if (process.env.ENSEMBLE_SCRIPT_EXIT !== '0') app.quit()
}

/**
 * Restarts the app into the demo team (on) or back into the real app (off). The demo is the same
 * program started with --demo: its own temp folder, no update checks, no summon key, no start-up entry,
 * and it never holds the single-instance lock, so it cannot wake or block the real app.
 */
function switchDemo(on: boolean): void {
  const args = process.argv.slice(1).filter((a) => a !== '--demo' && a !== '--hidden')
  app.relaunch({ args: on ? [...args, '--demo'] : args })
  quitting = true
  // Everything under way is stopped and on disk first; then exit rather than quit, so nothing
  // (a tray that keeps running, a close that hides, an update waiting to install) delays the restart.
  const done = (): void => app.exit(0)
  setTimeout(done, 4000)
  void (hub ? hub.dispose() : Promise.resolve()).catch(() => undefined).finally(done)
}

function registerIpc(): void {
  const handlers: Record<string, (...args: never[]) => unknown> = {
    bootstrap: () => hub.bootstrap(),
    switchDemo: (on: boolean) => switchDemo(!!on),
    updateSettings: (patch: Partial<Settings>) => {
      if (patch.theme) applyTheme(patch.theme)
      const next = hub.updateSettings(patch)
      if (patch.keepRunning !== undefined || patch.globalHotkey !== undefined || patch.launchAtLogin !== undefined) applyDesktop(next)
      return next
    },

    discoverAccounts: () => hub.accounts.discover(),
    setupStatus: () => hub.setupStatus(),
    installClaude: () => hub.installClaude(),
    addAccount: (input: Parameters<typeof hub.accounts.add>[0]) => hub.accounts.add(input),
    updateAccount: (id: string, patch: Parameters<typeof hub.updateAccount>[1]) => hub.updateAccount(id, patch),
    removeAccount: (id: string) => hub.removeAccount(id),
    refreshAccounts: (id?: string) => hub.accounts.refresh(id),
    login: (id: string) => hub.accounts.login(id),
    submitLoginCode: (id: string, code: string) => hub.accounts.submitLoginCode(id, code),
    cancelLogin: (id: string) => hub.accounts.cancelLogin(id),
    logout: (id: string) => hub.accounts.logout(id),

    createChat: (input: { cwd?: string | null; title?: string; folderId?: string | null }) => hub.createChat(input || {}),
    createFolder: (name: string) => hub.createFolder(String(name || '')),
    updateFolder: (id: string, patch: Parameters<typeof hub.updateFolder>[1]) => hub.updateFolder(id, patch || {}),
    deleteFolder: (id: string) => hub.deleteFolder(id),
    importScan: () => hub.importScan(),
    importRun: (ids: string[], mode?: 'continue' | 'summary') => hub.importRun(Array.isArray(ids) ? ids.map(String) : [], mode === 'summary' ? 'summary' : 'continue'),
    connectors: () => hub.connectorViews(),
    connectorsFound: () => hub.connectorsFound(),
    connectorSave: (input: Parameters<typeof hub.connectorSave>[0]) => hub.connectorSave(input),
    connectorRemove: (id: string) => hub.connectorRemove(String(id)),
    connectorTest: (id: string) => hub.connectors.test(String(id)),
    connectorSignIn: (id: string) => hub.connectorSignIn(String(id)),
    connectorCancelSignIn: () => hub.connectors.cancelSignIn(),
    connectorSignOut: (id: string) => hub.connectorSignOut(String(id)),
    browserSites: async () => {
      const ses = session.fromPartition('persist:ensemble-browser')
      const count = new Map<string, number>()
      for (const c of await ses.cookies.get({})) {
        const site = (c.domain || '').replace(/^\./, '').replace(/^www\./, '')
        if (site) count.set(site, (count.get(site) || 0) + 1)
      }
      return [...count].map(([site, cookies]) => ({ site, cookies })).sort((a, b) => a.site.localeCompare(b.site))
    },
    browserForget: async (site: string) => {
      const ses = session.fromPartition('persist:ensemble-browser')
      const s = String(site || '').toLowerCase()
      for (const c of await ses.cookies.get({})) {
        const d = (c.domain || '').replace(/^\./, '').replace(/^www\./, '').toLowerCase()
        if (d !== s) continue
        const url = `http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`
        await ses.cookies.remove(url, c.name).catch(() => undefined)
      }
    },
    learning: () => hub.learning.list(),
    resetLearning: () => hub.learning.reset(),
    removeAgent: (chatId: string, agentId: string) => hub.removeAgent(chatId, agentId).then(() => undefined),
    openChat: (id: string) => hub.openChat(id),
    updateChat: (id: string, patch: Parameters<typeof hub.updateChat>[1]) => hub.updateChat(id, patch),
    deleteChat: (id: string) => hub.deleteChat(id),
    searchChats: (q: string) => hub.search(q),
    setChatLead: (id: string, accountId: string, retry?: boolean) => hub.setChatLead(id, accountId, !!retry),
    dequeue: async (chatId: string, accountId: string, itemId: string) => hub.dequeue(String(chatId), String(accountId), String(itemId)),
    remoteInfo: async () => hub.remote.info(),
    remotePair: async () => hub.remote.pair(),
    remoteRemove: async (deviceId: string) => hub.remote.remove(String(deviceId)),
    remoteReach: async () => hub.remote.reach(),
    remoteReachSet: async (patch: RemoteReachPatch) => hub.remote.setReach(patch && typeof patch === 'object' ? patch : {}),
    remoteTailscaleCert: async () => hub.remote.tailscaleCert(),
    roomInfo: async (chatId: string) => hub.rooms.info(String(chatId)),
    roomShare: async (chatId: string, myName: string, projectName?: string) => hub.rooms.share(String(chatId), String(myName || ''), projectName ? String(projectName) : undefined),
    roomJoin: async (code: string, myName: string) => hub.rooms.join(String(code || ''), String(myName || '')),
    roomRemove: async (chatId: string, memberId: string) => hub.rooms.removeMember(String(chatId), String(memberId)),
    roomStop: async (chatId: string) => hub.rooms.stop(String(chatId)),
    roomLeave: async (chatId: string) => hub.rooms.leave(String(chatId)),
    roomNote: async (chatId: string, title: string, body: string) => hub.rooms.addNote(String(chatId), { title: String(title || ''), body: String(body || '') }),
    trace: (chatId: string, q?: Parameters<typeof hub.trace>[1]) => hub.trace(String(chatId), q),
    evidence: (chatId: string, ref: Parameters<typeof hub.evidence>[1]) => hub.evidence(String(chatId), ref),
    unattendedToday: () => hub.guard.today(),
    tracePath: async (chatId: string) => hub.tracePath(String(chatId)),
    steer: async (req: Parameters<typeof hub.steer>[0]) => hub.steer(req),
    resumeChat: (id: string) => hub.resumeChat(id).then(() => undefined),
    dismissRecovery: (id: string) => hub.dismissRecovery(id),
    folderChanges: (id: string) => hub.folderChanges(id),
    folderProbe: (dir: string | null) => folderProbe(dir),
    // Demo and test runs never write into the person's real Documents.
    firstFolders: () => firstFolders(os.homedir(), TESTING ? path.join(dataDir, 'Documents') : app.getPath('documents')),
    makeFirstFolder: async () => makeAppFolder(os.homedir(), TESTING ? path.join(dataDir, 'Documents') : app.getPath('documents')),
    fileDiff: (id: string, rel: string) => hub.fileDiff(id, rel),
    rewind: (chatId: string, accountId: string, turnId: string, apply: boolean) => hub.rewind(chatId, accountId, turnId, !!apply),
    listImages: () => hub.listImages(),

    screenWatch: (key: string, on: boolean, full?: boolean) => hub.screenWatch(String(key), !!on, !!full),
    screenInput: (chatId: string, accountId: string, input: ScreenInput) => hub.screenInput(chatId, accountId, input),
    screenGo: (chatId: string, accountId: string, to: string) => hub.screenGo(chatId, accountId, String(to)),
    screenOpen: (chatId: string, accountId: string, url?: string) => hub.screenOpen(chatId, accountId, url),
    screenClose: (chatId: string, accountId: string) => hub.screenClose(chatId, accountId),

    vaultList: () => hub.vaultList(),
    createVault: () => hub.createVault(),
    vaultSearch: (q: string) => hub.vaultSearch(String(q || '')),
    vaultRead: (ref: string) => hub.vaultRead(String(ref || '')),
    vaultOpen: async (ref: string) => {
      const file = hub.vaultPathOf(String(ref || ''))
      if (!file) return
      // Obsidian opens the note in place when it is installed; otherwise the file's own app does.
      try {
        await shell.openExternal(`obsidian://open?path=${encodeURIComponent(file)}`)
      } catch {
        await shell.openPath(file)
      }
    },
    saveImage: (bytes: ArrayBuffer, mime: string) => hub.saveImage(bytes, mime),
    exportChat: async (id: string): Promise<string | null> => {
      if (!win) return null
      const chat = hub.chats.get(id)
      if (!chat) return null
      const safe = chat.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'chat'
      const r = await dialog.showSaveDialog(win, {
        title: 'Save this chat',
        defaultPath: path.join(app.getPath('documents'), `${safe}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (r.canceled || !r.filePath) return null
      fs.writeFileSync(r.filePath, hub.chatMarkdown(id), 'utf8')
      return r.filePath
    },

    send: (req: Parameters<typeof hub.send>[0]) => hub.send(req),
    stop: (chatId: string, accountId?: string) => hub.stop(chatId, accountId),
    setGoal: (chatId: string, input: Parameters<typeof hub.setGoal>[1]) => hub.setGoal(chatId, input || null),
    goalAction: (chatId: string, action: Parameters<typeof hub.goalAction>[1]) => hub.goalAction(chatId, action),
    addLoop: (chatId: string, input: Parameters<typeof hub.addLoop>[1]) => hub.addLoop(chatId, input),
    updateLoop: (chatId: string, loopId: string, patch: Parameters<typeof hub.updateLoop>[2]) => hub.updateLoop(chatId, loopId, patch),
    removeLoop: (chatId: string, loopId: string) => hub.removeLoop(chatId, loopId),
    runLoop: (chatId: string, loopId: string) => hub.runLoop(chatId, loopId),
    enhance: (text: string, chatId?: string | null) => hub.enhance(String(text || ''), chatId || null),
    setUltra: (chatId: string, on: boolean) => hub.setUltra(chatId, !!on),
    githubList: (q: { cwd?: string | null; address?: string | null }) => github.list({ cwd: q?.cwd ? String(q.cwd) : null, address: q?.address ? String(q.address) : null }),
    // Watches and the inbox. The window speaks for the user: a watch saved here is the user's own.
    watches: () => hub.watches.list(),
    saveWatch: (input: Parameters<typeof hub.watches.saveWatch>[0]) => hub.watches.saveWatch(input, 'user'),
    removeWatch: (id: string) => hub.watches.remove(String(id)),
    runWatch: (id: string) => hub.watches.runNow(String(id)),
    inbox: () => hub.watches.inbox(),
    markInbox: (id: string, patch: { read?: boolean; done?: boolean }) => hub.watches.mark(String(id), { read: patch?.read, done: patch?.done }),
    githubItem: (q: { repo: string; kind: 'issue' | 'pull' | 'run'; number: number }) => github.item({ repo: String(q?.repo || ''), kind: q?.kind === 'pull' || q?.kind === 'run' ? q.kind : 'issue', number: Number(q?.number) }),
    respondPermission: (id: string, decision: Parameters<typeof hub.respondPermission>[1], note?: string) => hub.respondPermission(id, decision, note),
    respondQuestion: (id: string, answers: Record<string, string> | null) => hub.respondQuestion(id, answers),
    cancelTask: (chatId: string, id: string) => hub.cancelTask(chatId, id, true).then(() => undefined),

    saveMemory: (note: { id?: string; title: string; body: string; kind?: 'preference' | 'fact' | 'decision' | 'lesson'; scope?: string | null }) =>
      hub.memory.save({ id: note?.id, title: String(note?.title || ''), body: String(note?.body || ''), kind: note?.kind, scope: note?.scope ?? null, trust: 'user', source: { by: 'you', at: Date.now() } }, 'you'),
    deleteMemory: (id: string) => void hub.memory.delete(String(id)),
    forgetMemory: (id: string) => hub.forgetMemory(String(id)),
    undoMemory: (id: string) => hub.undoMemory(String(id)),
    decideMemory: (id: string, yes: boolean) => hub.decideMemory(String(id), !!yes),
    memoryCore: (chatId?: string | null) => hub.memoryCore(chatId ? String(chatId) : null),
    reviewMemory: (chatId: string) => hub.reviewMemory(String(chatId)),

    pickFolder: async () => {
      if (!win) return null
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' })
      return r.canceled ? null : r.filePaths[0]
    },
    pickFiles: async (): Promise<Attachment[]> => {
      if (!win) return []
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Attach files' })
      if (r.canceled) return []
      return r.filePaths.map((p) => ({ path: p, name: path.basename(p), kind: IMAGE_EXT.test(p) ? 'image' : 'file' }))
    },
    openPath: async (p: string) => {
      if (exists(p)) await shell.openPath(p)
    },
    showInFolder: (p: string) => {
      if (exists(p)) shell.showItemInFolder(p)
    },
    copyImage: async (p: string) => {
      const img = exists(p) ? nativeImage.createFromPath(p) : null
      if (!img || img.isEmpty()) throw new Error('That picture cannot be copied.')
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
    },
    installUpdate: () => {
      // Only an update that passed this build's checks (startUpdates) may be installed.
      if (!updateReady) {
        note('update', 'restart refused: no checked update is ready')
        return
      }
      quitting = true
      // The next start knows this restart was the app's own, and picks up the work it cuts.
      try {
        hub?.markUpdateRestart()
      } catch (e) {
        note('update', e)
      }
      // Silent, and Ensemble opens again on the new version.
      electronUpdater.autoUpdater.quitAndInstall(true, true)
    },
    openExternal: async (url: string) => {
      if (/^https?:\/\//.test(url)) await shell.openExternal(url)
    },
  }

  ipcMain.handle('ensemble', async (_e, method: string, ...args: unknown[]) => {
    const fn = handlers[method]
    if (!fn) throw new Error(`Unknown method ${method}`)
    return await fn(...(args as never[]))
  })
}

function mimeOfMedia(p: string): string {
  const ext = path.extname(p).toLowerCase().slice(1)
  const map: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg' }
  return map[ext] || 'application/octet-stream'
}

/**
 * Updates come from the project's GitHub releases. A new version is downloaded in the
 * background and installed the next time Ensemble closes, so it never restarts in the middle
 * of the team's work; the window offers a restart for whoever wants it sooner.
 */
let updateReady = false

function startUpdates(): void {
  if (!app.isPackaged || TESTING || DEMO || process.env.ENSEMBLE_NO_UPDATES === '1') return
  // With a project key built in (release-key.ts), an update installs only once its signature checks out.
  const policy = updatePolicy(process.platform, UPDATE_PUBLIC_KEY, MAC_SELF_UPDATE)
  note('update', policy.log)
  if (!policy.run) return
  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = !policy.verify
  // A newer download replaces the file an earlier check passed, in the same place. From the moment it
  // starts until it has passed its own check, nothing may install: not on quit, not on "restart to update".
  // Each download gets a number: a check that ends after a newer download began speaks for a file that is gone.
  let latest = 0
  const hold = (): void => {
    latest++
    if (!policy.verify) return
    updateReady = false
    autoUpdater.autoInstallOnAppQuit = false
  }
  autoUpdater.on('update-available', (info) => {
    hold()
    send({ type: 'update', state: 'downloading', version: info.version })
  })
  autoUpdater.on('update-downloaded', (info) => {
    hold()
    if (!policy.verify) {
      updateReady = true
      send({ type: 'update', state: 'ready', version: info.version })
      return
    }
    const mine = latest
    void checkDownloaded(UPDATE_PUBLIC_KEY, info).then((v) => {
      if (mine !== latest) return
      if (!v.ok) {
        updateReady = false
        note('update', `refused ${info.version}: ${v.why}`)
        return
      }
      updateReady = true
      autoUpdater.autoInstallOnAppQuit = true
      // electron-updater sets up its install-on-quit when the download ends, and skipped it while
      // that was off; set it up now that the file has been checked.
      ;(autoUpdater as unknown as { addQuitHandler?: () => void }).addQuitHandler?.()
      send({ type: 'update', state: 'ready', version: info.version })
    })
  })
  autoUpdater.on('error', (e) => note('update', e))
  const check = (): void => void autoUpdater.checkForUpdates().catch((e: unknown) => note('update', e))
  setTimeout(check, 20_000)
  setInterval(check, 4 * 3600e3)
}

function notify(title: string, body: string, target: { chatId: string; accountId?: string }): void {
  if (!Notification.isSupported() || HIDDEN) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    if (!win) return
    reveal()
    send({ type: 'focus-chat', chatId: target.chatId, accountId: target.accountId })
  })
  n.show()
  if (win && !win.isFocused()) win.flashFrame(true)
}

// A test or demo run is its own world: it must never wake the real app that may be open.
if (!(TESTING || app.requestSingleInstanceLock())) {
  app.quit()
} else {
  app.on('second-instance', () => reveal())
  ipcMain.on('frame-seen', (_e, key: string) => {
    unseen.delete(key)
    // A picture was held back while the last one was being drawn: send the current one now.
    if (skipped.delete(key)) hub?.hands.refresh(key)
  })

  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  const desktop = new WindowsDesktop(findHands([path.join(__dirname, '../../resources/hands.exe')]))

  void app.whenReady().then(async () => {
    // Local pictures, sound and video (what agents make, attachments) reach the page through
    // this scheme. It serves media files only. Sound and video are sent in pieces when asked,
    // which is what lets a player show its length and jump to any point.
    // Mini apps in answers: served from memory, locked down (see iui.ts).
    registerIui()
    // Voice: the window may use the microphone (sound only, never the camera), and nothing else may.
    // Other permissions are answered as Electron always did here.
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      if (permission !== 'media') return cb(true)
      // Only the app's own page asks: not a mini app's frame inside it, not a web page.
      const url = details.requestingUrl || ''
      const page = url.startsWith('file:') || (isDev && !!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
      const ours = !!win && !win.isDestroyed() && wc === win.webContents && details.isMainFrame && page
      const sound = (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio') ?? false
      cb(ours && sound)
    })
    protocol.handle('media', async (req) => {
      try {
        const u = new URL(req.url)
        const p = decodeURIComponent(u.pathname.replace(/^\//, ''))
        if (!MEDIA_EXT.test(p) || !path.isAbsolute(p)) return new Response('Not found', { status: 404 })
        if (IMAGE_EXT.test(p)) return net.fetch(pathToFileURL(p).toString())
        const size = (await fs.promises.stat(p)).size
        const type = mimeOfMedia(p)
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '')
        if (!range) {
          const body = Readable.toWeb(fs.createReadStream(p)) as unknown as ReadableStream<Uint8Array>
          return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
        }
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        const body = Readable.toWeb(fs.createReadStream(p, { start, end })) as unknown as ReadableStream<Uint8Array>
        return new Response(body, {
          status: 206,
          headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })

    hub = new Hub({
      dataDir,
      version: app.getVersion(),
      demo: DEMO,
      trial: TRIAL,
      mica: MICA,
      emit: send,
      notify,
      // Connector keys are encrypted with the Windows account's own key, so a copied data folder does not give them away.
      sealer: safeStorage.isEncryptionAvailable()
        ? { seal: (s: string) => `dpapi:${safeStorage.encryptString(s).toString('base64')}`, open: (s: string) => (s.startsWith('dpapi:') ? safeStorage.decryptString(Buffer.from(s.slice(6), 'base64')) : s.startsWith('plain:') ? s.slice(6) : s) }
        : undefined,
      isFocused: () => !!win && !win.isDestroyed() && win.isFocused(),
      hands: {
        browser: electronBrowsers,
        // A scripted demo never touches the real mouse, keyboard or screen: it gets a drawn one.
        desktop: DEMO ? new DemoDesktop() : desktop,
        control: DEMO ? undefined : new ScreenHud(() => win),
      },
      frame: (f) => {
        if (!win || win.isDestroyed()) return
        // A window that is busy must not be buried in pictures: the next one goes out when
        // the last was drawn, or after a moment if we never hear back.
        const sent = unseen.get(f.key)
        if (sent && Date.now() - sent < 1500) {
          skipped.add(f.key)
          return
        }
        unseen.set(f.key, Date.now())
        win.webContents.send('frame', f)
      },
    })
    applyTheme(hub.settings.theme)
    registerIpc()
    createWindow()
    applyDesktop(hub.settings)
    hub.connectors.opener = (url) => void shell.openExternal(url)
    await hub.start()
    startUpdates()

    nativeTheme.on('updated', () => {
      if (!win || win.isDestroyed()) return
      try {
        win.setTitleBarOverlay({ color: '#00000000', symbolColor: symbolColor(), height: 44 })
      } catch {
        /* overlay unsupported on this platform */
      }
      if (!MICA) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151514' : '#F2F1EE')
      send({ type: 'theme', dark: nativeTheme.shouldUseDarkColors })
    })
    win?.on('focus', () => win?.flashFrame(false))
  })

  app.on('window-all-closed', () => {
    tray?.destroy()
    tray = null
    void hub?.dispose().finally(() => app.quit())
  })
  // macOS: clicking the Dock icon brings back a window that "keep working" only hid. Never fires on Windows.
  app.on('activate', () => reveal())
}


