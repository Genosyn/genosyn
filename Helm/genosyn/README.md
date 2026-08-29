# genosyn Helm chart

The official chart for [Genosyn](https://genosyn.com) — one container, one
volume, Postgres. Defaults to production multi-tenant SaaS, with a one-file
off-ramp to a single-tenant self-host (`values-selfhost.yaml`). Published as
an OCI artifact alongside every release, and listed on
[Artifact Hub](https://artifacthub.io/packages/search?ts_query_web=genosyn).

## Quickstart

The chart's **default posture is production multi-tenant SaaS**: `multiTenant`
on, Postgres, the bubblewrap sandbox granted, chart-generated strong secrets.
A bare `helm install` fails fast at template time with one aggregated message
listing everything missing — by design, only two values need supplying.

### Genosyn Cloud / production (default)

```bash
helm install genosyn oci://ghcr.io/genosyn/charts/genosyn \
  --namespace genosyn --create-namespace \
  --set config.bootstrapMasterAdminEmail=ops@example.com \
  --set config.smtp.host=smtp.example.com \
  --set ingress.enabled=true \
  --set ingress.host=genosyn.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=genosyn-tls
```

The two `config.*` flags are the multi-tenant minimum (bootstrap admin email
and system SMTP — see the checklist below for SMTP auth). The Ingress with
TLS is not optional garnish: multi-tenant mode forces Secure session cookies,
so the **first login must already happen over HTTPS**. The default install
runs the **bundled evaluation Postgres**; real production should operate its
own (managed instance, CloudNativePG, an operator) and point
`config.db.postgresUrlSecret` at it with `postgres.enabled=false`.

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

## Values that matter

| Value | Default | What it does |
| --- | --- | --- |
| `image.tag` | chart `appVersion` | Pin the app version. Tags carry no `v` prefix (`1.155.0`, not `v1.155.0`). |
| `replicaCount` | `1` | Keep at 1 unless running multi-tenant with Postgres + RWX storage. |
| `strategy` | `Recreate` | Required for RWO volumes; `RollingUpdate` only for multi-replica RWX. |
| `ingress.enabled` / `ingress.host` | `false` / `""` | Front the app. WebSockets pass through a plain Ingress rule on nginx/Traefik. |
| `persistence.size` | `20Gi` | The `/app/data` volume. Holds checkouts, browser state, uploads — and the managed instance secrets. |
| `persistence.existingClaim` | `""` | Use a PVC you manage instead of the chart's. |
| `config.db.driver` | `postgres` | `sqlite` for single-tenant self-host (`values-selfhost.yaml` sets it). |
| `config.db.postgresUrlSecret` | `{}` | Secret + key holding a full `postgresql://…` URL — the production database. |
| `postgres.enabled` | `true` | Bundled single-node Postgres, evaluation only. Turn off when using `postgresUrlSecret`. |
| `sandbox.enabled` | `true` | Grant the securityContext the bubblewrap coding sandbox needs (see below). |
| `secrets.existingSecret` | `""` | Secret with `sessionSecret` + `encryptionSecret` keys (≥ 32 chars each, distinct). Empty generates a kept `-instance-secrets` Secret. |
| `config.multiTenant` | `true` | Shared SaaS mode — the default; read the checklist below. |
| `config.bootstrapMasterAdminEmail` | `""` | The only email allowed to claim the first master admin. Required when `multiTenant`. |
| `config.smtp.host` (+ `port`/`user`/`from`/…) | `""` | System SMTP. `host` required when `multiTenant`; password via `config.smtp.passwordSecret`. |
| `config.extraJs` | `""` | Extra `key: value,` lines spliced into the generated `config.js`. |
| `env` | `[]` | Extra container env vars (verbatim pod-spec syntax). |

## How config works

Genosyn has no `.env` files — config is a single JavaScript object compiled
into the image at `/app/dist/config.js`. The chart renders a complete
replacement from `values.yaml` and mounts it over that path (`subPath`), with
secrets injected as `GENOSYN_*` environment variables that the file reads via
`process.env`.

SMTP is first-class: `config.smtp.*` renders into the config, and an
authenticated relay's password comes from a pre-created Secret — never from
values:

```yaml
config:
  smtp:
    host: smtp.example.com
    user: apikey
    passwordSecret: { name: my-smtp, key: password }  # injected as GENOSYN_SMTP_PASS
```

Anything the chart does not parameterize goes through `config.extraJs`,
spliced verbatim before the closing brace of the config object. A duplicate
top-level key replaces the default block wholesale; the generated file defines
`const security = {...}` above the object so security fields can be overridden
one at a time:

```yaml
config:
  extraJs: |
    security: { ...security, trustedProxyHops: 2 },
    integrations: { google: { clientId: "…", clientSecret: process.env.GENOSYN_GOOGLE_SECRET ?? "" } },
env:
  - name: GENOSYN_GOOGLE_SECRET
    valueFrom:
      secretKeyRef: { name: my-google-oauth, key: clientSecret }
```

## The coding sandbox (`sandbox.enabled`)

Genosyn runs every command an AI Employee asks for inside bubblewrap, which
needs to create a user namespace and mount its own `/proc`. A stock pod
allows neither, so `sandbox.enabled=true` sets on the container:

```yaml
securityContext:
  seccompProfile: { type: Unconfined }
  procMount: Unmasked
```

`procMount: Unmasked` needs the cluster's `ProcMountType` feature gate and,
on newer Kubernetes (1.31+), a user-namespaced pod: the chart therefore also
renders pod-spec `hostUsers: false` (from `sandbox.hostUsers`, default
`false`), which needs the `UserNamespacesSupport` feature gate — set
`sandbox.hostUsers` to `null` on clusters without that gate to omit the
field. Pod Security admission rejects these fields below the `privileged`
level. Disabled (`--set sandbox.enabled=false`, which `values-selfhost.yaml`
does), Genosyn boots with command execution disabled and logs why — chat,
Routines, Integrations, and browser work all still function; builds, test
suites, and per-employee checkouts do not. Multi-tenant mode — the default —
is the exception: it refuses to boot without a working sandbox, so the chart
refuses `multiTenant` + `sandbox.enabled=false` at template time.

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
   ≥ 32 characters each). Managed on-disk secrets are refused in this mode.
3. **Working sandbox** — `sandbox.enabled: true` (default), on a cluster
   that actually honors the fields; multi-tenant boot probes bubblewrap and
   refuses on failure instead of degrading.
4. **Bootstrap admin** — `config.bootstrapMasterAdminEmail`, the only email
   allowed to claim the first master-admin account. Required; template-time
   failure when empty.
5. **System SMTP** — `config.smtp.host` (plus `user` /
   `config.smtp.passwordSecret` for an authenticated relay). Required;
   template-time failure when empty. Can later be overridden at
   Admin → Email transport.
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
