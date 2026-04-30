'use client'

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, type ButtonProps } from './button'

/**
 * Legacy action shape — an object with label + onClick. Kept so older callers
 * don't break. New callers should pass a ReactNode via the `action` prop.
 */
export interface EmptyStateLegacyAction {
  label: string
  onClick: () => void
  variant?: ButtonProps['variant']
}

export interface EmptyStateProps {
  /**
   * Icon to render in the header chip. Accepts either a LucideIcon component
   * (e.g. `icon={Inbox}`) for the new styled chip, or a ReactNode (e.g.
   * `icon={<Users className="h-12 w-12" />}`) for legacy callers.
   */
  icon?: LucideIcon | React.ReactNode
  title: string
  description?: string
  /**
   * Optional CTA. New callers pass a ReactNode (usually `<Button>...</Button>`).
   * Legacy callers may pass `{ label, onClick, variant }`.
   */
  action?: React.ReactNode | EmptyStateLegacyAction
  /** Optional secondary helper text shown below the action. */
  hint?: string
  className?: string
}

function isLucideIcon(icon: unknown): icon is LucideIcon {
  // Lucide icons are forwardRef components — test for the forwardRef sentinel
  // or the fact that it's a plain function/object that's not already a rendered
  // React element (which would have a $$typeof of Symbol(react.element)).
  if (!icon) return false
  if (typeof icon === 'function') return true
  // React elements have the $$typeof symbol; forwardRef objects look like
  // `{ $$typeof: Symbol(react.forward_ref), render: fn }`.
  if (typeof icon === 'object' && icon !== null) {
    const marker = (icon as { $$typeof?: symbol }).$$typeof
    if (marker && String(marker).includes('forward_ref')) return true
  }
  return false
}

function isLegacyAction(action: unknown): action is EmptyStateLegacyAction {
  return (
    typeof action === 'object' &&
    action !== null &&
    'label' in action &&
    'onClick' in action &&
    typeof (action as { onClick: unknown }).onClick === 'function'
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  hint,
  className,
}: EmptyStateProps) {
  // Render the icon — either wrap a LucideIcon in the styled chip, or render
  // a ReactNode as-is (with a muted color to keep the old look roughly intact).
  let iconNode: React.ReactNode = null
  if (icon) {
    if (isLucideIcon(icon)) {
      const Icon = icon as LucideIcon
      iconNode = (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400 ring-1 ring-gray-200">
          <Icon className="h-6 w-6" strokeWidth={1.75} />
        </div>
      )
    } else {
      iconNode = (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400 ring-1 ring-gray-200 [&_svg]:h-6 [&_svg]:w-6">
          {icon as React.ReactNode}
        </div>
      )
    }
  }

  // Render the action — either the legacy { label, onClick } shape or a
  // caller-supplied ReactNode.
  let actionNode: React.ReactNode = null
  if (action) {
    if (isLegacyAction(action)) {
      actionNode = (
        <Button
          variant={action.variant ?? 'primary'}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )
    } else {
      actionNode = action as React.ReactNode
    }
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-16 text-center',
        className
      )}
    >
      {iconNode && <div className="mb-5">{iconNode}</div>}
      <h3 className="text-lg font-semibold tracking-tight text-gray-900">
        {title}
      </h3>
      {description && (
        <p className="mx-auto mt-1.5 max-w-md text-sm text-gray-500">
          {description}
        </p>
      )}
      {actionNode && <div className="mt-5">{actionNode}</div>}
      {hint && (
        <p className="mt-3 text-xs text-gray-400">{hint}</p>
      )}
    </div>
  )
}
