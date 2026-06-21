import { Kafka, type Producer, type Consumer, type EachMessageHandler, logLevel } from 'kafkajs';
import { createLogger } from '../logger/index.js';

const log = createLogger('kafka');

export const KAFKA_TOPICS = {
  JOB_SUBMITTED: 'job.submitted',
  JOB_SCHEDULED: 'job.scheduled',
  JOB_ASSIGNED: 'job.assigned',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_STATE_CHANGE: 'job.state-change',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
}

let kafkaInstance: Kafka | null = null;
let producerInstance: Producer | null = null;

/**
 * Create or retrieve a Kafka client instance.
 * Creates the client on first call, returns cached instance on subsequent calls.
 */
export function getKafkaClient(config: KafkaConfig): Kafka {
  if (!kafkaInstance) {
    kafkaInstance = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 300,
        retries: 8,
      },
    });
  }
  return kafkaInstance;
}

/**
 * Create or retrieve a Kafka Producer instance.
 * Ensures the producer is connected before returning.
 */
export async function getProducer(config: KafkaConfig): Promise<Producer> {
  if (producerInstance) {
    return producerInstance;
  }

  const kafka = getKafkaClient(config);
  producerInstance = kafka.producer({
    allowAutoTopicCreation: false,
    maxInFlightRequests: 5,
    idempotent: true,
  });

  await producerInstance.connect();
  log.info('Kafka producer connected');

  return producerInstance;
}

/**
 * Publish a message to a Kafka topic with the given key and value.
 */
export async function publishMessage(
  producer: Producer,
  topic: KafkaTopic,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  try {
    await producer.send({
      topic,
      messages: [
        {
          key,
          value: JSON.stringify(value),
          headers: {
            'content-type': 'application/json',
            'produced-at': Date.now().toString(),
          },
        },
      ],
    });
  } catch (err) {
    log.error({ err, topic, key }, 'Failed to publish message to Kafka');
    throw err;
  }
}

/**
 * Create a Kafka consumer group.
 * Returns a Consumer instance connected and subscribed to the given topics.
 */
export async function createConsumer(
  config: KafkaConfig,
  groupId: string,
  topics: string[],
  handler: EachMessageHandler,
): Promise<Consumer> {
  const kafka = getKafkaClient(config);
  const consumer = kafka.consumer({
    groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    maxBytesPerPartition: 1048576,
  });

  await consumer.connect();
  log.info({ groupId, topics }, 'Kafka consumer connected');

  await consumer.subscribe({ topics, fromBeginning: false });

  await consumer.run({
    eachMessage: handler,
  });

  return consumer;
}

/**
 * Gracefully disconnect the producer and consumer.
 */
export async function disconnectAll(): Promise<void> {
  if (producerInstance) {
    try {
      await producerInstance.disconnect();
      log.info('Kafka producer disconnected');
    } catch {
      // ignore
    }
    producerInstance = null;
  }
}
