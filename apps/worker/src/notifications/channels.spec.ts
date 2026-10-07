import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { ChannelError, sesSender } from './channels';

const message = { notificationId: 'ntf_1', to: 'priya@example.com', subject: 'Reset your password', text: 'Use this link…', template: 'password_reset', variables: {} };
const config = { region: 'ap-south-1', from_address: 'no-reply@pay2all.in', from_name: 'Pay2All "Payments"', configuration_set: 'transactional', use_instance_role: false };

describe('Amazon SES sender', () => {
  it('sends a plain-text email with the configured sender and configuration set', async () => {
    const sent: SendEmailCommand[] = [];
    const client = { send: async (c: SendEmailCommand) => (sent.push(c), { MessageId: '0102018f-abcd' }) };
    const res = await sesSender(config, null, client).send(message);
    expect(res).toEqual({ messageId: '0102018f-abcd' });
    expect(sent[0]!.input).toMatchObject({
      FromEmailAddress: '"Pay2All Payments" <no-reply@pay2all.in>', // quotes stripped from the display name
      Destination: { ToAddresses: ['priya@example.com'] },
      ConfigurationSetName: 'transactional',
      Content: { Simple: { Subject: { Data: 'Reset your password' }, Body: { Text: { Data: 'Use this link…' } } } },
    });
  });

  it('marks rejected messages permanent and throttling retryable', async () => {
    const failing = (name: string) => ({ send: async () => Promise.reject(Object.assign(new Error(name), { name })) });
    const rejected = await sesSender(config, null, failing('MessageRejected') as never).send(message).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ChannelError);
    expect((rejected as ChannelError).permanent).toBe(true);
    const throttled = await sesSender(config, null, failing('TooManyRequestsException') as never).send(message).catch((e: unknown) => e);
    expect((throttled as ChannelError).permanent).toBe(false);
  });
});
