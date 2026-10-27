import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { CoreModule } from './database/core.module';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { PartnerModule } from './partner/partner.module';
import { PosModule } from './pos/pos.module';
import { SalesModule } from './sales/sales.module';

@Module({
  imports: [CoreModule, MetricsModule, AuthModule, PosModule, CatalogModule, SalesModule, PartnerModule],
  controllers: [HealthController],
})
export class AppModule {}
