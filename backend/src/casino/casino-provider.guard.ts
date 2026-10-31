import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AppError } from '../common/app-error';
import { APP_CONFIG, AppConfig } from '../config';
import { buildStringToSign, isTimestampFresh, signaturesMatch, signRequest } from '../partner/signature';

/** Wallet callbacks from the game provider carry X-Timestamp and X-Signature, signed like partner calls. */
@Injectable()
export class CasinoProviderGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const timestamp = request.header('x-timestamp');
    const signature = request.header('x-signature');
    if (!timestamp || !signature) {
      throw new AppError(401, 'MISSING_SIGNATURE', 'X-Timestamp and X-Signature headers are required');
    }
    if (!isTimestampFresh(timestamp, Math.floor(Date.now() / 1000), this.config.PARTNER_SIGNATURE_TOLERANCE_SECONDS)) {
      throw new AppError(401, 'STALE_TIMESTAMP', 'X-Timestamp is missing, malformed or outside the allowed window');
    }
    const expected = signRequest(
      this.config.CASINO_PROVIDER_SECRET,
      buildStringToSign(timestamp, request.method, request.originalUrl, request.rawBody ?? Buffer.alloc(0)),
    );
    if (!signaturesMatch(signature, expected)) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Signature verification failed');
    }
    return true;
  }
}
