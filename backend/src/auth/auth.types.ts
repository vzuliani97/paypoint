import { Request } from 'express';

export type Role = 'ADMIN' | 'CASHIER';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  posId: string | null;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  posId: string | null;
}

export type AuthenticatedRequest = Request & { user: AuthUser };
