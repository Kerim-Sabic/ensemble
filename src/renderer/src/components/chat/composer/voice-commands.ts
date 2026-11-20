// Reading what was said into the message box: dictation, and a handful of spoken commands.
// Pure functions, no DOM, so scripts/checks/voice.ts can check them with many examples.
//
// A command is recognised only as the whole of what was said ("Stop.") or, for the two that
// finish a message ("send it", "make this a goal"), as its own last sentence after a full
// stop, comma or similar ("Fix the login bug. Send it."). Anything else is dictation, so an
// ordinary sentence that merely contains one of the words ("stop the server", "write the email
// and send it", "what should I send?") is never taken as a command.

export type VoiceCommand = 'send' | 'stop' | 'new-chat' | 'ultra-on' | 'ultra-off' | 'goal'

export interface Heard {
  /** The words to put in the message box (may be empty). */
  text: string
  /** A command to carry out after the words are in the box. */
  command: VoiceCommand | null
}

/** What each command answers to, after fillers like "okay" and "please" are taken off. */
const PHRASES: Record<VoiceCommand, string[]> = {
  send: ['send', 'send it', 'send that', 'send this', 'send message', 'send the message', 'send it now'],
  stop: ['stop', 'stop it', 'stop now', 'stop that'],
  'new-chat': ['new chat', 'start a new chat', 'open a new chat', 'start new chat', 'new conversation'],
  'ultra-on': ['ultra on', 'turn ultra on', 'turn on ultra', 'ultra mode on', 'turn on ultra mode', 'turn ultra mode on', 'switch ultra on', 'switch on ultra'],
  'ultra-off': ['ultra off', 'turn ultra off', 'turn off ultra', 'ultra mode off', 'turn off ultra mode', 'turn ultra mode off', 'switch ultra off', 'switch off ultra'],
  goal: ['make this a goal', 'make it a goal', 'make that a goal', 'set this as a goal', 'set it as a goal', 'make this the goal'],
}

/** Commands that may close a longer message as its own last sentence. The rest must be said alone. */
const AT_END: VoiceCommand[] = ['send', 'goal']

const LOOKUP = new Map<string, VoiceCommand>()
for (const [cmd, list] of Object.entries(PHRASES) as [VoiceCommand, string[]][]) for (const p of list) LOOKUP.set(p, cmd)

// Courtesy words around a command that do not change it.
const BEFORE = /^(?:(?:ok|okay|alright|all right|please|now|yes|right)\s+)+/
const AFTER = /(?:\s+(?:please|now|thanks|thank you))+$/

/** A clause as compared with the phrases: lower case, no punctuation, single spaces, fillers off. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(BEFORE, '')
    .replace(AFTER, '')
    .trim()
}

const commandOf = (clause: string): VoiceCommand | null => LOOKUP.get(norm(clause)) ?? null

/**
 * Tidies what the speech model gave back: markers it writes for silence or noise
 * ("[BLANK_AUDIO]", "(music)") are dropped, and spacing is made single.
 */
export function tidySpeech(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\((?:music|silence|noise|applause|laughs?|inaudible|blank_audio)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Words after which a closing "send it" belongs to the sentence ("…and send it"), not to the app. */
const JOINED = /\b(?:and|then|or|to|but|so|you|we|i|they|will|would|should|could|can|must|not|also|just)$/i

/**
 * Reads what was said: dictation, a command, or dictation that ends with a command.
 * `pause`: the recording ends with a short stretch of speech after a clear pause, which marks the
 * last words off as their own sentence even when the speech model wrote no punctuation.
 */
export function readSpoken(raw: string, commands = true, opts: { pause?: boolean } = {}): Heard {
  const text = tidySpeech(raw)
  if (!text) return { text: '', command: null }
  if (!commands) return { text, command: null }
  // The whole of what was said is a command.
  const whole = commandOf(text)
  if (whole && !/\?\s*$/.test(text)) return { text: '', command: whole }
  // No punctuation, but a pause before the last words: those words alone may close the message.
  if (opts.pause && !/\?\s*$/.test(text)) {
    for (const cmd of AT_END) {
      for (const phrase of PHRASES[cmd]) {
        const m = new RegExp(`^([\\s\\S]*?)[\\s,;:.!]+(?:(?:ok|okay|please|now)[\\s,]+)?${phrase.replace(/ /g, '[\\s,]+')}[\\s.!]*$`, 'i').exec(text)
        const before = m?.[1].trim()
        if (before && !JOINED.test(before.replace(/[.,;:!]+$/, ''))) return { text: before, command: cmd }
      }
    }
  }
  // The last sentence on its own is a command that can close a message. It has to be set off
  // by punctuation (the model writes that for a pause), and a question never counts.
  const m = /^([\s\S]*?[.!,;:])\s+([^.!?,;:]+)[.!]?\s*$/.exec(text)
  if (m) {
    const cmd = commandOf(m[2])
    if (cmd && AT_END.includes(cmd)) {
      // "…to Save. Okay, send it.": the filler before the command goes with it.
      const before = m[1]
        .replace(/[,;:]\s*$/, '')
        .replace(/\s*\b(?:ok|okay|alright|all right|please|now|right)$/i, '')
        .trim()
      if (before) return { text: before, command: cmd }
    }
  }
  return { text, command: null }
}

/**
 * Whether a recording (16 kHz mono) ends with a short stretch of speech set off by a clear pause:
 * "Fix the login bug … send it". Measured on 20 ms frames against the recording's own quietest
 * level, so a loud or quiet microphone reads the same.
 */
export function pauseBeforeEnd(audio: Float32Array, rate = 16000): boolean {
  const frame = Math.round(rate * 0.02)
  const levels: number[] = []
  for (let i = 0; i + frame <= audio.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += audio[j] * audio[j]
    levels.push(Math.sqrt(sum / frame))
  }
  if (levels.length < 20) return false
  const sorted = [...levels].sort((a, b) => a - b)
  const floor = Math.max(sorted[Math.floor(sorted.length * 0.1)], 0.002)
  const loud = sorted[Math.floor(sorted.length * 0.95)]
  const bar = Math.max(floor * 3, loud * 0.12, 0.01)
  const speech = levels.map((l) => l > bar)
  let last = speech.lastIndexOf(true)
  if (last < 0) return false
  // Walk back over the last stretch of speech (short gaps inside a word or two do not end it).
  let start = last
  let gap = 0
  for (let i = last; i >= 0; i--) {
    if (speech[i]) {
      start = i
      gap = 0
    } else if (++gap >= 22) break
  }
  const tail = (last - start + 1) * 0.02
  const before = speech.slice(0, Math.max(0, start - 22)).some(Boolean)
  return gap >= 22 && before && tail <= 1.8
}

/** Puts dictated words after what is already in the box. */
export function joinDictation(prev: string, next: string): string {
  const add = next.trim()
  if (!add) return prev
  if (!prev.trim()) return add
  if (/\n\s*$/.test(prev)) return prev.replace(/[ \t]+$/, '') + add
  return `${prev.replace(/\s+$/, '')} ${add}`
}

/** Plain words for each command, for the line that says what was done. */
export const COMMAND_WORDS: Record<VoiceCommand, string> = {
  send: 'Sent',
  stop: 'Stopped',
  'new-chat': 'New chat',
  'ultra-on': 'Ultra on',
  'ultra-off': 'Ultra off',
  goal: 'Made it a goal',
}

/** The languages the speech model is offered in, by the name the model takes. */
export const VOICE_LANGUAGES: { id: string; label: string }[] = [
  { id: 'english', label: 'English' },
  { id: 'bosnian', label: 'Bosnian' },
  { id: 'croatian', label: 'Croatian' },
  { id: 'serbian', label: 'Serbian' },
  { id: 'german', label: 'German' },
]
