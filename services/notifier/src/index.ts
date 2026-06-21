import { WebSocketServer, type WebSocket } from 'ws';
import { OPEN as WS_OPEN } from 'ws';
import { createServer } from 'node:http';
import {
  createLogger,
  createConsumer,
  getRedisClient,
  withCorrelation,
  KAFKA_TOPICS,
  initTracing,
  shutdownTracing,
} from '@taskqueue/shared';
import type { KafkaConfig, RedisConfig } from '@taskqueue/shared';

const log = createLogger('notifier');

export interface NotifierConfig {
  port: number;
  kafka: KafkaConfig;
  redis: RedisConfig;
}

interface ClientSubscription {
  ws: WebSocket;
  jobIds: Set<string>;
}

/**
 * Main Notifier service.
 * Runs a WebSocket server for real-time job updates and processes webhooks
 * on job completion. Clients connect and subscribe to specific job IDs.
 */
export async function startNotifier(config: NotifierConfig): Promise<void> {
  const redis = getRedisClient(config.redis);

  // WebSocket Server
  const server = createServer();
  const wss = new WebSocketServer({ server });

  const clients = new Map<string, ClientSubscription>();

  wss.on('connection', (ws, req) => {
    const clientId = (req.headers['x-client-id'] as string) || `client_${Date.now()}`;
    const subscription: ClientSubscription = {
      ws,
      jobIds: new Set(),
    };
    clients.set(clientId, subscription);

    log.info({ clientId }, 'WebSocket client connected');

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.jobId) {
          subscription.jobIds.add(msg.jobId);
          log.info({ clientId, jobId: msg.jobId }, 'Client subscribed to job');
          ws.send(JSON.stringify({ type: 'subscribed', jobId: msg.jobId }));
        } else if (msg.type === 'unsubscribe' && msg.jobId) {
          subscription.jobIds.delete(msg.jobId);
          ws.send(JSON.stringify({ type: 'unsubscribed', jobId: msg.jobId }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      log.info({ clientId }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      log.error({ err, clientId }, 'WebSocket error');
    });
  });

  server.listen(config.port, () => {
    log.info({ port: config.port }, 'WebSocket server listening');
  });

  // Kafka consumer — listens for state changes and pushes to subscribed clients
  await createConsumer(
    config.kafka,
    'notifier-group',
    [KAFKA_TOPICS.JOB_STATE_CHANGE],
    async ({ message }) => {
      try {
        const value = JSON.parse(message.value?.toString() ?? '{}');
        const { jobId, newStatus, previousStatus, correlationId, onSuccess } = value;

        const notification = {
          type: 'job_update',
          jobId,
          previousStatus,
          newStatus,
          timestamp: new Date().toISOString(),
        };

        // Push to all subscribed WebSocket clients
        let notifiedCount = 0;
        for (const [, sub] of clients) {
          if (sub.jobIds.has(jobId) && sub.ws.readyState === WS_OPEN) {
            sub.ws.send(JSON.stringify(notification));
            notifiedCount++;
          }
        }

        if (notifiedCount > 0) {
          log.info({ jobId, newStatus, notifiedCount }, 'Pushed notification to clients');
        }

        // Handle webhooks on job completion or failure
        if (newStatus === 'SUCCESS' || newStatus === 'FAILED' || newStatus === 'DEAD') {
          await withCorrelation(correlationId, async () => {
            // Read the webhook URL from the cached job state
            const cachedJob = await redis.get(`job:state:${jobId}`);
            if (cachedJob) {
              const job = JSON.parse(cachedJob);
              if (job.webhookUrl) {
                await sendWebhook(job.webhookUrl, value);
              }
            }
          });
        }
      } catch (err) {
        log.error({ err }, 'Failed to process notification');
      }
    },
  );

  log.info({ service: 'notifier' }, 'Notifier running');
}

// Self-invocation entrypoint
initTracing('notifier', process.env.OTLP_ENDPOINT);
process.on('SIGTERM', () => {
  shutdownTracing().catch(() => {});
});

const PORT = parseInt(process.env.PORT || '3400', 10);
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:29092').split(',');
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

startNotifier({
  port: PORT,
  kafka: { brokers: KAFKA_BROKERS, clientId: 'notifier' },
  redis: { host: REDIS_HOST, port: REDIS_PORT },
});

/**
 * Deliver a webhook payload to a user-defined URL.
 */
async function sendWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      log.info({ url, status: response.status }, 'Webhook delivered');
    } else {
      log.warn({ url, status: response.status }, 'Webhook delivery failed');
    }
  } catch (err) {
    log.error({ err, url }, 'Webhook delivery error');
  }
}
