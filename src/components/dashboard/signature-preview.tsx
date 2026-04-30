'use client'

/**
 * Live preview of an email signature with `{{...}}` variables substituted.
 * Used by:
 *   - the per-user signature management page (`/account/signature`)
 *   - the admin company default editor (`/admin/companies/[id]/signature`)
 *   - the manual reply composer to show the agent what'll be appended.
 *
 * Renders a tiny subset of markdown (bold, italic, links, line breaks).
 * Falls back to a faded "no signature" placeholder when the template is
 * empty so the panel never collapses unexpectedly.
 */

import { substituteSignatureVariables } from '@/lib/email-signature'

export interface SignaturePreviewContext {
  full_name: string | null
  email: string | null
  company_name: string | null
}

interface Props {
  template: string
  context: SignaturePreviewContext
  /** Render the leading "---" separator like the actual email would show. */
  showDelimiter?: boolean
  /** Pass true when this preview is shown as a faded inline hint under the
   *  reply textarea. Switches the styling to a softer look. */
  faded?: boolean
  className?: string
}

/** Tiny markdown renderer — bold, italics, links, line breaks. Plain text
 *  otherwise. Intentionally avoids pulling in a markdown library since the
 *  rest of the codebase uses the same minimal subset. */
function renderInline(text: string): React.ReactNode {
  if (!text) return null
  // Match: **bold**, *italic*, [text](url), or http(s)://... auto-links.
  const tokens: React.ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s)]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(text.slice(last, m.index))
    if (m[1]) tokens.push(<strong key={`b-${key++}`}>{m[1]}</strong>)
    else if (m[2]) tokens.push(<em key={`i-${key++}`}>{m[2]}</em>)
    else if (m[3] && m[4]) {
      tokens.push(
        <a
          key={`a-${key++}`}
          href={m[4]}
          target="_blank"
          rel="noreferrer"
          className="text-teal-600 underline"
        >
          {m[3]}
        </a>,
      )
    } else if (m[5]) {
      tokens.push(
        <a
          key={`u-${key++}`}
          href={m[5]}
          target="_blank"
          rel="noreferrer"
          className="text-teal-600 underline"
        >
          {m[5]}
        </a>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) tokens.push(text.slice(last))
  return tokens
}

export function SignaturePreview({
  template,
  context,
  showDelimiter = false,
  faded = false,
  className,
}: Props) {
  const rendered = substituteSignatureVariables(template ?? '', {
    user: { id: 'preview', full_name: context.full_name, email: context.email },
    company: { name: context.company_name },
    date: new Date().toISOString().slice(0, 10),
  })

  const empty = rendered.trim().length === 0
  const baseTone = faded
    ? 'text-gray-400 italic'
    : empty
      ? 'text-gray-400 italic'
      : 'text-gray-700'

  return (
    <div className={className}>
      {showDelimiter && !empty && (
        <div className={`text-xs ${faded ? 'text-gray-300' : 'text-gray-400'} mb-1 select-none`}>
          --
        </div>
      )}
      <div className={`whitespace-pre-wrap text-sm leading-relaxed ${baseTone}`}>
        {empty ? (
          <span>No signature configured</span>
        ) : (
          rendered.split('\n').map((line, i) => (
            <span key={i}>
              {renderInline(line)}
              {i < rendered.split('\n').length - 1 && <br />}
            </span>
          ))
        )}
      </div>
    </div>
  )
}
