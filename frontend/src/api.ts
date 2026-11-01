export type Role = 'ADMIN' | 'CASHIER';

export interface User {
  id: string;
  email: string;
  role: Role;
  posId: string | null;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  type: 'TOPUP' | 'GIFT_CARD';
  minAmount: number;
  maxAmount: number;
}

export interface Sale {
  id: string;
  posId: string;
  productName: string;
  amount: number;
  destination: string;
  channel: 'PORTAL' | 'PARTNER';
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  providerReference: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface Movement {
  id: number;
  type: 'CREDIT' | 'SALE' | 'REFUND' | 'BET' | 'BET_PAYOUT' | 'CASINO_DEBIT' | 'CASINO_CREDIT' | 'CASINO_ROLLBACK';
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

export interface PointOfSale {
  id: string;
  name: string;
  balance: number;
  active: boolean;
}

export interface BoardEvent {
  id: number;
  league: string;
  home: string;
  away: string;
  startsAt: string;
  status: 'SCHEDULED' | 'LIVE' | 'FINISHED';
  minute: number;
  score: [number, number];
  selections: Array<{ id: number; market: Market; code: PickCode; odds: number; suspended: boolean }>;
}

export type Market = 'MATCH' | 'DOUBLE' | 'GOALS' | 'BTTS';
export type PickCode = 'HOME' | 'DRAW' | 'AWAY' | '1X' | '12' | 'X2' | 'OVER' | 'UNDER' | 'YES' | 'NO';

export interface Bet {
  id: string;
  market: Market;
  pick: PickCode;
  match: string;
  league: string;
  stake: number;
  odds: number;
  potentialPayout: number;
  status: 'OPEN' | 'WON' | 'LOST' | 'VOID';
  createdAt: string;
}

export interface CasinoGame {
  code: string;
  name: string;
  kind: string;
  minStake: number;
  maxStake: number;
  topMultiplier: number;
}

export interface RoundResult {
  roundId: string;
  game: string;
  stake: number;
  multiplier: number;
  win: number;
  balance: number;
  replayed: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? 'HTTP_ERROR',
      data?.error?.message ?? `HTTP ${response.status}`,
      data?.error?.details,
    );
  }

  return data as T;
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  INSUFFICIENT_BALANCE: 'Saldo insuficiente para esta venta.',
  INVALID_AMOUNT: 'El valor está fuera del rango permitido para este producto.',
  INVALID_DESTINATION: 'El destino no es válido para este producto.',
  UNAUTHORIZED: 'Tu sesión expiró. Vuelve a ingresar.',
  ODDS_CHANGED: 'La cuota cambió. Revisa el nuevo valor y confirma.',
  EVENT_CLOSED: 'El partido ya terminó.',
  MARKET_SUSPENDED: 'El mercado está suspendido en este momento.',
  STAKE_OUT_OF_RANGE: 'El valor apostado está fuera de los límites.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGES[error.code] ?? error.message;
  }
  return 'No fue posible conectar con el servidor. Intenta de nuevo.';
}
