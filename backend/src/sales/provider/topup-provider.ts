export const TOPUP_PROVIDER = Symbol('TOPUP_PROVIDER');

export interface ProviderRequest {
  saleId: string;
  productCode: string;
  amount: number;
  destination: string;
}

export type ProviderResult = { ok: true; reference: string } | { ok: false; reason: string };

/** Port to the external top-up provider. Swappable for a real integration or a test double. */
export interface TopupProvider {
  send(request: ProviderRequest): Promise<ProviderResult>;
}
