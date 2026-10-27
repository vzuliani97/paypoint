import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/app-error';
import { ROLES_KEY } from './auth.decorators';
import { AuthenticatedRequest, JwtPayload, Role } from './auth.types';

/** Verifies the Bearer token and, if the route declares @Roles, the user's role. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.header('authorization') ?? '').split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
    }

    request.user = { id: payload.sub, email: payload.email, role: payload.role, posId: payload.posId };

    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles && !requiredRoles.includes(payload.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Your role cannot perform this action');
    }

    return true;
  }
}
