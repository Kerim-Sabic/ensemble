import path from 'node:path'
import type { HubEvent, MemoryNote } from '@shared/types'
import { readJson, truncate, uid, writeJson } from './util'

/** A small shared notebook every agent can read and add to, across all chats. */
export class MemoryStore {
  notes: MemoryNote[]
  private file: string

  constructor(
    dataDir: string,
    private emit: (ev: HubEvent) => void,
  ) {
    this.file = path.join(dataDir, 'memory.json')
    this.notes = readJson<MemoryNote[]>(this.file, [])
  }

  private commit(): void {
    this.notes.sort((a, b) => b.updatedAt - a.updatedAt)
    writeJson(this.file, this.notes)
    this.emit({ type: 'memory', notes: this.notes })
  }

  save(input: { id?: string; title: string; body: string }, author: string): MemoryNote {
    const now = Date.now()
    const title = truncate(input.title.trim() || 'Untitled', 120)
    const body = truncate(input.body.trim(), 4000)
    // Same title means "update what we know", not "add a second copy".
    const existing = input.id
      ? this.notes.find((n) => n.id === input.id)
      : this.notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
    if (existing) {
      existing.title = title
      existing.body = body
      existing.updatedAt = now
      this.commit()
      return existing
    }
    const note: MemoryNote = { id: uid('m'), title, body, author, createdAt: now, updatedAt: now }
    this.notes.push(note)
    this.commit()
    return note
  }

  delete(id: string): boolean {
    const before = this.notes.length
    this.notes = this.notes.filter((n) => n.id !== id)
    if (this.notes.length === before) return false
    this.commit()
    return true
  }

  search(query: string, limit = 8): MemoryNote[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
    if (!terms.length) return this.notes.slice(0, limit)
    return this.notes
      .map((n) => {
        const title = n.title.toLowerCase()
        const body = n.body.toLowerCase()
        let score = 0
        for (const t of terms) score += (title.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0)
        return { n, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.n)
  }

  /** What gets written into a new session's briefing. Newest first, bounded. */
  digest(maxChars = 3500): string {
    const lines: string[] = []
    let used = 0
    for (const n of this.notes) {
      const line = `- ${n.title}: ${n.body.replace(/\s+/g, ' ')}`
      if (used + line.length > maxChars) {
        lines.push(`- (${this.notes.length - lines.length} more notes; search to find them)`)
        break
      }
      lines.push(line)
      used += line.length
    }
    return lines.join('\n')
  }
}
