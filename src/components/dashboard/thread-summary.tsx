'use client'

import { useState } from 'react'
import { Sparkles, RefreshCw, Loader2, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ThreadSummaryProps {
  conversationId: string
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'summary'; text: string }
  | { kind: 'error'; message: string }

export function ThreadSummary({ conversationId }: ThreadSummaryProps) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  const generate = async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch('/api/ai-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId }),
      })

      const json = (await res.json().catch(() => null)) as
        | { summary?: string | null; error?: string }
        | null

      if (!res.ok) {
        setState({
          kind: 'error',
          message: json?.error || `Request failed (${res.status})`,
        })
        return
      }

      if (json?.summary) {
        setState({ kind: 'summary', text: json.summary })
      } else {
        setState({
          kind: 'error',
          message: json?.error || 'No summary was generated',
        })
      }
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <Sparkles size={16} className="text-violet-600" />
        <h3 className="flex-1 text-left text-sm font-semibold text-gray-900">
          Thread Summary
        </h3>
        {state.kind === 'summary' && (
          <button
            type="button"
            onClick={generate}
            aria-label="Regenerate summary"
            title="Regenerate"
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-violet-700"
          >
            <RefreshCw size={13} />
          </button>
        )}
      </div>

      <div className="border-t border-gray-100 px-4 py-3">
        {state.kind === 'idle' && (
          <button
            type="button"
            onClick={generate}
            className={cn(
              'inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
              'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
              'transition-colors hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400'
            )}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Summarize thread
          </button>
        )}

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center gap-2 rounded-xl bg-violet-50 px-3 py-3 text-xs text-violet-700 ring-1 ring-violet-200">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Summarizing conversation...
          </div>
        )}

        {state.kind === 'summary' && (
          <div className="rounded-xl bg-violet-50 p-3 text-sm leading-relaxed text-violet-900 ring-1 ring-violet-200">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-violet-500">
              AI summary
            </p>
            {state.text}
          </div>
        )}

        {state.kind === 'error' && (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>{state.message}</span>
            </div>
            <button
              type="button"
              onClick={generate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200 transition-colors hover:bg-violet-100"
            >
              <RefreshCw className="h-3 w-3" />
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
