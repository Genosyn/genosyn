# Genosyn Connect

The hosted OAuth sign-in service for self-hosted Genosyn installations —
`https://connect.genosyn.com`, published as `ghcr.io/genosyn/connect`.

Providers such as Google only redirect people back to addresses registered in
advance, and a self-hosted installation can live anywhere: `localhost`, a NAS,
a company domain. Connect is the one registered address. It holds one OAuth app
per provider, so a person types their Gmail address, approves Google's consent
screen, and their installation has a working Connection — with no Google Cloud
project of its own. An installation that registers its own OAuth app, or a
Connection that brings one, never uses Connect.

User documentation: [genosyn.com/docs/connect](https://genosyn.com/docs/connect).

## How a sign-in works

```
installation server ──start(challenges)──────────────▶ Connect
browser (installation tab) ──opens window──▶ Connect consent page
   consent page ◀──postMessage proof── installation tab   (proves who opened it)
   consent page ──Continue──▶ Google consent ──code──▶ Connect /callback
                                                   Connect exchanges the code
installation server ──poll(verifier)─────────────────▶ Connect ──credential, once──▶
installation server ──refresh(refresh token)─────────▶ Connect ──access token──▶
```

1. **start** (server to server): the installation registers a PKCE-style
   challenge for collecting the result and a second challenge for its browser.
2. **authorize** (browser): the consent page shows the installation's origin and
   the access it asked for. It enables *Continue* only after the window that
   opened it — the installation's own page — posts the browser proof; the form
   is also bound to a cookie set on this page. A copied link cannot continue.
3. Google returns to **callback** in the same browser (checked against that
   cookie). Connect exchanges the code with its client secret and its own PKCE
   verifier, and keeps the credential sealed for at most ten minutes.
4. **poll** (server to server): only the holder of the start verifier collects
   the credential, exactly once.
5. **refresh** (server to server): installations renew access tokens here
   because the client secret is here. Nothing is stored.

Connect never contacts an installation, so `localhost` works. Mail, files and
other data go directly between the installation and the provider.

## Protocol

Each provider is served at `/api/connect/<provider>`:

| Path | Method | Caller | Purpose |
| --- | --- | --- | --- |
| `/status` | GET | installation | `{ version: 1, available, scopes }` — what is offered |
| `/start` | POST JSON | installation | `{ codeChallenge, browserChallenge, installationOrigin, scopes? }` |
| `/authorize` | GET, POST | browser | consent page, then the redirect to the provider |
| `/callback` | GET | browser | the provider's return |
| `/poll` | POST JSON | installation | `{ requestId, codeVerifier }` → pending, denied or the credential |
| `/refresh` | POST JSON | installation | `{ clientId, refreshToken }` → a new access token |

`GET /api/connect` lists every provider. A start request may name `scopes`;
each must be one this service offers, and the provider's identity scopes are
added. A request that names none receives the provider's original default —
Gmail for Google — because installations released before scopes were
negotiable send none and expect exactly that.

Those older installations also use `/api/google-sign-in/*` (Gmail only, its
own cookie prefix and window-message names). It stays, unchanged, for as long
as such installations exist: Connections renew on the exact path that issued
them. A sign-in can never cross between the two paths.

Installation endpoints refuse browser requests (any `Origin` or `Sec-Fetch-*`
header), non-JSON bodies, and bodies over 24 KB. Every route is rate limited:
starting, viewing, approving and returning per client address, failed polls
per address, and renewal per refresh token.

## Running it

Configuration is environment variables; a secret may instead come from a file
(`<NAME>_FILE`). The process refuses to start and lists every problem when the
configuration is wrong.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONNECT_PUBLIC_URL` | required | The HTTPS origin people reach, e.g. `https://connect.genosyn.com`. Callbacks are built from it. HTTP only on localhost. |
| `CONNECT_GOOGLE_CLIENT_ID`, `CONNECT_GOOGLE_CLIENT_SECRET` | unset | Google's OAuth client. Unset, Google reports `available: false`. |
| `CONNECT_GOOGLE_SCOPE_GROUPS` | `gmail` | Comma-separated: `gmail`, `calendar`, `drive`, `docs`, `tasks`, `contacts`, `directory`, `chat`, `meet`, `analytics`, `search-console`, `ads`. |
| `CONNECT_TRUSTED_PROXY_HOPS` | `0` | Proxies in front that append to `X-Forwarded-For`, so limits apply to the real client. |
| `CONNECT_DATABASE_URL` | unset | Postgres, for more than one replica. Unset, sign-in state is in memory. |
| `CONNECT_SECRET` | per-process | 32+ characters; encrypts sign-in state. Required with `CONNECT_DATABASE_URL`. |
| `CONNECT_PRIVACY_URL`, `CONNECT_TERMS_URL` | unset | HTTPS links shown on every page. |
| `CONNECT_ACCESS_LOG` | `true` | One line per request: method, path, status, time. Never a query string. |
| `PORT`, `CONNECT_LISTEN_HOST` | `8473`, `0.0.0.0` | Where to listen. |

```bash
docker run -d --name genosyn-connect --restart unless-stopped -p 8473:8473 \
  -e CONNECT_PUBLIC_URL=https://connect.example.com \
  -e CONNECT_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com \
  -e CONNECT_GOOGLE_CLIENT_SECRET=GOCSPX-... \
  -e CONNECT_TRUSTED_PROXY_HOPS=1 \
  ghcr.io/genosyn/connect:latest
```

Health: `GET /healthz` (the process) and `GET /readyz` (its sign-in store).
On Kubernetes the Genosyn Helm chart runs it beside the App — `connect.enabled`
and `ingress.connect`; see [the chart README](../Helm/genosyn/README.md#genosyn-connect).

### State and replicas

One replica keeps sign-in state in memory, sealed with a key that lives as long
as the process. A restart costs only the sign-ins open at that moment; people
start again. Renewal keeps no state and is unaffected.

For several replicas, set `CONNECT_DATABASE_URL` and a shared
`CONNECT_SECRET`: any replica can then serve any step. The service creates its
one table, `connect_flow_states`, on boot; it holds token hashes and sealed
values that expire within ten minutes. There is nothing to back up.

### Behind a proxy

Terminate HTTPS for the public hostname and forward everything to the service.
Preserve `Host`, `Origin` and cookies, do not cache, set
`CONNECT_TRUSTED_PROXY_HOPS` to the actual chain length, and keep query strings
and bodies out of access logs: callback URLs carry authorization codes and
renewal bodies carry refresh tokens. Do not put browser challenges in front of
the server-to-server routes. The service needs outbound HTTPS to the provider
and nothing else.

## Launch checklist (Google)

1. Create a Google Cloud project, enable the Gmail API (and each other product
   you will offer), and configure the OAuth consent screen with the homepage,
   privacy policy and terms.
2. Create a **Web application** OAuth client with both redirect URIs:
   `https://connect.genosyn.com/api/connect/google/callback` and
   `https://connect.genosyn.com/api/google-sign-in/callback` (for installations
   released before provider-neutral routes).
3. Deploy with the client's ID and secret. Keep the same client for the life of
   issued Connections: their refresh tokens belong to it, and renewal through a
   different client is refused with "registration changed".
4. Complete Google's verification for every scope group you offer. Gmail and
   Drive are restricted scopes that also need the security assessment; the
   [restricted-scope requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
   and [Gmail scope list](https://developers.google.com/workspace/gmail/api/auth/scopes)
   are authoritative.
5. From an installation on another network — include one on `localhost` —
   check: connect Gmail from **Email**; cancel on Google's screen; reconnect;
   an expired access token renews; **Admin → Runtime → Hosted sign-in** shows
   the service as reachable with what it offers.

An outage stops new sign-ins and renewal; issued access tokens keep working
until they expire, and renewal resumes when the service is back with the same
client. Withdrawing access is done per Connection (disconnect it) or per
Google account (remove the app's access).

## Adding a provider

1. An adapter in `src/providers/` implementing `ConnectProvider`: fixed
   endpoints, a scope-group catalog with consent wording, the code exchange
   with its identity check, and renewal. Register it in
   `src/providers/index.ts` and give it a client in `src/config.ts`.
2. Tests beside the Google ones, including its upstream failures.
3. In the App, an entry in `server/services/hostedOauthApps.ts` and a renewal
   hook in that provider's token lifecycle, the way
   `integrations/providers/google/auth.ts` calls `refreshHostedOauthToken`.

Provider names, endpoints and scopes are never taken from a request.

## Development

```bash
npm install
CONNECT_PUBLIC_URL=http://localhost:8473 npm run dev
npm test                       # memory store; add CONNECT_TEST_POSTGRES_URL for Postgres
npm run lint && npm run typecheck && npm run build
```

To point a local App at a local Connect, use the loopback IP in both places —
`CONNECT_PUBLIC_URL=http://127.0.0.1:8473` here and the same URL at **Admin →
Runtime → Hosted sign-in → Sign-in service URL** — because the App's outbound
policy refuses a hostname such as `localhost` that resolves to a private
address unless it is on the private-host allowlist.

`App/scripts/test-connect-sign-in.ts` drives an App installation and this
service together in a real browser, with Google as a fixture.
