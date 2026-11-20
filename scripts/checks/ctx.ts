// What every checks file gets from scripts/auto-test.ts: the hub running the scripted demo team,
// and the same small helpers the main file uses. One file per piece of work, so several people
// can add checks at the same time without touching each other's lines.
import type { Hub } from '../../src/main/hub'
import type { Account, Chat, Item } from '../../src/shared/types'

export interface Ctx {
  /** The hub the main checks ran on (demo team, data in a temp folder). */
  hub: Hub
  /** A second hub on a fresh data folder of its own, for checks that must not share state. Dispose it yourself. */
  freshHub(name: string): Promise<{ hub: Hub; dataDir: string }>
  lead: Account
  leadId: string
  /** An empty folder for the scripted team to work in. */
  work: string
  /** The main hub's data folder. */
  dataDir: string
  check(name: string, ok: unknown, detail?: string): void
  same(name: string, got: unknown, want: unknown): void
  until(what: string, test: () => boolean, ms?: number): Promise<void>
  pause(ms: number): Promise<void>
  /** The transcript rows of one agent in a chat (the lead's by default). */
  rows(chat: Chat, who?: string): Item[]
  /** One agent in a chat (the lead by default) is not working and has nothing lined up. */
  idle(chat: Chat, who?: string): boolean
}

export type Checks = (c: Ctx) => Promise<void>
