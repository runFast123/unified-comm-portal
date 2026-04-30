// --- Spam Detection ---
// Shared spam detection logic. Extracted from webhooks/email/route.ts so that
// per-account overrides (enable flag, allowlist) can be applied from any
// inbound pipeline (webhook, IMAP poller, etc).

const SPAM_SENDER_PATTERNS = [
  'noreply@', 'no-reply@', 'notifications@', 'marketing@',
  'newsletter@', 'mailer-daemon@', 'postmaster@',
  'digest@', 'updates@', 'news@', 'alerts@', 'promo@',
  'campaigns@', 'bounce@', 'auto@', 'system@', 'donotreply@',
  'unsubscribe@', 'feedback@', 'survey@', 'invite@',
]

const SPAM_SUBJECT_KEYWORDS = [
  'unsubscribe', 'newsletter', 'promotional', 'advertisement',
  'do not reply', 'automated message', 'out of office', 'auto-reply',
  'delivery status notification', 'mailer-daemon',
]

const NEWSLETTER_SUBJECT_KEYWORDS = [
  'webinar', 'invitation to', 'register now', 'sign up today',
  'event reminder', 'join us', 'you\'re invited',
  'digest', 'roundup', 'weekly update', 'monthly update', 'daily update',
  'what\'s new', 'product update', 'release notes', 'changelog',
  'award', 'nomination', 'submit your entry',
  'survey', 'take our survey', 'your feedback',
  'received $', 'payment of $', 'transaction alert',
  'account statement', 'billing summary',
  'trending', 'top stories', 'breaking news',
  'limited time', 'exclusive offer', 'special deal', 'save up to',
  'free trial', 'get started free',
]

const BULK_SENDER_PATTERNS = [
  'zendesk', 'freshdesk', 'hubspot', 'mailchimp',
  'sendgrid', 'constant contact', 'campaign monitor',
  'mailgun', 'postmark', 'sparkpost', 'sendinblue', 'brevo',
  'convertkit', 'drip', 'activecampaign', 'klaviyo',
  'intercom', 'drift', 'crisp', 'tawk',
]

// Only include dedicated email marketing / newsletter platforms — NOT general enterprise domains
const NEWSLETTER_SENDER_DOMAINS = [
  'mailchimp.com', 'sendgrid.net', 'hubspot.com', 'constantcontact.com',
  'campaign-archive.com', 'createsend.com', 'mailgun.org',
  'substack.com', 'ghost.io',
]

// Noreply-prefixed addresses from any domain are likely automated
const NOREPLY_PREFIXES = [
  'noreply@', 'no-reply@', 'donotreply@', 'do-not-reply@',
  'notifications@', 'notification@', 'alerts@', 'alert@',
  'updates@', 'update@', 'news@', 'newsletter@', 'digest@',
  'mailer@', 'mailer-daemon@', 'postmaster@',
]

export interface SpamCheckResult {
  isSpam: boolean
  reason: string | null
}

export interface SpamDetectionOptions {
  /** When false, returns {isSpam:false, reason:null} without running any checks. */
  enabled?: boolean
  /** Sender patterns (case-insensitive substring match) that override any spam signal. */
  allowlist?: string[]
}

export function detectSpam(
  senderEmail: string | null,
  subject: string | null,
  messageText: string,
  options?: SpamDetectionOptions
): SpamCheckResult {
  // Per-account kill-switch: skip all checks entirely.
  if (options?.enabled === false) {
    return { isSpam: false, reason: null }
  }

  const emailLower = (senderEmail || '').toLowerCase()
  const subjectLower = (subject || '').toLowerCase()
  const bodyLower = messageText.toLowerCase()

  // Allowlist short-circuit: any substring match on the sender exempts the
  // message from every downstream rule. Normalize once — callers typically
  // pass raw jsonb arrays that may include upper-case or padded entries.
  if (options?.allowlist && options.allowlist.length > 0 && emailLower) {
    const normalized = options.allowlist
      .map((a) => (typeof a === 'string' ? a.trim().toLowerCase() : ''))
      .filter((a) => a.length > 0)
    if (normalized.some((entry) => emailLower.includes(entry))) {
      return { isSpam: false, reason: null }
    }
  }

  // 1. Check hard spam sender patterns
  if (SPAM_SENDER_PATTERNS.some(p => emailLower.startsWith(p))) {
    return { isSpam: true, reason: 'automated_notification' }
  }

  // 2. Check hard spam subject keywords
  if (SPAM_SUBJECT_KEYWORDS.some(kw => subjectLower.includes(kw))) {
    return { isSpam: true, reason: 'spam' }
  }

  // 3. Check newsletter sender domains (only dedicated email marketing platforms)
  if (NEWSLETTER_SENDER_DOMAINS.some(d => emailLower.includes(d))) {
    return { isSpam: true, reason: 'newsletter' }
  }

  // 4. Check noreply/automated sender prefixes
  if (NOREPLY_PREFIXES.some(p => emailLower.startsWith(p))) {
    return { isSpam: true, reason: 'automated_notification' }
  }

  // 5. Check bulk sender platforms
  if (BULK_SENDER_PATTERNS.some(p => emailLower.includes(p))) {
    return { isSpam: true, reason: 'marketing' }
  }

  // 6. Check newsletter subject keywords
  if (NEWSLETTER_SUBJECT_KEYWORDS.some(kw => subjectLower.includes(kw))) {
    return { isSpam: true, reason: 'newsletter' }
  }

  // 7. Check body: require multiple spam signals (not just "unsubscribe" alone)
  const spamBodySignals = [
    bodyLower.includes('unsubscribe'),
    bodyLower.includes('email preferences'),
    bodyLower.includes('opt out'),
    bodyLower.includes('manage your subscriptions'),
    bodyLower.includes('view in browser'),
    bodyLower.includes('view this email'),
  ].filter(Boolean).length
  if (spamBodySignals >= 2) {
    return { isSpam: true, reason: 'newsletter' }
  }

  return { isSpam: false, reason: null }
}
