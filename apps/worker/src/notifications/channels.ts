import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { MESSAGING_SCHEMAS, MessagingAdapter } from '@pay2all/validation';
import nodemailer from 'nodemailer';
import type { z } from 'zod';

/**
 * Messaging integrations (docs/VENDORS.md §3). Each turns one decrypted notification into one call
 * to the vendor. Errors say whether the *message* is hopeless (permanent: bad recipient, template
 * not approved) or whether another vendor / a later retry may succeed (retryable).
 */
export interface OutgoingMessage {
  notificationId: string;
  to: string;
  subject: string;
  text: string;
  template: string;
  variables: Record<string, string>;
}

export class ChannelError extends Error {
  constructor(
    message: string,
    /** true: the message itself is rejected — don't retry or fall back. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export interface ChannelSender {
  send(m: OutgoingMessage): Promise<{ messageId: string | null }>;
}

type Cfg<A extends MessagingAdapter> = z.output<(typeof MESSAGING_SCHEMAS)[A]['config']>;
type Secret<A extends MessagingAdapter> = z.output<(typeof MESSAGING_SCHEMAS)[A]['secret']>;

const fromHeader = (address: string, name?: string) => (name ? `"${name.replace(/"/g, '')}" <${address}>` : address);

// ---- Amazon SES (v2 API) ---------------------------------------------------------------------------

/** SES errors that mean "this message will never be accepted" (vs throttling / outages). */
const SES_PERMANENT = new Set(['MessageRejected', 'MailFromDomainNotVerifiedException', 'BadRequestException', 'NotFoundException']);

export function sesSender(config: Cfg<'ses'>, secret: Secret<'ses'> | null, client?: Pick<SESv2Client, 'send'>): ChannelSender {
  const ses =
    client ??
    new SESv2Client({
      region: config.region,
      ...(secret && !config.use_instance_role ? { credentials: { accessKeyId: secret.access_key_id, secretAccessKey: secret.secret_access_key } } : {}),
      maxAttempts: 2,
    });
  return {
    async send(m) {
      try {
        const res = await ses.send(
          new SendEmailCommand({
            FromEmailAddress: fromHeader(config.from_address, config.from_name),
            Destination: { ToAddresses: [m.to] },
            ...(config.reply_to ? { ReplyToAddresses: [config.reply_to] } : {}),
            ...(config.configuration_set ? { ConfigurationSetName: config.configuration_set } : {}),
            Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } },
          }),
        );
        return { messageId: res.MessageId ?? null };
      } catch (err) {
        const name = (err as { name?: string }).name ?? 'Error';
        throw new ChannelError(`SES ${name}: ${(err as Error).message}`.slice(0, 300), SES_PERMANENT.has(name));
      }
    },
  };
}

// ---- SMTP ------------------------------------------------------------------------------------------

export function smtpSender(config: Cfg<'smtp'>, secret: Secret<'smtp'> | null): ChannelSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(secret ? { auth: { user: secret.username, pass: secret.password } } : {}),
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(m) {
      try {
        const info = (await transport.sendMail({ from: fromHeader(config.from_address, config.from_name), to: m.to, subject: m.subject, text: m.text })) as { messageId?: string };
        return { messageId: info.messageId ?? null };
      } catch (err) {
        // 5xx SMTP replies are permanent for this recipient; connection problems are not.
        const code = (err as { responseCode?: number }).responseCode;
        throw new ChannelError(`SMTP: ${(err as Error).message}`.slice(0, 300), code !== undefined && code >= 500 && code < 600);
      }
    },
  };
}

// ---- sms21.in (SMS and WhatsApp) ----------------------------------------------------------------------

/** sms21 error codes that mean the message can never be sent as is (docs: packages/api-spec). */
const SMS21_PERMANENT = new Set([
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'INVALID_RECIPIENT',
  'MESSAGE_TOO_LONG',
  'RECIPIENT_SUPPRESSED',
  'TEMPLATE_REQUIRED',
  'TEMPLATE_NOT_APPROVED',
  'TEMPLATE_VARIABLES_INVALID',
  'TEMPLATE_TEXT_MISMATCH',
  'TEMPLATE_CATEGORY_NOT_ALLOWED',
  'WHATSAPP_TEMPLATE_INVALID',
  'DESTINATION_NOT_ALLOWED',
  'IDEMPOTENCY_KEY_REUSED',
]);

export function sms21Sender(channel: 'SMS' | 'WHATSAPP', config: Cfg<'sms21'>, secret: Secret<'sms21'>, fetchImpl: typeof fetch = fetch): ChannelSender {
  const base = config.base_url.replace(/\/$/, '');
  return {
    async send(m) {
      const tpl = config.templates[m.template];
      const variables = tpl ? Object.fromEntries(tpl.variables.map((k) => [k, m.variables[k] ?? ''])) : undefined;
      // Business-initiated WhatsApp needs an approved template; free text only reaches someone who
      // messaged us in the last 24 h. Live SMS to India needs a DLT template; free text is test-only.
      const [path, body] =
        channel === 'SMS'
          ? ['/sms/send', tpl ? { to: m.to, templateId: tpl.template_id, variables } : { to: m.to, text: m.text, ...(config.sender_id ? { senderId: config.sender_id } : {}) }]
          : tpl
            ? ['/whatsapp/template', { to: m.to, templateId: tpl.template_id, variables }]
            : ['/whatsapp/send', { to: m.to, text: m.text }];
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': secret.api_key,
            // One notification = one message: a retry after a timeout returns the original message.
            'Idempotency-Key': m.notificationId,
            'User-Agent': 'pay2all-worker',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
      } catch (err) {
        throw new ChannelError(`sms21 unreachable: ${(err as Error).message}`.slice(0, 300), false);
      }
      const json = (await res.json().catch(() => null)) as { messageId?: string; error?: { code?: string; message?: string } } | null;
      if (res.ok && json?.messageId) return { messageId: json.messageId };
      const code = json?.error?.code ?? `HTTP_${res.status}`;
      throw new ChannelError(`sms21 ${res.status} ${code}: ${json?.error?.message ?? ''}`.slice(0, 300), SMS21_PERMANENT.has(code));
    },
  };
}
