/**
 * @-mention parsing for internal conversation notes.
 *
 * Encoded form (what's stored in `conversation_notes.note_text`):
 *   `@[Display Name](user-uuid)`
 *
 * The autocomplete in `internal-notes.tsx` inserts this exact form when the
 * user picks a suggestion. The renderer turns it back into a styled chip on
 * read; the server-side parser uses the embedded uuid to insert the
 * corresponding `note_mentions` rows.
 *
 * UUID pattern is the canonical 8-4-4-4-12 hex. Display name is anything
 * except `]` or newline so user names with parens / spaces still work.
 */
export const UUID_REGEX =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

export const MENTION_REGEX = new RegExp(
  `@\\[([^\\]\\n]+)\\]\\((${UUID_REGEX.source})\\)`,
  'g'
)

export interface ParsedMention {
  /** UUID of the mentioned user. */
  userId: string
  /** Display name as it appears in the note. */
  displayName: string
  /** Start index of the full `@[name](uuid)` token in the source string. */
  start: number
  /** End index (exclusive). */
  end: number
}

/**
 * Pull every mention out of a note body. Duplicates are preserved — call
 * `dedupeMentionUserIds` if you only need unique user IDs (e.g. for
 * notifications).
 */
export function parseMentions(text: string): ParsedMention[] {
  if (!text) return []
  const out: ParsedMention[] = []
  // RegExp.prototype.exec with /g maintains lastIndex; reset it so callers
  // never see leaked state from a previous run.
  const re = new RegExp(MENTION_REGEX.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({
      displayName: m[1],
      userId: m[2],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/** Returns the unique user IDs mentioned in the note, in first-seen order. */
export function dedupeMentionUserIds(mentions: ParsedMention[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of mentions) {
    if (!seen.has(m.userId)) {
      seen.add(m.userId)
      out.push(m.userId)
    }
  }
  return out
}

/**
 * Encode a mention token. Display name has any `]` characters stripped so it
 * can never break out of the bracket pair.
 */
export function encodeMention(userId: string, displayName: string): string {
  const safeName = (displayName || 'user').replace(/[\]\n\r]/g, '').trim() || 'user'
  return `@[${safeName}](${userId})`
}
