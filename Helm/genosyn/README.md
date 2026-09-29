# genosyn Helm chart

The official chart for [Genosyn](https://genosyn.com) — one container, one
volume, Postgres. Defaults to production multi-tenant SaaS, with a one-file
off-ramp to a single-tenant self-host (`values-selfhost.yaml`). Published as
an OCI artifact alongside every release, and listed on
[Artifact Hub](https://artifacthub.io/packages/search?ts_query_web=genosyn).

## Quickstart

For Genosyn's test and production SaaS environments, use the root
`npm run deploy-test` and `npm run deploy-prod` commands with the private,
Git-ignored files `Helm/Values/test.values.yaml` and
`Helm/Values/prod.values.yaml`. The
[environment guide](../Values/README.md) covers Kubernetes contexts, namespaces, TLS,
database Secrets, offline previews, and public URL initialization.
Production routes `connect.genosyn.com` to the same App through `/api/connect`
and the six legacy Gmail sign-in paths. Set its separate **Hosted sign-in address** at
**Admin → Runtime → Hosted sign-in** while retaining `app.genosyn.com` as the
App's public URL; see the [hosted sign-in guide](../../App/HOSTED_SIGN_IN.md).

The chart's **default posture is production multi-tenant SaaS**: `multiTenant`
on, Postgres, the bubblewrap sandbox granted, chart-generated strong secrets.
A bare `helm install` fails fast at template time with one aggregated message
listing everything missing — by design, only one value needs supplying.

### Genosyn Cloud / production (default)

```bash
helm install genosyn oci://ghcr.io/genosyn/charts/genosyn \
  --namespace genosyn --create-namespace \
  --set config.bootstrapMasterAdminEmail=ops@example.com \
  --set ingress.enabled=true \
  --set ingress.host=genosyn.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=genosyn-tls
```

The one `config.*` flag is the multi-tenant minimum (the bootstrap admin
email). The Ingress with TLS is not optional garnish: multi-tenant mode
forces Secure session cookies, so the **first login must already happen over
HTTPS**. The default install runs the **bundled evaluation Postgres**; real
production should operate its own (managed instance, CloudNativePG, an
operator) and point `config.db.postgresUrlSecret` at it with
`postgres.enabled=false`.

Multi-tenant installs accept registrations only once the database stores their
public HTTPS URL. The chart does this itself: a post-install and post-upgrade
Job stores `https://<ingress.host>` (or `config.publicUrl`) with the App's
first-write-only setup script. An origin later changed at **Admin → General** is
kept, and the upgrade continues. Without an HTTPS Ingress or `config.publicUrl`
no Job runs; initialize it from the running container instead:

```bash
kubectl -n genosyn exec deploy/genosyn -c app -- \
  node /app/dist/server/scripts/setupPublicUrl.js --url https://genosyn.example.com
```

**System SMTP is not a chart value.** Configure the mail transport after boot
at **Admin → Email transport**, where it is stored encrypted in the database.
Until it is set, boot prints a warning and every system mail — including the
bootstrap master admin's own verification link — goes to the pod log:

```bash
kubectl logs -n genosyn deploy/genosyn
```

Paste that link into the browser to verify and claim the master-admin
account, then set SMTP up from the dashboard.

### Single-tenant self-host

The old default shape — SQLite, no bundled Postgres, no securityContext
demands — lives in [`values-selfhost.yaml`](./values-selfhost.yaml):

```bash
helm pull oci://ghcr.io/genosyn/charts/genosyn --untar
helm install genosyn ./genosyn \
  --namespace genosyn --create-namespace \
  -f genosyn/values-selfhost.yaml
```

The pod becomes Ready once every migration has run (`/api/health` answers
only after boot completes). Create the first account in the browser, then
review the public URL at **Admin → General**.

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

Compatible clusters must support the selected workload's security posture.
Shared SaaS requires a working bubblewrap sandbox, the relevant kernel and
Kubernetes features, and admission policy permitting the security settings
described below. Restricted clusters that forbid them cannot run this SaaS
mode. The trusted single-tenant `values-selfhost.yaml` profile instead runs
OpenCode and Repository commands inside the App container without an OS sandbox.

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
# Container-Optimized OS nodes run the sandbox; see sandbox.appArmorProfile.
nodeSelector:
  cloud.google.com/gke-os-distribution: cos
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
| `replicaCount` | `1` | Keep at 1 unless running multi-tenant with Postgres + RWX storage. |
| `strategy` | `Recreate` | Required for RWO volumes; `RollingUpdate` only for multi-replica RWX. |
| `ingress.enabled` / `ingress.host` | `false` / `""` | Front the app. WebSockets pass through a plain Ingress rule on nginx/Traefik. |
| `ingress.connect.enabled` / `host` / `tlsSecretName` | `false` / `""` / `""` (effective) | Add a separate TLS hostname on the same Ingress and Service for hosted sign-in. Configure the hosting address and OAuth apps in the dashboard before enabling hosting. Legacy `ingress.gmailSignIn` fields remain supported. |
| `ingress.className` | Empty | Installed IngressClass to use; empty leaves selection to the cluster's default. |
| `ingress.annotations` | `{}` | Controller-specific settings passed through to the Ingress. They win over annotations an integration adds. |
| `service.annotations` | `{}` | Optional settings passed through to the App Service for the chosen cluster/load balancer. They win over annotations an integration adds. |
| `ingress.tls.certManager.enabled` / `issuerRef` / `email` | `false` / `{}` / `""` | Let cert-manager issue the Ingress TLS Secrets, with the chart's ACME Issuer or an existing one. See [TLS with cert-manager](#tls-with-cert-manager). |
| `gke.enabled` | `false` | Configure GKE's built-in Ingress: BackendConfig, HTTPS redirect, annotations and two proxy hops. See [GKE](#gke). |
| `gke.managedCertificate.enabled` / `name` | `false` / `""` | Google-managed certificate for the Ingress hostnames, instead of `ingress.tls`. |
| `gke.backendConfig.timeoutSec` / `gke.staticIpName` | `3600` / `""` | Load balancer request and WebSocket timeout; optional reserved global static IP. |
| `config.publicUrl` | `""` | Public HTTPS origin the post-install Job stores; empty derives it from an HTTPS `ingress.host`. |
| `persistence.storageClass` / `postgres.persistence.storageClass` | Empty | App and bundled database StorageClasses; empty uses the cluster default. |
| `persistence.size` | `20Gi` | The `/app/data` volume. Holds checkouts, browser state, uploads — and the managed instance secrets. |
| `persistence.existingClaim` | `""` | Use a PVC you manage instead of the chart's. |
| `config.db.driver` | `postgres` | `sqlite` for single-tenant self-host (`values-selfhost.yaml` sets it). |
| `config.db.postgresUrlSecret` | `{}` | Secret + key holding a full `postgresql://…` URL — the production database. |
| `postgres.enabled` | `true` | Bundled single-node Postgres, evaluation only. Turn off when using `postgresUrlSecret`. |
| `postgres.password` | `""` | Optional inline bundled-Postgres password in a private values file. Use only letters, digits, `.`, `_`, `~`, or `-`. Cannot be combined with `postgres.passwordSecret.name`. |
| `sandbox.enabled` | `true` | Grant the securityContext the bubblewrap coding sandbox needs (see below). |
| `sandbox.appArmorProfile` | `Unconfined` | AppArmor profile for the sandboxed App container; an empty string omits it. |
| `secrets.existingSecret` | `""` | Secret with `sessionSecret` + `encryptionSecret` keys (≥ 32 chars each, distinct). Empty lets the chart manage a kept `-instance-secrets` Secret. |
| `secrets.sessionSecret` / `secrets.encryptionSecret` | `""` / `""` | Optional inline instance secrets in a private values file. Supply both, at least 32 characters each and distinct. Cannot be combined with `secrets.existingSecret`. |
| `config.multiTenant` | `true` | Shared SaaS mode — the default; read the checklist below. |
| `config.bootstrapMasterAdminEmail` | `""` | The only email allowed to claim the first master admin. Required when `multiTenant`. |
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

## Hosted sign-in ingress

Add a Connect hostname when this installation hosts sign-in for other installs:

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
```

Both hosts use the same Ingress and App Service. The Connect host exposes only
the `/api/connect` path prefix and the six legacy exact paths
`/api/google-sign-in/{status,start,authorize,callback,poll,refresh}`. It does
not route the App, administration pages, or `/api/health`. Provider routes
under `/api/connect` need no further ingress changes; Google is the current
hosted sign-in provider. Use `/api/connect/google/callback` for its new OAuth
callback and retain `/api/google-sign-in/callback` for older installations.

`ingress.connect` defaults to an empty object, with effective defaults of
disabled, empty hostname, and empty TLS Secret name. Existing
`ingress.gmailSignIn` values still work. Each explicitly supplied `connect`
field takes precedence over the corresponding legacy field, including
`enabled: false` or an empty string. Unspecified fields inherit their legacy
values; remove the legacy block after migration. An enabled Connect host must
be a distinct DNS hostname, and both hosts must have TLS configured.

## Stripe billing bootstrap

For paid plans, set these fields directly in a private, untracked values file.
Enable `billing.enabled` once the Stripe credentials and both monthly price
IDs are ready. Use a different price ID for each configured plan and interval.

| Value | Default | Purpose |
| --- | --- | --- |
| `billing.enabled` | `false` | Import billing settings only when none have been saved. |
| `billing.secretKey` | Empty | Stripe `sk_` or `rk_` test/live secret key. Required when enabled. |
| `billing.webhookSecret` | Empty | Stripe `whsec_` webhook signing secret. Required when enabled. |
| `billing.growthMonthlyPriceId` | Empty | Required Growth monthly Stripe `price_` ID. |
| `billing.scaleMonthlyPriceId` | Empty | Required Scale monthly Stripe `price_` ID. |
| `billing.growthAnnualPriceId` | Empty | Optional Growth annual Stripe `price_` ID. |
| `billing.scaleAnnualPriceId` | Empty | Optional Scale annual Stripe `price_` ID. |

The chart creates a separate `-billing-bootstrap` Secret whose `settings.json`
key is injected through a Secret reference as `GENOSYN_BILLING_BOOTSTRAP_JSON`.
Credentials are absent from the ConfigMap, pod annotations, and deployment
notes. Direct `helm template` output still contains the Secret data, and Helm
retains the values in its release record.

At boot, the App atomically imports these settings into the encrypted
`billing.settings` database row **only if that row does not exist**. An
existing row always wins, including one with billing disabled. Use **Admin →
Billing** for later edits: changing Helm values, restarting, or turning
`billing.enabled` off does not replace or disable saved settings. This
bootstrap Secret is managed normally by Helm and is not retained on
uninstall; the database and its encryption key preserve the saved settings.
The default disabled block renders neither the Secret nor the bootstrap
environment variable.

## How config works

Genosyn has no `.env` files — config is a single JavaScript object compiled
into the image at `/app/dist/config.js`. The chart renders a complete
replacement from `values.yaml` and mounts it over that path (`subPath`), with
secrets injected as `GENOSYN_*` environment variables that the file reads via
`process.env`.

That file is deliberately short. It carries **boot configuration only**: the
data directory, database coordinates, the port, the session secret, the whole
`security` block, and the two agent isolation switches. Everything an
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
behavior. Adding those keys back to `config.extraJs` does nothing.

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
the file stays as it is. Shared multi-tenant installs ignore the dashboard list
and still refuse to boot with a non-empty one in values.

Anything `extraJs` reads via `process.env.*` is injected through `env`:

```yaml
env:
  - name: GENOSYN_EXAMPLE_SECRET
    valueFrom:
      secretKeyRef: { name: my-secret, key: value }
```

## The coding sandbox (`sandbox.enabled`)

With sandbox isolation enabled, Genosyn runs coding commands inside bubblewrap, which
needs to create a user namespace and mount its own `/proc`. A stock pod
allows neither, so `sandbox.enabled=true` sets on the container:

```yaml
securityContext:
  seccompProfile: { type: Unconfined }
  procMount: Unmasked
  appArmorProfile: { type: Unconfined }
```

The container runtime's default AppArmor profile (containerd's, on GKE, Ubuntu
and Container-Optimized OS nodes) denies the mounts bubblewrap makes inside its
own namespaces, so `sandbox.appArmorProfile` defaults to `Unconfined`. On
Kubernetes before 1.30 the chart sets the equivalent pod annotation instead;
an empty string omits both. Ubuntu 24.04 nodes additionally block the
sandbox's nested user namespace through
`kernel.apparmor_restrict_unprivileged_userns=1`, so schedule the App onto
other nodes with `nodeSelector` (on GKE, Container-Optimized OS).

`procMount: Unmasked` needs the cluster's `ProcMountType` feature gate and,
on newer Kubernetes (1.31+), a user-namespaced pod: the chart therefore also
renders pod-spec `hostUsers: false` (from `sandbox.hostUsers`, default
`false`), which needs the `UserNamespacesSupport` feature gate — set
`sandbox.hostUsers` to `null` on clusters without that gate to omit the
field. Pod Security admission rejects these fields below the `privileged`
level. Disabled (`--set sandbox.enabled=false`, which `values-selfhost.yaml`
does), the trusted single-tenant configuration uses host coding: OpenCode and
Repository commands run inside the App container without an OS sandbox. No
special namespace permissions are required. Shared SaaS retains its isolation
requirement, so the chart refuses `multiTenant` + `sandbox.enabled=false` at
template time.

## Multi-tenant (shared SaaS) mode

`config.multiTenant: true` — the chart default — makes boot validation refuse
anything below the shared-SaaS baseline. The chart pre-validates its share at
**template time** and reports every missing value in one aggregated error, so
`helm install` fails in one round instead of one CrashLoopBackOff per missing
value. The checklist, mapped to chart values:

1. **Postgres** — `config.db.driver: postgres` (default) + either
   `postgres.enabled: true` (default, evaluation only) or
   `config.db.postgresUrlSecret` pointing at a database you operate.
2. **Explicit strong secrets** — satisfied out of the box: the chart
   generates a `<fullname>-instance-secrets` Secret with distinct 48-char
   values, preserved across upgrades and `helm uninstall`
   (`helm.sh/resource-policy: keep`). Or bring your own via
   `secrets.existingSecret` (distinct `sessionSecret` / `encryptionSecret`,
   ≥ 32 characters each), or the paired inline fields in a private values
   file. Managed on-disk secrets are refused in this mode.
3. **Working sandbox** — `sandbox.enabled: true` (default), on a cluster
   that actually honors the fields; multi-tenant boot probes bubblewrap and
   refuses on failure instead of degrading.
4. **Bootstrap admin** — `config.bootstrapMasterAdminEmail`, the only email
   allowed to claim the first master-admin account. Required; template-time
   failure when empty.
5. **System SMTP** — not a chart value and not a boot requirement any more:
   set it at **Admin → Email transport** once the pod is up. Boot warns
   loudly until it is configured, and system mail (verification, invites,
   password resets) goes to the pod log in the meantime — which is how the
   bootstrap master admin claims the account on a fresh install:
   `kubectl logs -n genosyn deploy/genosyn`. Configure it before inviting
   anyone else; a shared install without a working transport cannot verify
   accounts or recover passwords.
6. **HTTPS** — serve through the Ingress with TLS. Secure cookies are forced
   in this mode, so even the first login must happen over HTTPS.

The chart already renders the remaining requirements for you when
`config.multiTenant` is true (member browsers off, in-process browser off,
sandbox network access off, private-host allowlist empty).

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

## Backups

Three things, separately: the database (yours or the bundled StatefulSet's
`pgdata` volume), the `/app/data` PVC (checkouts, browser state, uploads —
it matters even on Postgres installs), and the instance secrets — the
generated `<fullname>-instance-secrets` Secret (or your
`secrets.existingSecret`). Losing the encryption secret makes encrypted rows
unreadable.
