import type { Producer } from 'kafkajs';
import {
  createLogger,
  createConsumer,
  getProducer,
  publishMessage,
  KAFKA_TOPICS,
  getRedisClient,
  createMetricsServer,
  formatMetrics,
  initTracing,
  shutdownTracing,
} from '@taskqueue/shared';
import type { KafkaConfig, RedisConfig, Job } from '@taskqueue/shared';
import { initDB, createJob, updateJobStatus, getJob } from './db.js';
import { RedisStateStore } from './redis-state.js';

const log = createLogger('state-manager');
type Logger = ReturnType<typeof createLogger>;

export interface StateManagerConfig {
  kafka: KafkaConfig;
  redis: RedisConfig;
  databaseUrl: string;
  metricsPort: number;
}

/**
 * Main State Manager service.
 * Consumes job.submitted from Kafka, creates jobs in PostgreSQL,
 * and emits job.state-change events back to Kafka.
 */
export async function startStateManager(config: StateManagerConfig): Promise<void> {
  initDB(config.databaseUrl);

  const redis = getRedisClient(config.redis);
  const stateStore = new RedisStateStore(redis);
  const producer = await getProducer(config.kafka);

  log.info('State Manager started, consuming job.submitted...');

  await createConsumer(
    config.kafka,
    'state-manager-group',
    [KAFKA_TOPICS.JOB_SUBMITTED, KAFKA_TOPICS.JOB_COMPLETED, KAFKA_TOPICS.JOB_FAILED],
    async ({ topic, message }) => {
      const value = JSON.parse(message.value?.toString() ?? '{}');
      const correlationId = value.correlationId as string;
      const logCtx = log.child({ correlationId, topic });

      try {
        if (topic === KAFKA_TOPICS.JOB_SUBMITTED) {
          await handleJobSubmitted(value, stateStore, producer, logCtx);
        } else if (topic === KAFKA_TOPICS.JOB_COMPLETED) {
          await handleJobCompleted(value, stateStore, producer, logCtx);
        } else if (topic === KAFKA_TOPICS.JOB_FAILED) {
          await handleJobFailed(value, stateStore, producer, logCtx);
        }
      } catch (err) {
        logCtx.error({ err }, 'Failed to process message');
      }
    },
  );

  log.info({ service: 'state-manager' }, 'State Manager running');

  const metricsServer = createMetricsServer(
    config.metricsPort,
    'state-manager',
    async () => collectStateManagerMetrics(redis, stateStore),
  );
  log.info({ metricsPort: config.metricsPort }, 'State Manager metrics server started');
}

async function handleJobSubmitted(
  value: Record<string, unknown>,
  stateStore: RedisStateStore,
  producer: Producer,
  logCtx: Logger,
): Promise<void> {
  const job = await createJob(value as Parameters<typeof createJob>[0]);
  await stateStore.setJobState(job.id, {
    ...job,
    webhookUrl: (value.webhookUrl as string) || null,
    onSuccess: value.onSuccess as Job['onSuccess'] || null,
    onFailure: value.onFailure as Job['onFailure'] || null,
  } as Job);

  logCtx.info({ jobId: job.id, type: job.type }, 'Job created in DB');

  await publishMessage(producer, KAFKA_TOPICS.JOB_STATE_CHANGE, job.id, {
    jobId: job.id,
    previousStatus: null,
    newStatus: job.status,
    timestamp: new Date().toISOString(),
    correlationId: job.correlationId,
  });
}

async function handleJobCompleted(
  value: Record<string, unknown>,
  stateStore: RedisStateStore,
  producer: Producer,
  logCtx: Logger,
): Promise<void> {
  const jobId = value.jobId as string;
  const job = await updateJobStatus(jobId, 'SUCCESS', value.metadata as Record<string, unknown>);
  if (!job) {
    logCtx.warn({ jobId }, 'Job not found for completion');
    return;
  }

  await stateStore.updateJobFull(jobId, {
    status: 'SUCCESS',
    completedAt: job.completedAt,
  });

  await publishMessage(producer, KAFKA_TOPICS.JOB_STATE_CHANGE, jobId, {
    jobId,
    previousStatus: 'RUNNING',
    newStatus: 'SUCCESS',
    timestamp: new Date().toISOString(),
    correlationId: job.correlationId,
    onSuccess: job.onSuccess,
  });

  logCtx.info({ jobId }, 'Job marked as completed');
}

async function handleJobFailed(
  value: Record<string, unknown>,
  stateStore: RedisStateStore,
  producer: Producer,
  logCtx: Logger,
): Promise<void> {
  const jobId = value.jobId as string;
  const errorMessage = value.errorMessage as string;
  const existingJob = await getJob(jobId);

  if (!existingJob) {
    logCtx.warn({ jobId }, 'Job not found for failure');
    return;
  }

  const isDead = existingJob.retryCount + 1 >= existingJob.maxRetries;
  const newStatus = isDead ? 'DEAD' : 'FAILED';

  const job = await updateJobStatus(jobId, newStatus, { errorMessage });
  if (!job) return;

  if (isDead) {
    const { addToDLQ } = await import('./db.js');
    await addToDLQ(jobId, job.type, job.payload, errorMessage, job.retryCount);
    logCtx.warn({ jobId, type: job.type }, 'Job moved to DLQ');
  }

  await stateStore.updateJobFull(jobId, {
    status: newStatus,
    retryCount: job.retryCount,
    failedAt: job.failedAt,
    errorMessage,
  });

  await publishMessage(producer, KAFKA_TOPICS.JOB_STATE_CHANGE, jobId, {
    jobId,
    previousStatus: 'RUNNING',
    newStatus,
    timestamp: new Date().toISOString(),
    correlationId: job.correlationId,
    errorMessage,
    onFailure: job.onFailure,
  });
}

async function collectStateManagerMetrics(
  redis: ReturnType<typeof getRedisClient>,
  stateStore: RedisStateStore,
): Promise<string> {
  const types: Array<'email' | 'image' | 'data'> = ['email', 'image', 'data'];
  const metrics: Array<{ name: string; help: string; type: 'counter' | 'gauge' | 'histogram'; value: number; labels?: Record<string, string> }> = [];

  for (const type of types) {
    const stats = await stateStore.getQueueStats(type);
    const labels = { queue: type };
    metrics.push(
      { name: 'taskqueue_queue_depth', help: 'Queue depth', type: 'gauge', value: stats.depth, labels },
      { name: 'taskqueue_jobs_enqueued_total', help: 'Enqueued total', type: 'counter', value: stats.enqueueRate, labels },
      { name: 'taskqueue_jobs_dequeued_total', help: 'Dequeued total', type: 'counter', value: stats.dequeueRate, labels },
      { name: 'taskqueue_jobs_failed_total', help: 'Failed total', type: 'counter', value: stats.failed, labels },
    );
  }

  const workers = await stateStore.getAllWorkers();
  metrics.push(
    { name: 'taskqueue_workers_active', help: 'Active workers', type: 'gauge', value: workers.length },
    { name: 'taskqueue_state_manager_uptime_seconds', help: 'Uptime', type: 'gauge', value: process.uptime() },
  );

  return formatMetrics(metrics);
}

// Self-invocation entrypoint
initTracing('state-manager', process.env.OTLP_ENDPOINT);
process.on('SIGTERM', () => { shutdownTracing().catch(() => {}); });

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://taskqueue:taskqueue@localhost:5432/taskqueue';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:29092').split(',');
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '3300', 10);

startStateManager({
  kafka: { brokers: KAFKA_BROKERS, clientId: 'state-manager' },
  redis: { host: REDIS_HOST, port: REDIS_PORT },
  databaseUrl: DATABASE_URL,
  metricsPort: METRICS_PORT,
});
