# genosyn Helm chart

The official chart for [Genosyn](https://genosyn.com) — one container, one
volume, Postgres. It runs Genosyn single-tenant: one organization per install
(see [One organization per install](#one-organization-per-install)), with a
one-file SQLite variant (`values-selfhost.yaml`). Published as an OCI artifact
alongside every release, and listed on
[Artifact Hub](https://artifacthub.io/packages/search?ts_query_web=genosyn).

## Quickstart

For Genosyn's test and production SaaS environments, use the root
`npm run deploy-test` and `npm run deploy-prod` commands with the private,
Git-ignored files `Helm/Values/test.values.yaml` and
`Helm/Values/prod.values.yaml`. The
[environment guide](../Values/README.md) covers Kubernetes contexts, namespaces, TLS,
database Secrets, offline previews, and public URL initialization.
Production also runs Genosyn Connect, the hosted sign-in service, and routes
`connect.genosyn.com` to it on the same Ingress; see
[Genosyn Connect](#genosyn-connect) and the [operator guide](../../Connect/README.md).

A bare `helm install` works: bundled Postgres, one replica, a 20Gi data
volume, and chart-generated strong secrets. For real use, front it with an
HTTPS Ingress and name the operator:

```bash
helm install genosyn oci://ghcr.io/genosyn/charts/genosyn \
  --namespace genosyn --create-namespace \
  --set config.bootstrapMasterAdminEmail=ops@example.com \
  --set ingress.enabled=true \
  --set ingress.host=genosyn.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=genosyn-tls
```

The pod becomes Ready once every migration has run (`/api/health` answers
only after boot completes). The default install runs the **bundled evaluation
Postgres**; real production should operate its own (managed instance,
CloudNativePG, an operator) and point `config.db.postgresUrlSecret` at it
with `postgres.enabled=false`.

**The first master admin.** Register the `config.bootstrapMasterAdminEmail`
address and open its verification link: it becomes master admin at once.
Without that value, no account is promoted until the App restarts. Either
way, every App start with no master admin promotes the earliest registered
account, and sign-ups are open by default — so claim the account before
sharing the address.

**The public URL.** Email links, OAuth callbacks, and Secure session cookies
follow the public URL stored in the database. On Postgres, a post-install and
post-upgrade Job stores `https://<ingress.host>` (or `config.publicUrl`) with
the App's first-write-only setup script; an origin later changed at
**Admin → General** is kept, and the upgrade continues. Session cookies are
then Secure, so sign in through the Ingress, not a plain `http://`
port-forward. Without an HTTPS Ingress or `config.publicUrl`, or on SQLite,
the first master admin's sign-in records its browser origin. To set it from
the container instead:

```bash
kubectl -n genosyn exec deploy/genosyn -c app -- \
  node /app/dist/server/scripts/setupPublicUrl.js --url https://genosyn.example.com
```

**System SMTP is not a chart value.** Configure the mail transport after boot
at **Admin → Email transport**, where it is stored encrypted in the database.
Until it is set, boot prints a warning and every system mail — including the
master admin's own verification link — goes to the pod log:

```bash
kubectl logs -n genosyn deploy/genosyn
```

Paste that link into the browser to verify and claim the master-admin
account, then set SMTP up from the dashboard.

### SQLite instead of Postgres

[`values-selfhost.yaml`](./values-selfhost.yaml) keeps the database in SQLite
on the data volume, with no bundled Postgres — the shape of the one-line
Docker installer:

```bash
helm pull oci://ghcr.io/genosyn/charts/genosyn --untar
helm install genosyn ./genosyn \
  --namespace genosyn --create-namespace \
  -f genosyn/values-selfhost.yaml
```

## One organization per install

AI Employee commands run inside the App container as the App user (`node`,
uid 1000), with that user's filesystem and network authority. There is no OS
sandbox, so commands can reach every company's data in the install. Give each
unrelated organization its own install. The chart refuses
`config.multiTenant=true` and `sandbox.enabled=true`.

Keep `replicaCount` at 1. Repository work (its Git lock and running work
sessions), ChatGPT subscription models, and Member browsers each depend on
state held in one App process, so more than one replica is not supported for
them.

## Cluster compatibility

The chart renders standard Kubernetes resources: Deployments, Services,
ConfigMaps, Secrets, PersistentVolumeClaims, a Job, an optional StatefulSet,
and an optional `networking.k8s.io/v1` Ingress. By default it has no
cloud-specific resources or annotations; the opt-in [GKE](#gke) and
[cert-manager](#tls-with-cert-manager) settings below add theirs. Use a
Kubernetes context with access to the chosen namespace; the chart does not
create a cluster or install an ingress controller or cert-manager.

Select an installed controller through `ingress.className`, or leave it empty
for the cluster's default. Supply TLS Secrets for the enabled hostnames.
`ingress.annotations` and `service.annotations` pass through settings for your
chosen controller and load balancer. Configure WebSocket upgrades, timeouts
long enough for streamed replies, and response buffering there or in the
controller itself; the standard Ingress API has no portable timeout field.
Configure ingress and load-balancer access logs to omit query strings because
OAuth callbacks contain short-lived authorization codes. The App's standard
readiness and liveness probes use `/api/health` on port 8471; any external
load-balancer health probe is the operator's responsibility.

The default assumes one trusted ingress proxy (`trustedProxyHops: 1`;
`gke.enabled` sets 2 for Google's load balancer). Match this count to your
actual proxy chain through `config.extraJs`, and prevent direct untrusted
access around those proxies. Choose `persistence.storageClass`
and `postgres.persistence.storageClass` for the cluster's storage, or leave
them empty to use its default StorageClass. An existing App PVC is also
supported through `persistence.existingClaim`.

The App pod requests no special security settings, only `fsGroup: 1000` so
the unprivileged `node` user can write the data volume.

### GKE

`gke.enabled` configures GKE's built-in Ingress (the external Application Load
Balancer, used when no IngressClass is set). The chart then adds a
BackendConfig with a one-hour timeout for WebSockets and streamed replies, the
`/api/health` check, and load balancer request logging turned off; a
FrontendConfig that redirects HTTP to HTTPS; the annotations that attach them;
and `trustedProxyHops: 2`. With `gke.managedCertificate.enabled`, a
Google-managed certificate covers `ingress.host` and the Connect host instead
of TLS Secrets, so nothing else needs installing:

```yaml
ingress:
  enabled: true
  host: genosyn.example.com
gke:
  enabled: true
  managedCertificate:
    enabled: true
  # Optional: a reserved global address keeps DNS stable if the Ingress is recreated.
  # staticIpName: genosyn
```

Point every hostname at the Ingress address with DNS only (not through a
proxy); Google provisions the certificate once each one resolves, usually
within an hour. To keep an existing ManagedCertificate, set
`gke.managedCertificate.name` to its name.

### TLS with cert-manager

On clusters with [cert-manager](https://cert-manager.io) installed,
`ingress.tls.certManager.enabled` issues and renews `ingress.tls.secretName` and
the Connect host's `tlsSecretName`. The chart's own Issuer uses ACME HTTP-01
through the App's Ingress (Let's Encrypt production by default), or set
`ingress.tls.certManager.issuerRef` to an existing Issuer or ClusterIssuer. Each
Certificate starts from a temporary self-signed certificate, so an Ingress that
needs its Secret to exist, such as GKE's, comes up before the first issuance:

```yaml
ingress:
  enabled: true
  host: genosyn.example.com
  tls:
    enabled: true
    secretName: genosyn-tls
    certManager:
      enabled: true
```

cert-manager itself is a one-time cluster add-on, like the ingress controller:
Helm cannot create its CRDs and webhook in the same release as Certificates
that depend on them.

## Values that matter

| Value | Default | What it does |
| --- | --- | --- |
| `image.tag` | chart `appVersion` | Pin the app version. Tags carry no `v` prefix (`1.155.0`, not `v1.155.0`). |
| `replicaCount` | `1` | Keep at 1; see [One organization per install](#one-organization-per-install). |
| `strategy` | `Recreate` | Keep it: RWO volumes need it, and a rollout never overlaps two App processes. |
| `ingress.enabled` / `ingress.host` | `false` / `""` | Front the app. WebSockets pass through a plain Ingress rule on nginx/Traefik. |
| `ingress.connect.enabled` / `host` / `tlsSecretName` | `false` / `""` / `""` (effective) | Add a separate TLS hostname on the same Ingress, routed to the Genosyn Connect service. Requires `connect.enabled`. Legacy `ingress.gmailSignIn` fields remain supported. |
| `connect.enabled` / `existingSecret` | `false` / `""` | Run Genosyn Connect beside the App, with provider credentials from a Secret. See [Genosyn Connect](#genosyn-connect). |
| `ingress.className` | Empty | Installed IngressClass to use; empty leaves selection to the cluster's default. |
| `ingress.annotations` | `{}` | Controller-specific settings passed through to the Ingress. They win over annotations an integration adds. |
| `service.annotations` | `{}` | Optional settings passed through to the App Service for the chosen cluster/load balancer. They win over annotations an integration adds. |
| `ingress.tls.certManager.enabled` / `issuerRef` / `email` | `false` / `{}` / `""` | Let cert-manager issue the Ingress TLS Secrets, with the chart's ACME Issuer or an existing one. See [TLS with cert-manager](#tls-with-cert-manager). |
| `gke.enabled` | `false` | Configure GKE's built-in Ingress: BackendConfig, HTTPS redirect, annotations and two proxy hops. See [GKE](#gke). |
| `gke.managedCertificate.enabled` / `name` | `false` / `""` | Google-managed certificate for the Ingress hostnames, instead of `ingress.tls`. |
| `gke.backendConfig.timeoutSec` / `gke.staticIpName` | `3600` / `""` | Load balancer request and WebSocket timeout; optional reserved global static IP. |
| `config.publicUrl` | `""` | Public HTTPS origin the post-install Job stores on Postgres; empty derives it from an HTTPS `ingress.host`. |
| `persistence.storageClass` / `postgres.persistence.storageClass` | Empty | App and bundled database StorageClasses; empty uses the cluster default. |
| `persistence.size` | `20Gi` | The `/app/data` volume. Holds checkouts, browser state, and uploads; the instance secrets live in a Kubernetes Secret. |
| `persistence.existingClaim` | `""` | Use a PVC you manage instead of the chart's. |
| `config.db.driver` | `postgres` | `sqlite` keeps the database on the data volume (`values-selfhost.yaml` sets it). |
| `config.db.postgresUrlSecret` | `{}` | Secret + key holding a full `postgresql://…` URL — the production database. |
| `postgres.enabled` | `true` | Bundled single-node Postgres, evaluation only. Turn off when using `postgresUrlSecret`. |
| `postgres.password` | `""` | Optional inline bundled-Postgres password in a private values file. Use only letters, digits, `.`, `_`, `~`, or `-`. Cannot be combined with `postgres.passwordSecret.name`. |
| `secrets.existingSecret` | `""` | Secret with `sessionSecret` + `encryptionSecret` keys (≥ 32 chars each, distinct). Empty lets the chart manage a kept `-instance-secrets` Secret. |
| `secrets.sessionSecret` / `secrets.encryptionSecret` | `""` / `""` | Optional inline instance secrets in a private values file. Supply both, at least 32 characters each and distinct. Cannot be combined with `secrets.existingSecret`. |
| `config.bootstrapMasterAdminEmail` | `""` | Recommended. The address that claims the master-admin account once verified; see [Quickstart](#quickstart). |
| `config.extraJs` | `""` | Extra `key: value,` lines spliced into the generated `config.js`. |
| `env` | `[]` | Extra container env vars (verbatim pod-spec syntax). |

Inline secrets belong only in a private, untracked values file such as the
operator-owned files under `Helm/Values/`. Restrict the file to its owner
(`chmod 600`). The chart puts these values into Kubernetes Secrets; Helm also
stores them in its release values, and direct `helm template` output contains
the rendered Secret data.

Leaving the inline fields empty preserves the existing behavior: reuse a
chart-managed Secret if one exists, otherwise generate strong random values.
When inline values are supplied for an existing chart-managed Secret, they
must match its current values exactly. A mismatch stops the deployment with
no values shown; it neither rotates stored keys/passwords nor ignores the
requested values. Recover existing values from your backup when adopting this
mode. Password and encryption-key changes require a separate migration.
`postgres.password` applies only to the bundled database and is rejected when
`postgres.enabled=false`; an external production database still uses
`config.db.postgresUrlSecret`.

## Genosyn Connect

Genosyn Connect is the hosted OAuth sign-in service (`Connect/` in the
repository, image `ghcr.io/genosyn/connect`). It lets self-hosted installations
connect Gmail and other Integrations without registering their own OAuth app.
Only the operator of a public sign-in service runs it; an ordinary install
leaves it off and its App uses `https://connect.genosyn.com`.

Create a Secret with the provider credentials, then enable the workload and
its hostname together:

```bash
kubectl -n genosyn create secret generic genosyn-connect \
  --from-literal=CONNECT_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com \
  --from-literal=CONNECT_GOOGLE_CLIENT_SECRET=GOCSPX-...
```

```yaml
ingress:
  enabled: true
  host: app.example.com
  tls:
    enabled: true
    secretName: app-tls
  connect:
    enabled: true
    host: connect.example.com
    tlsSecretName: connect-tls
connect:
  enabled: true
  existingSecret: genosyn-connect
  # Products to offer; each needs your Google app's verification.
  googleScopeGroups: gmail
  privacyUrl: https://example.com/privacy
  termsUrl: https://example.com/terms
```

The chart renders a `<release>-connect` Deployment and Service: the image at
the chart's version (`connect.image.tag` overrides it), non-root, read-only,
no service-account token and no volume, with readiness on `/readyz` and
liveness on `/healthz`. The whole Connect hostname routes to it and none of it
reaches the App. On GKE it gets its own BackendConfig with request logging
off, because callback URLs carry authorization codes.

Connect keeps no state, so `connect.replicaCount` can be anything. Its
replicas share only `CONNECT_SECRET`, which the chart generates once into a
`<release>-connect-key` Secret and keeps across upgrades; a `CONNECT_SECRET`
in `connect.existingSecret` takes precedence. Register
`https://connect.example.com/api/connect/google/callback` with Google.

`ingress.connect` defaults to an empty object, with effective defaults of
disabled, empty hostname, and empty TLS Secret name. Existing
`ingress.gmailSignIn` values still work. Each explicitly supplied `connect`
field takes precedence over the corresponding legacy field, including
`enabled: false` or an empty string. Unspecified fields inherit their legacy
values; remove the legacy block after migration. An enabled Connect host must
be a distinct DNS hostname, both hosts must have TLS configured, and
`connect.enabled` must be on: a profile that routed the hostname to the App
fails to render, because the App no longer serves sign-in for other
installations.

## How config works

Genosyn has no `.env` files — config is a single JavaScript object compiled
into the image at `/app/dist/config.js`. The chart renders a complete
replacement from `values.yaml` and mounts it over that path (`subPath`), with
secrets injected as `GENOSYN_*` environment variables that the file reads via
`process.env`.

That file is deliberately short. It carries **boot configuration only**: the
data directory, database coordinates, the port, the session secret, the whole
`security` block, and the agent execution settings. Everything an
operator can safely change while the app runs lives in the database and is
edited in the dashboard, not in values:

| What | Where |
| --- | --- |
| Web tools, mail sync, meetings, browser, agent taint policy / member browsers / tool discovery, containment, the outbound private-host allowlist | **Admin → Runtime** |
| System SMTP transport | **Admin → Email transport** |
| Browser-facing public URL | **Admin → General** |
| OAuth app credentials | **Admin → Integrations** |

Upgrading from an older chart is safe: a ConfigMap still rendering the fat
old shape stays harmless (nothing enumerates config keys, so stale ones are
never read), and on the first boot after the upgrade the server copies each
surviving block into its database row once, so the install keeps its
behavior. Adding those keys back to `config.extraJs` does nothing. A release
that ran multi-tenant or in the sandbox needs one confirmation; see
[Upgrading a multi-tenant or sandboxed release](#upgrading-a-multi-tenant-or-sandboxed-release).

Anything the chart does not parameterize goes through `config.extraJs`,
spliced verbatim before the closing brace of the config object. A duplicate
top-level key replaces the default block wholesale; the generated file defines
`const security = {...}` above the object so security fields can be overridden
one at a time:

```yaml
config:
  extraJs: |
    security: { ...security, trustedProxyHops: 2, outboundPrivateHostAllowlist: ["internal.example.com"] },
```

`outboundPrivateHostAllowlist` still works exactly as shown, but it no longer
needs a values edit and a rollout: the same list is editable under **Outbound
network** at **Admin → Runtime**, and the two are combined, so a self-hosted
Forgejo or an in-cluster model endpoint can be allowed in the dashboard while
the file stays as it is.

Anything `extraJs` reads via `process.env.*` is injected through `env`:

```yaml
env:
  - name: GENOSYN_EXAMPLE_SECRET
    valueFrom:
      secretKeyRef: { name: my-secret, key: value }
```

## Upgrading

```bash
helm upgrade genosyn oci://ghcr.io/genosyn/charts/genosyn -n genosyn --reuse-values
```

- Chart version == app version; upgrading the chart upgrades the app.
- Migrations run on boot. The liveness probe is deliberately lax
  (`failureThreshold: 6`, 20s period) so a long migration is not killed
  mid-flight — do not tighten it.
- `strategy: Recreate` means a short outage per upgrade on single-replica
  installs; that is the cost of an RWO volume, not a bug.
- The bundled Postgres password and the generated instance secrets are each
  generated once and preserved across upgrades (Helm `lookup`); they never
  rotate on their own. Both secrets are annotated
  `helm.sh/resource-policy: keep`, so they also survive `helm uninstall` —
  the password must match the surviving `pgdata` volume, and rotating the
  encryption secret would orphan every encrypted row.
- Upgrading from a pre-release install of this same unreleased chart needs a delete+install: the workload selectors gained `app.kubernetes.io/component` and selector fields are immutable.
- The pod no longer requests seccomp, AppArmor, `procMount`, or
  user-namespace settings.

### Upgrading a multi-tenant or sandboxed release

Earlier charts defaulted to shared multi-tenant mode with the bubblewrap
command sandbox. This chart runs Genosyn single-tenant, and AI Employee
commands run in the App container without an OS sandbox, with access to every
company's data in the install. So `helm upgrade` stops before changing
anything until you confirm:

- **Multi-tenant** — the release's ConfigMap still renders `multiTenant: true`.
  If one organization uses this install, set `config.multiTenant=false` once.
  If it serves several unrelated organizations, give each its own install
  instead.
- **Sandboxed** — a single-tenant release ran commands in bubblewrap (its
  ConfigMap renders `executionMode: "bubblewrap"`), or your values still set
  `sandbox.enabled: true`. Set `sandbox.enabled=false` once.

```bash
helm upgrade genosyn oci://ghcr.io/genosyn/charts/genosyn -n genosyn \
  --reuse-values --set config.multiTenant=false --set sandbox.enabled=false
```

An explicit `false` for either value is always accepted; other leftover
`sandbox` keys are ignored. `--reuse-values` renders this upgrade with the
previous chart's defaults, which set both `multiTenant: true` and
`sandbox.enabled: true`, so it needs both flags even if your own values never
mentioned them. Without it, a multi-tenant release needs only
`config.multiTenant=false`.

## Backups

Three things, separately: the database (yours or the bundled StatefulSet's
`pgdata` volume), the `/app/data` PVC (checkouts, browser state, uploads —
it matters even on Postgres installs), and the instance secrets — the
generated `<fullname>-instance-secrets` Secret (or your
`secrets.existingSecret`). Losing the encryption secret makes encrypted rows
unreadable.
