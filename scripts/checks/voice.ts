// Voice (Canvas): reading what was said into the message box. A command counts only as the
// whole of what was said, or (send, goal) as its own last sentence; everything else is dictation.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Ctx } from './ctx'
import { VOICE_RUNTIME } from '../../src/renderer/src/components/chat/composer/voice-protocol'
import { joinDictation, pauseBeforeEnd, readSpoken, tidySpeech, VOICE_LANGUAGES } from '../../src/renderer/src/components/chat/composer/voice-commands'

export default async function (c: Ctx): Promise<void> {
  const cmd = (s: string, on = true): string | null => readSpoken(s, on).command
  const words = (s: string): string => readSpoken(s).text

  // The whole utterance is the command.
  c.same('alone: send', ['Send.', 'send it', 'Send it!', 'Okay, send it.', 'Please send.', 'Send the message.', ' SEND '].map((s) => cmd(s)), ['send', 'send', 'send', 'send', 'send', 'send', 'send'])
  c.same('alone: stop', ['Stop.', 'stop', 'Stop!', 'Stop it.', 'Stop now.', 'Okay stop.'].map((s) => cmd(s)), ['stop', 'stop', 'stop', 'stop', 'stop', 'stop'])
  c.same('alone: new chat', ['New chat.', 'Start a new chat.', 'Open a new chat please.'].map((s) => cmd(s)), ['new-chat', 'new-chat', 'new-chat'])
  c.same('alone: ultra on and off', ['Ultra on.', 'Turn ultra on.', 'Turn on Ultra mode.', 'Ultra off.', 'Turn off ultra.', 'Switch Ultra off please.'].map((s) => cmd(s)), ['ultra-on', 'ultra-on', 'ultra-on', 'ultra-off', 'ultra-off', 'ultra-off'])
  c.same('alone: make this a goal', ['Make this a goal.', 'make it a goal', 'Set this as a goal.'].map((s) => cmd(s)), ['goal', 'goal', 'goal'])
  c.check('a command said alone leaves nothing to type', words('Send it.') === '' && words('Ultra on.') === '')

  // A message that ends with its own "send it" or "make this a goal".
  const a = readSpoken('Fix the login bug on the pricing page. Send it.')
  c.same('at the end: dictation, then send', a, { text: 'Fix the login bug on the pricing page.', command: 'send' })
  c.same('at the end after a comma', readSpoken('Add dark mode to the settings, send it.'), { text: 'Add dark mode to the settings', command: 'send' })
  c.same('at the end: make this a goal', readSpoken('All tests pass and the build is green. Make this a goal.'), { text: 'All tests pass and the build is green.', command: 'goal' })
  c.same('at the end with a filler', readSpoken('Rename the button to Save. Okay, send it.'), { text: 'Rename the button to Save.', command: 'send' })

  // Commands that are only ever said alone are not taken from the end of a sentence.
  c.same('stop at the end is dictation', readSpoken('Run the tests. Stop.'), { text: 'Run the tests. Stop.', command: null })
  c.same('new chat at the end is dictation', cmd('That is all for this one. New chat.'), null)
  c.same('ultra at the end is dictation', cmd('Plan the launch. Ultra on.'), null)

  // Sentences that merely contain the words stay dictation.
  const ordinary = [
    'Stop the server when the tests finish.',
    "Don't stop until the build is green.",
    'Write the email to the client and send it.',
    'Write the email, and send it to the team.',
    'What should I send?',
    'Can you send it?',
    'Send it?',
    'Draft the reply. Then send it.',
    'Send the report to Amira.',
    'Make this a goal for the whole team.',
    'Make this a goal?',
    'We need a new chat feature in the app.',
    'Open a new chat window when I click the button.',
    'Turn ultra on in the settings page.',
    'The ultra on switch is broken.',
    'Stop sign detection should work at night.',
    'I want to stop paying for the old plan.',
    'Send',
    'Please send me the numbers. Stop guessing.',
    'fix the bug send it',
  ]
  const hijacked = ordinary.filter((s) => (s === 'Send' ? false : cmd(s) !== null))
  c.check('sentences that merely contain a command word stay dictation', !hijacked.length, JSON.stringify(hijacked))
  c.same('a bare word "Send" with nothing else is the command', cmd('Send'), 'send')
  c.same('dictation keeps every word', words('Stop the server when the tests finish.'), 'Stop the server when the tests finish.')

  // With spoken commands turned off, everything is dictation.
  c.same('commands off: all dictation', ['Send it.', 'Stop.', 'Fix it. Send it.', 'Ultra on.'].map((s) => readSpoken(s, false)), [
    { text: 'Send it.', command: null },
    { text: 'Stop.', command: null },
    { text: 'Fix it. Send it.', command: null },
    { text: 'Ultra on.', command: null },
  ])

  // What the speech model writes for silence or noise is dropped.
  c.same('markers for silence and noise are dropped', [tidySpeech(' [BLANK_AUDIO] '), tidySpeech('(music) Hello there.'), tidySpeech('Hello   world')], ['', 'Hello there.', 'Hello world'])
  c.same('nothing heard is nothing', readSpoken('  [BLANK_AUDIO]  '), { text: '', command: null })

  // Dictation goes after what is already in the box.
  c.same('joining dictation to the box', [joinDictation('', 'Hello.'), joinDictation('Fix the bug.', 'Then run the tests.'), joinDictation('Line one\n', 'line two'), joinDictation('Text  ', ''), joinDictation('Ends with space ', 'next')], ['Hello.', 'Fix the bug. Then run the tests.', 'Line one\nline two', 'Text  ', 'Ends with space next'])

  c.check('the languages offered include English and Bosnian', VOICE_LANGUAGES.some((l) => l.id === 'english') && VOICE_LANGUAGES.some((l) => l.id === 'bosnian'))

  // The speech model often writes no punctuation. Then a pause in the recording before the last
  // words is what marks "send it" off as its own sentence, and nothing else does.
  c.same('with a pause, an unpunctuated closing command counts', readSpoken('Check whether the tests pass Send it', true, { pause: true }), { text: 'Check whether the tests pass', command: 'send' })
  c.same('with a pause: make this a goal', readSpoken('all tests pass and the build is green make this a goal', true, { pause: true }), { text: 'all tests pass and the build is green', command: 'goal' })
  c.same('without a pause it stays dictation', readSpoken('Check whether the tests pass send it'), { text: 'Check whether the tests pass send it', command: null })
  const joined = ['Write the email and send it', 'Draft it then send it', 'Can you send it?', 'I want you to send it', 'We should send it', 'Fix it and make this a goal']
  c.same('with a pause, words joined to the sentence stay dictation', joined.map((s) => readSpoken(s, true, { pause: true }).command), joined.map(() => null))
  c.same('with a pause but commands off: dictation', readSpoken('Check the tests Send it', false, { pause: true }).command, null)

  // Pauses, measured on synthetic recordings: a tone for speech, silence for a pause.
  const clip = (...parts: [number, boolean][]): Float32Array => {
    const out: number[] = []
    for (const [secs, loud] of parts) for (let i = 0; i < Math.round(secs * 16000); i++) out.push(loud ? 0.25 * Math.sin(i * 0.11) * (0.6 + 0.4 * Math.sin(i * 0.0007)) : 0.001 * Math.sin(i * 1.7))
    return Float32Array.from(out)
  }
  c.same('pause before the end: speech, a pause, a short last phrase', pauseBeforeEnd(clip([0.3, false], [2.2, true], [0.7, false], [0.6, true], [0.4, false])), true)
  c.same('no pause: one stretch of speech', pauseBeforeEnd(clip([0.3, false], [3, true], [0.4, false])), false)
  c.same('a long last stretch is not a closing command', pauseBeforeEnd(clip([2, true], [0.7, false], [2.6, true], [0.3, false])), false)
  c.same('a short phrase alone has nothing before it', pauseBeforeEnd(clip([0.6, false], [0.6, true], [0.4, false])), false)
  c.same('a brief gap inside speech is not a pause', pauseBeforeEnd(clip([2, true], [0.2, false], [0.6, true], [0.3, false])), false)

  // The speech runtime runs only when its bytes match the fingerprints pinned in the code. They must
  // be those of the onnxruntime-web package that is installed: an upgrade that forgets them fails here.
  const ort = path.join(process.cwd(), 'node_modules', 'onnxruntime-web')
  const version = JSON.parse(fs.readFileSync(path.join(ort, 'package.json'), 'utf8')).version
  same(c, 'the pinned runtime is the installed onnxruntime-web', VOICE_RUNTIME.version, version)
  const sha = (f: string): string => createHash('sha256').update(fs.readFileSync(path.join(ort, 'dist', f))).digest('hex')
  same(c, 'the pinned fingerprints are those of its files', [sha(VOICE_RUNTIME.mjs.name), sha(VOICE_RUNTIME.wasm.name)], [VOICE_RUNTIME.mjs.sha256, VOICE_RUNTIME.wasm.sha256])
}

function same(c: Ctx, name: string, got: unknown, want: unknown): void {
  c.same(name, got, want)
}
