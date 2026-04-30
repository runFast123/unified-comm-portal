'use client'

/**
 * Per-user email-signature management.
 *
 *   - Markdown-style textarea (no library — we keep the editor as a plain
 *     textarea on purpose; signatures rarely need rich formatting).
 *   - "Use my signature" toggle. When off, the company default takes over
 *     (or no signature at all if the company has none).
 *   - Live preview pane on the right showing variable substitution against
 *     the current viewer's context.
 *   - Save -> POST /api/users/signature.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { useToast } from '@/components/ui/toast'
import { SignaturePreview } from '@/components/dashboard/signature-preview'
import { Loader2, Save, Info } from 'lucide-react'

interface SignaturePayload {
  user: {
    email_signature: string | null
    email_signature_enabled: boolean
    full_name: string | null
    email: string | null
  }
  company: {
    name: string | null
    default_email_signature: string | null
  }
  resolved: string | null
}

const DEFAULT_TEMPLATE = `**{{user.full_name}}**
{{company.name}}
{{user.email}}`

export default function SignaturePage() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<SignaturePayload | null>(null)
  const [text, setText] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [dirty, setDirty] = useState(false)

  // Load current value
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const res = await fetch('/api/users/signature')
        if (!res.ok) {
          let errMsg = 'Failed to load signature'
          try {
            const j = await res.json()
            if (j?.error) errMsg = j.error
          } catch { /* non-JSON */ }
          throw new Error(errMsg)
        }
        const json = (await res.json()) as SignaturePayload
        if (cancelled) return
        setData(json)
        setText(json.user.email_signature ?? '')
        setEnabled(json.user.email_signature_enabled)
      } catch (err) {
        if (!cancelled) toast.error((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [toast])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/users/signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_signature: text.length > 0 ? text : null,
          email_signature_enabled: enabled,
        }),
      })
      if (!res.ok) {
        let errMsg = 'Failed to save'
        try {
          const j = await res.json()
          if (j?.error) errMsg = j.error
        } catch { /* non-JSON */ }
        throw new Error(errMsg)
      }
      toast.success('Signature saved')
      setDirty(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [text, enabled, toast])

  const handleInsertTemplate = useCallback(() => {
    setText(DEFAULT_TEMPLATE)
    setDirty(true)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <span className="ml-3 text-gray-500">Loading signature settings...</span>
      </div>
    )
  }

  // Decide which template the live preview should reflect:
  //   - If the user has signatures enabled and a non-empty template: theirs.
  //   - Otherwise the company default (read-only context).
  const effectiveTemplate =
    enabled && text.trim().length > 0
      ? text
      : data?.company.default_email_signature ?? ''

  const previewContext = {
    full_name: data?.user.full_name ?? null,
    email: data?.user.email ?? null,
    company_name: data?.company.name ?? null,
  }

  const showCompanyFallbackHint =
    (!enabled || text.trim().length === 0) &&
    (data?.company.default_email_signature?.trim().length ?? 0) > 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Email Signature</h1>
        <p className="mt-1 text-sm text-gray-500">
          Auto-appended to every outbound email you send. Falls back to your
          company&apos;s default when you turn yours off.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Editor column */}
        <Card>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Use my signature</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  When off, the company default (if any) is used instead.
                </p>
              </div>
              <Toggle
                checked={enabled}
                onChange={(v) => {
                  setEnabled(v)
                  setDirty(true)
                }}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-gray-700">Signature (markdown)</label>
                {text.length === 0 && (
                  <button
                    type="button"
                    onClick={handleInsertTemplate}
                    className="text-xs text-teal-600 hover:text-teal-800 font-medium"
                  >
                    Insert default template
                  </button>
                )}
              </div>
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setDirty(true)
                }}
                rows={12}
                placeholder={`e.g.\n**Jane Doe**\nSupport Manager — Acme Corp\njane@acme.com`}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none resize-y"
                disabled={!enabled}
              />
              <p className="mt-2 text-xs text-gray-500">
                Variables: <code className="bg-gray-100 px-1 py-0.5 rounded">{'{{user.full_name}}'}</code>{' '}
                <code className="bg-gray-100 px-1 py-0.5 rounded">{'{{user.email}}'}</code>{' '}
                <code className="bg-gray-100 px-1 py-0.5 rounded">{'{{company.name}}'}</code>{' '}
                <code className="bg-gray-100 px-1 py-0.5 rounded">{'{{date}}'}</code>
              </p>
            </div>

            {showCompanyFallbackHint && (
              <div className="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-700">
                <Info size={14} className="shrink-0 mt-0.5" />
                <span>
                  Your company has a default signature configured. The preview on
                  the right shows what will be sent.
                </span>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-gray-100">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={saving}
                disabled={!dirty || saving}
              >
                <Save size={14} />
                {saving ? 'Saving...' : 'Save signature'}
              </Button>
            </div>
          </div>
        </Card>

        {/* Preview column */}
        <Card>
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Live preview</h2>
            <p className="text-xs text-gray-500">
              How recipients will see your signature, with variables resolved.
            </p>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <SignaturePreview
                template={effectiveTemplate}
                context={previewContext}
                showDelimiter
              />
            </div>

            {/* Source label so the agent knows which template is rendered */}
            <p className="text-[11px] text-gray-400">
              {enabled && text.trim().length > 0
                ? 'Source: your personal signature'
                : (data?.company.default_email_signature?.trim().length ?? 0) > 0
                  ? `Source: company default (${data?.company.name ?? '—'})`
                  : 'Source: none — no signature will be appended'}
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
