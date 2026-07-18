# Kubernetes deployment

These JSON documents are valid Kubernetes manifests and intentionally leave the
PostgreSQL and resource Adapter deployments to their owning teams. Before use,
replace every `replace-*` value, create `sdar-adapter-mtls` with `ca.pem`,
`tls.crt`, and `tls.key`, and create `sdar-runtime-secrets` through the cluster's
secret manager. `secret.example.json` is a shape example and must not be applied
unchanged.

Telemetry remains disabled in the ConfigMap by default. Before enabling it, create
`sdar-otel-headers` from `otel-headers-secret.example.json` and `sdar-otel-mtls` from
`otel-tls-secret.example.json` through the cluster secret manager. The Deployment mounts them as
files at the paths named by the ConfigMap; collector credentials must not be copied into the
ConfigMap or ordinary environment variables.

Apply the namespace and service account first, then configuration/secrets, and
finally the Deployment, Service, PodDisruptionBudget and NetworkPolicy. The
Deployment runs two non-root replicas; PostgreSQL advisory locks and row claims
coordinate scheduler/recovery work across them.

```bash
pnpm deployment:check
kubectl apply -f deploy/kubernetes/namespace.json
kubectl apply -f deploy/kubernetes/service-account.json
kubectl apply -f deploy/kubernetes/config-map.json
kubectl apply -f deploy/kubernetes/deployment.json
kubectl apply -f deploy/kubernetes/service.json
kubectl apply -f deploy/kubernetes/pod-disruption-budget.json
kubectl apply -f deploy/kubernetes/network-policy.json
kubectl -n sdar-system rollout status deployment/sdar-runtime
```
