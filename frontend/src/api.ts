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
  type: 'CREDIT' | 'SALE' | 'REFUND';
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
    throw new ApiError(response.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message ?? `HTTP ${response.status}`);
  }

  return data as T;
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  INSUFFICIENT_BALANCE: 'Saldo insuficiente para esta venta.',
  INVALID_AMOUNT: 'El valor está fuera del rango permitido para este producto.',
  INVALID_DESTINATION: 'El destino no es válido para este producto.',
  UNAUTHORIZED: 'Tu sesión expiró. Vuelve a ingresar.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGES[error.code] ?? error.message;
  }
  return 'No fue posible conectar con el servidor. Intenta de nuevo.';
}
