import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger/index.js';
import { getProducer, publishMessage, KAFKA_TOPICS } from '../kafka/index.js';
import type { KafkaConfig } from '../kafka/index.js';
import { getRedisClient, heartbeat } from '../redis/index.js';
import type { RedisConfig } from '../redis/index.js';
import { WorkerQueue } from './worker-queue.js';
import type { Job, JobType, JobChaining } from '../types/index.js';
import type { Producer } from 'kafkajs';
import { createMetricsServer, formatMetrics } from '../metrics-server.js';
import { initTracing, shutdownTracing } from '../tracing.js';
import type { Redis } from 'ioredis';

const log = createLogger('worker');

/**
 * Configuration for a worker pool instance.
 */
export interface WorkerConfig {
  workerType: JobType;
  kafka: KafkaConfig;
  redis: RedisConfig;
  maxConcurrency: number;
  metricsPort: number;
}

/**
 * A semaphore implementation using a counter to control concurrent job execution.
 * Used to limit the number of jobs a worker processes simultaneously.
 */
export class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  /**
   * Acquire a permit. Blocks if no permits are available.
   */
  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a permit, potentially unblocking a waiting acquirer.
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }

  /**
   * Return the number of available permits.
   */
  available(): number {
    return this.count;
  }
}

/**
 * Heartbeat loop that signals the worker is alive every 5 seconds.
 */
function startHeartbeat(redis: ReturnType<typeof getRedisClient>, workerId: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await heartbeat(redis, workerId, 15);
    } catch {
      // heartbeat failure is non-fatal
    }
  }, 5000);
}

/**
 * Process a single job through its lifecycle: lock, mark RUNNING, execute, mark SUCCESS/FAILED.
 */
async function processJob(
  job: Job,
  workerId: string,
  producer: Producer,
  redis: ReturnType<typeof getRedisClient>,
  workerType: JobType,
  execute: (job: Job) => Promise<{ success: boolean; result?: Record<string, unknown>; error?: string }>,
): Promise<void> {
  const startTime = Date.now();
  log.info({ jobId: job.id, type: job.type, workerId }, 'Processing job');

  const lockKey = `lock:job:${job.id}`;
  const locked = await redis.set(lockKey, workerId, 'EX', 60, 'NX');
  if (locked !== 'OK') {
    log.warn({ jobId: job.id }, 'Job already locked by another worker');
    return;
  }

  try {
    await publishMessage(producer, KAFKA_TOPICS.JOB_STATE_CHANGE, job.id, {
      jobId: job.id,
      previousStatus: 'QUEUED',
      newStatus: 'RUNNING',
      timestamp: new Date().toISOString(),
      workerId,
      correlationId: job.correlationId,
    });

    const lockExtender = setInterval(async () => {
      await redis.expire(lockKey, 60);
    }, 15000);

    const result = await execute(job);
    clearInterval(lockExtender);

    const duration = Date.now() - startTime;
    await redis.set(`metrics:${workerType}:job_duration:${job.id}`, duration.toString(), 'EX', 3600);

    if (result.success) {
      await publishMessage(producer, KAFKA_TOPICS.JOB_COMPLETED, job.id, {
        jobId: job.id,
        workerType,
        duration,
        result: result.result,
        correlationId: job.correlationId,
        metadata: { workerId, duration },
      });

      if (job.onSuccess) {
        await handleJobChaining(job.onSuccess, producer, job.correlationId);
      }
    } else {
      await publishMessage(producer, KAFKA_TOPICS.JOB_FAILED, job.id, {
        jobId: job.id,
        workerType,
        errorMessage: result.error || 'Unknown error',
        correlationId: job.correlationId,
        metadata: { workerId, duration },
      });

      if (job.onFailure) {
        await handleJobChaining(job.onFailure, producer, job.correlationId);
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err, jobId: job.id, workerId }, 'Job processing failed');

    await publishMessage(producer, KAFKA_TOPICS.JOB_FAILED, job.id, {
      jobId: job.id,
      workerType,
      errorMessage,
      correlationId: job.correlationId,
      metadata: { workerId },
    });
  } finally {
    await redis.del(lockKey);
  }
}

/**
 * Handle job chaining — submit the next job when the current one completes.
 */
async function handleJobChaining(
  chain: JobChaining,
  producer: Producer,
  correlationId: string,
): Promise<void> {
  const nextJob = {
    id: uuidv4(),
    type: chain.nextJobType,
    priority: chain.priority,
    payload: chain.payload,
    idempotencyKey: null,
    maxRetries: 3,
    scheduledAt: null,
    onSuccess: null,
    onFailure: null,
    webhookUrl: null,
  };

  await publishMessage(producer, KAFKA_TOPICS.JOB_SUBMITTED, nextJob.id, {
    ...nextJob,
    status: 'PENDING',
    correlationId,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  log.info({ parentCorrelationId: correlationId, nextJobId: nextJob.id, nextType: nextJob.type }, 'Chained job submitted');
}

/**
 * Reclaim orphaned jobs — jobs locked by dead workers with expired locks.
 */
async function reclaimOrphans(redis: ReturnType<typeof getRedisClient>, workerType: JobType): Promise<void> {
  const queue = new WorkerQueue(redis, workerType);
  const expired = await queue.findExpiredLocks();

  if (expired.length > 0) {
    log.warn({ count: expired.length, workerType }, 'Reclaiming orphaned jobs');

    for (const jobId of expired) {
      const cached = await redis.get(`job:state:${jobId}`);
      if (cached) {
        const job: Job = JSON.parse(cached);
        await queue.enqueue(job);
      }
    }
  }
}

/**
 * Start a worker pool for a specific job type.
 *
 * Workers pull jobs from a Redis-backed FIFO queue, process them with controlled
 * concurrency via a semaphore, send heartbeats every 5 seconds to signal they're alive,
 * and periodically reclaim orphaned jobs from dead workers.
 *
 * @param config - Worker configuration including type, concurrency, and infra connections
 * @param execute - The job execution function, specific to the worker type
 */
export async function startWorker(
  config: WorkerConfig,
  execute: (job: Job) => Promise<{ success: boolean; result?: Record<string, unknown>; error?: string }>,
): Promise<void> {
  const redis = getRedisClient(config.redis);
  const producer = await getProducer(config.kafka);
  const queue = new WorkerQueue(redis, config.workerType);
  const semaphore = new Semaphore(config.maxConcurrency);
  const workerId = `${config.workerType}-worker-${uuidv4().slice(0, 8)}`;

  initTracing(`${config.workerType}-worker`, process.env.OTLP_ENDPOINT);
  process.on('SIGTERM', () => { shutdownTracing().catch(() => {}); });

  const metricsServer = createMetricsServer(
    config.metricsPort,
    `${config.workerType}-worker`,
    async () => collectWorkerMetrics(redis, config.workerType, workerId),
  );
  log.info({ workerId, metricsPort: config.metricsPort }, 'Worker metrics server started');

  log.info({ workerId, type: config.workerType, maxConcurrency: config.maxConcurrency }, 'Worker started');

  const heartbeatTimer = startHeartbeat(redis, workerId);

  const reclaimer = setInterval(() => {
    reclaimOrphans(redis, config.workerType).catch((err) => {
      log.error({ err }, 'Reclaimer error');
    });
  }, 10_000);

  async function workLoop(): Promise<void> {
    while (true) {
      await semaphore.acquire();

      try {
        const job = await queue.dequeue(5);
        if (!job) {
          semaphore.release();
          continue;
        }

        processJob(job, workerId, producer, redis, config.workerType, execute)
          .finally(() => semaphore.release());
      } catch (err) {
        semaphore.release();
        log.error({ err }, 'Work loop error, releasing semaphore');
      }
    }
  }

  workLoop().catch((err) => log.error({ err }, 'Worker loop crashed'));

  process.on('SIGTERM', async () => {
    log.info({ workerId }, 'Worker shutting down...');
    clearInterval(heartbeatTimer);
    clearInterval(reclaimer);
    metricsServer.close();
  });
}

async function collectWorkerMetrics(
  redis: Redis,
  workerType: string,
  workerId: string,
): Promise<string> {
  const [depth, enqueued, dequeued, failed, heartbeatKeys] = await Promise.all([
    redis.llen(`queue:${workerType}`),
    redis.get(`metrics:${workerType}:enqueued`),
    redis.get(`metrics:${workerType}:dequeued`),
    redis.get(`metrics:${workerType}:failed`),
    redis.keys('heartbeat:*'),
  ]);

  return formatMetrics([
    {
      name: 'taskqueue_queue_depth',
      help: 'Current worker queue depth',
      type: 'gauge',
      value: depth || 0,
      labels: { queue: workerType, worker_id: workerId },
    },
    {
      name: 'taskqueue_jobs_enqueued_total',
      help: 'Total enqueued in worker queue',
      type: 'counter',
      value: parseInt(enqueued as string || '0', 10),
      labels: { queue: workerType },
    },
    {
      name: 'taskqueue_jobs_dequeued_total',
      help: 'Total dequeued from worker queue',
      type: 'counter',
      value: parseInt(dequeued as string || '0', 10),
      labels: { queue: workerType },
    },
    {
      name: 'taskqueue_jobs_failed_total',
      help: 'Total failed jobs',
      type: 'counter',
      value: parseInt(failed as string || '0', 10),
      labels: { queue: workerType },
    },
    {
      name: 'taskqueue_workers_active',
      help: 'Active workers (heartbeat keys)',
      type: 'gauge',
      value: heartbeatKeys.length,
    },
    {
      name: 'taskqueue_worker_uptime_seconds',
      help: 'Worker process uptime',
      type: 'gauge',
      value: process.uptime(),
      labels: { worker_id: workerId },
    },
  ]);
}
