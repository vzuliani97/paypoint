import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { SimulatedTopupProvider } from './provider/simulated-topup.provider';
import { TOPUP_PROVIDER } from './provider/topup-provider';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [CatalogModule],
  controllers: [SalesController],
  providers: [SalesService, { provide: TOPUP_PROVIDER, useClass: SimulatedTopupProvider }],
  exports: [SalesService],
})
export class SalesModule {}
