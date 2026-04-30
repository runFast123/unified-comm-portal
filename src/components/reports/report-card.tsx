import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface ReportCardProps {
  title: string
  description?: string
  /** Optional icon rendered as a small ringed chip beside the title. */
  icon?: LucideIcon
  /** Optional trailing content in the header (e.g. a filter dropdown or export button). */
  action?: React.ReactNode
  /**
   * Optional accent color for the icon chip. Accepts palette keys
   * ('teal' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'indigo' | 'gray').
   * Defaults to 'gray'.
   */
  accent?: 'teal' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'indigo' | 'gray'
  children: React.ReactNode
  className?: string
}

const ACCENT_CLASSES: Record<
  NonNullable<ReportCardProps['accent']>,
  { bg: string; text: string; ring: string }
> = {
  teal:   { bg: 'bg-teal-50',    text: 'text-teal-700',    ring: 'ring-teal-200' },
  blue:   { bg: 'bg-blue-50',    text: 'text-blue-700',    ring: 'ring-blue-200' },
  green:  { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-200' },
  amber:  { bg: 'bg-amber-50',   text: 'text-amber-700',   ring: 'ring-amber-200' },
  red:    { bg: 'bg-red-50',     text: 'text-red-700',     ring: 'ring-red-200' },
  purple: { bg: 'bg-violet-50',  text: 'text-violet-700',  ring: 'ring-violet-200' },
  indigo: { bg: 'bg-indigo-50',  text: 'text-indigo-700',  ring: 'ring-indigo-200' },
  gray:   { bg: 'bg-gray-100',   text: 'text-gray-700',    ring: 'ring-gray-200' },
}

export function ReportCard({
  title,
  description,
  icon: Icon,
  action,
  accent = 'gray',
  children,
  className,
}: ReportCardProps) {
  const a = ACCENT_CLASSES[accent]

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-gray-200/80 bg-white',
        'shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]',
        'transition-shadow hover:shadow-[0_4px_10px_rgba(16,24,40,0.06),0_2px_4px_rgba(16,24,40,0.04)]',
        className
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-gray-100 bg-gradient-to-b from-gray-50/50 to-transparent px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {Icon && (
            <div
              className={cn(
                'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ring-1',
                a.bg,
                a.text,
                a.ring
              )}
            >
              <Icon className="h-4 w-4" strokeWidth={2} />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold leading-tight text-gray-900">
              {title}
            </h3>
            {description && (
              <p className="mt-0.5 text-xs text-gray-500">{description}</p>
            )}
          </div>
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      <div className="px-6 py-5">{children}</div>
    </div>
  )
}
