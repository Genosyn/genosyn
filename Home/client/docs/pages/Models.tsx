import { Callout, Code, DocLink, H2, H3, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Models() {
  return (
    <>
      <PageHeader
        eyebrow="Brains & tools"
        title="AI Models"
        lead={
          <>
            Every AI Employee can register one or more <Strong>AI Models</Strong> — their brains —
            and keep exactly one <Strong>active</Strong> at a time. A model is a direct connection
            to a model API: pick a provider kind, paste a key (or point at your own endpoint), and
            the runner drives that model through an in-process agent loop. Switch the active model
            any time without losing the others&apos; credentials.
          </>
        }
      />

      <H2 id="supported-providers">Provider kinds</H2>
      <P>
        A model talks straight to a model API from inside Genosyn — there&apos;s no CLI to install,
        no subscription sign-in, and nothing written to disk. Three provider kinds cover every
        setup:
      </P>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProviderCard
          name="Anthropic (Claude)"
          vendor="Anthropic"
          creds="Paste an API key."
          connects="Claude models — Opus, Sonnet, Haiku."
        />
        <ProviderCard
          name="OpenAI (GPT)"
          vendor="OpenAI"
          creds="Paste an API key."
          connects="GPT models."
        />
        <ProviderCard
          name="Custom"
          vendor="OpenAI-compatible"
          creds="Base URL + model id, plus an optional key."
          connects="Ollama, vLLM, llama.cpp, LM Studio, or any gateway."
        />
      </div>

      <P>
        The <Code>Custom</Code> kind is the path for any self-hosted or gatewayed LLM that speaks
        the OpenAI API — see <DocLink to="/docs/open-source-models">Open-source LLMs</DocLink> for
        that flow.
      </P>
      <Callout kind="warn" title="Hosted network boundary">
        Tenant-controlled endpoints are resolved through Genosyn&apos;s public-network policy:
        private, loopback, link-local, reserved, and DNS-rebinding destinations are rejected. Keep
        self-hosted model servers on a single-tenant deployment; shared SaaS should use a public,
        authenticated endpoint plus an egress firewall.
      </Callout>

      <H2 id="credentials">Credentials</H2>
      <P>
        Everything a model needs is entered in the app. There&apos;s no OAuth sign-in and no
        per-provider config file to manage — just the fields the kind requires:
      </P>
      <UL>
        <LI>
          <Strong>Anthropic and OpenAI.</Strong> Paste an API key. That&apos;s the whole setup — the
          runner picks the default model for the kind, or you can name a specific model string.
        </LI>
        <LI>
          <Strong>Custom.</Strong> Paste a base URL and a model id, plus an optional API key if your
          endpoint requires one. The loop then points every request at that endpoint.
        </LI>
      </UL>
      <Callout kind="info" title="Encrypted at rest.">
        Keys and endpoints are AES-256-GCM encrypted and stored in the database — never on disk.
        They&apos;re decrypted in memory only when the agent loop makes a request. Removing a model
        (or firing the employee) deletes the encrypted row, so access dies with it.
      </Callout>

      <H2 id="context-window">Context window</H2>
      <P>
        Every turn sends the employee&apos;s Soul, their Skills, and the whole tool catalog, and
        each tool call adds its result on top. A long routine therefore grows until it reaches
        whatever the model will accept — so Genosyn needs to know how much room there is. When a
        model connects, it asks the provider and shows the answer on the model card.
      </P>
      <P>
        Once it knows, a run <Strong>budgets</Strong> against it: when the next prompt wouldn&apos;t
        fit, the oldest tool results are dropped to a stub so recent work and the routine&apos;s
        instruction survive. The run log says <Code>[compact]</Code> whenever that happens, so a
        forgetful-looking employee is always explained by its transcript.
      </P>
      <P>
        Not every server reports a window. vLLM, LM Studio, and llama.cpp publish one; plain Ollama
        and OpenAI&apos;s own API don&apos;t. When the card reads <Strong>Unknown</Strong>, use{" "}
        <Strong>Ask the provider</Strong> to retry, or <Strong>Set manually</Strong> and type the
        number in — whatever the server was launched with, such as vLLM&apos;s{" "}
        <Code>--max-model-len</Code> or llama.cpp&apos;s <Code>-c</Code>. A number you set by hand
        always wins over the probe, and <Strong>Clear</Strong> hands the field back to it.
      </P>
      <Callout kind="warn" title="Unknown is worth fixing.">
        With no window there is nothing to budget against, so a run can only discover it has overrun
        when the provider rejects a turn. Genosyn recovers — it drops history and retries once
        rather than failing the run — but it wastes a round-trip and loses more history than it
        needed to. Small self-hosted models feel this first: a 64k window can be half spent on the
        system prompt before any work begins.
      </Callout>

      <H2 id="built-in-tools">Built-in agent tools</H2>
      <P>
        The runner and chat both run an in-process agent loop that hands the model tools directly —
        no matter which provider kind you pick, every model gets the same toolset:
      </P>
      <UL>
        <LI>
          <Strong>Coding tools.</Strong> <Code>bash</Code>, <Code>read_file</Code>,{" "}
          <Code>write_file</Code>, <Code>edit_file</Code>, <Code>glob</Code>, and <Code>grep</Code>{" "}
          — run inside the employee&apos;s sandboxed directory.
        </LI>
        <LI>
          <Code>genosyn</Code> — the tools the employee calls to run Routines and Todos, write
          journal notes, save Memory, work with Bases and attachments, and reach{" "}
          <Strong>any registered Integration tool</Strong>. Always on.
        </LI>
        <LI>
          <Code>browser</Code> — browser tools backed by a headless Chromium when{" "}
          <Code>browserEnabled</Code> is true on the employee. Skipped when off.
        </LI>
        <LI>
          <Strong>Company MCP servers.</Strong> Any MCP servers your company has configured are
          added to the loop alongside the built-ins.
        </LI>
      </UL>

      <Callout kind="warn" title="Reserved names.">
        <Code>genosyn</Code> and <Code>browser</Code> are reserved tool names. If a company MCP
        server uses either name, it&apos;s silently dropped — the built-ins always win.
      </Callout>

      <H3 id="tool-limit">How many tools an employee can hold</H3>
      <P>
        OpenAI accepts at most <Strong>128 tools</Strong> on a request and rejects the whole turn if
        you send more. Anthropic publishes no such limit, and a custom endpoint sets its own — so
        this only constrains employees whose active model is an OpenAI one.
      </P>
      <P>
        The built-ins take up roughly 49 of those slots (coding, the <Code>genosyn</Code> tools, and
        the browser tools when enabled), which leaves about 79 for Integration tools and company MCP
        servers. That is a lot — but a single Integration can register a dozen or more tools, so an
        employee granted many Connections at once can reach the ceiling.
      </P>
      <P>
        If it happens, the run doesn&apos;t fail. Genosyn drops the lowest-value tools until the
        list fits, preferring to cut ones the employee holds no{" "}
        <DocLink to="/docs/integrations">Grant</DocLink> for and therefore couldn&apos;t have used
        anyway, and writes a <Code>[tools]</Code> line into the run log naming exactly what it
        dropped. If you see that line, remove a Connection or an MCP server from the employee — or
        move it to an Anthropic or custom model, which have no cap.
      </P>

      <H2 id="multiple-models">Multiple models &amp; the active one</H2>
      <P>
        An employee can hold several models side by side — say an <Code>Anthropic</Code> key for
        everyday work and an <Code>OpenAI</Code> key for a second opinion. Exactly one is{" "}
        <Strong>active</Strong> at a time; the active model is the brain the loop runs for routines
        and the chat seam answers with. The most recently added model becomes active automatically —
        hit <Strong>Make active</Strong> on any other to switch, instantly and as often as you like.
      </P>
      <P>
        Open an employee, then <Strong>Settings → Model</Strong> to see the roster: each card shows
        the provider kind, model string, connection status, and an <Strong>Active</Strong> badge on
        the current brain. Use <Strong>Add model</Strong> to register another.
      </P>

      <H3 id="model-errors">When a chat or Run reports a model error</H3>
      <P>
        The error names the active model, shows the safe host-only endpoint, preserves the
        provider&apos;s detail and request ID when available, and lists checks for that failure
        type. In chat, use <Strong>Review AI Model settings</Strong> on the error to jump straight
        to the active employee&apos;s model roster. A separate{" "}
        <Strong>chat connection interrupted</Strong> message means the browser lost its stream to
        the Genosyn server; confirm the server is running and inspect its logs before retrying. A{" "}
        <Strong>Genosyn couldn&apos;t complete this chat turn</Strong> message includes the
        conversation ID to search for in those logs and usually points to server-side setup such as
        a Browser or company MCP connection.
      </P>

      <H3 id="removing-a-model">Removing a model</H3>
      <P>
        <Strong>Remove</Strong> on a model card deletes that AIModel row along with its encrypted
        credentials. If you remove the active model, the most recently added survivor is promoted to
        active. No data on Soul, Skills, Routines, or past Runs is affected.
      </P>
    </>
  );
}

function ProviderCard({
  name,
  vendor,
  creds,
  connects,
}: {
  name: string;
  vendor: string;
  creds: string;
  connects: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[13px] font-semibold text-zinc-950">{name}</div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{vendor}</div>
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-[1.6]">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Credentials
          </dt>
          <dd className="text-zinc-700">{creds}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Connects to
          </dt>
          <dd className="text-zinc-700">{connects}</dd>
        </div>
      </dl>
    </div>
  );
}
