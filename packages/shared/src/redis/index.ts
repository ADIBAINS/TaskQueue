import { Redis } from 'ioredis';

let redisInstance: Redis | null = null;

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

/**
 * Create or retrieve a Redis client instance.
 * Uses connection pooling via ioredis for high throughput.
 */
export function getRedisClient(config: RedisConfig): Redis {
  if (!redisInstance) {
    redisInstance = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db ?? 0,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) {
          return null;
        }
        return Math.min(times * 200, 5000);
      },
      lazyConnect: false,
    });

    redisInstance.on('error', (err) => {
      console.error('Redis connection error:', err.message);
    });
  }

  return redisInstance;
}

/**
 * Set a worker heartbeat key with a TTL.
 * Workers call this every ~5 seconds to signal they're alive.
 */
export async function heartbeat(redis: Redis, workerId: string, ttlSeconds: number = 15): Promise<void> {
  await redis.set(`heartbeat:${workerId}`, Date.now().toString(), 'EX', ttlSeconds);
}

/**
 * Check if a worker is alive by checking its heartbeat key.
 */
export async function isWorkerAlive(redis: Redis, workerId: string): Promise<boolean> {
  const exists = await redis.exists(`heartbeat:${workerId}`);
  return exists === 1;
}

/**
 * Get all alive worker IDs.
 */
export async function getAliveWorkers(redis: Redis): Promise<string[]> {
  const keys = await redis.keys('heartbeat:*');
  return keys.map((k) => k.replace('heartbeat:', ''));
}

/**
 * Gracefully close the Redis connection.
 */
export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
