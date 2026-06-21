import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityQueue } from '../src/queue/priority-queue.js';
import type { EnqueuedJob } from '../src/types/index.js';

function makeJob(id: string, priority: number): EnqueuedJob {
  return {
    job: {
      id,
      type: 'email',
      priority: priority as 1 | 2 | 3 | 4 | 5,
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
    priority: priority as 1 | 2 | 3 | 4 | 5,
    enqueuedAt: Date.now(),
  };
}

describe('PriorityQueue', () => {
  let queue: PriorityQueue;

  beforeEach(() => {
    queue = new PriorityQueue();
  });

  it('starts empty', () => {
    expect(queue.size()).toBe(0);
    expect(queue.peek()).toBeNull();
    expect(queue.dequeue()).toBeNull();
  });

  it('enqueues and dequeues in priority order', () => {
    queue.enqueue(makeJob('low', 5));
    queue.enqueue(makeJob('high', 1));
    queue.enqueue(makeJob('mid', 3));

    expect(queue.size()).toBe(3);

    expect(queue.dequeue()?.job.id).toBe('high');
    expect(queue.dequeue()?.job.id).toBe('mid');
    expect(queue.dequeue()?.job.id).toBe('low');
    expect(queue.size()).toBe(0);
  });

  it('peek returns highest priority without removing', () => {
    queue.enqueue(makeJob('a', 3));
    queue.enqueue(makeJob('b', 1));

    expect(queue.peek()?.job.id).toBe('b');
    expect(queue.size()).toBe(2);
  });

  it('handles duplicate priorities (all have same priority)', () => {
    queue.enqueue(makeJob('first', 2));
    queue.enqueue(makeJob('second', 2));
    queue.enqueue(makeJob('third', 2));

    // Min-heap with equal priorities — order between equal elements is not guaranteed
    // All should be priority 2
    for (let i = 0; i < 3; i++) {
      const job = queue.dequeue();
      expect(job).not.toBeNull();
      expect(job!.priority).toBe(2);
    }
  });

  it('handles many items correctly', () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const priority = ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5;
      ids.push(`job-${i}-p${priority}`);
      queue.enqueue(makeJob(`job-${i}-p${priority}`, priority));
    }

    expect(queue.size()).toBe(100);

    let lastPriority = 0;
    while (queue.size() > 0) {
      const job = queue.dequeue()!;
      expect(job.priority).toBeGreaterThanOrEqual(lastPriority);
      lastPriority = job.priority;
    }

    expect(queue.size()).toBe(0);
  });

  it('clear empties the queue', () => {
    queue.enqueue(makeJob('a', 1));
    queue.enqueue(makeJob('b', 2));
    queue.clear();

    expect(queue.size()).toBe(0);
    expect(queue.peek()).toBeNull();
  });

  it('removes a queued job by ID', () => {
    queue.enqueue(makeJob('a', 1));
    queue.enqueue(makeJob('b', 3));
    queue.enqueue(makeJob('c', 2));

    expect(queue.remove('b')).toBe(true);
    expect(queue.remove('missing')).toBe(false);
    expect(queue.size()).toBe(2);
    expect(queue.dequeue()?.job.id).toBe('a');
    expect(queue.dequeue()?.job.id).toBe('c');
  });

  it('toArray returns a copy of the heap', () => {
    queue.enqueue(makeJob('a', 1));
    queue.enqueue(makeJob('b', 3));
    queue.enqueue(makeJob('c', 2));

    const arr = queue.toArray();
    expect(arr.length).toBe(3);

    // Heap property: root must be minimum
    expect(arr[0]!.priority).toBe(1);
  });
});
