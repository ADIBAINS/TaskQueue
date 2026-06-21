import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing with OTLP export to Jaeger.
 * Call once at service startup. No-op if OTLP endpoint is not configured.
 *
 * @param serviceName - Name of the service for span attribution
 * @param otlpEndpoint - OTLP HTTP endpoint (e.g., 'http://localhost:4318/v1/traces')
 */
export function initTracing(serviceName: string, otlpEndpoint?: string): void {
  if (!otlpEndpoint) return;

  if (sdk) {
    sdk.shutdown().catch(() => {});
  }

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });

  sdk = new NodeSDK({
    serviceName,
    traceExporter: exporter,
    instrumentations: [
      new HttpInstrumentation(),
      new IORedisInstrumentation(),
      new PgInstrumentation(),
      new KafkaJsInstrumentation(),
    ],
  });

  sdk.start();
  console.log(`[tracing] OpenTelemetry tracing started for ${serviceName} → ${otlpEndpoint}`);
}

/**
 * Gracefully shut down tracing before the process exits.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}
