'use client'

import { useState, useEffect, useCallback } from 'react'
import { Settings2, Eye, EyeOff, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type WidgetKey =
  | 'kpis'
  | 'sla'
  | 'channels'
  | 'categories'
  | 'escalated'
  | 'activity'
  | 'accounts'
  | 'company'

interface WidgetConfig {
  key: WidgetKey
  label: string
  description: string
}

const ALL_WIDGETS: WidgetConfig[] = [
  { key: 'kpis', label: 'KPI Cards', description: 'Messages, pending replies, AI sent, response time, sentiment' },
  { key: 'sla', label: 'SLA & Spam', description: 'SLA performance metrics and spam filter count' },
  { key: 'channels', label: 'Channel Breakdown', description: 'Message volume by channel (Email, Teams, WhatsApp)' },
  { key: 'categories', label: 'Category Breakdown', description: 'Message distribution by category' },
  { key: 'escalated', label: 'Escalated Conversations', description: 'Conversations needing urgent attention' },
  { key: 'activity', label: 'Activity Feed', description: 'Recent system activity and events' },
  { key: 'accounts', label: 'Accounts Overview', description: 'All accounts with message stats' },
  { key: 'company', label: 'Company Performance', description: 'Per-company performance metrics table' },
]

const STORAGE_KEY = 'dashboard-widget-visibility'

const DEFAULT_VISIBLE: Set<WidgetKey> = new Set(ALL_WIDGETS.map(w => w.key))

function loadVisibility(): Set<WidgetKey> {
  if (typeof window === 'undefined') return new Set(DEFAULT_VISIBLE)
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as WidgetKey[]
      if (Array.isArray(parsed)) return new Set(parsed)
    }
  } catch {}
  return new Set(DEFAULT_VISIBLE)
}

function saveVisibility(visible: Set<WidgetKey>) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]))
}

export function useWidgetVisibility() {
  const [visible, setVisible] = useState<Set<WidgetKey>>(new Set(DEFAULT_VISIBLE))

  useEffect(() => {
    setVisible(loadVisibility())
  }, [])

  const isVisible = useCallback((key: WidgetKey) => visible.has(key), [visible])

  return { visible, setVisible, isVisible }
}

interface WidgetCustomizerProps {
  visible: Set<WidgetKey>
  onChange: (visible: Set<WidgetKey>) => void
}

export function WidgetCustomizer({ visible, onChange }: WidgetCustomizerProps) {
  const [open, setOpen] = useState(false)

  const toggle = (key: WidgetKey) => {
    const next = new Set(visible)
    if (next.has(key)) {
      // Don't allow hiding KPIs
      if (key === 'kpis') return
      next.delete(key)
    } else {
      next.add(key)
    }
    saveVisibility(next)
    onChange(next)
  }

  const resetAll = () => {
    saveVisibility(DEFAULT_VISIBLE)
    onChange(new Set(DEFAULT_VISIBLE))
  }

  const hiddenCount = ALL_WIDGETS.length - visible.size

  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(!open)}
        className="gap-1.5 text-xs"
      >
        <Settings2 size={14} />
        Customize
        {hiddenCount > 0 && (
          <span className="rounded-full bg-amber-100 text-amber-700 px-1.5 py-0 text-[10px] font-bold">
            {hiddenCount} hidden
          </span>
        )}
      </Button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-xl border border-gray-200 bg-white shadow-xl p-3 space-y-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-gray-700">Dashboard Widgets</span>
              <button
                onClick={resetAll}
                className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-teal-600 transition-colors"
              >
                <RotateCcw size={12} />
                Reset
              </button>
            </div>
            {ALL_WIDGETS.map(w => {
              const isOn = visible.has(w.key)
              const isLocked = w.key === 'kpis'
              return (
                <button
                  key={w.key}
                  onClick={() => toggle(w.key)}
                  disabled={isLocked}
                  className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                    isOn
                      ? 'bg-teal-50 hover:bg-teal-100'
                      : 'bg-gray-50 hover:bg-gray-100 opacity-60'
                  } ${isLocked ? 'cursor-default' : 'cursor-pointer'}`}
                >
                  {isOn ? (
                    <Eye size={16} className="shrink-0 text-teal-600" />
                  ) : (
                    <EyeOff size={16} className="shrink-0 text-gray-400" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-700 truncate">{w.label}</p>
                    <p className="text-[11px] text-gray-400 truncate">{w.description}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
