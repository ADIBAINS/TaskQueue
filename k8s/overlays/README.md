# Kubernetes overlays

- `staging` sets application image pull policy to `Always`.
- `production` sets it to `IfNotPresent` and increases API HPA bounds.

The overlays do not replace images, credentials, or infrastructure endpoints. Add
environment-owned patches before applying them.

```bash
kubectl kustomize k8s/overlays/staging
kubectl kustomize k8s/overlays/production
```

See [Deployment](../../docs/DEPLOYMENT.md).
