# Deployment

TaskQueue includes a reusable multi-stage Dockerfile, a Helm chart, raw Kubernetes
manifests with Kustomize overlays, and a GitHub Actions workflow.

## Recommended public demo: one Ubuntu VM

For the current application, the recommended public-demo deployment is one Ubuntu VM
running `docker-compose.production.yml`.

Recommended minimum:

- Ubuntu 24.04 LTS
- 4 vCPU
- 8 GB RAM
- 80 GB SSD
- A non-root deployment user
- Two DNS records:
  - `api.example.com` for the REST API
  - `ws.example.com` for WebSockets

This model keeps Kafka, Redis, PostgreSQL, metrics, and dashboards on a private Docker
network while Caddy exposes only HTTPS API and WebSocket endpoints.

### 1. Point DNS at the server

Create A/AAAA records for the API and WebSocket names before the first deployment. Caddy
must be able to complete ACME validation over ports 80 and 443.

### 2. Provision the host

Copy the repository's provisioning script to the server and run it as root:

```bash
DEPLOY_USER=deploy sudo -E bash deploy/scripts/provision-ubuntu.sh
```

The script:

- Installs Docker Engine and Compose from Docker's Ubuntu repository.
- Installs rsync and automatic security updates.
- Creates the deployment user if necessary.
- Creates `/opt/taskqueue` and `/var/backups/taskqueue`.
- Enables UFW and permits only SSH, HTTP, HTTPS, and HTTP/3.

Log out and reconnect after provisioning so Docker group membership is applied.

### 3. Create the production environment

On the server:

```bash
cd /opt/taskqueue
cp deploy/.env.production.example .env.production
chmod 600 .env.production

openssl rand -hex 32 # POSTGRES_PASSWORD
openssl rand -hex 32 # JWT_SECRET
openssl rand -hex 32 # GRAFANA_ADMIN_PASSWORD
```

Edit `.env.production`:

```dotenv
IMAGE_REPOSITORY=ghcr.io/OWNER/REPOSITORY
IMAGE_TAG=<commit-sha>
API_DOMAIN=api.example.com
WS_DOMAIN=ws.example.com
ACME_EMAIL=ops@example.com
POSTGRES_PASSWORD=<random-hex>
JWT_SECRET=<random-hex>
GRAFANA_ADMIN_PASSWORD=<random-hex>
```

`IMAGE_REPOSITORY` is the path before the service suffix. The Compose stack pulls images
such as `${IMAGE_REPOSITORY}/api-gateway:${IMAGE_TAG}`.

### 4. Perform the first deployment

Copy these repository paths to `/opt/taskqueue`:

```text
docker-compose.production.yml
deploy/
config/
```

If GHCR packages are private:

```bash
printf '%s' "$GHCR_TOKEN" | \
  docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
```

Deploy an immutable image tag:

```bash
chmod +x /opt/taskqueue/deploy/scripts/*.sh
/opt/taskqueue/deploy/scripts/deploy.sh <commit-sha>
```

The deployment script:

1. Saves the previous image tag.
2. Pulls application and infrastructure images.
3. Starts PostgreSQL, Redis, Kafka, and Jaeger.
4. Runs database migrations.
5. Starts application services, Prometheus, Grafana, and Caddy.
6. Polls the public HTTPS health endpoint.
7. Restores the previous image tag when health verification fails.

Migrations are not automatically reversed during rollback. Schema changes must remain
backward compatible with the previous application release.

### 5. Verify public and private exposure

Public:

```bash
curl https://api.example.com/health
```

Configure the CLI:

```bash
taskqueue profile use demo
taskqueue config set api-url https://api.example.com
taskqueue config set ws-url wss://ws.example.com
taskqueue auth token '<jwt>'
taskqueue health
```

Operational tools bind to `127.0.0.1` and are available through an SSH tunnel:

```bash
ssh \
  -L 3001:127.0.0.1:3001 \
  -L 9090:127.0.0.1:9090 \
  -L 16686:127.0.0.1:16686 \
  deploy@server
```

Then open:

- Grafana: http://localhost:3001
- Prometheus: http://localhost:9090
- Jaeger: http://localhost:16686

Do not publish ports 2181, 5432, 6379, 9092, 29092, 3001, 9090, 16686, or service metrics
ports through the cloud firewall.

### 6. Enable nightly backups

After deployment assets exist on the server:

```bash
sudo cp deploy/systemd/taskqueue-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now taskqueue-backup.timer
systemctl list-timers taskqueue-backup.timer
```

Backups are written to `/var/backups/taskqueue`, compressed, mode `0600`, and retained for
seven days by default. Copy them to off-host storage for actual disaster recovery.

Test a backup immediately:

```bash
sudo systemctl start taskqueue-backup.service
sudo journalctl -u taskqueue-backup.service
```

### 7. Manual rollback

Rollback to the automatically recorded previous tag:

```bash
/opt/taskqueue/deploy/scripts/rollback.sh
```

Or specify a known image tag:

```bash
/opt/taskqueue/deploy/scripts/rollback.sh <commit-sha>
```

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

The workflow in `.github/workflows/ci-cd.yml` targets the single-VM demo deployment.

On pull requests and pushes:

1. Install dependencies.
2. Type-check.
3. Run tests.
4. Run formatting checks.
5. Build every workspace package.
6. Validate the production Compose file.

On pushes to `main`:

1. Build and push eight service images to GHCR with the commit SHA and `latest`.
2. Upload production Compose, Caddy, monitoring, and deployment scripts to the VM.
3. Authenticate the VM to GHCR.
4. Run the health-checked deployment script with the immutable SHA.

Required GitHub configuration:

| Secret             | Purpose                               |
| ------------------ | ------------------------------------- |
| `DEMO_HOST`        | VM hostname or IP                     |
| `DEMO_USER`        | Deployment user, normally `deploy`    |
| `DEMO_SSH_PORT`    | SSH port; use `22` when unchanged     |
| `DEMO_SSH_KEY`     | Private deploy key                    |
| `DEMO_KNOWN_HOSTS` | Trusted `known_hosts` line for the VM |
| `GHCR_USERNAME`    | Account used by the VM to pull images |
| `GHCR_TOKEN`       | Token with `read:packages`            |

Create a protected GitHub environment named `demo` to require approval or restrict the
deployment branch. Add repository variable `ENABLE_DEMO_DEPLOY=true` only after the VM,
DNS, server environment file, and deployment secrets are configured. Until then, image
builds run and the VM deployment job is skipped.

Generate `DEMO_KNOWN_HOSTS` from a trusted network and verify its fingerprint before saving
it:

```bash
ssh-keyscan -p 22 server.example.com
```

The server's `/opt/taskqueue/.env.production` is never uploaded or replaced by CI.

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
