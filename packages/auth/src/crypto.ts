import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM envelope encryption for sensitive fields (docs/SECURITY.md §4).
 * Format: v1.<keyId>.<iv>.<tag>.<ciphertext> — all parts base64url. The key id lets us rotate keys
 * without a flag day: decrypt with whichever key the envelope names, encrypt with the active key.
 */
export interface Keyring {
  activeKeyId: string;
  keys: Record<string, Buffer>;
}

export function createKeyring(activeKeyId: string, base64Keys: Record<string, string>): Keyring {
  const keys: Record<string, Buffer> = {};
  for (const [id, b64] of Object.entries(base64Keys)) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes`);
    keys[id] = key;
  }
  if (!keys[activeKeyId]) throw new Error(`Active encryption key "${activeKeyId}" not provided`);
  return { activeKeyId, keys };
}

export class FieldEncryptor {
  constructor(private readonly keyring: Keyring) {}

  encrypt(plaintext: string, associatedData?: string): string {
    const keyId = this.keyring.activeKeyId;
    const key = this.keyring.keys[keyId]!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (associatedData) cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', keyId, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  /** @param associatedData must equal the value used at encryption (binds ciphertext to its owner row). */
  decrypt(envelope: string, associatedData?: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext envelope');
    const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
    const key = this.keyring.keys[keyId];
    if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Keyed hash for equality lookups on encrypted values (e.g. duplicate bank accounts). */
  blindIndex(value: string, purpose: string): string {
    const key = this.keyring.keys[this.keyring.activeKeyId]!;
    const subkey = createHmac('sha256', key).update(`blind-index:${purpose}`).digest();
    return createHmac('sha256', subkey).update(value).digest('hex');
  }
}

/** Cryptographically random URL-safe token (default 256 bits). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex — for high-entropy tokens (refresh/reset) where a slow hash is unnecessary. */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time string comparison (returns false on length mismatch without early exit on content). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
