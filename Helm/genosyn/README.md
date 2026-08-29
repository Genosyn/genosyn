# genosyn Helm chart

The official chart for [Genosyn](https://genosyn.com) — one container, one
volume, optional Postgres. Published as an OCI artifact alongside every
release.

## Quickstart

```bash
helm install genosyn oci://ghcr.io/genosyn/charts/genosyn \
  --namespace genosyn --create-namespace
```

That gives you the same shape as the one-line Docker installer: a single
replica, SQLite, and a 20Gi volume at `/app/data`. Add an Ingress when you
are ready for real traffic:

```bash
helm upgrade genosyn oci://ghcr.io/genosyn/charts/genosyn -n genosyn \
  --set ingress.enabled=true \
  --set ingress.host=genosyn.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=genosyn-tls
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
| `config.db.driver` | `sqlite` | Flip to `postgres` with `config.db.postgresUrlSecret` for an external database. |
| `config.db.postgresUrlSecret` | `{}` | Secret + key holding a full `postgresql://…` URL. |
| `postgres.enabled` | `false` | Bundled single-node Postgres for evaluation (implies `driver: postgres`). |
| `sandbox.enabled` | `false` | Grant the securityContext the bubblewrap coding sandbox needs (see below). |
| `secrets.existingSecret` | `""` | Secret with `sessionSecret` + `encryptionSecret` keys (≥ 32 chars each, distinct). |
| `config.multiTenant` | `false` | Shared SaaS mode — read the checklist below first. |
| `config.extraJs` | `""` | Extra `key: value,` lines spliced into the generated `config.js`. |
| `env` | `[]` | Extra container env vars (verbatim pod-spec syntax). |

## How config works

Genosyn has no `.env` files — config is a single JavaScript object compiled
into the image at `/app/dist/config.js`. The chart renders a complete
replacement from `values.yaml` and mounts it over that path (`subPath`), with
secrets injected as `GENOSYN_*` environment variables that the file reads via
`process.env`.

Anything the chart does not parameterize goes through `config.extraJs`,
spliced verbatim before the closing brace of the config object. A duplicate
top-level key replaces the default block wholesale; the generated file defines
`const security = {...}` above the object so security fields can be overridden
one at a time:

```yaml
config:
  extraJs: |
    security: { ...security, bootstrapMasterAdminEmail: "ops@example.com" },
    smtp: { host: "smtp.example.com", port: 587, secure: false, user: "apikey", pass: process.env.GENOSYN_SMTP_PASS ?? "", fromName: "Genosyn", from: "no-reply@example.com" },
env:
  - name: GENOSYN_SMTP_PASS
    valueFrom:
      secretKeyRef: { name: my-smtp, key: password }
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
level. Left disabled (the default), Genosyn boots with command
execution disabled and logs why — chat, Routines, Integrations, and browser
work all still function; builds, test suites, and per-employee checkouts do
not. Multi-tenant mode is the exception: it refuses to boot without a working
sandbox.

## Multi-tenant (shared SaaS) mode

`config.multiTenant: true` makes boot validation refuse anything below the
shared-SaaS baseline. The checklist, mapped to chart values:

1. **Postgres** — `config.db.driver: postgres` + `config.db.postgresUrlSecret`
   (or `postgres.enabled: true` for a trial run).
2. **Explicit strong secrets** — `secrets.existingSecret` with distinct
   `sessionSecret` and `encryptionSecret` values of at least 32 characters.
   Managed on-disk secrets are refused in this mode.
3. **Working sandbox** — `sandbox.enabled: true`, on a cluster that actually
   honors the fields; multi-tenant boot probes bubblewrap and refuses on
   failure instead of degrading.
4. **Bootstrap admin** — predeclare the only email allowed to claim the first
   master-admin account, via `config.extraJs`:
   `security: { ...security, bootstrapMasterAdminEmail: "ops@example.com" },`
5. **System SMTP** — required for verification and recovery mail. Configure it
   via `config.extraJs` (`smtp: { ... },`) or later at Admin → Email
   transport; boot checks that one of the two is present.
6. **HTTPS** — serve through TLS; secure cookies are mandatory in this mode.

The chart already renders the remaining requirements for you when
`config.multiTenant` is true (member browsers off, in-process browser off,
sandbox network access off).

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
- The bundled Postgres password is generated once and preserved across
  upgrades (Helm `lookup`); it never rotates on its own. The generated secret
  is annotated `helm.sh/resource-policy: keep`, so it also survives
  `helm uninstall` alongside the `pgdata` volume it matches.
- Upgrading from a pre-release install of this same unreleased chart needs a delete+install: the workload selectors gained `app.kubernetes.io/component` and selector fields are immutable.

## Backups

Two things, separately: the database (yours or the bundled StatefulSet's
`pgdata` volume) and the `/app/data` PVC. `/app/data` matters even on
Postgres installs — unless explicit secrets are configured via
`secrets.existingSecret`, the managed instance encryption secrets live there,
and losing them makes encrypted rows unreadable.
