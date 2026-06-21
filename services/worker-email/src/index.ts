import { startWorker } from '@taskqueue/shared';
import type { Job } from '@taskqueue/shared';

const config = {
  workerType: 'email' as const,
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
    clientId: 'worker-email',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '5', 10),
  metricsPort: parseInt(process.env.METRICS_PORT || '3600', 10),
};

startWorker(config, async (job: Job) => {
  const { to, subject, body, cc, bcc, template, templateData } = job.payload as {
    to?: string;
    subject?: string;
    body?: string;
    cc?: string[];
    bcc?: string[];
    template?: string;
    templateData?: Record<string, string>;
  };

  if (!to || !subject) {
    return { success: false, error: 'Missing required fields: to, subject' };
  }

  const emailBody = template && templateData
    ? renderTemplate(template, templateData)
    : (body || '(no body)');

  const recipients = [to, ...(cc || []), ...(bcc || [])];
  for (const recipient of recipients) {
    if (!isValidEmail(recipient)) {
      return { success: false, error: `Invalid email address: ${recipient}` };
    }
  }

  const processingTime = 300 + Math.random() * 700;
  await new Promise((resolve) => setTimeout(resolve, processingTime));

  if (Math.random() < 0.05) {
    return { success: false, error: 'SMTP transient failure: connection timeout' };
  }

  const messageId = `<${Date.now()}.${job.id.slice(0, 8)}@taskqueue.local>`;

  return {
    success: true,
    result: {
      messageId,
      delivered: true,
      recipient: to,
      ccCount: (cc || []).length,
      bccCount: (bcc || []).length,
      bodyLength: emailBody.length,
      processingTimeMs: processingTime,
    },
  };
});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function renderTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => data[key] ?? `{{${key}}}`);
}
