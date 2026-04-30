/**
 * Lazy re-encryption helper for key rotation.
 *
 * When an admin rotates `CHANNEL_CONFIG_ENCRYPTION_KEYS` (new key first, old
 * key second), every existing ciphertext still decrypts via the old entry in
 * the ring — but it's still "stale", since it's pinned to the old key. To
 * finish the rotation the ciphertext must be re-encrypted with the new
 * active key.
 *
 * This helper lets callers do that opportunistically on any save path:
 *
 *   const { migrated, value } = reencryptIfStale(row.config_encrypted)
 *   if (migrated) await db.update({ config_encrypted: value })
 *
 * For the main write paths (`saveChannelConfig`, `saveIntegration`) lazy
 * migration happens naturally — the next save re-encrypts with the active
 * key, no wiring needed. This helper is intended for a future admin
 * "rotate all credentials now" sweep that re-saves every row without
 * waiting for user activity.
 */

import {
  decrypt,
  encrypt,
  __getActiveKeyId,
  __parseCiphertextKeyId,
} from '@/lib/encryption'

export interface ReencryptResult {
  /** true when the returned `value` is a fresh ciphertext under the active key. */
  migrated: boolean
  value: string
}

/**
 * Returns `{migrated:true, value:<new ciphertext>}` if the input was encrypted
 * with a non-active key (or is a legacy unversioned blob). Otherwise returns
 * `{migrated:false, value:<input>}`. Throws if the input cannot be decrypted
 * at all — callers should treat that the same way they treat any decrypt
 * failure (surface to logs, don't silently corrupt data).
 */
export function reencryptIfStale(ciphertext: string): ReencryptResult {
  const activeId = __getActiveKeyId()
  const embeddedId = __parseCiphertextKeyId(ciphertext)

  if (embeddedId !== null && embeddedId === activeId) {
    // Already on the active key — no-op.
    return { migrated: false, value: ciphertext }
  }

  // Either legacy (embeddedId===null) or an older key id — decrypt + re-encrypt.
  const plaintext = decrypt(ciphertext)
  const fresh = encrypt(plaintext)
  return { migrated: true, value: fresh }
}
