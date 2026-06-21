# TaskQueue — Distributed Task Queue & Worker Orchestration Platform

**A production-grade, Kubernetes-native distributed task queue built from scratch in TypeScript. Zero pre-built queue libraries. Every data structure, lock, and scheduling algorithm is hand-implemented.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What This Is

TaskQueue is a full distributed task queue platform — the kind of system that powers background job processing at companies like Stripe, Airbnb, and GitHub. Clients submit jobs via a REST API. Those jobs flow through a priority scheduler, get routed to the right worker pool, are processed concurrently with controlled parallelism, and report results in real time via WebSockets.

**Everything is built from first principles.** The priority queue is a binary min-heap I wrote, not a library. The delayed queue uses Redis sorted sets with atomic MULTI operations. Job locking uses Redis SET NX EX with Lua-scripted safe release. Worker heartbeats use TTL-based death detection. The semaphore for concurrency control is a custom async implementation. No BullMQ, no Agenda, no pre-built solutions — just raw data structures and distributed systems patterns implemented in TypeScript.

---

## Architecture

```
                              ┌──────────────────┐
                              │   API Gateway     │  Port 3000
                              │ Express + JWT     │
                              │ Rate Limiting     │
                              └────────┬─────────┘
                                       │ Kafka (job.submitted)
                                       ▼
                              ┌──────────────────┐
                              │   Scheduler       │  Port 3200
                              │ Min-Heap Priority │
                              │ Redis Delayed Q   │
                              │ Retry w/ Backoff  │
                              └────────┬─────────┘
                                       │ Redis LIST (FIFO per type)
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │ Email Worker  │  │ Image Worker  │  │ Data Worker   │
            │ Concurrency:5 │  │ Concurrency:3 │  │ Concurrency:8 │
            │ Metrics :3600 │  │ Metrics :3601 │  │ Metrics :3602 │
            └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
                   │                 │                 │
                   └────────┬────────┴────────┬────────┘
                            │ Kafka (job.completed / job.failed)
                            ▼
                   ┌──────────────────┐
                   │  State Manager    │  Port 3300
                   │ PostgreSQL + Redis│
                   │ Audit Log + DLQ   │
                   └────────┬─────────┘
                            │ Kafka (job.state-change)
                            ▼
                   ┌──────────────────┐
                   │   Notifier        │  Port 3400
                   │ WebSockets +      │
                   │ Webhooks          │
                   └────────┬─────────┘
                            │
                   ┌──────────────────┐
                   │ Metrics Exporter  │  Port 3500
                   │ Prometheus /metrics│
                   └──────────────────┘
```

**Message Flow:**
1. Client → `POST /jobs` → API Gateway publishes to `job.submitted` Kafka topic
2. Scheduler consumes `job.submitted` → priority heap or delayed queue → drains to Redis LIST per worker type
3. Worker pulls from Redis LIST (BLPOP) → acquires distributed lock → marks RUNNING → executes → publishes SUCCESS/FAILED
4. State Manager consumes completed/failed events → PostgreSQL + Redis dual-write → publishes state-change
5. Notifier consumes state-change → pushes to WebSocket clients + fires webhooks
6. Metrics Exporter scrapes Redis → exposes Prometheus `/metrics`

---

## Project Stats

| Metric | Count |
|--------|-------|
| TypeScript source files | 27 |
| Total lines of TypeScript | 3,514 |
| Services | 8 + 1 shared package |
| Kubernetes manifests | 13 |
| Helm chart templates | 4 |
| Database migrations | 1 (5 tables, 8 indexes) |
| Kafka topics | 6 |
| Grafana dashboards | 3 |
| CI/CD workflows | 1 (5 jobs, 8 matrix services) |
| Unit tests | 7 (PriorityQueue) |
| Integration tests | 6 (DelayedQueue) |

---

## Services

| Service | Purpose | Tech | Port |
|---------|---------|------|------|
| **api-gateway** | REST API — submit jobs, get status, cancel, retry, manage DLQ and cron | Express, JWT, rate-limit, helmet | 3000 |
| **scheduler** | In-memory priority heap + Redis delayed queue + retry with exponential backoff + cron trigger loop | Custom binary min-heap, cron-parser | 3200 |
| **state-manager** | Job lifecycle state machine — PostgreSQL for persistence, Redis for fast lookups, dual-write consistency | pg (raw SQL), ioredis | 3300 |
| **notifier** | Real-time job updates via WebSockets + webhook delivery on completion | ws, native fetch | 3400 |
| **metrics-exporter** | Prometheus-format metrics endpoint — queue depth, throughput, worker count, DLQ size | Express, Prometheus text format | 3500 |
| **worker-email** | Email job processor — template rendering, validation, SMTP simulation | Custom semaphore, Redis locks | 3600 |
| **worker-image** | Image processing — resize, format conversion, compression | Custom semaphore, Redis locks | 3601 |
| **worker-data** | Data/ETL — aggregate, transform, validate, export, cleanup operations | Custom semaphore, Redis locks | 3602 |

---

## Custom Implementations (No Pre-Built Queue Libraries)

### Priority Queue (`packages/shared/src/queue/priority-queue.ts`)
A binary min-heap with `enqueue()`, `dequeue()`, `peek()`, `size()`, `clear()`, and `toArray()`. Private `siftUp()` and `siftDown()` maintain heap property. O(log n) for enqueue/dequeue, O(1) for peek. Lower priority number = higher urgency.

### Delayed Queue (`packages/shared/src/queue/delayed-queue.ts`)
Redis sorted-set backed. Jobs stored with `ZADD` where score = execution timestamp (ms). `pullReady()` uses atomic `MULTI` → `ZRANGEBYSCORE` + `ZREMRANGEBYSCORE` to atomically fetch and remove ready jobs. Scheduler polls every 500ms.

### Worker FIFO Queue (`packages/shared/src/queue/worker-queue.ts`)
Redis LIST operations — `RPUSH` for enqueue, `BLPOP` for blocking dequeue with configurable timeout. Distributed locks via `SET key value EX ttl NX` with Lua-scripted safe `releaseLock()` and `extendLock()`. `findExpiredLocks()` reclaims orphaned jobs from dead workers.

### Semaphore (`packages/shared/src/queue/worker-runner.ts`)
Custom async semaphore with a counter and a waiter queue. `acquire()` blocks when no permits available, `release()` wakes the next waiter. Controls max concurrent jobs per worker.

### Exponential Backoff Retry
`baseDelay * 2^retryCount + random(0, 500ms)` jitter. Scheduler reads FAILED state from Kafka, checks retry count from Redis, re-queues with computed delay via delayed queue. Max retries exceeded → DLQ.

### Worker Heartbeat & Death Detection
Workers `SET heartbeat:{workerId} timestamp EX 15` every 5 seconds. Orphan reclaimer runs every 10 seconds — finds expired heartbeat keys and locked jobs with expired TTLs, re-queues them.

### Job Lifecycle State Machine
```
PENDING → QUEUED → RUNNING → SUCCESS
                  ↘ RUNNING → FAILED → (retry) → QUEUED
                            ↘ FAILED → DEAD → DLQ
                  → CANCELLED
```
Full audit log tracks every state transition in PostgreSQL.

---

## API Reference

All POST/DELETE endpoints require JWT authentication (`Authorization: Bearer <token>`).

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/jobs` | Submit a new job |
| `GET` | `/jobs/:id` | Get job status and details |
| `POST` | `/jobs/:id/cancel` | Cancel a pending/queued job |
| `POST` | `/jobs/:id/retry` | Retry a failed or dead job |

### Queue Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/queues/stats` | Queue depth, throughput per type |

### Cron Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/cron` | List all cron jobs |
| `POST` | `/cron` | Create a cron job |
| `DELETE` | `/cron/:id` | Disable a cron job |

### Dead Letter Queue
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/dlq` | List DLQ entries (filter by `?type=email`) |
| `POST` | `/dlq/:id/requeue` | Requeue a DLQ entry as a new job |

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health check |

### WebSocket
Connect to `ws://localhost:3400` with header `x-client-id: <your-id>`.
```json
{"type": "subscribe", "jobId": "<uuid>"}
```
Receive real-time updates:
```json
{"type": "job_update", "jobId": "...", "previousStatus": "RUNNING", "newStatus": "SUCCESS", "timestamp": "..."}
```

---

## Key Features

- **Custom Priority Queue** — Binary min-heap, O(log n), no dependencies
- **Delayed/Scheduled Jobs** — Redis sorted sets, schedule for future execution
- **Distributed Job Locking** — SET NX EX prevents double-processing, Lua-scripted safe release
- **Worker Heartbeats** — 5-second TTL-based liveness signals
- **Orphaned Job Reclamation** — Automatic detection and re-queue of jobs abandoned by dead workers
- **Semaphore Concurrency Control** — Configurable max concurrent jobs per worker type
- **Exponential Backoff Retry** — `base × 2^retryCount + jitter`, configurable max retries
- **Dead Letter Queue** — Jobs exceeding max retries land in DLQ with full context
- **Job Chaining** — `onSuccess`/`onFailure` triggers next job automatically
- **Idempotency Keys** — Duplicate submission returns existing job (24h Redis TTL)
- **Cron Job Scheduling** — Register recurring jobs with cron expressions, auto-triggered by scheduler
- **Real-time Notifications** — WebSocket push + webhook delivery on job completion
- **Structured Logging** — pino with correlation IDs propagating across all services via AsyncLocalStorage
- **Distributed Tracing** — OpenTelemetry auto-instrumentation (HTTP, Redis, PostgreSQL, Kafka) exported to Jaeger
- **Prometheus Metrics** — Every service exposes `/metrics` — queue depth, throughput, worker count, DLQ size
- **Grafana Dashboards** — 3 pre-built dashboards (Queue Health, Worker Health, System Overview)
- **KEDA Autoscaling** — Workers scale based on Redis LIST length, not CPU
- **Multi-stage Docker Builds** — Builder → runner, minimal alpine images, non-root user
- **Kubernetes-Native** — Deployments, Services, HPA, ConfigMaps, Secrets, ServiceMonitors, KEDA ScaledObjects
- **Helm Chart** — Single-command deployment with full parameterization
- **Kustomize Overlays** — Staging and production environment variants
- **CI/CD** — GitHub Actions: typecheck → test → matrix build (8 services) → push to ghcr.io → ArgoCD sync

---

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Build shared package
pnpm --filter @taskqueue/shared build

# 3. Create .env from template (edit JWT_SECRET!)
cp .env.example .env

# 4. Start infrastructure (Kafka, PostgreSQL, Redis, Prometheus, Grafana, Jaeger)
docker compose up -d

# 5. Run database migrations
pnpm --filter @taskqueue/state-manager migrate

# 6. Generate a JWT token
node -e "const j=require('jsonwebtoken'); console.log(j.sign({client:'cli'}, process.env.JWT_SECRET||'change-me-in-production', {expiresIn:'24h'}))"

# 7. Start services (8 separate terminals — see docs/STARTUP.md for full guide)
pnpm dev:state-manager   # Terminal 1 — start first
pnpm dev:scheduler        # Terminal 2
pnpm dev:api              # Terminal 3
pnpm dev:notifier         # Terminal 4
pnpm dev:metrics          # Terminal 5
pnpm dev:worker-email     # Terminal 6
pnpm dev:worker-image     # Terminal 7
pnpm dev:worker-data      # Terminal 8
```

**Full step-by-step startup guide with verification:** See [`docs/STARTUP.md`](docs/STARTUP.md)

---

## Example: Submit and Track a Job

```bash
TOKEN="<your-jwt-token>"

# Submit an email job
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "email",
    "priority": 1,
    "payload": {"to": "user@example.com", "subject": "Welcome!", "body": "Thanks for signing up."}
  }'

# Response: {"job": {"id": "abc-123", "type": "email", "status": "PENDING", ...}}

# Check status (retry every second — it'll go PENDING → QUEUED → RUNNING → SUCCESS)
curl http://localhost:3000/jobs/abc-123

# Submit a delayed job (runs 60 seconds from now)
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "data",
    "priority": 2,
    "payload": {"operation": "aggregate", "dataset": "sales"},
    "scheduledAt": "'$(date -u -d '+60 seconds' +%Y-%m-%dT%H:%M:%SZ)'"
  }'

# Job chaining — on success, trigger an image job
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "data",
    "priority": 2,
    "payload": {"operation": "export", "limit": 1000},
    "onSuccess": {"nextJobType": "image", "payload": {"url": "chart.png", "width": 1200}, "priority": 3}
  }'

# Create a recurring cron job
curl -X POST http://localhost:3000/cron \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "hourly-cleanup", "cronExpression": "0 * * * *", "jobType": "data", "payload": {"operation": "cleanup"}, "priority": 5}'
```

---

## Observability

| Component | URL | Credentials | Purpose |
|-----------|-----|-------------|---------|
| **Prometheus** | http://localhost:9090 | None | Metrics collection, alerting rules |
| **Grafana** | http://localhost:3000 | admin / admin | 3 pre-built dashboards |
| **Jaeger** | http://localhost:16686 | None | Distributed trace search and visualization |

Enable distributed tracing by adding to `.env`:
```bash
OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

---

## Project Structure

```
taskqueue/
├── packages/
│   └── shared/              # Shared types, queue impls, Kafka/Redis clients, logger, tracing
│       ├── src/
│       │   ├── types/       # Job, JobStatus, DLQEntry, CronJob, WorkerInfo, QueueStats
│       │   ├── queue/       # PriorityQueue, DelayedQueue, WorkerQueue, WorkerRunner
│       │   ├── kafka/       # Kafka producer/consumer with singleton management
│       │   ├── redis/       # Redis client, heartbeat, worker lifecycle
│       │   ├── logger/      # pino + AsyncLocalStorage correlation IDs
│       │   ├── tracing.ts   # OpenTelemetry auto-instrumentation
│       │   └── metrics-server.ts  # Lightweight /metrics HTTP server
│       └── tests/           # PriorityQueue (7 unit) + DelayedQueue (6 integration)
├── services/
│   ├── api-gateway/         # Express REST API, JWT auth, rate limiting
│   ├── scheduler/           # Kafka consumer, min-heap, delayed queue, retry, cron
│   ├── state-manager/       # PostgreSQL + Redis dual-write, migrations
│   ├── notifier/            # WebSocket server, webhook delivery
│   ├── metrics-exporter/    # Prometheus /metrics endpoint
│   ├── worker-email/        # Email job processor
│   ├── worker-image/        # Image processing job processor
│   └── worker-data/         # Data/ETL job processor
├── config/
│   ├── prometheus/          # Prometheus scrape config (all 8 services)
│   └── grafana/
│       └── dashboards/      # 3 dashboard JSONs
├── k8s/
│   ├── base/                # Deployments, Services, HPA, KEDA ScaledObjects, ServiceMonitors
│   └── overlays/            # Staging + Production Kustomize variants
├── helm/taskqueue/          # Helm chart (values.yaml, templated deployments)
├── .github/workflows/       # CI/CD — typecheck → test → build matrix → ArgoCD deploy
├── docker-compose.yml       # Local dev: Kafka, Zookeeper, PostgreSQL, Redis, Prometheus, Grafana, Jaeger
├── Dockerfile               # Multi-stage build (builder + runner, alpine, non-root)
├── .env.example             # Environment variable template
└── docs/
    └── STARTUP.md           # Complete startup & verification guide
```

---

## Production Deployment

### Prerequisites
- Kubernetes cluster with `kubectl` configured
- Helm 3
- KEDA: `helm install keda kedacore/keda --namespace keda --create-namespace`
- Prometheus Operator (for ServiceMonitor CRD)

### Deploy via Helm
```bash
helm upgrade --install taskqueue ./helm/taskqueue \
  --namespace taskqueue-production \
  --create-namespace \
  --set image.tag=v1.0.0 \
  --set auth.jwtSecret="$(openssl rand -hex 32)" \
  --set infrastructure.postgres.url="postgresql://user:pass@host:5432/taskqueue"
```

### Deploy via Kustomize
```bash
kubectl apply -k k8s/overlays/production
```

### CI/CD Pipeline (GitHub Actions)
On push to `main`:
1. TypeScript type check (`pnpm -r typecheck`)
2. Unit tests (`pnpm -r test`)
3. Build & push Docker images (matrix over 8 services) to `ghcr.io`
4. ArgoCD sync → staging namespace
5. ArgoCD sync → production namespace (requires environment approval)

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 22 |
| Language | TypeScript 5.7 (strict mode) |
| Monorepo | pnpm workspaces |
| API Framework | Express 4 |
| Auth | JWT (jsonwebtoken) |
| Rate Limiting | express-rate-limit |
| Security | helmet, CORS |
| Messaging | Apache Kafka (kafkajs) |
| Cache/Queue | Redis 7 (ioredis) |
| Database | PostgreSQL 16 (pg — raw SQL, no ORM) |
| Migrations | Custom SQL runner |
| Logging | pino (structured JSON + correlation IDs) |
| Tracing | OpenTelemetry → Jaeger (OTLP) |
| WebSockets | ws |
| Scheduling | cron-parser |
| Container Runtime | Docker (multi-stage, alpine) |
| Orchestration | Kubernetes |
| Autoscaling | KEDA (Redis queue length trigger) |
| Packaging | Helm 3 + Kustomize |
| CI/CD | GitHub Actions + ArgoCD |
| Observability | Prometheus + Grafana |
| Testing | Vitest |

---

## Design Decisions

**Why custom queue implementations instead of BullMQ/Redis?**
This is a portfolio project designed to demonstrate deep understanding of distributed systems. Every queue data structure is hand-built — the min-heap, the Redis sorted-set delayed queue, the distributed lock with Lua scripts, the semaphore. These are the same patterns used in production systems but typically hidden behind libraries.

**Why dual-write PostgreSQL + Redis?**
Redis provides sub-millisecond reads for real-time status checks. PostgreSQL provides durability, audit logging, and relational queries (DLQ filtering, cron job management). The state manager writes to both — Redis for speed, PostgreSQL for persistence. Eventual consistency is acceptable for status reads.

**Why Kafka instead of direct Redis pub/sub?**
Kafka provides durable, replayable event streams with consumer groups. If the notifier crashes, it can resume from its last offset. Redis pub/sub is fire-and-forget — messages are lost if no subscriber is listening.

**Why a separate metrics-exporter service?**
Each internal service (scheduler, workers, state-manager) exposes its own `/metrics` endpoint with service-specific metrics. The metrics-exporter provides a centralized Prometheus endpoint that aggregates cross-cutting metrics from Redis that span all services.

**Why KEDA over standard HPA?**
HPA scales on CPU/memory. KEDA scales on Redis queue length — directly tied to actual workload. If 1000 image processing jobs queue up, the image worker pool scales out immediately, regardless of CPU usage.

---

## What's Implemented vs What's Left for You

### Fully Implemented
- All 8 services with complete logic
- Custom PriorityQueue (binary min-heap)
- Custom DelayedQueue (Redis sorted sets)
- Custom WorkerQueue (Redis LIST + distributed locks)
- Custom Semaphore (async concurrency control)
- Kafka producer/consumer with 6 topics
- PostgreSQL schema with 5 tables, 8 indexes, triggers
- SQL migration runner
- Redis dual-write state layer
- JWT authentication
- Rate limiting
- Job lifecycle state machine
- Exponential backoff retry
- Dead Letter Queue
- Job chaining (onSuccess/onFailure)
- Idempotency keys
- Cron job scheduling
- WebSocket real-time notifications
- Webhook delivery
- Prometheus metrics on all services
- 3 Grafana dashboards
- OpenTelemetry distributed tracing
- Multi-stage Docker builds
- Kubernetes manifests (Deployments, Services, HPA, KEDA, ServiceMonitors)
- Helm chart
- Kustomize staging/production overlays
- GitHub Actions CI/CD pipeline
- docker-compose with 8 containers
- 7 unit tests + 6 integration tests
- Full startup & verification guide

### Left for You to Customize
- **JWT Secret** — Generate a real secret, don't use the default
- **Real worker logic** — Email workers need nodemailer/SES, image workers need actual sharp processing, data workers need real database connections
- **Admin CLI** — A Commander.js CLI tool for queue management (not yet built)
- **Production credentials** — Replace hardcoded secrets in Helm values with sealed secrets or external secrets operator
- **Production databases** — Point DATABASE_URL at a managed PostgreSQL, Kafka at a managed broker
- **TLS everywhere** — Enable TLS for Kafka, Redis, PostgreSQL connections
