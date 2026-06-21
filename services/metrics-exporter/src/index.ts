import express from 'express';
import { createLogger, getRedisClient, initTracing, shutdownTracing } from '@taskqueue/shared';
import type { RedisConfig } from '@taskqueue/shared';

const log = createLogger('metrics-exporter');

export interface MetricsExporterConfig {
  port: number;
  redis: RedisConfig;
}

interface MetricSample {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  value: number;
  labels?: Record<string, string>;
}

function formatPrometheus(samples: MetricSample[]): string {
  const grouped = new Map<string, MetricSample[]>();
  for (const s of samples) {
    const existing = grouped.get(s.name) || [];
    existing.push(s);
    grouped.set(s.name, existing);
  }

  let output = '';
  for (const [name, group] of grouped) {
    output += `# HELP ${name} ${group[0]!.help}\n`;
    output += `# TYPE ${name} ${group[0]!.type}\n`;
    for (const s of group) {
      const labels = s.labels
        ? `{${Object.entries(s.labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',')}}`
        : '';
      output += `${name}${labels} ${s.value}\n`;
    }
    output += '\n';
  }
  return output;
}

/**
 * Metrics Exporter service.
 * Exposes a /metrics endpoint in Prometheus format.
 * Scrapes Redis for real-time metrics and computes rates from stored data.
 */
export async function startMetricsExporter(config: MetricsExporterConfig): Promise<void> {
  const app = express();
  const redis = getRedisClient(config.redis);

  app.get('/metrics', async (_req, res) => {
    try {
      const samples = await collectMetrics(redis);
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(formatPrometheus(samples));
    } catch (err) {
      log.error({ err }, 'Failed to collect metrics');
      res.status(500).send('# Metrics collection failed\n');
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'metrics-exporter' });
  });

  app.listen(config.port, () => {
    log.info({ port: config.port }, 'Metrics exporter listening');
  });
}

// Self-invocation entrypoint
initTracing('metrics-exporter', process.env.OTLP_ENDPOINT);
process.on('SIGTERM', () => {
  shutdownTracing().catch(() => {});
});

const PORT = parseInt(process.env.PORT || '3500', 10);
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

startMetricsExporter({
  port: PORT,
  redis: { host: REDIS_HOST, port: REDIS_PORT },
});

async function collectMetrics(redis: ReturnType<typeof getRedisClient>): Promise<MetricSample[]> {
  const types = ['email', 'image', 'data'];
  const metrics: MetricSample[] = [];

  for (const type of types) {
    const [enqueued, dequeued, failed, depth] = await Promise.all([
      redis.get(`metrics:${type}:enqueued`),
      redis.get(`metrics:${type}:dequeued`),
      redis.get(`metrics:${type}:failed`),
      redis.llen(`queue:${type}`),
    ]);

    const labels = { queue: type };

    metrics.push({
      name: 'taskqueue_jobs_enqueued_total',
      help: 'Total number of jobs enqueued to worker queues',
      type: 'counter',
      value: parseInt((enqueued as string) || '0', 10),
      labels,
    });

    metrics.push({
      name: 'taskqueue_jobs_dequeued_total',
      help: 'Total number of jobs dequeued from worker queues',
      type: 'counter',
      value: parseInt((dequeued as string) || '0', 10),
      labels,
    });

    metrics.push({
      name: 'taskqueue_jobs_failed_total',
      help: 'Total number of failed jobs',
      type: 'counter',
      value: parseInt((failed as string) || '0', 10),
      labels,
    });

    metrics.push({
      name: 'taskqueue_queue_depth',
      help: 'Current number of jobs waiting in the queue',
      type: 'gauge',
      value: depth || 0,
      labels,
    });
  }

  // Worker utilization - count active workers
  const workerKeys = await redis.keys('heartbeat:*');
  metrics.push({
    name: 'taskqueue_workers_active',
    help: 'Number of currently active workers',
    type: 'gauge',
    value: workerKeys.length,
  });

  // DLQ size
  const dlqKeys = await redis.keys('dlq:*');
  metrics.push({
    name: 'taskqueue_dlq_size',
    help: 'Number of jobs in the Dead Letter Queue',
    type: 'gauge',
    value: dlqKeys.length,
  });

  // Uptime
  metrics.push({
    name: 'taskqueue_metrics_exporter_uptime_seconds',
    help: 'Uptime of the metrics exporter in seconds',
    type: 'gauge',
    value: process.uptime(),
  });

  return metrics;
}
