import { Body, Controller, Get, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CasinoProviderGuard } from './casino-provider.guard';
import { CasinoService } from './casino.service';

const txId = z.string().regex(/^[A-Za-z0-9:_-]{6,80}$/);
const walletSchema = z
  .object({ posId: z.uuid(), providerTxId: txId, roundId: txId, gameCode: z.string().min(3).max(40), amount: z.number().int().min(0) })
  .strict();
const rollbackSchema = z
  .object({ posId: z.uuid(), providerTxId: txId, rollsBackTxId: txId, roundId: txId, gameCode: z.string().min(3).max(40) })
  .strict();
const roundSchema = z.object({ gameCode: z.string().min(3).max(40), stake: z.number().int().positive() }).strict();

@Controller('casino')
@UseGuards(JwtAuthGuard)
export class CasinoController {
  constructor(private readonly casino: CasinoService) {}

  @Get('games')
  games() {
    return this.casino.games();
  }

  @Post('rounds')
  @Roles('CASHIER')
  @HttpCode(200)
  play(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(roundSchema)) body: z.infer<typeof roundSchema>,
  ) {
    return this.casino.playRound(user.posId!, body.gameCode, body.stake, idempotencyKey);
  }
}

/** Seamless-wallet endpoints the game provider calls, authenticated by its HMAC signature. */
@Controller('casino/wallet')
@UseGuards(CasinoProviderGuard)
export class CasinoWalletController {
  constructor(private readonly casino: CasinoService) {}

  @Post('debit')
  @HttpCode(200)
  debit(@Body(new ZodValidationPipe(walletSchema)) body: z.infer<typeof walletSchema>) {
    return this.casino.debit(body);
  }

  @Post('credit')
  @HttpCode(200)
  credit(@Body(new ZodValidationPipe(walletSchema)) body: z.infer<typeof walletSchema>) {
    return this.casino.credit(body);
  }

  @Post('rollback')
  @HttpCode(200)
  rollback(@Body(new ZodValidationPipe(rollbackSchema)) body: z.infer<typeof rollbackSchema>) {
    return this.casino.rollback(body);
  }
}

@Module({
  controllers: [CasinoController, CasinoWalletController],
  providers: [CasinoService, CasinoProviderGuard],
})
export class CasinoModule {}
