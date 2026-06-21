import type { EnqueuedJob } from '../types/index.js';

/**
 * A binary min-heap priority queue for jobs.
 * Lower priority number = higher urgency (priority 1 is highest).
 */
export class PriorityQueue {
  private heap: EnqueuedJob[];

  constructor() {
    this.heap = [];
  }

  /**
   * Add a job to the queue with the given priority.
   * O(log n) time complexity.
   */
  enqueue(job: EnqueuedJob): void {
    this.heap.push(job);
    this.siftUp(this.heap.length - 1);
  }

  /**
   * Remove and return the highest priority job from the queue.
   * Returns null if the queue is empty.
   * O(log n) time complexity.
   */
  dequeue(): EnqueuedJob | null {
    if (this.heap.length === 0) {
      return null;
    }

    const root = this.heap[0]!;
    const last = this.heap.pop()!;

    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }

    return root;
  }

  /**
   * Return the highest priority job without removing it.
   * O(1) time complexity.
   */
  peek(): EnqueuedJob | null {
    return this.heap[0] ?? null;
  }

  /**
   * Return the number of jobs currently in the queue.
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Remove all jobs from the queue.
   */
  clear(): void {
    this.heap = [];
  }

  /**
   * Remove a job by ID.
   * Returns true when a queued job was removed.
   */
  remove(jobId: string): boolean {
    const index = this.heap.findIndex((item) => item.job.id === jobId);
    if (index === -1) {
      return false;
    }

    const last = this.heap.pop()!;
    if (index < this.heap.length) {
      this.heap[index] = last;
      const parent = Math.floor((index - 1) / 2);
      if (index > 0 && this.heap[index]!.priority < this.heap[parent]!.priority) {
        this.siftUp(index);
      } else {
        this.siftDown(index);
      }
    }

    return true;
  }

  /**
   * Return all jobs in the queue as an array.
   * The array may not be fully sorted — only the root is guaranteed to be the minimum.
   */
  toArray(): EnqueuedJob[] {
    return [...this.heap];
  }

  private siftUp(index: number): void {
    let current = index;

    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.heap[current]!.priority < this.heap[parent]!.priority) {
        this.swap(current, parent);
        current = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(index: number): void {
    const size = this.heap.length;
    let current = index;

    while (true) {
      const left = 2 * current + 1;
      const right = 2 * current + 2;
      let smallest = current;

      if (left < size && this.heap[left]!.priority < this.heap[smallest]!.priority) {
        smallest = left;
      }
      if (right < size && this.heap[right]!.priority < this.heap[smallest]!.priority) {
        smallest = right;
      }

      if (smallest !== current) {
        this.swap(current, smallest);
        current = smallest;
      } else {
        break;
      }
    }
  }

  private swap(a: number, b: number): void {
    const temp = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = temp;
  }
}
