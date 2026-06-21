# Architecture

## System overview

TaskQueue separates request handling, scheduling, execution, persistence, notification, and
metrics into independently deployable processes.

```text
CLI / REST clients
        |
        v
API Gateway :3000
        |
        | job.submitted
        v
      Kafka ------------------------------+
        |                                  |
        v                                  |
Scheduler :3200                            |
  | priority heap                          |
  | Redis delayed set                      |
  v                                        |
Redis lists: queue:email/image/data        |
  |                                        |
  v                                        |
Workers :3600-3602                         |
  | job.completed / job.failed             |
  +---------------------> Kafka            |
                              |             |
                              v             |
                       State Manager :3300  |
                       PostgreSQL + Redis   |
                              |             |
                              | state-change|
                              +------> Kafka+
                                        |
                                        v
                                 Notifier :3400
                                 WebSocket/webhook
```

The Metrics Exporter on port 3500 reads aggregate counters and queue depths from Redis.
Scheduler, State Manager, and each worker also expose process-specific Prometheus metrics.

## Component responsibilities

### API Gateway

- Accepts REST requests.
- Verifies JWTs on mutating and administrative endpoints.
- Applies request-size limits, Helmet, CORS, and rate limiting.
- Publishes submitted jobs and requested state changes to Kafka.
- Reads fast job state from Redis.
- Reads job lists, cron definitions, and DLQ entries from PostgreSQL.

### Scheduler

- Consumes `job.submitted`.
- Stores immediate jobs in an in-memory binary min-heap.
- Stores delayed and retry jobs in a Redis sorted set.
- Moves ready jobs into per-type Redis lists.
- Consumes failed state changes to schedule retries.
- Polls PostgreSQL for due cron jobs and publishes normal job submissions.
- Removes cancelled jobs from known scheduler and worker queues.

The priority heap is process-local. The scheduler deployment therefore runs one replica in
the supplied manifests. Running multiple scheduler replicas requires partitioning or
leader election.

### Workers

Each worker process:

- Blocks on its Redis list with `BLPOP`.
- Limits parallel jobs with an async semaphore.
- Acquires a Redis owner lock before executing a job.
- Extends the lock while the job runs.
- Publishes RUNNING, completed, or failed events.
- Sends a heartbeat every five seconds.
- Detects processing markers whose locks expired and safely requeues them.

The included worker execution functions simulate domain work.

### State Manager

- Creates durable job records on submission.
- Persists lifecycle transitions in PostgreSQL.
- Maintains a one-hour Redis cache for fast status lookup.
- Increments retry counts on failed and dead transitions.
- Adds terminal failures to the DLQ.
- Writes an audit-log record for each persisted state transition.

PostgreSQL is the durable source of truth. Redis is the low-latency state and queue layer.

### Notifier

- Consumes `job.state-change`.
- Maintains in-memory WebSocket subscriptions by job ID.
- Sends state changes to subscribed clients.
- Delivers an HTTP webhook on SUCCESS, FAILED, or DEAD when a job has `webhookUrl`.

Subscriptions are process-local. Multiple notifier replicas require sticky routing or a
shared subscription/fan-out layer for complete delivery semantics.

## Kafka topics

| Topic              | Producers                                          | Consumers                          | Purpose                                 |
| ------------------ | -------------------------------------------------- | ---------------------------------- | --------------------------------------- |
| `job.submitted`    | API, CLI through API, scheduler cron, job chaining | Scheduler, State Manager           | New or manually retried job             |
| `job.scheduled`    | Scheduler                                          | none in current code               | Scheduling observation event            |
| `job.assigned`     | Scheduler                                          | none in current code               | Worker-queue assignment event           |
| `job.completed`    | Workers                                            | State Manager                      | Successful execution                    |
| `job.failed`       | Workers, Scheduler                                 | State Manager                      | Failed execution                        |
| `job.state-change` | Workers, State Manager, API                        | Scheduler, State Manager, Notifier | Lifecycle coordination and notification |

Kafka messages use the job ID as their key, preserving per-job partition ordering within a
topic.

## Storage model

### PostgreSQL

The migration creates:

- `jobs` — durable job definition and current state
- `workers` — worker metadata schema; current workers primarily use Redis heartbeats
- `audit_log` — persisted state-transition history
- `dlq` — terminal failures available for requeue
- `cron_jobs` — recurring job definitions
- `migrations` — applied migration tracking

### Redis

Important keys:

| Pattern                 | Type        | Purpose                              |
| ----------------------- | ----------- | ------------------------------------ |
| `queue:<type>`          | List        | FIFO worker queue                    |
| `delayed:scheduler`     | Sorted set  | Scheduled and retry jobs             |
| `job:state:<id>`        | String/JSON | Fast job state cache                 |
| `idempotency:<key>`     | String/JSON | 24-hour submission deduplication     |
| `lock:job:<id>`         | String      | Worker owner lock                    |
| `processing:job:<id>`   | String      | In-flight marker for orphan recovery |
| `heartbeat:<worker-id>` | String      | Worker liveness with TTL             |
| `metrics:<type>:*`      | Strings     | Counters and durations               |

## Job lifecycle

```text
PENDING
  | immediate
  v
QUEUED -----------> RUNNING -----------> SUCCESS
  ^                    |
  |                    v
  |                  FAILED
  |                    |
  | retry budget       | exhausted
  +---- SCHEDULED <----+-----------> DEAD ---> DLQ

PENDING / SCHEDULED / QUEUED ---> CANCELLED
```

Delayed submissions enter SCHEDULED before dispatch. Retry delays use the same delayed
queue.

## Priorities and ordering

Priority values range from 1 to 5; 1 is highest. The scheduler heap orders jobs by priority.
Once jobs reach a worker-type Redis list, that list is FIFO. Equal-priority ordering in the
heap is not guaranteed to be stable.

## Retry behavior

The retry delay is approximately:

```text
1000ms × 2^retryCount + random(0..500ms)
```

The State Manager increments `retryCount` after execution failure. When the configured
`maxRetries` is reached, the job transitions to DEAD and is copied to the DLQ.

## Delivery semantics

The system aims for at-least-once execution:

- Kafka can redeliver messages.
- A worker can fail after performing side effects but before publishing completion.
- An expired worker lock can cause requeue.

Production handlers must therefore be idempotent. Use external idempotency keys around
irreversible side effects such as charging a card or sending a message.

## Scaling constraints

- Workers scale horizontally; KEDA definitions use Redis list length.
- The API Gateway and Metrics Exporter are stateless enough to replicate.
- The supplied Scheduler should remain single-replica because of its in-memory heap.
- WebSocket subscriptions are local to a Notifier process.
- Redis `KEYS` is used in some liveness/metrics paths and should be replaced with `SCAN` for
  very large keyspaces.

These constraints should be addressed before high-scale production use.
