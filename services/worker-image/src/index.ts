import { startWorker } from '@taskqueue/shared';
import type { Job } from '@taskqueue/shared';

const config = {
  workerType: 'image' as const,
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
    clientId: 'worker-image',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '3', 10),
  metricsPort: parseInt(process.env.METRICS_PORT || '3601', 10),
};

startWorker(config, async (job: Job) => {
  const { url, width, height, format, quality, operations } = job.payload as {
    url?: string;
    width?: number;
    height?: number;
    format?: string;
    quality?: number;
    operations?: string[];
  };

  if (!url) {
    return { success: false, error: 'Missing required field: url' };
  }

  const targetWidth = width || 800;
  const targetHeight = height || 600;
  const targetFormat = format || 'jpeg';
  const targetQuality = quality || 80;
  const ops = operations || ['resize'];

  const supportedFormats = ['jpeg', 'png', 'webp', 'avif'];
  if (!supportedFormats.includes(targetFormat)) {
    return {
      success: false,
      error: `Unsupported format: ${targetFormat}. Supported: ${supportedFormats.join(', ')}`,
    };
  }

  if (targetWidth < 1 || targetWidth > 10000 || targetHeight < 1 || targetHeight > 10000) {
    return { success: false, error: 'Invalid dimensions. Must be 1-10000px' };
  }

  if (targetQuality < 1 || targetQuality > 100) {
    return { success: false, error: 'Quality must be 1-100' };
  }

  const processingTime = 500 + Math.random() * 2000;
  await new Promise((resolve) => setTimeout(resolve, processingTime));

  // Simulate actual sharp behavior
  const originalSize = targetWidth * targetHeight * 4;
  const compressedSize = Math.round(originalSize * (targetQuality / 100) * 0.3);
  const compressionRatio = (originalSize / compressedSize).toFixed(2);

  if (Math.random() < 0.03) {
    return { success: false, error: 'Image processing failed: corrupt input file' };
  }

  return {
    success: true,
    result: {
      originalUrl: url,
      processedUrl: `${url}?w=${targetWidth}&h=${targetHeight}&fmt=${targetFormat}&q=${targetQuality}`,
      dimensions: { width: targetWidth, height: targetHeight },
      format: targetFormat,
      quality: targetQuality,
      operations: ops,
      originalSizeBytes: originalSize,
      compressedSizeBytes: compressedSize,
      compressionRatio: `${compressionRatio}:1`,
      processingTimeMs: processingTime,
    },
  };
});
