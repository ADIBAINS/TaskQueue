import type { Redis } from 'ioredis';
import type { EnqueuedJob } from '../types/index.js';

/**
 * A delayed job queue backed by Redis sorted sets.
 * Jobs are stored with their execution timestamp as the score.
 * A scheduler loop periodically checks for jobs whose execution time has passed
 * and moves them to the active queue.
 */
export class DelayedQueue {
  private readonly key: string;

  constructor(
    private readonly redis: Redis,
    queueName: string,
  ) {
    this.key = `delayed:${queueName}`;
  }

  /**
   * Schedule a job for future execution.
   * @param job - The job to delay
   * @param executeAt - Unix timestamp (ms) when the job should execute
   */
  async add(job: EnqueuedJob, executeAt: number): Promise<void> {
    const data = JSON.stringify(job);
    await this.redis.zadd(this.key, executeAt, data);
  }

  /**
   * Fetch all jobs whose execution time has passed.
   * These jobs are removed from the delayed queue and returned.
   * Used by the scheduler loop to move ready jobs to the active queue.
   */
  async pullReady(now: number = Date.now()): Promise<EnqueuedJob[]> {
    const results = await this.redis
      .multi()
      .zrangebyscore(this.key, 0, now)
      .zremrangebyscore(this.key, 0, now)
      .exec();

    if (!results || results.length < 2) {
      return [];
    }

    const members = results[0]?.[1] as string[] | null;
    if (!members || members.length === 0) {
      return [];
    }

    return members.map((m) => JSON.parse(m) as EnqueuedJob);
  }

  /**
   * Get the number of jobs in the delayed queue.
   */
  async size(): Promise<number> {
    return this.redis.zcard(this.key);
  }

  /**
   * Remove a specific job from the delayed queue by its job ID.
   */
  async remove(jobId: string): Promise<boolean> {
    const members = await this.redis.zrange(this.key, 0, -1);
    for (const member of members) {
      const job: EnqueuedJob = JSON.parse(member);
      if (job.job.id === jobId) {
        await this.redis.zrem(this.key, member);
        return true;
      }
    }
    return false;
  }

  /**
   * Get the earliest scheduled execution time in the queue.
   * Returns null if the queue is empty.
   */
  async nextExecutionTime(): Promise<number | null> {
    const result = await this.redis.zrange(this.key, 0, 0, 'WITHSCORES');
    if (!result || result.length < 2) {
      return null;
    }
    return parseInt(result[1]!, 10);
  }
}
