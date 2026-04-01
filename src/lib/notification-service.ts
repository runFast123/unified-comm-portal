/**
 * Notification Service
 * Fetches matching notification rules and sends email notifications
 * directly via SMTP (nodemailer) for incoming messages.
 * Runs fire-and-forget (non-blocking).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'

export interface NotificationMessageData {
  id: string
  conversation_id: string
  account_id: string
  account_name: string
  channel: 'email' | 'teams' | 'whatsapp'
  sender_name: string | null
  email_subject: string | null
  message_text: string | null
  is_spam: boolean
  priority?: 'low' | 'medium' | 'high' | 'urgent'
}

const PRIORITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'urgent': return '#dc2626'
    case 'high': return '#ea580c'
    case 'medium': return '#2563eb'
    case 'low': return '#16a34a'
    default: return '#2563eb'
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Trigger email notifications for a new message.
 * Sends emails directly via SMTP instead of calling an internal API endpoint.
 */
export async function triggerNotifications(
  supabase: SupabaseClient,
  messageData: NotificationMessageData
): Promise<void> {
  try {
    if (messageData.is_spam) return

    const { data: rules, error } = await supabase
      .from('notification_rules')
      .select('*')
      .eq('is_active', true)

    if (error || !rules || rules.length === 0) return

    const messagePriority = messageData.priority || 'medium'
    const messagePriorityValue = PRIORITY_ORDER[messagePriority] ?? 1

    const matchingRules = rules.filter((rule: Record<string, unknown>) => {
      if (rule.channel && rule.channel !== messageData.channel) return false
      if (rule.account_id && rule.account_id !== messageData.account_id) return false
      const ruleMinPriority = PRIORITY_ORDER[rule.min_priority as string] ?? 1
      if (messagePriorityValue < ruleMinPriority) return false
      return true
    })

    if (matchingRules.length === 0) return

    const smtpUser = process.env.SMTP_USER
    const smtpPassword = process.env.SMTP_PASSWORD
    if (!smtpUser || !smtpPassword) {
      console.error('SMTP_USER or SMTP_PASSWORD not configured — skipping email notifications')
      return
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: smtpUser, pass: smtpPassword },
    })

    const portalUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://unified-comm-portal.vercel.app'
    const messagePreview = messageData.message_text?.substring(0, 200) || '(no content)'
    const priorityLabel = messagePriority.toUpperCase()
    const channelLabel = messageData.channel.charAt(0).toUpperCase() + messageData.channel.slice(1)
    const conversationUrl = `${portalUrl}/conversations/${messageData.conversation_id}`

    const emailPromises = matchingRules
      .filter((rule: Record<string, unknown>) => rule.notify_email && rule.notify_email_address)
      .map(async (rule: Record<string, unknown>) => {
        try {
          await transporter.sendMail({
            from: `"Unified Comms Portal" <${smtpUser}>`,
            to: rule.notify_email_address as string,
            subject: `[${priorityLabel}] New message from ${messageData.sender_name || 'Unknown'} — ${messageData.account_name}`,
            html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
  <div style="background:#1e293b;padding:16px 24px;"><h1 style="margin:0;color:#fff;font-size:16px;">Unified Comms Portal</h1></div>
  <div style="padding:20px 24px;">
    <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;color:#fff;background:${getPriorityColor(messagePriority)};">${priorityLabel}</span>
    <h2 style="margin:12px 0 16px;font-size:15px;color:#1e293b;">New message received</h2>
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#64748b;width:100px;">From</td><td style="padding:6px 0;color:#1e293b;font-weight:500;">${escapeHtml(messageData.sender_name || 'Unknown')}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">Account</td><td style="padding:6px 0;color:#1e293b;">${escapeHtml(messageData.account_name)}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">Channel</td><td style="padding:6px 0;color:#1e293b;">${channelLabel}</td></tr>
      ${messageData.email_subject ? `<tr><td style="padding:6px 0;color:#64748b;">Subject</td><td style="padding:6px 0;color:#1e293b;">${escapeHtml(messageData.email_subject)}</td></tr>` : ''}
    </table>
    <div style="background:#f8fafc;border-left:3px solid #3b82f6;padding:10px 14px;margin:16px 0;border-radius:0 4px 4px 0;">
      <p style="margin:0 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;">Preview</p>
      <p style="margin:0;font-size:13px;color:#334155;line-height:1.5;">${escapeHtml(messagePreview)}</p>
    </div>
    <a href="${conversationUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:500;">View Conversation</a>
  </div>
  <div style="padding:12px 24px;border-top:1px solid #e2e8f0;"><p style="margin:0;font-size:11px;color:#94a3b8;">Unified Communication Portal notification</p></div>
</div>`.trim(),
          })
          console.log(`Notification email sent to ${rule.notify_email_address} for message ${messageData.id}`)
        } catch (sendError) {
          console.error(`Failed to send notification to ${rule.notify_email_address}:`, sendError instanceof Error ? sendError.message : sendError)
        }
      })

    await Promise.allSettled(emailPromises)
  } catch (outerError) {
    console.error('triggerNotifications error:', outerError instanceof Error ? outerError.message : outerError)
  }
}
