import type { OnApplicationShutdown } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { createAllowListAttributesProcessor, MeterProvider } from '@opentelemetry/sdk-metrics';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export class MetricsRuntime implements OnApplicationShutdown {
  private constructor(
    private readonly provider: MeterProvider,
    private readonly server: Server,
  ) {}

  static async start(
    options: { METRICS_HOST: string; METRICS_PORT: number; OTEL_SERVICE_NAME: string },
    role: 'api' | 'worker',
  ): Promise<MetricsRuntime> {
    const exporter = new PrometheusExporter({
      preventServerStart: true,
      withoutScopeInfo: true,
      withoutTargetInfo: true,
    });
    const provider = new MeterProvider({
      readers: [exporter],
      views: [
        {
          instrumentName: '*',
          attributesProcessors: [
            createAllowListAttributesProcessor([
              'operation',
              'result',
              'consumer',
              'state',
              'scope',
              'queue',
            ]),
            {
              process: (attributes) => ({
                ...attributes,
                service: options.OTEL_SERVICE_NAME,
                process_role: role,
              }),
            },
          ],
        },
      ],
    });
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      exporter.getMetricsRequestHandler(request, response);
    });
    const runtime = new MetricsRuntime(provider, server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.METRICS_PORT, options.METRICS_HOST, resolve);
      });
      if (!metrics.setGlobalMeterProvider(provider)) throw new Error('METRICS_ALREADY_STARTED');
      return runtime;
    } catch {
      await runtime.onApplicationShutdown();
      throw new Error('METRICS_START_FAILED');
    }
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    await this.provider.shutdown();
    if (metrics.getMeterProvider() === this.provider) metrics.disable();
  }
}
