import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProviderRequest, ProviderResult, TopupProvider } from './topup-provider';

/**
 * Stand-in for a real provider so the system runs locally at no cost.
 * Deterministic: destinations ending in "0000" are rejected, everything else is confirmed.
 */
@Injectable()
export class SimulatedTopupProvider implements TopupProvider {
  async send(request: ProviderRequest): Promise<ProviderResult> {
    await sleep(50);

    if (request.destination.endsWith('0000')) {
      return { ok: false, reason: 'DESTINATION_REJECTED' };
    }

    return { ok: true, reference: `SIM-${randomUUID().slice(0, 8).toUpperCase()}` };
  }
}
