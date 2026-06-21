/** Core domain types for the distributed task queue system. */

export type JobType = 'email' | 'image' | 'data';

export type JobStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'DEAD'
  | 'CANCELLED';

export type JobPriority = 1 | 2 | 3 | 4 | 5;

export interface JobPayload {
  [key: string]: unknown;
}

export interface Job {
  id: string;
  type: JobType;
  priority: JobPriority;
  status: JobStatus;
  payload: JobPayload;
  idempotencyKey: string | null;
  correlationId: string;
  retryCount: number;
  maxRetries: number;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  workerId: string | null;
  onSuccess: JobChaining | null;
  onFailure: JobChaining | null;
  webhookUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobChaining {
  nextJobType: JobType;
  payload: JobPayload;
  priority: JobPriority;
}

export interface PendingJob {
  id: string;
  type: JobType;
  priority: JobPriority;
  payload: JobPayload;
  idempotencyKey: string | null;
  maxRetries: number;
  onSuccess: JobChaining | null;
  onFailure: JobChaining | null;
  webhookUrl: string | null;
  scheduledAt: string | null;
}

export interface EnqueuedJob {
  job: Job;
  priority: JobPriority;
  enqueuedAt: number;
}

export interface JobStateChange {
  jobId: string;
  previousStatus: JobStatus | null;
  newStatus: JobStatus;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface WorkerInfo {
  workerId: string;
  workerType: JobType;
  status: 'idle' | 'busy' | 'dead';
  currentJobCount: number;
  maxConcurrency: number;
  lastHeartbeat: string;
  startedAt: string;
}

export interface QueueStats {
  queueName: string;
  depth: number;
  processing: number;
  failed: number;
  enqueueRate: number;
  dequeueRate: number;
}

export interface DLQEntry {
  id: string;
  jobId: string;
  jobType: JobType;
  payload: JobPayload;
  errorMessage: string;
  retryCount: number;
  failedAt: string;
}

export interface CronJob {
  id: string;
  name: string;
  cronExpression: string;
  jobType: JobType;
  payload: JobPayload;
  priority: JobPriority;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
}
