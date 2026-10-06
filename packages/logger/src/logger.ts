import pino, { type Logger, type LoggerOptions } from 'pino';
import { PINO_REDACT_PATHS, REDACTED } from './redaction';

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  /** Extra static fields added to every line (e.g. env, version). */
  base?: Record<string, unknown>;
}

export function buildLoggerOptions(opts: CreateLoggerOptions): LoggerOptions {
  return {
    level: opts.level ?? 'info',
    base: { service: opts.service, ...opts.base },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: PINO_REDACT_PATHS, censor: REDACTED },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  };
}

/** Structured JSON logger with mandatory secret redaction. */
export function createLogger(opts: CreateLoggerOptions): Logger {
  return pino(buildLoggerOptions(opts));
}

export type { Logger };
