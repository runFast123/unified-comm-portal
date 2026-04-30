'use client'

import { useState, useRef } from 'react'
import { Copy, Check } from 'lucide-react'

interface CopyFieldProps {
  label: string
  value: string
  helpText?: string
}

export function CopyField({ label, value, helpText }: CopyFieldProps) {
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleCopy = async () => {
    // Guard: navigator.clipboard is unavailable in SSR and insecure (http) contexts.
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        return
      } catch {
        // fall through to manual-select fallback
      }
    }
    // Manual-select fallback — highlights the value so the user can Ctrl+C.
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }

  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 ring-1 ring-gray-200">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={value}
          title={value}
          className="flex-1 truncate bg-transparent font-mono text-xs tabular-nums text-gray-800 outline-none"
        />
        <button
          type="button"
          onClick={handleCopy}
          className={
            copied
              ? 'inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200'
              : 'inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-100'
          }
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      {helpText && (
        <div className="mt-1 text-[11px] text-gray-500">{helpText}</div>
      )}
    </div>
  )
}
