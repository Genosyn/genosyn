import {
  Callout,
  Code,
  DocLink,
  ExtLink,
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

const CATALOG: Array<{ name: string; kind: string }> = [
  { name: "GitHub", kind: "engineering" },
  { name: "Stripe", kind: "finance" },
  { name: "Brex", kind: "finance" },
  { name: "Gmail / Google", kind: "comms + drive" },
  { name: "Google Analytics", kind: "analytics" },
  { name: "Google Search Console", kind: "SEO / search" },
  { name: "Notion", kind: "knowledge" },
  { name: "Airtable", kind: "data" },
  { name: "Linear", kind: "tickets" },
  { name: "Telegram", kind: "comms" },
  { name: "Postgres / MySQL / ClickHouse", kind: "databases" },
  { name: "Redis", kind: "cache / KV" },
  { name: "Metabase / NocoDB", kind: "BI / data" },
  { name: "Lightning (NWC + LND)", kind: "payments" },
  { name: "Nostr", kind: "social" },
  { name: "Reddit, X, LinkedIn", kind: "social" },
  { name: "Google Ads", kind: "paid marketing" },
  { name: "Meta Ads", kind: "paid marketing" },
  { name: "Microsoft Advertising", kind: "paid marketing" },
  { name: "Reddit Ads", kind: "paid marketing" },
];

export function Integrations() {
  return (
    <>
      <PageHeader
        eyebrow="Brains & tools"
        title="Integrations"
        lead={
          <>
            An <Strong>Integration</Strong> is a connector type — Stripe,
            Gmail, GitHub, Postgres. A <Strong>Connection</Strong> is one
            authenticated account inside an integration. A <Strong>Grant</Strong>{" "}
            gives an AI employee access to one Connection.
          </>
        }
      />

      <H2 id="three-words">Three words, three rows</H2>
      <KeyList
        rows={[
          {
            term: "Integration",
            def: (
              <>
                A connector <em>type</em>, defined in code under{" "}
                <Code>server/integrations/providers/</Code>. Static catalog —
                you add one by writing a provider file, not by clicking a
                button.
              </>
            ),
          },
          {
            term: "Connection",
            def: (
              <>
                One authenticated <em>account</em> inside an integration. DB
                row (<Code>IntegrationConnection</Code>), per-company. You
                might have two Stripe connections — &quot;live&quot; and
                &quot;test&quot;.
              </>
            ),
          },
          {
            term: "Grant",
            def: (
              <>
                A row on <Code>EmployeeConnectionGrant</Code> giving one
                employee access to one connection. Without a grant, the
                employee&apos;s MCP server simply doesn&apos;t list those
                tools.
              </>
            ),
          },
        ]}
      />

      <Callout kind="info" title="Granular by design.">
        Grants are per-employee, per-connection. Your Bookkeeper gets the
        Stripe Live grant; your Brand Writer doesn&apos;t. Both employees
        share the same company, but the MCP surface they see is different.
      </Callout>

      <H2 id="how-tools-show-up">How tools show up</H2>
      <P>
        Every run, the in-process agent regenerates the MCP server list. The
        built-in <Code>genosyn</Code> server lists every integration tool the
        employee has a Grant for; the agent sees a flat catalog of tools and
        never has to know anything about Connections.
      </P>

      <H2 id="external-mcp">Connecting an external MCP client</H2>
      <P>
        The built-in <Code>genosyn</Code> tools an employee gets inside a run —
        the same tool catalog the in-process{" "}
        <DocLink to="/docs/models">agent</DocLink> loads per run — are also
        reachable over the network. Point any MCP client at an employee&apos;s
        endpoint and it drives that employee from anywhere: Claude Desktop,
        Cursor, VS Code, or your own agent, all seeing the same tools, Grants,
        and audit trail as the in-app assistant.
      </P>

      <H3 id="external-mcp-url">Get the endpoint URL</H3>
      <P>
        Open the employee&apos;s <Code>MCP servers</Code> tab. The{" "}
        <Strong>Connect an external harness</Strong> panel at the top shows a
        copyable URL:
      </P>
      <Pre lang="text">{`https://<your-genosyn-host>/api/companies/<company-id>/employees/<employee-id>/mcp/connect`}</Pre>
      <P>
        The ids are the company and employee UUIDs, wired in for you — just copy
        it. Whichever employee the URL names is the one the client acts{" "}
        <em>as</em>: every call runs with that employee&apos;s Grants and lands
        in its journal.
      </P>

      <H3 id="external-mcp-auth">Authenticate</H3>
      <P>
        Requests carry a Genosyn API key as a bearer token — the same durable
        credential the REST API uses. Mint one at{" "}
        <Code>Settings → API keys</Code> with <Strong>Generate key</Strong>; the
        plaintext is shown exactly once, so copy it then. Send it on every
        request:
      </P>
      <Pre lang="http">{`Authorization: Bearer gen_xxxxxxxx…`}</Pre>
      <P>
        A key is scoped to a single company and authenticates as the member who
        minted it. Browse the full REST surface at{" "}
        <ExtLink href="/api/docs">API reference</ExtLink>.
      </P>

      <H3 id="external-mcp-config">Transport &amp; client config</H3>
      <P>
        The endpoint speaks the MCP <Strong>Streamable HTTP</Strong> transport
        and is stateless — the client POSTs JSON-RPC and reads a JSON reply,
        with no session to keep alive. Any client that takes a remote server as{" "}
        <Code>{"{ url, headers }"}</Code> connects natively:
      </P>
      <Pre lang="json">{`{
  "mcpServers": {
    "genosyn": {
      "url": "https://<your-host>/api/companies/<company-id>/employees/<employee-id>/mcp/connect",
      "headers": { "Authorization": "Bearer gen_xxxxxxxx…" }
    }
  }
}`}</Pre>
      <P>
        <Strong>Claude Code</Strong> registers it in one command:
      </P>
      <Pre lang="bash">{`claude mcp add --transport http genosyn \\
  "https://<your-host>/api/companies/<company-id>/employees/<employee-id>/mcp/connect" \\
  --header "Authorization: Bearer gen_xxxxxxxx…"`}</Pre>
      <P>
        <Strong>Claude Desktop</Strong> has no field for a custom auth header
        yet, so bridge the endpoint through <Code>mcp-remote</Code> in{" "}
        <Code>claude_desktop_config.json</Code>. Keep the token in an env var,
        where its space survives — passed as a raw <Code>--header</Code> arg it
        can get mangled:
      </P>
      <Pre lang="json">{`{
  "mcpServers": {
    "genosyn": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-host>/api/companies/<company-id>/employees/<employee-id>/mcp/connect",
        "--header",
        "Authorization:\${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer gen_xxxxxxxx…" }
    }
  }
}`}</Pre>
      <P>
        Cursor and VS Code use the same <Code>url</Code> + <Code>headers</Code>{" "}
        shape (VS Code names the block <Code>servers</Code> and prompts for the
        token as an <Code>input</Code>); any stdio-only client can reach the
        endpoint through the same <Code>mcp-remote</Code> bridge.
      </P>

      <Callout kind="warn" title="An API key is a company-wide credential.">
        Any valid key for a company can drive <em>any</em> employee in it —
        there is no per-employee scope beyond company membership — and every
        write runs as that employee, landing in its audit log and journal. Serve
        Genosyn over HTTPS, keep keys out of committed config, and revoke a
        leaked one at <Code>Settings → API keys</Code>.
      </Callout>

      <H2 id="catalog">What ships today</H2>
      <P>
        A non-exhaustive sampling of integrations available in the latest
        image:
      </P>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CATALOG.map((c) => (
          <div
            key={c.name}
            className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px]"
          >
            <span className="font-medium text-zinc-950">{c.name}</span>
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">
              {c.kind}
            </span>
          </div>
        ))}
      </div>

      <H2 id="adding-an-integration">Adding an Integration</H2>
      <P>
        Integrations live in code: a file under{" "}
        <Code>server/integrations/providers/</Code> exports the auth flow,
        config shape, and MCP tools the integration contributes. Once
        compiled, the integration appears in the UI for{" "}
        <em>any</em> company on that instance — no per-tenant flag.
      </P>

      <H2 id="grants-and-revocation">Grants & revocation</H2>
      <UL>
        <LI>
          <Strong>Add a grant</Strong> on the employee&apos;s Connections
          page. The MCP tool list updates on the next run.
        </LI>
        <LI>
          <Strong>Revoke a grant</Strong> the same place. The next routine
          won&apos;t see the tools.
        </LI>
        <LI>
          <Strong>Delete a Connection</Strong> at the company level. All
          dependent grants disappear with it.
        </LI>
      </UL>

      <H3 id="brex">Brex Cash and corporate cards</H3>
      <P>
        To connect your company&apos;s Brex account, sign in to Brex as an
        administrator, open <Code>Developer → Settings</Code>, and create a user
        token with the <Code>accounts.cash.readonly</Code>,{" "}
        <Code>transactions.cash.readonly</Code>, and{" "}
        <Code>transactions.card.readonly</Code> scopes. In Genosyn, open{" "}
        <Code>Settings → Integrations</Code>, choose <Code>Brex</Code>, and paste
        that token into a new Connection. Genosyn encrypts the token and never
        returns it to the browser after creation.
      </P>
      <P>
        The Connection contributes read-only cash-account, Cash transaction, and
        card transaction tools to employees who receive a Grant. To bring Cash
        transactions into the books, open{" "}
        <DocLink to="/docs/finance">Finance → Reconciliation</DocLink>, create a{" "}
        <Code>Brex Cash</Code> feed, choose the Connection and Cash account, then
        click <Code>Sync</Code>.
      </P>
      <P>
        For corporate card accounting, open <Code>Finance → Card expenses</Code>
        and map the Brex Connection to a card liability, default expense
        category, and payment account. Brex exposes only settled transactions:
        pending card activity appears after it settles.
      </P>

      <H3 id="github-engineering">GitHub & engineering grants</H3>
      <P>
        GitHub is special: a Connection holds a list of repos the employee is
        allowed to touch, and the runner materializes a git checkout of each
        allowed repo into{" "}
        <Code>data/companies/&lt;co&gt;/employees/&lt;emp&gt;/repos/...</Code>{" "}
        before each run. The git token never lands on disk — it&apos;s read
        from the env var the runner injects, via a per-connection credential
        helper inside <Code>.git/genosyn-cred.sh</Code>.
      </P>

      <H3 id="lightning-payments">Lightning payments</H3>
      <P>
        The Lightning integration adds spending caps on the Connection
        itself: <Code>maxPaymentSats</Code>,{" "}
        <Code>dailyLimitSats</Code>, <Code>requireApprovalAboveSats</Code>.
        Over-cap payments queue a <Code>lightning_payment</Code>{" "}
        <DocLink to="/docs/routines">Approval</DocLink> that replays the call
        once a human ✓&apos;s it.
      </P>

      <H3 id="gmail-attachments">Emailing files from Resources</H3>
      <P>
        An employee drafting or sending mail through the{" "}
        <Strong>Google Workspace</Strong> connector can attach{" "}
        <DocLink to="/docs/vocabulary">Resources</DocLink> it has been granted
        — the ebook you uploaded, a contract, a report. It names the resource
        by slug and Genosyn reads the bytes server-side, so the file never has
        to travel through the model. Attachments work the same on a draft as
        on a send: the draft lands in Gmail with the files already on it,
        ready for a human to review before it goes out.
      </P>
      <P>
        Each attachment picks a <Code>format</Code>. The default,{" "}
        <Code>original</Code>, sends the file exactly as it was uploaded —
        that is what you want for a PDF or EPUB that already exists. The other
        four (<Code>pdf</Code>, <Code>html</Code>, <Code>md</Code>,{" "}
        <Code>txt</Code>) render the resource&apos;s extracted text into a new
        document, the same rendering the Download menu on the resource page
        produces. Those are the only options for link- and paste-kind
        resources, which never keep an original file.
      </P>
      <Callout kind="warn" title="A grant says which file, not who receives it.">
        Genosyn checks the employee&apos;s grant on every attachment, so it
        cannot email a Resource nobody shared with it. It does{" "}
        <em>not</em> check the recipient. An employee that reads untrusted
        text — a support inbox, a scraped page — can be talked into mailing a
        document it legitimately holds to an address of the attacker&apos;s
        choosing. Grant document access the way you&apos;d hand someone a
        printout, and keep employees that read the open internet away from
        Resources you would not want forwarded.
      </Callout>
      <P>
        Who may send at all is a separate question, and the{" "}
        <DocLink to="/docs/email">Email</DocLink> section owns it. Once you
        connect a mailbox there, the <Code>gmail_*</Code> tools honour that
        mailbox&apos;s <Strong>Read / Draft / Send</Strong> level — so an
        employee on the default <Strong>Draft</Strong> can attach a Resource to
        a draft for you to review, but cannot send it itself. Until a mailbox
        is connected there is no level to honour, and a Connection grant alone
        lets an employee send.
      </P>

      <H3 id="google-analytics-search-console">
        Google Analytics &amp; Search Console
      </H3>
      <P>
        Two <em>read-only</em> Google integrations for the team&apos;s growth
        work, listed under <Strong>Analytics</Strong> in the catalog and
        separate from the Gmail / Drive <Strong>Google Workspace</Strong>{" "}
        connector. <Strong>Google Analytics</Strong> exposes GA4 accounts and
        properties plus report tools (sessions, users, conversions, channels,
        realtime, and the dimension/metric catalog). <Strong>Google Search
        Console</Strong> exposes verified sites, Search Analytics (clicks,
        impressions, CTR, position), sitemaps, and URL inspection.
      </P>
      <P>
        Connect either with your own <Strong>OAuth client</Strong> (add the
        callback URI the modal shows to your Google Cloud OAuth client) or a{" "}
        <Strong>service-account JSON key</Strong> — for a service account,
        add its email as a viewer/user on the GA4 property or Search Console
        site; no domain-wide delegation is needed. Both request only the
        read-only scope (<Code>analytics.readonly</Code> /{" "}
        <Code>webmasters.readonly</Code>), so employees can report on traffic
        and search performance but never change settings.
      </P>

      <H3 id="paid-marketing">Ad platforms (paid marketing)</H3>
      <P>
        Four ad-platform integrations — <Strong>Google Ads, Meta Ads,
        Microsoft Advertising, Reddit Ads</Strong> — give AI employees
        read-first campaign visibility plus a tiny, approval-gated mutation
        surface (pause / enable / budget change) bounded by per-Connection
        spending caps and a kill switch. Spend increases queue in the
        Approvals inbox by default; pausing never does. Setup recipes, the
        full safety model, and the browser-based fallback for LinkedIn / X /
        TikTok live on the{" "}
        <DocLink to="/docs/marketing">Paid Marketing</DocLink> page.
      </P>
    </>
  );
}
