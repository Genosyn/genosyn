# Genosyn SaaS environments

Run these commands from the repository root against any compatible Kubernetes
cluster. They use standard Helm and kubectl with your existing kubeconfig;
the App chart has no cloud-specific resources or authentication requirements.

`test.values.yaml` and `prod.values.yaml` are private, Git-ignored operator
files containing real database, session, and encryption secrets. Keep them
owner-readable only (`chmod 600`) in `Helm/Values/` and restore them from your
private configuration storage on a new checkout. They are also excluded from
Docker build contexts. The chart defaults in
`Helm/genosyn/values.yaml` remain tracked. CI generates sample profiles for
its checks and does not use these private files.

| Command | Values | Context setting | Namespace | Public address |
| --- | --- | --- | --- | --- |
| `npm run deploy-test` | `test.values.yaml` | `GENOSYN_TEST_KUBE_CONTEXT` | `genosyn-test` | `https://test.genosyn.com` |
| `npm run deploy-prod` | `prod.values.yaml` | `GENOSYN_PROD_KUBE_CONTEXT` | `genosyn-prod` | `https://app.genosyn.com` |

Production also serves `https://connect.genosyn.com` from the same Ingress,
App containers, database, and secrets. That host forwards only the
`/api/connect` namespace and six legacy Gmail sign-in endpoints. It does not
expose App pages or create a second App deployment.

Set the environment's context variable, or override it for one command with
`GENOSYN_KUBE_CONTEXT`. Live deployments require an explicit context and
verify that it exists before applying anything. They use the normal kubectl
kubeconfig resolution, including `KUBECONFIG` with multiple files, without
rewriting configuration or changing the current context. Both releases are
named `genosyn`; all cluster commands select the context and namespace explicitly.
Helm-only connection overrides are cleared so Helm and kubectl use the same
endpoint and credentials from that kubeconfig.

## Configure once

1. Install Node 22, Helm, and kubectl. Obtain a kubeconfig with deployment
   access using your cluster's usual procedure. Any credential plugin named
   by that kubeconfig must already work. List available context names with
   `kubectl config get-contexts -o name`.
2. Restore your private values files and review their domains, storage, and resource sizes.
   Install an ingress controller and set `ingress.className` to its
   IngressClass, or leave it empty to use the cluster's default. The profiles
   use the default StorageClass; set `persistence.storageClass` and
   `postgres.persistence.storageClass` when a specific class is needed.
   Create the namespaces, provision the named TLS certificates in them, and
   point the domains at the ingress controller's external address. The
   profiles do not create a cluster, ingress controller, certificate issuer, or DNS
   records. Production needs both `genosyn-prod-tls` and `genosyn-connect-tls`;
   point both production domains at the same ingress address. External
   address allocation and any required load balancer are cluster infrastructure.
3. Set `config.bootstrapMasterAdminEmail` to the real operator's email, or
   supply `GENOSYN_BOOTSTRAP_ADMIN_EMAIL` when running a command. It is
   required: validation stops before deployment until an operator is named.
4. Each private profile contains independently generated
   `secrets.sessionSecret`, `secrets.encryptionSecret`, and `postgres.password`.
   Helm creates the instance and database Kubernetes Secrets from them;
   there is no separate Secret creation step. Back up the private values,
   database, instance Secret, and App data volume together. Keep these values
   stable after the first deployment: the chart rejects changes that conflict
   with existing keys or an initialized database password.
5. Use nodes that support the chart's bubblewrap sandbox and user namespaces.
   Pod admission must permit `seccompProfile: Unconfined`, `procMount: Unmasked`,
   and `hostUsers: false`. Both environments keep multi-tenant isolation on;
   disabling the sandbox is not a SaaS workaround. See the
   [chart's sandbox requirements](../genosyn/README.md#the-coding-sandbox-sandboxenabled).

One replica with a persistent ReadWriteOnce volume is the starting footprint in
both environments. Each profile deploys its own single-node Postgres database:
20Gi for test and 100Gi for production. More App replicas need shared ReadWriteMany storage and a
matching rollout strategy. This profile does not provision HA or backups.
An external production database remains supported through
`config.db.postgresUrlSecret`; disable bundled Postgres and remove
`postgres.password` when choosing that setup.

The App keeps its Kubernetes readiness and liveness probes at `/api/health`.
Configure the ingress controller for HTTPS redirects, WebSockets, and long
streamed responses without buffering; allow a response duration suitable for
AI replies (for example, one hour). Kubernetes Ingress
has no universal timeout setting, so controller configuration or annotations
own this behavior. `ingress.annotations` and `service.annotations` pass through
your own settings without selecting a provider. Proxy access logs must omit
query strings and request bodies/headers because OAuth callbacks carry codes.

The chart defaults to one trusted HTTP proxy hop. Set
`security: { ...security, trustedProxyHops: N },` through `config.extraJs` only
to match your actual proxy chain. This keeps client-IP rate limits accurate;
keep the App port private so requests cannot bypass the trusted proxies.

## Stripe and paid Plans

Both private profiles include a disabled `billing` block. Fill it using your
Stripe account's values, then set `billing.enabled: true` before deploying:

- `secretKey`: a server-side API key (`sk_test_…` or `rk_test_…` for test;
  `sk_live_…` or `rk_live_…` for production). Restricted keys need access to
  the customer, checkout, subscription, and billing portal operations used by Genosyn.
- `webhookSecret`: the endpoint's `whsec_…` signing secret.
- `growthMonthlyPriceId` and `scaleMonthlyPriceId`: required recurring,
  per-seat `price_…` IDs for the paid Plans.
- `growthAnnualPriceId` and `scaleAnnualPriceId`: optional annual `price_…` IDs.

Use keys, prices, and webhook endpoints from the same Stripe mode and account.
These credentials must come from Stripe; they cannot be generated locally.
See Stripe's [API key guide](https://docs.stripe.com/keys) and
[webhook setup guide](https://docs.stripe.com/webhooks).

Create a webhook endpoint for each environment:

- Test: `https://test.genosyn.com/api/billing/stripe/webhook`
- Production: `https://app.genosyn.com/api/billing/stripe/webhook`

Subscribe to `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, and `customer.subscription.deleted`.
Configure the Stripe customer portal so Members can manage their subscriptions.
The `connect.genosyn.com` host serves hosted sign-in only.

Helm passes the billing payload through a Kubernetes Secret. On first setup,
the App encrypts the credentials into its existing billing settings. If a
`billing.settings` row already exists, it is preserved in full: values-file
edits, key changes, and `billing.enabled: false` do not change stored billing.
Use **Admin → Billing** for those later changes, including disabling billing.
Deployment previews omit the Secret. No publishable key is needed because
Genosyn creates Stripe-hosted checkout sessions on the server.

## Preview and deploy

```bash
# Use the operator email intended for this installation.
export GENOSYN_BOOTSTRAP_ADMIN_EMAIL=operator@example.com

# Offline previews omit Secret documents; no cluster access or context required.
npm run template-deploy-test
npm run template-deploy-prod

# Use context names from your existing kubeconfig.
export GENOSYN_TEST_KUBE_CONTEXT=your-test-context
export GENOSYN_PROD_KUBE_CONTEXT=your-prod-context

# Apply the selected environment and wait for readiness.
npm run deploy-test
npm run deploy-prod
```

Replace the example email before running these commands. The helper packages
the local chart with the version from `VERSION` and deploys that exact App
image tag. This avoids accidentally deploying the older development
`Chart.yaml` version. The image must already have been published by the normal
[release process](../../RELEASING.md). To deploy a specific published candidate,
set `GENOSYN_IMAGE_TAG=sha-<commit>`; moving tags such as `latest` are refused.

The helper validates the chart before contacting the cluster, installs or upgrades the
release, and waits for readiness. It then runs the existing host-only public URL
initializer against the deployment's actual HTTPS ingress address. This writes
the database setting only once and refuses to replace a different stored
origin; change an established origin at **Admin → General**. A failed upgrade
or URL setup returns failure. Rollback is an operator decision because App boot
can apply database migrations.

After deployment, register and verify the configured operator. Until SMTP is
configured, the verification link is in the private App log. Configure
**Admin → Email transport**, verify **Admin → Billing** for Cloud Edition, and
**Admin → Integrations** for OAuth apps before onboarding customers.
For hosted sign-in, keep **Admin → General → Public URL** at
`https://app.genosyn.com`. Set **Admin → Runtime → Hosted sign-in → Hosted
sign-in address** to `https://connect.genosyn.com`. Register Google's new
`https://connect.genosyn.com/api/connect/google/callback` alongside the App's
ordinary Google redirect URI, and retain the legacy hosted callback
`https://connect.genosyn.com/api/google-sign-in/callback` for older installs.
Complete Google configuration before enabling hosting.
The [hosted sign-in guide](../../App/HOSTED_SIGN_IN.md) covers these steps.
The test profile leaves `ingress.connect.enabled` off; it can use its own
hostname and TLS Secret when hosted sign-in needs a test environment.

Use `ingress.connect.enabled`, `host`, and `tlsSecretName` in new profiles.
Legacy `ingress.gmailSignIn` fields remain supported. Each explicitly supplied
`connect` field overrides its legacy counterpart, including `enabled: false`;
unspecified fields inherit legacy values. Remove the legacy block once migrated.
The shared `/api/connect` route accommodates future providers without changing
the ingress; Google is the current hosted sign-in provider.

Run `npm run test:deploy` to check the deployment commands using stubbed Helm
and kubectl commands; it does not deploy either environment.
