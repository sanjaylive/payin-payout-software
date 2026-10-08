import { createVerify } from 'node:crypto';

/**
 * Amazon SNS message verification (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html):
 * the signing certificate must come from an sns.<region>.amazonaws.com HTTPS URL, and its key must
 * verify the signature over the canonical string of the message's fields.
 */
export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** An SNS-owned HTTPS URL (signing certificate or subscribe link). */
export function isSnsUrl(raw: string | undefined, suffix?: RegExp): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname) && !u.username && !u.password && (!suffix || suffix.test(u.pathname));
  } catch {
    return false;
  }
}

export function parseSnsMessage(raw: string): SnsMessage | null {
  try {
    const m = JSON.parse(raw) as Partial<SnsMessage>;
    if (!m.Type || !m.MessageId || !m.TopicArn || typeof m.Message !== 'string' || !m.Timestamp || !m.Signature || !m.SigningCertURL || (m.SignatureVersion !== '1' && m.SignatureVersion !== '2')) return null;
    return m as SnsMessage;
  } catch {
    return null;
  }
}

export function snsStringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const fields = m as unknown as Record<string, string | undefined>;
  return keys.map((k) => `${k}\n${fields[k] ?? ''}\n`).join('');
}

export function verifySnsSignature(m: SnsMessage, certificatePem: string): boolean {
  try {
    const v = createVerify(m.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
    v.update(snsStringToSign(m), 'utf8');
    return v.verify(certificatePem, m.Signature, 'base64');
  } catch {
    return false;
  }
}
