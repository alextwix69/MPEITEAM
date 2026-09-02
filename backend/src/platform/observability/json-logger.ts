import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';

const URL_PATTERN = /\b(?:postgres(?:ql)?|redis|https?):\/\/\S+/giu;

export function sanitizeLogMessage(message: unknown): string {
  if (typeof message !== 'string') return '[NON_STRING_MESSAGE]';
  return message.replace(URL_PATTERN, '[REDACTED_URL]');
}

export class JsonLogger implements LoggerService {
  readonly #logger: Logger;

  constructor(processRole: 'api' | 'worker', level: string) {
    this.#logger = pino({
      level,
      base: { service: 'komanda-mpei', processRole },
      redact: {
        paths: ['password', 'token', 'authorization', 'cookie', '*.secret', '*.url'],
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }

  child(bindings: Record<string, unknown>): Logger {
    return this.#logger.child(bindings);
  }

  log(message: unknown, context?: string): void {
    this.#logger.info({ context }, sanitizeLogMessage(message));
  }

  error(message: unknown, _trace?: string, context?: string): void {
    this.#logger.error({ context }, sanitizeLogMessage(message));
  }

  warn(message: unknown, context?: string): void {
    this.#logger.warn({ context }, sanitizeLogMessage(message));
  }

  debug(message: unknown, context?: string): void {
    this.#logger.debug({ context }, sanitizeLogMessage(message));
  }

  verbose(message: unknown, context?: string): void {
    this.#logger.trace({ context }, sanitizeLogMessage(message));
  }

  fatal(message: unknown, context?: string): void {
    this.#logger.fatal({ context }, sanitizeLogMessage(message));
  }
}
