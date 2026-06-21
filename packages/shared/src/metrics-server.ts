import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Redis } from 'ioredis';

/** Lightweight HTTP server exposing /metrics (Prometheus) and /health endpoints for worker and internal services. */
export function createMetricsServer(
  port: number,
  serviceName: string,
  collectMetrics: () => Promise<string>,
): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: serviceName, uptime: process.uptime() }));
      return;
    }

    if (req.url === '/metrics') {
      try {
        const body = await collectMetrics();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('# Error collecting metrics\n');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    // Logged by caller
  });

  return server;
}

/** Simple Prometheus text format formatter. */
export function formatMetrics(
  samples: Array<{
    name: string;
    help: string;
    type: 'counter' | 'gauge' | 'histogram';
    value: number;
    labels?: Record<string, string>;
  }>,
): string {
  const grouped = new Map<string, typeof samples>();
  for (const s of samples) {
    const existing = grouped.get(s.name) || [];
    existing.push(s);
    grouped.set(s.name, existing);
  }

  let output = '';
  for (const [name, group] of grouped) {
    output += `# HELP ${name} ${group[0]!.help}\n`;
    output += `# TYPE ${name} ${group[0]!.type}\n`;
    for (const s of group) {
      const labels = s.labels
        ? `{${Object.entries(s.labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',')}}`
        : '';
      output += `${name}${labels} ${s.value}\n`;
    }
    output += '\n';
  }
  return output;
}
