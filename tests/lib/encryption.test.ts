import { randomBytes } from 'crypto'
import {
  encrypt,
  decrypt,
  __resetEncryptionCacheForTests,
  __getActiveKeyId,
  __parseCiphertextKeyId,
} from '@/lib/encryption'

function b64Key(): string {
  return randomBytes(32).toString('base64')
}

// Snapshot of env we modify, restored after each test.
const ORIGINAL_ENV = { ...process.env }

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetEncryptionCacheForTests()
}

describe('encryption', () => {
  beforeEach(() => {
    // Clean slate: strip both vars, then the test can set what it needs.
    delete process.env.CHANNEL_CONFIG_ENCRYPTION_KEY
    delete process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS
    __resetEncryptionCacheForTests()
  })

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV }
    __resetEncryptionCacheForTests()
  })

  it('encrypt produces v1:{keyId}:base64(...) format', () => {
    const key = b64Key()
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${key}` })

    const ct = encrypt('hello')
    expect(ct.startsWith('v1:k1:')).toBe(true)
    const body = ct.slice('v1:k1:'.length)
    // base64 string of some minimum length
    expect(body.length).toBeGreaterThan(20)
    expect(__parseCiphertextKeyId(ct)).toBe('k1')
    expect(__getActiveKeyId()).toBe('k1')
  })

  it('two encrypts of the same plaintext yield different ciphertexts (random IV)', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${b64Key()}` })
    const a = encrypt('same-input')
    const b = encrypt('same-input')
    expect(a).not.toBe(b)
    expect(decrypt(a)).toBe('same-input')
    expect(decrypt(b)).toBe('same-input')
  })

  it('roundtrips ASCII, unicode, empty, and large strings', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${b64Key()}` })
    const samples = [
      'simple ascii',
      'unicode: café — 日本語 — 🔐',
      '',
      'x'.repeat(50_000),
    ]
    for (const s of samples) {
      expect(decrypt(encrypt(s))).toBe(s)
    }
  })

  it('legacy bare-base64 ciphertext decrypts against the legacy key', () => {
    // Step 1: configure only the legacy env var, encrypt, then strip the `v1:k0:` prefix
    // to simulate a pre-migration (unversioned) payload.
    const legacy = b64Key()
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEY: legacy })
    const versioned = encrypt('legacy-roundtrip')
    expect(versioned.startsWith('v1:k0:')).toBe(true)
    const bareBody = versioned.slice('v1:k0:'.length)

    // Step 2: decrypt the bare-base64 form — takes the legacy path.
    expect(decrypt(bareBody)).toBe('legacy-roundtrip')
  })

  it('key rotation: encrypt under K1, rotate so K2 is active and K1 stays in ring, decrypt still works', () => {
    const k1 = b64Key()
    const k2 = b64Key()
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${k1}` })
    const ctUnderK1 = encrypt('rotate-me')
    expect(__parseCiphertextKeyId(ctUnderK1)).toBe('k1')

    // Rotate: K2 first (active), K1 retained in ring for reads.
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k2:${k2},k1:${k1}` })
    expect(__getActiveKeyId()).toBe('k2')
    expect(decrypt(ctUnderK1)).toBe('rotate-me')
    // New encrypts use K2.
    const ctUnderK2 = encrypt('rotate-me')
    expect(__parseCiphertextKeyId(ctUnderK2)).toBe('k2')
    expect(decrypt(ctUnderK2)).toBe('rotate-me')
  })

  it('ciphertext with unknown keyId throws descriptively', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${b64Key()}` })
    // Forge a ciphertext with a keyId that isn't in the ring.
    const fake = 'v1:unknown:' + Buffer.from('x'.repeat(40)).toString('base64')
    expect(() => decrypt(fake)).toThrow(/keyId "unknown"/)
  })

  it('malformed ciphertext throws (too short body)', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${b64Key()}` })
    const tooShort = 'v1:k1:' + Buffer.from('abc').toString('base64')
    expect(() => decrypt(tooShort)).toThrow(/too short/i)
  })

  it('malformed v1 ciphertext throws (missing second separator)', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${b64Key()}` })
    // "v1:" + an identifier with no second colon is invalid.
    expect(() => decrypt('v1:nocolonhere')).toThrow(/malformed/i)
  })

  it('empty payload throws', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `k1:${b64Key()}` })
    expect(() => decrypt('')).toThrow(/empty/i)
  })
})
