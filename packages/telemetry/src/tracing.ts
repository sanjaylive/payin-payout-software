import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

/**
 * OpenTelemetry tracing (docs/OBSERVABILITY.md §3). Must run before anything imports http, pg,
 * ioredis, kafkajs or pino — each process's entry file imports its `instrument` module first.
 * Disabled (zero overhead) unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Privacy: Postgres spans carry the parameterised SQL text only (never bound values); Redis spans
 * carry the command name only (keys and arguments can hold nonces and session ids); health and
 * metrics requests are not traced. Log lines gain trace_id/span_id for correlation.
 */
export interface TracingOptions {
  service: string;
  endpoint: string | undefined;
  /** 0–1, fraction of new traces kept (children follow their parent's decision). */
  sampleRatio: number;
  environment: string;
  version?: string;
}

let sdk: NodeSDK | null = null;

export function initTracing(opts: TracingOptions): boolean {
  if (!opts.endpoint || sdk) return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': `pay2all-${opts.service}`,
      'service.version': opts.version ?? '0.0.0',
      'deployment.environment.name': opts.environment,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/$/, '')}/v1/traces` }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(opts.sampleRatio) }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => /^\/(health|metrics)(\/|$|\?)/.test(req.url ?? ''),
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
      new KafkaJsInstrumentation(),
      new PinoInstrumentation({ disableLogSending: true }),
    ],
  });
  sdk.start();
  return true;
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
  sdk = null;
}
