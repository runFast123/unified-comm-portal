import { getChannelConfig, saveChannelConfig, type TeamsConfig } from '@/lib/channel-config'

/**
 * Delegated OAuth helpers for Microsoft Graph (Teams).
 *
 * Unlike the client-credentials flow (see channel-sender.ts#getGraphToken),
 * the delegated flow acquires tokens on behalf of a signed-in user. This
 * bypasses the "Protected API Access" gate that Microsoft applies to
 * application-permission reads of /chats/{id}/messages.
 *
 * Contract:
 *  - Caller passes the decrypted TeamsConfig and the owning account_id.
 *  - We return a valid access_token (cached or freshly minted).
 *  - If the refresh token is missing/expired/revoked we throw a
 *    "reconnect required" error that the UI can surface.
 */

const SCOPES = 'offline_access User.Read Chat.Read ChatMessage.Read'
const ACCESS_TOKEN_SAFETY_MARGIN_MS = 30_000 // refresh if we're within 30s of expiry

export class TeamsOAuthExpiredError extends Error {
  constructor(message = 'Teams OAuth expired — reconnect required') {
    super(message)
    this.name = 'TeamsOAuthExpiredError'
  }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type?: string
  scope?: string
}

interface TokenErrorResponse {
  error?: string
  error_description?: string
}

/**
 * Acquire a delegated Graph access token.
 *  1. Return the cached access token if it's still valid (with safety margin).
 *  2. Otherwise, exchange the stored refresh token for a new access token.
 *     Microsoft MAY rotate the refresh token — if the response contains a
 *     new refresh_token we persist it (merged into the existing config).
 *  3. If the refresh exchange fails (AADSTS70000/70008/etc. — user revoked
 *     consent, password changed, MFA required, or token too old) we throw
 *     TeamsOAuthExpiredError so callers can prompt re-auth.
 *
 * Accepts `accountId` so we can persist rotated refresh tokens back to the
 * DB. If accountId is null we still return a valid token but silently skip
 * the write-back — callers that care about rotation durability must pass
 * a real account_id.
 */
export async function getDelegatedAccessToken(
  cfg: TeamsConfig,
  accountId: string | null
): Promise<string> {
  if (!cfg.delegated_refresh_token) {
    throw new TeamsOAuthExpiredError('No delegated refresh token on file — reconnect required')
  }

  const now = Date.now()
  if (
    cfg.delegated_access_token &&
    cfg.delegated_access_token_expires_at &&
    cfg.delegated_access_token_expires_at > now + ACCESS_TOKEN_SAFETY_MARGIN_MS
  ) {
    return cfg.delegated_access_token
  }

  // Snapshot for optimistic locking below.
  const startingRefreshToken = cfg.delegated_refresh_token

  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.azure_tenant_id}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.azure_client_id,
        client_secret: cfg.azure_client_secret,
        grant_type: 'refresh_token',
        refresh_token: cfg.delegated_refresh_token,
        scope: SCOPES,
      }),
    }
  )

  if (!res.ok) {
    let err: TokenErrorResponse = {}
    try {
      err = (await res.json()) as TokenErrorResponse
    } catch {
      /* body may be empty or non-JSON */
    }
    // invalid_grant == user revoked, consent withdrawn, password changed,
    // refresh token aged out, etc. Treat as "reconnect required".
    if (err.error === 'invalid_grant' || err.error === 'interaction_required') {
      throw new TeamsOAuthExpiredError(
        `Teams OAuth expired — reconnect required (${err.error_description || err.error})`
      )
    }
    throw new Error(
      `Delegated token refresh failed: ${res.status} ${err.error || ''} ${err.error_description || ''}`.trim()
    )
  }

  const json = (await res.json()) as TokenResponse
  const expiresAtMs = Date.now() + (json.expires_in - 60) * 1000

  // Persist the rotated refresh token (if any) and cache the access token.
  // Best-effort: a write-back failure should not prevent us from returning
  // a usable token for this request.
  //
  // Optimistic locking — the config is stored as one encrypted blob so we
  // can't do a column-level UPDATE ... WHERE refresh_token = ?. Re-fetch
  // just before writing and compare. If another worker already rotated, use
  // their tokens rather than clobbering them with our now-stale ones.
  if (accountId) {
    try {
      const freshCfg = (await getChannelConfig(accountId, 'teams')) as TeamsConfig | null
      if (
        freshCfg &&
        freshCfg.delegated_refresh_token &&
        freshCfg.delegated_refresh_token !== startingRefreshToken
      ) {
        // Concurrent rotation — prefer their cached access token if valid.
        if (
          freshCfg.delegated_access_token &&
          freshCfg.delegated_access_token_expires_at &&
          freshCfg.delegated_access_token_expires_at > Date.now() + ACCESS_TOKEN_SAFETY_MARGIN_MS
        ) {
          return freshCfg.delegated_access_token
        }
        return json.access_token
      }
      const updated: TeamsConfig = {
        ...(freshCfg ?? cfg),
        auth_mode: 'delegated',
        delegated_refresh_token: json.refresh_token || startingRefreshToken,
        delegated_access_token: json.access_token,
        delegated_access_token_expires_at: expiresAtMs,
      }
      await saveChannelConfig(accountId, 'teams', updated)
    } catch (writeErr) {
      console.error('Failed to persist rotated delegated tokens:', writeErr)
    }
  }

  return json.access_token
}

/**
 * Exchange an authorization code for access + refresh tokens. Used by the
 * OAuth callback handler.
 */
export async function exchangeAuthCode(params: {
  cfg: TeamsConfig
  code: string
  redirectUri: string
}): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
}> {
  const { cfg, code, redirectUri } = params
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.azure_tenant_id}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.azure_client_id,
        client_secret: cfg.azure_client_secret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        scope: SCOPES,
      }),
    }
  )
  if (!res.ok) {
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(`Auth code exchange failed: ${res.status} ${body.slice(0, 400)}`)
  }
  const json = (await res.json()) as TokenResponse
  if (!json.access_token || !json.refresh_token) {
    // No refresh_token means we forgot offline_access, or admin consent
    // policy denied it. Either way it's unusable for a long-lived poll.
    throw new Error(
      'Token response missing refresh_token — ensure offline_access is in the requested scopes and granted'
    )
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
  }
}

export const TEAMS_OAUTH_SCOPES = SCOPES
