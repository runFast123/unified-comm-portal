'use client'

import { useEffect, useState } from 'react'
import {
  Inbox,
  Star,
  AlertTriangle,
  Users,
  MessageSquare,
  Tag,
  Clock,
  CheckCircle,
  type LucideIcon,
} from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { useUser } from '@/context/user-context'
import { cn } from '@/lib/utils'
import type { SavedView, SavedViewFilters } from '@/types/database'

/** Small curated set of lucide icons exposed in the picker. */
export const SAVED_VIEW_ICONS: Record<string, LucideIcon> = {
  Inbox,
  Star,
  AlertTriangle,
  Users,
  MessageSquare,
  Tag,
  Clock,
  CheckCircle,
}
export const SAVED_VIEW_ICON_NAMES = Object.keys(SAVED_VIEW_ICONS)

export function getSavedViewIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Inbox
  return SAVED_VIEW_ICONS[name] ?? Inbox
}

interface SavedViewModalProps {
  open: boolean
  onClose: () => void
  /** When provided we update; otherwise create. */
  view?: SavedView | null
  initialFilters?: SavedViewFilters
  onSaved?: (view: SavedView) => void
}

const channelOptions = [
  { value: 'all', label: 'All channels' },
  { value: 'email', label: 'Email' },
  { value: 'teams', label: 'Teams' },
  { value: 'whatsapp', label: 'WhatsApp' },
]
const statusOptions = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'waiting_on_customer', label: 'Waiting on customer' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'escalated', label: 'Escalated' },
]
const priorityOptions = [
  { value: 'all', label: 'All priorities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]
const sentimentOptions = [
  { value: 'all', label: 'All sentiments' },
  { value: 'positive', label: 'Positive' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'negative', label: 'Negative' },
]
const assigneeOptions = [
  { value: 'all', label: 'Anyone' },
  { value: 'me', label: 'Me' },
  { value: 'unassigned', label: 'Unassigned' },
]

export function SavedViewModal({
  open,
  onClose,
  view,
  initialFilters,
  onSaved,
}: SavedViewModalProps) {
  const { isAdmin } = useUser()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string>('Inbox')
  const [filters, setFilters] = useState<SavedViewFilters>({})
  const [isShared, setIsShared] = useState(false)
  const [saving, setSaving] = useState(false)

  // Reset form whenever the modal is (re)opened.
  useEffect(() => {
    if (!open) return
    if (view) {
      setName(view.name)
      setIcon(view.icon ?? 'Inbox')
      setFilters(view.filters ?? {})
      setIsShared(view.is_shared)
    } else {
      setName('')
      setIcon('Inbox')
      setFilters(initialFilters ?? {})
      setIsShared(false)
    }
  }, [open, view, initialFilters])

  const update = <K extends keyof SavedViewFilters>(key: K, value: SavedViewFilters[K]) => {
    setFilters((prev) => {
      const next = { ...prev }
      // Drop the key if the value is "all" (default), undefined, or empty string.
      if (value === undefined || value === '' || value === 'all') {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      const payload = {
        ...(view ? { id: view.id } : {}),
        name: trimmed,
        icon,
        filters,
        is_shared: isAdmin ? isShared : false,
      }
      const res = await fetch('/api/saved-views', {
        method: view ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Failed to save view')
        return
      }
      toast.success(view ? 'View updated' : 'View created')
      onSaved?.(data.view as SavedView)
      onClose()
    } catch (err) {
      toast.error('Failed to save: ' + (err instanceof Error ? err.message : 'network error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={view ? 'Edit saved view' : 'New saved view'}
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
            {view ? 'Save changes' : 'Create view'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Name */}
        <Input
          label="Name"
          placeholder="e.g. Urgent customer issues"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        {/* Icon picker */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Icon</label>
          <div className="flex flex-wrap gap-2">
            {SAVED_VIEW_ICON_NAMES.map((iconName) => {
              const IconComp = SAVED_VIEW_ICONS[iconName]
              const selected = iconName === icon
              return (
                <button
                  key={iconName}
                  type="button"
                  onClick={() => setIcon(iconName)}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                    selected
                      ? 'border-teal-500 bg-teal-50 text-teal-700 ring-1 ring-teal-200'
                      : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:bg-gray-50'
                  )}
                  title={iconName}
                  aria-label={`Icon: ${iconName}`}
                >
                  <IconComp className="h-5 w-5" />
                </button>
              )
            })}
          </div>
        </div>

        {/* Filter builder */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Channel</label>
            <Select
              options={channelOptions}
              value={filters.channel ?? 'all'}
              onChange={(e) => update('channel', e.target.value as SavedViewFilters['channel'])}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Status</label>
            <Select
              options={statusOptions}
              value={filters.status ?? 'all'}
              onChange={(e) => update('status', e.target.value as SavedViewFilters['status'])}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Priority</label>
            <Select
              options={priorityOptions}
              value={filters.priority ?? 'all'}
              onChange={(e) => update('priority', e.target.value as SavedViewFilters['priority'])}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Sentiment</label>
            <Select
              options={sentimentOptions}
              value={filters.sentiment ?? 'all'}
              onChange={(e) => update('sentiment', e.target.value as SavedViewFilters['sentiment'])}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Assignee</label>
            <Select
              options={assigneeOptions}
              value={filters.assignee ?? 'all'}
              onChange={(e) => update('assignee', e.target.value as SavedViewFilters['assignee'])}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Older than (hours)
            </label>
            <Input
              type="number"
              min={0}
              placeholder="e.g. 24"
              value={filters.age_hours_gt ?? ''}
              onChange={(e) => {
                const n = e.target.value === '' ? undefined : Number(e.target.value)
                update('age_hours_gt', n && n > 0 ? n : undefined)
              }}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Category
            </label>
            <Input
              placeholder="e.g. Trouble Ticket (leave blank for all)"
              value={filters.category ?? ''}
              onChange={(e) => update('category', e.target.value || undefined)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Search text</label>
            <Input
              placeholder="Subject, sender, or body keyword"
              value={filters.search ?? ''}
              onChange={(e) => update('search', e.target.value || undefined)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                checked={!!filters.unread_only}
                onChange={(e) => update('unread_only', e.target.checked || undefined)}
              />
              Only show unread / pending messages
            </label>
          </div>
        </div>

        {/* Share toggle (admin only) */}
        {isAdmin && (
          <div className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <input
              id="saved-view-shared"
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
            />
            <label htmlFor="saved-view-shared" className="text-sm text-gray-700">
              <span className="font-medium">Share with company</span>
              <p className="mt-0.5 text-xs text-gray-500">
                Other users will see this view in their sidebar.
              </p>
            </label>
          </div>
        )}
      </div>
    </Modal>
  )
}
