import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { Response } from 'express';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @HttpCode(200)
  async check(@Res({ passthrough: true }) res: Response) {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      res.status(503);
      return { status: 'error', database: 'unavailable' };
    }
  }
}
