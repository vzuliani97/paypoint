import { RequestMethod } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AppConfig } from './config';
import { MetricsService } from './metrics/metrics.module';

/** HTTP setup shared by main.ts and the e2e tests, so tests exercise the real configuration. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(app.get(MetricsService).httpMiddleware());
  app.use(helmet());
  app.enableCors({ origin: config.CORS_ORIGIN });
  app.useBodyParser('json', { limit: '10kb' });
  // /health and /metrics stay outside /api: nginx only exposes /api, so metrics are internal-only.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.useGlobalFilters(new AllExceptionsFilter());
}
