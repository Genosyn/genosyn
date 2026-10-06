import {
  Callout,
  Code,
  DocLink,
  ExtLink,
  H2,
  H3,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Connect() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="Genosyn Connect"
        lead={
          <>
            Genosyn Connect lets a self-hosted installation connect Gmail, and other Integrations
            the service offers, without registering an OAuth app. Type your address, press{" "}
            <Strong>Continue with Google</Strong>, approve Google&apos;s consent screen, and you
            are back in your installation with the mailbox connected. Prefer your own OAuth app?
            Register it and Connect is never used.
          </>
        }
      />

      <H2 id="how-it-works">How it works</H2>
      <P>
        Providers such as Google only send people back to addresses registered in advance, and a
        self-hosted installation can live anywhere: a laptop on <Code>localhost</Code>, a NAS on a
        home network, a company domain. Genosyn Connect is the one address that is registered. It
        runs at <Code>https://connect.genosyn.com</Code> by default, and it is open source: the{" "}
        <Code>Connect/</Code> folder of the repository, published as the{" "}
        <Code>ghcr.io/genosyn/connect</Code> image.
      </P>
      <OL>
        <LI>
          Your installation asks Connect to start a sign-in, with two one-time proofs: one only its
          server holds, one only the browser tab you are using holds.
        </LI>
        <LI>
          A window opens on Connect. It shows your installation&apos;s address and what it will be
          able to do, and enables <Strong>Continue with Google</Strong> only once your installation
          proves it opened that window. A copied sign-in link cannot be continued anywhere else.
        </LI>
        <LI>
          You approve Google&apos;s consent screen. Google returns to Connect, which exchanges the
          one-time code for tokens and keeps them, encrypted, for at most ten minutes.
        </LI>
        <LI>
          Your installation&apos;s server collects them, once, with the proof only it holds. The
          window closes, and the Connection — and for Gmail the mailbox — is created.
        </LI>
      </OL>
      <P>
        From then on your installation talks to Google directly. Your email, files and events never
        pass through Connect. Access tokens last about an hour; to renew one, your installation
        sends the Connection&apos;s refresh token to the Connect service that issued it, which adds
        the app&apos;s client secret and asks Google. Connect stores nothing from a renewal.
        Connect never needs to reach your installation, so it works the same behind a firewall.
      </P>

      <H2 id="what-it-offers">What it offers</H2>
      <P>
        Google is the first provider. The service operator chooses which Google products it
        offers, because each needs Google&apos;s verification of the operator&apos;s app.
        Genosyn&apos;s service starts with <Strong>Gmail</Strong>; Calendar, Drive, Docs, Tasks,
        Contacts, Google Analytics, Search Console and Google Ads can be offered as they are
        verified. Your installation asks the service what it offers before showing a sign-in
        option:
      </P>
      <UL>
        <LI>
          <Strong>Email</Strong> offers <Strong>Continue with Google</Strong> for a Gmail or Google
          Workspace address when Gmail is offered.
        </LI>
        <LI>
          <Strong>Settings → Integrations</Strong> marks the products Connect covers. Pick only
          those and there is nothing to set up. Pick another, and the form asks for an OAuth
          client of your own and says which products need it.
        </LI>
      </UL>
      <P>
        More providers will follow in the same service. Until one is offered, those Integrations
        connect with your own OAuth app as before; see{" "}
        <DocLink to="/docs/integrations">Integrations</DocLink>.
      </P>

      <H2 id="own-app">Using your own OAuth app instead</H2>
      <P>
        Connect is the default, never a requirement. Any of these takes precedence:
      </P>
      <KeyList
        rows={[
          {
            term: "Admin → Integrations",
            def: "Register a Google OAuth app for the whole installation. Every Google Integration then signs in through it, and Connect is not asked.",
          },
          {
            term: "On one Connection",
            def: "In the connect form, choose Use my own OAuth client instead and enter a client ID and secret.",
          },
          {
            term: "Admin → Runtime → Hosted sign-in",
            def: "Turn off Use Genosyn Connect. New sign-ins then need your own app; Connections Connect already made keep renewing through it until you reconnect them with your own app.",
          },
        ]}
      />
      <P>
        To withdraw access entirely, disconnect the Connection in Genosyn and remove Genosyn&apos;s
        access in your Google account&apos;s security settings.
      </P>

      <H2 id="status">Checking the service</H2>
      <P>
        <Strong>Admin → Runtime → Hosted sign-in</Strong> shows, live, whether this installation
        can reach the service and what it offers — the first place to look when Email says Google
        sign-in is unavailable. It distinguishes the three reasons:
      </P>
      <UL>
        <LI>
          <Strong>Turned off</Strong> — Use Genosyn Connect is off on this installation.
        </LI>
        <LI>
          <Strong>Cannot reach</Strong> — the installation has no outbound HTTPS to the service.
          Check its network, proxy and DNS.
        </LI>
        <LI>
          <Strong>Does not offer</Strong> — the service answered but does not offer that product.
        </LI>
      </UL>
      <P>
        An outage of the service stops new sign-ins and token renewal; already-issued access
        tokens keep working until they expire. Connections renew again as soon as the service is
        back.
      </P>

      <H2 id="run-your-own">Running your own Genosyn Connect</H2>
      <P>
        You can run the service yourself, for example to offer Google sign-in to several
        installations under your own verified Google app. Point those installations at it with{" "}
        <Strong>Sign-in service URL (advanced)</Strong> at <Strong>Admin → Runtime → Hosted
        sign-in</Strong>. A Connection always renews through the service that issued it, so
        changing the URL never sends an existing refresh token somewhere new.
      </P>

      <H3 id="google-app">Register the Google app</H3>
      <OL>
        <LI>
          In Google Cloud Console, create a project, enable the Gmail API (and the API of each
          other product you will offer), and configure the OAuth consent screen with your
          homepage, privacy policy and terms.
        </LI>
        <LI>
          Create an OAuth client of type <Strong>Web application</Strong> with these authorized
          redirect URIs — the second one serves installations released before provider-neutral
          routes:
          <Pre>{`https://connect.example.com/api/connect/google/callback
https://connect.example.com/api/google-sign-in/callback`}</Pre>
        </LI>
        <LI>
          Complete Google&apos;s verification for the scopes you offer. Gmail and Drive are
          restricted scopes that also need Google&apos;s security assessment before people outside
          your organization can consent.
        </LI>
      </OL>

      <H3 id="docker">Run the container</H3>
      <Pre lang="bash">{`docker run -d --name genosyn-connect --restart unless-stopped \\
  -p 8473:8473 \\
  -e CONNECT_PUBLIC_URL=https://connect.example.com \\
  -e CONNECT_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com \\
  -e CONNECT_GOOGLE_CLIENT_SECRET=GOCSPX-... \\
  -e CONNECT_GOOGLE_SCOPE_GROUPS=gmail \\
  -e CONNECT_TRUSTED_PROXY_HOPS=1 \\
  ghcr.io/genosyn/connect:latest`}</Pre>
      <P>
        Put it behind a reverse proxy that terminates HTTPS for{" "}
        <Code>connect.example.com</Code>, preserves the Host and Origin headers, and keeps query
        strings out of its access logs: callback URLs carry one-time authorization codes. The
        service has no admin UI and nothing to back up; it needs only outbound HTTPS to Google.
      </P>
      <KeyList
        rows={[
          {
            term: "CONNECT_PUBLIC_URL",
            def: "Required. The HTTPS origin people reach the service at; callbacks are built from it. HTTP is allowed only on localhost, for development.",
          },
          {
            term: "CONNECT_GOOGLE_CLIENT_ID / _SECRET",
            def: "The Google OAuth client. Without them the service runs and reports Google as unavailable.",
          },
          {
            term: "CONNECT_GOOGLE_SCOPE_GROUPS",
            def: "Products to offer, comma-separated: gmail (default), calendar, drive, docs, tasks, contacts, directory, chat, meet, analytics, search-console, ads.",
          },
          {
            term: "CONNECT_TRUSTED_PROXY_HOPS",
            def: "How many proxies sit in front and append to X-Forwarded-For, so rate limits apply to the real client. Default 0.",
          },
          {
            term: "CONNECT_DATABASE_URL, CONNECT_SECRET",
            def: "For more than one replica: a Postgres URL for shared sign-in state, and a secret of at least 32 characters that encrypts it. One replica keeps sign-ins in memory and needs neither.",
          },
          {
            term: "CONNECT_PRIVACY_URL, CONNECT_TERMS_URL",
            def: "Linked from the service's pages.",
          },
          {
            term: "PORT",
            def: "Listening port, 8473 by default. Health checks: /healthz (process) and /readyz (sign-in store).",
          },
        ]}
      />
      <P>
        Each secret can also come from a mounted file: set <Code>CONNECT_GOOGLE_CLIENT_SECRET_FILE</Code>,{" "}
        <Code>CONNECT_SECRET_FILE</Code> or <Code>CONNECT_DATABASE_URL_FILE</Code> instead. On
        Kubernetes, the Helm chart runs the service beside the App; see{" "}
        <DocLink to="/docs/kubernetes">Kubernetes</DocLink>. The repository&apos;s{" "}
        <ExtLink href="https://github.com/genosyn/genosyn/blob/main/Connect/README.md">
          Connect/README.md
        </ExtLink>{" "}
        has the operator&apos;s checklist.
      </P>

      <Callout kind="info" title="Two products, one word">
        Genosyn Connect connects <em>Integrations</em>. It does not change how Members sign in to
        Genosyn itself; that stays with passwords, passkeys and company SSO.
      </Callout>
    </>
  );
}
