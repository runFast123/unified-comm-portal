'use client'

import type { ReactNode } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { DraggableWidget } from './draggable-widget'

interface DashboardWidgetGridProps {
  order: string[]
  onOrderChange: (next: string[]) => void
  reorderMode: boolean
  widgets: Record<string, ReactNode>
}

export function DashboardWidgetGrid({
  order,
  onOrderChange,
  reorderMode,
  widgets,
}: DashboardWidgetGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Small activation distance so clicks on KPI cards still work when
      // reorder mode is off (though handle catches listeners regardless).
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = order.indexOf(active.id as string)
    const newIndex = order.indexOf(over.id as string)
    if (oldIndex < 0 || newIndex < 0) return
    onOrderChange(arrayMove(order, oldIndex, newIndex))
  }

  // Render in current order. Falsy widgets (hidden by visibility gate) are
  // skipped in output but their slot is preserved in `order`.
  const items = order

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="space-y-6">
          {items.map((id) => {
            const node = widgets[id]
            if (!node) return null
            return (
              <DraggableWidget key={id} id={id} enabled={reorderMode}>
                {node}
              </DraggableWidget>
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
}
