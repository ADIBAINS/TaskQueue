import { Pool } from 'pg';
import { createLogger } from '@taskqueue/shared';
import type { Job, JobStatus, DLQEntry, CronJob } from '@taskqueue/shared';

const log = createLogger('state-manager:db');

let pool: Pool;

/**
 * Initialize the PostgreSQL connection pool.
 */
export function initDB(connectionString: string): void {
  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    log.error({ err }, 'Unexpected PostgreSQL pool error');
  });
}

/**
 * Get the database connection pool.
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initDB() first.');
  }
  return pool;
}

/**
 * Create a new job in the PENDING state.
 */
export async function createJob(job: Omit<Job, 'createdAt' | 'updatedAt'>): Promise<Job> {
  const client = await pool.connect();
  try {
    const result = await client.query<Job>(
      `INSERT INTO jobs (id, type, priority, status, payload, idempotency_key, correlation_id,
        retry_count, max_retries, scheduled_at, on_success, on_failure, webhook_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        job.id,
        job.type,
        job.priority,
        job.status,
        JSON.stringify(job.payload),
        job.idempotencyKey,
        job.correlationId,
        job.retryCount,
        job.maxRetries,
        job.scheduledAt,
        job.onSuccess ? JSON.stringify(job.onSuccess) : null,
        job.onFailure ? JSON.stringify(job.onFailure) : null,
        job.webhookUrl,
      ],
    );
    return rowToJob(result.rows[0]! as unknown as Record<string, unknown>);
  } finally {
    client.release();
  }
}

/**
 * Update a job's status and return the updated job.
 */
export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  metadata: Record<string, unknown> = {},
): Promise<Job | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<Record<string, unknown>>(
      'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const previousStatus = existing.rows[0]!.status as JobStatus;
    const updates: string[] = ['status = $2', 'updated_at = NOW()'];
    const values: unknown[] = [jobId, status];
    let paramIndex = 3;

    if (status === 'RUNNING') {
      updates.push('started_at = NOW()');
      if (metadata.workerId) {
        updates.push(`worker_id = $${paramIndex++}`);
        values.push(metadata.workerId);
      }
    } else if (status === 'SUCCESS') {
      updates.push('completed_at = NOW()');
    } else if (status === 'FAILED' || status === 'DEAD') {
      updates.push('failed_at = NOW()');
      updates.push(`retry_count = retry_count + 1`);
      if (metadata.errorMessage) {
        updates.push(`error_message = $${paramIndex++}`);
        values.push(metadata.errorMessage);
      }
    }

    const result = await client.query<Record<string, unknown>>(
      `UPDATE jobs SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      values,
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const job = rowToJob(result.rows[0]!);

    await client.query(
      `INSERT INTO audit_log (job_id, previous_status, new_status, metadata, correlation_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, previousStatus, status, JSON.stringify(metadata), job.correlationId],
    );

    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reset an existing failed job for a user-requested retry.
 */
export async function resetJobForRetry(jobId: string): Promise<Job | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<Record<string, unknown>>(
      'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const previous = rowToJob(existing.rows[0]!);
    if (previous.status !== 'FAILED' && previous.status !== 'DEAD') {
      await client.query('COMMIT');
      return previous;
    }

    const result = await client.query<Record<string, unknown>>(
      `UPDATE jobs
       SET status = 'PENDING', retry_count = 0, started_at = NULL,
           completed_at = NULL, failed_at = NULL, error_message = NULL,
           worker_id = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [jobId],
    );
    const job = rowToJob(result.rows[0]!);

    await client.query(
      `INSERT INTO audit_log (job_id, previous_status, new_status, metadata, correlation_id)
       VALUES ($1, $2, 'PENDING', $3, $4)`,
      [jobId, previous.status, JSON.stringify({ reason: 'manual_retry' }), job.correlationId],
    );

    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get a job by ID.
 */
export async function getJob(jobId: string): Promise<Job | null> {
  const result = await pool.query<Record<string, unknown>>('SELECT * FROM jobs WHERE id = $1', [
    jobId,
  ]);
  if (result.rows.length === 0) return null;
  return rowToJob(result.rows[0]!);
}

/**
 * Find a job by idempotency key.
 */
export async function getJobByIdempotencyKey(key: string): Promise<Job | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM jobs WHERE idempotency_key = $1',
    [key],
  );
  if (result.rows.length === 0) return null;
  return rowToJob(result.rows[0]!);
}

/**
 * Add an entry to the Dead Letter Queue.
 */
export async function addToDLQ(
  jobId: string,
  jobType: string,
  payload: Record<string, unknown>,
  errorMessage: string,
  retryCount: number,
): Promise<DLQEntry> {
  const result = await pool.query<DLQEntry>(
    `INSERT INTO dlq (job_id, job_type, payload, error_message, retry_count)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [jobId, jobType, JSON.stringify(payload), errorMessage, retryCount],
  );
  return result.rows[0]!;
}

/**
 * Get all DLQ entries, optionally filtered by job type.
 */
export async function getDLQEntries(jobType?: string): Promise<DLQEntry[]> {
  let query = 'SELECT * FROM dlq WHERE requeued = FALSE';
  const params: unknown[] = [];
  if (jobType) {
    query += ' AND job_type = $1';
    params.push(jobType);
  }
  query += ' ORDER BY failed_at DESC';
  const result = await pool.query<DLQEntry>(query, params);
  return result.rows;
}

/**
 * Mark a DLQ entry as requeued.
 */
export async function requeueDLQEntry(id: string): Promise<void> {
  await pool.query('UPDATE dlq SET requeued = TRUE WHERE id = $1', [id]);
}

/**
 * Get all registered cron jobs.
 */
export async function getCronJobs(): Promise<CronJob[]> {
  const result = await pool.query<CronJob>(
    'SELECT * FROM cron_jobs WHERE enabled = TRUE ORDER BY next_run ASC',
  );
  return result.rows;
}

/**
 * Update a cron job's last_run and next_run timestamps.
 */
export async function updateCronJobRun(id: string, nextRun: string): Promise<void> {
  await pool.query(
    'UPDATE cron_jobs SET last_run = NOW(), next_run = $1, updated_at = NOW() WHERE id = $2',
    [nextRun, id],
  );
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    type: row.type as Job['type'],
    priority: row.priority as Job['priority'],
    status: row.status as JobStatus,
    payload: (row.payload as Record<string, unknown>) || {},
    idempotencyKey: (row.idempotency_key as string) || null,
    correlationId: row.correlation_id as string,
    retryCount: (row.retry_count as number) || 0,
    maxRetries: (row.max_retries as number) || 3,
    scheduledAt: (row.scheduled_at as string) || null,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
    failedAt: (row.failed_at as string) || null,
    errorMessage: (row.error_message as string) || null,
    workerId: (row.worker_id as string) || null,
    onSuccess: (row.on_success as Job['onSuccess']) || null,
    onFailure: (row.on_failure as Job['onFailure']) || null,
    webhookUrl: (row.webhook_url as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
