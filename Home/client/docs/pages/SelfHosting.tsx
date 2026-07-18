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
            One file: <Code>App/config.ts</Code>. No <Code>.env</Code>, no YAML
            stack, no secret loader. Self-hosters edit one TypeScript object
            with commented JSON shape — and that&apos;s the whole story.
          </>
        }
      />

      <Callout kind="warn" title="No .env, ever.">
        Genosyn doesn&apos;t use <Code>dotenv</Code>, per-environment files, or
        a config service. If a tutorial or PR adds one, it&apos;s wrong. There
        is one config object; users override values in-place.
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

  // HTTP port + the URL the app should think it lives at.
  port: 8471,
  publicUrl: "http://localhost:8471",

  // 32+ random bytes. Rotate to log everyone out.
  sessionSecret: "change-me-in-production",

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

      <H2 id="db-driver">Switching to Postgres</H2>
      <P>
        Genosyn ships on SQLite by default — single file, zero install. To
        switch to Postgres, flip the driver and point at a connection URL:
      </P>
      <Pre lang="ts">{`db: {
  driver: "postgres",
  sqlitePath: "",
  postgresUrl: "postgresql://user:pass@host:5432/genosyn",
},`}</Pre>
      <P>
        All entities and migrations work on both drivers. On startup Genosyn
        calls <Code>AppDataSource.runMigrations()</Code> — any pending
        migrations apply automatically.
      </P>

      <H2 id="data-dir">The data directory</H2>
      <P>
        Everything user-generated — the SQLite file, materialized git checkouts,
        MCP configs, uploaded attachments — lives under <Code>dataDir</Code>:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-zinc-700">
        {`data/
├── app.sqlite
└── companies/<co-slug>/employees/<emp-slug>/
    ├── .mcp.json
    ├── repos/<owner>/<name>/
    └── ...`}
      </pre>
      <P>
        In the Docker image, this is mounted at <Code>/app/data</Code>. The
        installer maps a named volume <Code>genosyn-data</Code> there — back
        that volume up and you&apos;ve backed up everything.
      </P>

      <H2 id="email">Email</H2>
      <P>
        Email transport is per-company: every <Code>Company</Code> can have one
        or more <Code>EmailProvider</Code> rows. Supported transports today:
      </P>
      <UL>
        <LI>
          <Strong>SMTP</Strong> via <Code>nodemailer</Code>.
        </LI>
        <LI>
          <Strong>SendGrid</Strong>, <Strong>Mailgun</Strong>,{" "}
          <Strong>Resend</Strong>, <Strong>Postmark</Strong> — REST-based, paste
          an API key.
        </LI>
      </UL>
      <P>
        System-level sends (password resets, invites, welcomes) and any company
        without its own provider fall back to a single{" "}
        <Strong>global SMTP transport</Strong>. Configure it in the app at{" "}
        <Code>Admin → Email transport</Code>: fill in the host, port,
        encryption, username, password, from name, and from address, then use{" "}
        <Code>Send test</Code> to confirm deliverability. The settings are
        stored in the database and take effect immediately — no restart. Until
        it&apos;s configured, the <Code>Admin → Overview</Code> and{" "}
        <Code>Instance Health</Code> dashboards flag Email transport with a
        warning, because those system emails only log to the server console and
        never reach a mailbox.
      </P>
      <P>
        A file-based default also exists: the <Code>smtp</Code> block in{" "}
        <Code>config.ts</Code>. The dashboard override takes precedence over it;
        clearing the override (the <Code>Reset</Code> button) reverts to
        whatever <Code>config.ts</Code> provides, and if that&apos;s blank too,
        to the console. When a global transport is configured either way, adding
        a company SMTP provider at <Code>Settings → Email</Code> pre-fills the
        host, port, encryption, username, and sender address from it — you only
        enter the password. Every send appends an <Code>EmailLog</Code> row you
        can read at <Code>Settings → Email Logs</Code>.
      </P>

      <H2 id="secrets">Secrets</H2>
      <P>Three places store secrets, each for a different lifecycle:</P>
      <KeyList
        rows={[
          {
            term: "sessionSecret",
            def: (
              <>
                In <Code>config.ts</Code>. Used to sign cookies. Rotating it
                invalidates every session.
              </>
            ),
          },
          {
            term: "Connection config",
            def: (
              <>
                Encrypted per-Connection blobs on{" "}
                <Code>IntegrationConnection.encryptedConfig</Code>{" "}
                (AES-256-GCM). Decrypted at tool-call time.
              </>
            ),
          },
          {
            term: "Secret entity",
            def: (
              <>
                Free-form encrypted key/value pairs scoped to a company,
                editable from <Code>Settings → Secrets</Code>. Surfaced to
                Pipelines.
              </>
            ),
          },
        ]}
      />

      <H2 id="admin">Admin &amp; instance health</H2>
      <P>
        Install-wide operations live under the <Code>Admin</Code> section (your
        avatar menu → <Code>Admin</Code>) — separate from a single
        company&apos;s <Code>Settings</Code>. Because it spans every company on
        the deployment, it&apos;s gated to <Strong>master admins</Strong>:
        instance-level operators, a global flag on the user account that&apos;s
        distinct from the per-company <Code>owner</Code> / <Code>admin</Code> /{" "}
        <Code>member</Code> roles. The first account to sign up on a fresh
        install is bootstrapped as the master admin; from{" "}
        <Code>Admin → Users</Code> an existing master admin can grant or revoke
        the flag on anyone else (you just can&apos;t revoke your own, so the
        install always keeps at least one operator). Since it&apos;s
        operator-only, <Code>Admin</Code> isn&apos;t advertised in the products
        section menu — reach it from your avatar menu.
      </P>
      <UL>
        <LI>
          <Strong>Overview</Strong> — an at-a-glance dashboard: instance health
          status, the running version and build, database driver, uptime and
          memory, and an inventory of companies, members, and AI employees.
        </LI>
        <LI>
          <Strong>Instance Health</Strong> — live probes of the deployment
          substrate: database connectivity and round-trip latency, pending
          schema migrations, a writable data directory, the backup story, and
          the email + Web Push transports. This is distinct from a
          company&apos;s <Code>Settings → System Health</Code>, which watches
          that company&apos;s routines, models, and integrations.
        </LI>
        <LI>
          <Strong>Migrations</Strong> — expands the Instance Health migrations
          probe into the full ledger: every schema migration, its state, and
          whether the database has drifted from the code. See{" "}
          <Code>Migrations</Code> below.
        </LI>
        <LI>
          <Strong>Database</Strong> — a raw SQL console over Genosyn&apos;s own
          application database. See <Code>Database console</Code> below.
        </LI>
        <LI>
          <Strong>Email transport</Strong> — configure the install-wide global
          SMTP server for system emails (password resets, invites), with a test
          send. See <Code>Email</Code> above.
        </LI>
        <LI>
          <Strong>Sign-ups</Strong> — an instance-wide toggle for self-service
          registration. See <Code>Sign-ups</Code> below.
        </LI>
        <LI>
          <Strong>SSO</Strong> — instance-wide single sign-on via Google or any
          OpenID Connect provider. Disabled by default. See <Code>SSO</Code>{" "}
          below.
        </LI>
        <LI>
          <Strong>Users</Strong> — every human member across every company, with
          their handle, how many companies they belong to, and which companies
          they own. Grant or revoke <Strong>master admin</Strong> on any user
          here to control who else can reach this dashboard. Delete an account
          from here to remove the person and everything scoped to them
          (memberships, API keys, notifications); content they authored is kept
          but unlinked. A user who still owns a company can&apos;t be deleted
          until you reassign or delete those companies first, and you can&apos;t
          delete your own account here.
        </LI>
        <LI>
          <Strong>Companies</Strong> — every company (tenant) on the instance,
          with its owner and member + AI-employee counts. Deleting one runs the
          same cascade as a company&apos;s own <Code>Delete company</Code>{" "}
          action — every employee, routine, message, note, and finance record it
          owns, plus its files on disk — so an operator can prune any tenant
          without switching into it first.
        </LI>
        <LI>
          <Strong>Backups</Strong> — see below.
        </LI>
      </UL>

      <H3 id="signups">Sign-ups</H3>
      <P>
        <Code>Admin → Sign-ups</Code> is an instance-wide toggle for
        self-service registration. Flip <Strong>Disable sign-ups</Strong> on and
        the public sign-up page stops accepting new accounts — anyone who lands
        on it sees a &ldquo;sign-ups are closed&rdquo; notice instead of the
        form, and the API refuses a registration attempt with a <Code>403</Code>
        . Existing members keep their accounts and can still sign in; this only
        stops <em>new</em> people from registering themselves.
      </P>
      <P>
        One account is always exempt: the very first account on a fresh install,
        so a box with no users yet can never lock itself out before an operator
        exists. With sign-ups disabled, add people by promoting an existing
        account to <Strong>master admin</Strong> from <Code>Admin → Users</Code>
        , or by inviting them into a company from that company&apos;s{" "}
        <Code>Settings → Members</Code>.
      </P>

      <H3 id="sso">SSO</H3>
      <P>
        <Code>Admin → SSO</Code> adds single sign-on to the login page —{" "}
        <Strong>disabled by default</Strong>; a fresh install only offers email
        + password until a master admin turns it on. Pick{" "}
        <Strong>Google</Strong> or <Strong>Custom OpenID Connect</Strong> (Okta,
        Keycloak, Microsoft Entra ID, Auth0, or anything OIDC-compliant), then:
      </P>
      <UL>
        <LI>
          Register an OAuth client at your identity provider and set its
          authorized redirect URI to the <Strong>Callback URL</Strong> shown on
          the page (it follows <Code>publicUrl</Code> from{" "}
          <Code>config.ts</Code>).
        </LI>
        <LI>
          Paste the <Strong>Client ID</Strong> and{" "}
          <Strong>Client secret</Strong> into the form — the secret is stored
          encrypted and never shown again. For a custom provider, also enter the{" "}
          <Strong>Issuer URL</Strong>; <Code>Check issuer</Code> verifies the
          provider&apos;s discovery document before you commit.
        </LI>
        <LI>
          Flip <Strong>Enable SSO sign-in</Strong> and save. The login page
          grows a &ldquo;Continue with …&rdquo; button (the label is yours to
          override).
        </LI>
      </UL>
      <P>
        On first SSO sign-in an existing account with the same verified email is
        linked automatically; after that the identity provider&apos;s stable
        subject is what identifies the account, so an email change at either end
        won&apos;t orphan it. With{" "}
        <Strong>Create accounts on first sign-in</Strong> on (the default),
        people your identity provider admits get a Genosyn account automatically
        — turn it off to admit only people who already have an account or an
        invitation. Password login keeps working either way, so enabling (or
        later resetting) SSO can never lock an operator out.
      </P>

      <H3 id="db-console">Database console</H3>
      <P>
        <Code>Admin → Database</Code> is a raw SQL console wired directly to
        Genosyn&apos;s own application database — the same SQLite or Postgres
        the app itself runs on. It is meant for operators who need to inspect or
        repair an install directly: check a row the UI doesn&apos;t surface,
        audit what an AI employee wrote, or fix up data after a botched import.
        Distinct from <DocLink to="/docs/explore">Explore</DocLink>, which runs
        SQL against a company&apos;s <em>external</em> database integrations.
      </P>
      <UL>
        <LI>
          <Strong>Schema browser</Strong> — every table with its live row count
          down the left. Click a table to load a <Code>SELECT *</Code>; expand
          one to see its columns (primary keys flagged) and click a column to
          drop its name into the editor.
        </LI>
        <LI>
          <Strong>Read-only by default</Strong> — the console runs one statement
          at a time and refuses anything that isn&apos;t plainly a read. To run
          an <Code>INSERT</Code> / <Code>UPDATE</Code> / <Code>DELETE</Code> or
          DDL you must first flip <Strong>Allow writes</Strong>, which surfaces
          a standing warning — these statements change the live database
          permanently, so take a{" "}
          <DocLink to="/docs/self-hosting#backups">backup</DocLink> first if you
          are unsure.
        </LI>
        <LI>
          <Strong>Results</Strong> — a scrollable grid with the row count and
          elapsed time; long result sets are capped (100–5,000 rows, your
          choice) and flagged when truncated. Recent queries are kept under the{" "}
          <Code>History</Code> tab. Press <Code>⌘↵</Code> / <Code>Ctrl↵</Code>{" "}
          to run.
        </LI>
      </UL>

      <H3 id="migrations">Migrations</H3>
      <P>
        <Code>Admin → Migrations</Code> is a read-only ledger of every TypeORM
        schema migration — <Code>Total</Code> / <Code>Applied</Code> /{" "}
        <Code>Pending</Code> / <Code>Unknown</Code> tiles over the full list.
        Nothing runs from here: boot applies pending migrations automatically,
        so this is the detail view behind the Instance Health probe.
      </P>
      <UL>
        <LI>
          <Strong>Applied</Strong> — recorded in the database, in the order they
          ran. Each shows when it was <em>authored</em>, not when it ran —
          TypeORM&apos;s migrations table records no such timestamp.
        </LI>
        <LI>
          <Strong>Pending</Strong> — shipped but not applied. A healthy instance
          has none, so anything pending points at a migration that failed at
          boot; read that boot&apos;s server log.
        </LI>
        <LI>
          <Strong>Drift</Strong> — the database disagrees with the code.{" "}
          <Strong>Unknown</Strong> is a migrations-table row matching no shipped
          migration file (a downgrade, or a hand-edited database);{" "}
          <Strong>out-of-order</Strong> is an older migration applied after a
          newer one (usually a branch merge). Take a{" "}
          <DocLink to="/docs/self-hosting#backups">backup</DocLink> before
          repairing either.
        </LI>
      </UL>

      <H2 id="backups">Backups</H2>
      <P>
        A backup zips the <em>entire</em> data directory — every company&apos;s
        rows, uploads, and credentials — so it is install-wide, not per company.
        Run one from the CLI:
      </P>
      <Pre lang="bash">{`genosyn backup --out ~/backups/genosyn-$(date +%F).tar.gz
genosyn restore ~/backups/genosyn-2026-04-22.tar.gz`}</Pre>
      <P>
        Or drive it in-app at <Code>Admin → Backups</Code>: back up now, upload
        an existing <Code>.zip</Code> to restore from, download or restore any
        past archive, and set a recurring schedule (daily / weekly / monthly at
        a chosen hour) backed by the <Code>BackupSchedule</Code> row. See{" "}
        <DocLink to="/docs/cli">CLI reference</DocLink> for the flag list.
      </P>

      <P>
        A backup is written to a temporary <Code>.part</Code> file and moved
        into place only once it is complete, so a <Code>.zip</Code> in{" "}
        <Code>data/Backup/</Code> is always a whole archive — never a half-one
        left by a container restart or an OOM kill. If a backup is interrupted,
        History keeps showing it as <Code>running</Code> and the leftover{" "}
        <Code>.part</Code> is swept on the next start. Restoring also opens the
        archive before it touches anything, so a damaged file is refused up
        front rather than part-way through replacing your data.
      </P>

      <H3 id="off-box-destinations">
        Off-box destinations (NAS / remote volumes)
      </H3>
      <P>
        Backups live in <Code>data/Backup/</Code> by default — on the same disk
        as everything else. Add one or more{" "}
        <Strong>off-box destinations</Strong> under{" "}
        <Code>Admin → Backups → Off-box destinations</Code> and every completed
        backup is mirrored there automatically. Three kinds:
      </P>
      <UL>
        <LI>
          <Strong>Mounted path</Strong> — a filesystem path Genosyn can already
          write to. Mount your NAS share (SMB / NFS / iSCSI) on the host or
          bind-mount it into the container, then point the destination at that
          path (for example <Code>/mnt/nas/genosyn</Code>). The kernel handles
          the protocol; Genosyn just copies the archive. Still the simplest
          option when you are able to mount the share.
        </LI>
        <LI>
          <Strong>SMB / CIFS</Strong> — push straight to a Windows or NAS share
          with <em>no mount required</em>. Enter the host, share, an optional
          folder within it, and a username, password, and optional domain. For
          when bind-mounting is not available to you — a locked-down Kubernetes
          cluster, or a host where you cannot mount CIFS. Genosyn negotiates
          SMB3 and signs the connection; leave <Code>Encrypt in transit</Code>{" "}
          on (the default) so the archive is not readable on your network, and
          turn it off only for a NAS that predates SMB3.
        </LI>
        <LI>
          <Strong>SFTP / SSH</Strong> — push to a remote host with no mount
          required. Enter the host, port, username, and a password or private
          key. Good for appliance NASes (Synology, QNAP, TrueNAS) that expose
          SSH but are awkward to bind-mount.
        </LI>
      </UL>
      <P>
        Credentials for the SMB and SFTP kinds are encrypted at rest with the
        same AES-256-GCM helper used for model API keys, and are never returned
        to the browser.
      </P>
      <P>
        Use <Code>Test</Code> on a destination to confirm it is reachable and
        writable, toggle <Code>Enabled</Code> to pause mirroring without
        deleting it, and use <Code>Send</Code> next to any archive in History to
        push an existing backup on demand. Delivery is best-effort: a mirror
        that fails is flagged on the destination with the error, but never fails
        the backup itself, which is already safe in <Code>data/Backup/</Code>.
      </P>

      <H3 id="retention">Retention (deleting old backups)</H3>
      <P>
        Left alone, <Code>data/Backup/</Code> grows forever. Tick{" "}
        <Code>Automatically delete old backups</Code> under{" "}
        <Code>Admin → Backups → Retention</Code> and set a number of days:
        anything older is deleted. Genosyn checks hourly and again straight
        after every backup, so a window that lapses at midday is honoured at
        midday.
      </P>
      <P>
        Retention is <em>independent of the recurring schedule</em> — it covers
        every archive in <Code>data/Backup/</Code>, including ones you made by
        hand with <Code>Back up now</Code>, and it runs even when the schedule
        is off. Two things are always spared, on the principle that a retention
        setting must never leave you with nothing to restore from:
      </P>
      <UL>
        <LI>
          <Strong>The newest completed archive</Strong> — kept however old it
          is. If backups stop running for a year, the last one survives. Should
          that archive turn out not to open, the newest one that <em>does</em>{" "}
          open is kept as well, so an unreadable file can never cost you the
          last archive you could actually restore from.
        </LI>
        <LI>
          <Strong>Archives you uploaded</Strong> through{" "}
          <Code>Admin → Backups</Code> — you carried those in from somewhere
          else and they may be the only copy. Delete them by hand when you are
          done with them.
        </LI>
      </UL>
      <P>
        Retention is <Strong>local only</Strong>. Copies already delivered to an{" "}
        <DocLink to="/docs/self-hosting#off-box-destinations">
          off-box destination
        </DocLink>{" "}
        stay on the remote — Genosyn never reaches onto your NAS to delete
        things. Prune those with whatever your NAS or a cron job on that host
        already offers.
      </P>

      <H2 id="upgrading">Upgrading</H2>
      <P>
        CLI installs schedule <Code>genosyn upgrade</Code> automatically every
        day at 03:17 local time. The command self-upgrades the CLI, pulls the
        latest image, and retains the previous container until the new version
        becomes ready. A failed start restarts the previous version with the
        current data volume. Backups are off by default; run{" "}
        <Code>genosyn upgrade --backup</Code> for a manual upgrade that also
        writes a verified archive under <Code>~/.genosyn/backups</Code> and
        restores it on failure. Check or change the schedule with{" "}
        <Code>genosyn auto-update status</Code>,{" "}
        <Code>genosyn auto-update off</Code>, or{" "}
        <Code>genosyn auto-update on</Code>. You can also upgrade immediately
        by rerunning the installer:
      </P>
      <Pre lang="bash">{`curl -fsSL https://genosyn.com/install.sh | bash`}</Pre>

      <H3 id="ports-and-reverse-proxies">Ports and reverse proxies</H3>
      <P>
        The container listens on <Code>8471</Code>. Stick a reverse proxy
        (Caddy, nginx, Traefik) in front of it for TLS and a real hostname.
        Update <Code>publicUrl</Code> in <Code>config.ts</Code> so the app
        generates absolute links correctly (invite emails, OAuth callbacks).
      </P>
    </>
  );
}
