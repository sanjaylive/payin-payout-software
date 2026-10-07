import pino, { type Logger, type LoggerOptions } from 'pino';
import { PINO_REDACT_PATHS, REDACTED } from './redaction';

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  /** Extra static fields added to every line (e.g. env, version). */
  base?: Record<string, unknown>;
  /** Called for every error/fatal line that carries an Error under `err` (error reporting hook). */
  onError?: (err: Error, context: Record<string, unknown>) => void;
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
    ...(opts.onError
      ? {
          hooks: {
            logMethod(this: Logger, args: Parameters<Logger['info']>, method: (...a: unknown[]) => void, level: number) {
              const first = args[0] as { err?: unknown } | undefined;
              if (level >= 50 && first && typeof first === 'object' && first.err instanceof Error) {
                try {
                  opts.onError!(first.err, { msg: typeof args[1] === 'string' ? args[1] : undefined });
                } catch {
                  // Reporting must never break logging.
                }
              }
              method.apply(this, args);
            },
          },
        }
      : {}),
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
