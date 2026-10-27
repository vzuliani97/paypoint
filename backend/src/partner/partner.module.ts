import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PosModule } from '../pos/pos.module';
import { PosService } from '../pos/pos.service';
import { CreateSaleInput, createSaleSchema } from '../sales/sales.schemas';
import { SalesModule } from '../sales/sales.module';
import { SalesService } from '../sales/sales.service';
import { CurrentPartner, PartnerAuthGuard, PartnerPrincipal } from './partner-auth.guard';
import { PartnersService } from './partners.service';

/** B2B API for integrators. Every call is bound to the partner's own point of sale. */
@Controller('partner/v1')
@UseGuards(PartnerAuthGuard)
export class PartnerController {
  constructor(
    private readonly pos: PosService,
    private readonly sales: SalesService,
  ) {}

  @Get('balance')
  async balance(@CurrentPartner() partner: PartnerPrincipal) {
    const pos = await this.pos.get(partner.posId);
    return { posId: pos.id, balance: pos.balance };
  }

  @Post('sales')
  async createSale(
    @CurrentPartner() partner: PartnerPrincipal,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(createSaleSchema)) body: CreateSaleInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.sales.createSale({
      ...body,
      posId: partner.posId,
      idempotencyKey,
      channel: 'PARTNER',
    });

    res.status(result.replayed ? 200 : 201);
    return { data: result.sale, meta: { replayed: result.replayed } };
  }

  @Get('sales/:id')
  getSale(@CurrentPartner() partner: PartnerPrincipal, @Param('id', new ParseUUIDPipe()) saleId: string) {
    return this.sales.getSale(saleId, partner.posId);
  }
}

@Module({
  imports: [PosModule, SalesModule],
  controllers: [PartnerController],
  providers: [PartnersService, PartnerAuthGuard],
})
export class PartnerModule {}
