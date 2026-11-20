// How a provider says "you are out of allowance", in every wording seen so far. A reply that is
// not recognised as this is treated as an ordinary failure, or worse as an ordinary answer: the
// work then neither steps down a model nor changes hands, and a goal reads the notice as a report.

const LIMIT = /usage limit|rate limit|limit reached|out of .{0,40}usage|\b(?:hit|reached) your (?:[\w.\- ]{1,40} )?limit\b|limit\s*[·•|]\s*resets/i

/** Whether an error's text says a usage limit was reached. */
export function isLimitText(text: string): boolean {
  return LIMIT.test(text || '')
}

/**
 * Whether a whole reply is nothing but the provider's own notice that a limit was reached
 * ("You've hit your Fable limit · resets Nov 21, 5pm. Switch to another model to continue.").
 * Such a reply can arrive marked as a success; it did no work.
 */
export function isLimitNotice(text: string): boolean {
  const t = (text || '').trim()
  return t.length > 0 && t.length <= 320 && /^you(?:['’]ve| have) (?:hit|reached) (?:your|the) (?:[\w.\- ]{1,40} )?limit\b/i.test(t)
}
