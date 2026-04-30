/**
 * Integration settings — DB-backed OAuth-app credentials.
 *
 * Moves "which Google Cloud OAuth client / Azure App Registration do we use"
 * out of env vars into an admin-configurable table so any portal admin can
 * rotate creds without server access. Same AES-256-GCM envelope scheme as
 * channel_configs — shares the key ring configured via
 * `CHANNEL_CONFIG_ENCRYPTION_KEY` / `CHANNEL_CONFIG_ENCRYPTION_KEYS`
 * (see `src/lib/encryption.ts`).
 *
 * Resolution order for `getGoogleOAuth` / `getAzureOAuth`:
 *   1. Decrypt from `integration_settings` row (service-role read, RLS bypass)
 *   2. Env vars (back-compat)
 *   3. null
 */

import { createServiceRoleClient } from '@/lib/supabase-server'
import { encrypt, decrypt } from '@/lib/encryption'
import { logError } from '@/lib/logger'

export type IntegrationKey = 'google_oauth' | 'azure_oauth'

export interface GoogleOAuthCreds {
  client_id: string
  client_secret: string
}

export interface AzureOAuthCreds {
  tenant_id: string
  client_id: string
  client_secret: string
}

export interface IntegrationStatus {
  source: 'db' | 'env' | 'none' | 'db_broken'
  last_tested_at: string | null
  last_tested_ok: boolean | null
  client_id_last4: string | null
}

// ─── Type guards for decrypted payloads ──────────────────────────────

function isGoogleCreds(v: unknown): v is GoogleOAuthCreds {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.client_id === 'string' && typeof o.client_secret === 'string'
}

function isAzureCreds(v: unknown): v is AzureOAuthCreds {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.tenant_id === 'string' &&
    typeof o.client_id === 'string' &&
    typeof o.client_secret === 'string'
  )
}

// ─── DB row fetch ────────────────────────────────────────────────────

interface IntegrationRow {
  key: string
  config_encrypted: string | null
  updated_at: string | null
  last_tested_at: string | null
  last_tested_ok: boolean | null
}

async function fetchRow(key: IntegrationKey): Promise<IntegrationRow | null> {
  const supabase = await createServiceRoleClient()
  const { data, error } = await supabase
    .from('integration_settings')
    .select('key, config_encrypted, updated_at, last_tested_at, last_tested_ok')
    .eq('key', key)
    .maybeSingle()
  if (error) {
    console.error(`[integration_settings] fetch ${key} failed:`, error.message)
    return null
  }
  return data as IntegrationRow | null
}

/**
 * Shape returned by decryptConfig so callers can distinguish between
 * "no row" (null) and "row exists but undecryptable" (the broken flag).
 */
interface DecryptResult {
  value: unknown | null
  /** true when a row existed but we failed to decrypt/parse its payload. */
  broken: boolean
}

function decryptConfig(row: IntegrationRow | null): DecryptResult {
  if (!row?.config_encrypted) return { value: null, broken: false }
  try {
    return { value: JSON.parse(decrypt(row.config_encrypted)), broken: false }
  } catch (err) {
    console.error(
      `[integration_settings] decrypt/parse failed for ${row.key}:`,
      err instanceof Error ? err.message : err
    )
    // Surface to audit log so an admin can see that stored creds are
    // broken rather than just getting silent env-var fallback forever.
    void logError(
      'system',
      'integration_settings.decrypt_failed',
      `Could not decrypt integration_settings row — encryption key may have rotated`,
      { key: row.key, error: err instanceof Error ? err.message : String(err) }
    ).catch(() => { /* ignore */ })
    return { value: null, broken: true }
  }
}

// ─── Resolvers (DB → env → null) ─────────────────────────────────────

export async function getGoogleOAuth(): Promise<GoogleOAuthCreds | null> {
  const row = await fetchRow('google_oauth')
  const parsed = decryptConfig(row).value
  if (isGoogleCreds(parsed) && parsed.client_id && parsed.client_secret) {
    return { client_id: parsed.client_id, client_secret: parsed.client_secret }
  }
  const envId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const envSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (envId && envSecret) return { client_id: envId, client_secret: envSecret }
  return null
}

export async function getAzureOAuth(): Promise<AzureOAuthCreds | null> {
  const row = await fetchRow('azure_oauth')
  const parsed = decryptConfig(row).value
  if (
    isAzureCreds(parsed) &&
    parsed.tenant_id &&
    parsed.client_id &&
    parsed.client_secret
  ) {
    return {
      tenant_id: parsed.tenant_id,
      client_id: parsed.client_id,
      client_secret: parsed.client_secret,
    }
  }
  const tenant = process.env.AZURE_TENANT_ID
  const clientId = process.env.AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  if (tenant && clientId && clientSecret) {
    return { tenant_id: tenant, client_id: clientId, client_secret: clientSecret }
  }
  return null
}

// ─── Write helpers ───────────────────────────────────────────────────

export async function saveIntegration(
  key: IntegrationKey,
  config: unknown,
  actorUserId: string
): Promise<void> {
  // Normalise the persisted shape — we only store known fields. Preventing
  // accidental extra keys from the client makes later reads predictable.
  let toStore: GoogleOAuthCreds | AzureOAuthCreds
  if (key === 'google_oauth') {
    if (!isGoogleCreds(config)) throw new Error('Invalid google_oauth config shape')
    toStore = { client_id: config.client_id, client_secret: config.client_secret }
  } else {
    if (!isAzureCreds(config)) throw new Error('Invalid azure_oauth config shape')
    toStore = {
      tenant_id: config.tenant_id,
      client_id: config.client_id,
      client_secret: config.client_secret,
    }
  }

  const ciphertext = encrypt(JSON.stringify(toStore))
  const supabase = await createServiceRoleClient()
  const { error } = await supabase
    .from('integration_settings')
    .upsert(
      {
        key,
        config_encrypted: ciphertext,
        updated_at: new Date().toISOString(),
        updated_by: actorUserId,
        // Reset test state on any save — the creds just changed, so old
        // test results no longer describe reality.
        last_tested_at: null,
        last_tested_ok: null,
      },
      { onConflict: 'key' }
    )
  if (error) throw new Error(`Failed to save integration ${key}: ${error.message}`)
}

export async function deleteIntegration(key: IntegrationKey): Promise<void> {
  const supabase = await createServiceRoleClient()
  const { error } = await supabase.from('integration_settings').delete().eq('key', key)
  if (error) throw new Error(`Failed to delete integration ${key}: ${error.message}`)
}

export async function markIntegrationTested(
  key: IntegrationKey,
  ok: boolean
): Promise<void> {
  const supabase = await createServiceRoleClient()
  // Only updates an existing row — don't create one just to record a test.
  const { error } = await supabase
    .from('integration_settings')
    .update({
      last_tested_at: new Date().toISOString(),
      last_tested_ok: ok,
    })
    .eq('key', key)
  if (error) {
    console.error(`[integration_settings] markTested ${key} failed:`, error.message)
  }
}

// ─── Masked status getter for the admin UI ───────────────────────────

/**
 * Source resolution:
 *   'db'   — row exists with valid decrypted creds
 *   'env'  — no DB row (or undecryptable) but env vars are set
 *   'none' — nothing configured anywhere
 *
 * NEVER returns client_secret. Exposes only the last 4 chars of client_id
 * so an admin can eyeball which Google/Azure app is wired up.
 */
export async function getIntegrationStatus(
  key: IntegrationKey
): Promise<IntegrationStatus> {
  const row = await fetchRow(key)
  const decrypted = decryptConfig(row)
  const parsed = decrypted.value

  let source: 'db' | 'env' | 'none' | 'db_broken' = 'none'
  let clientId: string | null = null

  if (key === 'google_oauth') {
    if (isGoogleCreds(parsed) && parsed.client_id && parsed.client_secret) {
      source = 'db'
      clientId = parsed.client_id
    } else if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      source = 'env'
      clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
    }
  } else {
    if (
      isAzureCreds(parsed) &&
      parsed.tenant_id &&
      parsed.client_id &&
      parsed.client_secret
    ) {
      source = 'db'
      clientId = parsed.client_id
    } else if (
      process.env.AZURE_TENANT_ID &&
      process.env.AZURE_CLIENT_ID &&
      process.env.AZURE_CLIENT_SECRET
    ) {
      source = 'env'
      clientId = process.env.AZURE_CLIENT_ID
    }
  }

  // If a row exists but its ciphertext couldn't be decrypted, surface that
  // distinctly so the admin UI can show "stored credentials are unreadable
  // — re-save to repair" rather than quietly fall back to env defaults.
  if (decrypted.broken) source = 'db_broken'

  return {
    source,
    last_tested_at: source === 'db' ? row?.last_tested_at ?? null : null,
    last_tested_ok: source === 'db' ? row?.last_tested_ok ?? null : null,
    client_id_last4: clientId ? clientId.slice(-4) : null,
  }
}
