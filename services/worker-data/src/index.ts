import { startWorker } from '@taskqueue/shared';
import type { Job } from '@taskqueue/shared';

const config = {
  workerType: 'data' as const,
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
    clientId: 'worker-data',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '8', 10),
  metricsPort: parseInt(process.env.METRICS_PORT || '3602', 10),
};

startWorker(config, async (job: Job) => {
  const { query, dataset, operation, filters, aggregation, limit } = job.payload as {
    query?: string;
    dataset?: string;
    operation?: string;
    filters?: Record<string, unknown>;
    aggregation?: string;
    limit?: number;
  };

  if (!operation) {
    return { success: false, error: 'Missing required field: operation' };
  }

  const validOps = ['aggregate', 'transform', 'validate', 'export', 'cleanup'];
  if (!validOps.includes(operation)) {
    return {
      success: false,
      error: `Unknown operation: ${operation}. Valid: ${validOps.join(', ')}`,
    };
  }

  const processingTime = 200 + Math.random() * 800;

  switch (operation) {
    case 'aggregate': {
      await new Promise((resolve) => setTimeout(resolve, processingTime + Math.random() * 1500));

      if (!dataset) {
        return { success: false, error: 'Aggregate requires dataset field' };
      }

      if (Math.random() < 0.05) {
        return { success: false, error: 'Aggregation failed: data schema mismatch' };
      }

      const rowsProcessed = Math.floor(Math.random() * 50000) + 1000;
      const groupsFound = Math.floor(Math.random() * 200) + 1;

      return {
        success: true,
        result: {
          operation: 'aggregate',
          dataset,
          rowsProcessed,
          groupsFound,
          aggregation: aggregation || 'sum',
          queryTimeMs: processingTime,
          filters: filters || {},
        },
      };
    }

    case 'transform': {
      await new Promise((resolve) => setTimeout(resolve, processingTime + Math.random() * 500));

      if (!dataset || !query) {
        return { success: false, error: 'Transform requires dataset and query fields' };
      }

      if (Math.random() < 0.07) {
        return { success: false, error: 'Transform failed: cyclic dependency detected in query' };
      }

      const rowsAffected = Math.floor(Math.random() * 20000) + 500;

      return {
        success: true,
        result: {
          operation: 'transform',
          dataset,
          rowsAffected,
          queryTimeMs: processingTime,
        },
      };
    }

    case 'validate': {
      await new Promise((resolve) => setTimeout(resolve, processingTime));

      const recordsChecked = Math.floor(Math.random() * 100000) + 1000;
      const invalidRecords = Math.floor(recordsChecked * (Math.random() * 0.05));
      const passRate = (((recordsChecked - invalidRecords) / recordsChecked) * 100).toFixed(2);

      return {
        success: true,
        result: {
          operation: 'validate',
          recordsChecked,
          invalidRecords,
          passRate: `${passRate}%`,
          queryTimeMs: processingTime,
        },
      };
    }

    case 'export': {
      await new Promise((resolve) => setTimeout(resolve, processingTime + Math.random() * 2000));
      return {
        success: true,
        result: {
          operation: 'export',
          rowsExported: limit || 10000,
          format: 'jsonl',
          exportSizeBytes: Math.floor(Math.random() * 5000000) + 100000,
          queryTimeMs: processingTime,
        },
      };
    }

    case 'cleanup': {
      await new Promise((resolve) => setTimeout(resolve, processingTime));
      const recordsDeleted = Math.floor(Math.random() * 5000);
      return {
        success: true,
        result: {
          operation: 'cleanup',
          recordsDeleted,
          queryTimeMs: processingTime,
        },
      };
    }

    default:
      return { success: false, error: `Unhandled operation: ${operation}` };
  }
});
