import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CreateSaleInput, createSaleSchema } from './sales.schemas';
import { SalesService } from './sales.service';

const listQuerySchema = z.object({ posId: z.uuid().optional() });

@Controller('sales')
@UseGuards(JwtAuthGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  @Roles('CASHIER')
  async create(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(createSaleSchema)) body: CreateSaleInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.sales.createSale({
      ...body,
      posId: user.posId!,
      idempotencyKey,
      channel: 'PORTAL',
    });

    // 201 for a new sale, 200 when the same request is replayed.
    res.status(result.replayed ? 200 : 201);
    return { data: result.sale, meta: { replayed: result.replayed } };
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(listQuerySchema)) query: { posId?: string }) {
    // Cashiers only ever see their own point of sale; admins may filter.
    const posId = user.role === 'CASHIER' ? user.posId! : query.posId;
    return this.sales.listSales(posId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) saleId: string) {
    return this.sales.getSale(saleId, user.role === 'CASHIER' ? user.posId! : undefined);
  }
}
