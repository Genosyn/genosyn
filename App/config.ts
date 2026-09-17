/**
 * Boot configuration — the short list of things that must be settled before
 * this process can safely accept a request.
 *
 * Three kinds of thing live here and nothing else does:
 *
 *   1. **Secrets** — `sessionSecret` and `security.encryptionSecret`. Default
 *      self-host installs replace the placeholders with managed values in
 *      `data/.instance-secrets.json`; explicit values take precedence.
 *   2. **Database coordinates** — where the data is and how to reach it.
 *   3. **The fail-closed security posture** — the whole `security` block plus
 *      the agent execution switches. These are validated at startup and a
 *      multi-tenant install refuses to boot when they do not meet the shared
 *      SaaS baseline, which is only meaningful if they cannot be edited by
 *      whoever happens to be signed in.
 *
 * **Everything operational now lives in the database and is edited in the
 * dashboard, not here**: the web tools, mail sync tuning, meetings, the
 * container's browser, the agent's taint policy / member browsers / tool
 * discovery, and containment are at **Admin → Runtime** (see
 * `server/services/runtimeSettings.ts`); the global SMTP transport is at
 * **Admin → Email transport**; the browser-facing public URL and custom
 * JavaScript are at **Admin → General**; OAuth app credentials are at
 * **Admin → Integrations**.
 * Do not reintroduce any of them here — an operator should not have to edit a
 * file and restart a container to change how often a mailbox polls.
 *
 * `security.outboundPrivateHostAllowlist` is the one setting that lives in both
 * places, and deliberately so: the outbound policy is installed before the
 * database is open, so this copy is what holds during boot, while Admin →
 * Runtime carries an editable list that is unioned with it. See the note on the
 * field.
 *
 * An install upgrading from the old shape keeps its behavior: any of those
 * blocks still present in this object (or in a Kubernetes ConfigMap overlay
 * rendering an old `config.js`) is imported into the database once at boot by
 * `importLegacyConfigOverrides()`, and is inert afterwards.
 */
export const config = {
  // Directory where SQLite db and per-company filesystem tree live
  dataDir: "./data",

  // Database driver — flip to "postgres" + fill url when ready
  db: {
    driver: "sqlite" as "sqlite" | "postgres",
    sqlitePath: "./data/app.sqlite",
    postgresUrl: "",
  },

  // API server
  port: 8471,
  // Default self-host installs replace this public placeholder with a strong,
  // persistent value in data/.instance-secrets.json. Set an explicit secret
  // of at least 32 characters to take precedence. Shared multi-tenant installs
  // must always configure an explicit value.
  sessionSecret: "change-me-in-production",

  // Security posture. `multiTenant` is intentionally false for existing
  // self-hosted installs; hosted operators must turn it on. In that mode the
  // server refuses to boot unless the database, cookie, encryption, and agent
  // isolation settings below meet the shared-SaaS baseline.
  security: {
    multiTenant: false,
    // Separate from sessionSecret. Default self-host installs replace this
    // placeholder with the distinct managed encryption key stored in
    // data/.instance-secrets.json. Explicit values take precedence. New
    // ciphertexts derive a scoped key per company (or user); keep old explicit
    // values in previousEncryptionSecrets while rotating so rows stay readable.
    encryptionSecret: "change-me-in-production-too",
    previousEncryptionSecrets: [] as string[],
    // "auto" sets Secure whenever the Admin → General public URL is https,
    // and always in multi-tenant mode. Multi-tenant mode rejects false.
    secureCookies: "auto" as "auto" | boolean,
    sessionMaxAgeDays: 7,
    // Number of trusted reverse-proxy hops in front of Express. The Docker
    // deployment is normally reached through one ingress/reverse-proxy hop.
    // Set this to 0 only when Genosyn is directly reachable.
    trustedProxyHops: 1,
    // Hosts in this exact, case-insensitive list may resolve to loopback,
    // private, link-local, or other non-public addresses. Leave empty for a
    // public SaaS. Add an internal hostname only when the operator explicitly
    // intends tenants to reach it.
    //
    // This stays here because the outbound policy is installed before the
    // database is open, so it is the only list that holds during boot. The
    // same exemption is also editable at **Admin → Runtime** under Outbound
    // network, and the two lists are unioned — so a self-hosted Forgejo can be
    // allowed without a restart, and a multi-tenant install ignores the
    // editable half entirely (`privateHostAllowed()` in lib/outboundUrl.ts).
    outboundPrivateHostAllowlist: [] as string[],
    outboundRequestTimeoutMs: 15_000,
    outboundMaxResponseBytes: 25 * 1024 * 1024,
    authRateLimit: {
      windowMinutes: 15,
      maxAttempts: 10,
      blockMinutes: 15,
    },
    // Fresh installs must predeclare the only email allowed to claim the first
    // master-admin account. Promotion happens only after email verification,
    // preventing an internet race during bootstrap. Existing installs that
    // already have a master admin are unaffected.
    bootstrapMasterAdminEmail: "",
  },

  // AI Employee execution controls. OpenCode runs directly on the host by
  // default, with ordinary file and command access. This includes Repository
  // work-session commands and command Checks; no Linux namespace support or
  // Docker security options are required for a self-hosted install.
  // `disabled` exposes no coding tools and materializes no repositories.
  // `bubblewrap` remains available for installs that explicitly require
  // isolation; boot disables coding if that selected sandbox cannot start.
  // Shared multi-tenant installs still require bubblewrap and no sandbox
  // network access. ChatGPT subscription auth remains single-tenant only.
  agent: {
    codingTools: {
      enabled: true,
      executionMode: "host" as "host" | "bubblewrap" | "disabled",
      bubblewrapPath: "/usr/bin/bwrap",
      allowNetwork: false,
      // Retained for existing operator configurations. Set false to deny host
      // execution even when executionMode is host.
      allowUnsafeHostExecution: true,
    },
    // The current app-owned Chromium process shares the API container. Keep it
    // off in multi-tenant mode until a separately isolated browser worker is
    // configured; startup validation enforces this boundary.
    browserEnabledInMultiTenant: false,
  },
} as const;
