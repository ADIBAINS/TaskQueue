# Kubernetes base

The base contains TaskQueue application Deployments and Services, an API HPA, worker KEDA
ScaledObjects, a metrics ServiceMonitor, configuration, and an example Secret.

It does not install Kafka, Redis, PostgreSQL, ingress, KEDA, or Prometheus Operator.

Before applying:

1. Replace all `taskqueue/*:latest` images.
2. Replace `taskqueue-secrets`; never use the example JWT or database credentials.
3. Ensure services named `kafka`, `redis`, and `postgres` exist or update configuration.
4. Install KEDA and Prometheus Operator CRDs, or remove their custom resources.

Render with:

```bash
kubectl kustomize k8s/base
```

See [Deployment](../../docs/DEPLOYMENT.md) for production guidance.
