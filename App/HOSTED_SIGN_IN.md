# Operating the shared sign-in service

Genosyn includes a provider-neutral sign-in service inside the **App** server.
Google for Gmail is the first supported provider. New sign-in providers can share
this host, deployment, settings, and security flow through dedicated adapters;
this does not enable additional providers or change Member login by itself. The default
customer setting points to `https://connect.genosyn.com`, but shipping the code
does not deploy that service or register a Google app. Until it is online and
configured, customers need their own Google OAuth app.

## Share the production App deployment

The production Helm profile serves both `app.genosyn.com` and
`connect.genosyn.com` through the same Ingress, App Service, containers,
database, and instance secrets. `connect.genosyn.com` exposes the shared `/api/connect` namespace and the six
legacy Google sign-in paths listed below. It does not expose the App UI or admin
routes. Both names use the same load-balancer address; provision the
`genosyn-prod-tls` and `genosyn-connect-tls` certificates in `genosyn-prod`.
With `GENOSYN_PROD_KUBE_CONTEXT` set to your existing Kubernetes context,
`npm run deploy-prod` installs both host rules using your chosen ingress controller.
Configure that controller's HTTPS routing and query-string-free access logs
for both hosts. No separate connect release,
database, or container is needed.

Keep **Admin → General → Public URL** at `https://app.genosyn.com`. In
**Admin → Runtime → Hosted sign-in**, set **Hosted sign-in address** to
`https://connect.genosyn.com`. This separate address controls the hosted
authorization page, its browser-origin checks, and Google's callback. Leaving
it blank uses the App's public URL, which supports an existing dedicated host.
**Sign-in service URL (advanced)** still chooses the remote service used by
this installation as a customer; it does not configure the hosting address.

Register the Google app and complete the launch steps below before enabling
**Host shared sign-in on this installation**. The Helm profile configures
routing, while these settings and OAuth credentials remain in the dashboard.
The two domains share capacity, upgrades, and outages. The test profile leaves
the extra host off; opt in with `ingress.connect` and a separate test
hostname/certificate when testing hosted sign-in.

## Optional dedicated deployment

Use the existing App image and a separate database, data volume, and instance
secrets. Pin an immutable image containing this feature; publishing the Home
site or deploying an older release does not install the service. Build and
release conventions are in [RELEASING.md](../RELEASING.md).

For a separately operated service, the existing Helm chart's
[`values-selfhost.yaml`](../Helm/genosyn/values-selfhost.yaml) provides one App
replica, SQLite on a persistent volume, and no bundled Postgres. Keep
`replicaCount: 1`, `strategy: Recreate`, persistence enabled, and a predeclared
`config.bootstrapMasterAdminEmail`. Before starting the App, use
`config.extraJs` to replace the complete `agent` block so commands never run:
set `codingTools.enabled: false`, `codingTools.executionMode: "disabled"`, and
`codingTools.allowUnsafeHostExecution: false`. This override is required
because the chart otherwise runs AI Employee commands directly in the App
container. This is an operator-only installation;
do not create customer companies, AI Models, or AI Employees here. Disable
Member browsers and meetings at **Admin → Runtime**. A managed Postgres
database is also supported; it does not remove the need for durable instance
secrets and the data volume.

For this dedicated topology, the chart's ordinary ingress exposes the whole App. Keep
`ingress.enabled: false` and configure a dedicated TLS ingress or reverse proxy
for `connect.genosyn.com` that permits the `/api/connect` path prefix and these exact legacy public paths.
Each supported provider uses `/api/connect/<provider>/status`, `/start`,
`/authorize`, `/callback`, `/poll`, and `/refresh`, with the methods below.
Unknown providers and routes return 404; the rest of the App stays private:

| Path                            | Methods   |
| ------------------------------- | --------- |
| `/api/google-sign-in/status`    | GET       |
| `/api/google-sign-in/start`     | POST      |
| `/api/google-sign-in/authorize` | GET, POST |
| `/api/google-sign-in/callback`  | GET       |
| `/api/google-sign-in/poll`      | POST      |
| `/api/google-sign-in/refresh`   | POST      |

Forward to the App service on port 8471 (the Helm Service exposes port 80),
without rewriting the path. Keep all other App paths private, including
registration, administration, internal APIs, and `/api/health`. The chart's
existing internal readiness and liveness probes use `/api/health`; monitor
`/api/connect/google/status` separately. Its `available: true` means the local
configuration is present, so a real consent and refresh check is still required.

Give operators private access to the full UI through a tunnel or restricted
ingress that preserves the canonical HTTPS origin. Complete bootstrap before
opening public broker access: configure the exact operator email, then from
`/app` in the container run
`node dist/server/scripts/setupPublicUrl.js --url https://connect.genosyn.com`.
Register that operator, verify its email, sign in, and disable registration at
**Admin → Sign-ups**. Before an email transport is configured, verification
links appear in the private server log; keep that log access restricted. Set
an email transport for subsequent account recovery. Confirm **Admin → General
→ Public URL** remains `https://connect.genosyn.com`.

Set `security.trustedProxyHops` to the actual proxy chain length (in Helm,
override with `security: { ...security, trustedProxyHops: N }` through
`config.extraJs`). Block direct public access to the App port. Preserve the
original Host, Origin, cookies, and the App's CSP and opener headers. Do not
cache these endpoints or put browser challenges or interactive access gates
in front of server-to-server requests. Disable request body/header capture;
proxy access logs must omit query strings, especially on the Google callback.
Keep the outbound private-host allowlist empty; the service needs outbound
HTTPS to Google and never needs to contact customer installation addresses.

## Launch the Genosyn service

1. Deploy the production profile with both domains, or the optional
   dedicated topology above. When the service shares the production App
   deployment, keep **Admin → General → Public URL** at
   `https://app.genosyn.com` and set **Admin → Runtime → Hosted sign-in →
   Hosted sign-in address** to `https://connect.genosyn.com`.
   On a dedicated installation, its public URL can be `https://connect.genosyn.com`
   with the hosting address left blank. The marketing site's Cloudflare Worker
   does not provide these endpoints.
2. Create a Google Cloud project, enable the Gmail API, and configure its OAuth
   branding and consent screen. Register a **Web application** OAuth client with
   this exact authorized redirect URI:

   `https://connect.genosyn.com/api/connect/google/callback`

   Keep `https://connect.genosyn.com/api/google-sign-in/callback` registered too
   for older installations and in-flight sign-ins. The two URLs are served
   directly, without redirects. Add the new URL before upgrading customer clients.

   Customer installation URLs are not registered as Google redirect URIs.
   When the service shares the production App deployment, that App also uses
   its locally registered Google app for its own Connections. Keep the ordinary
   redirect URI shown at **Admin → Integrations
   → Google** registered too:
   `https://app.genosyn.com/api/integrations/oauth/callback/google`.

3. Set that Client ID and Client Secret at **Admin → Integrations → Google** on
   the hosting App. These credentials remain server-side and are stored
   encrypted. Keep the same Client ID for the life of issued Connections;
   replacing it invalidates the refresh path for credentials issued by the old
   client.
4. Complete Google's production verification for the requested Gmail scopes.
   Publish accurate support, privacy, and deletion information covering both
   the sign-in service and self-hosted installations. Review the security
   assessment requirements with Google before launching; routing mail directly
   to customer installations does not itself establish an exemption. Google's
   [restricted-scope verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
   and [Gmail scope list](https://developers.google.com/workspace/gmail/api/auth/scopes)
   are the authoritative references.
5. After configuration and verification, open **Admin → Runtime → Hosted
   sign-in**, enable **Host shared sign-in on this installation**, and save.
   Ordinary customer installations leave this setting off. This opens the
   sign-in and token-renewal endpoints to other Genosyn installations.
6. Verify the browser flow from a separate installation: **Email → enter Gmail
   address → Continue with Google → consent → mailbox opens**. Check a rejected
   consent, an interrupted flow, reconnect, and an expired access token before
   announcing availability. Include a localhost customer installation in the
   verification: the service must not need inbound network access to it.

For local development, the service URL may use HTTP only on `localhost`,
`127.0.0.1`, or `[::1]`. Production uses HTTPS. Do not use real production
credentials or accounts in a local mock flow.
From `App/`, `npm run test:shared-google-host` exercises the real admin form
and sign-in routes on two local origins, with an in-memory database and
mocked Google consent/token responses. It checks cookie separation and that
the hosted address does not replace the App's public URL.

## Data and availability

The sign-in service owns the Google OAuth client secret. It exchanges the
Google code and briefly holds an encrypted, one-time handoff. The hosted page
verifies which installation opened it before Google consent. A separate
server-held proof is required to collect the credentials. Handoffs
expire after ten minutes; a cleanup pass deletes expired rows at startup and
every minute. Previously created encrypted backups follow their own retention.
The customer installation stores the returned Google credentials encrypted in its existing
Connection row. For token renewal, it sends the refresh credential to the
original sign-in service over HTTPS. The service has no long-term refresh-token
registry. Email content is read and sent directly between the customer
installation and Google.

Treat callback query strings, handoff values, authorization headers, and token
request/response bodies as secrets. Do not record them in reverse-proxy logs,
error-reporting payloads, analytics, support bundles, or request-body capture.
Monitor availability and Google error counts without credential material.
Back up the hosting App's database and instance secrets together; the shared
topology uses the production deployment's existing backup plan.

An outage affects new sign-ins and token renewal. Already issued access tokens
work until they expire. Restoring the service with the same Google client lets
existing Connections renew again; revoked credentials require reconnecting.

## Customer controls

The default **Use hosted sign-in** setting needs no customer OAuth app
when the Genosyn service is available. An operator may replace the service URL
with another trusted service; it must be an HTTPS origin without credentials,
a path, query, or fragment. This changes where **new** Connections authenticate.
Existing Connections retain their original issuer for refresh, so changing the
default cannot redirect an existing credential to a different service.

Disabling **Use hosted sign-in** prevents new hosted sign-ins without
revoking existing Connections or blocking their refresh. Disconnect the
Connection and revoke its access in Google to withdraw access.

A locally registered Google OAuth app, or explicit credentials on a
Connection, takes precedence over hosted Gmail sign-in. This preserves the
independent installation path. The Google adapter currently supports Gmail only; Drive,
Calendar, Analytics, Search Console, Ads, and the other Google products still
need an independently registered app.


## Adding another sign-in provider

The shared router at `server/routes/connectSignIn.ts` dispatches only registered
providers beneath `/api/connect/<provider>`. A provider adapter owns its OAuth
registration, fixed upstream endpoints, allowed scopes, consent copy, and token
validation. The common broker owns browser proof, encrypted one-time handoff,
expiry, CSRF checks, and throttling. Adding a provider must include its consumer
flow, callback registration, token validation, and tests; adding an OAuth app in
the dashboard alone does not expose it through Connect. Future Member sign-in
also needs an explicit account identity and account-linking flow.

New Google Connections save both their issuer and the protocol path. Older
Connections and in-flight attempts without a saved path continue using
`/api/google-sign-in`. New clients discover the provider through a public status
request; only a 404 permits checking an older Google host. Credential requests
never follow redirects or fall back to a different path. The browser opener
supports both protocol generations, while tokens stay server-side.

Existing `runtime.oauth` Gmail-named fields and `ingress.gmailSignIn` values
remain readable for upgrades. New saves use the neutral runtime fields
`hostedSignInEnabled`, `hostedSignInUrl`, `hostSignIn`, and `signInHostUrl`;
new Helm profiles use `ingress.connect`. An explicitly supplied new field takes
precedence over its old name, including `false` or an empty hosting address.
