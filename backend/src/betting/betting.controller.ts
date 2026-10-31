import { Body, Controller, Get, MessageEvent, Post, Res, Sse, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { from, interval, map, Observable, startWith, switchMap } from 'rxjs';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BettingService } from './betting.service';

const placeBetSchema = z
  .object({
    selectionId: z.number().int().positive(),
    stake: z.number().int().positive(),
    // Decimal odds the cashier saw, e.g. 2.35. Stored and compared in hundredths.
    acceptedOdds: z.number().positive().max(50),
  })
  .strict();

@Controller('betting')
@UseGuards(JwtAuthGuard)
export class BettingController {
  constructor(private readonly betting: BettingService) {}

  @Get('events')
  events() {
    return this.betting.board();
  }

  @Post('bets')
  @Roles('CASHIER')
  async place(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(placeBetSchema)) body: z.infer<typeof placeBetSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.betting.placeBet({
      posId: user.posId!,
      selectionId: body.selectionId,
      stake: body.stake,
      acceptedOdds: Math.round(body.acceptedOdds * 100),
      idempotencyKey,
    });
    res.status(result.replayed ? 200 : 201);
    return { data: result.bet, meta: { replayed: result.replayed } };
  }

  @Get('bets')
  @Roles('CASHIER')
  bets(@CurrentUser() user: AuthUser) {
    return this.betting.listBets(user.posId!);
  }
}

/**
 * Live board over Server-Sent Events. Public on purpose: odds and scores are not private, and the
 * browser's EventSource cannot send an Authorization header. It exposes no store or customer data.
 */
@Controller('betting')
export class BettingStreamController {
  constructor(private readonly betting: BettingService) {}

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return interval(2000).pipe(
      startWith(0),
      switchMap(() => from(this.betting.board())),
      map((board) => ({ data: board })),
    );
  }
}
