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
    // Taint-aware turns (M53). "web" (the default) marks a turn tainted once
    // it ingests web content (search_web / fetch_web_page / download_web_file);
    // a tainted turn's mail sends and Routine writes queue a human Approval
    // instead of executing — the classic prompt-injection sinks. "off"
    // disables the escalation entirely.
    taintPolicy: "web" as "web" | "off",
    // The current app-owned Chromium process shares the API container. Keep it
    // off in multi-tenant mode until a separately isolated browser worker is
    // configured; startup validation enforces this boundary.
    browserEnabledInMultiTenant: false,
    // Member browsers: a human connects a Chrome running on their own
    // computer, and a granted AI Employee drives that instead of the
    // container's headless Chromium. The bridge agent on their machine
    // launches a dedicated Chrome profile and relays CDP back over an
    // outbound WebSocket, so the App reaches a machine it could never dial.
    //
    // Forced off in multi-tenant mode by startup validation, and for a
    // stronger reason than the shared-container one above: a tenant would be
    // leaving a bearer-authenticated channel into a personal laptop standing
    // against shared infrastructure. Self-hosters can turn it off here too.
    memberBrowsersEnabled: true,
    // Show the model a working set of tools and let it reach the rest through
    // `find_tools` / `call_tool`, instead of sending every schema on every
    // step. Off makes every tool resident again — the model sees the whole
    // catalogue on each request, as it did before this existed. (Not identical
    // to the old on-wire size: the collapsed CRUD families are gone, so an
    // OpenAI-provider employee with many integrations could brush the 128-tool
    // cap and get trimmed — the run still works, it just isn't as lean.) Keep
    // the switch: first-turn recall is the risk this design carries, and an
    // operator who hits it needs a way back that doesn't involve a downgrade.
    toolDiscovery: {
      enabled: true,
      // Below this many tools the round-trip costs more than the schemas do.
      minCatalogueSize: 40,
    },
  },

  // The browser an AI Employee drives when it runs inside Genosyn's own
  // container (as opposed to a Member browser, which is a Chrome on a human's
  // own computer — see `agent.memberBrowsersEnabled`).
  //
  // The Docker image ships **real Google Chrome**, not Chromium, and runs it
  // headed against an Xvfb display. That is deliberate and it is the whole
  // anti-blocking strategy: a genuine Chrome needs no disguise, so there is no
  // disguise left to catch it out. Sites bounce automation by finding
  // *contradictions* — a browser claiming to be Chrome on macOS while its
  // fonts, WebGL renderer and `navigator.platform` say headless Chromium on
  // Linux — and the cheapest way to have no contradictions is to tell the
  // truth. Genosyn still never solves a captcha; when a site genuinely
  // challenges us we hand the page to a human.
  //
  // A source-managed install on a host without Chrome falls back to whatever
  // Chromium it can find, and only then does the compatibility mask in
  // `services/browserProfile.ts` switch on.
  browser: {
    // Absolute path to the Chrome/Chromium binary. Empty means autodetect:
    // the `GENOSYN_CHROME_PATH` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env
    // vars first (the Docker image sets the latter), then the usual install
    // locations for this platform, then Playwright's own download.
    executablePath: "",
    // "auto" runs headed whenever a display is available (`DISPLAY` set — the
    // container's entrypoint starts Xvfb and sets it) and headless otherwise.
    // Headed is what a real person's Chrome is, and headless remains the
    // single loudest automation signal, so prefer leaving this on "auto".
    // Force `true` only if your host cannot run Xvfb.
    headless: "auto" as "auto" | boolean,
    // Locale and IANA timezone reported to sites. Empty means "inherit
    // whatever Chrome derives from the container", which is the honest
    // answer. Set these only to match where this deployment actually egresses
    // from — a browser claiming Los Angeles from a German IP is a mismatch a
    // detector reads the same way it reads a spoofed user agent.
    locale: "",
    timezone: "",
    // Enter text and clicks the way a person does: type character by character
    // with small randomized gaps, and move the pointer to a control before
    // pressing it. The alternative — setting a field's value in one shot and
    // teleporting the cursor — is how automation frameworks drive a browser,
    // and login pages (X, Google, and the anti-bot vendors in front of them)
    // score exactly that. A form that receives a username and password with no
    // keystroke or pointer telemetry is read as a bot even when the browser is
    // otherwise an honest, real Chrome, which is why an AI Employee gets
    // challenged from the same IP a human signs in from cleanly. Leave this on.
    // Turn it off only for a trusted environment that wants raw speed and does
    // not meet human-facing anti-bot defenses.
    humanize: true as boolean,
  },

  // Global SMTP fallback for system-level sends (password resets, invites).
  // Leave host empty to disable — reset links then log to the console instead.
  // This block is the file-based default; operators can override it at runtime
  // from Admin → Email transport (stored in the DB, takes precedence over this).
  smtp: {
    host: "",
    port: 587,
    secure: false,
    user: "",
    pass: "",
    fromName: "Genosyn",
    from: "no-reply@genosyn.local",
  },

  // Third-party Integrations.
  //
  // Each entry configures a Connection *type* (Stripe, Gmail, Metabase, …).
  // Connections themselves are per-company DB rows; this block only carries
  // the globally-shared credentials the platform needs to broker OAuth.
  //
  // API-key integrations (Stripe, Metabase) need nothing here — the user
  // pastes their key when they create a Connection and it is encrypted at
  // rest. OAuth integrations (Gmail and friends) need a shared app ID +
  // secret registered with the provider, because the user's browser
  // redirects through *our* server on its way back from Google.
  //
  // The redirect URI is shown in Settings → Integrations and follows the
  // public URL saved under Admin → General.
  integrations: {
    google: {
      // Google Cloud OAuth client — leave empty to disable Gmail etc.
      // Create one at console.cloud.google.com under APIs & Services →
      // Credentials → OAuth 2.0 Client IDs (type: Web application).
      clientId: "",
      clientSecret: "",
    },
  },

  // Email section (M25) — Gmail mailbox sync tuning.
  //
  // Sync is poll-based (no Google Pub/Sub setup required): a 30s heartbeat
  // syncs every active mailbox whose last sync is older than
  // `syncIntervalSec`. The first import walks the ENTIRE mailbox (newest
  // first) so everything is searchable locally; it is resumable and runs in
  // bounded passes so it never blocks or hammers Gmail. After the backfill
  // completes, sync is incremental via the Gmail history API.
  mail: {
    // How often an up-to-date mailbox re-checks for new mail.
    syncIntervalSec: 60,
    // Per backfill pass: stop after this many threads or this many seconds,
    // then resume on the next heartbeat. Bounds each pass's Gmail API burst.
    backfillThreadsPerPass: 200,
    backfillPassSeconds: 25,
    // Only-recent cap. 0 = import the whole mailbox (the default — the point
    // is that nothing needs Gmail). Set to e.g. 365 to limit the first import
    // to the last year on a very large account.
    backfillDays: 0,
  },

  // Open-web tools for AI Employees: `search_web`, `fetch_web_page`, and
  // `download_web_file` (which saves a file — a blank tax form, a price
  // list — as a chat attachment the PDF and mail tools can then use).
  //
  // Every request goes through the same outbound guard as the rest of the
  // product (`security.outbound*`): http(s) only, no credentials in the URL,
  // and every hop re-validated against private, loopback and link-local
  // addresses. Fetched pages are DATA, never instructions — the employee's
  // system prompt says so, and tool results are labelled as untrusted.
  web: {
    // Master switch. false makes all three tools refuse with an explanation
    // instead of disappearing, so an employee can tell the human why.
    enabled: true,
    // Search backend. "duckduckgo" reads DuckDuckGo's no-JavaScript HTML
    // endpoint and needs no API key or account, which is the only kind of
    // default a self-hosted install can ship. "disabled" turns search off
    // and leaves direct fetches and downloads working.
    searchProvider: "duckduckgo" as "duckduckgo" | "disabled",
    maxSearchResults: 8,
    // Bytes a page fetch or download may pull. Below the 25 MB attachment
    // cap on purpose: a blank form is kilobytes, and anything larger is
    // usually a mis-clicked link.
    maxDocumentBytes: 10 * 1024 * 1024,
    // Characters of extracted page text handed to the model per fetch.
    maxTextChars: 20_000,
  },

  // Meetings (M42) — the calendar mirror and meeting transcription.
  //
  // Transcription deliberately has **no credential of its own**. It borrows the
  // notetaker employee's own AI Model row: an `openai` API key talks to
  // OpenAI's audio endpoint, and a `custom` endpoint talks to whatever
  // OpenAI-compatible server it points at — a local whisper.cpp or
  // faster-whisper, which is how a self-hoster keeps the audio in the building.
  // Anthropic models have no audio endpoint and say so rather than failing
  // obscurely. Nothing here is a secret, so nothing here needs the DB.
  meetings: {
    // Master switch. false leaves connected calendars in place and stops the
    // sync heartbeat, rather than hiding the section.
    enabled: true,
    // How often connected calendars are re-synced, in seconds. Google's
    // incremental syncToken makes a pass cheap, so this is deliberately brisk:
    // arming a notetaker for a meeting somebody moved 10 minutes ago is the
    // whole point.
    syncIntervalSeconds: 300,
    // The model name sent to `/v1/audio/transcriptions`. `whisper-1` is the
    // one name both OpenAI and every local OpenAI-compatible whisper server
    // answer to, which is what makes it the only sane default.
    transcriptionModel: "whisper-1",
    // Bytes of audio a single meeting recording may carry. Chosen to match the
    // 25 MB attachment ceiling used everywhere else in the app, and because
    // OpenAI's audio endpoint refuses larger uploads outright.
    maxRecordingBytes: 25 * 1024 * 1024,
  },
} as const;
