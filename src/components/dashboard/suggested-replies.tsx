'use client'

import { useState, useEffect } from 'react'
import { Sparkles, FileText, Loader2, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SuggestedRepliesProps {
  conversationId: string
  latestMessage: string | null
  category: string | null
  onInsert?: (text: string) => void
}

export function SuggestedReplies({ conversationId, latestMessage, category, onInsert }: SuggestedRepliesProps) {
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([])
  const [templates, setTemplates] = useState<{ id: string; title: string; content: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const handleInsert = (text: string) => {
    if (onInsert) {
      onInsert(text)
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 2000)
    }
  }

  useEffect(() => {
    if (!latestMessage || loaded) return
    setLoading(true)
    fetch('/api/suggest-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, message_text: latestMessage, category }),
    })
      .then(res => res.json())
      .then(data => {
        setAiSuggestions(data.ai_suggestions || [])
        setTemplates(data.templates || [])
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
      .finally(() => setLoading(false))
  }, [conversationId, latestMessage, category, loaded])

  if (!latestMessage) return null

  return (
    <div className="border-t border-gray-100 px-4 py-2">
      <div className="flex items-center gap-4 overflow-x-auto pb-1">
        {loading && (
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Generating suggestions...
          </div>
        )}

        {/* AI suggestions */}
        {aiSuggestions.map((s, i) => (
          <button
            key={`ai-${i}`}
            onClick={() => handleInsert(s)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs text-teal-700 hover:bg-teal-100 transition-colors max-w-[250px]"
            title={s}
          >
            <Sparkles className="h-3 w-3 shrink-0" />
            <span className="truncate">{s.substring(0, 60)}{s.length > 60 ? '...' : ''}</span>
          </button>
        ))}

        {/* Template suggestions */}
        {templates.map((t) => (
          <button
            key={`t-${t.id}`}
            onClick={() => handleInsert(t.content)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs text-purple-700 hover:bg-purple-100 transition-colors max-w-[200px]"
            title={t.content}
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{t.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
