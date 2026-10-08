import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser';
import { api, ApiError } from '@/lib/api/client';

export const passkeysSupported = () => typeof window !== 'undefined' && browserSupportsWebAuthn();

/** Friendly text for the browser's WebAuthn errors (cancelled prompt, unsupported device…). */
export function passkeyErrorMessage(err: unknown): string | null {
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This device already has a passkey for your account.';
    return 'The passkey prompt was cancelled or timed out.';
  }
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return 'The passkey prompt was cancelled or timed out.';
  return null;
}

/** Turn a browser passkey failure into an error forms can display (API errors pass through). */
export function passkeyFailure(err: unknown): unknown {
  const message = passkeyErrorMessage(err);
  return message ? new ApiError(0, 'PASSKEY_CANCELLED', message) : err;
}

export interface PasskeyRegistered {
  passkey: { id: string; name: string };
  access_token?: string;
  recovery_codes?: string[];
}

/** Create a passkey on this device and register it with the account. */
export async function registerPasskey(name: string): Promise<PasskeyRegistered> {
  const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>('/v1/auth/passkeys/register/options');
  const response = await startRegistration({ optionsJSON });
  return api.post<PasskeyRegistered>('/v1/auth/passkeys/register', { name, response });
}

/** Ask the device to sign a server challenge (`optionsPath` returns the request options). */
export async function signWithPasskey(optionsPath: string, body?: unknown, auth = true) {
  const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>(optionsPath, body, { auth });
  return startAuthentication({ optionsJSON });
}

/** A sensible default name for a new passkey, from the browser's platform. */
export function defaultPasskeyName(): string {
  if (typeof navigator === 'undefined') return 'Passkey';
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}
