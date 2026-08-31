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
 *      the two agent isolation switches. These are validated at startup and a
 *      multi-tenant install refuses to boot when they do not meet the shared
 *      SaaS baseline, which is only meaningful if they cannot be edited by
 *      whoever happens to be signed in.
 *
 * **Everything operational now lives in the database and is edited in the
 * dashboard, not here**: the web tools, mail sync tuning, meetings, the
 * container's browser, the agent's taint policy / member browsers / tool
 * discovery, and containment are at **Admin → Runtime** (see
 * `server/services/runtimeSettings.ts`); the global SMTP transport is at
 * **Admin → Email transport**; the browser-facing public URL is at
 * **Admin → General**; OAuth app credentials are at **Admin → Integrations**.
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

  // AI Employee execution controls. Command execution is on by default, and
  // `bubblewrap` is the only mode that default is allowed to mean: every shell
  // invocation and repository Git child runs in user/mount/PID namespaces with
  // only the employee workspace writable. The stock Docker image ships the
  // executable, so an out-of-the-box install can run commands, materialize
  // repositories, and test a Repository connection without an operator
  // deciding anything — and a ChatGPT subscription still signs in beside it.
  // Bubblewrap is Linux-only and needs unprivileged user namespaces, so boot
  // probes it once and falls back to `disabled` when the sandbox cannot run
  // (see services/runtimeSecurity.ts). That fallback only ever narrows: a host
  // that cannot isolate a shell gets no shell, never an unsandboxed one.
  // `disabled` exposes no coding tools, materializes no repositories, and
  // permits no user-configured stdio MCP children; it still supports ChatGPT
  // subscription auth. Acknowledged `host` mode keeps path-confined file/search
  // tools but never exposes bash: a same-UID host shell could read App data,
  // Vault encryption roots, and sibling process tokens. It permits user stdio
  // MCP and therefore rejects subscription credentials. Shared SaaS requires
  // bubblewrap and disables network access inside the coding sandbox;
  // networked work goes through governed Integration, browser, and HTTP
  // surfaces instead.
  agent: {
    codingTools: {
      enabled: true,
      executionMode: "bubblewrap" as "host" | "bubblewrap" | "disabled",
      bubblewrapPath: "/usr/bin/bwrap",
      allowNetwork: false,
      // Emergency compatibility escape hatch for a trusted, single-company
      // install only. This acknowledgement enables host-mode coding tools and
      // server-owned Git work. The model tools stay path-confined, but all of
      // that work runs outside a namespace; selecting host mode alone is not
      // sufficient.
      allowUnsafeHostExecution: false,
    },
    // The current app-owned Chromium process shares the API container. Keep it
    // off in multi-tenant mode until a separately isolated browser worker is
    // configured; startup validation enforces this boundary.
    browserEnabledInMultiTenant: false,
  },
} as const;
