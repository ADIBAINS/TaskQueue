import type { Producer, Consumer } from 'kafkajs';
import { CronExpressionParser } from 'cron-parser';
import {
  createLogger,
  createConsumer,
  getProducer,
  getRedisClient,
  publishMessage,
  PriorityQueue,
  DelayedQueue,
  WorkerQueue,
  KAFKA_TOPICS,
  createMetricsServer,
  formatMetrics,
  initTracing,
  shutdownTracing,
} from '@taskqueue/shared';
import type {
  KafkaConfig,
  RedisConfig,
  Job,
  EnqueuedJob,
  JobType,
  JobPriority,
  CronJob,
} from '@taskqueue/shared';

const log = createLogger('scheduler');

export interface SchedulerConfig {
  kafka: KafkaConfig;
  redis: RedisConfig;
  metricsPort: number;
  databaseUrl?: string;
}

/** Maximum number of retry attempts before a job is sent to the DLQ. */
const DEFAULT_MAX_RETRIES = 3;

/** Base delay for exponential backoff in milliseconds. */
const BASE_RETRY_DELAY_MS = 1000;

/** Interval for checking the delayed queue for ready jobs. */
const DELAYED_CHECK_INTERVAL_MS = 500;

/** Interval for draining the priority queue into worker queues. */
const DRAIN_INTERVAL_MS = 200;

/** Maximum number of jobs to drain per cycle. */
const DRAIN_BATCH_SIZE = 100;

/**
 * Compute exponential backoff delay for a given retry count.
 * Formula: base * 2^retryCount with jitter.
 */
function getRetryDelay(retryCount: number): number {
  const base = BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
  const jitter = Math.random() * 500;
  return base + jitter;
}

/**
 * Main Scheduler service.
 * Consumes job.submitted from Kafka, queues jobs in an in-memory priority heap,
 * routes delayed jobs through Redis sorted sets, and dispatches ready jobs
 * to the appropriate worker queue with retry and DLQ support.
 */
export async function startScheduler(config: SchedulerConfig): Promise<void> {
  const producer = await getProducer(config.kafka);
  const redis = getRedisClient(config.redis);
  const priorityQueue = new PriorityQueue();
  const queues = {
    email: new WorkerQueue(redis, 'email'),
    image: new WorkerQueue(redis, 'image'),
    data: new WorkerQueue(redis, 'data'),
  };

  const delayedQueue = new DelayedQueue(redis, 'scheduler');

  let consumer: Consumer;

  // --- Kafka Consumer ---
  const handler = async ({
    message,
  }: {
    topic: string;
    message: { key?: Buffer | null; value?: Buffer | null };
  }) => {
    try {
      const value = JSON.parse(message.value?.toString() ?? '{}');
      const job = value as Job;

      log.info(
        { jobId: job.id, type: job.type, priority: job.priority },
        'Received job for scheduling',
      );

      // Check if this is a delayed/scheduled job
      if (job.scheduledAt) {
        const executeAt = new Date(job.scheduledAt).getTime();
        const enqueued: EnqueuedJob = {
          job,
          priority: job.priority,
          enqueuedAt: Date.now(),
        };
        await delayedQueue.add(enqueued, executeAt);
        await publishMessage(producer, KAFKA_TOPICS.JOB_STATE_CHANGE, job.id, {
          jobId: job.id,
          previousStatus: 'PENDING',
          newStatus: 'SCHEDULED',
          timestamp: new Date().toISOString(),
          correlationId: job.correlationId,
        });
        log.info(
          { jobId: job.id, executeAt: new Date(executeAt).toISOString() },
          'Job added to delayed queue',
        );
        return;
      }

      // Standard job — add to priority queue immediately
      priorityQueue.enqueue({
        job,
        priority: job.priority,
        enqueuedAt: Date.now(),
      });

      await publishMessage(producer, KAFKA_TOPICS.JOB_SCHEDULED, job.id, {
        jobId: job.id,
        scheduledAt: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err }, 'Failed to process incoming job');
    }
  };

  // Handle retries and cancellation from the state-change topic.
  const stateChangeHandler = async ({
    message,
  }: {
    topic: string;
    message: { key?: Buffer | null; value?: Buffer | null };
  }) => {
    try {
      const value = JSON.parse(message.value?.toString() ?? '{}');
      const { jobId, newStatus, previousStatus } = value;

      if (newStatus === 'CANCELLED') {
        priorityQueue.remove(jobId);
        await Promise.all([
          delayedQueue.remove(jobId),
          queues.email.remove(jobId),
          queues.image.remove(jobId),
          queues.data.remove(jobId),
        ]);
        log.info({ jobId }, 'Cancelled job removed from scheduler queues');
        return;
      }

      if (newStatus !== 'FAILED' || previousStatus !== 'RUNNING') return;

      // Get the full job from Redis
      const cachedJob = await redis.get(`job:state:${jobId}`);
      if (!cachedJob) return;

      const job: Job = JSON.parse(cachedJob);

      if (job.retryCount < (job.maxRetries || DEFAULT_MAX_RETRIES)) {
        const delay = getRetryDelay(job.retryCount);
        const executeAt = Date.now() + delay;
        const enqueued: EnqueuedJob = { job, priority: job.priority, enqueuedAt: Date.now() };

        await delayedQueue.add(enqueued, executeAt);
        log.info(
          {
            jobId,
            retryCount: job.retryCount,
            delay,
            executeAt: new Date(executeAt).toISOString(),
          },
          'Job queued for retry with exponential backoff',
        );
      } else {
        // Max retries exceeded — publish to DLQ flow
        log.warn({ jobId, retryCount: job.retryCount }, 'Job exceeded max retries, routing to DLQ');

        await publishMessage(producer, KAFKA_TOPICS.JOB_FAILED, jobId, {
          jobId,
          errorMessage: `Max retries (${job.maxRetries || DEFAULT_MAX_RETRIES}) exceeded`,
          correlationId: job.correlationId,
        });
      }
    } catch (err) {
      log.error({ err }, 'Failed to process retry');
    }
  };

  consumer = await createConsumer(
    config.kafka,
    'scheduler-group',
    [KAFKA_TOPICS.JOB_SUBMITTED, KAFKA_TOPICS.JOB_STATE_CHANGE],
    async (payload) => {
      if (payload.topic === KAFKA_TOPICS.JOB_SUBMITTED) {
        await handler(payload);
      } else if (payload.topic === KAFKA_TOPICS.JOB_STATE_CHANGE) {
        await stateChangeHandler(payload);
      }
    },
  );

  // --- Delayed Queue Poller ---
  const delayedPoller = setInterval(async () => {
    try {
      const readyJobs = await delayedQueue.pullReady();
      if (readyJobs.length === 0) return;

      for (const enqueued of readyJobs) {
        priorityQueue.enqueue(enqueued);
      }

      log.info({ count: readyJobs.length }, 'Moved delayed jobs to active queue');
    } catch (err) {
      log.error({ err }, 'Delayed queue poller error');
    }
  }, DELAYED_CHECK_INTERVAL_MS);

  // --- Priority Queue Drainer ---
  const drainer = setInterval(async () => {
    try {
      let drained = 0;

      while (priorityQueue.size() > 0 && drained < DRAIN_BATCH_SIZE) {
        const item = priorityQueue.dequeue();
        if (!item) break;

        const cached = await redis.get(`job:state:${item.job.id}`);
        if (cached && (JSON.parse(cached) as Job).status === 'CANCELLED') {
          continue;
        }

        const workerQueue = queues[item.job.type];
        if (workerQueue) {
          await workerQueue.enqueue(item.job);

          // Update metrics
          await redis.incrby(`metrics:${item.job.type}:enqueued`, 1);

          await publishMessage(producer, KAFKA_TOPICS.JOB_ASSIGNED, item.job.id, {
            jobId: item.job.id,
            workerType: item.job.type,
            priority: item.priority,
            assignedAt: new Date().toISOString(),
          });
          await publishMessage(producer, KAFKA_TOPICS.JOB_STATE_CHANGE, item.job.id, {
            jobId: item.job.id,
            previousStatus: item.job.scheduledAt ? 'SCHEDULED' : 'PENDING',
            newStatus: 'QUEUED',
            timestamp: new Date().toISOString(),
            correlationId: item.job.correlationId,
          });

          drained++;
        } else {
          log.warn({ jobType: item.job.type, jobId: item.job.id }, 'Unknown job type, skipping');
        }
      }

      if (drained > 0) {
        log.info({ drained, remaining: priorityQueue.size() }, 'Drained jobs to worker queues');
      }
    } catch (err) {
      log.error({ err }, 'Priority queue drainer error');
    }
  }, DRAIN_INTERVAL_MS);

  log.info({ service: 'scheduler' }, 'Scheduler running');

  const metricsServer = createMetricsServer(config.metricsPort, 'scheduler', async () =>
    collectSchedulerMetrics(redis, priorityQueue, delayedQueue),
  );
  log.info({ metricsPort: config.metricsPort }, 'Scheduler metrics server started');

  // --- Cron Job Poller ---
  let cronPoller: NodeJS.Timeout | undefined;
  if (config.databaseUrl) {
    const { Pool } = await import('pg');
    const pgPool = new Pool({ connectionString: config.databaseUrl, max: 1 });

    cronPoller = setInterval(async () => {
      try {
        const result = await pgPool.query<Record<string, unknown>>(
          'SELECT * FROM cron_jobs WHERE enabled = TRUE ORDER BY next_run ASC',
        );

        for (const row of result.rows) {
          const cron = row as unknown as {
            id: string;
            name: string;
            cron_expression: string;
            job_type: string;
            payload: Record<string, unknown>;
            priority: number;
            next_run: string | null;
          };
          const interval = CronExpressionParser.parse(cron.cron_expression);
          const nextRun = interval.next().toDate();
          const now = new Date();

          if (cron.next_run && new Date(cron.next_run) > now) continue;

          const jobId = crypto.randomUUID();
          await publishMessage(producer, KAFKA_TOPICS.JOB_SUBMITTED, jobId, {
            id: jobId,
            type: cron.job_type,
            priority: cron.priority,
            status: 'PENDING',
            payload: cron.payload,
            idempotencyKey: null,
            correlationId: crypto.randomUUID(),
            retryCount: 0,
            maxRetries: 3,
            scheduledAt: null,
            startedAt: null,
            completedAt: null,
            failedAt: null,
            errorMessage: null,
            workerId: null,
            onSuccess: null,
            onFailure: null,
            webhookUrl: null,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          });

          await pgPool.query(
            'UPDATE cron_jobs SET last_run = NOW(), next_run = $1, updated_at = NOW() WHERE id = $2',
            [nextRun.toISOString(), cron.id],
          );

          log.info(
            { cronName: cron.name, jobId, nextRun: nextRun.toISOString() },
            'Cron job triggered',
          );
        }
      } catch (err) {
        log.error({ err }, 'Cron poller error');
      }
    }, DELAYED_CHECK_INTERVAL_MS);

    log.info('Cron scheduler started');
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    log.info('Scheduler shutting down...');
    clearInterval(delayedPoller);
    clearInterval(drainer);
    if (cronPoller) clearInterval(cronPoller);
    metricsServer.close();
    await consumer.disconnect();
  });
}

async function collectSchedulerMetrics(
  redis: ReturnType<typeof getRedisClient>,
  priorityQueue: PriorityQueue,
  delayedQueue: DelayedQueue,
): Promise<string> {
  const types: JobType[] = ['email', 'image', 'data'];
  const metrics: Array<{
    name: string;
    help: string;
    type: 'counter' | 'gauge' | 'histogram';
    value: number;
    labels?: Record<string, string>;
  }> = [];

  for (const type of types) {
    const [enqueued, dequeued, failed, depth] = await Promise.all([
      redis.get(`metrics:${type}:enqueued`),
      redis.get(`metrics:${type}:dequeued`),
      redis.get(`metrics:${type}:failed`),
      redis.llen(`queue:${type}`),
    ]);

    const labels = { queue: type };
    metrics.push(
      {
        name: 'taskqueue_queue_depth',
        help: 'Queue depth per type',
        type: 'gauge',
        value: depth || 0,
        labels,
      },
      {
        name: 'taskqueue_jobs_enqueued_total',
        help: 'Total enqueued',
        type: 'counter',
        value: parseInt((enqueued as string) || '0', 10),
        labels,
      },
      {
        name: 'taskqueue_jobs_dequeued_total',
        help: 'Total dequeued',
        type: 'counter',
        value: parseInt((dequeued as string) || '0', 10),
        labels,
      },
      {
        name: 'taskqueue_jobs_failed_total',
        help: 'Total failed',
        type: 'counter',
        value: parseInt((failed as string) || '0', 10),
        labels,
      },
    );
  }

  metrics.push(
    {
      name: 'taskqueue_priority_queue_depth',
      help: 'Active priority queue depth',
      type: 'gauge',
      value: priorityQueue.size(),
    },
    {
      name: 'taskqueue_delayed_queue_depth',
      help: 'Delayed jobs waiting',
      type: 'gauge',
      value: await delayedQueue.size(),
    },
    {
      name: 'taskqueue_scheduler_uptime_seconds',
      help: 'Scheduler uptime',
      type: 'gauge',
      value: process.uptime(),
    },
  );

  return formatMetrics(metrics);
}

// Self-invocation entrypoint
initTracing('scheduler', process.env.OTLP_ENDPOINT);
process.on('SIGTERM', () => {
  shutdownTracing().catch(() => {});
});

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:29092').split(',');
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

startScheduler({
  kafka: { brokers: KAFKA_BROKERS, clientId: 'scheduler' },
  redis: { host: REDIS_HOST, port: REDIS_PORT },
  metricsPort: 3200,
  databaseUrl: process.env.DATABASE_URL,
});
