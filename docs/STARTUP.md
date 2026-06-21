# Local development and verification

This guide starts TaskQueue locally with infrastructure in Docker and application services
running as Node.js processes.

## Prerequisites

| Tool           | Supported baseline |
| -------------- | ------------------ |
| Node.js        | 20 or newer        |
| pnpm           | 9 or newer         |
| Docker         | 24 or newer        |
| Docker Compose | 2 or newer         |

Optional tools: `jq`, `redis-cli`, `pg_isready`, and `wscat`.

## 1. Install and configure

```bash
cd ~/genesis/dev/Projects/taskqueue
pnpm install
cp .env.example .env
```

Generate a secret and place it in `.env`:

```bash
openssl rand -hex 32
```

At minimum, verify these values:

```dotenv
KAFKA_BROKERS=localhost:29092
REDIS_HOST=localhost
REDIS_PORT=6379
DATABASE_URL=postgresql://taskqueue:taskqueue@localhost:5432/taskqueue
JWT_SECRET=<generated-secret>
LOG_LEVEL=info
NODE_ENV=development
OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

Shell commands do not automatically load `.env`. Export it before starting services:

```bash
set -a
source .env
set +a
```

## 2. Validate the workspace

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

The normal test command skips Redis-backed integration tests. Run them after Redis starts:

```bash
RUN_REDIS_TESTS=true REDIS_URL=redis://localhost:6379 \
  pnpm --filter @taskqueue/shared test
```

## 3. Start infrastructure

```bash
docker compose up -d
docker compose ps
```

Compose starts:

- ZooKeeper and a single Kafka broker
- Kafka topic initialization
- PostgreSQL
- Redis
- Prometheus
- Grafana
- Jaeger

It does not start TaskQueue application services.

Verify infrastructure:

```bash
docker compose logs kafka-init
docker compose exec redis redis-cli ping
docker compose exec postgres pg_isready -U taskqueue
```

The one-shot `kafka-init` container should exit successfully after creating six topics.

## 4. Apply database migrations

```bash
pnpm --filter @taskqueue/state-manager migrate
```

Verify the schema:

```bash
docker compose exec postgres \
  psql -U taskqueue -d taskqueue -c '\dt'
```

Expected tables:

- `jobs`
- `workers`
- `audit_log`
- `dlq`
- `cron_jobs`
- `migrations`

## 5. Start application services

Export `.env` in each terminal, or run the following from shells where it is already
exported.

Start the state manager first, then the scheduler, API, notifier, metrics exporter, and
workers:

```bash
pnpm dev:state-manager
pnpm dev:scheduler
pnpm dev:api
pnpm dev:notifier
pnpm dev:metrics
pnpm dev:worker-email
pnpm dev:worker-image
pnpm dev:worker-data
```

Default ports:

| Process               | Port |
| --------------------- | ---: |
| API Gateway           | 3000 |
| Scheduler metrics     | 3200 |
| State Manager metrics | 3300 |
| Notifier WebSocket    | 3400 |
| Metrics Exporter      | 3500 |
| Email Worker metrics  | 3600 |
| Image Worker metrics  | 3601 |
| Data Worker metrics   | 3602 |

## 6. Configure the CLI

```bash
pnpm taskqueue profile use local
pnpm taskqueue config set api-url http://localhost:3000
pnpm taskqueue auth login --secret "$JWT_SECRET"
pnpm taskqueue auth status
pnpm taskqueue health
```

CLI profiles are stored in `~/.config/taskqueue/config.json` with file mode `0600`.

## 7. Verify job processing

Submit an email job:

```bash
pnpm taskqueue job submit email --priority 1 --payload '{
  "to":"hello@example.com",
  "subject":"TaskQueue test",
  "body":"Local verification"
}'
```

Use the returned ID:

```bash
pnpm taskqueue job get <job-id>
pnpm taskqueue job watch <job-id>
pnpm taskqueue job list --type email --limit 10
```

The typical lifecycle is `PENDING → QUEUED → RUNNING → SUCCESS`. The demonstration workers
intentionally inject occasional random failures, so retries may occur.

Submit a delayed job using an ISO-8601 timestamp:

```bash
pnpm taskqueue job submit data \
  --schedule '<future-iso-8601-timestamp>' \
  --payload '{"operation":"cleanup"}'
```

Create a cron job:

```bash
pnpm taskqueue cron create hourly-cleanup '0 * * * *' data \
  --payload '{"operation":"cleanup"}' \
  --priority 5
```

Other checks:

```bash
pnpm taskqueue queue stats
pnpm taskqueue cron list
pnpm taskqueue dlq list
```

## 8. Verify metrics and tracing

```bash
curl http://localhost:3200/metrics
curl http://localhost:3300/metrics
curl http://localhost:3500/metrics
curl http://localhost:3600/metrics
curl http://localhost:3601/metrics
curl http://localhost:3602/metrics
```

The API Gateway and Notifier do not currently expose Prometheus endpoints.

Local observability:

| Tool       | URL                    | Credentials       |
| ---------- | ---------------------- | ----------------- |
| Prometheus | http://localhost:9090  | none              |
| Grafana    | http://localhost:3001  | `admin` / `admin` |
| Jaeger     | http://localhost:16686 | none              |

Prometheus runs inside Docker and scrapes application processes through
`host.docker.internal`. Compose supplies a host-gateway mapping for Linux Docker engines.

## Troubleshooting

### A service cannot connect to Kafka

Use `localhost:29092` from host processes. `kafka:9092` is only resolvable from the Compose
network or Kubernetes.

```bash
docker compose ps kafka
docker compose logs kafka kafka-init
```

### A service cannot connect to PostgreSQL or Redis

```bash
docker compose ps postgres redis
docker compose logs postgres redis
```

Confirm `.env` is exported into the service shell.

### Job status is initially not found

Kafka processing is asynchronous. Retry after a short delay and inspect the state-manager
logs if the job never appears.

### CLI authentication fails

The secret used by `taskqueue auth login` must be identical to the API Gateway
`JWT_SECRET`. Alternatively, save an externally issued token:

```bash
pnpm taskqueue auth token '<jwt>'
```

### Port conflict

```bash
lsof -i :3000
```

Change the relevant `PORT` or `METRICS_PORT`, then update Prometheus configuration if a
metrics port changed.

## Shutdown and reset

Stop application processes with `Ctrl+C`, then:

```bash
docker compose down
```

Remove local PostgreSQL, Redis, Prometheus, and Grafana volumes:

```bash
docker compose down -v
```

This permanently deletes local development data.
