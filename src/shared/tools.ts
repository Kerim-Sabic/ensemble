// Turns a raw tool call into a short human sentence. Used by the main process
// (live status lines) and by the renderer (activity rows).

export type ToolIcon =
  | 'read'
  | 'edit'
  | 'write'
  | 'terminal'
  | 'search'
  | 'web'
  | 'agent'
  | 'todo'
  | 'team'
  | 'memory'
  | 'image'
  | 'plug'
  | 'skill'
  | 'note'
  | 'screen'
  | 'tool'

export interface ToolSummary {
  icon: ToolIcon
  /** Present tense while running: "Reading". */
  doing: string
  /** Past tense when finished: "Read". */
  done: string
  /** The object of the verb: a file name, a command, a query. */
  target: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return oneLine(url, 50)
  }
}

/** A note's name without its folder or extension. */
function noteName(p: string): string {
  return oneLine(baseName(p.replace(/^\[\[|\]\]$/g, '').split('|')[0]).replace(/\.md$/i, ''), 60)
}

export function describeTool(name: string, input: unknown): ToolSummary {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const file = str(i.file_path) || str(i.path) || str(i.notebook_path)

  switch (name) {
    case 'Read':
      return { icon: 'read', doing: 'Reading', done: 'Read', target: baseName(file) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { icon: 'edit', doing: 'Editing', done: 'Edited', target: baseName(file) }
    case 'Write':
      return { icon: 'write', doing: 'Writing', done: 'Wrote', target: baseName(file) }
    case 'Bash':
    case 'PowerShell':
    case 'Shell': {
      // Agents usually say what a command is for; that reads better than the command.
      const why = oneLine(str(i.description), 90)
      if (why) return { icon: 'terminal', doing: why, done: why, target: '' }
      return { icon: 'terminal', doing: 'Running', done: 'Ran', target: oneLine(str(i.command), 90) }
    }
    case 'BashOutput':
    case 'KillShell':
    case 'Monitor':
      return { icon: 'terminal', doing: 'Checking', done: 'Checked', target: 'background command' }
    case 'Glob':
      return { icon: 'search', doing: 'Finding', done: 'Found', target: oneLine(str(i.pattern), 60) }
    case 'Grep':
      return { icon: 'search', doing: 'Searching', done: 'Searched', target: oneLine(str(i.pattern), 60) }
    case 'WebSearch':
      return { icon: 'web', doing: 'Searching the web', done: 'Searched the web', target: oneLine(str(i.query), 70) }
    case 'WebFetch':
      return { icon: 'web', doing: 'Reading', done: 'Read', target: host(str(i.url)) }
    case 'Agent':
    case 'Task':
      return { icon: 'agent', doing: 'Running a helper', done: 'Ran a helper', target: oneLine(str(i.description), 70) }
    case 'TodoWrite':
    case 'Todo':
      return { icon: 'todo', doing: 'Updating the plan', done: 'Updated the plan', target: '' }
    case 'Skill':
      return { icon: 'skill', doing: 'Using skill', done: 'Used skill', target: str(i.skill) }
    case 'ToolSearch':
      return { icon: 'tool', doing: 'Looking up tools', done: 'Looked up tools', target: '' }
    case 'ExitPlanMode':
      return { icon: 'todo', doing: 'Presenting the plan', done: 'Presented the plan', target: '' }
    case 'FileChange':
      return { icon: 'edit', doing: 'Changing', done: 'Changed', target: oneLine(str(i.summary), 80) }
    case 'ImageGen':
      return { icon: 'image', doing: 'Creating an image', done: 'Created an image', target: '' }
  }

  if (name.startsWith('mcp__team__')) {
    const t = name.slice('mcp__team__'.length)
    switch (t) {
      case 'roster':
        return { icon: 'team', doing: 'Checking on the team', done: 'Checked on the team', target: '' }
      case 'assign_task':
        return { icon: 'team', doing: 'Handing off', done: 'Handed off', target: oneLine(str(i.title), 70) }
      case 'spawn_agent':
        return { icon: 'team', doing: 'Starting a new agent', done: 'Started a new agent', target: oneLine(str(i.name), 40) }
      case 'dismiss_agent':
        return { icon: 'team', doing: 'Sending an agent home', done: 'Sent an agent home', target: oneLine(str(i.name), 40) }
      case 'board_post':
        return { icon: 'note', doing: 'Posting to the team board', done: 'Posted to the team board', target: oneLine(str(i.title), 60) }
      case 'board_read':
        return { icon: 'note', doing: 'Reading the team board', done: 'Read the team board', target: '' }
      case 'message':
        return { icon: 'team', doing: 'Messaging', done: 'Messaged', target: str(i.to) }
      case 'ask':
        return { icon: 'team', doing: 'Asking', done: 'Asked', target: str(i.to) }
      case 'cancel_task':
        return { icon: 'team', doing: 'Cancelling a task', done: 'Cancelled a task', target: str(i.id) }
      case 'task_status':
        return { icon: 'team', doing: 'Checking tasks', done: 'Checked tasks', target: '' }
      case 'memory_save':
        return { icon: 'memory', doing: 'Remembering', done: 'Remembered', target: oneLine(str(i.title), 70) }
      case 'memory_search':
        return { icon: 'memory', doing: 'Recalling', done: 'Recalled', target: oneLine(str(i.query), 60) }
      case 'memory_delete':
        return { icon: 'memory', doing: 'Forgetting', done: 'Forgot', target: '' }
      case 'chat_history_search':
        return { icon: 'memory', doing: 'Searching past chats', done: 'Searched past chats', target: oneLine(str(i.query), 60) }
      case 'vault_search':
        return { icon: 'note', doing: 'Searching the vault', done: 'Searched the vault', target: oneLine(str(i.query), 60) }
      case 'vault_read':
        return { icon: 'note', doing: 'Reading note', done: 'Read note', target: noteName(str(i.note)) }
      case 'vault_save':
        return { icon: 'note', doing: i.mode === 'create' ? 'Writing note' : 'Adding to note', done: i.mode === 'create' ? 'Wrote note' : 'Added to note', target: noteName(str(i.path)) }
      case 'goal_report':
        return i.state === 'blocked'
          ? { icon: 'todo', doing: 'Saying the goal needs you', done: 'Said the goal needs you', target: '' }
          : i.state === 'met'
            ? { icon: 'todo', doing: 'Reporting the goal as met', done: 'Reported the goal as met', target: '' }
            : { icon: 'todo', doing: 'Reporting on the goal', done: 'Reported on the goal', target: '' }
      case 'goal_set':
        return { icon: 'todo', doing: 'Setting a goal', done: 'Set a goal', target: oneLine(str(i.goal), 70) }
      case 'loop_start':
        return { icon: 'todo', doing: 'Starting a loop', done: 'Started a loop', target: oneLine(str(i.prompt), 70) }
      case 'loop_update':
        return i.stop
          ? { icon: 'todo', doing: 'Ending the loop', done: 'Ended the loop', target: oneLine(str(i.reason), 70) }
          : i.next_in_minutes !== undefined
            ? { icon: 'todo', doing: 'Setting the next run', done: 'Set the next run', target: `in ${String(i.next_in_minutes)} min` }
            : { icon: 'todo', doing: 'Checking the loops', done: 'Checked the loops', target: '' }
      case 'notify_user':
        return { icon: 'note', doing: 'Letting you know', done: 'Let you know', target: oneLine(str(i.title), 60) }
      case 'browser':
        return { icon: 'screen', doing: 'Using the browser', done: 'Used the browser', target: '' }
      case 'computer':
        return { icon: 'screen', doing: 'Using the computer', done: 'Used the computer', target: '' }
    }
  }

  if (name.startsWith('mcp__')) {
    const [, server = '', tool = ''] = name.split('__')
    const pretty = tool.replace(/[_-]+/g, ' ')
    return { icon: 'plug', doing: 'Using', done: 'Used', target: `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')} · ${pretty}` }
  }

  return { icon: 'tool', doing: 'Using', done: 'Used', target: name }
}

export function toolLine(name: string, input: unknown, running = true): string {
  const s = describeTool(name, input)
  const verb = running ? s.doing : s.done
  return s.target ? `${verb} ${s.target}` : verb
}

/** Tool calls that get their own bespoke card instead of a generic row. */
export const HIDDEN_TEAM_TOOLS = new Set(['mcp__team__assign_task', 'mcp__team__spawn_agent', 'mcp__team__message', 'mcp__team__ask', 'AskUserQuestion'])

/** The browser and computer tools: each call becomes a step on a screen instead of a tool row. */
export const isHandsTool = (name: string): boolean => name === 'mcp__team__browser' || name === 'mcp__team__computer'

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
export const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i
export const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|mp4|webm|mov|m4v|ogv)$/i

export type MediaKind = 'image' | 'audio' | 'video'

export const mediaKind = (p: string): MediaKind | null => (IMAGE_EXT.test(p) ? 'image' : AUDIO_EXT.test(p) ? 'audio' : VIDEO_EXT.test(p) ? 'video' : null)

/** Full paths to pictures, sound and video mentioned in a piece of text, in order and without repeats. */
export function mediaPathsIn(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const re = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|mnt|Volumes)\/)[^\n\r"'`<>|*?]*?\.(?:png|jpe?g|gif|webp|bmp|svg|mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|mp4|webm|mov|m4v|ogv)(?![A-Za-z0-9])/gi
  for (const m of text.matchAll(re)) {
    const p = m[0].replace(/^[(\[]+/, '').trim()
    if (!out.includes(p)) out.push(p)
  }
  return out.slice(0, 24)
}
