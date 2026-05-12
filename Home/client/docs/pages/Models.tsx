import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Models() {
  return (
    <>
      <PageHeader
        eyebrow="Brains & tools"
        title="AI Models"
        lead={
          <>
            Every AI Employee has exactly one <Strong>AI Model</Strong> — their
            brain. Pick a provider, sign in (or paste an API key), and the
            runner spawns that provider&apos;s CLI inside the employee&apos;s
            sandboxed directory.
          </>
        }
      />

      <H2 id="supported-providers">Supported providers</H2>
      <P>
        Genosyn supports five provider CLIs today. None of them are written by
        Genosyn — they&apos;re the official tools from each vendor. Genosyn
        just wraps them in a per-employee sandbox.
      </P>
      <P>
        Three of them (<Code>opencode</Code>, <Code>goose</Code>,{" "}
        <Code>openclaw</Code>) are routers and can point at an
        OpenAI-compatible endpoint you host yourself — see{" "}
        <DocLink to="/docs/open-source-models">Open-source LLMs</DocLink>{" "}
        for that flow.
      </P>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProviderCard
          name="claude-code"
          vendor="Anthropic"
          auth="Subscription sign-in or ANTHROPIC_API_KEY."
          mcpHost=".mcp.json at the employee's cwd"
        />
        <ProviderCard
          name="codex"
          vendor="OpenAI"
          auth="Subscription sign-in or OPENAI_API_KEY."
          mcpHost="$CODEX_HOME/config.toml — [mcp_servers.*] (stdio only)"
        />
        <ProviderCard
          name="opencode"
          vendor="opencode.ai"
          auth="Subscription sign-in or provider keys."
          mcpHost="opencode.json — mcp.* entries"
        />
        <ProviderCard
          name="goose"
          vendor="Block"
          auth="goose configure handles auth — Genosyn doesn't touch it."
          mcpHost="Passed as runtime --with-extension flags"
        />
        <ProviderCard
          name="openclaw"
          vendor="OpenClaw"
          auth="API key only."
          mcpHost="openclaw.json — mcp.servers.* (read-merge-write)"
        />
      </div>

      <H2 id="auth-modes">Auth modes</H2>
      <P>
        Three flows ship across the picker. Each provider opts into the ones
        that make sense for it — see the cards above.
      </P>
      <UL>
        <LI>
          <Strong>Subscription sign-in.</Strong> The runner launches the
          provider CLI&apos;s sign-in command, mirrors the OAuth URL into the
          browser, and waits for the credentials file to appear on disk. No
          tokens transit the database.
        </LI>
        <LI>
          <Strong>API key.</Strong> Paste a key, Genosyn AES-256-GCM encrypts
          it, and decrypts it back into env vars only at spawn time. The
          plaintext never lives on disk.
        </LI>
        <LI>
          <Strong>Custom OpenAI-compatible endpoint.</Strong> opencode and
          goose only. Paste a base URL + model id (and optionally an API
          key); Genosyn materializes the harness&apos;s config files
          (opencode.json + auth.json, or goose&apos;s config.yaml) before
          each spawn pointed at your endpoint. The path for any self-hosted
          LLM — see{" "}
          <DocLink to="/docs/open-source-models">Open-source LLMs</DocLink>.
        </LI>
      </UL>

      <H2 id="credentials-on-disk">Credentials on disk</H2>
      <P>
        Each provider has its own credential format. Genosyn keeps them under
        the employee&apos;s directory so a fired employee&apos;s access dies
        with their folder:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-zinc-700">
        {`data/companies/<co>/employees/<emp>/
├── .claude/      claude-code
├── .codex/       codex
├── .opencode/    opencode
├── .goose/       goose
└── .openclaw/    openclaw`}
      </pre>

      <H2 id="built-in-mcp">Built-in MCP servers</H2>
      <P>
        No matter which provider you pick, every spawn gets two built-in MCP
        servers materialized into the provider&apos;s config:
      </P>
      <UL>
        <LI>
          <Code>genosyn</Code> — stdio server the employee calls to write
          journal notes, create Routines / Todos / Notes, send messages on
          channels, and reach{" "}
          <Strong>any registered Integration tool</Strong>. Always on.
        </LI>
        <LI>
          <Code>browser</Code> — stdio server backed by a headless Chromium
          when <Code>browserEnabled</Code> is true on the employee. Skipped
          when off.
        </LI>
      </UL>

      <Callout kind="warn" title="Reserved names.">
        <Code>genosyn</Code> and <Code>browser</Code> are reserved MCP server
        names. If you register a user MCP server with either name, it&apos;s
        silently dropped when the config is materialized — the built-ins
        always win.
      </Callout>

      <H2 id="switching-disconnecting">Switching & disconnecting</H2>
      <P>
        To change an employee&apos;s model: disconnect the current one (this
        deletes the AIModel row and wipes the on-disk credentials for that
        provider), then attach the new provider. No data on Soul, Skills,
        Routines, or past Runs is affected.
      </P>

      <H3 id="openclaw-defaults">OpenClaw extras</H3>
      <P>
        OpenClaw&apos;s config file mixes MCP server settings with other
        runtime defaults (model picks, gateway, channels). Genosyn does a{" "}
        <Code>read-merge-write</Code> on <Code>openclaw.json</Code> so it
        preserves everything outside the <Code>mcp.servers</Code> block and
        only overlays its managed entries on top.
      </P>
    </>
  );
}

function ProviderCard({
  name,
  vendor,
  auth,
  mcpHost,
}: {
  name: string;
  vendor: string;
  auth: string;
  mcpHost: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[13px] font-semibold text-zinc-950">
          {name}
        </div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          {vendor}
        </div>
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-[1.6]">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Auth
          </dt>
          <dd className="text-zinc-700">{auth}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            MCP config
          </dt>
          <dd className="font-mono text-[12px] text-zinc-700">{mcpHost}</dd>
        </div>
      </dl>
    </div>
  );
}
