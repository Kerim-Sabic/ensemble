// The checks of each piece of work, in the order they run after the main file's own.
// Do not edit this list to add checks: put them in your own file.
import type { Checks } from './ctx'
import integrity from './integrity'
import resources from './resources'
import routing from './routing'
import trace from './trace'
import remote from './remote'
import rooms from './rooms'
import platform from './platform'
import voice from './voice'
import modes from './modes'
import github from './github'
import goals from './goals'
import speed from './speed'
import load from './load'
import watches from './watches'
import guard from './guard'
import reach from './reach'
import recall from './recall'
import inboxui from './inboxui'

export const CHECKS: [string, Checks][] = [
  ['state integrity and the tool server', integrity],
  ['measured resources and team size', resources],
  ['model routing', routing],
  ['execution trace and evidence', trace],
  ['phone and remote access', remote],
  ['shared projects', rooms],
  ['platforms and distribution', platform],
  ['voice', voice],
  ['ways of working and first run', modes],
  ['GitHub workflows', github],
  ['goals that finish', goals],
  ['a responsive window', speed],
  ['a light engine', load],
  ['watches and the inbox', watches],
  ['safe unattended runs', guard],
  ['phone from anywhere', reach],
  ['memory with receipts', recall],
  ['watches and inbox in the window', inboxui],
]
