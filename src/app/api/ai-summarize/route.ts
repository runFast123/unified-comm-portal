import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { callAI, verifyAccountAccess } from '@/lib/api-helpers'
import { AIBudgetExceededError } from '@/lib/ai-usage'
import { logError } from '@/lib/logger'

const SYSTEM_PROMPT = `You are a customer support assistant. Summarize this conversation in 2-3 short sentences.
Focus on: what the customer needs, any action already taken, and the current status (waiting / resolved / blocked).
Be concrete. No filler phrases.`

export async function POST(request: Request) {
  // Session auth
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { conversation_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const conversationId = body.conversation_id
  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'conversation_id required' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Look up conversation to know its account, then enforce scoping for non-admins
  const { data: conversation, error: convError } = await admin
    .from('conversations')
    .select('id, account_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // verifyAccountAccess returns true for admins unconditionally, and for
  // non-admins only when the account belongs to their company.
  const hasAccess = await verifyAccountAccess(user.id, conversation.account_id)
  if (!hasAccess) {
    return NextResponse.json({ error: 'Access denied to this conversation' }, { status: 403 })
  }

  // Fetch last 30 messages in timestamp order
  const { data: messages, error: msgError } = await admin
    .from('messages')
    .select('sender_name, direction, message_text, timestamp')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(30)

  if (msgError) {
    return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 })
  }

  if (!messages || messages.length < 2) {
    return NextResponse.json(
      { error: 'Need at least 2 messages to summarize' },
      { status: 400 }
    )
  }

  // Oldest-first for the prompt
  const ordered = [...messages].reverse()
  const transcript = ordered
    .map((m) => {
      const name = (m.sender_name || '').toString().trim() || 'Unknown'
      const dir = m.direction === 'outbound' ? 'agent' : 'customer'
      const text = (m.message_text || '').toString().replace(/\s+/g, ' ').trim().slice(0, 600)
      return `[${name} (${dir})]: ${text}`
    })
    .join('\n')

  const userMessage = `Conversation:\n${transcript}`

  try {
    const summary = await callAI(SYSTEM_PROMPT, userMessage, {
      account_id: conversation.account_id,
      endpoint: 'ai-summarize',
    })
    const cleaned = (summary || '').trim()
    if (!cleaned) {
      return NextResponse.json({ summary: null, error: 'Empty summary' }, { status: 200 })
    }
    return NextResponse.json({ summary: cleaned })
  } catch (err) {
    if (err instanceof AIBudgetExceededError) {
      logError('ai', 'budget_exceeded_summarize', err.message, {
        account_id: conversation.account_id,
        conversation_id: conversationId,
        monthly_total_usd: err.monthly_total_usd,
        budget_usd: err.budget_usd,
      })
      return NextResponse.json(
        {
          summary: null,
          error: 'AI budget exceeded for this account',
          skipped: true,
          monthly_total_usd: err.monthly_total_usd,
          budget_usd: err.budget_usd,
          retry_after: 'next month',
        },
        { status: 200 }
      )
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isTimeout = /abort|timeout/i.test(message)
    logError('ai', 'summarize_failed', message, { conversation_id: conversationId })
    // Graceful fallback — 200 so the UI can render a soft error
    return NextResponse.json(
      {
        summary: null,
        error: isTimeout ? 'AI timed out' : 'AI call failed',
      },
      { status: 200 }
    )
  }
}
