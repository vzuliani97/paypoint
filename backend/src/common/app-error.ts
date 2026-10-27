import { HttpException } from '@nestjs/common';

export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Business error with a stable, machine-readable code. */
export class AppError extends HttpException {
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    const body: ErrorBody = { code, message, ...(details ? { details } : {}) };
    super(body, status);
  }

  get body(): ErrorBody {
    return this.getResponse() as ErrorBody;
  }
}
