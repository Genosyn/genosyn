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
            subscription access for OpenAI on a trusted single-tenant install. OpenCode runs API-key
            and custom models, with host coding access enabled by default. Switch the active model
            any time without losing the others&apos; credentials.
          </>
        }
      />

      <H2 id="connect-model">Connect an AI Model</H2>
      <OL>
        <LI>
          Open an AI Employee, then go to <Strong>Settings → Model</Strong>.
        </LI>
        <LI>
          Select <Strong>Add model</Strong> and choose your <Strong>AI Model service</Strong>.
        </LI>
        <LI>
          For Claude or OpenAI, paste your API key. Genosyn loads the available models and
          recommends a current choice. Select <Strong>Connect AI Model</Strong> to test and save it.
          For a custom endpoint, enter its URL and model ID, then select <Strong>Add model</Strong>.
        </LI>
        <LI>
          To use ChatGPT subscription access, choose <Strong>ChatGPT sign-in</Strong>, continue,
          then select <Strong>Sign in with ChatGPT</Strong> on its card. Genosyn tests a reply after
          sign-in. Use <Strong>Make active</Strong> to switch between connected AI Models.
        </LI>
      </OL>

      <H2 id="supported-providers">Provider kinds</H2>
      <P>
        Three provider kinds cover every setup. API-key and custom-endpoint models use the bundled,
        pinned OpenCode runtime. Genosyn starts it automatically and supplies the selected model,
        company context, and granted tools. OpenAI subscription models use OpenAI&apos;s official
        Codex app-server.
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
          creds="API key, or trusted single-tenant ChatGPT subscription access."
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
          newest compatible Claude model available to your account, or you can choose another.
        </LI>
        <LI>
          <Strong>OpenAI API key.</Strong> Paste an OpenAI Platform API key for direct, usage-based
          access through OpenCode.
        </LI>
        <LI>
          <Strong>OpenAI subscription.</Strong> On a trusted single-tenant Genosyn deployment,
          complete ChatGPT device sign-in or paste a Codex access token from an eligible Business or
          Enterprise workspace. Genosyn runs this model through the pinned{" "}
          <Code>@openai/codex</Code> app-server. It remains available with the default host
          execution mode, optional bubblewrap, or coding disabled.
        </LI>
        <LI>
          <Strong>Custom.</Strong> Paste a base URL and a model id, plus an optional API key if your
          endpoint requires one. Genosyn tests a real tool-use reply before saving the endpoint.
          OpenCode then sends model requests to that endpoint.
        </LI>
      </UL>

      <H3 id="connect-and-test">Connect and test an AI Model</H3>
      <P>
        During onboarding, or under an AI Employee&apos;s <Strong>Settings → Model</Strong>, choose
        <Strong> AI Model service</Strong> and paste your <Strong>API key</Strong>. Genosyn loads
        the models your account can access and recommends a recent compatible model. You can select
        another from <Strong>Model</Strong>, or open <Strong>Choose a model ID manually</Strong>
        to enter an exact ID. A choice you make is preserved when the list reloads.
      </P>
      <P>
        Select <Strong>Connect AI Model</Strong>. Genosyn sends a small request through the same API
        that employee work uses and checks that the model can call a harmless test tool. The request
        uses a small amount of your API allowance. Only a successful test saves and activates the AI
        Model. If the key, model access, billing, or network needs attention, an inline error
        explains what to check; correct it and try again. A failed key replacement keeps the
        previous working credential.
      </P>
      <P>
        The OpenAI and Anthropic model lists do not declare a general default. Genosyn recommends
        from their live catalogs rather than shipping a fixed model version, and tests the chosen
        model before connecting. ChatGPT sign-in uses the default advertised for that workspace.
        Existing AI Models keep their selected IDs; onboarding does not silently upgrade them.
      </P>
      <P>
        To change a connected ChatGPT AI Model, edit its model ID and save. Genosyn tests the new
        choice with the existing sign-in before saving. Leave the model ID blank to discover and
        test the workspace&apos;s current default. If the test fails, the previous model stays
        selected.
      </P>

      <H3 id="openai-subscription">Use an OpenAI subscription</H3>
      <P>
        Subscription access is available on a trusted single-tenant deployment. In the add-model
        form, choose <Strong>OpenAI / ChatGPT</Strong>, set <Strong>Connect with</Strong> to{" "}
        <Strong>ChatGPT sign-in</Strong>, then select <Strong>Continue to ChatGPT sign-in</Strong>.
        Genosyn uses your workspace&apos;s current default model and tests a real reply before
        marking it connected. The model card offers two official Codex authentication paths:
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
        {", the"}
        <ExtLink href="https://learn.chatgpt.com/docs/enterprise/access-tokens">
          Business and Enterprise access-token flow
        </ExtLink>
        {", and the"}
        <ExtLink href="https://developers.openai.com/codex/app-server/">
          official Codex app-server
        </ExtLink>
        .
      </P>
      <Callout kind="warn" title="Unavailable in shared SaaS mode">
        When <Code>config.security.multiTenant</Code> is on, Genosyn rejects subscription model
        creation, sign-in, and Runs. Use an OpenAI API key in shared SaaS. Subscription credentials
        represent a person or workspace identity, and their device sessions and refresh locks are
        process-local, so Genosyn keeps this path inside the trust boundary of one self-hosted App
        process.
      </Callout>
      <Callout kind="info" title="Host coding is the default">
        <Code>config.agent.codingTools.executionMode</Code> ships as <Code>host</Code>. Coding
        commands run with the App process user&apos;s authority, inside the App container in Docker;
        they do not require an OS sandbox or Linux user namespaces. Choose <Code>disabled</Code> to
        omit coding and employee repository materialization, or <Code>bubblewrap</Code> to opt into
        isolated command execution. These modes do not change Genosyn&apos;s Grant and Approval
        checks on company tools. See <DocLink to="/docs/self-hosting">Configuration</DocLink>.
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
        database. Genosyn keeps the selected model&apos;s API key and gives OpenCode a temporary
        token for its model-request proxy. Managed Codex authentication requires file-backed state,
        so a subscription login or Run gets a new locked temporary <Code>CODEX_HOME</Code>; Genosyn
        materializes the credential there, never in the employee workspace, and removes the
        directory afterward. The app-server itself gets a separate empty scratch directory. This is
        credential lifecycle management; default host execution does not isolate processes from one
        another. Cleanup retries, and startup removes stale Genosyn Codex directories left by a
        prior crash. Removing a model (or firing the employee) deletes the encrypted row, so access
        dies with it.
      </Callout>

      <H2 id="context-window">Context window</H2>
      <P>
        Every turn includes the employee&apos;s Soul, Skills, and tools, and tool results add more
        history as work progresses. OpenCode owns context management and compaction for API-key and
        custom models. Genosyn passes the model&apos;s known context window to it; the Codex
        app-server manages context for subscription models.
      </P>
      <P>
        Genosyn probes the context window when a model connects and every three hours afterward. The
        model card shows the result. If your endpoint does not report a window, select
        <Strong> Set manually</Strong> and enter the number your server supports, such as
        vLLM&apos;s <Code>--max-model-len</Code> or llama.cpp&apos;s <Code>-c</Code>. A manual value
        takes precedence; <Strong>Clear</Strong> returns to the detected value, and
        <Strong> Ask the provider</Strong> retries detection immediately. A failed probe keeps the
        previous value. Subscription model cards omit these controls.
      </P>

      <H2 id="built-in-tools">Built-in agent tools</H2>
      <P>
        API-key and custom-endpoint models run through OpenCode; an OpenAI subscription model runs
        through the official Codex app-server. Both receive the same granted product and built-in
        browser <Strong>catalogue</Strong>. Subscription turns omit parallel delegation because they
        serialize on the model&apos;s credential-refresh lock. The installation mode controls coding
        tools and user-configured stdio MCP as described below. An employee is shown a small working
        set every turn and looks the rest up on demand; see{" "}
        <DocLink to="/docs/tool-discovery">How tools reach the model</DocLink>. The catalogue is:
      </P>
      <UL>
        <LI>
          <Strong>Coding tools.</Strong> Ordinary employee work uses OpenCode&apos;s native file,
          search, edit, and shell tools in the default host mode. Subscription models use
          Genosyn&apos;s coding tools through Codex. Host commands execute with the App process
          user&apos;s authority. Disabled mode omits coding entirely. Optional bubblewrap mode
          disables native coding and supplies an isolated command tool. Restricted review turns omit
          coding, and Repository work sessions use only their scoped
          <Code> repository_*</Code> tools and the Repository&apos;s command policy.
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
          <Code>browser</Code> — browser tools backed by real Chrome when{" "}
          <Code>browserEnabled</Code> is true on the employee. Skipped when off.
        </LI>
        <LI>
          <Strong>Company MCP servers.</Strong> HTTP MCP servers your company has configured are
          added alongside the built-ins. User-configured stdio servers are omitted in disabled and
          bubblewrap modes. They are available in trusted single-tenant host mode.
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
        one is <Strong>active</Strong> at a time; the active model is the default brain for employee
        Chat and the model inherited by Routines and other AI surfaces. The most recently added
        model becomes active automatically — hit <Strong>Make active</Strong> on any other to
        switch, instantly and as often as you like.
      </P>
      <P>
        Open an employee, then <Strong>Settings → Model</Strong> to see the roster: each card shows
        the provider kind, model string, connection status, and an <Strong>Active</Strong> badge on
        the current brain. Use <Strong>Add model</Strong> to register another.
      </P>
      <P>
        When at least two models are connected, the dedicated employee Chat composer shows an{" "}
        <Strong>AI Model</Strong> picker. You can choose a different brain for the next message
        without changing the employee&apos;s active model or any Routine. Follow-ups remember the
        model selected when each message entered the queue, including while a durable turn recovers
        after a disconnect or server restart.
      </P>
      <P>
        <Strong>Each conversation keeps its own model.</Strong> Reopening a past thread puts the
        picker back on the model that thread last answered on, not on whatever is active now — so a
        long conversation carries on with the same brain, context window, and billing you started it
        with. A brand-new thread starts on the active model, and so does a thread whose model has
        since been deleted or disconnected.
      </P>

      <H3 id="model-errors">When a chat or Run reports a model error</H3>
      <P>
        OpenCode manages temporary model-service retries for API-key and custom models. The Codex
        app-server manages subscription retries. Genosyn keeps the same Run while the runtime
        retries; cancelling work or reaching the Run deadline stops it. If the runtime cannot
        complete a model request, the Run ends with <Strong>Error</Strong>. Retry timing and context
        compaction belong to the selected runtime rather than a second Genosyn model loop.
      </P>
      <P>
        If Genosyn loses the response connection while OpenCode is still working, it reconnects to
        the same session with exponential backoff: roughly 1s, 2s, 4s, 8s and 16s, then up to 30s.
        It reads the existing session&apos;s progress and final result, preserving completed work
        without submitting the request again. Recovery stops on cancellation, the original Run or
        chat deadline, or ten consecutive failed reconnection attempts. Retries appear in the Run
        log.
      </P>
      <P>
        The error names the model used for that turn, shows the safe host-only endpoint, and
        explains the failure type or HTTP status. Runtime provider response bodies are not copied
        into the Run log. In chat, use <Strong>Review AI Model settings</Strong> on the error to
        jump straight to the active employee&apos;s model roster. A separate{" "}
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
    <div className="border border-hairline bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[13px] font-semibold text-ink">{name}</div>
        <div className="text-[11px] uppercase text-muted">{vendor}</div>
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-[1.6]">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">
            Credentials
          </dt>
          <dd className="text-ink2">{creds}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">
            Connects to
          </dt>
          <dd className="text-ink2">{connects}</dd>
        </div>
      </dl>
    </div>
  );
}
