'use client'

import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

interface DraggableWidgetProps {
  id: string
  enabled: boolean
  children: ReactNode
}

export function DraggableWidget({ id, enabled, children }: DraggableWidgetProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !enabled })

  // When drag is disabled, keep layout neutral (no wrapper styling) so the
  // dashboard looks exactly like it used to.
  if (!enabled) {
    return <>{children}</>
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={[
        'group relative rounded-2xl',
        'outline outline-1 outline-dashed outline-gray-300 outline-offset-2',
        'transition-[box-shadow,transform] duration-200',
        isDragging
          ? 'z-20 scale-[1.01] shadow-[0_12px_32px_rgba(16,24,40,0.18),0_4px_8px_rgba(16,24,40,0.08)]'
          : 'shadow-none hover:outline-teal-300',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}

      {/* Drag handle — absolute top-right */}
      <button
        type="button"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        {...listeners}
        className={[
          'absolute top-3 right-3 z-10',
          'rounded-lg bg-white ring-1 ring-gray-200 p-1',
          'text-gray-500 hover:text-gray-700 hover:ring-gray-300',
          'shadow-sm',
          'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
          isDragging ? 'opacity-100 cursor-grabbing' : 'cursor-grab',
        ].join(' ')}
      >
        <GripVertical className="h-4 w-4" />
      </button>
    </div>
  )
}
