import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function ConnectedApps() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="Connected apps"
        lead={
          <>
            claude.ai, ChatGPT and any MCP client that signs in with OAuth connect to the{" "}
            <DocLink to="/docs/mcp-server">Genosyn MCP server</DocLink> without a key: you approve
            the app in Genosyn, and it acts as you in that one company until you disconnect it.
          </>
        }
      />

      <H2 id="approve">Approving an app</H2>
      <P>
        Add the MCP server&apos;s endpoint to an app that signs in —{" "}
        <DocLink to="/docs/mcp-server#claude-ai">claude.ai</DocLink> or{" "}
        <DocLink to="/docs/mcp-server#chatgpt">ChatGPT</DocLink> — and the app sends you to Genosyn.
        Sign in if you are not already, and the consent page shows:
      </P>
      <UL>
        <LI>
          <Strong>The app</Strong>, by the name it gave itself and the address it returns you to —{" "}
          <Code>claude.ai</Code>, <Code>chatgpt.com</Code>. A name can be anything; the address
          cannot. Allow only an app you started connecting yourself, from that address.
        </LI>
        <LI>
          <Strong>You</Strong>, with <Strong>Use another account</Strong> in case you are signed in
          as someone else.
        </LI>
        <LI>
          <Strong>The company.</Strong> The endpoint names one, so an app usually arrives with the
          company chosen. One that did not name a company lets you pick among yours.
        </LI>
        <LI>
          <Strong>What it can do</Strong>, with your role and Finance access, and how long it stays
          connected.
        </LI>
      </UL>
      <P>
        <Strong>Allow</Strong> sends you back to the app, connected. <Strong>Deny</Strong> sends you
        back with nothing. Either way, the code that comes back is only good to the app that asked
        for it: it must prove so (PKCE) before it gets a token.
      </P>

      <H2 id="who">Who may connect an app</H2>
      <P>
        Owners and admins. An app acts with your whole authority through the MCP server, and there
        is no key for anyone to look after, so connecting one is kept to the people trusted with the
        company. A Member connects a desktop client — Claude Desktop, Claude Code, Cursor — with an{" "}
        <DocLink to="/docs/api">API key</DocLink> instead.
      </P>
      <P>
        The rule is checked when you approve and again on every request the app makes: demoted to
        Member, or removed from the company, you lose your apps with the role. A company that
        requires two-factor authentication requires it before you can approve one.
      </P>

      <H2 id="reach">What a connected app can reach</H2>
      <P>
        What an API key of yours can, checked the same way on every call: your role and Finance
        access at that moment, and nothing that needs a signed-in browser — minting keys, Member
        roles, deciding Approvals, the Vault. Its token works at the company&apos;s MCP endpoint and
        nowhere else: presented to a REST route directly, it is refused. Every change it makes lands
        in the <DocLink to="/docs/security">audit log</DocLink> under your name.
      </P>

      <H2 id="lifetime">How long it lasts</H2>
      <KeyList
        rows={[
          {
            term: "Access token",
            def: (
              <>
                An hour. The app refreshes it on its own, and each refresh replaces the refresh
                token too.
              </>
            ),
          },
          {
            term: "Refresh token",
            def: (
              <>
                30 days from its last use. An app unused that long stops, and works again only once
                you approve it again.
              </>
            ),
          },
          {
            term: "A stolen copy",
            def: (
              <>
                A refresh token works once. Used again later and the app is disconnected at once —
                for the thief and the app alike. An authorization code works once too, for five
                minutes.
              </>
            ),
          },
        ]}
      />

      <H2 id="disconnect">Seeing and disconnecting your apps</H2>
      <P>
        <Strong>Settings → API keys → Connected apps</Strong> lists the apps you connected to the
        company, each with the address it returns to, when you connected it and when it was last
        used. <Strong>Disconnect</Strong> stops one on its next request; to use it again, connect it
        from the app. The list is yours alone, like your API keys, and connecting or disconnecting
        an app is recorded in the audit log.
      </P>

      <H2 id="how-it-works">How sign-in works</H2>
      <P>For anyone building an MCP client: the server follows the MCP authorization spec.</P>
      <UL>
        <LI>
          A request to the endpoint without a credential is answered <Code>401</Code>, with{" "}
          <Code>WWW-Authenticate</Code> naming the protected-resource metadata (RFC 9728) at{" "}
          <Code>/.well-known/oauth-protected-resource/api/companies/&lt;id&gt;/mcp</Code>.
        </LI>
        <LI>
          That names the authorization server — your install — whose metadata (RFC 8414) is at{" "}
          <Code>/.well-known/oauth-authorization-server</Code>.
        </LI>
        <LI>
          Clients register themselves (RFC 7591). Registration is open, twenty an hour from one
          address, and an app may only return to an <Code>https</Code> address, or <Code>http</Code>{" "}
          on the same computer. Registrations never connected are removed after a month.
        </LI>
        <LI>
          Authorization is the code flow with PKCE, <Code>S256</Code> only, and a{" "}
          <Code>resource</Code> (RFC 8707) naming the company&apos;s endpoint. The one scope is{" "}
          <Code>mcp</Code>.
        </LI>
        <LI>
          Tokens are opaque and stored hashed, never JWTs, so whether one still works is always the
          database&apos;s answer. An app may revoke its own tokens (RFC 7009).
        </LI>
      </UL>
      <Callout kind="warn" title="The public URL must be the address clients connect to.">
        Discovery, sign-in and the check on a browser&apos;s <Code>Origin</Code> are all built from
        the public URL at <Strong>Admin → General</Strong>. If it names another address than the
        endpoint&apos;s, apps refuse the metadata. Serve Genosyn over HTTPS, too: claude.ai and
        ChatGPT reach your install from the internet.
      </Callout>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <KeyList
        rows={[
          {
            term: "The sign-in stops on a Genosyn page",
            def: (
              <>
                The app asked to send you somewhere it never registered, or its registration was
                removed after a month unused. Remove the connector in the app and add it again.
              </>
            ),
          },
          {
            term: "Only owners and admins can connect apps",
            def: (
              <>Ask an owner to make you an admin, or connect a desktop client with an API key.</>
            ),
          },
          {
            term: "Resource does not match",
            def: (
              <>
                Set the public URL at <Strong>Admin → General</Strong> to the address in the
                endpoint, then connect again.
              </>
            ),
          },
          {
            term: "The app stopped working",
            def: (
              <>
                It was disconnected, went 30 days unused, or its Member lost the role. Connect it
                again from the app.
              </>
            ),
          },
        ]}
      />
    </>
  );
}
