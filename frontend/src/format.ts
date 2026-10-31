const currency = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short' });

export const formatCop = (value: number) => currency.format(value);
export const formatDate = (iso: string) => dateTime.format(new Date(iso));

export const STATUS_LABELS = { PENDING: 'Pendiente', CONFIRMED: 'Confirmada', FAILED: 'Fallida' } as const;
export const MOVEMENT_LABELS = {
  CREDIT: 'Recarga de saldo',
  SALE: 'Venta',
  REFUND: 'Reembolso',
  BET: 'Apuesta',
  BET_PAYOUT: 'Pago de apuesta',
  CASINO_DEBIT: 'Casino: apuesta',
  CASINO_CREDIT: 'Casino: premio',
  CASINO_ROLLBACK: 'Casino: reverso',
} as const;
export const BET_STATUS_LABELS = { OPEN: 'Abierta', WON: 'Ganada', LOST: 'Perdida', VOID: 'Anulada' } as const;
export const formatOdds = (odds: number) => odds.toFixed(2);
