# API reference

Base URL for local development: `http://localhost:3000`.

## Authentication

Protected endpoints require:

```http
Authorization: Bearer <jwt>
```

The API verifies HMAC JWTs with `JWT_SECRET`. There is no token-issuing HTTP endpoint.
Use the CLI development login command or integrate an external issuer that uses the same
verification configuration.

Protected endpoints:

- `GET /jobs`
- `POST /jobs`
- `POST /jobs/:id/cancel`
- `POST /jobs/:id/retry`
- All `/cron` endpoints
- All `/dlq` endpoints

`GET /jobs/:id`, `GET /queues/stats`, and `GET /health` are currently public.

## Jobs

### `POST /jobs`

Submit a job.

```json
{
  "type": "email",
  "priority": 1,
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome",
    "body": "Hello"
  },
  "idempotencyKey": "welcome-user-123",
  "maxRetries": 3,
  "scheduledAt": null,
  "webhookUrl": null,
  "onSuccess": null,
  "onFailure": null
}
```

Fields:

| Field            | Required | Rules                                            |
| ---------------- | -------- | ------------------------------------------------ |
| `type`           | yes      | `email`, `image`, or `data`                      |
| `priority`       | no       | Integer 1–5; default 3; lower is higher priority |
| `payload`        | no       | JSON object; default `{}`                        |
| `idempotencyKey` | no       | Deduplicates submissions for 24 hours            |
| `maxRetries`     | no       | Integer 0–100; default 3                         |
| `scheduledAt`    | no       | ISO-8601 date/time                               |
| `webhookUrl`     | no       | HTTP(S) callback target                          |
| `onSuccess`      | no       | Chained-job definition                           |
| `onFailure`      | no       | Chained-job definition                           |

Chained-job definition:

```json
{
  "nextJobType": "data",
  "payload": { "operation": "cleanup" },
  "priority": 3
}
```

Success returns HTTP 201. A duplicate idempotency key returns HTTP 200 with
`"deduplicated": true`.

### `GET /jobs`

List recent jobs from PostgreSQL.

Query parameters:

| Parameter | Values                   |
| --------- | ------------------------ |
| `type`    | `email`, `image`, `data` |
| `status`  | Any job status           |
| `limit`   | 1–200; default 50        |

Returns database rows in PostgreSQL column naming, such as `created_at` and
`retry_count`.

### `GET /jobs/:id`

Reads the Redis state cache and returns:

```json
{ "job": { "id": "...", "status": "RUNNING" } }
```

Cached job state expires after one hour. The durable row remains in PostgreSQL and is
visible through `GET /jobs`; direct ID lookup currently does not fall back to PostgreSQL.

### `POST /jobs/:id/cancel`

Cancels a PENDING, SCHEDULED, or QUEUED job. Returns HTTP 409 if execution already started
or the job is terminal.

### `POST /jobs/:id/retry`

Retries a FAILED or DEAD job with the same ID and resets its retry count.

## Queue statistics

### `GET /queues/stats`

Returns one entry for each worker type:

```json
{
  "queues": [
    {
      "queueName": "email",
      "depth": 0,
      "processing": 0,
      "failed": 2,
      "enqueueRate": 12,
      "dequeueRate": 0
    }
  ]
}
```

The fields named `enqueueRate` and `dequeueRate` are cumulative counters in the current
implementation, not time-normalized rates.

## Cron jobs

### `GET /cron`

Lists cron definitions.

### `POST /cron`

```json
{
  "name": "hourly-cleanup",
  "cronExpression": "0 * * * *",
  "jobType": "data",
  "payload": { "operation": "cleanup" },
  "priority": 5
}
```

Cron names must be unique. Invalid expressions return HTTP 500 in the current
implementation rather than a dedicated validation status.

### `DELETE /cron/:id`

Disables the cron definition; it does not delete the row.

## Dead-letter queue

### `GET /dlq`

Lists up to 100 unrequeued entries. Optional query: `?type=email`.

### `POST /dlq/:id/requeue`

Marks the DLQ entry as requeued and submits a new job with a new ID.

## Health

### `GET /health`

```json
{
  "status": "ok",
  "service": "api-gateway",
  "uptime": 123.45
}
```

This is a process health endpoint. It does not currently verify Kafka, Redis, or
PostgreSQL connectivity.

## WebSocket protocol

Connect to `ws://localhost:3400`. An optional `x-client-id` header identifies the
connection.

Subscribe:

```json
{ "type": "subscribe", "jobId": "<uuid>" }
```

Unsubscribe:

```json
{ "type": "unsubscribe", "jobId": "<uuid>" }
```

Update:

```json
{
  "type": "job_update",
  "jobId": "<uuid>",
  "previousStatus": "RUNNING",
  "newStatus": "SUCCESS",
  "timestamp": "2026-06-21T00:00:00.000Z"
}
```

The WebSocket server does not currently authenticate subscriptions.

## Worker payloads

### Email

```json
{
  "to": "user@example.com",
  "subject": "Subject",
  "body": "Body",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"],
  "template": "Hello {{name}}",
  "templateData": { "name": "Sam" }
}
```

Required: `to`, `subject`. Delivery is simulated.

### Image

```json
{
  "url": "https://example.com/image.jpg",
  "width": 800,
  "height": 600,
  "format": "webp",
  "quality": 80,
  "operations": ["resize"]
}
```

Required: `url`. Supported formats: jpeg, png, webp, avif. Processing is simulated.

### Data

```json
{
  "operation": "aggregate",
  "dataset": "sales",
  "filters": { "region": "west" },
  "aggregation": "sum"
}
```

Supported operations:

| Operation   | Additional requirements |
| ----------- | ----------------------- |
| `aggregate` | `dataset`               |
| `transform` | `dataset`, `query`      |
| `validate`  | none                    |
| `export`    | optional `limit`        |
| `cleanup`   | none                    |

All data operations are simulated.

## Error format

REST errors generally return:

```json
{ "error": "Description" }
```

Common statuses are 400, 401, 404, 409, 429, 500, and 501.
