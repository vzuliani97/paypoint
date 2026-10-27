import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AppError } from '../common/app-error';
import { APP_CONFIG, AppConfig } from '../config';
import { isIpAllowed } from './ip-allowlist';
import { PartnersService } from './partners.service';
import { buildStringToSign, isTimestampFresh, signaturesMatch, signRequest } from './signature';

export interface PartnerPrincipal {
  id: string;
  name: string;
  posId: string;
}

type PartnerRequest = Request & { rawBody?: Buffer; partner?: PartnerPrincipal };

/**
 * Authenticates B2B calls with three headers:
 *   X-Api-Key    public key id
 *   X-Timestamp  unix seconds, must be within the tolerance window
 *   X-Signature  hex HMAC-SHA256 of the string built by buildStringToSign
 * and then checks the caller IP against the partner's allowlist.
 */
@Injectable()
export class PartnerAuthGuard implements CanActivate {
  constructor(
    private readonly partners: PartnersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PartnerRequest>();
    const apiKeyId = request.header('x-api-key');
    const timestamp = request.header('x-timestamp');
    const signature = request.header('x-signature');

    if (!apiKeyId || !timestamp || !signature) {
      throw new AppError(401, 'MISSING_SIGNATURE', 'X-Api-Key, X-Timestamp and X-Signature headers are required');
    }

    const now = Math.floor(Date.now() / 1000);
    if (!isTimestampFresh(timestamp, now, this.config.PARTNER_SIGNATURE_TOLERANCE_SECONDS)) {
      throw new AppError(401, 'STALE_TIMESTAMP', 'X-Timestamp is missing, malformed or outside the allowed window');
    }

    const partner = await this.partners.findActiveByKeyId(apiKeyId);
    // An unknown key gets the same answer as a bad signature: do not confirm which keys exist.
    if (!partner) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Signature verification failed');
    }

    const expected = signRequest(
      partner.hmacSecret,
      buildStringToSign(timestamp, request.method, request.originalUrl, request.rawBody ?? Buffer.alloc(0)),
    );

    if (!signaturesMatch(signature, expected)) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Signature verification failed');
    }

    if (!isIpAllowed(request.ip, partner.allowedIps)) {
      throw new AppError(403, 'IP_NOT_ALLOWED', 'Requests from this IP address are not allowed');
    }

    request.partner = { id: partner.id, name: partner.name, posId: partner.posId };
    return true;
  }
}

export const CurrentPartner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PartnerPrincipal => ctx.switchToHttp().getRequest<PartnerRequest>().partner!,
);
