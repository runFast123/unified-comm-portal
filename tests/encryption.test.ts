import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomBytes } from 'crypto'
import {
  encrypt,
  decrypt,
  __resetEncryptionCacheForTests,
  __getActiveKeyId,
  __parseCiphertextKeyId,
} from '@/lib/encryption'

// Snapshot of env we mutate, restored after the suite.
const ORIGINAL_ENV = { ...process.env }

let KEY_A: string
let KEY_B: string
let LEGACY_KEY: string

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetEncryptionCacheForTests()
}

describe('encryption (baseline)', () => {
  beforeAll(() => {
    KEY_A = randomBytes(32).toString('base64')
    KEY_B = randomBytes(32).toString('base64')
    LEGACY_KEY = randomBytes(32).toString('base64')
  })

  beforeEach(() => {
    delete process.env.CHANNEL_CONFIG_ENCRYPTION_KEY
    delete process.env.CHANNEL_CONFIG_ENCRYPTION_KEYS
    __resetEncryptionCacheForTests()
  })

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV }
    __resetEncryptionCacheForTests()
  })

  it('encrypt then decrypt round-trips the original plaintext', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `kA:${KEY_A}` })
    const plain = 'sensitive-channel-secret'
    const ct = encrypt(plain)
    expect(decrypt(ct)).toBe(plain)
  })

  it('two consecutive encrypts of the same plaintext produce different ciphertexts (random IV)', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `kA:${KEY_A}` })
    const plain = 'same-input-twice'
    const ct1 = encrypt(plain)
    const ct2 = encrypt(plain)
    expect(ct1).not.toBe(ct2)
    expect(decrypt(ct1)).toBe(plain)
    expect(decrypt(ct2)).toBe(plain)
  })

  it('new ciphertexts use the v1: prefix', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `kA:${KEY_A}` })
    const ct = encrypt('hello')
    expect(ct.startsWith('v1:')).toBe(true)
    expect(__parseCiphertextKeyId(ct)).toBe('kA')
    expect(__getActiveKeyId()).toBe('kA')
  })

  it('legacy bare-base64 ciphertext still decrypts when only CHANNEL_CONFIG_ENCRYPTION_KEY is configured', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEY: LEGACY_KEY })
    // Encrypt under legacy-only env, then strip the v1:k0: prefix to simulate
    // a pre-migration payload.
    const versioned = encrypt('legacy-payload')
    expect(versioned.startsWith('v1:k0:')).toBe(true)
    const bare = versioned.slice('v1:k0:'.length)
    expect(decrypt(bare)).toBe('legacy-payload')
  })

  it('multi-key ring: ciphertext under key A still decrypts after rotating to key B', () => {
    // Encrypt with only key A active.
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `kA:${KEY_A}` })
    const ctUnderA = encrypt('migrate-me')
    expect(__parseCiphertextKeyId(ctUnderA)).toBe('kA')

    // Rotate: kB is now active, kA stays in the ring for reads.
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `kB:${KEY_B},kA:${KEY_A}` })
    expect(__getActiveKeyId()).toBe('kB')
    expect(decrypt(ctUnderA)).toBe('migrate-me')
  })

  it('decrypt of a ciphertext with an unknown keyId throws with a descriptive error', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `kA:${KEY_A}` })
    const fake = 'v1:rogue:' + Buffer.from('x'.repeat(40)).toString('base64')
    expect(() => decrypt(fake)).toThrow(/keyId "rogue"/)
  })

  it('decrypt of an empty string throws', () => {
    setEnv({ CHANNEL_CONFIG_ENCRYPTION_KEYS: `kA:${KEY_A}` })
    expect(() => decrypt('')).toThrow(/empty/i)
  })
})
