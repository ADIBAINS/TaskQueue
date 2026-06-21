import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DelayedQueue } from '../src/queue/delayed-queue.js';
import type { EnqueuedJob } from '../src/types/index.js';
import Redis from 'ioredis';

function makeJob(id: string): EnqueuedJob {
  return {
    job: {
      id,
      type: 'email',
      priority: 3,
      status: 'PENDING',
      payload: {},
      idempotencyKey: null,
      correlationId: 'test',
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    priority: 3,
    enqueuedAt: Date.now(),
  };
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const describeWithRedis = process.env.RUN_REDIS_TESTS === 'true' ? describe : describe.skip;

describeWithRedis('DelayedQueue', () => {
  let redis: Redis;
  let queue: DelayedQueue;

  beforeEach(async () => {
    redis = new Redis(REDIS_URL);
    queue = new DelayedQueue(redis, 'test-delayed');
    await redis.del('delayed:test-delayed');
  });

  afterEach(async () => {
    await redis.del('delayed:test-delayed');
    await redis.quit();
  });

  it('adds a delayed job and pulls it when ready', async () => {
    const job = makeJob('test-1');
    const pastTime = Date.now() - 1000;

    await queue.add(job, pastTime);

    const ready = await queue.pullReady();
    expect(ready.length).toBe(1);
    expect(ready[0]!.job.id).toBe('test-1');
  });

  it('does not pull jobs scheduled for the future', async () => {
    const job = makeJob('future-1');
    const futureTime = Date.now() + 3600000;

    await queue.add(job, futureTime);

    const ready = await queue.pullReady();
    expect(ready.length).toBe(0);
  });

  it('tracks size correctly', async () => {
    expect(await queue.size()).toBe(0);

    await queue.add(makeJob('a'), Date.now() + 1000);
    await queue.add(makeJob('b'), Date.now() + 2000);

    expect(await queue.size()).toBe(2);
  });

  it('removes a job by ID', async () => {
    await queue.add(makeJob('remove-me'), Date.now() + 5000);
    await queue.add(makeJob('keep-me'), Date.now() + 5000);

    expect(await queue.size()).toBe(2);

    const removed = await queue.remove('remove-me');
    expect(removed).toBe(true);
    expect(await queue.size()).toBe(1);
  });

  it('returns null for empty queue nextExecutionTime', async () => {
    expect(await queue.nextExecutionTime()).toBeNull();
  });

  it('returns the earliest execution time', async () => {
    await queue.add(makeJob('a'), 1000);
    await queue.add(makeJob('b'), 500);

    const next = await queue.nextExecutionTime();
    expect(next).toBe(500);
  });
});
