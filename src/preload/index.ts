import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EnsembleApi, HubEvent, ScreenFrame } from '@shared/types'

const call =
  (method: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke('ensemble', method, ...args) as Promise<never>

const METHODS = [
  'bootstrap',
  'updateSettings',
  'discoverAccounts',
  'addAccount',
  'updateAccount',
  'removeAccount',
  'refreshAccounts',
  'login',
  'submitLoginCode',
  'cancelLogin',
  'logout',
  'createChat',
  'createFolder',
  'updateFolder',
  'deleteFolder',
  'importScan',
  'importRun',
  'removeAgent',
  'learning',
  'browserSites',
  'connectors',
  'connectorsFound',
  'connectorSave',
  'connectorRemove',
  'connectorTest',
  'browserForget',
  'resetLearning',
  'openChat',
  'updateChat',
  'deleteChat',
  'searchChats',
  'setChatLead',
  'resumeChat',
  'dismissRecovery',
  'exportChat',
  'folderChanges',
  'fileDiff',
  'rewind',
  'listImages',
  'saveImage',
  'screenWatch',
  'screenInput',
  'screenGo',
  'screenOpen',
  'screenClose',
  'vaultList',
  'createVault',
  'vaultSearch',
  'vaultRead',
  'vaultOpen',
  'send',
  'stop',
  'respondPermission',
  'respondQuestion',
  'cancelTask',
  'saveMemory',
  'deleteMemory',
  'pickFolder',
  'pickFiles',
  'openPath',
  'showInFolder',
  'openExternal',
  'installUpdate',
] as const

const api: Record<string, unknown> = {}
for (const m of METHODS) api[m] = call(m)

api.onEvent = (cb: (ev: HubEvent) => void): (() => void) => {
  const listener = (_e: unknown, ev: HubEvent): void => cb(ev)
  ipcRenderer.on('hub', listener)
  return () => ipcRenderer.removeListener('hub', listener)
}

api.onFrame = (cb: (f: ScreenFrame) => void): (() => void) => {
  const listener = (_e: unknown, f: ScreenFrame): void => cb(f)
  ipcRenderer.on('frame', listener)
  return () => ipcRenderer.removeListener('frame', listener)
}

api.frameSeen = (key: string): void => ipcRenderer.send('frame-seen', key)

api.fileUrl = (p: string): string => `media://local/${encodeURIComponent(p)}`

// Dropped files only reveal their path through this call.
api.pathForFile = (f: File): string => {
  try {
    return webUtils.getPathForFile(f)
  } catch {
    return ''
  }
}

contextBridge.exposeInMainWorld('ensemble', api as unknown as EnsembleApi)
