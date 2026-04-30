'use client'

import { useMemo } from 'react'
import { useConversationPresence } from '@/hooks/useConversationPresence'

interface PresenceBarProps {
  conversationId: string
  currentUser: {
    user_id: string
    display_name: string
    avatar_url?: string | null
  }
}

/**
 * Soft chip palette — kept as static class strings so Tailwind 4's JIT
 * compiler can see every option. Extend by appending new entries; the order
 * doesn't matter, the picker is deterministic per user_id.
 */
const AVATAR_PALETTE = [
  { bg: 'bg-teal-500', ring: 'ring-teal-200' },
  { bg: 'bg-indigo-500', ring: 'ring-indigo-200' },
  { bg: 'bg-amber-500', ring: 'ring-amber-200' },
  { bg: 'bg-rose-500', ring: 'ring-rose-200' },
  { bg: 'bg-emerald-500', ring: 'ring-emerald-200' },
  { bg: 'bg-violet-500', ring: 'ring-violet-200' },
  { bg: 'bg-cyan-500', ring: 'ring-cyan-200' },
  { bg: 'bg-orange-500', ring: 'ring-orange-200' },
  { bg: 'bg-pink-500', ring: 'ring-pink-200' },
  { bg: 'bg-blue-500', ring: 'ring-blue-200' },
] as const

/** djb2-style hash → palette index. Stable across reloads/devices. */
function colorForUser(user_id: string): (typeof AVATAR_PALETTE)[number] {
  let hash = 5381
  for (let i = 0; i < user_id.length; i++) {
    hash = ((hash << 5) + hash) + user_id.charCodeAt(i)
    hash |= 0
  }
  const idx = Math.abs(hash) % AVATAR_PALETTE.length
  return AVATAR_PALETTE[idx]
}

function initialsFor(name: string): string {
  const cleaned = name.trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * Live "who else is here" stack rendered in the conversation header.
 *
 * Returns null if no other agents are present so the header doesn't keep an
 * empty slot. Stack uses the standard avatar-overlap pattern (-mx-1) with a
 * white ring for separation.
 */
export function PresenceBar({ conversationId, currentUser }: PresenceBarProps) {
  const { others } = useConversationPresence(conversationId, currentUser)

  // Sort deterministically so the chips don't reshuffle on every presence
  // sync (which would look jittery during typing).
  const sorted = useMemo(
    () => [...others].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    [others]
  )

  if (sorted.length === 0) return null

  return (
    <div
      className="flex items-center pl-1"
      aria-label={`${sorted.length} other agent${sorted.length === 1 ? '' : 's'} viewing`}
    >
      {sorted.map((u) => {
        const c = colorForUser(u.user_id)
        const status = u.composing ? 'composing…' : 'viewing now'
        return (
          <div
            key={u.user_id}
            className="relative -mx-1 first:ml-0"
            title={`${u.display_name} — ${status}`}
          >
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-full ${c.bg} text-[10px] font-semibold text-white ring-1 ring-white shadow-sm`}
            >
              {initialsFor(u.display_name)}
            </div>
            {u.composing && (
              <span
                className="pointer-events-none absolute -bottom-1 -right-1 inline-flex items-center gap-0.5 rounded-full bg-white px-1 py-0.5 ring-1 ring-gray-200 shadow-sm"
                aria-hidden
              >
                <span className="h-1 w-1 animate-pulse rounded-full bg-teal-500 [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-pulse rounded-full bg-teal-500 [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-pulse rounded-full bg-teal-500 [animation-delay:300ms]" />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
