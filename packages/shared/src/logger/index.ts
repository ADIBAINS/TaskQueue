import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'node:async_hooks';

const correlationStore = new AsyncLocalStorage<{ correlationId: string }>();

/**
 * pino logger with structured JSON output and correlation ID support.
 * Use createLogger(serviceName) to create a logger instance for each service.
 */
export function createLogger(serviceName: string): ReturnType<typeof pino> {
  return pino({
    name: serviceName,
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    mixin() {
      const ctx = correlationStore.getStore();
      return ctx ? { correlationId: ctx.correlationId } : {};
    },
    ...(process.env.NODE_ENV !== 'production' && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    }),
  });
}

/**
 * Run a function within a correlation context.
 * If no correlationId is provided, a new UUID is generated.
 * All log calls within the function will include the correlationId.
 */
export function withCorrelation<T>(correlationId: string | null, fn: () => T): T {
  const id = correlationId || uuidv4();
  return correlationStore.run({ correlationId: id }, fn) as T;
}

/**
 * Get the current correlation ID from the async context.
 * Returns null if called outside a correlation context.
 */
export function getCorrelationId(): string | null {
  return correlationStore.getStore()?.correlationId ?? null;
}

export { pino };
