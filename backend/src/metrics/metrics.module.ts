import { Controller, Get, Global, Injectable, Module, Res } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'paypoint_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly sales = new Counter({
    name: 'paypoint_sales_total',
    help: 'Sales created, by resulting status and channel',
    labelNames: ['status', 'channel'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'paypoint_' });

    // Export every status/channel series at 0 from startup. A counter that first appears at 1 is invisible
    // to increase()/rate(), so the first sale after each restart would be lost from dashboards and alerts.
    for (const status of ['CONFIRMED', 'FAILED', 'PENDING']) {
      for (const channel of ['PORTAL', 'PARTNER']) {
        this.sales.labels({ status, channel }).inc(0);
      }
    }
  }

  /** Express middleware. Labels by route pattern (/api/sales/:id), never by raw URL, to keep cardinality low. */
  httpMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const stop = this.httpDuration.startTimer();

      res.on('finish', () => {
        const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
        stop({ method: req.method, route, status: String(res.statusCode) });
      });

      next();
    };
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res() res: Response) {
    res.type(this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }
}

// Global so SalesService can record business metrics without importing this module.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
