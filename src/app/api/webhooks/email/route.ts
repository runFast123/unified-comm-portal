import { NextResponse, after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { logInfo, logError } from '@/lib/logger'
import {
  validateWebhookSecret,
  findOrCreateConversation,
  getAccountSettings,
  stripHtml,
  checkRateLimit,
} from '@/lib/api-helpers'
import { detectSpam } from '@/lib/spam-detection'
import { evaluateRouting, applyRoutingResult } from '@/lib/routing-engine'
import { getRequestId, REQUEST_ID_HEADER } from '@/lib/request-id'

export async function POST(request: Request) {
  const requestId = await getRequestId()
  try {
    // Validate webhook secret
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
    }

    const body = await request.json()
    const { sender, subject, body: emailBody, thread_id, account_id, attachments } = body

    // Parse RFC 5322 format: "Display Name" <email@addr> or just email@addr
    const emailMatch = sender ? sender.match(/<([^>]+)>/) : null
    const senderEmail = emailMatch ? emailMatch[1].trim() : (sender || null)
    const senderName = emailMatch
      ? sender.slice(0, sender.indexOf('<')).trim().replace(/^["']|["']$/g, '') || senderEmail
      : sender || null

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing required field: account_id', request_id: requestId },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!(await checkRateLimit(`webhook:email:${account_id}`, 100, 60))) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Try again later.', request_id: requestId },
        { status: 429 }
      )
    }

    if (!sender || (typeof sender === 'string' && sender.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Missing or empty required field: sender', request_id: requestId },
        { status: 400 }
      )
    }

    // Strip HTML from email body and truncate if too large
    const MAX_MESSAGE_LENGTH = 50000 // 50KB max
    let plainTextBody = emailBody ? stripHtml(emailBody) : ''
    if (plainTextBody.length > MAX_MESSAGE_LENGTH) {
      plainTextBody = plainTextBody.substring(0, MAX_MESSAGE_LENGTH) + '... [truncated]'
    }

    const supabase = await createServiceRoleClient()

    // Verify account exists and is active
    const { data: accountRow, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, is_active, spam_detection_enabled, spam_allowlist')
      .eq('id', account_id)
      .single()

    if (accountError || !accountRow) {
      return NextResponse.json(
        { error: 'Account not found', request_id: requestId },
        { status: 404 }
      )
    }

    if (!accountRow.is_active) {
      return NextResponse.json(
        { error: 'Account is not active', request_id: requestId },
        { status: 403 }
      )
    }

    // Dedup check: skip if exact same message text was received recently (within 5 minutes) for this account
    // Note: thread_id is NOT used for dedup because multiple messages share the same thread
    if (plainTextBody && plainTextBody.trim().length > 0) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('channel', 'email')
        .eq('direction', 'inbound')
        .like('message_text', plainTextBody.substring(0, 100).replace(/%/g, '\\%').replace(/_/g, '\\_') + '%')
        .gte('timestamp', fiveMinAgo)
        .limit(1)
        .maybeSingle()

      if (existingMsg) {
        return NextResponse.json(
          { message: 'Duplicate - already processed', message_id: existingMsg.id },
          { status: 200 }
        )
      }
    }

    // Spam detection — run before storing. Honours per-account overrides:
    //   spam_detection_enabled=false -> always {isSpam:false}
    //   spam_allowlist sender substring match -> always {isSpam:false}
    const spamResult = detectSpam(senderEmail, subject, plainTextBody, {
      enabled: accountRow.spam_detection_enabled ?? true,
      allowlist: (accountRow.spam_allowlist as string[]) ?? [],
    })

    // Find or create conversation
    const conversationId = await findOrCreateConversation(supabase, {
      account_id,
      channel: 'email',
      participant_name: senderName,
      participant_email: senderEmail,
    })

    // Store message in messages table (spam is stored but flagged)
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
        channel: 'email',
        sender_name: senderName || sender || null,
        sender_type: 'customer',
        message_text: plainTextBody,
        message_type: 'text',
        direction: 'inbound',
        email_subject: subject || null,
        email_thread_id: thread_id || null,
        attachments: attachments || null,
        replied: false,
        reply_required: spamResult.isSpam ? false : true,
        is_spam: spamResult.isSpam,
        spam_reason: spamResult.reason,
        timestamp: new Date().toISOString(),
        received_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (msgError || !message) {
      logError('webhook', 'email_store_failed', msgError?.message || 'unknown insert failure', {
        request_id: requestId,
        account_id,
      })
      return NextResponse.json(
        { error: 'Failed to store message', request_id: requestId },
        { status: 500 }
      )
    }

    // Routing rules — evaluate AFTER message stored, BEFORE AI dispatch.
    // Skip entirely for spam to avoid mutating spam threads. Fail-soft so
    // a routing-engine error never blocks ingest.
    if (!spamResult.isSpam) {
      try {
        const routingResult = await evaluateRouting({
          channel: 'email',
          account_id,
          sender_email: senderEmail,
          sender_phone: null,
          subject: subject || null,
          message_text: plainTextBody,
        })
        if (routingResult.matched_rule_ids.length > 0) {
          const applied = await applyRoutingResult(supabase, conversationId, routingResult)
          logInfo('webhook', 'rule_matched', `Routing matched ${routingResult.matched_rule_ids.length} rule(s)`, {
            request_id: requestId,
            account_id,
            message_id: message.id,
            conversation_id: conversationId,
            matched_rule_ids: routingResult.matched_rule_ids,
            applied,
          })
        }
      } catch (routingErr) {
        logError('webhook', 'routing_failed', routingErr instanceof Error ? routingErr.message : 'unknown', {
          request_id: requestId,
          account_id,
          message_id: message.id,
        })
      }
    }

    // Trigger email notifications (async, non-blocking)
    if (!spamResult.isSpam) {
      try {
        const { triggerNotifications } = await import('@/lib/notification-service')
        triggerNotifications(supabase, {
          id: message.id,
          conversation_id: conversationId,
          account_id: account_id,
          account_name: accountRow.name || 'Unknown',
          channel: 'email',
          sender_name: senderName || senderEmail,
          email_subject: subject || null,
          message_text: plainTextBody?.substring(0, 200) || null,
          is_spam: spamResult.isSpam,
        }).catch(err => console.error('Notification trigger failed:', err))
      } catch (notifErr) {
        console.error('Failed to load notification service:', notifErr)
      }
    }

    // Skip AI processing for spam messages (save costs)
    if (!spamResult.isSpam) {
      const account = await getAccountSettings(supabase, account_id)
      const origin = new URL(request.url).origin
      // Forward the request id so /api/classify and /api/ai-reply log under
      // the same correlation id as this webhook — one inbound email's
      // journey shows up as a single thread in logs/Sentry.
      const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
        [REQUEST_ID_HEADER]: requestId,
      }

      // Phase 1 + Phase 2 are fired asynchronously so the webhook returns
      // as soon as the message is stored. The inbound poller can then move
      // to the next email without waiting for AI (which can take 30s+).
      // Trade-off: if classify later flags this message as Newsletter/Marketing,
      // the AI reply still runs (sits in pending_approval — admin can reject).
      // Use Next's `after()` so Vercel keeps the function alive until these
      // fetches complete — `void fetch(...)` gets killed when the serverless
      // instance terminates after the response is sent, dropping classify/AI
      // coverage on production (classify in particular can take 30s+).
      if (account.phase1_enabled) {
        after(() =>
          fetch(`${origin}/api/classify`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              message_id: message.id,
              message_text: plainTextBody,
              channel: 'email',
              account_id,
            }),
          }).catch((err) =>
            console.error(
              `Phase 1 classify dispatch failed [message_id=${message.id}]:`,
              err instanceof Error ? err.message : err
            )
          )
        )
      }

      if (account.phase2_enabled) {
        after(() =>
          fetch(`${origin}/api/ai-reply`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              message_id: message.id,
              message_text: plainTextBody,
              channel: 'email',
              account_id,
              conversation_id: conversationId,
            }),
          }).catch((err) =>
            console.error(
              `Phase 2 AI reply dispatch failed [message_id=${message.id}]:`,
              err instanceof Error ? err.message : err
            )
          )
        )
      }
    }

    logInfo('webhook', 'email_received', `Email from ${senderEmail}`, {
      request_id: requestId,
      account_id,
      message_id: message.id,
      is_spam: spamResult.isSpam,
    })
    return NextResponse.json(
      { message_id: message.id, is_spam: spamResult.isSpam, request_id: requestId },
      { status: 201 }
    )
  } catch (error) {
    logError('webhook', 'email_error', error instanceof Error ? error.message : 'Unknown error', {
      request_id: requestId,
    })
    return NextResponse.json(
      { error: 'Internal server error', request_id: requestId },
      { status: 500 }
    )
  }
}
