import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from '../config';
import { DatabaseService } from './database.service';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }, DatabaseService],
  exports: [APP_CONFIG, DatabaseService],
})
export class CoreModule {}
