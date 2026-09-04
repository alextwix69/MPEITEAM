import { HttpException } from '@nestjs/common';

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export class ApplicationError extends HttpException {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    status: number,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
    readonly fieldErrors?: FieldError[],
    readonly retryAfter?: number,
  ) {
    super(publicMessage, status);
  }
}
