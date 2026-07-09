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
        Every time the runner spawns an employee&apos;s provider CLI, it
        regenerates the MCP server list. The built-in <Code>genosyn</Code>{" "}
        server lists every integration tool the employee has a Grant for; the
        provider CLI sees a flat catalog of tools and never has to know
        anything about Connections.
      </P>

      <H2 id="external-mcp">Connecting an external MCP client</H2>
      <P>
        The built-in <Code>genosyn</Code> tools an employee gets inside a run —
        the stdio server the <DocLink to="/docs/models">provider CLI</DocLink>{" "}
        loads on every spawn — are also reachable over the network. Point any
        MCP client at an employee&apos;s endpoint and it drives that employee
        from anywhere: Claude Desktop, Cursor, VS Code, or your own agent, all
        seeing the same tools, Grants, and audit trail as the in-app assistant.
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
          page. The MCP tool list updates on next spawn.
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

      <H3 id="github-engineering">GitHub & engineering grants</H3>
      <P>
        GitHub is special: a Connection holds a list of repos the employee is
        allowed to touch, and the runner materializes a git checkout of each
        allowed repo into{" "}
        <Code>data/companies/&lt;co&gt;/employees/&lt;emp&gt;/repos/...</Code>{" "}
        before each spawn. The git token never lands on disk — it&apos;s read
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
    </>
  );
}
