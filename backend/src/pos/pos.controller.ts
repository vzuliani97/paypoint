import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PosService } from './pos.service';

const createPosSchema = z.object({ name: z.string().trim().min(3).max(120) }).strict();
const creditSchema = z
  .object({
    amount: z.number().int().positive().max(10_000_000),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

type CreatePosInput = z.infer<typeof createPosSchema>;
type CreditInput = z.infer<typeof creditSchema>;

@Controller('pos')
@UseGuards(JwtAuthGuard)
export class PosController {
  constructor(private readonly pos: PosService) {}

  // "me" routes are declared before ":id" so they are matched first.
  @Get('me')
  @Roles('CASHIER')
  me(@CurrentUser() user: AuthUser) {
    return this.pos.get(user.posId!);
  }

  @Get('me/movements')
  @Roles('CASHIER')
  myMovements(@CurrentUser() user: AuthUser) {
    return this.pos.movements(user.posId!);
  }

  @Get()
  @Roles('ADMIN')
  list() {
    return this.pos.list();
  }

  @Post()
  @Roles('ADMIN')
  create(@Body(new ZodValidationPipe(createPosSchema)) body: CreatePosInput) {
    return this.pos.create(body.name);
  }

  @Post(':id/credits')
  @Roles('ADMIN')
  credit(
    @Param('id', new ParseUUIDPipe()) posId: string,
    @Body(new ZodValidationPipe(creditSchema)) body: CreditInput,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.pos.credit(posId, body.amount, body.note, admin.id);
  }

  @Get(':id/movements')
  @Roles('ADMIN')
  movements(@Param('id', new ParseUUIDPipe()) posId: string) {
    return this.pos.movements(posId);
  }
}
