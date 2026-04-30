'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, X, Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/toast'

interface ScheduledMessage {
  id: string
  conversation_id: string
  channel: string
  reply_text: string
  scheduled_for: string
  to_address: string | null
  subject: string | null
  teams_chat_id: string | null
  created_at: string
}

interface ScheduledMessagesListProps {
  conversationId: string
}

/** Short "in 3h", "in 2d", "in 45m" relative label. */
function relativeFromNow(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'any moment now'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours}h`
  const days = Math.round(hours / 24)
  return `in ${days}d`
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ScheduledMessagesList({ conversationId }: ScheduledMessagesListProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [items, setItems] = useState<ScheduledMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/scheduled-messages?conversation_id=${encodeURIComponent(conversationId)}`,
        { cache: 'no-store' }
      )
      if (!res.ok) throw new Error('Failed to load scheduled messages')
      const json = await res.json()
      setItems(Array.isArray(json.items) ? json.items : [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    fetchItems()
    // Listen for in-page "new scheduled send" events so the list refreshes
    // immediately after the user schedules via the modal.
    const onScheduled = () => fetchItems()
    window.addEventListener('scheduled-message-created', onScheduled)
    return () => window.removeEventListener('scheduled-message-created', onScheduled)
  }, [fetchItems])

  const handleCancel = useCallback(
    async (id: string) => {
      setCancelling(id)
      try {
        const res = await fetch(`/api/scheduled-messages/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          let msg = ''
          try {
            const j = await res.json()
            msg = j?.error ? ` (${j.error})` : ''
          } catch { /* non-JSON */ }
          throw new Error(`Cancel failed${msg}`)
        }
        setItems((prev) => prev.filter((x) => x.id !== id))
        toast.success('Scheduled send cancelled')
        router.refresh()
      } catch (err) {
        toast.error((err as Error).message)
      } finally {
        setCancelling(null)
      }
    },
    [router, toast]
  )

  if (loading) return null
  if (items.length === 0) return null

  return (
    <div className="rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
      <div className="flex items-center gap-2 border-b border-gray-100 bg-gradient-to-b from-indigo-50/40 to-transparent px-5 py-3">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200">
          <Clock className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Scheduled
        </p>
        <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200 tabular-nums">
          {items.length}
        </span>
      </div>

      <ul className="divide-y divide-gray-100">
        {items.map((item) => {
          const preview = item.reply_text.length > 80
            ? item.reply_text.slice(0, 80).trimEnd() + '…'
            : item.reply_text
          const rel = relativeFromNow(item.scheduled_for)
          const abs = formatAbsolute(item.scheduled_for)
          const isCancelling = cancelling === item.id
          return (
            <li key={item.id} className="flex items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-800 line-clamp-2">{preview}</p>
                <p className="mt-1 text-[11px] text-gray-500 tabular-nums">
                  Will send {rel}
                  <span className="text-gray-300"> &middot; </span>
                  <span className="text-gray-500">{abs}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleCancel(item.id)}
                disabled={isCancelling}
                aria-label="Cancel scheduled send"
                title="Cancel scheduled send"
                className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 ring-1 ring-gray-200 transition-colors hover:bg-red-50 hover:text-red-600 hover:ring-red-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCancelling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
