import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AppError } from './app-error';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Reads and validates the Idempotency-Key header. */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const key = request.header('idempotency-key');

  if (!key || !KEY_PATTERN.test(key)) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key header is required: 8-128 characters, letters, digits, "_", ".", ":" or "-"',
    );
  }

  return key;
});
