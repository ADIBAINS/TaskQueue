import type { Redis } from 'ioredis';
import type { Job, JobType } from '../types/index.js';

/**
 * A Redis-backed FIFO queue for worker pools.
 * Each worker type gets its own queue (e.g., `queue:email`, `queue:image`).
 * Uses Redis LIST operations (RPUSH for enqueue, BLPOP for blocking dequeue).
 */
export class WorkerQueue {
  private readonly key: string;
  private readonly lockPrefix: string;

  constructor(
    private readonly redis: Redis,
    workerType: JobType,
  ) {
    this.key = `queue:${workerType}`;
    this.lockPrefix = `lock:job:`;
  }

  /**
   * Push a job onto the tail of the FIFO queue.
   */
  async enqueue(job: Job): Promise<void> {
    await this.redis.rpush(this.key, JSON.stringify(job));
  }

  /**
   * Block until a job is available, then pop and return it from the head of the queue.
   * Blocks for up to `timeout` seconds (0 = block indefinitely).
   * Returns null if timeout is reached without a job.
   */
  async dequeue(timeout: number = 0): Promise<Job | null> {
    const result = await this.redis.blpop(this.key, timeout);
    if (!result || result.length < 2) {
      return null;
    }
    return JSON.parse(result[1]!) as Job;
  }

  /**
   * Non-blocking pop from the head of the queue.
   * Returns null if the queue is empty.
   */
  async tryDequeue(): Promise<Job | null> {
    const result = await this.redis.lpop(this.key);
    if (!result) {
      return null;
    }
    return JSON.parse(result) as Job;
  }

  /**
   * Peek at the head of the queue without removing it.
   */
  async peek(): Promise<Job | null> {
    const result = await this.redis.lindex(this.key, 0);
    if (!result) {
      return null;
    }
    return JSON.parse(result) as Job;
  }

  /**
   * Return the current length of the queue.
   */
  async size(): Promise<number> {
    return this.redis.llen(this.key);
  }

  /**
   * Acquire a distributed lock on a job using SET NX EX.
   * Returns true if the lock was acquired.
   */
  async acquireLock(jobId: string, workerId: string, ttlSeconds: number = 30): Promise<boolean> {
    const key = `${this.lockPrefix}${jobId}`;
    const result = await this.redis.set(key, workerId, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Release a job lock. Only releases if the lock is held by the given worker.
   */
  async releaseLock(jobId: string, workerId: string): Promise<boolean> {
    const key = `${this.lockPrefix}${jobId}`;
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, workerId);
    return result === 1;
  }

  /**
   * Extend a lock's TTL. Only extends if the lock is held by the given worker.
   */
  async extendLock(jobId: string, workerId: string, ttlSeconds: number = 30): Promise<boolean> {
    const key = `${this.lockPrefix}${jobId}`;
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("EXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, workerId, ttlSeconds);
    return result === 1;
  }

  /**
   * Find and reclaim orphaned jobs — jobs with expired locks.
   * Returns the job IDs that should be re-queued.
   */
  async findExpiredLocks(): Promise<string[]> {
    const keys = await this.redis.keys(`${this.lockPrefix}*`);
    const expired: string[] = [];

    for (const key of keys) {
      const ttl = await this.redis.ttl(key);
      if (ttl <= 0) {
        const jobId = key.replace(this.lockPrefix, '');
        await this.redis.del(key);
        expired.push(jobId);
      }
    }

    return expired;
  }
}
