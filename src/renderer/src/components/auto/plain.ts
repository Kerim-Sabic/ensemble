// Text from a chat, shown as a line of plain words where markdown would only get in the way.

/** A found passage as plain words: no markdown marks, code fences or table bars. */
export function plain(text: string): string {
  return text
    .replace(/```[a-z0-9]*/gi, ' ')
    .replace(/`/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s*(#{1,6}|>|[-*+]|\d+\.)\s+/g, '$1')
    .replace(/\s*\|\s*(?:-{3,}\s*\|\s*)*/g, ' · ')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
