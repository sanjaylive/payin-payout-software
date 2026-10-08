import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

/**
 * A minimal software WebAuthn authenticator (ES256, "none" attestation) for integration tests: it
 * produces the same JSON a browser's navigator.credentials API returns, so the server code under test
 * is the real verification path.
 */
export class SoftAuthenticator {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credentialId = randomBytes(32);
  counter = 0;

  constructor(
    private readonly rpId = 'localhost',
    private readonly origin = 'http://localhost:3000',
  ) {}

  get id() {
    return b64url(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const map = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    return isoCBOR.encode(map);
  }

  /** Response to navigator.credentials.create() for the given server options. */
  create(options: { challenge: string }, opts: { origin?: string } = {}) {
    const flags = 0x01 | 0x04 | 0x40; // UP, UV, AT
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.credentialId, Buffer.from(this.cosePublicKey())]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, opts.origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** Response to navigator.credentials.get() for the given server options. */
  get(options: { challenge: string }, opts: { origin?: string; counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([sha256(this.rpId), Buffer.from([0x01 | 0x04]), count]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, opts.origin);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}
