# Operations

## Health model

The API Gateway exposes `GET /health`, but it reports process liveness only. It does not
probe Kafka, Redis, or PostgreSQL. Kubernetes liveness checks should distinguish process
health from dependency readiness in a future hardening pass.

Use these operational checks:

```bash
taskqueue health
taskqueue queue stats
taskqueue job list --status FAILED
taskqueue dlq list
```

## Metrics

Prometheus-format endpoints:

| Process          | Endpoint        |
| ---------------- | --------------- |
| Scheduler        | `:3200/metrics` |
| State Manager    | `:3300/metrics` |
| Metrics Exporter | `:3500/metrics` |
| Email Worker     | `:3600/metrics` |
| Image Worker     | `:3601/metrics` |
| Data Worker      | `:3602/metrics` |

The API Gateway and Notifier do not currently expose metrics.

Important metric families include:

- `taskqueue_queue_depth`
- `taskqueue_jobs_enqueued_total`
- `taskqueue_jobs_dequeued_total`
- `taskqueue_jobs_failed_total`
- `taskqueue_workers_active`
- `taskqueue_priority_queue_depth`
- `taskqueue_delayed_queue_depth`
- Service uptime gauges

The counters are cumulative from Redis and are not reset-aware rate calculations. Use
PromQL `rate()` or `increase()` over counter metrics where appropriate.

Suggested alerts:

- Queue depth increasing continuously
- Oldest delayed job past due
- Worker count zero while queue depth is nonzero
- Failure rate above baseline
- DLQ growth
- Kafka consumer lag
- PostgreSQL or Redis unavailable
- Scheduler or State Manager absent

## Logs

Services use Pino structured logging. `LOG_LEVEL` defaults to `info`. Development uses
pretty output; production emits JSON.

Useful correlation fields:

- `jobId`
- `correlationId`
- `workerId`
- Kafka topic
- Service name

Centralize logs and retain correlation IDs across the complete job path.

## Distributed tracing

Set:

```dotenv
OTLP_ENDPOINT=http://jaeger:4318/v1/traces
```

The shared tracing module instruments HTTP, Redis, PostgreSQL, and Kafka libraries.
Validate trace volume and sampling before production; the current configuration does not
expose a documented sampling control.

## Queue and job operations

Inspect:

```bash
taskqueue queue stats
taskqueue job list --status RUNNING
taskqueue job list --status FAILED
taskqueue job get <job-id>
```

Cancel before execution:

```bash
taskqueue job cancel <job-id>
```

Retry a failed or dead job:

```bash
taskqueue job retry <job-id>
```

Manual retry preserves the job ID and resets its retry count. Ensure the handler is
idempotent before retrying a job that may have produced external side effects.

## Dead-letter queue procedure

1. List and filter entries:

   ```bash
   taskqueue dlq list --type email
   ```

2. Inspect the original error and payload.
3. Correct the underlying worker, dependency, or payload problem.
4. Requeue:

   ```bash
   taskqueue dlq requeue <entry-id>
   ```

DLQ requeue creates a new job ID and marks the entry as requeued.

## Cron operations

```bash
taskqueue cron list
taskqueue cron disable <cron-id>
```

Cron execution is polled by the single Scheduler instance. Monitor Scheduler availability
and PostgreSQL connectivity. Disabled cron rows remain in the database for auditability.

## Worker failure and orphan recovery

Workers:

- Refresh a heartbeat every five seconds with a 15-second TTL.
- Hold a per-job lock with a 60-second TTL.
- Extend locks every 15 seconds.
- Leave an in-flight processing marker while executing.

The reclaimer checks processing markers whose lock has disappeared and requeues cached
nonterminal jobs. Because at-least-once execution is possible, external side effects must
be idempotent.

## Backups

### PostgreSQL

PostgreSQL contains durable jobs, audit logs, DLQ entries, and cron definitions.

Example:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=taskqueue.dump
pg_restore --clean --if-exists --dbname="$DATABASE_URL" taskqueue.dump
```

Test restores regularly.

### Redis

Redis contains active queues, delayed jobs, locks, cached states, idempotency records, and
metrics counters. Configure persistence according to recovery requirements. A PostgreSQL
backup alone cannot reconstruct queued but unexecuted Redis jobs.

### Kafka

Set retention and replication according to expected outage and replay windows. The local
single-broker setup is not a production backup strategy.

## Graceful shutdown

Scheduler disconnects its consumer and closes timers on SIGTERM. Workers stop heartbeat and
reclaimer timers, but active work-loop shutdown is not fully drain-aware. Set a sufficient
Kubernetes termination grace period and test interruption behavior for long-running jobs.

## Incident checklist

### Queue is growing

1. Check worker count and pod health.
2. Check Redis connectivity.
3. Inspect worker errors and failure metrics.
4. Compare total worker concurrency with arrival rate.
5. Scale workers or reduce workload.

### Jobs remain PENDING

1. Check Kafka health and consumer lag.
2. Check State Manager and Scheduler logs.
3. Confirm topics exist.
4. Confirm the API uses the externally advertised Kafka broker.

### Jobs remain RUNNING

1. Check worker logs and lock keys.
2. Confirm Redis is available.
3. Wait for lock expiry and orphan recovery.
4. Verify the cached job state still exists.

### WebSocket updates are missing

1. Confirm the Notifier is consuming `job.state-change`.
2. Confirm the client subscribed to the correct job ID.
3. Check proxy WebSocket upgrade and idle-timeout configuration.
4. If multiple Notifier replicas are used, verify sticky routing/shared fan-out design.

### Metrics targets are down

1. Curl the service metrics endpoint directly.
2. Check Prometheus network/DNS reachability.
3. Confirm metrics ports match deployment configuration.
4. On local Docker, verify `host.docker.internal` resolution.
