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

export function McpServer() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="MCP server"
        lead={
          <>
            Connect claude.ai, ChatGPT, Claude Desktop, Claude Code, Cursor or any MCP client to
            Genosyn. The Genosyn MCP server offers every operation of the{" "}
            <DocLink to="/docs/api">REST API</DocLink> an API key can call — find one, read its
            inputs, call it — acting as one Member and never more: you, once you approve an app, or
            an API key&apos;s Member.
          </>
        }
      />

      <H2 id="connect">Connect a client</H2>
      <P>
        Open <Strong>Settings → API keys</Strong> in the company you want to connect. Its{" "}
        <Strong>MCP server</Strong> card shows the <Strong>Endpoint</Strong> — your install&apos;s
        address followed by the company&apos;s path — and the setup for each client:
      </P>
      <Pre lang="text">{`https://<your-genosyn-host>/api/companies/<company-id>/mcp`}</Pre>
      <P>
        claude.ai and ChatGPT take the endpoint alone and sign in to Genosyn, where you approve
        them. Every other client sends an API key: choose <Strong>Generate key</Strong>, name it
        after the client so you can revoke one without the others, and the dialog that shows the key
        ends with <Strong>Connect an MCP client</Strong>, the setup filled in. A key is shown only
        once, so the card shows the setup with <Code>gen_YOUR_API_KEY</Code> in its place.
      </P>

      <H3 id="claude-ai">claude.ai</H3>
      <OL>
        <LI>
          In claude.ai, open <Strong>Settings → Connectors</Strong> and choose{" "}
          <Strong>Add custom connector</Strong>. Name it and paste the endpoint as its URL. On a
          Team or Enterprise plan, an owner of your Claude organization adds it first, under{" "}
          <Strong>Admin settings → Connectors</Strong>.
        </LI>
        <LI>
          Choose <Strong>Connect</Strong>. Claude sends you to Genosyn: sign in, check the app and
          the company, and choose <Strong>Allow</Strong>. Back in Claude, the connector also reaches
          Claude Desktop and the Claude mobile apps.
        </LI>
      </OL>

      <H3 id="chatgpt">ChatGPT</H3>
      <OL>
        <LI>
          In ChatGPT, open <Strong>Settings → Apps &amp; Connectors</Strong> and, under{" "}
          <Strong>Advanced settings</Strong>, turn on <Strong>Developer mode</Strong>.
        </LI>
        <LI>
          Choose <Strong>Create</Strong>, paste the endpoint as the <Strong>MCP server URL</Strong>,
          and pick <Strong>OAuth</Strong> for authentication.
        </LI>
        <LI>
          ChatGPT sends you to Genosyn: sign in, check the app and the company, and choose{" "}
          <Strong>Allow</Strong>. Add the connector to a chat from its tools menu.
        </LI>
      </OL>
      <P>
        Only owners and admins can approve an app; a Member connects a desktop client with an API
        key instead. <DocLink to="/docs/connected-apps">Connected apps</DocLink> covers what
        approving gives the app, how long it lasts and how to disconnect it.
      </P>

      <H3 id="claude-desktop">Claude Desktop</H3>
      <P>
        A claude.ai connector already reaches Claude Desktop. To connect it with a key instead, use
        the <Code>mcp-remote</Code> bridge: open <Strong>Settings → Developer → Edit Config</Strong>
        , add the server to <Code>claude_desktop_config.json</Code>, and restart Claude Desktop. The
        bridge runs with <Code>npx</Code>, so Node.js must be installed; the key travels in an
        environment variable because a space in an argument can be mangled on the way.
      </P>
      <Pre lang="json">{`{
  "mcpServers": {
    "genosyn": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-genosyn-host>/api/companies/<company-id>/mcp",
        "--header",
        "Authorization:\${GENOSYN_AUTH}"
      ],
      "env": { "GENOSYN_AUTH": "Bearer gen_…" }
    }
  }
}`}</Pre>

      <H3 id="claude-code">Claude Code</H3>
      <P>
        One command registers it; add <Code>--scope user</Code> to use it in every project.
      </P>
      <Pre lang="bash">{`claude mcp add --transport http genosyn https://<your-genosyn-host>/api/companies/<company-id>/mcp \\
  --header "Authorization: Bearer gen_…"`}</Pre>
      <P>
        <Code>claude mcp list</Code> shows whether it connected. Claude Code names the tools{" "}
        <Code>mcp__genosyn__search_operations</Code> and so on, which is what a permission rule
        names to let reads through without asking.
      </P>

      <H3 id="cursor">Cursor</H3>
      <P>
        Add the server to <Code>~/.cursor/mcp.json</Code>, or to <Code>.cursor/mcp.json</Code> in
        one project. Cursor picks it up once the file is saved, and lists it in its MCP settings.
      </P>
      <Pre lang="json">{`{
  "mcpServers": {
    "genosyn": {
      "url": "https://<your-genosyn-host>/api/companies/<company-id>/mcp",
      "headers": { "Authorization": "Bearer gen_…" }
    }
  }
}`}</Pre>

      <H3 id="other-clients">Other clients</H3>
      <P>
        Any client that speaks MCP&apos;s <Strong>Streamable HTTP</Strong> transport and can send an{" "}
        <Code>Authorization</Code> header connects the same way: POST JSON-RPC to the endpoint with
        the key as a Bearer token. The server is stateless — it keeps no session and pushes nothing
        — and answers every POST with JSON, so a plain HTTP client works too:
      </P>
      <Pre lang="bash">{`curl -X POST https://<your-genosyn-host>/api/companies/<company-id>/mcp \\
  -H "Authorization: Bearer gen_…" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}</Pre>
      <P>With the TypeScript SDK:</P>
      <Pre lang="ts">{`import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(
    new URL("https://<your-genosyn-host>/api/companies/<company-id>/mcp"),
    { requestInit: { headers: { Authorization: \`Bearer \${process.env.GENOSYN_KEY}\` } } },
  ),
);
const found = await client.callTool({ name: "search_operations", arguments: { query: "create a deal" } });`}</Pre>
      <P>
        A client that only starts local (stdio) servers can use the same <Code>mcp-remote</Code>{" "}
        bridge. One that signs in with OAuth needs only the endpoint, and connects as claude.ai
        does. For a terminal or a script, <DocLink to="/docs/api-cli">genosyn-api</DocLink> offers
        the same operations as commands.
      </P>

      <H2 id="tools">What the server offers</H2>
      <P>
        Hundreds of operations are too many to list at once — a client would spend its context on
        them before the conversation began — so the server lists six tools, and every operation is
        one search away:
      </P>
      <KeyList
        rows={[
          {
            term: "whoami",
            def: (
              <>
                Whose authority the key carries: the Member, their company role and Finance access,
                the key, and how many operations they can call.
              </>
            ),
          },
          {
            term: "search_operations",
            def: (
              <>
                Finds operations by what you want to do — <Code>create a deal</Code>,{" "}
                <Code>list overdue invoices</Code>, <Code>pause a routine</Code> — or lists a whole
                area, such as Revenue or Tasks. With no arguments it lists the areas. Each result
                names the tool that calls it, and whether the key&apos;s Member may.
              </>
            ),
          },
          {
            term: "describe_operation",
            def: (
              <>
                One operation&apos;s inputs as JSON Schema — its path, query and body, and any file
                it takes — with what it answers, the access it needs, and an example call.
              </>
            ),
          },
          {
            term: "call_read_operation",
            def: <>Calls a GET operation by its operationId. It changes nothing.</>,
          },
          {
            term: "call_write_operation",
            def: (
              <>
                Calls a POST, PUT or PATCH operation: anything that creates, changes, sends or
                starts something.
              </>
            ),
          },
          {
            term: "call_delete_operation",
            def: <>Calls a DELETE operation.</>,
          },
        ]}
      />
      <P>
        An operation is named by its <Code>operationId</Code> from the{" "}
        <DocLink to="/docs/api#reference">API reference</DocLink> — <Code>createRevenueDeal</Code>,{" "}
        <Code>listGoals</Code> — and called with its path parameters in <Code>path</Code>, its query
        string in <Code>query</Code> and its body in <Code>body</Code>. The company is filled in for
        you. An operation that takes a file — a contract, a resume, a CSV to import — takes it in{" "}
        <Code>file</Code>, with its name and its contents as base64 or text.
      </P>
      <P>
        Calls are split three ways so each tool tells your client the truth about what it does:
        reads are marked read-only, writes and deletes are marked as changing things. A client can
        then let reads through on its own and still ask you before anything changes.
      </P>
      <P>
        The operations are generated from the API reference, not listed by hand, so a new feature is
        reachable here the day it ships.
      </P>

      <H2 id="authority">What it can and cannot do</H2>
      <P>
        Every call is sent back through Genosyn&apos;s own API with the same credential, so it is
        checked exactly as a REST request is: it acts as one Member, with their role and Finance
        access at that moment, only in the company the key or app is for, and every change lands in
        the <DocLink to="/docs/security">audit log</DocLink> under their name. Demote the Member and
        the server loses the same powers on the next call; revoke the key or disconnect the app and
        it stops.
      </P>
      <UL>
        <LI>
          <Strong>Not offered:</Strong> the operations that need a person at a signed-in browser —
          minting keys, Member roles, deciding Approvals, the Vault and other credentials, and
          conversations that carry your authority to an AI Employee (the{" "}
          <DocLink to="/docs/api#what-a-key-can-do">full list</DocLink>). Asked for one, the server
          says why it cannot.
        </LI>
        <LI>
          <Strong>Files:</Strong> a request can be up to 10 MB, so a file sent as one base64 string
          — without line breaks — can be about 7 MB; past 1 MB a request may carry nothing else that
          large. A file an operation answers with comes back embedded up to 1 MB, and one request
          embeds up to 2 MB of files in all; past that a file is described with the URL to download
          it with the same key.
        </LI>
        <LI>
          <Strong>A few at a time:</Strong> each Member runs up to four operations at once — later
          calls wait their turn — and has up to eight MCP requests open; one more is answered{" "}
          <Code>429</Code>.
        </LI>
        <LI>
          <Strong>Long answers</Strong> are cut at about 100,000 characters, with a note to ask for
          less: most list operations take <Code>limit</Code>, <Code>offset</Code> or a search term.
        </LI>
      </UL>
      <P>
        This is not the per-employee MCP endpoint. To have an outside agent act as one AI Employee
        with that employee&apos;s built-in tools and Grants, use its endpoint instead — see{" "}
        <DocLink to="/docs/integrations#external-mcp">Connecting an external MCP client</DocLink>.
      </P>

      <H3 id="errors">When a call fails</H3>
      <P>
        A failed call comes back as a tool error carrying Genosyn&apos;s own message, the HTTP
        status, and what it means for you: a <Code>400</Code> lists each field the operation&apos;s
        schema refused, a <Code>403</Code> says which role or Finance access the operation needs
        against what the key&apos;s Member has, a <Code>404</Code> reminds that every id must belong
        to this company, and a <Code>409</Code> says the record changed or already exists. A mistake
        in the call itself — a missing path parameter, the wrong call tool — is explained before
        anything is sent.
      </P>

      <Callout kind="warn" title="Anything your client can read, it can be told.">
        The server returns your company&apos;s data — emails, notes, customer messages — and text in
        it can try to instruct the model reading it. Keep your client asking before{" "}
        <Code>call_write_operation</Code> and <Code>call_delete_operation</Code>, and allow reads
        alone to run without asking. Give each client its own key, from a Member with no more role
        or Finance access than the work needs, prefer a key that expires, and revoke a key or
        disconnect an app at <Strong>Settings → API keys</Strong> the moment it is no longer used.
        Serve Genosyn over HTTPS so no credential crosses the network in the clear.
      </Callout>

      <H2 id="security">How the endpoint is guarded</H2>
      <UL>
        <LI>
          An API key or a connected app&apos;s token is the only credential. The server never reads
          the browser session cookie, so a page you have open elsewhere cannot use your sign-in to
          reach it.
        </LI>
        <LI>
          Signing in follows the MCP authorization specification — OAuth 2.1 with PKCE, discovery
          and dynamic client registration — with opaque tokens stored hashed:{" "}
          <DocLink to="/docs/connected-apps#how-it-works">how sign-in works</DocLink>.
        </LI>
        <LI>
          A request from a web page on another site is refused: the server accepts no browser{" "}
          <Code>Origin</Code> but your install&apos;s own public URL, as the MCP specification asks.
          Desktop, command-line and server clients send none.
        </LI>
        <LI>
          A request&apos;s body is read only after its key checks out, compressed bodies are
          refused, and the endpoint answers <Code>GET</Code> and <Code>DELETE</Code> with{" "}
          <Code>405</Code>: there is no event stream to open and no session to end.
        </LI>
        <LI>
          Each tool call is made inside Genosyn, so a reverse proxy in front of it sees only the
          request to <Code>/mcp</Code>. Rules it applies to individual API paths — rate limits, path
          rules, a web application firewall — do not reach the operations the server calls.
        </LI>
      </UL>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <KeyList
        rows={[
          {
            term: "401",
            def: (
              <>
                The key is missing, mistyped, revoked or expired — or it was minted for another
                company than the one in the URL. Check <Strong>Settings → API keys</Strong>. For an
                app that signs in, see{" "}
                <DocLink to="/docs/connected-apps#troubleshooting">Connected apps</DocLink>.
              </>
            ),
          },
          {
            term: "403 Origin not allowed",
            def: (
              <>
                A browser page on another site sent the request. Connect from a desktop or
                command-line client, or through a proxy that sends no <Code>Origin</Code>.
              </>
            ),
          },
          {
            term: "403 Forbidden",
            def: (
              <>
                The Member has left the company — or, for a connected app, is no longer an owner or
                admin.
              </>
            ),
          },
          {
            term: "406",
            def: (
              <>
                The client&apos;s <Code>Accept</Code> header rules out JSON. Send{" "}
                <Code>application/json, text/event-stream</Code>.
              </>
            ),
          },
          {
            term: "413",
            def: (
              <>
                The request is over 10 MB, or over 1 MB with something besides one file in it. Send
                a large file as a single base64 string with no line breaks, and other data in
                smaller calls.
              </>
            ),
          },
          {
            term: "429",
            def: (
              <>
                The Member already has eight MCP requests open. Let them finish; the client can
                retry after a second.
              </>
            ),
          },
          {
            term: "405 on GET",
            def: <>Expected: the server is stateless. MCP clients carry on over POST.</>,
          },
        ]}
      />
    </>
  );
}
