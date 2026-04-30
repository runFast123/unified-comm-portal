'use client'

import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'dashboard-widget-order'

function loadOrder(defaultOrder: string[]): string[] {
  if (typeof window === 'undefined') return defaultOrder
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return defaultOrder
    const parsed = JSON.parse(stored) as unknown
    if (!Array.isArray(parsed)) return defaultOrder

    const defaultSet = new Set(defaultOrder)
    // Keep only ids that still exist in defaultOrder (strip removed widgets)
    const cleaned = parsed.filter(
      (id): id is string => typeof id === 'string' && defaultSet.has(id),
    )
    // Append any new ids from defaultOrder that the stored list doesn't have
    const cleanedSet = new Set(cleaned)
    for (const id of defaultOrder) {
      if (!cleanedSet.has(id)) cleaned.push(id)
    }
    return cleaned
  } catch {
    return defaultOrder
  }
}

function saveOrder(order: string[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
  } catch {}
}

export function useWidgetOrder(defaultOrder: string[]): {
  order: string[]
  setOrder: (next: string[]) => void
  resetOrder: () => void
} {
  // SSR-safe: initial state uses defaultOrder so server + first client paint match.
  const [order, setOrderState] = useState<string[]>(defaultOrder)

  useEffect(() => {
    const loaded = loadOrder(defaultOrder)
    setOrderState(loaded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If defaultOrder changes (new widget added to code), reconcile
  useEffect(() => {
    setOrderState((prev) => {
      const defaultSet = new Set(defaultOrder)
      const cleaned = prev.filter((id) => defaultSet.has(id))
      const cleanedSet = new Set(cleaned)
      for (const id of defaultOrder) {
        if (!cleanedSet.has(id)) cleaned.push(id)
      }
      // If identical, return prev to avoid re-renders
      if (
        cleaned.length === prev.length &&
        cleaned.every((v, i) => v === prev[i])
      ) {
        return prev
      }
      return cleaned
    })
  }, [defaultOrder])

  const setOrder = useCallback((next: string[]) => {
    setOrderState(next)
    saveOrder(next)
  }, [])

  const resetOrder = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {}
    }
    setOrderState(defaultOrder)
  }, [defaultOrder])

  return { order, setOrder, resetOrder }
}
