import {
  Callout,
  Code,
  DocLink,
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

export function Api() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="REST API"
        lead={
          <>
            Everything a Member does in Genosyn goes through a documented REST endpoint. Script it
            from a terminal, CI, or your own agent with a personal API key, and browse every
            operation at <Code>/api/docs</Code> on your install.
          </>
        }
      />

      <H2 id="mint-a-key">Mint an API key</H2>
      <OL>
        <LI>
          Open <Strong>Settings → API keys</Strong> in the company you want to script, and choose{" "}
          <Strong>Generate key</Strong>.
        </LI>
        <LI>
          Give it a <Strong>Name</Strong> that says where it will live — &quot;GitHub Actions&quot;,
          &quot;local CLI&quot; — and pick when it <Strong>Expires</Strong>: never, or in 30 days,
          90 days or a year.
        </LI>
        <LI>
          Choose <Strong>Generate</Strong> and copy the token. It starts with <Code>gen_</Code> and
          is shown exactly once; if you lose it, generate a new one and revoke the old.
        </LI>
      </OL>
      <P>
        The same page shows the company&apos;s <Strong>Base URL</Strong> — your install&apos;s
        address followed by <Code>/api/companies/</Code> and the company&apos;s id — with a{" "}
        <Strong>Copy</Strong> button, and the new-key dialog ends with a first request to try.
        Minting and revoking keys needs a signed-in browser: a key can never create another.
      </P>

      <H2 id="requests">Make a request</H2>
      <P>
        Send the token as a bearer credential on every request. Every company operation lives below
        the Base URL; bodies are JSON.
      </P>
      <Pre lang="bash">{`export GENOSYN=https://genosyn.example.com/api/companies/<company-id>
export GENOSYN_KEY=gen_…

# Who is this key? Its Member, their role, Finance access and the key itself.
curl -H "Authorization: Bearer $GENOSYN_KEY" $GENOSYN/me

# List the AI Employees.
curl -H "Authorization: Bearer $GENOSYN_KEY" $GENOSYN/employees

# Add a Contact to Revenue.
curl -X POST -H "Authorization: Bearer $GENOSYN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Ada Lovelace", "email": "ada@example.com"}' \\
  $GENOSYN/revenue/contacts

# Start a Routine now.
curl -X POST -H "Authorization: Bearer $GENOSYN_KEY" $GENOSYN/routines/<routine-id>/run`}</Pre>
      <P>
        <Code>GET /me</Code> is the check to run first: it answers{" "}
        <Code>authentication: &quot;api_key&quot;</Code> with the key&apos;s name and prefix, so a
        script can confirm it is talking to the right company as the right Member before it changes
        anything.
      </P>

      <H2 id="cli">From the command line</H2>
      <P>
        <DocLink to="/docs/api-cli">genosyn-api</DocLink> turns every operation in the reference
        below into a command, reading the reference from your install as it runs. It keeps the key
        out of your shell history, prints tables for you and JSON for scripts, and exits with a
        code a script can branch on. Every install serves it at <Code>/cli/genosyn-api.mjs</Code>.
      </P>
      <Pre lang="bash">{`genosyn-api login --url https://genosyn.example.com/api/companies/<company-id>
genosyn-api whoami
genosyn-api revenue list-deals --limit 20
genosyn-api call createRevenueContact name="Ada Lovelace" email=ada@example.com`}</Pre>

      <H2 id="mcp">From an AI agent</H2>
      <P>
        The same keys open the <DocLink to="/docs/mcp-server">MCP server</DocLink>. Point Claude
        Desktop, Claude Code, Cursor or any MCP client at <Code>/api/companies/&lt;id&gt;/mcp</Code>{" "}
        and it can search, describe and call every operation in the reference below that a key can
        call, by the same <Code>operationId</Code>s and under the same rules — and claude.ai and
        ChatGPT sign in to it as <DocLink to="/docs/connected-apps">connected apps</DocLink>, with no
        key. <Strong>Settings → API keys</Strong> shows the endpoint and each client&apos;s setup.
      </P>

      <H2 id="reference">The API reference</H2>
      <KeyList
        rows={[
          {
            term: "/api/docs",
            def: (
              <>
                The interactive reference. Operations are grouped by product area and start
                collapsed; the search box matches an area, a path, a summary or an operation id, in
                any case. <Strong>Authorize</Strong> takes your key, and <Strong>Try it out</Strong>{" "}
                sends real requests with it.
              </>
            ),
          },
          {
            term: "/api/openapi.json",
            def: (
              <>
                The same reference as an OpenAPI 3.0 document, for Postman, code generators and
                agents. Neither address needs a key: they describe shapes, not data.
              </>
            ),
          },
        ]}
      />
      <P>
        Every operation in the document has a stable <Code>operationId</Code> — a verb and what it
        acts on, such as <Code>listRevenueDeals</Code> or <Code>archiveRevenueDeal</Code> — derived
        from its method and path, so it changes only when the endpoint does. Request bodies, query
        strings and path parameters come from the same validation the server runs, and every
        operation carries an <Strong>Access</Strong> paragraph plus an <Code>x-genosyn-access</Code>{" "}
        field saying whether a key works, which company role it needs, and what Finance access.
      </P>

      <H2 id="what-a-key-can-do">What a key can and cannot do</H2>
      <P>
        A key acts as the Member who minted it, with that Member&apos;s role and Finance access at
        the moment of each request, and only for the one company it was minted for. Demote the
        Member and their keys lose the same powers; remove them from the company and their keys stop
        working there. A key never does more than its Member could in the app.
      </P>
      <P>
        A few operations need a person at a signed-in browser by design, and refuse a key with{" "}
        <Code>403</Code>. The reference marks them <Code>cookieAuth</Code> only:
      </P>
      <UL>
        <LI>
          The account and the keys: signing in, passwords, passkeys and two-factor authentication,
          minting and revoking API keys.
        </LI>
        <LI>
          Who belongs: invitations, Member roles and Finance access, deleting the company, and the
          company&apos;s two-factor policy.
        </LI>
        <LI>
          Human gates on AI work: the <DocLink to="/docs/decisions">Approvals</DocLink> inbox,
          authorizing a fresh allowance for a Run, and switching{" "}
          <DocLink to="/docs/reactivity">proactive work</DocLink> on or off.
        </LI>
        <LI>
          Credential custody: the <DocLink to="/docs/vault">Vault</DocLink>, Secrets, Integration
          Connections and their Grants, AI Models, MCP servers, email providers, connecting a
          mailbox by password, phone numbers, Member browsers, and{" "}
          <DocLink to="/docs/repositories">Repositories</DocLink>.
        </LI>
        <LI>
          What could show a credential: live views of an AI Employee&apos;s browser, Run browser
          recordings, external chat identities, and the email delivery log.
        </LI>
        <LI>
          Conversations that carry a Member&apos;s authority to an AI Employee: direct chat, Ask AI
          messages, TLDR questions, Decision discussions, workspace messages, mail handovers and AI
          analysis actions, and assigning or mentioning an AI Employee on a todo.
        </LI>
        <LI>Instance administration and backups, for master admins.</LI>
      </UL>
      <P>
        Account-level paths outside <Code>/api/companies/&lt;id&gt;</Code> do not recognize a key at
        all and answer <Code>401</Code>. Everything else a Member does — Employees and their Skills
        and Routines, Runs, Goals, Revenue, Finance, Banking, Tasks, Bases, Notes, Resources, Email,
        Meetings, Recruiting and the rest — takes a key.
      </P>

      <H3 id="errors">Errors</H3>
      <KeyList
        rows={[
          {
            term: "400",
            def: (
              <>
                The request failed its schema:{" "}
                <Code>{`{ "error": "ValidationError", "issues": [...] }`}</Code>, each issue naming
                the field.
              </>
            ),
          },
          {
            term: "401",
            def: (
              <>
                No usable credential: a missing, revoked or expired key, or a key used outside its
                own company&apos;s paths — another company, or the account.
              </>
            ),
          },
          {
            term: "403",
            def: (
              <>
                Authenticated but not allowed: a role or Finance access the Member lacks, a Member
                no longer in the company, or a browser-only operation.
              </>
            ),
          },
          { term: "404", def: <>Nothing with that id in this company.</> },
        ]}
      />

      <H2 id="webhooks">Inbound webhooks</H2>
      <P>
        Three endpoints take requests from your own systems without a key, because the secret token
        in their URL is the credential: starting a <DocLink to="/docs/routines">Routine</DocLink>,
        starting a <DocLink to="/docs/pipelines">Pipeline</DocLink> from its Webhook trigger, and
        posting to a <DocLink to="/docs/workspace-chat">workspace channel</DocLink> in Slack&apos;s
        format. Copy each URL from the app; the reference lists them under{" "}
        <Strong>Inbound webhooks</Strong>. To give another agent everything a key can do, connect it
        to the <DocLink to="/docs/mcp-server">MCP server</DocLink>; to have it act as one AI
        Employee with that employee&apos;s tools, use the employee&apos;s{" "}
        <DocLink to="/docs/integrations#external-mcp">MCP endpoint</DocLink>. Both take the same API
        key.
      </P>

      <Callout kind="warn" title="Treat a key like your password for this company.">
        Anyone holding it can do what you can there, short of the browser-only operations above.
        Keep it in a secret manager or your CI&apos;s secrets, never in a repository or a chat;
        prefer a key that expires; give each script its own key so you can revoke one without
        breaking the rest; and serve Genosyn over HTTPS so it never crosses the network in the
        clear. <Strong>Settings → API keys</Strong> shows when each key was last used, and{" "}
        <Strong>Revoke</Strong> stops a key on its next request. Resetting your password revokes all
        of your keys.
      </Callout>
    </>
  );
}
