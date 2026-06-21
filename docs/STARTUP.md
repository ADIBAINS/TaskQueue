# TaskQueue — Startup & Verification Guide

This guide walks through starting every component from scratch and verifying each one works. Follow it in order — each step depends on the previous.

---

## Prerequisites

You need these installed on your machine:

| Tool | Version | Check |
|------|---------|-------|
| Node.js | ≥20.0.0 | `node --version` |
| pnpm | ≥9.0.0 | `pnpm --version` |
| Docker | ≥24.0.0 | `docker --version` |
| Docker Compose | ≥2.0.0 | `docker compose version` |

**Install pnpm if missing:**
```bash
npm install -g pnpm
```

---

## Step 1 — Clone & Install Dependencies

```bash
cd ~/genesis/dev/Projects/taskqueue
pnpm install
```

**Verify:** You should see all 10 workspace packages resolve without errors.

```bash
pnpm ls -r --depth 0
```

Expected output lists: `@taskqueue/shared`, `@taskqueue/api-gateway`, `@taskqueue/scheduler`, `@taskqueue/state-manager`, `@taskqueue/notifier`, `@taskqueue/metrics-exporter`, `@taskqueue/worker-email`, `@taskqueue/worker-image`, `@taskqueue/worker-data`.

---

## Step 2 — Build the Shared Package

All services depend on `@taskqueue/shared`. Build it first:

```bash
pnpm --filter @taskqueue/shared build
```

**Verify:** `packages/shared/dist/` directory exists with compiled `.js` and `.d.ts` files.

---

## Step 3 — TypeScript Type Check (Optional but Recommended)

```bash
pnpm -r typecheck
```

Every service should report `OK`. If any fail, stop and fix before continuing.

---

## Step 4 — Run Unit Tests

```bash
pnpm --filter @taskqueue/shared test
```

**Expected:** 7 tests pass (PriorityQueue tests). The DelayedQueue tests require Redis and will be skipped or fail if Redis isn't running — that's fine at this stage.

---

## Step 5 — Create Your .env File

```bash
cp .env.example .env
```

**What YOU need to set:**

| Variable | Default | What to change |
|----------|---------|----------------|
| `JWT_SECRET` | `change-me-in-production` | **MUST change** — generate a random string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL` | Already correct for Docker | No change needed for local dev |
| Everything else | Already correct | No changes needed for local dev |

**Minimal .env file (copy this exactly if you want):**
```bash
KAFKA_BROKERS=localhost:29092
REDIS_HOST=localhost
REDIS_PORT=6379
DATABASE_URL=postgresql://taskqueue:taskqueue@localhost:5432/taskqueue
PORT=3000
JWT_SECRET=<your-generated-secret-here>
LOG_LEVEL=info
NODE_ENV=development
```

---

## Step 6 — Start Infrastructure (Docker)

This starts Kafka, Zookeeper, PostgreSQL, Redis, Prometheus, Grafana, and Jaeger:

```bash
docker compose up -d
```

**Wait for all containers to be healthy (about 30-60 seconds):**

```bash
docker compose ps
```

**Verify each container runs:**

```bash
docker compose logs kafka-init | grep "All topics created"
docker compose logs postgres | grep "database system is ready"
docker compose logs redis | grep "Ready to accept connections"
```

If `kafka-init` exited with code 0 and you see "All topics created.", Kafka is ready.

**Verify infrastructure ports:**

```bash
# PostgreSQL
pg_isready -h localhost -p 5432 -U taskqueue

# Redis
redis-cli -h localhost -p 6379 PING

# Kafka broker
docker exec tq-kafka kafka-broker-api-versions --bootstrap-server localhost:9092 | head -5
```

---

## Step 7 — Run Database Migrations

```bash
pnpm --filter @taskqueue/state-manager migrate
```

**Verify:** No errors in output. Check the tables were created:

```bash
docker exec tq-postgres psql -U taskqueue -d taskqueue -c "\dt"
```

Expected tables: `jobs`, `workers`, `audit_log`, `dlq`, `cron_jobs`, `migrations`.

---

## Step 8 — Generate a JWT Token

You need this to submit jobs. Generate one:

```bash
node -e "
const jwt = require('jsonwebtoken');
const secret = process.env.JWT_SECRET || 'change-me-in-production';
const token = jwt.sign({ client: 'cli' }, secret, { expiresIn: '24h' });
console.log(token);
"
```

**Save this token** — you'll use it in every API call.

---

## Step 9 — Start Services (8 Terminal Windows)

Open **8 separate terminals**. In each, run one of these commands. Order matters — start state-manager first, then the rest.

### Terminal 1 — State Manager (start first)
```bash
cd ~/genesis/dev/Projects/taskqueue/services/state-manager
source ../../.env 2>/dev/null
METRICS_PORT=3300 npx tsx src/index.ts
```

### Terminal 2 — Scheduler
```bash
cd ~/genesis/dev/Projects/taskqueue/services/scheduler
source ../../.env 2>/dev/null
npx tsx src/index.ts
```

### Terminal 3 — API Gateway
```bash
cd ~/genesis/dev/Projects/taskqueue/services/api-gateway
source ../../.env 2>/dev/null
npx tsx src/index.ts
```

### Terminal 4 — Notifier
```bash
cd ~/genesis/dev/Projects/taskqueue/services/notifier
source ../../.env 2>/dev/null
PORT=3400 npx tsx src/index.ts
```

### Terminal 5 — Metrics Exporter
```bash
cd ~/genesis/dev/Projects/taskqueue/services/metrics-exporter
source ../../.env 2>/dev/null
PORT=3500 npx tsx src/index.ts
```

### Terminal 6 — Email Worker
```bash
cd ~/genesis/dev/Projects/taskqueue/services/worker-email
source ../../.env 2>/dev/null
METRICS_PORT=3600 npx tsx src/index.ts
```

### Terminal 7 — Image Worker
```bash
cd ~/genesis/dev/Projects/taskqueue/services/worker-image
source ../../.env 2>/dev/null
METRICS_PORT=3601 npx tsx src/index.ts
```

### Terminal 8 — Data Worker
```bash
cd ~/genesis/dev/Projects/taskqueue/services/worker-data
source ../../.env 2>/dev/null
METRICS_PORT=3602 npx tsx src/index.ts
```

**Verify each service started:** Look for log lines like:
- `"API Gateway listening"` (port 3000)
- `"Scheduler running"` + `"Scheduler metrics server started"` (port 3200)
- `"State Manager running"` + `"State Manager metrics server started"` (port 3300)
- `"WebSocket server listening"` (port 3400)
- `"Metrics exporter listening"` (port 3500)
- `"Worker started"` (email 3600, image 3601, data 3602)

---

## Step 10 — Verify Each Component

### 10a — Submit a Test Job

```bash
TOKEN="<paste-your-jwt-token-here>"

curl -s -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "email",
    "priority": 1,
    "payload": {
      "to": "hello@example.com",
      "subject": "Test from TaskQueue",
      "body": "This is a test email job."
    }
  }' | jq .
```

**Expected:** Returns a JSON object with `job.id`, `job.type: "email"`, `job.status: "PENDING"`.

Save the job ID from the response:
```bash
JOB_ID="<from-response>"
```

### 10b — Check Job Status

```bash
curl -s http://localhost:3000/jobs/$JOB_ID | jq .
```

The job should transition: `PENDING` → `QUEUED` → `RUNNING` → `SUCCESS` within a few seconds.

### 10c — Submit a Delayed Job

```bash
curl -s -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "data",
    "priority": 2,
    "payload": {"operation": "aggregate", "dataset": "sales_q4"},
    "scheduledAt": "'$(date -u -d '+30 seconds' +%Y-%m-%dT%H:%M:%SZ)'"
  }' | jq .
```

The job should wait ~30 seconds before moving to RUNNING.

### 10d — Submit with Idempotency Key

```bash
curl -s -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "image",
    "priority": 3,
    "payload": {"url": "photo.jpg", "width": 800, "height": 600},
    "idempotencyKey": "unique-key-123"
  }' | jq .

# Submit the same again
curl -s -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "image",
    "priority": 3,
    "payload": {"url": "photo.jpg", "width": 800, "height": 600},
    "idempotencyKey": "unique-key-123"
  }' | jq .
```

The second call should return `"deduplicated": true` with the same job.

### 10e — Check Queue Stats

```bash
curl -s http://localhost:3000/queues/stats | jq .
```

### 10f — Create a Cron Job

```bash
curl -s -X POST http://localhost:3000/cron \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hourly-cleanup",
    "cronExpression": "0 * * * *",
    "jobType": "data",
    "payload": {"operation": "cleanup"},
    "priority": 5
  }' | jq .
```

### 10g — List Cron Jobs & DLQ

```bash
curl -s http://localhost:3000/cron -H "Authorization: Bearer $TOKEN" | jq .
curl -s http://localhost:3000/dlq -H "Authorization: Bearer $TOKEN" | jq .
```

### 10h — Verify Metrics Endpoints

```bash
curl -s http://localhost:3200/metrics | grep taskqueue
curl -s http://localhost:3300/metrics | grep taskqueue
curl -s http://localhost:3500/metrics | grep taskqueue
curl -s http://localhost:3600/metrics | grep taskqueue
```

Each should return Prometheus-formatted metrics with `taskqueue_*` lines.

### 10i — Verify WebSocket Notifications

Use a WebSocket client:
```bash
# Install wscat if needed: npm install -g wscat
wscat -c ws://localhost:3400 -H "x-client-id: test-client"
```

Once connected, send a subscribe message:
```json
{"type": "subscribe", "jobId": "<paste-a-job-id>"}
```

Then submit a job with that ID — you'll receive real-time status updates.

---

## Step 11 — Verify Observability Stack

| Component | URL | Credentials |
|-----------|-----|-------------|
| **Prometheus** | http://localhost:9090 | None |
| **Grafana** | http://localhost:3000 | admin / admin |
| **Jaeger** | http://localhost:16686 | None |

**Prometheus check:** Go to http://localhost:9090 → Status → Targets. You should see targets for api-gateway, scheduler, state-manager, notifier, metrics-exporter, and all 3 workers as UP.

**Grafana check:** Go to http://localhost:3000 → Dashboards → TaskQueue folder. Three dashboards should appear: Queue Health, Worker Health, System Overview.

**Jaeger check:** Go to http://localhost:16686 → Search. If you set `OTLP_ENDPOINT=http://localhost:4318/v1/traces`, traces from all 8 services should appear after processing jobs.

---

## Step 12 — Enable Distributed Tracing (Optional)

Add this to your `.env` and restart all services:
```bash
OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

Then submit a job and look for traces in Jaeger at http://localhost:16686. You'll see spans across API Gateway → Scheduler → Worker → State Manager → Notifier.

---

## Things YOU Need to Implement

These items are intentionally left for you as the developer to customize:

### 1. JWT Secret
Generate and set `JWT_SECRET` in your `.env`. The default `change-me-in-production` is intentionally insecure.

### 2. Actual Email Sending
`services/worker-email/src/index.ts` currently simulates email delivery. To send real emails, replace the `execute` function with nodemailer/SES/SendGrid integration.

### 3. Actual Image Processing
`services/worker-image/src/index.ts` simulates image processing. To process real images, import `sharp` (already in `package.json`) and implement actual resize/format/watermark operations.

### 4. Actual Data Processing
`services/worker-data/src/index.ts` simulates data operations. To process real data, connect to your database and implement actual ETL logic.

### 5. Production PostgreSQL
The Docker PostgreSQL container has no persistent volume in production. For real deployments, use a managed PostgreSQL service (RDS, Cloud SQL) and set `DATABASE_URL` accordingly.

### 6. Production Kafka
For production, use a managed Kafka service (Confluent Cloud, MSK) instead of the single-broker Docker setup. Update `KAFKA_BROKERS` accordingly.

### 7. TLS/SSL
All connections are plaintext in local dev. For production, configure TLS for Kafka, Redis, and PostgreSQL connections.

### 8. Kubernetes Cluster
The `k8s/` and `helm/` directories contain production manifests. You need:
- A running Kubernetes cluster (EKS, GKE, AKS, or local k3s)
- `kubectl` configured
- Helm 3 installed
- KEDA installed: `helm install keda kedacore/keda --namespace keda --create-namespace`
- Prometheus Operator (for ServiceMonitor CRD): `helm install prometheus-operator prometheus-community/kube-prometheus-stack`

### 9. Container Registry
The GitHub Actions CI/CD pushes to `ghcr.io`. You need:
- A GitHub repository with the code pushed
- GitHub Container Registry enabled
- ArgoCD installed on your cluster

### 10. Admin CLI (from spec)
A TypeScript CLI using Commander.js for:
- `taskqueue queue list` — show all queues
- `taskqueue queue drain <type>` — drain a queue
- `taskqueue worker pause <type>` — pause a worker pool
- `taskqueue dlq requeue <id>` — move job from DLQ back to queue

---

## Troubleshooting

### Kafka connection refused
```bash
docker compose restart kafka kafka-init
# Wait 10 seconds, then check:
docker compose logs kafka-init | tail -5
```

### PostgreSQL connection refused
```bash
docker compose restart postgres
# Wait for "database system is ready" in logs
docker compose logs postgres | grep "ready"
```

### Redis connection refused
```bash
docker compose restart redis
```

### "Job not found" when checking status
The state-manager might not have processed the job yet. Wait a few seconds and retry. Check state-manager terminal for errors.

### pnpm build failures in shared package
```bash
rm -rf packages/shared/dist
pnpm --filter @taskqueue/shared build
```

### Port conflicts
If ports 3000, 3200, 3300, 3400, 3500, or 3600-3602 are in use:
```bash
# Find what's using a port
lsof -i :3000
# Kill it
kill -9 <PID>
```
Or change the ports in your `.env` and adjust `config/prometheus/prometheus.yml`.

---

## Complete Verification Checklist

Run through this checklist to confirm everything works:

- [ ] `docker compose ps` shows all 8 containers running
- [ ] `pnpm -r typecheck` passes for all 9 packages
- [ ] `pnpm --filter @taskqueue/shared test` passes 7 tests
- [ ] Database migrations applied (tables exist)
- [ ] JWT token generated and saved
- [ ] API Gateway responds to `GET /health`
- [ ] Job submission returns a job object
- [ ] Job transitions through PENDING → QUEUED → RUNNING → SUCCESS
- [ ] Delayed job waits the specified time before processing
- [ ] Idempotency key prevents duplicate jobs
- [ ] Queue stats endpoint returns data
- [ ] Cron job creation works
- [ ] DLQ listing works
- [ ] All metrics endpoints return Prometheus data
- [ ] WebSocket notifications work
- [ ] Prometheus targets are UP
- [ ] Grafana dashboards show data
- [ ] (If OTLP enabled) Jaeger shows traces
