import type { Redis } from 'ioredis';
import type { Job, JobStatus, WorkerInfo, QueueStats } from '@taskqueue/shared';

const JOB_STATE_PREFIX = 'job:state:';
const JOB_TTL = 3600; // 1 hour

/**
 * Redis-backed fast state layer for real-time job lookups.
 * All state transitions are written here first, then persisted to PostgreSQL.
 */
export class RedisStateStore {
  constructor(private readonly redis: Redis) {}

  /**
   * Cache a job's current state in Redis.
   */
  async setJobState(jobId: string, job: Job): Promise<void> {
    const key = `${JOB_STATE_PREFIX}${jobId}`;
    await this.redis.set(key, JSON.stringify(job), 'EX', JOB_TTL);
  }

  /**
   * Get a cached job state. Returns null if not found or expired.
   */
  async getJobState(jobId: string): Promise<Job | null> {
    const data = await this.redis.get(`${JOB_STATE_PREFIX}${jobId}`);
    if (!data) return null;
    return JSON.parse(data) as Job;
  }

  /**
   * Update just the status field of a cached job.
   */
  async updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
    const job = await this.getJobState(jobId);
    if (job) {
      job.status = status;
      job.updatedAt = new Date().toISOString();
      await this.setJobState(jobId, job);
    }
  }

  /**
   * Update the full cached job state, syncing all mutable fields.
   * Called after PostgreSQL mutations to keep Redis consistent.
   */
  async updateJobFull(jobId: string, updates: Partial<Pick<Job, 'status' | 'retryCount' | 'workerId' | 'startedAt' | 'completedAt' | 'failedAt' | 'errorMessage' | 'onSuccess' | 'onFailure'>>): Promise<void> {
    const job = await this.getJobState(jobId);
    if (job) {
      Object.assign(job, updates);
      job.updatedAt = new Date().toISOString();
      await this.setJobState(jobId, job);
    }
  }

  /**
   * Store worker info with a heartbeat TTL in Redis.
   */
  async registerWorker(worker: WorkerInfo): Promise<void> {
    const key = `worker:${worker.workerId}`;
    await this.redis.set(key, JSON.stringify(worker), 'EX', 30);
  }

  /**
   * Get info for a specific worker.
   */
  async getWorker(workerId: string): Promise<WorkerInfo | null> {
    const data = await this.redis.get(`worker:${workerId}`);
    if (!data) return null;
    return JSON.parse(data) as WorkerInfo;
  }

  /**
   * Get all currently alive workers.
   */
  async getAllWorkers(): Promise<WorkerInfo[]> {
    const keys = await this.redis.keys('worker:*');
    if (keys.length === 0) return [];

    const pipeline = this.redis.pipeline();
    keys.forEach((k) => pipeline.get(k));
    const results = await pipeline.exec();

    return (results ?? [])
      .filter(([, val]) => val !== null)
      .map(([, val]) => JSON.parse(val as string) as WorkerInfo);
  }

  /**
   * Increment a metrics counter for queue stats.
   */
  async incrementCounter(counter: string, amount: number = 1): Promise<void> {
    await this.redis.incrby(`metrics:${counter}`, amount);
  }

  /**
   * Get current queue stats from Redis metrics counters.
   */
  async getQueueStats(queueName: string): Promise<QueueStats> {
    const pipeline = this.redis.pipeline();
    pipeline.get(`metrics:${queueName}:enqueued`);
    pipeline.get(`metrics:${queueName}:dequeued`);
    pipeline.get(`metrics:${queueName}:failed`);
    pipeline.llen(`queue:${queueName}`);

    const results = await pipeline.exec();
    if (!results) {
      return {
        queueName,
        depth: 0,
        processing: 0,
        failed: 0,
        enqueueRate: 0,
        dequeueRate: 0,
      };
    }

    const enqueued = parseInt((results[0]?.[1] as string) ?? '0', 10);
    const dequeued = parseInt((results[1]?.[1] as string) ?? '0', 10);
    const failed = parseInt((results[2]?.[1] as string) ?? '0', 10);
    const depth = (results[3]?.[1] as number) ?? 0;

    return {
      queueName,
      depth,
      processing: Math.max(0, enqueued - dequeued - failed - depth),
      failed,
      enqueueRate: enqueued,
      dequeueRate: dequeued,
    };
  }
}
