'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, X, Loader2, Check } from 'lucide-react'
import { useToast } from '@/components/ui/toast'

interface SnoozeButtonProps {
  conversationId: string
  /** ISO string when this conversation is snoozed until, or null. */
  snoozedUntil: string | null
}

type Preset =
  | 'in_1h'
  | 'in_3h'
  | 'tomorrow_9am'
  | 'next_monday_9am'
  | 'in_3_days'
  | 'in_1_week'

const PRESETS: { key: Preset; label: string; sub: string }[] = [
  { key: 'in_1h', label: 'In 1 hour', sub: 'Quick follow-up' },
  { key: 'in_3h', label: 'In 3 hours', sub: 'Later today' },
  { key: 'tomorrow_9am', label: 'Tomorrow 9am', sub: 'Next morning (UTC)' },
  { key: 'next_monday_9am', label: 'Next Monday 9am', sub: 'Start of next week (UTC)' },
  { key: 'in_3_days', label: 'In 3 days', sub: 'Mid-week' },
  { key: 'in_1_week', label: 'In 1 week', sub: 'Long pause' },
]

/** Human-readable "until X" label from an ISO timestamp. */
function formatUntil(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function SnoozeButton({ conversationId, snoozedUntil }: SnoozeButtonProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const [busy, setBusy] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowCustom(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        setShowCustom(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const sendSnooze = useCallback(
    async (body: { preset?: Preset; until?: string }) => {
      setBusy(true)
      try {
        const res = await fetch(`/api/conversations/${conversationId}/snooze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error || 'Failed to snooze')
          return
        }
        toast.success(`Snoozed until ${formatUntil(data.snoozed_until)}`)
        setOpen(false)
        setShowCustom(false)
        setCustomValue('')
        router.refresh()
      } catch (err) {
        toast.error(`Snooze failed: ${(err as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [conversationId, router, toast]
  )

  const handlePreset = useCallback(
    (preset: Preset) => {
      void sendSnooze({ preset })
    },
    [sendSnooze]
  )

  const handleCustom = useCallback(() => {
    if (!customValue) {
      toast.warning('Pick a date and time first.')
      return
    }
    const d = new Date(customValue)
    if (Number.isNaN(d.getTime())) {
      toast.error('Invalid date/time')
      return
    }
    if (d.getTime() <= Date.now() + 60_000) {
      toast.error('Snooze time must be at least 1 minute from now.')
      return
    }
    void sendSnooze({ until: d.toISOString() })
  }, [customValue, sendSnooze, toast])

  const handleUnsnooze = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/snooze`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error || 'Failed to unsnooze')
        return
      }
      toast.success('Snooze cleared — conversation is back in your inbox')
      router.refresh()
    } catch (err) {
      toast.error(`Unsnooze failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [conversationId, router, toast])

  // Snoozed chip — show this in place of the dropdown trigger when active.
  if (snoozedUntil) {
    const untilLabel = formatUntil(snoozedUntil)
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 shadow-sm"
        title={`Snoozed until ${untilLabel} — cron will auto-resurface this conversation.`}
      >
        <Clock className="h-3 w-3" strokeWidth={2.5} />
        Snoozed until {untilLabel}
        <button
          type="button"
          onClick={handleUnsnooze}
          disabled={busy}
          aria-label="Unsnooze"
          title="Unsnooze and bring back to inbox"
          className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-amber-700 transition-colors hover:bg-amber-200 hover:text-amber-900 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" strokeWidth={2.5} />}
        </button>
      </span>
    )
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 disabled:opacity-50"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Snooze this conversation"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
        Snooze
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-[0_12px_36px_rgba(16,24,40,0.14),0_2px_6px_rgba(16,24,40,0.06)]">
          <div className="border-b border-gray-100 bg-gradient-to-b from-amber-50/40 to-transparent px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                <Clock className="h-3.5 w-3.5" strokeWidth={2.25} />
              </div>
              <div>
                <p className="text-[13px] font-semibold leading-tight text-gray-900">Snooze conversation</p>
                <p className="mt-0.5 text-[11px] text-gray-500">Hides until the chosen time, then re-opens.</p>
              </div>
            </div>
          </div>

          {!showCustom ? (
            <div className="py-1">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => handlePreset(p.key)}
                  disabled={busy}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-amber-50/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800">{p.label}</p>
                    <p className="text-[11px] text-gray-400">{p.sub}</p>
                  </div>
                  <Check className="h-3.5 w-3.5 flex-shrink-0 text-transparent" />
                </button>
              ))}
              <div className="my-1 border-t border-gray-100" />
              <button
                type="button"
                onClick={() => setShowCustom(true)}
                disabled={busy}
                className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-amber-50/60"
              >
                <p className="text-sm font-medium text-amber-700">Custom...</p>
                <span className="text-[10px] uppercase tracking-wider text-amber-500">Pick</span>
              </button>
            </div>
          ) : (
            <div className="space-y-3 px-4 py-3">
              <label htmlFor="snooze-custom" className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Snooze until
              </label>
              <input
                id="snooze-custom"
                type="datetime-local"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm tabular-nums text-gray-800 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCustom(false)}
                  disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleCustom}
                  disabled={busy || !customValue}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clock className="h-3 w-3" />}
                  Snooze
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
