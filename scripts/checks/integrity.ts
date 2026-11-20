import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Ctx } from './ctx'
import { Hub } from '../../src/main/hub'
import { BAK_MAX, Saver, integrityLog, readJson, removeJson, saveIo, sweepTemps, writeJson } from '../../src/main/util'
import { TOOL_SERVER_LIMITS, ToolServer, validRpc } from '../../src/main/toolserver'
import type { TeamTool } from '../../src/main/providers/types'
import type { Chat, Item } from '../../src/shared/types'

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')
/** A process id that belongs to nobody: what a temp file of a dead process carries. */
const DEAD = 4_190_001

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}
/** One request to the real server, with every header under the check's control. */
function ask(url: string, o: { method?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean } = {}): Promise<Reply> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? undefined : Buffer.from(o.body)
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(o.headers || {}) }
    if (body && !o.chunked) headers['content-length'] = String(body.length)
    const req = http.request({ host: '127.0.0.1', port: Number(u.port), path: u.pathname + u.search, method: o.method || 'POST', headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body && o.chunked) {
      // Sent in pieces with no length declared; a refusal mid-way may reset the connection, which is fine.
      req.on('error', () => undefined)
      for (let i = 0; i < body.length; i += 256) req.write(body.subarray(i, i + 256))
      req.end()
    } else req.end(body)
  })
}
const call = (id: number, name: string, args: Record<string, unknown> = {}): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
/** Raw bytes on a socket, for senders that stall: resolves with whatever came back once the server closes or `ms` passes. */
function raw(port: number, bytes: string, ms: number): Promise<{ text: string; closed: boolean; after: number }> {
  return new Promise((resolve) => {
    const at = Date.now()
    let text = ''
    let done = false
    const s = net.connect(port, '127.0.0.1', () => s.write(bytes))
    const end = (closed: boolean): void => {
      if (done) return
      done = true
      clearTimeout(t)
      s.destroy()
      resolve({ text, closed, after: Date.now() - at })
    }
    const t = setTimeout(() => end(false), ms)
    s.on('data', (c) => (text += c.toString('utf8')))
    s.on('close', () => end(true))
    s.on('error', () => end(true))
  })
}

export default async function (c: Ctx): Promise<void> {
  const { check, same, pause } = c
  const root = path.join(os.tmpdir(), 'ensemble-auto-integrity')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  let n = 0
  const fresh = (): string => {
    const dir = path.join(root, `case-${++n}`)
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'state.json')
  }
  const onDisk = (f: string): unknown => JSON.parse(fs.readFileSync(f, 'utf8'))
  const logged = (f: string, what: 'recovered' | 'lost'): boolean => integrityLog.some((e) => e.file === f && e.what === what)
  const quiet = async <T>(run: () => T | Promise<T>): Promise<T> => {
    const real = console.error
    console.error = () => undefined
    try {
      return await run()
    } finally {
      console.error = real
    }
  }
  const v1 = { v: 1, list: ['a', 'b'] }
  const v2 = { v: 2, list: ['a', 'b', 'c'] }
  const v3 = { v: 3, list: [] as string[] }

  // ───────────── B. state on disk ─────────────
  {
    const f = fresh()
    writeJson(f, v1)
    same('a save is plain JSON any tool can read', onDisk(f), v1)
    const sum = onDisk(`${f}.sum`) as { cur: string; prev?: string }
    check('with the checksum of what was saved beside it', sum.cur === sha(fs.readFileSync(f)) && !fs.existsSync(`${f}.bak`))
    writeJson(f, v2)
    const sum2 = onDisk(`${f}.sum`) as { cur: string; prev?: string }
    check('the next save keeps the last good state beside it, and both checksums', JSON.stringify(onDisk(`${f}.bak`)) === JSON.stringify(v1) && sum2.cur === sha(JSON.stringify(v2)) && sum2.prev === sha(JSON.stringify(v1)), JSON.stringify(sum2))
    same('and reads back the newest', readJson(f, null), v2)
    check('no temp file is left behind', !fs.readdirSync(path.dirname(f)).some((x) => x.endsWith('.tmp')))
  }
  {
    // A truncated main file: the last good state is read, and the main file is whole again afterwards.
    const f = fresh()
    writeJson(f, v1)
    writeJson(f, v2)
    const whole = fs.readFileSync(f)
    fs.writeFileSync(f, whole.subarray(0, Math.floor(whole.length / 2)))
    const got = await quiet(() => readJson(f, null))
    same('a truncated main file: the last good state is read', got, v1)
    check('said loudly, and the main file is whole again', logged(f, 'recovered') && JSON.stringify(onDisk(f)) === JSON.stringify(v1) && (onDisk(`${f}.sum`) as { cur: string }).cur === sha(fs.readFileSync(f)))
  }
  {
    // Valid JSON, wrong checksum (bit rot, or half of another file): not trusted while a checked copy exists.
    const f = fresh()
    writeJson(f, v1)
    writeJson(f, v2)
    // Damage changes the bytes without the file being written again: its time stays that of the save.
    const saved = fs.statSync(f)
    fs.writeFileSync(f, JSON.stringify({ v: 2, list: ['a', 'b', 'X'] }))
    fs.utimesSync(f, saved.atime, saved.mtime)
    same('a main file that parses but fails its checksum: the checked last-good state is read instead', await quiet(() => readJson(f, null)), v1)
    // Edited on purpose after the app's last save (by hand, or by another tool): the edit is the state.
    const e = fresh()
    writeJson(e, v1)
    writeJson(e, v2)
    fs.writeFileSync(e, JSON.stringify({ v: 2, list: ['edited by hand'] }, null, 2))
    fs.utimesSync(e, new Date(), new Date(Date.now() + 5000))
    same('a main file edited after the last save is kept, not replaced by the older copy', [readJson(e, null), (onDisk(`${e}.sum`) as { cur: string }).cur === sha(fs.readFileSync(e))], [{ v: 2, list: ['edited by hand'] }, true])
    // With no checked copy at all, a file that parses is still better than nothing (it may have been edited by hand).
    const g = fresh()
    writeJson(g, v1)
    fs.writeFileSync(g, JSON.stringify(v3))
    same('with no other copy, a main file that parses is used, and its checksum is put right', [await quiet(() => readJson(g, null)), (onDisk(`${g}.sum`) as { cur: string }).cur === sha(fs.readFileSync(g))], [v3, true])
  }
  {
    // A half-written temp file of a dead process: never read, and cleaned up.
    const f = fresh()
    writeJson(f, v1)
    const half = `${f}.${DEAD}.tmp`
    fs.writeFileSync(half, JSON.stringify(v2).slice(0, 9))
    same('a half-written temp file beside a whole main file changes nothing', readJson(f, null), v1)
    sweepTemps(path.dirname(f), true)
    check('temp files of dead processes are removed', !fs.existsSync(half))
    fs.writeFileSync(half, JSON.stringify(v2).slice(0, 9))
    fs.writeFileSync(`${f}.${process.pid}.a.tmp`, 'x')
    fs.writeFileSync(f, '{"v":1,"li')
    same('main damaged and only a half-written temp file left: the default, not half a state', await quiet(() => readJson(f, 'default')), 'default')
    check('and that loss is said loudly', logged(f, 'lost'))
    check("a living process's temp file is left alone, a dead one's is removed", fs.existsSync(`${f}.${process.pid}.a.tmp`) && !fs.existsSync(half))
  }
  {
    // The swap fails with EPERM / EBUSY every time (a scanner holds the file): the live file is never rewritten in place.
    const f = fresh()
    writeJson(f, v1)
    const before = fs.readFileSync(f)
    const real = saveIo.rename
    let tries = 0
    saveIo.rename = () => {
      tries++
      throw Object.assign(new Error(tries % 2 ? 'EPERM: operation not permitted, rename' : 'EBUSY: resource busy or locked, rename'), { code: tries % 2 ? 'EPERM' : 'EBUSY' })
    }
    const ok = await quiet(() => writeJson(f, v2))
    check('a swap that fails every time is tried several times, then the save is kept beside the file', ok && tries >= 6 && JSON.stringify(onDisk(`${f}.pending`)) === JSON.stringify(v2), `${tries} tries`)
    check('the live file is left exactly as it was (no in-place write)', fs.readFileSync(f).equals(before))
    same('the reader prefers the waiting save: it is whole and newer', readJson(f, null), v2)
    await quiet(() => writeJson(f, v3))
    same('a later save while the file is still held replaces the waiting one', [readJson(f, null), fs.readFileSync(f).equals(before)], [v3, true])
    saveIo.rename = real
    writeJson(f, { v: 4 })
    check('once the file is free again the next save swaps in and the waiting copy is gone', JSON.stringify(onDisk(f)) === '{"v":4}' && !fs.existsSync(`${f}.pending`) && JSON.stringify(readJson(f, null)) === '{"v":4}')
  }
  {
    // A crash between the write and the swap: the temp file is whole and its checksum is the committed one.
    const f = fresh()
    writeJson(f, v1)
    const tmp = `${f}.${DEAD}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(v2))
    fs.writeFileSync(`${f}.sum`, JSON.stringify({ v: 1, cur: sha(JSON.stringify(v2)), prev: sha(JSON.stringify(v1)) }))
    same('a crash between write and swap: the newer, whole state is read from the temp file', await quiet(() => readJson(f, null)), v2)
    check('and it becomes the main file, the temp file gone', JSON.stringify(onDisk(f)) === JSON.stringify(v2) && !fs.existsSync(tmp))
    // A crash before the checksum was recorded: that save was never committed, so the state stays the one before.
    const g = fresh()
    writeJson(g, v1)
    fs.writeFileSync(`${g}.${DEAD}.tmp`, JSON.stringify(v2))
    same('a crash before the checksum was recorded: the committed state stands', readJson(g, null), v1)
    // A crash right after the live file was replaced is simply the new state.
    const h = fresh()
    writeJson(h, v1)
    writeJson(h, v2)
    fs.rmSync(h)
    same('the main file gone altogether: the last good state', await quiet(() => readJson(h, null)), v1)
  }
  {
    // Both copies damaged: the default, loudly.
    const f = fresh()
    writeJson(f, v1)
    writeJson(f, v2)
    fs.writeFileSync(f, '{"v":2,"list":["a"')
    fs.writeFileSync(`${f}.bak`, '\u0000\u0000\u0000')
    const before = integrityLog.length
    same('main and last-good both damaged: the default is given', await quiet(() => readJson(f, { v: 0 })), { v: 0 })
    check('and said loudly', integrityLog.slice(before).some((e) => e.file === f && e.what === 'lost'))
    same('a file that was simply never written is the default, with no alarm', [readJson(path.join(root, 'never.json'), 7), logged(path.join(root, 'never.json'), 'lost')], [7, false])
  }
  {
    // Files written before checksums existed, and removal.
    const f = fresh()
    fs.writeFileSync(f, '\uFEFF' + JSON.stringify(v1))
    same('a file from before checksums (with a byte-order mark) reads as it always did', readJson(f, null), v1)
    writeJson(f, v2)
    writeJson(f, v3)
    removeJson(f)
    check('removing a state file removes its copies too, so no reader brings it back', fs.readdirSync(path.dirname(f)).length === 0 && readJson(f, null) === null)
  }
  {
    // A long transcript keeps no second copy for good.
    const f = fresh()
    const big = { text: 'x'.repeat(BAK_MAX + 1024) }
    writeJson(f, big)
    writeJson(f, { ...big, more: 1 })
    check('a file over 8 MB keeps no last-good copy (no doubled disk use), but still its checksum', !fs.existsSync(`${f}.bak`) && (onDisk(`${f}.sum`) as { cur: string }).cur === sha(fs.readFileSync(f)))
    same('BAK_MAX', BAK_MAX, 8 * 1024 * 1024)
  }
  {
    // The background saver follows the same rules.
    const f = fresh()
    let state: unknown = v1
    const s = new Saver(f, () => state, 10)
    s.now()
    for (let i = 0; i < 100 && !fs.existsSync(f); i++) await pause(10)
    await pause(30)
    state = v2
    s.now()
    // Watched on disk: a read here would itself take part in what is being checked.
    for (let i = 0; i < 100 && JSON.stringify((() => { try { return onDisk(f) } catch { return null } })()) !== JSON.stringify(v2); i++) await pause(10)
    check('background saves: checksum and last-good copy as well', (onDisk(`${f}.sum`) as { cur: string }).cur === sha(fs.readFileSync(f)) && JSON.stringify(onDisk(`${f}.bak`)) === JSON.stringify(v1))
    const before = fs.readFileSync(f)
    const real = saveIo.renameAsync
    saveIo.renameAsync = async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    }
    state = v3
    await quiet(async () => {
      s.now()
      for (let i = 0; i < 300 && !fs.existsSync(`${f}.pending`); i++) await pause(10)
    })
    check('background save with the swap failing every time: kept beside the file, the live file untouched', fs.existsSync(`${f}.pending`) && fs.readFileSync(f).equals(before) && JSON.stringify(readJson(f, null)) === JSON.stringify(v3))
    saveIo.renameAsync = real
    s.flushSync()
    check('and the save at closing time puts it in place', JSON.stringify(onDisk(f)) === JSON.stringify(v3) && !fs.existsSync(`${f}.pending`))
  }

  {
    // A read while a save is on its way never rolls the file back: the checksum already names the new
    // state while the old file is still in place and the save's temp file belongs to a living writer.
    const bytes = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
    const f = fresh()
    writeJson(f, v1)
    const old = bytes(f)
    const next = JSON.stringify(v2)
    // Mid-save, by hand: the new state is written and synced, its checksum recorded, the swap not yet made.
    const tmp = `${f}.${process.pid}.a.tmp`
    fs.writeFileSync(tmp, next)
    fs.writeFileSync(`${f}.sum`, JSON.stringify({ v: 1, cur: sha(next), prev: sha(old), at: Date.now() }))
    const sumBefore = bytes(`${f}.sum`)
    const got = await quiet(() => readJson(f, null))
    check('a read in the middle of a save gives the new state and writes nothing', JSON.stringify(got) === next && bytes(f) === old && bytes(`${f}.sum`) === sumBefore && fs.existsSync(tmp), JSON.stringify({ got, live: bytes(f).slice(0, 40), sum: bytes(`${f}.sum`) === sumBefore }))
    fs.renameSync(tmp, f)
    same('and once the writer swaps it in, the file and its checksum agree on the new state', [bytes(f), (onDisk(`${f}.sum`) as { cur: string }).cur], [next, sha(next)])

    // The same with another living process as the writer (the parent of this one), with its save still half-written.
    const g = fresh()
    writeJson(g, v1)
    const gOld = bytes(g)
    const other = `${g}.${process.ppid}.tmp`
    fs.writeFileSync(other, next.slice(0, 7))
    const gSum = bytes(`${g}.sum`)
    const gGot = await quiet(() => readJson(g, null))
    check("another process's save that is still being written: the whole old state, nothing rewritten", JSON.stringify(gGot) === JSON.stringify(v1) && bytes(g) === gOld && bytes(`${g}.sum`) === gSum && fs.existsSync(other))
    fs.rmSync(other, { force: true })

    // A real background save held open at the swap, and a read in between.
    const h = fresh()
    let state: unknown = v1
    const saver = new Saver(h, () => state, 0)
    saver.now()
    for (let i = 0; i < 100 && !fs.existsSync(h); i++) await pause(10)
    await pause(30)
    const real = saveIo.renameAsync
    let release: () => void = () => undefined
    const held = new Promise<void>((r) => (release = r))
    let reached = false
    saveIo.renameAsync = async (from: string, to: string) => {
      reached = true
      await held
      return real(from, to)
    }
    state = v2
    saver.now()
    for (let i = 0; i < 200 && !reached; i++) await pause(5)
    const hOld = bytes(h)
    const during = await quiet(() => readJson(h, null))
    const untouched = bytes(h) === hOld
    release()
    for (let i = 0; i < 200 && bytes(h) !== next; i++) await pause(5)
    saveIo.renameAsync = real
    await pause(20)
    check('a read while a background save is held at the swap: no rollback, and the newer state lands', reached && untouched && JSON.stringify(during) === next && bytes(h) === next && (onDisk(`${h}.sum`) as { cur: string }).cur === sha(next), JSON.stringify({ reached, untouched, during, final: bytes(h).slice(0, 40) }))
  }
  {
    // Recovering a damaged file keeps the good last-good copy, and keeps the damaged file aside for diagnosis.
    const f = fresh()
    writeJson(f, v1)
    writeJson(f, v2)
    const good = fs.readFileSync(`${f}.bak`, 'utf8')
    const torn = '{"v":2,"list":["a","'
    fs.writeFileSync(f, torn)
    await quiet(() => readJson(f, null))
    const dir = path.dirname(f)
    const aside = fs.readdirSync(dir).filter((n) => /^state\.json\.damaged/.test(n))
    check('recovery: the main file is whole again and the last-good copy is still the good one', JSON.stringify(onDisk(f)) === JSON.stringify(v1) && fs.readFileSync(`${f}.bak`, 'utf8') === good, fs.readFileSync(`${f}.bak`, 'utf8').slice(0, 40))
    check('and the damaged file is kept aside, not thrown away', aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8') === torn, aside.join(', '))
    // A file that fails its checksum is never made the last-good copy by a save either.
    const g = fresh()
    writeJson(g, v1)
    writeJson(g, v2)
    const gGood = fs.readFileSync(`${g}.bak`, 'utf8')
    fs.writeFileSync(g, '{"v":"bitrot"}')
    fs.utimesSync(g, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)) // older than its checksum: damage, not an edit
    writeJson(g, v3)
    check('a save over a file that fails its checksum keeps the earlier good copy as last-good', fs.readFileSync(`${g}.bak`, 'utf8') === gGood && JSON.stringify(onDisk(g)) === JSON.stringify(v3))
  }
  {
    // A crash's last save survives the next start: the dead process's temp file carries the committed
    // checksum, and a write to another file in the same folder (which sweeps old temp files) must not delete it.
    // Laid out by hand, as the last run left it: no save has happened in this folder yet in this run, so the
    // write to the other file below is the first one, which is when old temp files are swept.
    const f = fresh()
    const old = JSON.stringify(v1)
    fs.writeFileSync(f, old)
    const last = JSON.stringify(v2)
    const crashed = `${f}.${DEAD}.tmp`
    fs.writeFileSync(crashed, last)
    fs.writeFileSync(`${f}.sum`, JSON.stringify({ v: 1, cur: sha(last), prev: sha(old), at: Date.now() }))
    const torn = `${f}.${DEAD + 1}.tmp`
    fs.writeFileSync(torn, last.slice(0, 5))
    writeJson(path.join(path.dirname(f), 'other.json'), { x: 1 })
    check('a sweep keeps a dead process\'s temp file that carries the committed checksum, and removes a torn one', fs.existsSync(crashed) && !fs.existsSync(torn))
    same('and the next read adopts that last save', [await quiet(() => readJson(f, null)), fs.readFileSync(f, 'utf8')], [v2, last])
    check('after which the temp file is gone', !fs.existsSync(crashed))
  }

  // ───────────── C. the tool server ─────────────
  {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let built = 0
    const tools: TeamTool[] = [
      { name: 'echo', description: 'Says it back', schema: { text: z.string() }, run: async (a) => `echo: ${String(a.text)}` },
      { name: 'hold', description: 'Waits until released', schema: {}, run: async () => (await gate, 'released') },
      { name: 'slow', description: 'Takes a while', schema: {}, run: async () => (await new Promise((r) => setTimeout(r, 700)), 'done after 700 ms') },
      { name: 'never', description: 'Never answers', schema: {}, run: () => new Promise<string>(() => undefined) },
      { name: 'boom', description: 'Fails inside', schema: {}, run: async () => Promise.reject(new Error('could not reach the teammate')) },
    ]
    const counted: TeamTool[] = tools.map((t) => ({
      ...t,
      get schema() {
        built++
        return t.schema
      },
    }))
    const ts = new ToolServer({ maxBody: 4096, headersMs: 300, requestMs: 400, perAgent: 2, overall: 3, toolMs: 1500 })
    await ts.start()
    const url = ts.register('agent-a', counted)!
    const urlB = ts.register('agent-b', tools)!
    const port = Number(new URL(url).port)
    const p = new URL(url).pathname

    const ok = await ask(url, { body: call(1, 'echo', { text: 'hello' }) })
    check('a tool called through the server answers', ok.status === 200 && /echo: hello/.test(ok.body), `${ok.status} ${ok.body.slice(0, 120)}`)
    const viaName = await ask(url, { headers: { host: `localhost:${port}` }, body: call(2, 'echo', { text: 'by name' }) })
    check('addressed as localhost with our port: answered too', viaName.status === 200 && /echo: by name/.test(viaName.body))

    const wrongHost = await ask(url, { headers: { host: `evil.example:${port}` }, body: call(3, 'echo', { text: 'x' }) })
    const wrongPort = await ask(url, { headers: { host: '127.0.0.1:1' }, body: call(3, 'echo', { text: 'x' }) })
    same('another Host name (DNS rebinding) or another port: refused with 403', [wrongHost.status, wrongPort.status, /echo/.test(wrongHost.body)], [403, 403, false])
    const origin = await ask(url, { headers: { origin: 'https://evil.example' }, body: call(4, 'echo', { text: 'x' }) })
    const originLocal = await ask(url, { headers: { origin: `http://127.0.0.1:${port}` }, body: call(4, 'echo', { text: 'x' }) })
    same('a request carrying a browser Origin, even a local one: refused with 403', [origin.status, originLocal.status], [403, 403])

    const text = await ask(url, { headers: { 'content-type': 'text/plain' }, body: call(5, 'echo', { text: 'x' }) })
    const form = await ask(url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })
    same('a body that is not declared as JSON: 415', [text.status, form.status], [415, 415])
    const get = await ask(url, { method: 'GET' })
    same('anything but POST: 405', [get.status, get.headers.allow], [405, 'POST'])
    const nobody = await ask(`http://127.0.0.1:${port}/mcp/not-a-real-address`, { body: call(6, 'echo', { text: 'x' }) })
    same('an address nobody was given: 404', nobody.status, 404)

    const builtBefore = built
    const broken = await ask(url, { body: '{"jsonrpc":"2.0","id":1,' })
    same('a body that is not JSON: 400 with a parse error and nothing else', [broken.status, (JSON.parse(broken.body) as { error: { code: number; message: string } }).error], [400, { code: -32700, message: 'Parse error' }])
    const shapes = [{ foo: 1 }, { jsonrpc: '1.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: {}, method: 'tools/list' }, { jsonrpc: '2.0', id: 1, method: 7 }, [], 'tools/list', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'x' }, Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/list' }))]
    const refused = await Promise.all(shapes.map((s) => ask(urlB, { body: JSON.stringify(s) })))
    check('a body that is JSON but not a JSON-RPC call (or too long a batch): 400 "Invalid request"', refused.every((r) => r.status === 400 && (JSON.parse(r.body) as { error: { code: number } }).error.code === -32600), refused.map((r) => r.status).join(','))
    const shaped = await ask(url, { body: JSON.stringify({ foo: 1 }) })
    check('and nothing is built for a request that fails the shape check', shaped.status === 400 && built === builtBefore, `${built - builtBefore} schemas read`)
    same('the shape check itself', [validRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), validRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), validRpc({ jsonrpc: '2.0', id: 1, result: {} }), validRpc([{ jsonrpc: '2.0', id: 1, method: 'a' }]), validRpc(null), validRpc({ jsonrpc: '2.0' })], [true, true, true, true, false, false])

    const tooBig = await ask(url, { body: call(7, 'echo', { text: 'x'.repeat(5000) }) })
    same('a body over the size limit (declared): 413', tooBig.status, 413)
    const stream = await ask(url, { chunked: true, body: call(8, 'echo', { text: 'y'.repeat(60_000) }) }).catch((e: Error) => ({ status: 0, headers: {}, body: e.message }))
    check('a body over the limit sent in pieces with no length: 413 (or cut off), and never run', (stream.status === 413 || stream.status === 0) && !/echo: y/.test(stream.body), String(stream.status))

    const stalledBody = await raw(port, `POST ${p} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"jsonrpc":"2.0",`, 3000)
    check('a body that stops arriving is given up on within the time limit (408)', stalledBody.closed && stalledBody.after < 2500 && /^HTTP\/1\.1 408/.test(stalledBody.text), `${stalledBody.after} ms: ${stalledBody.text.slice(0, 40)}`)
    const stalledHead = await raw(port, `POST ${p} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-ty`, 3000)
    check('headers that stop arriving: the connection is closed within the time limit', stalledHead.closed && stalledHead.after < 2500, `${stalledHead.after} ms`)
    // Only Node's own time limit can notice stalled headers, so this is the path that used to answer 400.
    check('and that sender is told it was too slow (408), not that its request was bad', /^HTTP\/1\.1 408/.test(stalledHead.text), stalledHead.text.slice(0, 40))

    const slow = await ask(urlB, { body: call(9, 'slow') })
    check('a tool that runs longer than the receiving limits is not cut off', slow.status === 200 && /done after 700 ms/.test(slow.body), `${slow.status} ${slow.body.slice(0, 80)}`)
    const never = await ask(urlB, { body: call(10, 'never') })
    check("a tool that never answers is given up on at the tool's own bound, as a tool error", never.status === 200 && /took longer than/.test(never.body) && /"isError":true/.test(never.body), never.body.slice(0, 160))
    const boom = await ask(urlB, { body: call(11, 'boom') })
    check("a tool's own refusal reaches the agent that called it", boom.status === 200 && /Failed: could not reach the teammate/.test(boom.body))

    // Only so many at once: per agent address, then overall. Refused at once (429), not queued.
    const held = [ask(url, { body: call(20, 'hold') }), ask(url, { body: call(21, 'hold') })]
    await pause(150)
    const third = await ask(url, { body: call(22, 'echo', { text: 'x' }) })
    same('a third request at once on one agent address: 429 at once, with Retry-After', [third.status, third.headers['retry-after']], [429, '1'])
    const other = ask(urlB, { body: call(23, 'hold') })
    await pause(150)
    const fourth = await ask(urlB, { body: call(24, 'echo', { text: 'x' }) })
    same('another agent is not held up by that, until the whole server is full: then 429', fourth.status, 429)
    release()
    const answers = await Promise.all([...held, other])
    check('the requests that were under way finish normally', answers.every((r) => r.status === 200 && /released/.test(r.body)))
    await pause(50)
    const again = await ask(url, { body: call(25, 'echo', { text: 'room again' }) })
    check('and there is room again afterwards', again.status === 200 && /echo: room again/.test(again.body))

    // What goes wrong inside is never described in a reply.
    const real = console.error
    const said: string[] = []
    console.error = (...a: unknown[]) => void said.push(a.join(' '))
    const urlC = ts.register('agent-c', [
      {
        name: 'broken',
        description: 'x',
        get schema(): z.ZodRawShape {
          throw new Error('secret detail C:\\Users\\someone\\data.json')
        },
        run: async () => 'x',
      },
    ])!
    const inner = await ask(urlC, { body: call(30, 'broken') })
    console.error = real
    check('an error inside the server: 500 "Internal error", no detail in the reply, the detail in the log', inner.status === 500 && (JSON.parse(inner.body) as { error: { message: string } }).error.message === 'Internal error' && !/secret|Users/.test(inner.body) && said.some((x) => /secret detail/.test(x)), inner.body)

    ts.unregister('agent-a')
    same('an agent that is gone: its address stops answering', (await ask(url, { body: call(31, 'echo', { text: 'x' }) })).status, 404)
    ts.stop()

    same('the limits the app runs with', TOOL_SERVER_LIMITS, { maxBody: 2 * 1024 * 1024, headersMs: 10_000, requestMs: 30_000, keepAliveMs: 5_000, perAgent: 8, overall: 256, toolMs: 30 * 60 * 1000, maxBatch: 20 })
    const live = (c.hub as unknown as { toolServer: { server: http.Server } }).toolServer.server
    same("and the hub's own server has them set (headers 10 s, request 30 s, keep-alive 5 s, 64 headers, no idle cut on a running tool)", [live.headersTimeout, live.requestTimeout, live.keepAliveTimeout, live.maxHeadersCount, live.timeout], [10_000, 30_000, 5_000, 64, 0])
  }
  {
    // What ChatGPT agents rely on keeps working: a real team tool, called through the hub's server the way their program does.
    const hub = c.hub
    const gptAcc = hub.accounts.accounts.find((a) => a.provider === 'chatgpt' && a.enabled)
    if (gptAcc) {
      const chat = hub.createChat({ cwd: c.work })
      const session = hub['session'](chat, gptAcc)
      const url = hub['toolServer'].register(`${chat.id}:${gptAcc.id}`, hub['toolsFor'](session)) as string
      const list = await ask(url, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
      const roster = await ask(url, { body: call(2, 'roster') })
      check("a ChatGPT agent's team tools still work through the server (tools/list, then roster)", list.status === 200 && /"name":"roster"/.test(list.body) && roster.status === 200 && new RegExp(`You are ${gptAcc.name}`).test(roster.body), `${list.status} ${roster.status} ${roster.body.slice(0, 120)}`)
      hub['toolServer'].unregister(`${chat.id}:${gptAcc.id}`)
    } else check("a ChatGPT agent's team tools still work through the server", false, 'the demo team has no ChatGPT account')
  }

  // ───────────── A. "Restart to update" never restarts a cut the user had left alone ─────────────
  {
    const dir = path.join(os.tmpdir(), 'ensemble-auto-integrity-restart')
    fs.rmSync(dir, { recursive: true, force: true })
    const open = async (version: string): Promise<Hub> => {
      const h = new Hub({ dataDir: dir, version, demo: true, mica: false, isFocused: () => false, notify: () => {}, emit: () => {} })
      await h.start()
      return h
    }
    const rowsOf = (h: Hub, id: string): Item[] => h.openChat(id).items[h.lead()!.id] || []
    const offer = (h: Hub, id: string): boolean => !!h.chats.get(id)?.recovery && rowsOf(h, id).some((i) => i.kind === 'notice' && i.action?.kind === 'resume' && !i.action.done)
    const pickedUp = (h: Hub, id: string): boolean => rowsOf(h, id).some((i) => i.kind === 'notice' && /picked up again by itself/.test(i.text))
    const settle = async (h: Hub): Promise<void> => {
      await h.accounts.refresh()
      await pause(500)
    }
    const stopAll = async (h: Hub, ids: string[]): Promise<void> => {
      for (const id of ids) await h.stop(id)
      await pause(200)
    }
    const liveOnDisk = (id: string): number => readJson<{ status: string }[]>(path.join(dir, 'chats', id, 'tasks.json'), []).filter((t) => t.status === 'running' || t.status === 'queued').length
    let h = await open('1.0.0')
    for (const cand of await h.accounts.discover()) if (cand.signedIn) h.accounts.add({ name: cand.suggestedName, provider: cand.provider, configDir: cand.configDir })
    await h.accounts.refresh()
    // An ordinary close in the middle of work: the lead mid-reply, and a task that was out.
    const left: Chat = h.createChat({ cwd: c.work })
    h.send({ chatId: left.id, to: h.lead()!.id, text: 'Add a pricing page' })
    await pause(400)
    const task = { id: `t${h.tasksOf(left.id).length + 1}`, chatId: left.id, title: 'Out when it closed', brief: 'x', from: h.lead()!.id, to: h.lead()!.id, status: 'running' as const, createdAt: Date.now() }
    h.tasksOf(left.id).push(task)
    writeJson(path.join(dir, 'chats', left.id, 'tasks.json'), h.tasksOf(left.id))
    const leftId = left.id
    await h.dispose()
    // The next start offers "Continue". The user leaves it alone, works in another chat, and chooses "Restart to update".
    h = await open('1.0.0')
    await settle(h)
    check('an ordinary close in the middle of work: offered, not restarted', offer(h, leftId) && !pickedUp(h, leftId))
    same('the cut tasks are written down as interrupted at once, not left as running on disk', [liveOnDisk(leftId), h.tasksOf(leftId).find((t) => t.id === task.id)?.status], [0, 'interrupted'])
    const working = h.createChat({ cwd: c.work })
    h.send({ chatId: working.id, to: h.lead()!.id, text: 'Add a pricing page' })
    const stale = h.createChat({ cwd: c.work })
    h.send({ chatId: stale.id, to: h.lead()!.id, text: 'Add a pricing page' })
    await pause(400)
    const ids = { working: working.id, stale: stale.id }
    h.markUpdateRestart()
    await h.dispose()
    // One chat last moved an hour before the restart: whatever it holds was not cut by it.
    const chatsFile = path.join(dir, 'chats.json')
    const all = readJson<Chat[]>(chatsFile, [])
    for (const ch of all) if (ch.id === ids.stale) ch.updatedAt = Date.now() - 60 * 60 * 1000
    writeJson(chatsFile, all)
    h = await open('1.0.1')
    await settle(h)
    for (let i = 0; i < 100 && !pickedUp(h, ids.working); i++) await pause(50)
    check('restart to update: the chat it cut is picked up by itself', pickedUp(h, ids.working) && !h.chats.get(ids.working)?.recovery)
    check('the cut the user had left alone is NOT restarted: its offer stands, nothing ran', offer(h, leftId) && !pickedUp(h, leftId) && h.tasksOf(leftId).find((t) => t.id === task.id)?.status === 'interrupted' && !(h.openChat(leftId).states.find((x) => x.accountId === h.lead()!.id)?.phase !== 'idle'), `${JSON.stringify(h.chats.get(leftId)?.recovery)} ${h.tasksOf(leftId).find((t) => t.id === task.id)?.status}`)
    check('a chat that last moved long before the restart is not picked up either: it is offered', offer(h, ids.stale) && !pickedUp(h, ids.stale))
    await stopAll(h, [ids.working])
    // And once more: a second update restart, with the same old cut still left alone.
    h.markUpdateRestart()
    await h.dispose()
    h = await open('1.0.2')
    await settle(h)
    check('a second restart to update still leaves that old cut alone', offer(h, leftId) && !pickedUp(h, leftId) && offer(h, ids.stale) && !pickedUp(h, ids.stale))
    await h.dispose()
  }
}
