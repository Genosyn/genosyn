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

export function ApiCli() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="API CLI"
        lead={
          <>
            <Code>genosyn-api</Code> puts every operation an API key can call on the command line —
            for you, your scripts and your AI agents. It reads your install&apos;s{" "}
            <DocLink to="/docs/api">API reference</DocLink> as it runs, so whatever ships in
            Genosyn is scriptable the same day.
          </>
        }
      />

      <H2 id="install">Install it</H2>
      <P>
        Every Genosyn install serves the CLI it was released with, at{" "}
        <Code>/cli/genosyn-api.mjs</Code>. It is one file with nothing to install beside it, and
        needs Node.js 22 or later. Use your own address in place of the example:
      </P>
      <Pre lang="bash">{`mkdir -p ~/.local/bin
curl -fsSL https://genosyn.example.com/cli/genosyn-api.mjs -o ~/.local/bin/genosyn-api
chmod +x ~/.local/bin/genosyn-api
genosyn-api --version`}</Pre>
      <P>
        On Windows, save it as <Code>genosyn-api.mjs</Code> and run{" "}
        <Code>node genosyn-api.mjs</Code>. It is not the <DocLink to="/docs/cli">genosyn</DocLink>{" "}
        command that installs and upgrades the server: that one runs on the server; this one runs
        wherever you work.
      </P>

      <H2 id="login">Log in</H2>
      <OL>
        <LI>
          In the company you want to work in, open <Strong>Settings → API keys</Strong>,{" "}
          <DocLink to="/docs/api#mint-a-key">generate a key</DocLink>, and copy the{" "}
          <Strong>Base URL</Strong> shown there. It ends in <Code>/api/companies/</Code> and the
          company&apos;s id, so it names the install and the company at once.
        </LI>
        <LI>
          Run <Code>genosyn-api login --url</Code> with that Base URL, and paste the key when asked.
          Nothing is shown while you paste.
        </LI>
      </OL>
      <Pre lang="bash">{`genosyn-api login --url https://genosyn.example.com/api/companies/3f2c…
API key (input hidden):
✓ Logged in to Acme as ada@example.com (owner).

genosyn-api whoami`}</Pre>
      <P>
        <Code>login</Code> checks the key with the install before saving it, as a{" "}
        <Strong>profile</Strong> named after the company, in{" "}
        <Code>~/.genosyn/genosyn-api.json</Code>. Only you can read that file. A key belongs to one
        company, so each company is its own profile: <Code>genosyn-api profiles</Code> lists them,{" "}
        <Code>profiles use &lt;name&gt;</Code> switches, <Code>--profile &lt;name&gt;</Code> picks one
        for a single command, and <Code>logout</Code> forgets one. Forgetting it here does not
        revoke the key; <Strong>Revoke</Strong> on Settings → API keys does.
      </P>
      <P>
        In a script, pipe the key in instead of typing it:{" "}
        <Code>echo &quot;$KEY&quot; | genosyn-api login --url … --with-token</Code>. The key is
        never taken as a flag, where it would land in your shell history, and never printed: output
        shows only its first characters, as Settings does.
      </P>

      <H2 id="discover">Find an operation</H2>
      <P>
        Operations are grouped by area, the same groups as the API reference. Every command
        explains itself with <Code>--help</Code>, generated from the reference.
      </P>
      <Pre lang="bash">{`genosyn-api areas                      # the areas a key can work in
genosyn-api revenue                    # one area's operations
genosyn-api search "deal stage"        # find by id, summary, path or area
genosyn-api describe createRevenueDeal # parameters, body, access, usage
genosyn-api revenue create-deal --help # the same, by command`}</Pre>
      <P>
        Each operation has two names. Its <Strong>operation id</Strong> —{" "}
        <Code>createRevenueDeal</Code> — comes from the reference and changes only when the
        endpoint does, so scripts and agents should use it with <Code>call</Code>. Its command —{" "}
        <Code>revenue create-deal</Code> — is shorter, for people. Operations an API key
        can&apos;t call are left out of these lists; <Code>--include-all</Code> shows them.
      </P>

      <H2 id="call">Call it</H2>
      <P>
        Give parameters as flags (<Code>--amount-cents 120000</Code>) or as{" "}
        <Code>name=value</Code>; <Code>name:=&lt;json&gt;</Code> sends an exact JSON value. Path
        parameters can be given in order, without names. Text becomes what each field expects —
        a number, true or false, a list when a flag repeats. A whole body can come from{" "}
        <Code>--data</Code> as JSON, <Code>--data @file.json</Code>, or <Code>--data -</Code> for
        stdin; flags add to it. A parameter named like one of the CLI&apos;s own options —{" "}
        <Code>url</Code>, <Code>data</Code>, <Code>format</Code> — is always written{" "}
        <Code>name=value</Code>, as its help shows.
      </P>

      <H3 id="list-deals">List deals</H3>
      <Pre lang="bash">{`genosyn-api revenue list-deals --status open --limit 50
genosyn-api revenue list-deals --all --select 'rows.*.title'   # every page, titles only`}</Pre>

      <H3 id="create-a-routine">Create a Routine</H3>
      <Pre lang="bash">{`genosyn-api employees list --columns id,name,role
genosyn-api routines create-employee-routine <employee-id> \\
  --name "Morning digest" --cron-expr "0 9 * * 1-5" \\
  --brief "Summarize yesterday's open deals for the team."`}</Pre>

      <H3 id="run-a-routine">Run a Routine and read its Run</H3>
      <Pre lang="bash">{`genosyn-api routines run <routine-id>
genosyn-api routines list-runs <routine-id>
genosyn-api call getRunLog <run-id>`}</Pre>

      <H3 id="upload-a-file">Upload a file, and fetch one</H3>
      <Pre lang="bash">{`genosyn-api resources upload --file ./support-handbook.pdf
genosyn-api resources get-file support-handbook --output handbook.pdf`}</Pre>
      <P>
        A field that takes a file takes its path. An answer that is a file is saved with{" "}
        <Code>--output</Code>, or streamed when stdout is redirected; it is never printed to a
        terminal. Add <Code>--dry-run</Code> to any call to see the request — method, address,
        headers with the key cut short, and body — without sending it.
      </P>

      <H2 id="output">Output</H2>
      <KeyList
        rows={[
          {
            term: "At a terminal",
            def: <>Lists as tables, records as aligned fields, errors as a sentence.</>,
          },
          {
            term: "Into a pipe",
            def: (
              <>
                One compact JSON document on stdout; an error is one JSON line on stderr.{" "}
                <Code>--json</Code> asks for JSON at a terminal too, and <Code>--table</Code> for a
                table in a pipe.
              </>
            ),
          },
          {
            term: "--select",
            def: (
              <>
                Prints part of the result — <Code>id</Code>, <Code>rows.0.title</Code>,{" "}
                <Code>rows.*.id</Code>. A single string or number comes out bare, ready for{" "}
                <Code>$(…)</Code>.
              </>
            ),
          },
          {
            term: "--all",
            def: (
              <>
                Follows a list&apos;s pages (by cursor or offset) and prints one result in the
                first page&apos;s shape. <Code>--max-pages</Code> caps it at 100 by default.
              </>
            ),
          },
          {
            term: "--raw, --output",
            def: <>The response body exactly as it arrived, on stdout or in a file.</>,
          },
        ]}
      />

      <H2 id="exit-codes">Exit codes</H2>
      <P>
        A script can branch on the exit code; <Code>genosyn-api help exit-codes</Code> prints this
        table. Codes keep their meaning across releases.
      </P>
      <KeyList
        rows={[
          { term: "0", def: <>Success.</> },
          { term: "1", def: <>Unexpected error inside the CLI.</> },
          { term: "2", def: <>Bad command, option or argument. Nothing was sent.</> },
          { term: "3", def: <>Not logged in, or the server refused the key (401).</> },
          {
            term: "4",
            def: <>The key&apos;s Member may not do this (403), or it needs a signed-in browser.</>,
          },
          { term: "5", def: <>Nothing with that id in this company (404).</> },
          {
            term: "6",
            def: (
              <>
                The server rejected the request&apos;s content (400). The error lists each field
                with the flag that sets it.
              </>
            ),
          },
          { term: "7", def: <>Refused for another reason: a conflict (409), too many requests (429).</> },
          { term: "8", def: <>The server failed (5xx).</> },
          {
            term: "9",
            def: <>The server could not be reached, timed out, redirected, or isn&apos;t Genosyn.</>,
          },
        ]}
      />
      <Pre lang="json">{`{"error":{"kind":"validation","message":"The request didn't pass the server's validation.","exitCode":6,"status":400,"operationId":"createGoal","method":"POST","url":"…","issues":[{"path":"targetValue","message":"Required","flag":"--target-value"}]}}`}</Pre>

      <H2 id="agents">Use it from an AI agent</H2>
      <P>
        An agent — Claude Code, Codex, your own — works the CLI the way a person does, without the
        prompts. Give it a key from <Strong>Settings → API keys</Strong> for a Member whose role
        and Finance access fit the job, preferably one that expires, and put the key in its
        environment rather than in its instructions:
      </P>
      <Pre lang="bash">{`export GENOSYN_URL=https://genosyn.example.com/api/companies/<company-id>
export GENOSYN_API_KEY=gen_…`}</Pre>
      <UL>
        <LI>
          <Code>genosyn-api help agents</Code> is a one-screen brief to hand it: confirm the
          identity with <Code>whoami</Code>, <Code>search</Code>, read the operation with{" "}
          <Code>describe --json</Code>, then <Code>call</Code> it by operation id.
        </LI>
        <LI>
          Its stdout is JSON, its errors are one JSON line on stderr with the exit codes above,
          and a refused body names the fields to fix, so it can correct itself.
        </LI>
        <LI>
          <Code>--dry-run</Code> previews a change without making it.
        </LI>
        <LI>
          The operations that{" "}
          <DocLink to="/docs/api#what-a-key-can-do">need a person at a signed-in browser</DocLink>{" "}
          — approving, minting keys, credentials — are refused before anything is sent.
        </LI>
      </UL>
      <P>
        To let an AI Employee inside Genosyn use another system&apos;s tools, see{" "}
        <DocLink to="/docs/integrations">Integrations</DocLink>; this CLI is for agents outside
        Genosyn working on it.
      </P>

      <H2 id="environment">Environment and configuration</H2>
      <P>
        Flags beat environment variables, which beat the profile. A saved key is sent only to the
        install it was saved for: pointing <Code>GENOSYN_URL</Code> somewhere else needs{" "}
        <Code>GENOSYN_API_KEY</Code> too.
      </P>
      <KeyList
        rows={[
          { term: "GENOSYN_URL", def: <>The Base URL or install address. Flag: <Code>--url</Code>.</> },
          { term: "GENOSYN_API_KEY", def: <>The API key. Keep it in a secret store.</> },
          { term: "GENOSYN_COMPANY", def: <>The company id. Flag: <Code>--company</Code>.</> },
          { term: "GENOSYN_PROFILE", def: <>The profile to use. Flag: <Code>--profile</Code>.</> },
          {
            term: "GENOSYN_CONFIG",
            def: <>The config file. Default <Code>~/.genosyn/genosyn-api.json</Code>.</>,
          },
          {
            term: "GENOSYN_CACHE_DIR",
            def: <>Where API references are cached. Default beside the config.</>,
          },
          {
            term: "GENOSYN_SPEC_TTL",
            def: (
              <>
                Seconds to trust the cached reference before checking the server&apos;s version.
                Default <Code>300</Code>.
              </>
            ),
          },
          {
            term: "GENOSYN_TIMEOUT",
            def: <>Seconds before a request gives up. Default <Code>60</Code>. Flag: <Code>--timeout</Code>.</>,
          },
        ]}
      />
      <P>
        The CLI downloads <Code>/api/openapi.json</Code> once and keeps it beside the config. After
        five minutes it asks the server for its version, and downloads the reference again only
        when the version changed; an operation or parameter it doesn&apos;t know makes it check at
        once.{" "}
        <Code>genosyn-api spec refresh</Code> forces it.
      </P>

      <Callout kind="warn" title="The key is your access to this company.">
        Anyone holding it can do what you can there, short of the browser-only operations. The CLI
        stores it readable only by you and never prints it; keep it out of repositories and chat
        logs, and revoke it at Settings → API keys if it may have leaked.
      </Callout>
    </>
  );
}
