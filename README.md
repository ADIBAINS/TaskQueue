# TaskQueue

TaskQueue is a TypeScript distributed task queue and worker-orchestration platform. It
accepts jobs through a REST API or CLI, prioritizes and schedules them, dispatches them to
specialized worker pools, persists lifecycle state, and publishes live updates through
WebSockets.

The queue primitives are implemented directly instead of using BullMQ or another queue
framework:

- Binary min-heap priority queue
- Redis sorted-set delayed queue
- Redis list worker queues
- Redis distributed locks with owner-safe Lua release
- Async semaphore-based worker concurrency
- Heartbeats and orphaned-job reclamation
- Retry scheduling with exponential backoff and jitter

## Current status

The orchestration platform, CLI, local infrastructure, observability configuration,
container build, Kubernetes manifests, Helm chart, Kustomize overlays, and CI workflow are
implemented.

The included email, image, and data workers are demonstrators. They validate payloads and
simulate work and intermittent failures; they do not send real email, transform real image
files, or run production ETL. Replace their execution functions before treating those
workers as production integrations.

## Components

| Component        | Responsibility                                            | Default port |
| ---------------- | --------------------------------------------------------- | -----------: |
| API Gateway      | REST API, JWT auth, rate limiting                         |         3000 |
| Scheduler        | Priority, delayed jobs, retries, cron dispatch            |         3200 |
| State Manager    | PostgreSQL persistence, Redis state cache, audit log, DLQ |         3300 |
| Notifier         | WebSocket subscriptions and outbound webhooks             |         3400 |
| Metrics Exporter | Aggregated Prometheus metrics                             |         3500 |
| Email Worker     | Simulated email execution                                 |         3600 |
| Image Worker     | Simulated image execution                                 |         3601 |
| Data Worker      | Simulated data/ETL execution                              |         3602 |
| CLI              | Operator and client interface (`taskqueue` / `tq`)        |          n/a |

Infrastructure dependencies are Kafka, Redis, and PostgreSQL. Prometheus, Grafana, and
Jaeger are included for local observability.

## Quick start

Requirements: Node.js 20+, pnpm 9+, Docker, and Docker Compose.

```bash
pnpm install
cp .env.example .env

# Replace the insecure example value in .env.
openssl rand -hex 32

# Starts infrastructure and observability, not application services.
docker compose up -d

pnpm --filter @taskqueue/state-manager migrate
```

Start the eight application services in separate terminals:

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

Configure and use the CLI:

```bash
pnpm taskqueue profile use local
pnpm taskqueue config set api-url http://localhost:3000
pnpm taskqueue auth login --secret "$JWT_SECRET"
pnpm taskqueue health

pnpm taskqueue job submit email \
  --payload '{"to":"hello@example.com","subject":"Hello","body":"Test message"}'

pnpm taskqueue job list
pnpm taskqueue queue stats
```

See [Local development](docs/STARTUP.md) for the complete startup and verification
procedure.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, data flow, state transitions, storage,
  retries, and failure handling
- [CLI guide](docs/CLI.md) — installation, profiles, authentication, every command, JSON
  output, and shell completion
- [API reference](docs/API.md) — REST endpoints, payloads, authentication, WebSockets, and
  worker payload formats
- [Local development](docs/STARTUP.md) — prerequisites, startup order, tests, verification,
  observability, and troubleshooting
- [Operations](docs/OPERATIONS.md) — metrics, logs, tracing, backups, DLQ handling, and
  operational procedures
- [Deployment](docs/DEPLOYMENT.md) — Docker images, Helm, Kustomize, external dependencies,
  CI/CD, secrets, and production readiness

## Common development commands

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build

# Redis-backed delayed-queue integration tests
RUN_REDIS_TESTS=true REDIS_URL=redis://localhost:6379 \
  pnpm --filter @taskqueue/shared test

# CLI help
pnpm taskqueue --help
```

## Local URLs

| Service    | URL                    | Notes                                     |
| ---------- | ---------------------- | ----------------------------------------- |
| API        | http://localhost:3000  | `/health`, `/jobs`, `/queues/stats`       |
| Grafana    | http://localhost:3001  | `admin` / `admin` for local use           |
| Prometheus | http://localhost:9090  | Local metrics                             |
| Jaeger     | http://localhost:16686 | Traces when `OTLP_ENDPOINT` is configured |
| WebSocket  | ws://localhost:3400    | Job update subscriptions                  |

## Repository layout

```text
packages/shared/       Shared types, queue primitives, Kafka/Redis clients, metrics
services/api-gateway/  REST API
services/scheduler/    Scheduling, retries, delayed jobs, cron
services/state-manager/ Persistence, cached state, migration runner
services/notifier/     WebSocket and webhook notifications
services/metrics-exporter/
services/worker-*/     Worker implementations
services/cli/          taskqueue/tq command-line client
config/                Prometheus and Grafana provisioning
k8s/                   Base manifests and staging/production overlays
helm/taskqueue/         Helm chart
docs/                  User, architecture, operations, and deployment guides
```

## Important production limitations

Before production deployment:

- Replace simulated worker implementations.
- Supply managed or highly available Kafka, Redis, and PostgreSQL.
- Replace example secrets and remove credentials from values/manifests.
- Add TLS and authentication for infrastructure connections.
- Define network policies, ingress, certificates, resource sizing, disruption budgets, and
  backup/restore procedures.
- Review webhook destination controls; user-supplied URLs require SSRF protections in
  untrusted environments.
- Verify your Prometheus Operator and KEDA CRDs are installed before applying manifests
  that use them.

The deployment assets assume those platform-level dependencies already exist; they do not
install production Kafka, Redis, PostgreSQL, ingress, or certificate management.
