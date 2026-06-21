# CLI guide

The TaskQueue CLI is the primary user and operator interface. Its package is
`@taskqueue/cli`, and its installed executable names are `taskqueue` and `tq`.

## Run or install

Run from the repository:

```bash
pnpm taskqueue --help
```

Build and link globally:

```bash
pnpm --filter @taskqueue/cli build
cd services/cli
npm link
taskqueue --version
```

## Global options

| Option             | Purpose                            |
| ------------------ | ---------------------------------- |
| `--profile <name>` | Select a saved profile             |
| `--api-url <url>`  | Override the profile API URL       |
| `--ws-url <url>`   | Override the profile WebSocket URL |
| `--token <jwt>`    | Override the saved JWT             |
| `--json`, `-j`     | Pretty JSON output                 |
| `--quiet`, `-q`    | Suppress successful output         |
| `--help`, `-h`     | Command help                       |
| `--version`, `-v`  | CLI version                        |

When stdout is not a terminal, results are emitted as compact JSON even without `--json`.

## Configuration precedence

Highest priority first:

1. Command-line overrides
2. Environment variables
3. Selected profile
4. Defaults

Supported variables:

```text
TASKQUEUE_CONFIG
TASKQUEUE_PROFILE
TASKQUEUE_API_URL
TASKQUEUE_WS_URL
TASKQUEUE_TOKEN
```

The default config path is `~/.config/taskqueue/config.json`. The CLI writes it with mode
`0600`. Tokens are stored as plaintext in that user-only file; use environment variables or
an external secret mechanism if local token storage is not acceptable.

## Profiles

```bash
taskqueue profile list
taskqueue profile use local
taskqueue profile delete staging
```

Configure profile values:

```bash
taskqueue config list
taskqueue config set api-url http://localhost:3000
taskqueue config set ws-url ws://localhost:3400
taskqueue config get api-url
taskqueue config unset ws-url
```

If no WebSocket URL is configured, the CLI derives it from the API URL. For the default
local API port 3000, it uses WebSocket port 3400.

## Authentication

Create a JWT locally using the same secret as the API Gateway:

```bash
taskqueue auth login --secret "$JWT_SECRET"
taskqueue auth login --secret "$JWT_SECRET" --client deploy-script --expires-in 1h
```

Save an externally issued JWT:

```bash
taskqueue auth token '<jwt>'
```

Inspect or clear authentication:

```bash
taskqueue auth status
taskqueue auth logout
```

`auth login` is a local development convenience. In production, tokens should normally be
issued by an identity service rather than distributing the signing secret to users.

## Jobs

### List

```bash
taskqueue job list
taskqueue job list --type image --status FAILED --limit 100
```

Status values are PENDING, SCHEDULED, QUEUED, RUNNING, SUCCESS, FAILED, DEAD, and
CANCELLED.

### Submit

```bash
taskqueue job submit email \
  --priority 1 \
  --max-retries 3 \
  --payload '{"to":"user@example.com","subject":"Hello","body":"Message"}'
```

Payload sources:

```bash
taskqueue job submit data --payload-file payload.json
cat payload.json | taskqueue job submit data --payload-file -
```

Scheduling and delivery controls:

```bash
taskqueue job submit data \
  --schedule '<future-iso-8601-timestamp>' \
  --idempotency-key cleanup-run-001 \
  --webhook https://example.com/taskqueue-events \
  --payload '{"operation":"cleanup"}'
```

Job chaining:

```bash
taskqueue job submit data \
  --payload '{"operation":"export","limit":1000}' \
  --on-success '{"nextJobType":"email","payload":{"to":"ops@example.com","subject":"Done","body":"Export complete"},"priority":3}'
```

`--on-success` and `--on-failure` accept JSON objects with `nextJobType`, `payload`, and
`priority`.

### Inspect and control

```bash
taskqueue job get <job-id>
taskqueue job watch <job-id>
taskqueue job watch <job-id> --timeout 120
taskqueue job cancel <job-id>
taskqueue job retry <job-id>
```

Cancellation is allowed only before execution: PENDING, SCHEDULED, or QUEUED. Manual retry
is allowed for FAILED or DEAD jobs.

`job watch` first checks current state, then subscribes over WebSocket. It exits on SUCCESS,
FAILED, DEAD, or CANCELLED.

## Queues

```bash
taskqueue queue stats
taskqueue queue stats --json
```

The output contains queue depth and cumulative enqueue/failure counters. Some rate and
processing values are approximate because they are derived from Redis counters.

## Cron jobs

```bash
taskqueue cron list

taskqueue cron create nightly-cleanup '0 2 * * *' data \
  --priority 5 \
  --payload '{"operation":"cleanup"}'

taskqueue cron disable <cron-id>
```

Cron expressions are interpreted by `cron-parser` using the service process timezone.
Production deployments should set and document a consistent timezone, normally UTC.

## Dead-letter queue

```bash
taskqueue dlq list
taskqueue dlq list --type email
taskqueue dlq requeue <entry-id>
```

Requeue creates a new job ID and marks the DLQ entry as requeued.

## Health and completion

```bash
taskqueue health

taskqueue completion bash
taskqueue completion zsh
taskqueue completion fish
```

Example Bash installation:

```bash
taskqueue completion bash > ~/.local/share/bash-completion/completions/taskqueue
```

## Automation and exit codes

Use `--json` and inspect the process exit code.

| Code | Meaning                                 |
| ---: | --------------------------------------- |
|    0 | Success                                 |
|    1 | Network, server, or general error       |
|    2 | Invalid command or arguments            |
|    3 | Resource not found                      |
|    4 | Authentication or authorization failure |

Example:

```bash
job_id="$(
  taskqueue job submit data \
    --payload '{"operation":"cleanup"}' \
    --json | jq -r '.job.id'
)"

taskqueue job get "$job_id" --json
```
