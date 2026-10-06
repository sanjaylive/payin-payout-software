import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ApiConfig } from '../config/api-config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Email delivery. Uses SMTP when SMTP_URL is set (Mailpit locally); otherwise an in-memory transport
 * that tests can inspect. Production requires SMTP_URL (enforced by env validation).
 *
 * Phase 7 moves sending behind the outbox + notification worker so request latency never depends on
 * SMTP. Until then callers fire-and-forget via sendInBackground().
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  /** Populated only when no SMTP transport is configured (tests). */
  readonly memoryOutbox: MailMessage[] = [];

  constructor(private readonly config: ApiConfig) {
    this.transporter = config.env.SMTP_URL ? nodemailer.createTransport(config.env.SMTP_URL) : null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.memoryOutbox.push(message);
      return;
    }
    await this.transporter.sendMail({ from: this.config.env.MAIL_FROM, ...message });
  }

  sendInBackground(message: MailMessage): void {
    this.send(message).catch((err: unknown) => {
      // Never log the message body — it may contain one-time links.
      this.logger.error({ err, subject: message.subject }, 'Email delivery failed');
    });
  }
}
