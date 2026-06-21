import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { Producer } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import {
  createLogger,
  getProducer,
  getRedisClient,
  publishMessage,
  KAFKA_TOPICS,
  initTracing,
  shutdownTracing,
} from '@taskqueue/shared';
import type {
  KafkaConfig,
  RedisConfig,
  PendingJob,
  JobType,
  JobPriority,
  QueueStats,
  DLQEntry,
} from '@taskqueue/shared';

const log = createLogger('api-gateway');

export interface APIGatewayConfig {
  port: number;
  kafka: KafkaConfig;
  redis: RedisConfig;
  jwtSecret: string;
  databaseUrl?: string;
}

/**
 * Main API Gateway service.
 * Exposes REST endpoints for job submission, status queries, and queue management.
 * Authenticates clients via JWT and rate-limits requests.
 */
export async function startAPIGateway(config: APIGatewayConfig): Promise<void> {
  const app = express();
  const producer = await getProducer(config.kafka);
  const redis = getRedisClient(config.redis);

  let pgPool: Pool | undefined;
  if (config.databaseUrl) {
    const { Pool } = await import('pg');
    pgPool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  }

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  const limiter = rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
  app.use(limiter);

  app.use((req, _res, next) => {
    log.info({ method: req.method, path: req.path }, 'Request');
    next();
  });

  /**
   * POST /jobs - Submit a new job
   */
  app.post('/jobs', authenticate(config.jwtSecret), async (req, res) => {
    try {
      const {
        type,
        priority = 3,
        payload = {},
        idempotencyKey,
        maxRetries = 3,
        scheduledAt,
        onSuccess,
        onFailure,
        webhookUrl,
      } = req.body;

      if (!type || !['email', 'image', 'data'].includes(type)) {
        res.status(400).json({ error: 'Invalid job type. Must be: email, image, or data' });
        return;
      }

      if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
        res.status(400).json({ error: 'Priority must be an integer between 1 and 5' });
        return;
      }

      if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) {
        res.status(400).json({ error: 'maxRetries must be an integer between 0 and 100' });
        return;
      }

      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        res.status(400).json({ error: 'payload must be a JSON object' });
        return;
      }

      if (scheduledAt && isNaN(Date.parse(scheduledAt))) {
        res.status(400).json({ error: 'Invalid scheduledAt date' });
        return;
      }

      if (idempotencyKey) {
        const existing = await redis.get(`idempotency:${idempotencyKey}`);
        if (existing) {
          const existingJob = JSON.parse(existing);
          res.status(200).json({ job: existingJob, deduplicated: true });
          return;
        }
      }

      const job: PendingJob = {
        id: uuidv4(),
        type: type as JobType,
        priority: priority as JobPriority,
        payload,
        idempotencyKey: idempotencyKey || null,
        maxRetries,
        scheduledAt: scheduledAt || null,
        onSuccess: onSuccess || null,
        onFailure: onFailure || null,
        webhookUrl: webhookUrl || null,
      };

      await publishMessage(producer, KAFKA_TOPICS.JOB_SUBMITTED, job.id, {
        ...job,
        status: 'PENDING',
        correlationId: uuidv4(),
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      if (idempotencyKey) {
        await redis.set(`idempotency:${idempotencyKey}`, JSON.stringify(job), 'EX', 86400);
      }

      log.info({ jobId: job.id, type: job.type }, 'Job submitted');
      res.status(201).json({ job });
    } catch (err) {
      log.error({ err }, 'Failed to submit job');
      res.status(500).json({ error: 'Failed to submit job' });
    }
  });

  /**
   * GET /jobs - List recent jobs with optional type and status filters.
   */
  app.get('/jobs', authenticate(config.jwtSecret), async (req, res) => {
    if (!pgPool) {
      res.status(501).json({ error: 'Job listing requires a database connection' });
      return;
    }

    const type = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(200, Math.max(1, requestedLimit))
      : 50;

    if (type && !['email', 'image', 'data'].includes(type)) {
      res.status(400).json({ error: 'Invalid job type' });
      return;
    }

    const validStatuses = [
      'PENDING',
      'QUEUED',
      'SCHEDULED',
      'RUNNING',
      'SUCCESS',
      'FAILED',
      'DEAD',
      'CANCELLED',
    ];
    if (status && !validStatuses.includes(status.toUpperCase())) {
      res.status(400).json({ error: 'Invalid job status' });
      return;
    }

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (type) {
        params.push(type);
        conditions.push(`type = $${params.length}`);
      }
      if (status) {
        params.push(status.toUpperCase());
        conditions.push(`status = $${params.length}`);
      }
      params.push(limit);

      const result = await pgPool.query<Record<string, unknown>>(
        `SELECT * FROM jobs
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params,
      );
      res.json({ jobs: result.rows, count: result.rows.length });
    } catch (err) {
      log.error({ err }, 'Failed to list jobs');
      res.status(500).json({ error: 'Failed to list jobs' });
    }
  });

  /**
   * GET /jobs/:id - Get job status
   */
  app.get('/jobs/:id', async (req, res) => {
    const cached = await redis.get(`job:state:${req.params.id}`);
    if (cached) {
      res.json({ job: JSON.parse(cached) });
      return;
    }
    res.status(404).json({ error: 'Job not found' });
  });

  /**
   * POST /jobs/:id/cancel - Cancel a job
   */
  app.post('/jobs/:id/cancel', authenticate(config.jwtSecret), async (req, res) => {
    const jobId = req.params['id'] as string;
    const cached = await redis.get(`job:state:${jobId}`);
    if (!cached) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = JSON.parse(cached);
    if (!['PENDING', 'SCHEDULED', 'QUEUED'].includes(job.status)) {
      res.status(409).json({ error: `Job in ${job.status} state cannot be cancelled` });
      return;
    }

    const previousStatus = job.status;
    job.status = 'CANCELLED';
    job.updatedAt = new Date().toISOString();
    await redis.set(`job:state:${jobId}`, JSON.stringify(job), 'EX', 3600);

    await publishMessage(producer, KAFKA_TOPICS.JOB_STATE_CHANGE, jobId, {
      jobId,
      previousStatus,
      newStatus: 'CANCELLED',
      timestamp: new Date().toISOString(),
      correlationId: job.correlationId,
    });
    res.json({ jobId, status: 'CANCELLED' });
  });

  /**
   * POST /jobs/:id/retry - Retry a failed job
   */
  app.post('/jobs/:id/retry', authenticate(config.jwtSecret), async (req, res) => {
    const jobId = req.params['id'] as string;
    const cached = await redis.get(`job:state:${jobId}`);
    if (!cached) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = JSON.parse(cached);
    if (job.status !== 'FAILED' && job.status !== 'DEAD') {
      res.status(400).json({ error: 'Only failed or dead jobs can be retried' });
      return;
    }

    await publishMessage(producer, KAFKA_TOPICS.JOB_SUBMITTED, jobId, {
      ...job,
      status: 'PENDING',
      retryCount: 0,
    });

    res.json({ jobId, status: 'PENDING' });
  });

  /**
   * GET /queues/stats - Get queue statistics
   */
  app.get('/queues/stats', async (_req, res) => {
    const types: JobType[] = ['email', 'image', 'data'];
    const stats: QueueStats[] = [];

    for (const type of types) {
      const [enqueued, depth, failed] = await Promise.all([
        redis.get(`metrics:${type}:enqueued`),
        redis.llen(`queue:${type}`),
        redis.get(`metrics:${type}:failed`),
      ]);

      stats.push({
        queueName: type,
        depth: depth || 0,
        processing: 0,
        failed: parseInt((failed as string) || '0', 10),
        enqueueRate: parseInt((enqueued as string) || '0', 10),
        dequeueRate: 0,
      });
    }

    res.json({ queues: stats });
  });

  /**
   * GET /dlq - List Dead Letter Queue entries
   */
  app.get('/dlq', authenticate(config.jwtSecret), async (req, res) => {
    if (!pgPool) {
      res.status(501).json({ error: 'DLQ management requires a database connection' });
      return;
    }

    try {
      const jobType = req.query.type as string | undefined;
      let query = 'SELECT * FROM dlq WHERE requeued = FALSE';
      const params: unknown[] = [];

      if (jobType && ['email', 'image', 'data'].includes(jobType)) {
        query += ' AND job_type = $1';
        params.push(jobType);
      }
      query += ' ORDER BY failed_at DESC LIMIT 100';

      const result = await pgPool.query<Record<string, unknown>>(query, params);
      res.json({ entries: result.rows, count: result.rows.length });
    } catch (err) {
      log.error({ err }, 'Failed to list DLQ');
      res.status(500).json({ error: 'Failed to list DLQ' });
    }
  });

  /**
   * POST /dlq/:id/requeue - Requeue a DLQ entry
   */
  app.post('/dlq/:id/requeue', authenticate(config.jwtSecret), async (req, res) => {
    if (!pgPool) {
      res.status(501).json({ error: 'DLQ management requires a database connection' });
      return;
    }

    try {
      const entryId = req.params['id'] as string;

      const entry = await pgPool.query<Record<string, unknown>>(
        'SELECT * FROM dlq WHERE id = $1 AND requeued = FALSE',
        [entryId],
      );
      if (entry.rows.length === 0) {
        res.status(404).json({ error: 'DLQ entry not found or already requeued' });
        return;
      }

      const dlqEntry = entry.rows[0]!;
      await pgPool.query('UPDATE dlq SET requeued = TRUE WHERE id = $1', [entryId]);

      const job: PendingJob = {
        id: uuidv4(),
        type: dlqEntry.job_type as string as JobType,
        priority: 3,
        payload: dlqEntry.payload as Record<string, unknown>,
        idempotencyKey: null,
        maxRetries: 3,
        scheduledAt: null,
        onSuccess: null,
        onFailure: null,
        webhookUrl: null,
      };

      await publishMessage(producer, KAFKA_TOPICS.JOB_SUBMITTED, job.id, {
        ...job,
        status: 'PENDING',
        correlationId: uuidv4(),
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      res.json({ requeued: true, newJobId: job.id });
    } catch (err) {
      log.error({ err }, 'Failed to requeue DLQ entry');
      res.status(500).json({ error: 'Failed to requeue' });
    }
  });

  /**
   * GET /cron - List cron jobs
   */
  app.get('/cron', authenticate(config.jwtSecret), async (_req, res) => {
    if (!pgPool) {
      res.status(501).json({ error: 'Cron management requires a database connection' });
      return;
    }

    try {
      const result = await pgPool.query('SELECT * FROM cron_jobs ORDER BY next_run ASC');
      res.json({ cronJobs: result.rows, count: result.rows.length });
    } catch (err) {
      log.error({ err }, 'Failed to list cron jobs');
      res.status(500).json({ error: 'Failed to list cron jobs' });
    }
  });

  /**
   * POST /cron - Create a cron job
   */
  app.post('/cron', authenticate(config.jwtSecret), async (req, res) => {
    if (!pgPool) {
      res.status(501).json({ error: 'Cron management requires a database connection' });
      return;
    }

    try {
      const { name, cronExpression, jobType, payload = {}, priority = 3 } = req.body;

      if (!name || !cronExpression || !jobType) {
        res.status(400).json({ error: 'name, cronExpression, and jobType are required' });
        return;
      }

      if (!['email', 'image', 'data'].includes(jobType)) {
        res.status(400).json({ error: 'Invalid jobType' });
        return;
      }

      const { CronExpressionParser } = await import('cron-parser');
      const interval = CronExpressionParser.parse(cronExpression);
      const nextRun = interval.next().toDate();

      const result = await pgPool.query(
        `INSERT INTO cron_jobs (name, cron_expression, job_type, payload, priority, next_run)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [name, cronExpression, jobType, JSON.stringify(payload), priority, nextRun],
      );

      res.status(201).json({ cronJob: result.rows[0] });
    } catch (err) {
      log.error({ err }, 'Failed to create cron job');
      res.status(500).json({ error: 'Failed to create cron job' });
    }
  });

  /**
   * DELETE /cron/:id - Delete a cron job
   */
  app.delete('/cron/:id', authenticate(config.jwtSecret), async (req, res) => {
    if (!pgPool) {
      res.status(501).json({ error: 'Cron management requires a database connection' });
      return;
    }

    try {
      const id = req.params['id'] as string;
      const result = await pgPool.query(
        'UPDATE cron_jobs SET enabled = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *',
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Cron job not found' });
        return;
      }

      res.json({ disabled: true, id });
    } catch (err) {
      log.error({ err }, 'Failed to delete cron job');
      res.status(500).json({ error: 'Failed to delete cron job' });
    }
  });

  /**
   * GET /health - Health check
   */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'api-gateway', uptime: process.uptime() });
  });

  app.listen(config.port, () => {
    log.info({ port: config.port }, 'API Gateway listening');
  });
}

function authenticate(secret: string): express.RequestHandler {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.replace('Bearer ', '');
    try {
      const jwt = require('jsonwebtoken');
      jwt.verify(token, secret);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// Self-invocation entrypoint
initTracing('api-gateway', process.env.OTLP_ENDPOINT);
process.on('SIGTERM', () => {
  shutdownTracing().catch(() => {});
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:29092').split(',');
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

startAPIGateway({
  port: PORT,
  kafka: { brokers: KAFKA_BROKERS, clientId: 'api-gateway' },
  redis: { host: REDIS_HOST, port: REDIS_PORT },
  jwtSecret: JWT_SECRET,
  databaseUrl: process.env.DATABASE_URL,
});
