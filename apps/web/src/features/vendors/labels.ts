import type { MessagingChannel } from '@/lib/api/types';

export const SERVICE_LABELS: Record<string, string> = { PAYIN: 'Payin', PAYOUT: 'Payout', EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp' };
export const ADAPTER_LABELS: Record<string, string> = { ses: 'Amazon SES', smtp: 'SMTP server', sms21: 'sms21.in' };
export const CHANNEL_ADAPTERS: Record<MessagingChannel, Array<'ses' | 'smtp' | 'sms21'>> = { EMAIL: ['ses', 'smtp'], SMS: ['sms21'], WHATSAPP: ['sms21'] };

export interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'bool' | 'password';
  placeholder?: string;
  hint?: string;
  optional?: boolean;
}

/** Non-secret settings per integration (validated again by the API). */
export const CONFIG_FIELDS: Record<'ses' | 'smtp' | 'sms21', FieldSpec[]> = {
  ses: [
    { key: 'region', label: 'AWS region', kind: 'text', placeholder: 'ap-south-1' },
    { key: 'from_address', label: 'From address', kind: 'text', placeholder: 'no-reply@yourdomain.in', hint: 'Must be a verified identity in SES.' },
    { key: 'from_name', label: 'From name', kind: 'text', placeholder: 'Pay2All Payments', optional: true },
    { key: 'reply_to', label: 'Reply-to', kind: 'text', optional: true },
    { key: 'configuration_set', label: 'Configuration set', kind: 'text', optional: true, hint: 'For bounce / complaint tracking.' },
    { key: 'use_instance_role', label: 'Use the server’s IAM role (no stored keys)', kind: 'bool' },
  ],
  smtp: [
    { key: 'host', label: 'Host', kind: 'text', placeholder: 'email-smtp.ap-south-1.amazonaws.com' },
    { key: 'port', label: 'Port', kind: 'number', placeholder: '587' },
    { key: 'secure', label: 'Implicit TLS (port 465)', kind: 'bool' },
    { key: 'from_address', label: 'From address', kind: 'text' },
    { key: 'from_name', label: 'From name', kind: 'text', optional: true },
  ],
  sms21: [
    { key: 'base_url', label: 'API base URL', kind: 'text', placeholder: 'https://api.sms21.in/v1', optional: true },
    { key: 'sender_id', label: 'Sender ID (test keys / non-DLT only)', kind: 'text', optional: true, hint: 'Live SMS in India uses the DLT template’s sender.' },
  ],
};

/** Write-only credentials per integration. */
export const SECRET_FIELDS: Record<'ses' | 'smtp' | 'sms21', FieldSpec[]> = {
  ses: [
    { key: 'access_key_id', label: 'Access key ID', kind: 'text' },
    { key: 'secret_access_key', label: 'Secret access key', kind: 'password' },
  ],
  smtp: [
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'password' },
  ],
  sms21: [{ key: 'api_key', label: 'API key', kind: 'password', placeholder: 'sms21_live_… or sms21_test_…' }],
};
