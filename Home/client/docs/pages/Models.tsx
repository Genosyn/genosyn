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
            <Strong>AI Models</Strong> are your AI Employees&apos; brains, and they belong to the
            company. Connect a model once — Anthropic or OpenAI with an API key, or{" "}
            <a href="#api-keys">several keys it spreads its work across</a>, your own
            OpenAI-compatible endpoint, or eligible ChatGPT subscription access for OpenAI — and
            attach it to as many
            AI Employees as you like: they share one set of keys and settings. Each employee can
            have several attached and keeps exactly one <Strong>active</Strong>. OpenCode runs
            API-key and custom models, with host coding access enabled by default.
          </>
        }
      />

      <H2 id="company-models">The company&apos;s AI Models</H2>
      <P>
        <Strong>Settings → AI Models</Strong> (or <Code>⌘K</Code>, then <Strong>AI Models</Strong>)
        lists every AI Model the company has, newest first. Each is one card: the service and model
        in plain words, whether it is <Strong>Connected</Strong> and how, and{" "}
        <Strong>Used by</Strong> — every AI Employee it is attached to, marked{" "}
        <Strong>active</Strong> where it is the model that employee&apos;s chat and Routines use,
        or <Strong>standby</Strong>. From the page:
      </P>
      <UL>
        <LI>
          <Strong>Add an AI Model</Strong> connects a new one. It waits on the page, used by nobody,
          until you attach it.
        </LI>
        <LI>
          <Strong>Attach to AI Employees</Strong> on a card lists every employee not on it yet, with
          what each runs on now. Tick any number and select <Strong>Attach</Strong>: each switches
          to this AI Model, and <Strong>Make active</Strong> on their own Model page switches back.
          Only a connected model can be attached.
        </LI>
        <LI>
          The <Strong>×</Strong> beside an employee&apos;s name detaches the model from them, after
          asking. Detaching never deletes the model: it stays here with its keys, and everyone else
          keeps using it. An employee whose active model it was switches to its most recently
          attached other one, and its Routines pinned to the model go back to that.
        </LI>
        <LI>
          <Strong>Test connection</Strong>, the model&apos;s keys and settings, and{" "}
          <Strong>Remove from the company</Strong> are on the card as on an employee&apos;s page —
          see <a href="#advanced">Each AI Model&apos;s card</a>.
        </LI>
      </UL>
      <P>
        Owners and admins manage this page; a Member who opens it is told so, and still sees what
        each employee runs on from that employee&apos;s Model page. Only someone signed in to the
        app can attach, detach or remove a model: API keys, so the{" "}
        <DocLink to="/docs/api-cli">genosyn-api CLI</DocLink> and the{" "}
        <DocLink to="/docs/mcp-server">Genosyn MCP server</DocLink>, can&apos;t, and no AI Employee
        has a tool that chooses its own model or another&apos;s. Every attach, detach and change is
        in the <DocLink to="/docs/security#audit-log">audit log</DocLink>.
      </P>

      <H3 id="sharing">One model, many AI Employees</H3>
      <P>
        Every AI Employee attached to a model runs on that same model — not a copy. So its API keys
        are one pool for all of them — their sessions take the keys in turn together — a key added
        once serves all of them, a key the provider refuses rests for all of them, a change of
        model changes it for all of them, and a key rotated at the provider needs updating in one
        place. Usage lands on the account the key bills. On an employee&apos;s Model page a shared
        model&apos;s card says <Strong>Also used by</Strong> whoever else runs on it, and its{" "}
        <Strong>Advanced</Strong> section repeats that a change there changes it for them too. Its{" "}
        <a href="#concurrent-runs">Run limit</a> counts every employee&apos;s Runs together.
      </P>
      <P>
        A ChatGPT sign-in can be shared too. It takes one turn at a time whichever employee asks, so
        its employees take turns: a Routine Run waits in the queue rather than on the sign-in, and
        it serves one Run at a time unless you change that.
      </P>

      <H3 id="duplicates">Copies of the same model</H3>
      <P>
        Before AI Models belonged to the company, each employee kept its own, and the same key was
        often pasted — or copied — for several of them. Upgrading turns each of those into a
        company model attached to its employee, keeping its keys, their health, its settings and
        which one was active; nothing is merged on its own. When two or more company models are
        exactly the same — the same service, model, endpoint and keys, in whatever order — Settings
        → AI Models says so above the cards: <Strong>2 copies of … with the same keys</Strong>.{" "}
        <Strong>Merge into one</Strong> moves everyone on a copy to the oldest one, which keeps its
        settings, carries each key&apos;s health across, points Routine, mailbox and Work session
        pins at it, and removes the other copies. Keys are compared without ever being shown or
        logged. A ChatGPT sign-in is never offered for merging: two sign-ins are two sessions.
      </P>

      <H2 id="connect-model">Connect an AI Model</H2>
      <OL>
        <LI>
          Open <Strong>Settings → AI Models</Strong> and select <Strong>Add an AI Model</Strong>, or
          open an AI Employee and go to <Strong>Settings → Model</Strong>. An employee with no AI
          Model shows the connect form; if the company already has one, the page leads with{" "}
          <Strong>Use the same AI Model as</Strong> whoever runs on it instead — see{" "}
          <a href="#employee-models">An employee&apos;s AI Models</a>.
        </LI>
        <LI>
          Choose your <Strong>AI Model service</Strong>.
        </LI>
        <LI>
          For Claude or OpenAI, paste your API key; <Strong>Get an Anthropic key</Strong> or{" "}
          <Strong>Get an OpenAI key</Strong> under the field opens the page that creates one.
          Genosyn loads the available models and recommends a current choice. Select{" "}
          <Strong>Connect AI Model</Strong> to test and save it. For a custom endpoint, enter its
          URL and model ID, then select <Strong>Continue</Strong>.
        </LI>
        <LI>
          To use ChatGPT subscription access, choose <Strong>ChatGPT sign-in</Strong>, continue,
          then select <Strong>Sign in with ChatGPT</Strong> on its card. Genosyn tests a reply after
          sign-in.
        </LI>
      </OL>
      <P>
        A model connected from an employee&apos;s page is the company&apos;s too: it appears in
        Settings → AI Models, attached to that employee, ready for others. Owners and admins
        connect, test, change and remove AI Models. Other Members see an employee&apos;s cards and
        settings without the controls, and an employee with none says that an owner or admin
        connects one.
      </P>

      <H2 id="employee-models">An employee&apos;s AI Models</H2>
      <P>
        An AI Employee&apos;s <Strong>Settings → Model</Strong> shows the company models attached to
        it, the active one first. To give it another, select <Strong>Add an AI Model</Strong> under
        its cards: the company&apos;s other connected models are listed first under{" "}
        <Strong>Already in your company</Strong>, the one most of the company runs on leading, each
        with <Strong>Use this one</Strong>, above the connect form for a new one. Whatever you add
        becomes the employee&apos;s active model; <Strong>Make active</Strong> on a card switches
        back. Nothing is copied and no key is pasted — the employee runs on the same model.
      </P>
      <UL>
        <LI>
          <Strong>When you hire.</Strong> <Strong>Hire {"{name}"}</Strong> attaches the company&apos;s
          AI Model to the new employee — the one most of the team runs on — and the next screen says
          so, with a link to <Strong>Settings → Model</Strong> to change it. With no model in the
          company yet, the next screen connects one instead.
        </LI>
        <LI>
          <Strong>An employee with none.</Strong> Its page shows the company&apos;s model in plain
          words — for example <Strong>Claude (Anthropic) · claude-sonnet-4-5</Strong>, used by Avery
          — and one button, <Strong>Use the same AI Model as Avery</Strong>.{" "}
          <Strong>Connect a different model</Strong> shows the connect form and the company&apos;s
          other models.
        </LI>
      </UL>

      <H2 id="advanced">Each AI Model&apos;s card</H2>
      <P>
        Every AI Model is one card, and everything about that model is on it. The top says the
        service and model in plain words, whether it is <Strong>Connected</Strong>, and how — an
        API key, a ChatGPT sign-in, or the server a custom endpoint reaches. Beside it:
      </P>
      <UL>
        <LI>
          <Strong>Test connection</Strong> asks the model for one small reply, the same test it
          passed when it was connected, and changes nothing. A pass says how long the reply took;
          a failure says what to check, with the service&apos;s own words behind{" "}
          <Strong>View details</Strong>. It spends a little of the account&apos;s allowance.
        </LI>
        <LI>
          On an employee&apos;s page, <Strong>Make active</Strong> on every connected model that
          isn&apos;t the active one, and <Strong>Also used by</Strong> for a shared model. In
          Settings → AI Models, who uses it and <Strong>Attach to AI Employees</Strong>.
        </LI>
      </UL>
      <P>
        The bottom of the card is that model&apos;s own <Strong>Advanced</Strong> section, closed
        until you open it:
      </P>
      <UL>
        <LI>
          A Claude or OpenAI model connected with a key: its <Strong>API keys</Strong> — every
          key it <a href="#api-keys">spreads its sessions across</a>, each with how it has been
          doing — then <Strong>Model</Strong>, <Strong>Context window</Strong> and{" "}
          <Strong>Concurrent Routine Runs</Strong>.
        </LI>
        <LI>
          A custom endpoint: its <Strong>Endpoint</Strong> — the server, the model it serves and
          whether a key is saved — then context window and concurrent Runs.
        </LI>
        <LI>
          A ChatGPT sign-in: the <Strong>ChatGPT sign-in</Strong> and its <Strong>Model</Strong>.
          Codex manages its context and Runs.
        </LI>
        <LI>
          Last, on an employee&apos;s page, <Strong>Detach from</Strong> the employee; in Settings →
          AI Models, <Strong>Remove from the company</Strong> — see{" "}
          <a href="#removing-a-model">Removing a model</a>.
        </LI>
      </UL>
      <P>
        Its closed line names whatever has been moved off its default on that model, so nothing you
        set is hidden by being folded away: for example{" "}
        <Strong>3 API keys · 4 concurrent Runs</Strong>. A key the provider is refusing adds{" "}
        <Strong>1 API key failing</Strong> — and the card itself says so too, above the line. A
        custom endpoint whose server did not report a context window reads{" "}
        <Strong>Context window unknown</Strong>. With nothing changed it names what is inside, such
        as <Strong>API keys, model, context window and Run limit</Strong>. No setting applies to
        every model at once, so the page holds only the cards and <Strong>Add an AI Model</Strong>.
      </P>
      <P>
        To run a different model on the same service, open <Strong>Model</Strong> and select{" "}
        <Strong>Change</Strong>: the list comes from the models the card&apos;s own keys can reach,
        with the current one marked, so there is nothing to paste. Genosyn tests the model you pick
        before saving it, and the model keeps its keys. The same form switches to the other
        API-key service with a new key.
      </P>

      <H2 id="api-keys">API keys: one pool, spread across sessions</H2>
      <P>
        A Claude (Anthropic) or OpenAI model connected with an API key can hold any number of keys
        — several accounts&apos; keys, say, to get past one account&apos;s rate limits or credit.
        None of them is a primary or a backup: they are equals, and the model&apos;s work is spread
        across all of them. Open <Strong>Advanced</Strong> on the model card;{" "}
        <Strong>API keys</Strong> lists them:
      </P>
      <UL>
        <LI>
          <Strong>Add a key</Strong>: paste it, then select <Strong>Add key</Strong>. Genosyn tests
          a real reply with that key on its own before adding it, the same test a new model gets,
          so a key that fails is never saved. There is no limit on how many you add, and a new key
          joins the turns straight away.
        </LI>
        <LI>
          The bin removes a key after you confirm; sessions carry on across the others. The only
          key can&apos;t be removed — remove the model instead. There is no order to set: every key
          takes its turn.
        </LI>
        <LI>
          Switching the model to another service, in <Strong>Model → Change</Strong>, asks for that
          service&apos;s key and drops the old ones, since another service&apos;s keys would not
          work.
        </LI>
      </UL>
      <P>
        Each new <Strong>session</Strong> opens on the next key in turn and keeps that key until it
        ends. A session is one piece of work on the model: a chat reply, a Routine Run&apos;s work
        (a Check fix or the grading of a Run is a session of its own), a turn of a{" "}
        <DocLink to="/docs/repositories">Repository work session</DocLink>, a delegated copy of
        the work, and a meeting&apos;s transcription. Staying on one key keeps a session&apos;s
        prompt caching and rate limits on one account; the next session takes the next key, so
        with three keys every third session lands on each. Every AI Employee on the model draws
        from the same pool, the turns start from a random key after the App restarts, and sessions
        that start at the same moment never take the same turn. Test connection and the test
        behind <Strong>Add key</Strong> are not work, so they take no turn.
      </P>
      <P>
        When the provider refuses a session&apos;s key — invalid or revoked (HTTP 401), not
        allowed (403), out of credit or a billing problem (402, or a 400 that says the credit
        balance is too low), rate-limited or out of quota (429) — Genosyn sends the very same
        request again on the next key in turn before any of the reply reaches the AI Employee, so
        its work carries on without noticing, and the rest of the session stays on the key that
        answered. A refused key is then skipped by every session for five minutes, or for as long
        as a rate limit asks (a minute when it doesn&apos;t say), though it is still tried last
        when every other key is refused; once it wakes it takes its turn again. When every key is
        resting, a new session opens on the one whose rest ends soonest. Anything else — a
        malformed or over-long request, an unknown model, the provider failing or overloaded, no
        answer at all — is not about the key, so it goes back unchanged, and OpenCode retries the
        temporary ones itself; a service that keeps failing makes the model{" "}
        <a href="#unavailable">unavailable</a>. When every key is refused, the chat or Run reports
        the provider&apos;s own error, the last key&apos;s or an earlier key&apos;s — except when
        every key is only rate-limited: that is the service saying &quot;not now&quot;, so the
        model is unavailable until the limit resets and its work waits instead of failing. A
        Run&apos;s log says which key it opened on and notes each switch, by preview.
      </P>
      <P>
        Each key shows only a preview such as <Code>sk-…c123</Code>, with when it was last used,
        how many sessions it carried in the last 24 hours — so you can see the work spread across
        the keys — when the provider last refused it and why, and <Strong>Skipped for now</Strong>{" "}
        while it rests, so a dead key is easy to spot. Every key is encrypted at rest. Owners and
        admins add and remove keys; other Members only see the list. Each change is in the{" "}
        <DocLink to="/docs/security#audit-log">audit log</DocLink>. Custom endpoints and ChatGPT
        sign-in take no API keys of this kind.
      </P>

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
          creds="API key, or eligible ChatGPT subscription access."
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
      <Callout kind="warn" title="Private endpoints must be allowed first">
        Custom endpoints go through Genosyn&apos;s outbound network policy: private, loopback,
        link-local, reserved, and DNS-rebinding destinations are rejected. To use a model server on
        your own network, add its host under <Strong>Outbound network</Strong> at{" "}
        <Code>Admin → Runtime</Code>; see{" "}
        <DocLink to="/docs/self-hosting#private-hosts">Reaching something on your own network</DocLink>
        .
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
          <Strong>OpenAI subscription.</Strong> Complete ChatGPT device sign-in or paste a Codex
          access token from an eligible Business or Enterprise workspace. Genosyn runs this model
          through the pinned <Code>@openai/codex</Code> app-server. It works in the default host
          execution mode and with command execution disabled.
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
        explains what to check; correct it and try again. When the AI Model&apos;s service said why
        it refused the test, select <Strong>View details</Strong> on the error to read its own
        explanation, HTTP status, and request ID, which its support team can look up. A failed key
        replacement keeps the previous working credential.
      </P>
      <P>
        The OpenAI and Anthropic model lists do not declare a general default. Genosyn recommends
        from their live catalogs rather than shipping a fixed model version, and tests the chosen
        model before connecting. ChatGPT sign-in uses the default advertised for that workspace.
        Existing AI Models keep their selected IDs; onboarding does not silently upgrade them.
      </P>
      <P>
        To change a connected ChatGPT AI Model, open <Strong>Model → Change</Strong> on its card,
        edit the model ID and save. Genosyn tests the new
        choice with the existing sign-in before saving. Leave the model ID blank to discover and
        test the workspace&apos;s current default. If the test fails, the previous model stays
        selected.
      </P>

      <H3 id="openai-subscription">Use an OpenAI subscription</H3>
      <P>
        In the connect form (under <Strong>Add an AI Model</Strong> for an employee who already
        has one), choose <Strong>OpenAI / ChatGPT</Strong>, set{" "}
        <Strong>Connect with</Strong> to <Strong>ChatGPT sign-in</Strong>, then select{" "}
        <Strong>Continue to ChatGPT sign-in</Strong>.
        Genosyn uses your workspace&apos;s current default model and tests a real reply before
        marking it connected. While the sign-in is waiting, the model card offers two official
        Codex authentication paths; once it is connected they sit in{" "}
        <Strong>ChatGPT sign-in</Strong> under the card&apos;s <Strong>Advanced</Strong>:
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
          <Strong>Business or Enterprise access token</Strong> and paste a token created by a
          permitted member of that workspace. Workspace admins control whether members can
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
      <Callout kind="info" title="Host coding is the default">
        <Code>config.agent.codingTools.executionMode</Code> ships as <Code>host</Code>. Coding
        commands run directly on the host with the App process user&apos;s filesystem and network
        authority, inside the App container in Docker; there is no OS sandbox. Choose{" "}
        <Code>disabled</Code> to omit coding and employee repository materialization. Neither mode
        changes Genosyn&apos;s Grant and Approval checks on company tools. See{" "}
        <DocLink to="/docs/self-hosting">Configuration</DocLink>.
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
        API keys (every key in a model&apos;s pool), endpoints, and OpenAI subscription credentials are
        AES-256-GCM encrypted in the database. Genosyn keeps the selected model&apos;s API keys and
        gives OpenCode a temporary token for its model-request proxy. Managed Codex authentication
        requires file-backed state,
        so a subscription login or Run gets a new locked temporary <Code>CODEX_HOME</Code>; Genosyn
        materializes the credential there, never in the employee workspace, and removes the
        directory afterward. The app-server itself gets a separate empty scratch directory. This is
        credential lifecycle management; default host execution does not isolate processes from one
        another. Cleanup retries, and startup removes stale Genosyn Codex directories left by a
        prior crash. A model&apos;s credentials belong to the company and live on its one row:
        detaching it from an employee, or letting an employee go, ends that employee&apos;s use of
        it at once, and removing it from the company deletes the row and its keys.
      </Callout>

      <H2 id="context-window">Context window</H2>
      <P>
        Every turn includes the employee&apos;s Soul, Skills, and tools, and tool results add more
        history as work progresses. OpenCode owns context management and compaction for API-key and
        custom models. Genosyn passes the model&apos;s known context window to it; the Codex
        app-server manages context for subscription models.
      </P>
      <P>
        Genosyn probes the context window when a model connects or changes, and every three hours
        afterward.
        Open <Strong>Advanced</Strong> on the model card to see the result. If your endpoint does
        not report a window, select
        <Strong> Set manually</Strong> and enter the number your server supports, such as
        vLLM&apos;s <Code>--max-model-len</Code> or llama.cpp&apos;s <Code>-c</Code>. A manual value
        takes precedence; <Strong>Clear</Strong> returns to the detected value, and
        <Strong> Ask the provider</Strong> retries detection immediately. A failed probe keeps the
        previous value. Subscription model cards omit these controls.
      </P>

      <H2 id="concurrent-runs">Concurrent Routine Runs</H2>
      <P>
        <Strong>Concurrent Routine Runs</Strong>, under <Strong>Advanced</Strong> on the model
        card, sets how many Routine Runs may use the model at once. Runs beyond the limit wait in
        the queue and start when one finishes, in queue order —{" "}
        <DocLink to="/docs/routines#priority">High priority</DocLink> Routines first; their time
        limit starts then. A <Code>Custom</Code>{" "}
        endpoint on this machine or a private network defaults to one at a time, a ChatGPT sign-in
        to one at a time, and everything else to no limit. The limit is the model&apos;s, so every
        AI Employee attached to it shares it, and models that point at the same endpoint share it
        too. See <DocLink to="/docs/open-source-models#busy-model">When the model is busy</DocLink>.
      </P>

      <H2 id="unavailable">When an AI Model is unavailable</H2>
      <P>
        Now and then a model&apos;s service stops answering for a while: a hosted API has an
        incident or is overloaded, the server on your own network restarts, or every one of the
        model&apos;s keys is rate-limited. Genosyn then calls the model{" "}
        <Strong>unavailable</Strong> and treats it as a wait, not as the work going wrong. Nothing
        needs redoing, and nothing is counted against the AI Employee or the Routine:
      </P>
      <UL>
        <LI>
          <Strong>Routine Runs</Strong> on the model don&apos;t start, and a Run that was working
          pauses as the same Run, keeping its transcript, progress and the time it had left — see{" "}
          <DocLink to="/docs/routines#paused-for-unavailable-model">
            Paused while its AI Model was unavailable
          </DocLink>
          .
        </LI>
        <LI>
          <Strong>A chat message</Strong> says{" "}
          <Strong>The AI Model is unavailable — this will be answered when it is back</Strong> and
          is answered then, with nothing to send again; <Strong>Stop</Strong> cancels it. See{" "}
          <DocLink to="/docs/chat#model-unavailable">Chat</DocLink>. So does a reply in a
          Workspace channel, DM or group chat, where everyone in the conversation sees it waiting —
          see <DocLink to="/docs/workspace-chat#live-activity">Workspace chat</DocLink>.
        </LI>
        <LI>
          <Strong>Background work</Strong> waits as well, instead of recording a result the outage
          made up: grading a Run against its acceptance criteria, an employee&apos;s Wakeups, TLDR
          briefings and board letters, meeting write-ups, application screening, data-room answers
          and Sequence drafts. A Run is never graded off goal or unverified because its model was
          unavailable.
        </LI>
        <LI>
          <Strong>An email that arrives</Strong> waits to be read, as the arrival it is; your
          mailbox&apos;s instructions act on it once it is read, and rules and Pipelines run
          meanwhile — see <DocLink to="/docs/email#analysis-unavailable">Email</DocLink>.
        </LI>
        <LI>
          <Strong>A Pipeline run</Strong> pauses at the step that asks an AI Employee and carries on
          from there — see <DocLink to="/docs/pipelines#paused-runs">Pipelines</DocLink>.
        </LI>
        <LI>
          <Strong>Decisions</Strong>: the work an answer starts waits and then starts by itself, and
          an AI decider keeps the question without anyone being paged — see{" "}
          <DocLink to="/docs/decisions#model-unavailable">Decisions</DocLink>.
        </LI>
        <LI>
          <Strong>A group discussion</Strong> waits within its time limit, and{" "}
          <Strong>Start the work</Strong> waits for each owner&apos;s model — see{" "}
          <DocLink to="/docs/collaboration#discussion-unavailable">Collaboration</DocLink>.
        </LI>
        <LI>
          <Strong>People outside the company</Strong> are answered when the model is back: a message
          on Slack, Teams, Telegram or WhatsApp (told once that the answer is coming), an answer in a{" "}
          <DocLink to="/docs/customer-channels#model-unavailable">customer channel</DocLink>, and an
          automatic text reply. A live phone call can&apos;t wait, so the employee says so and takes
          a message — see <DocLink to="/docs/phone-numbers#model-unavailable">Phone numbers</DocLink>{" "}
          and <DocLink to="/docs/chat-surfaces#model-unavailable">Chat surfaces</DocLink>.
        </LI>
      </UL>
      <P>
        Each piece of that work carries on once, and everything it would have checked on a normal
        day is checked when it runs — Grants, Standdowns, delivery limits, who will read the answer —
        not when it began to wait. Work that meets the model unavailable ten times after resuming is
        given up, saying why. An answer owed to someone outside the company is given up after a day
        — three days on Slack, Teams and Telegram, where the person was told it is coming — so a late
        reply never lands in a conversation long over.
      </P>
      <P>
        What makes a model unavailable: its service can&apos;t be reached (a refused connection,
        an unknown host, a certificate that does not verify, no answer in time), it answers with a
        server error (HTTP 5xx) or says it is overloaded (such as Anthropic&apos;s 529), or every
        key is rate-limited (429) until a limit resets. One refused connection, unknown host or bad
        certificate is enough; a server error, an overload or a timeout counts once three requests
        in a row have failed with one (by default), or once a piece of work has run out of retries
        on one. Any success resets the count. A key the service refuses — invalid, revoked, out of
        credit or quota — is not an outage: the work moves to the model&apos;s{" "}
        <a href="#api-keys">next key</a>, and when none works the chat or Run reports the error,
        since waiting would not fix it. Neither is a request the model rejects, such as one longer
        than its context window.
      </P>
      <P>
        Every AI Employee the model is attached to shares its state, and so does every copy of it
        that reaches the same custom endpoint. The state is kept in the database, so a restart
        remembers it and every replica sees the same thing.
      </P>

      <H3 id="unavailable-checks">Checks, and coming back</H3>
      <P>
        While a model is unavailable, Genosyn asks it again with a cheap check, run on the server
        with the model&apos;s own credentials: a reply a few tokens long for an Anthropic or OpenAI
        key, the list of models for a custom endpoint, and the same small test as{" "}
        <Strong>Test connection</Strong> for a ChatGPT sign-in. The first check comes 30 seconds
        after the model became unavailable; each check that finds it still unavailable doubles the
        wait, up to ten minutes, with a little jitter, and never sooner than a retry time the service
        asked for (honoured up to an hour). One check per model runs at a time, across every
        replica.
      </P>
      <P>
        The model is available again as soon as a check — or any real work on it — succeeds, and
        the work that waited carries on by itself. Paused Runs go first, with the time they had
        left, then the Runs that were queued; for ten minutes they start ten seconds apart (by
        default), so they don&apos;t all land at once on a model that has just come back. Waiting
        direct-chat messages are answered straight away; Workspace replies that waited take the
        same turns as the Runs, one at a time. The model&apos;s card counts both kinds of message
        among the work that waits.
      </P>

      <H3 id="unavailable-card">Seeing it, and Check now</H3>
      <P>
        An unavailable model&apos;s card says <Strong>Unavailable</Strong>, since when and why —{" "}
        <em>Its service is overloaded</em>, <em>Genosyn can&apos;t reach it</em> — with the latest
        failure in one line, what is waiting (
        <em>3 Runs, 1 chat message and 2 other pieces of work are waiting</em>), how
        many checks found it still unavailable, and when the next one is. Owners and admins can select{" "}
        <Strong>Check now</Strong> to ask it at once instead of waiting for the next check. A paused
        Run says why in its status and its log, a waiting one says so in its AI Employee&apos;s
        work queue on Home, and <DocLink to="/docs/routines#system-health">System Health</DocLink>{" "}
        lists the model under <Strong>AI Models unavailable</Strong>.
      </P>
      <P>
        Owners and admins get one notification when a check confirms the model is unavailable and
        one when it is available again — never one per Run or message. A blip that clears before
        the first check notifies nobody. A master admin can change when a model counts as
        unavailable and how often it is checked at{" "}
        <DocLink to="/docs/self-hosting#runtime-settings">
          Admin → Runtime → Unavailable AI Models
        </DocLink>
        .
      </P>
      <P>
        An unavailable model is not a <DocLink to="/docs/standdowns">Standdown</DocLink>: nobody
        decided to stop the work, and it lifts itself. The two work together — a Standdown placed
        meanwhile still holds the work it covers after the model is back, and lifting a Standdown
        starts nothing on a model that is still unavailable.
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
          user&apos;s authority. Disabled mode omits coding entirely. Restricted review turns omit
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
          added alongside the built-ins. User-configured stdio servers run in host mode and are
          omitted in disabled mode.
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
        An employee can have several company models attached side by side — say an{" "}
        <Code>Anthropic</Code> key for everyday work and an <Code>OpenAI</Code> subscription model
        for a second opinion. Exactly one is <Strong>active</Strong> for that employee; the active
        model is the default brain for employee Chat and the model inherited by Routines and other
        AI surfaces. Which model is active is each employee&apos;s own: the same model can be one
        employee&apos;s active model and another&apos;s standby. The most recently attached model
        becomes active automatically — hit <Strong>Make active</Strong> on any other to switch,
        instantly and as often as you like.
      </P>
      <P>
        Open an employee, then <Strong>Settings → Model</Strong> to see the roster: each card names
        the service and model in plain words and shows whether it is connected. With more than one
        model the current brain carries an <Strong>Active</Strong> badge and every other connected
        model offers <Strong>Make active</Strong>. Use <Strong>Add an AI Model</Strong> to register
        another.
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
        since been detached, removed or disconnected.
      </P>

      <H3 id="thinking-level">Thinking levels: how hard the model thinks</H3>
      <P>
        Many AI Models can think before they answer, and think harder when asked. A Member picks a{" "}
        <Strong>thinking level</Strong> for each conversation from <Strong>Thinking</Strong> in the
        Chat composer — Off, Low, Medium, High, Max, and Minimal, Extra high or Ultra where a model
        offers them — and the level sticks to that conversation (see{" "}
        <DocLink to="/docs/chat#thinking-level">Chat</DocLink>). Higher levels help with hard
        problems but take longer and cost more. Genosyn sends each AI Model the level its own way:
      </P>
      <UL>
        <LI>
          <Strong>Claude 4.6 and later</Strong> — adaptive thinking at that effort. Claude Opus 4.6,
          4.7 and 4.8 and Sonnet 4.6 think only when asked, so their own default is Off; Claude
          5-family models always think, so Low is their lightest level and their own default is the
          API&apos;s (Medium on Claude Opus 5.5 and Haiku 5.5, High on the rest).
        </LI>
        <LI>
          <Strong>Older Claude models</Strong> (Opus 4.5, Sonnet 4.5, Haiku 4.5, Opus 4 and 4.1,
          Sonnet 4) — a thinking budget sized by the level; Off, their own default, means no
          thinking.
        </LI>
        <LI>
          <Strong>OpenAI models</Strong> (GPT-5 family, o-series) — their reasoning effort; Off is
          available where the model has <Code>none</Code>.
        </LI>
        <LI>
          <Strong>ChatGPT sign-ins</Strong> — the Codex runtime&apos;s per-turn effort, from the
          levels the pinned Codex release lists for the model, Ultra included.
        </LI>
        <LI>
          <Strong>Custom endpoints</Strong> — none until an owner turns{" "}
          <Strong>Offer thinking levels</Strong> on (below); then Off, Low, Medium and High as{" "}
          <Code>reasoning_effort</Code>.
        </LI>
      </UL>
      <P>
        Every level that thinks also asks the model to show a summary of its thinking, which the
        chat&apos;s live activity displays. If an AI Model refuses the level it is sent, the reply
        carries on at the model&apos;s own default and says so under it — Genosyn never fails the
        reply over a level, and never drops one silently. A model Genosyn knows nothing about runs at
        its own default, and the menu says why its levels are greyed out. Routines and other work
        no Member chose a level for — replies on Slack, Teams, Telegram or WhatsApp, screening,
        briefings — run at the AI Model&apos;s own default.
      </P>
      <P>
        <Strong>Defaults and limits for owners.</Strong> In the model&apos;s Advanced section,{" "}
        <Strong>Thinking level</Strong> sets <Strong>Default for chat</Strong> — the level a
        conversation left on Default starts at — and <Strong>Highest Members may choose</Strong>, a
        ceiling for cost. Both apply to chat, Help and{" "}
        <DocLink to="/docs/repositories">Repository work sessions</DocLink> on that model, for every
        AI Employee using it; the default can&apos;t sit above the ceiling, and lowering the ceiling
        brings the default down with it. A conversation set higher than the ceiling runs at the
        ceiling and its replies say so; a work session can&apos;t start above it. For a custom
        endpoint, <Strong>Offer thinking levels</Strong> turns the levels on — only do it for a
        server that reads <Code>reasoning_effort</Code>, as vLLM and Ollama do for some models.
        Owners and admins change these from a signed-in browser; Members read them.
      </P>

      <H3 id="model-errors">When a chat or Run reports a model error</H3>
      <P>
        OpenCode manages temporary model-service retries for API-key and custom models; a key the
        provider refuses first moves the request to the next of the model&apos;s{" "}
        <a href="#api-keys">API keys</a>. The Codex app-server manages subscription retries.
        Genosyn keeps the same Run while the runtime
        retries; cancelling work or reaching the Run deadline stops it. If the runtime cannot
        complete a model request, the Run ends with <Strong>Error</Strong> — unless the model is{" "}
        <a href="#unavailable">unavailable</a>, when the Run pauses and a chat message waits until
        it is back. Retry timing and context compaction belong to the selected runtime rather than
        a second Genosyn model loop.
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

      <H3 id="removing-a-model">Detaching and removing a model</H3>
      <P>
        <Strong>Detach</Strong>, the last setting in a card&apos;s <Strong>Advanced</Strong> section
        on an employee&apos;s page, takes the model off that employee only. The model stays in
        Settings → AI Models with its keys, and anyone else using it carries on. If it was the
        active model, the employee&apos;s most recently attached other model takes over, and Routines
        pinned to it go back to that. Letting an AI Employee go detaches its models the same way.
      </P>
      <P>
        <Strong>Remove from the company</Strong>, in Settings → AI Models, deletes the model and its
        encrypted keys. A model nobody uses goes after one question. While any AI Employee uses it,
        the dialog names them and who would be left with no AI Model at all, and the only way on is{" "}
        <Strong>Detach and remove</Strong>, which detaches it from everyone first. No data on Soul,
        Skills, Routines, or past Runs is affected.
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
    <div className="rounded-2xl border border-line bg-paper-raised p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[13px] font-semibold text-ink">{name}</div>
        <div className="text-[11px] uppercase text-ink-500">{vendor}</div>
      </div>
      <dl className="mt-3 space-y-2 text-[13px] leading-[1.6]">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
            Credentials
          </dt>
          <dd className="text-ink-600">{creds}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
            Connects to
          </dt>
          <dd className="text-ink-600">{connects}</dd>
        </div>
      </dl>
    </div>
  );
}
