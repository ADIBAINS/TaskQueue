# Deployment

TaskQueue includes a reusable multi-stage Dockerfile, a Helm chart, raw Kubernetes
manifests with Kustomize overlays, and a GitHub Actions workflow.

## Deployment model

The supplied deployment assets install TaskQueue application workloads only. They assume
the following names or configured endpoints already exist:

- Kafka
- Redis
- PostgreSQL

They do not install ingress, TLS certificates, DNS, Kafka, Redis, PostgreSQL, Prometheus
Operator, KEDA, or a secret-management controller.

## Build container images

The Dockerfile builds one service at a time:

```bash
docker build \
  --build-arg SERVICE_NAME=api-gateway \
  -t registry.example.com/taskqueue/api-gateway:1.0.0 .
```

Valid service names:

```text
api-gateway
scheduler
state-manager
notifier
metrics-exporter
worker-email
worker-image
worker-data
```

The CLI is distributed as an npm package/binary rather than an application container.

The image:

- Builds the shared package and selected service.
- Prunes development dependencies.
- Runs as the Node image's non-root `node` user.
- Includes migrations for the State Manager image.

Build every service before deployment. Use immutable tags such as a Git commit SHA.

## Infrastructure configuration

Application environment variables:

| Variable          | Used by                                          | Purpose                               |
| ----------------- | ------------------------------------------------ | ------------------------------------- |
| `KAFKA_BROKERS`   | API, Scheduler, State Manager, Notifier, Workers | Comma-separated broker list           |
| `REDIS_HOST`      | All runtime services                             | Redis hostname                        |
| `REDIS_PORT`      | All runtime services                             | Redis port                            |
| `DATABASE_URL`    | API, Scheduler, State Manager/migration          | PostgreSQL connection                 |
| `JWT_SECRET`      | API Gateway                                      | JWT verification secret               |
| `PORT`            | API, Notifier, Metrics Exporter                  | Listening port                        |
| `METRICS_PORT`    | Scheduler, State Manager, Workers                | Metrics port                          |
| `MAX_CONCURRENCY` | Workers                                          | Per-process job concurrency           |
| `OTLP_ENDPOINT`   | All traced services                              | OTLP HTTP traces endpoint             |
| `LOG_LEVEL`       | All services                                     | Pino log level                        |
| `NODE_ENV`        | All services                                     | Runtime mode                          |
| `MIGRATIONS_DIR`  | Migration runner                                 | Optional migration directory override |

Current Redis and Kafka clients support host/port or broker endpoints but do not expose TLS,
SASL, Redis username, or Redis TLS settings. Add these configuration paths before using
managed services that require them.

## Helm

### Prerequisites

- Kubernetes cluster
- Helm 3
- Existing Kafka, Redis, and PostgreSQL
- KEDA CRDs when `keda.enabled=true`

The chart does not currently create an Ingress.

### Configure values

Create a production values file:

```yaml
image:
  repository: ghcr.io/example/taskqueue
  tag: '<commit-sha>'
  pullPolicy: IfNotPresent

infrastructure:
  kafka:
    brokers: 'kafka.example.internal:9092'
  redis:
    host: 'redis.example.internal'
    port: 6379
  postgres:
    url: 'postgresql://taskqueue:REPLACE@postgres.example.internal:5432/taskqueue'

auth:
  jwtSecret: 'REPLACE'

keda:
  enabled: true
```

The repository prefixes each image with the service name, for example:

```text
ghcr.io/example/taskqueue/api-gateway:<tag>
ghcr.io/example/taskqueue/worker-email:<tag>
```

Do not commit production credentials in a values file. The current chart renders a normal
Kubernetes Secret from values. Prefer External Secrets, Sealed Secrets, SOPS, or your
platform's secret injection mechanism.

### Validate and deploy

```bash
helm lint ./helm/taskqueue
helm template taskqueue ./helm/taskqueue -f values-production.yaml

helm upgrade --install taskqueue ./helm/taskqueue \
  --namespace taskqueue-production \
  --create-namespace \
  -f values-production.yaml
```

The State Manager deployment runs migrations in an init container before starting.

Disable KEDA when its CRDs are unavailable:

```bash
helm upgrade --install taskqueue ./helm/taskqueue \
  --namespace taskqueue \
  --create-namespace \
  --set keda.enabled=false
```

## Kustomize

The raw manifests use:

- `taskqueue/*:latest` images
- Service names `kafka`, `redis`, and `postgres`
- An example plaintext secret
- KEDA `ScaledObject` resources
- A Prometheus Operator `ServiceMonitor`

Before applying them, customize image names and secrets. For example, create an additional
overlay or use:

```bash
cd k8s/overlays/production
kustomize edit set image \
  taskqueue/api-gateway=ghcr.io/example/taskqueue/api-gateway:<sha>
```

Review the rendered manifests:

```bash
kubectl kustomize k8s/overlays/production
kubectl apply --dry-run=server -k k8s/overlays/production
kubectl apply -k k8s/overlays/production
```

The namespace must exist unless your delivery system creates it:

```bash
kubectl create namespace taskqueue-production
```

## Database migration

Helm and the supplied State Manager manifest run:

```text
node services/state-manager/dist/run-migrate.js
```

The custom runner:

- Creates the migration tracking table.
- Applies ordered `.sql` files transactionally.
- Records each filename once.

For manual execution:

```bash
docker run --rm \
  -e DATABASE_URL="$DATABASE_URL" \
  registry.example.com/taskqueue/state-manager:<tag> \
  node services/state-manager/dist/run-migrate.js
```

Back up PostgreSQL before schema changes.

## Exposure and routing

Typical cluster exposure:

- API Gateway: HTTP service exposed through an authenticated TLS ingress
- Notifier: WebSocket-capable ingress with appropriate idle timeouts
- Metrics endpoints: cluster-internal only
- Worker and Scheduler services: cluster-internal metrics only

Do not expose Redis, Kafka, PostgreSQL, or worker metrics publicly.

## Autoscaling

Worker KEDA objects scale from Redis list lengths:

```text
queue:email
queue:image
queue:data
```

Tune `minReplicas`, `maxReplicas`, queue threshold, and worker `maxConcurrency` together.
Total theoretical concurrency is:

```text
replicas × MAX_CONCURRENCY
```

Keep the Scheduler at one replica unless leader election or queue partitioning is added.

## CI/CD workflow

On pull requests:

1. Install dependencies.
2. Type-check.
3. Run tests.

On pushes to `main`:

1. Run validation.
2. Build and push eight service images to GHCR.
3. Trigger an ArgoCD staging sync.
4. Trigger production sync after the configured GitHub environment gate.

Required GitHub configuration:

- Package write permission for `GITHUB_TOKEN`
- `ARGOCD_URL`
- `ARGOCD_TOKEN`
- ArgoCD applications named `taskqueue-staging` and `taskqueue-production`

The workflow only triggers ArgoCD. It does not update Git manifests with the new SHA.
Configure ArgoCD Image Updater or another image-tag promotion mechanism, otherwise the
cluster may continue using the tag declared in Git.

## Production readiness checklist

- [ ] Real worker integrations replace simulations.
- [ ] Immutable image tags are used.
- [ ] PostgreSQL backups and restore tests exist.
- [ ] Kafka and Redis are highly available and monitored.
- [ ] Secrets are externalized and rotated.
- [ ] TLS/authentication are implemented for Kafka, Redis, and PostgreSQL.
- [ ] API and WebSocket ingress use TLS.
- [ ] Webhook URLs are restricted and protected against SSRF.
- [ ] NetworkPolicies restrict east-west access.
- [ ] PodDisruptionBudgets and topology spread are configured.
- [ ] Resource requests/limits are load-tested.
- [ ] Scheduler single-replica behavior is accepted or redesigned.
- [ ] Notifier multi-replica subscription behavior is addressed.
- [ ] Alerting and on-call procedures are defined.
- [ ] Disaster recovery is tested.
