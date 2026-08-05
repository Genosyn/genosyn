import {
  Callout,
  Code,
  DocLink,
  ExtLink,
  H2,
  H3,
  LI,
  OL,
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
            Every AI Employee can register one or more <Strong>AI Models</Strong> — their brains —
            and keep exactly one <Strong>active</Strong> at a time. Connect Anthropic or OpenAI with
            an API key, point at your own OpenAI-compatible endpoint, or use eligible ChatGPT
            subscription access for OpenAI on a source-managed Linux server with bubblewrap
            isolation. Switch the active model any time without losing the others&apos; credentials.
          </>
        }
      />

      <H2 id="connect-model">Connect an AI Model</H2>
      <OL>
        <LI>
          Open an AI Employee, then go to <Strong>Settings → Model</Strong>.
        </LI>
        <LI>
          Select <Strong>Add model</Strong> and choose Anthropic, OpenAI, or Custom.
        </LI>
        <LI>
          Choose the model and authentication method. For Custom, enter the endpoint and model id in
          the same form. Then select <Strong>Add model</Strong>.
        </LI>
        <LI>
          On the new card, paste the Anthropic / OpenAI API key, or select{" "}
          <Strong>Sign in with ChatGPT</Strong> for an OpenAI subscription. The newest model becomes
          active automatically; use <Strong>Make active</Strong> when you want to switch back to
          another.
        </LI>
      </OL>

      <H2 id="supported-providers">Provider kinds</H2>
      <P>
        Three provider kinds cover every setup. API-key and custom-endpoint models talk straight to
        the model API from Genosyn&apos;s in-process agent loop. OpenAI subscription models use
        OpenAI&apos;s official Codex app-server; there is still no generic provider CLI to install
        or maintain.
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
          creds="API key, or source-managed Linux ChatGPT subscription access."
          connects="Models available to the selected OpenAI access method."
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
        Everything a model needs is entered in the app. There is no persistent per-provider config
        directory to manage:
      </P>
      <UL>
        <LI>
          <Strong>Anthropic.</Strong> Paste an Anthropic Console API key. The runner picks the
          default Claude model, or you can name a specific model string.
        </LI>
        <LI>
          <Strong>OpenAI API key.</Strong> Paste an OpenAI Platform API key for direct, usage-based
          access through Genosyn&apos;s in-process model loop.
        </LI>
        <LI>
          <Strong>OpenAI subscription.</Strong> On a source-managed Linux Genosyn deployment with
          bubblewrap isolation, complete ChatGPT device sign-in or paste a Codex access token from
          an eligible Business or Enterprise workspace. Genosyn runs this model through the pinned{" "}
          <Code>@openai/codex</Code> app-server.
        </LI>
        <LI>
          <Strong>Custom.</Strong> Paste a base URL and a model id, plus an optional API key if your
          endpoint requires one. The loop then points every request at that endpoint.
        </LI>
      </UL>

      <H3 id="openai-subscription">Use an OpenAI subscription</H3>
      <P>
        Subscription access is available only on a source-managed Linux deployment whose bubblewrap
        isolation check passes. In the add-model form, choose <Strong>OpenAI (GPT)</Strong>, set{" "}
        <Strong>Authentication</Strong> to <Strong>ChatGPT subscription</Strong>, choose the model,
        then select <Strong>Add model</Strong>. The model card offers two official Codex
        authentication paths:
      </P>
      <UL>
        <LI>
          <Strong>ChatGPT device sign-in.</Strong> Select <Strong>Sign in with ChatGPT</Strong>,
          then <Strong>Open ChatGPT sign-in</Strong>. Sign in to the ChatGPT account and workspace
          you want to use and enter the displayed one-time code. Device sign-in must be enabled in
          your ChatGPT security settings or by your workspace admin.
        </LI>
        <LI>
          <Strong>Codex access token.</Strong> Open{" "}
          <Strong>Advanced: Business or Enterprise access token</Strong> and paste a token created
          by a permitted member of that workspace. Workspace admins control whether members can
          create these tokens and use Codex Local.
        </LI>
      </UL>
      <P>
        This uses the Codex access and limits attached to the selected ChatGPT workspace; it does
        not turn a ChatGPT subscription into a general OpenAI Platform API key. OpenAI documents the{" "}
        <ExtLink href="https://learn.chatgpt.com/docs/auth#login-on-headless-devices">
          device-code flow
        </ExtLink>
        {", the "}
        <ExtLink href="https://learn.chatgpt.com/docs/enterprise/access-tokens">
          Business and Enterprise access-token flow
        </ExtLink>
        {", and the "}
        <ExtLink href="https://developers.openai.com/codex/app-server/">
          official Codex app-server
        </ExtLink>
        .
      </P>
      <Callout kind="warn" title="Unavailable in shared SaaS mode">
        When <Code>config.security.multiTenant</Code> is on, Genosyn rejects subscription model
        creation, sign-in, and Runs. Use an OpenAI API key in shared SaaS. Subscription credentials
        represent a person or workspace identity and may run code, so Genosyn keeps this path inside
        the trust boundary of a self-hosted deployment.
      </Callout>
      <Callout kind="info" title="Subscription auth needs coding-tool isolation">
        Genosyn requires working Linux bubblewrap for subscription auth. A same-user host shell from
        any concurrent AI Employee could inspect the temporary Codex credential. Set{" "}
        <Code>config.agent.codingTools.executionMode</Code> to <Code>bubblewrap</Code>; host and
        disabled modes are rejected. API-key models are unchanged.
      </Callout>
      <Callout kind="info" title="Coding and repository sync share one boundary">
        Every model turn in a bubblewrap deployment exposes only sandboxed <Code>bash</Code> from
        the coding family. The host-process file tools are omitted install-wide, so an overlapping
        API-key or custom-model turn cannot race a workspace symlink into a subscription credential.
        Automatic repository clone, fetch, and credential setup run through the same private PID and
        temporary-filesystem boundary with a cleared environment and only the configured remote.
      </Callout>
      <Callout kind="warn" title="Run one App replica">
        Device sessions and managed ChatGPT refresh locks currently live in one Genosyn process. Use
        this authentication mode with a single-App-process self-hosted topology. If you horizontally
        scale App replicas, use OpenAI API keys instead.
      </Callout>

      <H3 id="anthropic-subscriptions">Why Claude subscriptions are not offered</H3>
      <P>
        Genosyn does not ask for or accept Claude.ai or Claude Code subscription credentials.
        Anthropic&apos;s{" "}
        <ExtLink href="https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account">
          account authentication guidance
        </ExtLink>{" "}
        tells developers building third-party products to use an API key and prohibits routing
        third-party traffic against subscription limits. Connect Anthropic with a Console API key
        instead.
      </P>

      <Callout kind="info" title="Encrypted at rest, ephemeral when materialized.">
        API keys, endpoints, and OpenAI subscription credentials are AES-256-GCM encrypted in the
        database. Direct API credentials are decrypted in memory only when the agent loop makes a
        request. Managed Codex authentication requires file-backed state, so a subscription login or
        Run gets a new locked temporary <Code>CODEX_HOME</Code>; Genosyn materializes the credential
        there, never in the employee workspace, and removes the directory afterward. The app-server
        itself gets a separate empty scratch directory; Genosyn&apos;s granted tools remain the only
        route to the employee workspace. Cleanup retries, and startup removes stale Genosyn Codex
        directories left by a prior crash. Removing a model (or firing the employee) deletes the
        encrypted row, so access dies with it.
      </Callout>

      <H2 id="context-window">Context window</H2>
      <P>
        Every turn sends the employee&apos;s Soul, their Skills, and their working set of tools, and
        each tool call adds its result on top. A long routine therefore grows until it reaches
        whatever the model will accept — so the direct agent loop needs to know how much room there
        is. When an API-key or custom-endpoint model connects, Genosyn asks the provider and shows
        the answer on the model card. For an OpenAI subscription model, the Codex app-server owns
        context management, so its card does not show the manual context-window controls.
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
        API-key and custom-endpoint models run through Genosyn&apos;s in-process agent loop; an
        OpenAI subscription model runs through the official Codex app-server. The employee keeps the
        same granted <Strong>catalogue</Strong> either way, except that subscription turns omit
        parallel delegation because they serialize on the model&apos;s credential-refresh lock. An
        employee is shown a small working set every turn and looks the rest up on demand; see{" "}
        <DocLink to="/docs/tool-discovery">How tools reach the model</DocLink>. The catalogue is:
      </P>
      <UL>
        <LI>
          <Strong>Coding tools.</Strong> <Code>bash</Code>, <Code>read_file</Code>,{" "}
          <Code>write_file</Code>, <Code>edit_file</Code>, <Code>glob</Code>, and <Code>grep</Code>{" "}
          — run inside the employee&apos;s sandboxed directory.
        </LI>
        <LI>
          <Code>genosyn</Code> — the tools the employee calls to run Routines and Todos, write
          journal notes, save Memory, work with Bases, Notes, Resources, charts, mail, finance and
          attachments, and reach <Strong>any registered Integration tool</Strong>. Always available;
          the frequently-used ones are loaded up-front and the rest are a <Code>find_tools</Code>{" "}
          call away.
        </LI>
        <LI>
          <Code>find_tools</Code> and <Code>call_tool</Code> — how the employee searches the
          catalogue and runs anything in it. Always on.
        </LI>
        <LI>
          <Code>browser</Code> — browser tools backed by a headless Chromium when{" "}
          <Code>browserEnabled</Code> is true on the employee. Skipped when off.
        </LI>
        <LI>
          <Strong>Company MCP servers.</Strong> HTTP MCP servers your company has configured are
          added alongside the built-ins. User-configured stdio servers are omitted whenever
          bubblewrap mode is active, across every model turn, because an arbitrary same-UID child
          would break the subscription credential boundary.
        </LI>
      </UL>

      <Callout kind="warn" title="Reserved names.">
        <Code>genosyn</Code> and <Code>browser</Code> are reserved tool names. If a company MCP
        server uses either name, it&apos;s silently dropped — the built-ins always win.
      </Callout>

      <H3 id="tool-limit">How many tools an employee can hold</H3>
      <P>
        The direct OpenAI API path accepts at most <Strong>128 tools</Strong> on a request and
        rejects the whole turn if you send more. Anthropic publishes no such limit, and a custom
        endpoint sets its own.
      </P>
      <P>
        In practice this no longer binds. Only the working set goes on the request — around{" "}
        <Strong>20 tools</Strong> — so the catalogue behind it can grow without approaching any
        provider&apos;s ceiling. An employee with a dozen Connections is fine.
      </P>
      <P>
        The old trimming behaviour is still there as a backstop: if the working set somehow did
        exceed a cap, Genosyn drops the lowest-value tools until it fits, preferring ones the
        employee holds no <DocLink to="/docs/integrations">Grant</DocLink> for, and writes a{" "}
        <Code>[tools]</Code> line into the run log naming exactly what it dropped. Every run also
        logs how the catalogue was split, so you can always see what the employee was shown.
      </P>

      <H2 id="multiple-models">Multiple models &amp; the active one</H2>
      <P>
        An employee can hold several models side by side — say an <Code>Anthropic</Code> key for
        everyday work and an <Code>OpenAI</Code> subscription model for a second opinion. Exactly
        one is <Strong>active</Strong> at a time; the active model is the default brain for
        employee Chat and the model inherited by Routines and other AI surfaces. The most recently
        added model becomes active automatically — hit <Strong>Make active</Strong> on any other
        to switch, instantly and as often as you like.
      </P>
      <P>
        Open an employee, then <Strong>Settings → Model</Strong> to see the roster: each card shows
        the provider kind, model string, connection status, and an <Strong>Active</Strong> badge on
        the current brain. Use <Strong>Add model</Strong> to register another.
      </P>
      <P>
        When at least two models are connected, the dedicated employee Chat composer shows an{" "}
        <Strong>AI Model</Strong> picker. It starts on the active model, but you can choose a
        different brain for the next message without changing the employee&apos;s active model or
        any Routine. Follow-ups remember the model selected when each message entered the queue,
        including while a durable turn recovers after a disconnect or server restart.
      </P>

      <H3 id="model-errors">When a chat or Run reports a model error</H3>
      <P>
        For API-key and custom-endpoint models, temporary model-service and network failures are
        retried automatically before Genosyn reports an error. Each model turn gets up to{" "}
        <Strong>five attempts</Strong> with a short exponential backoff; provider{" "}
        <Code>Retry-After</Code> guidance is respected up to 30 seconds, and cancelling the chat or
        Run cancels the wait. A turn is never replayed after visible output has started, because
        doing so could duplicate a partial answer. Run transcripts record each retry on a{" "}
        <Code>[model]</Code> line. The Codex app-server manages retries for subscription-auth turns,
        so those turns do not use Genosyn&apos;s five-attempt loop or its retry transcript lines.
      </P>
      <P>
        The error names the model used for that turn, shows the safe host-only endpoint, preserves the
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
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[13px] font-semibold text-slate-950">{name}</div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{vendor}</div>
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-[1.6]">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Credentials
          </dt>
          <dd className="text-slate-700">{creds}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Connects to
          </dt>
          <dd className="text-slate-700">{connects}</dd>
        </div>
      </dl>
    </div>
  );
}
