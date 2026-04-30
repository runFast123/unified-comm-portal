/**
 * AES-256-GCM envelope encryption with key-ring / key-rotation support.
 *
 * Ciphertext format:
 *   Current:  v1:{keyId}:base64(iv[12] || authTag[16] || ciphertext)
 *   Legacy:   base64(iv[12] || authTag[16] || ciphertext)   (no prefix)
 *
 * Both shapes decrypt transparently. New encryptions always emit `v1:…`.
 *
 * Key configuration (env):
 *   - CHANNEL_CONFIG_ENCRYPTION_KEYS  (new, optional)
 *       Comma-separated list of "id:base64_32byte_key". The FIRST entry is
 *       the active encrypt key; ALL entries are tried on decrypt.
 *       Example: "k2:newKeyBase64==,k1:oldKeyBase64=="
 *   - CHANNEL_CONFIG_ENCRYPTION_KEY   (legacy, optional)
 *       Single base64 key. Treated as keyId 'k0'. If KEYS is not set this is
 *       also the active encrypt key. Either way it stays in the decrypt ring
 *       so pre-rotation ciphertexts keep decrypting.
 *
 * At least one of the two env vars MUST decode to a 32-byte key, otherwise
 * `encrypt` / `decrypt` throws on first call.
 *
 * Rotation procedure (admin):
 *   1. Generate a new key, set CHANNEL_CONFIG_ENCRYPTION_KEYS =
 *      "k2:NEW,k1:OLD" (new one first). Deploy. New writes use k2; reads of
 *      old rows still succeed via k1 in the ring.
 *   2. Once all rows have been re-saved (lazy migration) or via a batch
 *      `reencryptIfStale` sweep, drop the old key from the env var.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const VERSION = 'v1'
const LEGACY_KEY_ID = 'k0'

interface KeyEntry {
  id: string
  key: Buffer
}

interface KeyRing {
  active: KeyEntry
  ring: KeyEntry[]
}

// ─── Key loading ──────────────────────────────────────────────────────

function parseKeyEntry(raw: string): KeyEntry {
  const trimmed = raw.trim()
  const sep = trimmed.indexOf(':')
  if (sep <= 0) {
    throw new Error(
      `CHANNEL_CONFIG_ENCRYPTION_KEYS entry "${trimmed.slice(0, 12)}…" is malformed — expected "id:base64key"`
    )
  }
  const id = trimmed.slice(0, sep).trim()
  const b64 = trimmed.slice(sep + 1).trim()
  if (!id) throw new Error('Key id must be non-empty in CHANNEL_CONFIG_ENCRYPTION_KEYS entry')
  if (id.includes(':')) {
    throw new Error(`Key id "${id}" must not contain ':' — it would break ciphertext parsing`)
  }
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) {
    throw new Error(
      `CHANNEL_CONFIG_ENCRYPTION_KEYS entry "${id}" must decode to 32 bytes (got ${key.length})`
    )
  }
  return { id, key }
}

let cachedRing: KeyRing | null = null

function loadKeys(): KeyRing {
  if (cachedRing) return cachedRing

  const keysEnv = process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS?.trim()
  const legacyEnv = process.env.CHANNEL_CONFIG_ENCRYPTION_KEY?.trim()

  const ring: KeyEntry[] = []
  const seen = new Set<string>()

  if (keysEnv) {
    for (const part of keysEnv.split(',')) {
      if (!part.trim()) continue
      const entry = parseKeyEntry(part)
      if (seen.has(entry.id)) {
        throw new Error(`Duplicate key id "${entry.id}" in CHANNEL_CONFIG_ENCRYPTION_KEYS`)
      }
      seen.add(entry.id)
      ring.push(entry)
    }
  }

  if (legacyEnv) {
    const key = Buffer.from(legacyEnv, 'base64')
    if (key.length !== 32) {
      throw new Error(
        `CHANNEL_CONFIG_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`
      )
    }
    const legacyEntry: KeyEntry = { id: LEGACY_KEY_ID, key }
    if (ring.length === 0) {
      // No KEYS set — legacy is the active key.
      ring.push(legacyEntry)
    } else if (!seen.has(LEGACY_KEY_ID)) {
      // KEYS set — legacy still participates in decrypt, but is NOT active.
      ring.push(legacyEntry)
      seen.add(LEGACY_KEY_ID)
    }
  }

  if (ring.length === 0) {
    throw new Error(
      'No encryption key configured. Set CHANNEL_CONFIG_ENCRYPTION_KEY or CHANNEL_CONFIG_ENCRYPTION_KEYS.'
    )
  }

  cachedRing = { active: ring[0], ring }
  return cachedRing
}

/** Test-only: drop the cached ring so env changes are re-read. */
export function __resetEncryptionCacheForTests(): void {
  cachedRing = null
}

// Back-compat alias for the existing selfcheck block below.
const resetKeyCacheForSelfcheck = __resetEncryptionCacheForTests

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Encrypt a UTF-8 string with the active key.
 * Output: `v1:{activeKeyId}:base64(iv || authTag || ciphertext)`.
 */
export function encrypt(plaintext: string): string {
  const { active } = loadKeys()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, active.key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const body = Buffer.concat([iv, tag, ct]).toString('base64')
  return `${VERSION}:${active.id}:${body}`
}

/**
 * Decrypt a payload produced by `encrypt()` — either the current `v1:…`
 * format or a legacy bare-base64 blob. Throws descriptively on failure.
 */
export function decrypt(payload: string): string {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('decrypt: empty payload')
  }
  const { ring } = loadKeys()

  // Versioned path: v1:keyId:body
  if (payload.startsWith(`${VERSION}:`)) {
    const firstSep = VERSION.length + 1
    const secondSep = payload.indexOf(':', firstSep)
    if (secondSep === -1) {
      throw new Error('decrypt: malformed v1 ciphertext (missing keyId separator)')
    }
    const keyId = payload.slice(firstSep, secondSep)
    const body = payload.slice(secondSep + 1)
    const entry = ring.find((k) => k.id === keyId)
    if (!entry) {
      throw new Error(
        `decrypt: ciphertext was encrypted with keyId "${keyId}" which is not in the configured key ring`
      )
    }
    return decryptWithKey(body, entry.key)
  }

  // Legacy path: bare base64 — try every key in the ring sequentially.
  let lastErr: unknown = null
  for (const entry of ring) {
    try {
      return decryptWithKey(payload, entry.key)
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `decrypt: legacy ciphertext did not decrypt with any of the ${ring.length} configured key(s)` +
      (lastErr instanceof Error ? ` (last error: ${lastErr.message})` : '')
  )
}

function decryptWithKey(base64Body: string, key: Buffer): string {
  const buf = Buffer.from(base64Body, 'base64')
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('decrypt: ciphertext body too short')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ─── Helpers for the migration module (not part of the stable public API) ──

/**
 * Internal: expose the active keyId so `reencryptIfStale` can decide whether
 * a given ciphertext already uses the current key. NOT intended for callers
 * outside this package.
 */
export function __getActiveKeyId(): string {
  return loadKeys().active.id
}

/**
 * Internal: return the keyId embedded in a ciphertext, or null for legacy
 * (unversioned) payloads.
 */
export function __parseCiphertextKeyId(payload: string): string | null {
  if (!payload.startsWith(`${VERSION}:`)) return null
  const firstSep = VERSION.length + 1
  const secondSep = payload.indexOf(':', firstSep)
  if (secondSep === -1) return null
  return payload.slice(firstSep, secondSep)
}

// ─── Self-check (opt-in) ──────────────────────────────────────────────
//
// Run with: ENCRYPTION_SELFCHECK=1 npm run dev
// (Also usable from a one-off script: `ENCRYPTION_SELFCHECK=1 node ...`.)
// Intentionally guarded so it never executes on a normal boot.

if (process.env.ENCRYPTION_SELFCHECK === '1') {
  try {
    const sample = 'hello-encryption-' + Date.now()
    const ct1 = encrypt(sample)
    const pt1 = decrypt(ct1)
    if (pt1 !== sample) throw new Error(`roundtrip mismatch: got "${pt1}"`)
    if (!ct1.startsWith(`${VERSION}:`)) throw new Error(`missing version prefix: "${ct1}"`)

    const ct2 = encrypt(sample)
    if (ct1 === ct2) throw new Error('IV appears deterministic — two encrypts produced same output')

    // Multi-key rotation check: only meaningful when KEYS has >1 entry.
    const { ring } = loadKeys()
    if (ring.length > 1) {
      const originalKeys = process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS
      try {
        // Capture ciphertext under the current active key.
        const activeId = ring[0].id
        const ctActive = encrypt(sample)
        if (!ctActive.startsWith(`${VERSION}:${activeId}:`)) {
          throw new Error(`active-key prefix mismatch: "${ctActive.slice(0, 20)}"`)
        }
        // Swap ring order so a different entry is now active.
        const swapped = [ring[1], ring[0], ...ring.slice(2)]
          .map((e) => `${e.id}:${e.key.toString('base64')}`)
          .join(',')
        process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS = swapped
        resetKeyCacheForSelfcheck()
        const pt = decrypt(ctActive) // old active is still in ring → must work
        if (pt !== sample) throw new Error(`rotation roundtrip mismatch: got "${pt}"`)
      } finally {
        // Restore env + cache regardless of outcome.
        if (originalKeys === undefined) delete process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS
        else process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS = originalKeys
        resetKeyCacheForSelfcheck()
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[encryption selfcheck] OK — active=${loadKeys().active.id}, ring=${loadKeys().ring.length}`
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[encryption selfcheck] FAILED:', err)
    throw err
  }
}
