import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { ApplicationError } from './application-error';
import { getRequestContext } from './request-context';
import type { JsonLogger } from '../observability/json-logger';

export interface ProblemDetails {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    fieldErrors?: Array<{ path: string; code: string; message: string }>;
  };
}

export function createProblemDetails(
  code: string,
  message: string,
  requestId: string,
  retryable = false,
  details?: Record<string, unknown>,
  fieldErrors?: Array<{ path: string; code: string; message: string }>,
): ProblemDetails {
  return {
    error: {
      code,
      message,
      requestId,
      retryable,
      ...(details ? { details } : {}),
      ...(fieldErrors ? { fieldErrors } : {}),
    },
  };
}

function errorForStatus(
  status: number,
): Pick<ProblemDetails['error'], 'code' | 'message' | 'retryable'> {
  if (status === HttpStatus.NOT_FOUND) {
    return {
      code: 'RESOURCE_NOT_FOUND',
      message: 'Запрошенный ресурс не найден.',
      retryable: false,
    };
  }
  if (status === HttpStatus.SERVICE_UNAVAILABLE) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Сервис временно недоступен. Повторите попытку позже.',
      retryable: true,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      code: 'INVALID_REQUEST',
      message: 'Запрос не может быть выполнен. Проверьте данные и повторите попытку.',
      retryable: false,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Произошла внутренняя ошибка. Повторите попытку позже.',
    retryable: true,
  };
}

export function safeExceptionMetadata(exception: unknown): { exceptionType: string } {
  return {
    exceptionType:
      exception instanceof HttpException
        ? 'HttpException'
        : exception instanceof Error
          ? 'Error'
          : 'UnknownError',
  };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const context = getRequestContext();
    const requestId = context?.requestId ?? uuidv7();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const safeError =
      exception instanceof ApplicationError
        ? {
            code: exception.code,
            message: exception.publicMessage,
            retryable: exception.retryable,
            details: exception.details,
            fieldErrors: exception.fieldErrors,
          }
        : errorForStatus(status);

    if (status >= 500) {
      this.logger
        .child({
          requestId,
          correlationId: context?.correlationId ?? requestId,
          module: 'platform',
          operation: 'http.exception',
          result: status,
          ...safeExceptionMetadata(exception),
        })
        .error('HTTP request failed.');
    }

    if (exception instanceof ApplicationError && exception.retryAfter !== undefined) {
      response.setHeader('Retry-After', exception.retryAfter);
    }
    response
      .status(status)
      .type('application/problem+json')
      .send(
        createProblemDetails(
          safeError.code,
          safeError.message,
          requestId,
          safeError.retryable,
          'details' in safeError ? safeError.details : undefined,
          'fieldErrors' in safeError ? safeError.fieldErrors : undefined,
        ),
      );
  }
}
