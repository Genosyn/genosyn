import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function SelfHosting() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="Configuration"
        lead={
          <>
            Boot settings live in <Code>App/config.ts</Code>. Settings that are safe to change while
            Genosyn is running, including its public URL, live in the database and are managed from
            Admin.
          </>
        }
      />

      <Callout kind="warn" title="No .env, ever.">
        Genosyn doesn&apos;t use <Code>dotenv</Code>, per-environment files, or a config service. If
        a tutorial or PR adds one, it&apos;s wrong. Override boot settings in the one config object;
        use Admin for live instance settings.
      </Callout>

      <H2 id="config-ts">config.ts</H2>
      <P>The shape, with the same comments you&apos;ll see in the file:</P>
      <Pre lang="ts">{`export const config = {
  // Where all user-generated data lives.
  dataDir: "./data",

  db: {
    // "sqlite" (default) or "postgres".
    driver: "sqlite",
    sqlitePath: "./data/app.sqlite",
    postgresUrl: "",
  },

  // HTTP port.
  port: 8471,

  // Default self-host installs replace this placeholder with a durable,
  // generated value under dataDir. An explicit 32+ character value wins.
  sessionSecret: "change-me-in-production",

  security: {
    multiTenant: false,
    // Managed separately from the cookie secret on default self-host installs.
    encryptionSecret: "change-me-in-production-too",
    previousEncryptionSecrets: [],
    secureCookies: "auto",
    sessionMaxAgeDays: 7,
    // The standard Docker deployment sits behind one reverse proxy.
    // Set 0 only when Genosyn is directly reachable.
    trustedProxyHops: 1,
    outboundPrivateHostAllowlist: [],
    outboundRequestTimeoutMs: 15_000,
    outboundMaxResponseBytes: 25 * 1024 * 1024,
    authRateLimit: { windowMinutes: 15, maxAttempts: 10, blockMinutes: 15 },
    // Exact mailbox authorized to bootstrap instance administration.
    bootstrapMasterAdminEmail: "operator@example.com",
  },

  agent: {
    codingTools: {
      enabled: true,
      // Command execution is on by default, and only ever behind bubblewrap.
      // Boot probes the sandbox and falls back to disabled where Linux user
      // namespaces are unavailable; it never falls back to host execution.
      executionMode: "bubblewrap",
      bubblewrapPath: "/usr/bin/bwrap", allowNetwork: false,
      allowUnsafeHostExecution: false,
    },
    browserEnabledInMultiTenant: false,
  },

  // Global SMTP fallback. Per-company EmailProvider rows take precedence.
  smtp: {
    host: "", port: 587, secure: false,
    user: "", pass: "",
    fromName: "Genosyn",
    from: "no-reply@genosyn.local",
  },

  // OAuth client credentials for integrations that need them.
  integrations: {
    google: { clientId: "", clientSecret: "" },
    // ...
  },
} as const;`}</Pre>
      <P>
        Genosyn does not impose a per-company ceiling on top-level AI work. Chats and Routine runs
        can overlap freely; only chat replies for the same AI Employee are serialized. Size the host
        and any worker replicas for the overlap Members and Routines can create, and monitor your AI
        Model provider&apos;s concurrency, token, spend, and rate limits. Provider-side throttling still
        applies.
      </P>
      <Callout kind="info" title="Command execution is on by default, behind bubblewrap.">
        The standard Docker image ships the <Code>bwrap</Code> executable, so an out-of-the-box
        install runs sandboxed <Code>bash</Code> and repository work without you deciding anything
        — and a ChatGPT subscription still signs in beside it on a trusted single-tenant install.
        Bubblewrap needs Linux unprivileged user namespaces, so Genosyn probes the sandbox at boot
        and falls back to <Code>disabled</Code> when it cannot start, logging the reason. In that
        mode there are no coding tools, no repository materialization, and no user-configured stdio
        MCP, and subscription Runs still work. The fallback never reaches for host execution.
        Separately acknowledged host mode exposes path-confined file and search tools and permits
        host child processes, so it rejects subscription auth.
      </Callout>
      <Callout kind="info" title="A container has to be created able to start that sandbox.">
        Bubblewrap creates a user namespace and mounts its own <Code>/proc</Code> for every command.
        Docker&apos;s stock profile denies both — the default seccomp filter rejects{" "}
        <Code>clone</Code> and <Code>unshare</Code> carrying the namespace flags, and its masked{" "}
        <Code>/proc</Code> entries are locked mounts a nested namespace may not mount over. So the
        container is created with{" "}
        <Code>--security-opt seccomp=unconfined --security-opt systempaths=unconfined</Code>, which
        the <DocLink to="/docs/cli">CLI</DocLink> passes for you; <Code>genosyn upgrade</Code> also
        recreates an older container that predates them. What that loosens is the App container,
        Genosyn&apos;s own process. What it buys is the stronger boundary around the untrusted part:
        each AI-authored command gets its own user, PID, IPC and UTS namespaces, a fresh{" "}
        <Code>/proc</Code>, no <Code>/sys</Code>, no network, and a filesystem view holding nothing
        but its workspace — and the container still runs unprivileged as <Code>node</Code> with no
        added capabilities. Never add <Code>--privileged</Code> or{" "}
        <Code>--cap-add SYS_ADMIN</Code> instead; those hand the container the host, and neither is
        needed. To keep the stock profile, install with <Code>GENOSYN_SANDBOX=0</Code> and run
        without command execution. If the sandbox still cannot start, the host itself is refusing
        unprivileged user namespaces: on Ubuntu 24.04 and later check{" "}
        <Code>kernel.apparmor_restrict_unprivileged_userns</Code> and keep Docker current, and on
        Debian check <Code>kernel.unprivileged_userns_clone</Code>.
      </Callout>
      <Callout kind="warn" title="Host execution is an explicit unsafe compatibility mode.">
        A trusted, single-company operator can select <Code>host</Code> and separately set{" "}
        <Code>allowUnsafeHostExecution: true</Code> to enable path-confined file/search tools and
        let Genosyn&apos;s repository Git operations run outside bubblewrap. AI Employees still
        receive no host shell, but the coding tools and server-owned Git children share the App
        process user&apos;s filesystem and network authority. Never use it for multiple companies or
        with untrusted Members, prompts, Skills, repositories, or content.
      </Callout>

      <H2 id="public-url">Public URL</H2>
      <P>
        Sign in as a master admin and open <Code>Admin → General</Code>. Set the exact origin
        Members use to reach Genosyn, for example <Code>https://genosyn.example.com</Code>. Genosyn
        stores it in the database and uses it for OAuth callbacks, WebAuthn, invitation and reset
        links, push notifications, and API documentation. A path, query, or fragment is not allowed.
      </P>
      <Callout kind="tip" title="Fresh installs detect it automatically.">
        The first successful verified master-admin browser sign-in saves the same-origin URL it
        arrived on. Review the value in <Code>Admin → General</Code> after putting Genosyn behind a
        reverse proxy; you can replace it without restarting the app.
      </Callout>

      <H2 id="db-driver">Switching to Postgres</H2>
      <P>
        Genosyn ships on SQLite by default — single file, zero install. To switch to Postgres, flip
        the driver and point at a connection URL:
      </P>
      <Pre lang="ts">{`db: {
  driver: "postgres",
  sqlitePath: "",
  postgresUrl: "postgresql://user:pass@host:5432/genosyn",
},`}</Pre>
      <P>
        All entities and migrations work on both drivers. On startup Genosyn calls{" "}
        <Code>AppDataSource.runMigrations()</Code> — any pending migrations apply automatically.
        SQLite and Postgres use separate generated migration streams. Postgres is required for
        shared SaaS; see <DocLink to="/docs/saas-hosting">Shared SaaS mode</DocLink>.
      </P>
      <Callout title="Upgrading private conversations">
        Older direct and Help conversations may predate private Member ownership. They remain hidden
        from ordinary Members after migration. Company owners and admins can open one and select{" "}
        <Strong>Claim conversation</Strong> after a sign-in from the last 15 minutes. Any
        unattributed turn that was still running during the upgrade is stopped safely and can be
        retried after the conversation is claimed. Pending manual Mail handovers from an older
        release also stop safely; retry one from its thread to authorize it with your current
        browser session.
      </Callout>

      <H2 id="data-dir">The data directory</H2>
      <P>
        Files created by tools — the SQLite file, materialized git checkouts, browser state, and
        uploaded attachments — live under <Code>dataDir</Code>. Souls, Skills, Routines, Run logs,
        model credentials, and Connection credentials live on encrypted/scoped database rows:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-slate-700">
        {`data/
├── .instance-secrets.json
├── .instance-secrets.required
├── .private/
│   ├── browser-state/<company-id>/<employee-id>.json
│   └── code-repository-ssh/<company-id>/<employee-id>.known_hosts
├── app.sqlite
└── companies/<co-slug>/employees/<emp-slug>/
    ├── repos/
    ├── code-repos/
    └── ...`}
      </pre>
      <P>
        In the Docker image, this is mounted at <Code>/app/data</Code>. The installer maps a named
        volume <Code>genosyn-data</Code> there — back that volume up and you&apos;ve backed up
        everything.
      </P>
      <Callout kind="warn" title="Back up the managed instance secrets with the database">
        When the stock placeholders remain, a default self-host install atomically creates strong,
        distinct values in <Code>data/.instance-secrets.json</Code> with file mode <Code>0600</Code>
        . Its non-secret <Code>.instance-secrets.required</Code> marker prevents a missing key from
        being replaced silently, and the database stores a matching non-secret key ID so replacing
        or losing both files stops startup. Keep the whole data directory together: losing the
        secret file makes data encrypted with its managed key unreadable. Never expose its values in
        logs, support bundles, employee working trees, or source control. Explicit strong values in{" "}
        <Code>config.ts</Code> remain supported and take precedence.
      </Callout>

      <H2 id="email">Email</H2>
      <P>
        Email transport is per-company: every <Code>Company</Code> can have one or more{" "}
        <Code>EmailProvider</Code> rows. Supported transports today:
      </P>
      <UL>
        <LI>
          <Strong>SMTP</Strong> via <Code>nodemailer</Code>.
        </LI>
        <LI>
          <Strong>SendGrid</Strong>, <Strong>Mailgun</Strong>, <Strong>Resend</Strong>,{" "}
          <Strong>Postmark</Strong> — REST-based, paste an API key.
        </LI>
      </UL>
      <P>
        System-level sends (password resets, invites, welcomes) and any company without its own
        provider fall back to a single <Strong>global SMTP transport</Strong>. Configure it in the
        app at <Code>Admin → Email transport</Code>: fill in the host, port, encryption, username,
        password, from name, and from address, then use <Code>Send test</Code> to confirm
        deliverability. The settings are stored in the database and take effect immediately — no
        restart. Until it&apos;s configured, the <Code>Admin → Overview</Code> and{" "}
        <Code>Instance Health</Code> dashboards flag Email transport with a warning, because those
        system emails only log to the server console and never reach a mailbox.
      </P>
      <P>
        A file-based default also exists: the <Code>smtp</Code> block in <Code>config.ts</Code>. The
        dashboard override takes precedence over it; clearing the override (the <Code>Reset</Code>{" "}
        button) reverts to whatever <Code>config.ts</Code> provides, and if that&apos;s blank too,
        to the console. When a global transport is configured either way, adding a company SMTP
        provider at <Code>Settings → Email</Code> pre-fills the host, port, encryption, username,
        and sender address from it — you only enter the password. Every send appends an{" "}
        <Code>EmailLog</Code> row that company owners and admins can read at{" "}
        <Code>Settings → Email Logs</Code>. Member-role accounts cannot read recipient addresses,
        subjects, delivery errors, or body previews. Bearer links such as company invitations are
        redacted from the stored preview.
      </P>

      <H2 id="oauth-apps">OAuth apps for the whole install</H2>
      <P>
        Integrations that sign in with OAuth — Google, GitHub, Microsoft, LinkedIn, Reddit, X —
        need a client registered with the provider. Left alone, every Connection has to bring its
        own, so the first person to connect a Gmail mailbox has to stand up a Google Cloud project
        before they can start.
      </P>
      <P>
        Do it once instead, at <Code>Admin → Integrations</Code>. Each provider card shows the exact
        redirect URI to allow-list (derived from the <Code>Public URL</Code> above, so set that
        first) and the ordered steps for that provider&apos;s console.
        Paste back the Client ID and Client Secret, and every company on the instance can connect
        that provider with a single click. Registering <Strong>Google</Strong> covers Google
        Workspace, Google Analytics, Search Console, and Google Ads at once.
      </P>
      <P>
        Secrets are encrypted at rest with the instance key and never returned to the browser; the
        page shows the Client ID and whether a secret is stored. Removing a registration only
        affects <em>new</em> Connections — existing ones keep the credentials they were created
        with and go on refreshing their tokens. Rotate the secret while keeping the same Client ID
        and a <Strong>Reconnect</Strong> moves an existing Connection onto it. Companies that need
        their own client pick <Strong>Use my own OAuth client instead</Strong> on the connect form,
        which takes precedence for that Connection.
      </P>

      <H2 id="secrets">Secrets and the Password Vault</H2>
      <P>
        Genosyn stores several kinds of sensitive value, each with a different lifecycle. In
        particular, environment Secrets and Password Vault items are separate products:
      </P>
      <KeyList
        rows={[
          {
            term: "sessionSecret",
            def: (
              <>
                Used to sign cookies. Default self-host placeholders resolve to the managed
                per-install value; an explicit strong <Code>config.ts</Code> value takes precedence.
                Rotation invalidates every session.
              </>
            ),
          },
          {
            term: "security.encryptionSecret",
            def: (
              <>
                Master for scoped AES-256-GCM data-encryption keys. Rotate by moving the old value
                into <Code>previousEncryptionSecrets</Code> while new writes use the new value.
                Default self-host placeholders resolve to the distinct managed encryption key.
              </>
            ),
          },
          {
            term: "Connection config",
            def: (
              <>
                Encrypted per-Connection blobs on <Code>IntegrationConnection.encryptedConfig</Code>{" "}
                (AES-256-GCM). Decrypted at tool-call time.
              </>
            ),
          },
          {
            term: "Environment Secret",
            def: (
              <>
                A <Code>Secret</Code> row is an encrypted key/value pair scoped to a company,
                editable from <Code>Settings → Secrets</Code>. It is surfaced to coding-tool
                environments and Pipelines by name. It has no human reveal flow or item-level AI
                Employee Grant.
              </>
            ),
          },
          {
            term: "Password Vault item",
            def: (
              <>
                A separate encrypted <Code>VaultItem</Code> for a login, API key, or secure note,
                managed from <Strong>Vault</Strong>. Member access and AI Employee Grants are set
                per item; AI browser autofill uses the value server-side instead of injecting it
                into an environment or returning it to the model. See{" "}
                <DocLink to="/docs/vault">Vault</DocLink>.
              </>
            ),
          },
        ]}
      />
      <H2 id="admin">Admin &amp; instance health</H2>
      <P>
        Install-wide operations live under the <Code>Admin</Code> section (your avatar menu →{" "}
        <Code>Admin</Code>) — separate from a single company&apos;s <Code>Settings</Code>. Because
        it spans every company on the deployment, it&apos;s gated to <Strong>master admins</Strong>:
        instance-level operators, a global flag on the user account that&apos;s distinct from the
        per-company <Code>owner</Code> / <Code>admin</Code> / <Code>member</Code> roles. On a fresh
        install, set <Code>security.bootstrapMasterAdminEmail</Code>, sign up with that exact
        address, and open its verification link. The account remains an ordinary Member until
        mailbox ownership is proven; being first to reach the public sign-up form grants no
        privilege. Verification revokes every earlier cookie, so sign in again. From{" "}
        <Code>Admin → Users</Code> an existing master admin can grant or revoke the flag on anyone
        else (you just can&apos;t revoke your own, so the install always keeps at least one
        operator). Since it&apos;s operator-only, <Code>Admin</Code> isn&apos;t advertised in the
        products section menu — reach it from your avatar menu.
      </P>
      <UL>
        <LI>
          <Strong>Overview</Strong> — an at-a-glance dashboard: instance health status, the running
          version and build, database driver, uptime and memory, and an inventory of companies,
          members, and AI employees.
        </LI>
        <LI>
          <Strong>Instance Health</Strong> — live probes of the deployment substrate: database
          connectivity and round-trip latency, pending schema migrations, a writable data directory,
          the backup story, and the email + Web Push transports. This is distinct from a
          company&apos;s <Code>Settings → System Health</Code>, which watches that company&apos;s
          routines, models, and integrations.
        </LI>
        <LI>
          <Strong>Migrations</Strong> — expands the Instance Health migrations probe into the full
          ledger: every schema migration, its state, and whether the database has drifted from the
          code. See <Code>Migrations</Code> below.
        </LI>
        <LI>
          <Strong>Database</Strong> — a raw SQL console over Genosyn&apos;s own application
          database. See <Code>Database console</Code> below.
        </LI>
        <LI>
          <Strong>Email transport</Strong> — configure the install-wide global SMTP server for
          system emails (password resets, invites), with a test send. See <Code>Email</Code> above.
        </LI>
        <LI>
          <Strong>Sign-ups</Strong> — an instance-wide toggle for self-service registration. See{" "}
          <Code>Sign-ups</Code> below.
        </LI>
        <LI>
          <Strong>SSO</Strong> — instance-wide single sign-on via Google or any OpenID Connect
          provider. Disabled by default. See <Code>SSO</Code> below.
        </LI>
        <LI>
          <Strong>Users</Strong> — every human member across every company, with their handle, how
          many companies they belong to, and which companies they own. Grant or revoke{" "}
          <Strong>master admin</Strong> on any user here to control who else can reach this
          dashboard. Delete an account from here to remove the person and everything scoped to them
          (memberships, API keys, notifications); content they authored is kept but unlinked. A user
          who still owns a company can&apos;t be deleted until you reassign or delete those
          companies first, and you can&apos;t delete your own account here.
        </LI>
        <LI>
          <Strong>Companies</Strong> — every company (tenant) on the instance, with its owner and
          member + AI-employee counts. Deleting one runs the same cascade as a company&apos;s own{" "}
          <Code>Delete company</Code> action — every employee, routine, message, note, and finance
          record it owns, plus its files on disk — so an operator can prune any tenant without
          switching into it first.
        </LI>
        <LI>
          <Strong>Backups</Strong> — see below.
        </LI>
      </UL>

      <H3 id="signups">Sign-ups</H3>
      <P>
        <Code>Admin → Sign-ups</Code> is an instance-wide toggle for self-service registration. Flip{" "}
        <Strong>Disable sign-ups</Strong> on and the public sign-up page stops accepting new
        accounts — anyone who lands on it sees a &ldquo;sign-ups are closed&rdquo; notice instead of
        the form, and the API refuses a registration attempt with a <Code>403</Code>. Existing
        members keep their accounts and can still sign in; this only stops <em>new</em> people from
        registering themselves.
      </P>
      <P>
        The configured <Code>bootstrapMasterAdminEmail</Code> remains eligible to register while
        sign-ups are disabled if the instance has no master admin. It receives no operator access
        until its email-verification link is used. After bootstrap, add people by promoting an
        existing account to <Strong>master admin</Strong> from <Code>Admin → Users</Code>, or by
        inviting them into a company from that company&apos;s <Code>Settings → Members</Code>.
      </P>

      <H3 id="sso">SSO</H3>
      <P>
        <Code>Admin → SSO</Code> adds single sign-on to the login page —{" "}
        <Strong>disabled by default</Strong>; a fresh install only offers email + password until a
        master admin turns it on. Pick <Strong>Google</Strong> or{" "}
        <Strong>Custom OpenID Connect</Strong> (Okta, Keycloak, Microsoft Entra ID, Auth0, or
        anything OIDC-compliant), then:
      </P>
      <UL>
        <LI>
          Register an OAuth client at your identity provider and set its authorized redirect URI to
          the <Strong>Callback URL</Strong> shown on the page (it follows the public URL saved at{" "}
          <Code>Admin → General</Code>).
        </LI>
        <LI>
          Paste the <Strong>Client ID</Strong> and <Strong>Client secret</Strong> into the form —
          the secret is stored encrypted and never shown again. For a custom provider, also enter
          the <Strong>Issuer URL</Strong>; <Code>Check issuer</Code> verifies the provider&apos;s
          discovery document before you commit.
        </LI>
        <LI>
          Flip <Strong>Enable SSO sign-in</Strong> and save. The login page grows a &ldquo;Continue
          with …&rdquo; button (the label is yours to override).
        </LI>
      </UL>
      <P>
        On first SSO sign-in an existing account with the same verified email is linked
        automatically; after that the identity provider&apos;s stable subject is what identifies the
        account, so an email change at either end won&apos;t orphan it. With{" "}
        <Strong>Create accounts on first sign-in</Strong> on (the default), people your identity
        provider admits get a Genosyn account automatically — turn it off to admit only people who
        already have an account or an invitation. Password login keeps working either way, so
        enabling (or later resetting) SSO can never lock an operator out.
      </P>

      <H3 id="db-console">Database console</H3>
      <P>
        <Code>Admin → Database</Code> is a raw SQL console wired directly to Genosyn&apos;s own
        application database — the same SQLite or Postgres the app itself runs on. It is meant for
        operators who need to inspect or repair an install directly: check a row the UI doesn&apos;t
        surface, audit what an AI employee wrote, or fix up data after a botched import. Distinct
        from <DocLink to="/docs/explore">Explore</DocLink>, which runs SQL against a company&apos;s{" "}
        <em>external</em> database integrations.
      </P>
      <UL>
        <LI>
          <Strong>Schema browser</Strong> — every table with its live row count down the left. Click
          a table to load a <Code>SELECT *</Code>; expand one to see its columns (primary keys
          flagged) and click a column to drop its name into the editor.
        </LI>
        <LI>
          <Strong>Read-only by default</Strong> — the console runs one statement at a time and
          refuses anything that isn&apos;t plainly a read. To run an <Code>INSERT</Code> /{" "}
          <Code>UPDATE</Code> / <Code>DELETE</Code> or DDL you must first flip{" "}
          <Strong>Allow writes</Strong>, which surfaces a standing warning — these statements change
          the live database permanently, so take a{" "}
          <DocLink to="/docs/self-hosting#backups">backup</DocLink> first if you are unsure.
        </LI>
        <LI>
          <Strong>Results</Strong> — a scrollable grid with the row count and elapsed time; long
          result sets are capped (100–5,000 rows, your choice) and flagged when truncated. Recent
          queries are kept under the <Code>History</Code> tab. Press <Code>⌘↵</Code> /{" "}
          <Code>Ctrl↵</Code> to run.
        </LI>
      </UL>

      <H3 id="migrations">Migrations</H3>
      <P>
        <Code>Admin → Migrations</Code> is a read-only ledger of every TypeORM schema migration —{" "}
        <Code>Total</Code> / <Code>Applied</Code> / <Code>Pending</Code> / <Code>Unknown</Code>{" "}
        tiles over the full list. Nothing runs from here: boot applies pending migrations
        automatically, so this is the detail view behind the Instance Health probe.
      </P>
      <UL>
        <LI>
          <Strong>Applied</Strong> — recorded in the database, in the order they ran. Each shows
          when it was <em>authored</em>, not when it ran — TypeORM&apos;s migrations table records
          no such timestamp.
        </LI>
        <LI>
          <Strong>Pending</Strong> — shipped but not applied. A healthy instance has none, so
          anything pending points at a migration that failed at boot; read that boot&apos;s server
          log.
        </LI>
        <LI>
          <Strong>Drift</Strong> — the database disagrees with the code. <Strong>Unknown</Strong> is
          a migrations-table row matching no shipped migration file (a downgrade, or a hand-edited
          database); <Strong>out-of-order</Strong> is an older migration applied after a newer one
          (usually a branch merge). Take a <DocLink to="/docs/self-hosting#backups">backup</DocLink>{" "}
          before repairing either.
        </LI>
      </UL>

      <H2 id="backups">Backups</H2>
      <P>
        A backup zips the <em>entire</em> data directory — every company&apos;s rows, uploads, and
        credentials, including the hidden managed <Code>.instance-secrets.json</Code> file — so it
        is install-wide, not per company. Run one from the CLI:
      </P>
      <Pre lang="bash">{`genosyn backup --out ~/backups/genosyn-$(date +%F).tar.gz
genosyn restore ~/backups/genosyn-2026-04-22.tar.gz`}</Pre>
      <P>
        Or drive it in-app at <Code>Admin → Backups</Code>: back up now, upload an existing{" "}
        <Code>.zip</Code> to restore from, download or restore any past archive, and set a recurring
        schedule (daily / weekly / monthly at a chosen hour) backed by the{" "}
        <Code>BackupSchedule</Code> row. See <DocLink to="/docs/cli">CLI reference</DocLink> for the
        flag list.
      </P>

      <P>
        A backup is written to a temporary <Code>.part</Code> file and moved into place only once it
        is complete, so a <Code>.zip</Code> in <Code>data/Backup/</Code> is always a whole archive —
        never a half-one left by a container restart or an OOM kill. If a backup is interrupted,
        History keeps showing it as <Code>running</Code> and the leftover <Code>.part</Code> is
        swept on the next start. Restoring also opens the archive before it touches anything, so a
        damaged file is refused up front rather than part-way through replacing your data.
      </P>
      <Callout kind="warn" title="Treat every backup like the live Vault">
        Every archive contains both encrypted credentials and the installation key that can decrypt
        them, so it is a plaintext-equivalent secret bundle. Genosyn creates local in-app, mounted
        path, and CLI archives with file mode <Code>0600</Code>, but you must still restrict who can
        read, copy, or restore them. TLS or SSH protects a backup while it is moving; it does not
        encrypt the archive after it reaches its destination.
      </Callout>

      <H3 id="off-box-destinations">Off-box destinations (NAS / remote volumes)</H3>
      <P>
        Backups live in <Code>data/Backup/</Code> by default — on the same disk as everything else.
        Add one or more <Strong>off-box destinations</Strong> under{" "}
        <Code>Admin → Backups → Off-box destinations</Code> and every completed backup is mirrored
        there automatically. Three kinds:
      </P>
      <UL>
        <LI>
          <Strong>Mounted path</Strong> — a filesystem path Genosyn can already write to. Mount your
          NAS share (SMB / NFS / iSCSI) on the host or bind-mount it into the container, then point
          the destination at that path (for example <Code>/mnt/nas/genosyn</Code>). The kernel
          handles the protocol; Genosyn just copies the archive. Still the simplest option when you
          are able to mount the share.
        </LI>
        <LI>
          <Strong>SMB / CIFS</Strong> — push straight to a Windows or NAS share with{" "}
          <em>no mount required</em>. Enter the host, share, an optional folder within it, and a
          username, password, and optional domain. For when bind-mounting is not available to you —
          a locked-down Kubernetes cluster, or a host where you cannot mount CIFS. Genosyn
          negotiates SMB3 and signs the connection; leave <Code>Encrypt in transit</Code> on (the
          default) so the archive is not readable on your network, and turn it off only for a NAS
          that predates SMB3.
        </LI>
        <LI>
          <Strong>SFTP / SSH</Strong> — push to a remote host with no mount required. Enter the
          host, port, username, and a password or private key. Good for appliance NASes (Synology,
          QNAP, TrueNAS) that expose SSH but are awkward to bind-mount.
        </LI>
      </UL>
      <P>
        Credentials for the SMB and SFTP kinds are encrypted at rest with the same AES-256-GCM
        helper used for model API keys, and are never returned to the browser.
      </P>
      <P>
        Use <Code>Test</Code> on a destination to confirm it is reachable and writable, toggle{" "}
        <Code>Enabled</Code> to pause mirroring without deleting it, and use <Code>Send</Code> next
        to any archive in History to push an existing backup on demand. Delivery is best-effort: a
        mirror that fails is flagged on the destination with the error, but never fails the backup
        itself, which is already safe in <Code>data/Backup/</Code>.
      </P>

      <H3 id="retention">Retention (deleting old backups)</H3>
      <P>
        Left alone, <Code>data/Backup/</Code> grows forever. Tick{" "}
        <Code>Automatically delete old backups</Code> under <Code>Admin → Backups → Retention</Code>{" "}
        and set a number of days: anything older is deleted. Genosyn checks hourly and again
        straight after every backup, so a window that lapses at midday is honoured at midday.
      </P>
      <P>
        Retention is <em>independent of the recurring schedule</em> — it covers every archive in{" "}
        <Code>data/Backup/</Code>, including ones you made by hand with <Code>Back up now</Code>,
        and it runs even when the schedule is off. Two things are always spared, on the principle
        that a retention setting must never leave you with nothing to restore from:
      </P>
      <UL>
        <LI>
          <Strong>The newest completed archive</Strong> — kept however old it is. If backups stop
          running for a year, the last one survives. Should that archive turn out not to open, the
          newest one that <em>does</em> open is kept as well, so an unreadable file can never cost
          you the last archive you could actually restore from.
        </LI>
        <LI>
          <Strong>Archives you uploaded</Strong> through <Code>Admin → Backups</Code> — you carried
          those in from somewhere else and they may be the only copy. Delete them by hand when you
          are done with them.
        </LI>
      </UL>
      <P>
        Retention is <Strong>local only</Strong>. Copies already delivered to an{" "}
        <DocLink to="/docs/self-hosting#off-box-destinations">off-box destination</DocLink> stay on
        the remote — Genosyn never reaches onto your NAS to delete things. Prune those with whatever
        your NAS or a cron job on that host already offers.
      </P>

      <H2 id="upgrading">Upgrading</H2>
      <P>
        CLI installs schedule <Code>genosyn upgrade</Code> automatically every day at 03:17 local
        time. The command self-upgrades the CLI, pulls the latest image, and retains the previous
        container until the new version becomes ready. A failed start restarts the previous version
        with the current data volume. Backups are off by default; run{" "}
        <Code>genosyn upgrade --backup</Code> for a manual upgrade that also writes a verified
        archive under <Code>~/.genosyn/backups</Code> and restores it on failure. Check or change
        the schedule with <Code>genosyn auto-update status</Code>,{" "}
        <Code>genosyn auto-update off</Code>, or <Code>genosyn auto-update on</Code>. You can also
        upgrade immediately by rerunning the installer:
      </P>
      <Pre lang="bash">{`curl -fsSL https://genosyn.com/install.sh | bash`}</Pre>

      <H3 id="ports-and-reverse-proxies">Ports and reverse proxies</H3>
      <P>
        The container listens on <Code>8471</Code>. Stick a reverse proxy (Caddy, nginx, Traefik) in
        front of it for TLS and a real hostname. Then save that HTTPS origin at{" "}
        <Code>Admin → General</Code> so the app generates absolute links and OAuth callbacks
        correctly.
      </P>
    </>
  );
}
