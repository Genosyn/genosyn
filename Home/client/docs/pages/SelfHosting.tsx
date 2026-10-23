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
            A short list of boot settings lives in <Code>App/config.ts</Code>. Everything an
            operator can safely change while Genosyn is running lives in the database and is edited
            from Admin, with no restart.
          </>
        }
      />

      <Callout kind="warn" title="No .env, ever.">
        Genosyn doesn&apos;t use <Code>dotenv</Code>, per-environment files, or a config service. If
        a tutorial or PR adds one, it&apos;s wrong. Override boot settings in the one config object;
        use Admin for everything else.
      </Callout>

      <H2 id="config-ts">config.ts</H2>
      <P>
        The file holds three kinds of thing and nothing else: <Strong>secrets</Strong>,{" "}
        <Strong>database coordinates</Strong>, and the <Strong>fail-closed security posture</Strong>{" "}
        that startup validation checks before the process accepts a request. Here are those
        settings, with the comments you&apos;ll see in the file:
      </P>
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
      // "host": commands run directly on the host with the App process
      // user's authority; there is no OS sandbox. "disabled": no coding tools.
      executionMode: "host",
      allowUnsafeHostExecution: true,
    },
  },
} as const;`}</Pre>

      <P>
        Genosyn does not impose a per-company ceiling on top-level AI work. Chats and Routine runs
        can overlap freely, including several conversations with one AI Employee; only replies
        within a single thread are serialized. Size the host and any worker replicas for the overlap
        Members and Routines can create, and monitor your AI Model provider&apos;s concurrency,
        token, spend, and rate limits. Provider-side throttling still applies.
      </P>
      <Callout kind="info" title="OpenCode and host coding are enabled by default.">
        The App image includes pinned OpenCode. Genosyn starts it automatically for API-key and
        custom models and enables native coding tools for ordinary employee work. AI Employee
        commands — OpenCode&apos;s coding tools, Genosyn&apos;s command tools, Repository
        work-session commands, command Checks, and server-managed Git — run directly on the host,
        inside the App container in Docker, with the App process user&apos;s filesystem and network
        authority. The container keeps Docker&apos;s standard security profile. ChatGPT
        subscription models keep using the official Codex app-server.
      </Callout>
      <P>
        A working directory, tool permission, command allowlist, or Grant is not an OS sandbox, and
        Genosyn has no isolation mode. To stop command execution, select{" "}
        <Code>executionMode: &quot;disabled&quot;</Code>: Genosyn then exposes no coding tools,
        materializes no employee repositories, and omits company-configured stdio MCP servers; HTTP
        MCP servers remain available. An existing <Code>allowUnsafeHostExecution: false</Code>{" "}
        opt-out remains effective. Restricted review turns omit coding, and Repository work sessions
        always use Genosyn&apos;s scoped tools, command policy, and delivery controls.
      </P>
      <P>
        A configuration that still selects the removed <Code>bubblewrap</Code> mode starts with
        command execution disabled and logs a warning. Set <Code>executionMode</Code> to{" "}
        <Code>&quot;host&quot;</Code> or <Code>&quot;disabled&quot;</Code> explicitly.
      </P>

      <H3 id="runtime-settings">Everything else is in the database</H3>
      <P>
        Operational settings are not in this file. An operator should never have to edit a file and
        restart a container to change how often a mailbox polls, so those settings live in the{" "}
        <Code>AppSetting</Code> table and are edited by a master admin in the dashboard. Changes
        take effect immediately on the replica that saved them and within 30 seconds on every other
        one — no restart, no redeploy.
      </P>
      <KeyList
        rows={[
          {
            term: "Admin → Runtime",
            def: (
              <>
                <Strong>Web tools</Strong> (on/off, search provider, result and document limits),{" "}
                <Strong>Mail sync</Strong> (poll interval, backfill pacing and window),{" "}
                <Strong>Hosted sign-in</Strong> (Genosyn Connect on or off, its URL, and its live
                status),{" "}
                <Strong>Meetings</Strong> (on/off, sync interval, transcription model, recording
                size cap), <Strong>Browser</Strong> (executable path, headless, locale, timezone,
                humanized input, how long Routine recordings are kept),{" "}
                <Strong>Agent</Strong> (taint policy, member browsers, tool
                discovery), <Strong>Containment</Strong> (the re-grade sweep), and{" "}
                <Strong>Outbound network</Strong> (the private-host allowlist). Each section starts
                as one collapsed line that reads <Strong>Defaults</Strong> or, say,{" "}
                <Strong>3 customized</Strong>; open one to edit it, save it on its own, or choose{" "}
                <Strong>Reset to defaults</Strong>. A field almost nobody changes, such as the
                Genosyn Connect service URL, sits under the section&apos;s own{" "}
                <Strong>Advanced</Strong>.
              </>
            ),
          },
          {
            term: "Admin → Email transport",
            def: <>The install-wide global SMTP server, stored encrypted. See below.</>,
          },
          {
            term: "Admin → General",
            def: <>The browser-facing public URL and custom browser JavaScript. See below.</>,
          },
          {
            term: "Admin → Integrations",
            def: <>OAuth client credentials for the whole install. See below.</>,
          },
        ]}
      />
      <Callout kind="tip" title="Upgrading from an older release keeps your settings.">
        Earlier versions carried <Code>smtp</Code>, <Code>web</Code>, <Code>mail</Code>,{" "}
        <Code>meetings</Code>, <Code>browser</Code>, and the agent knobs in <Code>config.ts</Code>.
        If yours still does — including a Kubernetes ConfigMap rendering the old file — the first
        boot after upgrading copies each block into its database row once and logs what it imported.
        The values you had are the values you keep, and they are editable in Admin from then on. A
        block already saved in Admin is never overwritten, and the leftover keys in the file are
        simply ignored.
      </Callout>

      <H3 id="private-hosts">Reaching something on your own network</H3>
      <P>
        Genosyn refuses any outbound request that resolves to a loopback, private, or link-local
        address, which is what stops a Connection form or a fetched page from being pointed at your
        internal network. Redirects are checked again, and so is DNS when the socket connects, so a
        public name cannot be rebound to a private address. A self-hosted Forgejo at{" "}
        <Code>git.internal</Code>, or a model endpoint at <Code>10.0.0.5</Code>, is caught by that
        same rule. List those hosts, one per line, under <Strong>Outbound network</Strong> at{" "}
        <Code>Admin → Runtime</Code> and they become reachable within about 30 seconds — no file
        to edit, no container to restart.
      </P>
      <P>
        This policy covers Genosyn&apos;s own requests. Commands an AI Employee runs in host mode
        use the App container&apos;s network directly and are not filtered by it.
      </P>
      <Callout kind="warn" title="An allowlisted host is exempt from the check, permanently.">
        Everything an AI Employee can be talked into fetching can reach a host on this list, so add
        one only when you mean employees to reach it — and prefer the narrowest hostname over a
        whole internal domain. The list is empty on a fresh install. Hosts set in{" "}
        <Code>security.outboundPrivateHostAllowlist</Code> in <Code>config.ts</Code> keep working as
        well; the two lists are combined.
      </Callout>

      <H3 id="http-proxy">Sending outbound traffic through a proxy</H3>
      <P>
        If your network only lets traffic out through an HTTP proxy, set the standard{" "}
        <Code>HTTPS_PROXY</Code>, <Code>HTTP_PROXY</Code>, and <Code>NO_PROXY</Code> variables on
        the App container. In Kubernetes, add them to the chart&apos;s <Code>env</Code> value. With
        the Docker installer, add a <Code>proxies</Code> block to <Code>~/.docker/config.json</Code>{" "}
        and Docker sets them on each container it creates from then on, such as the one{" "}
        <Code>genosyn install</Code> or an upgrade to a new release starts. Genosyn reads them at
        startup. Its own HTTP requests (model providers, web tools, Integrations) then go through
        the proxy, except for hosts listed in <Code>NO_PROXY</Code>. Loopback never goes through the
        proxy, and IMAP and SMTP connections always go directly.
      </P>
      <P>
        A proxy resolves the names it carries, so for those requests Genosyn checks the address when
        it validates the URL but not again when the socket connects. Have the proxy refuse private
        and link-local destinations as well. List internal hosts, such as a Forgejo at{" "}
        <Code>git.internal</Code> or an Ollama on your LAN, in <Code>NO_PROXY</Code> so Genosyn
        reaches them directly. If the proxy inspects TLS, point <Code>NODE_EXTRA_CA_CERTS</Code> at
        its CA certificate.
      </P>

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

      <H2 id="custom-javascript">Custom JavaScript</H2>
      <P>
        Open <Code>Admin → General → Custom JavaScript</Code> to add Google Tag Manager, Google
        Analytics, or another trusted browser script. Paste either raw JavaScript or the complete
        vendor snippet with its <Code>&lt;script&gt;</Code> elements; an external script element
        must use HTTPS and include <Code>async</Code>. Select <Strong>Save changes</Strong>. It runs
        on the next eligible signed-in App page load without a restart. Clear the field and save
        again to disable it.
      </P>
      <Callout kind="warn" title="Custom code has every Member's browser authority.">
        It can read the page and make same-origin requests as whoever is signed in. Use only code
        you trust, never place a secret in the field, and load third-party bundles over HTTPS.
        Genosyn does not start custom code on login, sign-up, reset, verification, invitation,
        signing, or chat-link page loads. If a broken snippet disrupts the App, load any page with
        <Code>?safe=1</Code>, return to Admin → General, and clear it.
      </Callout>
      <P>
        This setting measures the Genosyn App itself. It is separate from a Google Analytics{" "}
        <Strong>Connection</Strong>, which gives granted AI Employees read-only access to a
        company&apos;s GA4 reporting data.
      </P>

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
        SQLite and Postgres use separate generated migration streams. Built-in backups do not
        include a Postgres database; see <DocLink to="/docs/self-hosting#backups">Backups</DocLink>.
      </P>
      <Callout title="Upgrading private conversations">
        Older direct and Help conversations may predate private Member ownership. They remain hidden
        from ordinary Members after migration. Company owners and admins can open one and select{" "}
        <Strong>Claim conversation</Strong> from any valid browser session. Any unattributed turn
        that was still running during the upgrade is stopped safely and can be retried after the
        conversation is claimed. Pending manual Mail handovers from an older release also stop
        safely; retry one from its thread to authorize it with your current browser session.
      </Callout>

      <H2 id="data-dir">The data directory</H2>
      <P>
        Files created by tools — the SQLite file, materialized git checkouts, browser state, and
        uploaded attachments — live under <Code>dataDir</Code>. Routine browser recordings are
        App-private files there too. Souls, Skills, Routines, Run logs, model credentials, and
        Connection credentials live on encrypted/scoped database rows:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-2xl border border-line bg-paper-raised px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-ink-600">
        {`data/
├── .instance-secrets.json
├── .instance-secrets.required
├── .private/
│   ├── browser-state/<company-id>/<employee-id>.profile/
│   ├── browser-state/<company-id>/<employee-id>.json
│   ├── browser-recordings/<company-id>/<run-id>/
│   ├── code-repository-ssh/<company-id>/<employee-id>.known_hosts
│   └── recruiting/<company-id>/   # applicants' resumes and the careers site logo
├── app.sqlite            # plus app.sqlite-wal / -shm while the App runs
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
      <P>
        SQLite runs in write-ahead-log mode, so while the App is running its most recent writes sit
        in <Code>app.sqlite-wal</Code> beside the database. Copy the whole directory rather than{" "}
        <Code>app.sqlite</Code> on its own; a clean stop folds the log back into{" "}
        <Code>app.sqlite</Code>.
      </P>
      <P>
        Each file under <Code>.private/browser-recordings</Code> is a silent MP4 from one browser
        session that a Routine Run actually used. Parallel browser work may create several files for
        one Run, so recording-heavy Routines can materially increase storage and backup size. These
        files are capped at 2 GiB each; that includes ample headroom for the longest supported
        six-hour Run at the recording bitrate. If an encoder stops before the browser session ends,
        Genosyn marks the recording unavailable rather than publishing a truncated video. These
        files never enter an AI Employee&apos;s working tree. Genosyn deletes each one 7 days after
        it finishes, keeping the Run and its log, and checks hourly. To keep them longer, set{" "}
        <Strong>Keep browser recordings</Strong> at <Code>Admin → Runtime → Browser</Code>;{" "}
        <Code>0</Code> keeps them until the owning Routine or company is deleted. The first check
        runs as Genosyn starts, so upgrading to a release with this setting removes recordings
        already past the window right away.
      </P>
      <Callout kind="info" title="Source installs need ffmpeg and ffprobe">
        The standard Docker image includes <Code>ffmpeg</Code> for encoding browser recordings and{" "}
        <Code>ffprobe</Code> for validating recoverable recordings. They are normally installed
        together. If you run the App directly from source, make sure both are on <Code>PATH</Code>.
        A missing encoder leaves the Run and its log intact, but its browser recording is shown as
        unavailable.
      </Callout>
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
        The dashboard is the only place this transport is configured — there is no file-based
        fallback any more, and clearing it (the <Code>Reset</Code> button) sends system mail back to
        the server console. That console fallback is deliberate and useful: on a brand-new install
        the bootstrap master admin&apos;s own verification link prints there, which is how you claim
        the first operator account before any mail server exists. When a global transport is
        configured, adding a company SMTP provider at <Code>Settings → Email</Code> pre-fills the
        host, port, encryption, username, and sender address from it — you only enter the password.
        Every send appends an <Code>EmailLog</Code> row that company owners and admins can read at{" "}
        <Code>Settings → Email Logs</Code>. Member-role accounts cannot read recipient addresses,
        subjects, delivery errors, or body previews. Bearer links such as company invitations are
        redacted from the stored preview.
      </P>

      <H2 id="oauth-apps">OAuth apps for the whole install</H2>
      <P>
        Gmail needs no OAuth app of your own: open <Strong>Email</Strong>, enter your address, and
        choose <Strong>Continue with Google</Strong>.{" "}
        <DocLink to="/docs/connect">Genosyn Connect</DocLink> handles sign-in and token renewal;
        reading and sending mail happen directly between your installation and Google, and email
        content never passes through Connect. Credentials are stored encrypted locally, and the
        refresh token is sent to Connect only to renew access. Your installation needs outbound
        HTTPS to the service; Connect never connects to your installation.
      </P>
      <P>
        <Code>Admin → Runtime → Hosted sign-in</Code> controls it and shows, live, whether the
        service answers and what it offers. The default service is{" "}
        <Code>https://connect.genosyn.com</Code>. Turning off <Strong>Use Genosyn Connect</Strong>{" "}
        prevents new sign-ins through it without revoking existing Connections, which keep renewing
        through their original service even if you change the URL. To run the service yourself,
        see <DocLink to="/docs/connect#run-your-own">Running your own Genosyn Connect</DocLink>.
      </P>
      <P>
        To use your own Google app instead — or for Google products Connect does not offer, and for
        GitHub, Microsoft, LinkedIn, Reddit and X — register an app at{" "}
        <Code>Admin → Integrations</Code>. A registered app always takes precedence over Connect.
        Each provider card shows the exact
        redirect URI to allow-list (derived from the <Code>Public URL</Code> above, so set that
        first) and the ordered steps for that provider&apos;s console. Paste back the Client ID and
        Client Secret, and every company on the instance can connect that provider with a single
        click. Registering <Strong>Google</Strong> covers Google Workspace, Google Analytics, Search
        Console, and Google Ads at once.
      </P>
      <P>
        Secrets are encrypted at rest with the instance key and never returned to the browser; the
        page shows the Client ID and whether a secret is stored. Removing a registration only
        affects <em>new</em> Connections — existing ones keep the credentials they were created with
        and go on refreshing their tokens. Rotate the secret while keeping the same Client ID and a{" "}
        <Strong>Reconnect</Strong> moves an existing Connection onto it. Companies that need their
        own client pick <Strong>Use my own OAuth client instead</Strong> on the connect form, which
        takes precedence for that Connection.
      </P>

      <H2 id="secrets">Secrets and the Vault</H2>
      <P>
        Genosyn stores several kinds of sensitive value, each with a different lifecycle. In
        particular, environment Secrets and Vault items are separate products:
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
            term: "Vault item",
            def: (
              <>
                A separate encrypted <Code>VaultItem</Code> for a login, API key, or secure note,
                managed from <Strong>Vault</Strong>. A login can also own an encrypted TOTP setup
                key and software passkeys. Member access and AI Employee Grants are set per item; AI
                browser actions use credential material server-side instead of injecting it into an
                environment or returning it to the model. See{" "}
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
        privilege. Verification revokes every earlier cookie, so sign in again. If that link was
        missed or has expired, sign in and press <Strong>Resend verification email</Strong> at{" "}
        <Strong>Account → Profile</Strong> — the page shows whether the address is verified, and, on
        an install with no email transport, says the fresh link went to the server log rather than
        claiming it was sent. From <Code>Admin → Users</Code> an existing master admin can grant or
        revoke the flag on anyone else (you just can&apos;t revoke your own, so the install always
        keeps at least one operator). Since it&apos;s operator-only, <Code>Admin</Code> isn&apos;t
        advertised in the products section menu — reach it from your avatar menu.
      </P>
      <UL>
        <LI>
          <Strong>Overview</Strong> — an at-a-glance dashboard: instance health status, the running
          version and build, database driver, uptime and memory, and an inventory of companies,
          members, and AI Employees.
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
          <Strong>Runtime</Strong> — the operational knobs that used to live in{" "}
          <Code>config.ts</Code>: web tools, mail sync pacing, meetings, the container&apos;s
          browser, and the agent&apos;s taint policy, member browsers, and tool discovery. Each
          section starts collapsed, saying whether anything in it differs from the defaults; open
          one to edit it. Each saves independently and can be reset to its default; changes take
          effect within 30 seconds without a restart. See <Code>config.ts</Code> above.
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
          <Strong>Backups</Strong> — whether the install is backed up, where each backup lives,
          and restoring one; see <DocLink to="/docs/backups">Backups</DocLink>.
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
        until its email-verification link is used. After bootstrap, add people yourself from{" "}
        <Code>Admin → Users → Add user</Code> (see <DocLink to="/docs/self-hosting#users">Users</DocLink>{" "}
        below), or invite them into a company from that company&apos;s{" "}
        <Code>Settings → Members</Code>. Promote an existing account to{" "}
        <Strong>master admin</Strong> from <Code>Admin → Users</Code>.
      </P>
      <P>
        A new Member follows the invitation email and chooses <Strong>Create account</Strong>. That
        form stays available when public sign-ups are closed, for that invitation&apos;s email
        address only. Genosyn then returns them to the invitation, where they choose{" "}
        <Strong>Accept invitation</Strong>. Registering does not consume the invitation or add a
        company membership. An expired invitation needs to be replaced by an owner or admin.
      </P>

      <H3 id="users">Users</H3>
      <P>
        <Code>Admin → Users</Code> lists every account on the install. <Strong>Add user</Strong>{" "}
        creates one by hand — useful when sign-ups are closed, when the install has no email
        transport, or when people should not have to register themselves. Enter their name and
        email, then choose how they get their first password:
      </P>
      <UL>
        <LI>
          <Strong>Let them choose it</Strong> (the default) — the account gets a one-time setup
          link that expires in 7 days. Genosyn emails it to them and also shows it to you, with a{" "}
          <Strong>Copy</Strong> button, so you can pass it on yourself when nothing was emailed.
        </LI>
        <LI>
          <Strong>Set it now</Strong> — choose their first password (at least 12 characters) and
          give it to them yourself. They can change it later under <Code>Account → Profile</Code>.
        </LI>
      </UL>
      <P>
        Pick a <Strong>Company</Strong> to add them straight in as a <Code>Member</Code> or an{" "}
        <Code>Admin</Code> — the company is chosen for you when the install has only one — or
        leave it at <Strong>No company yet</Strong> and invite them later. The add is recorded in
        that company&apos;s audit log. An account added here starts unverified, like one that
        signed up, and is never a company owner or a master admin until you make it one.
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
      <P>
        Companies can also sign their Members in through their own identity provider, with their
        own login URL, at <Strong>Settings → Single sign-on</Strong> — see{" "}
        <DocLink to="/docs/security#company-sso">Company single sign-on</DocLink>. A master admin
        allows that first with <Strong>Let companies use their own identity provider</Strong>{" "}
        under <Strong>Company single sign-on</Strong> on the same page. It is off by default:
        each company admin&apos;s provider can then sign that company&apos;s Members in to their
        whole account, so turn it on only if you trust every company admin on the install with
        that.
      </P>

      <H3 id="db-console">Database console</H3>
      <P>
        <Code>Admin → Database</Code> is a raw SQL console wired directly to Genosyn&apos;s own
        application database — the same SQLite or Postgres the app itself runs on. It is meant for
        operators who need to inspect or repair an install directly: check a row the UI doesn&apos;t
        surface, audit what an AI Employee wrote, or fix up data after a botched import. Distinct
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
        A backup copies the <em>entire</em> data directory — every company&apos;s rows, uploads, and
        credentials, including the hidden managed <Code>.instance-secrets.json</Code> file — so it
        is install-wide, not per company. On Postgres the database lives outside that directory:
        back it up separately with <Code>pg_dump</Code> or your provider&apos;s backups, from the
        same point in time.
      </P>
      <P>
        <Code>Admin → Backups</Code> says whether the install is backed up, takes a backup on a
        schedule or with <Code>Back up now</Code>, copies every backup to off-box destinations
        such as a NAS, and lists where each backup lives. See{" "}
        <DocLink to="/docs/backups">Backups</DocLink> for the whole page, and the{" "}
        <DocLink to="/docs/cli">CLI reference</DocLink> for <Code>genosyn backup</Code> and{" "}
        <Code>genosyn restore</Code>.
      </P>

      <H2 id="upgrading">Upgrading</H2>
      <P>
        CLI installs schedule <Code>genosyn upgrade</Code> automatically every day at 03:17 local
        time. Each run first updates its own{" "}
        <DocLink to="/docs/cli#automatic-updates">copy of the CLI</DocLink>, which needs no{" "}
        <Code>sudo</Code> even when <Code>/usr/local/bin/genosyn</Code> belongs to root, then pulls
        the latest image and retains the previous container until the new version becomes ready.
        Before it restarts, it pauses running Routine Runs — each saves its progress and waits in
        the queue — and the upgraded version continues them where they stopped (
        <DocLink to="/docs/cli#upgrade-drain">details</DocLink>). Every upgrade, scheduled or by
        hand, first writes a verified archive of the data volume under{" "}
        <Code>~/.genosyn/backups</Code> while Genosyn keeps running, replacing the previous
        upgrade&apos;s, and restores it if
        the new version fails to start. When the archive would not fit, the upgrade first clears
        Docker&apos;s build cache and unused untagged images, never volumes, and one that still has
        no room stops without changing Genosyn (
        <DocLink to="/docs/cli#upgrade-with-backup">details</DocLink>). Pass{" "}
        <Code>--no-backup</Code> to upgrade without it. Check or change
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

      <H3 id="careers-domains">Careers site domains</H3>
      <P>
        A company can put its <DocLink to="/docs/recruiting#domain">careers site</DocLink> on its
        own domain, such as <Code>careers.example.com</Code>. Its DNS points a <Code>CNAME</Code> at
        the hostname of your public URL, and Genosyn serves the careers site, and only the careers
        site, on that name once the company&apos;s TXT record checks out. Your reverse proxy has to
        accept the name and hold a certificate for it.
      </P>
      <P>
        With Caddy, on-demand TLS issues a certificate the first time a domain is visited. Point
        its <Code>ask</Code> at Genosyn: it answers <Code>200</Code> only for careers domains a
        company has verified, so Caddy never requests a certificate for a name nobody claimed.
      </P>
      <Pre lang="caddyfile">{`{
  on_demand_tls {
    ask http://localhost:8471/api/careers/domains/check
  }
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy localhost:8471
}`}</Pre>
      <P>
        With nginx, Traefik, or a Kubernetes Ingress, add each domain to the hosts the proxy
        routes to Genosyn and to its certificate (with cert-manager, to the Ingress&apos;s{" "}
        <Code>tls.hosts</Code>), then choose <Strong>Verify</Strong> on the careers site page. Keep
        the original <Code>Host</Code> header when proxying: Genosyn picks the company&apos;s site
        by it.
      </P>
    </>
  );
}
