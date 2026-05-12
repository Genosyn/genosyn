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

export function OpenSourceModels() {
  return (
    <>
      <PageHeader
        eyebrow="Brains & tools"
        title="Open-source LLMs"
        lead={
          <>
            You don&apos;t have to ship traffic to Anthropic or OpenAI. Run a
            local model behind an OpenAI-compatible endpoint and point a
            Genosyn employee at it — same Soul, same Skills, same Routines,
            different brain.
          </>
        }
      />

      <H2 id="why">Why run a local model</H2>
      <UL>
        <LI>
          <Strong>Privacy.</Strong> Soul, Skills, and tool I/O never leave
          your network. Critical when an employee touches customer data, a
          Postgres replica, or finance records.
        </LI>
        <LI>
          <Strong>Cost.</Strong> No per-token bill. Routines that run on a
          tight cron can become uneconomical on the big closed models;
          locally hosted Llama / Qwen / Mistral don&apos;t care how often
          you call them.
        </LI>
        <LI>
          <Strong>Model choice.</Strong> The open ecosystem ships
          specialized weights — coding-tuned, retrieval-tuned, JSON-tuned —
          that the big labs don&apos;t. You can also stay on a stable model
          forever; nobody deprecates a checkpoint you downloaded.
        </LI>
      </UL>

      <Callout kind="warn" title="Open-source models vary wildly at tool use.">
        Genosyn relies on the model calling MCP tools — to write a Note,
        post a message, or query Postgres. The big labs&apos; models are
        excellent at this; open weights are catching up but uneven. As of
        early 2026, the safest picks for an autonomous employee are
        Qwen2.5-Coder 32B+, Llama 3.3 70B, and DeepSeek-V3 / R1. Smaller
        models work for chat but will trip on multi-step tool plans.
      </Callout>

      <H2 id="the-shape">The shape of the integration</H2>
      <P>
        Genosyn doesn&apos;t talk to your LLM directly. The runtime path is
        always:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-zinc-700">
        {`Genosyn runner
   └─ spawns provider CLI (opencode / goose / openclaw)
        └─ HTTP to an OpenAI-compatible /v1/chat/completions endpoint
             └─ your local server (Ollama / vLLM / llama.cpp / LM Studio)
                  └─ the model weights on your GPU or Mac`}
      </pre>
      <P>
        So you need two pieces wired up:
      </P>
      <OL>
        <LI>
          <Strong>A local server</Strong> that exposes an OpenAI-compatible
          API. Most popular runtimes do this out of the box.
        </LI>
        <LI>
          <Strong>A provider CLI</Strong> on the Genosyn side that knows
          how to call a custom OpenAI-compatible base URL. The two best
          paths are <Code>opencode</Code> and <Code>goose</Code>.
        </LI>
      </OL>

      <H2 id="run-a-server">Step 1 — Run a local server</H2>
      <P>
        Pick one of these. They all expose{" "}
        <Code>/v1/chat/completions</Code> and{" "}
        <Code>/v1/models</Code> so any OpenAI-compatible client just works.
      </P>

      <H3 id="ollama">Ollama (easiest)</H3>
      <P>
        Best for a Mac, a single GPU, or just kicking the tires. Ships a
        model registry and serves on <Code>http://localhost:11434</Code>.
      </P>
      <Pre lang="bash">{`# install
curl -fsSL https://ollama.com/install.sh | sh

# pull a tool-capable model
ollama pull qwen2.5-coder:32b

# serve (auto-starts on macOS; this is for Linux/manual)
ollama serve`}</Pre>
      <P>
        Ollama exposes the OpenAI-compatible API at{" "}
        <Code>http://localhost:11434/v1</Code>. Any client that takes a base
        URL + a model name works.
      </P>

      <H3 id="vllm">vLLM (best throughput)</H3>
      <P>
        For a real GPU box. Highest tokens/sec, batches concurrent requests
        across multiple employees. Native OpenAI-compatible server.
      </P>
      <Pre lang="bash">{`pip install vllm

vllm serve Qwen/Qwen2.5-Coder-32B-Instruct \\
  --host 0.0.0.0 \\
  --port 8000 \\
  --enable-auto-tool-choice \\
  --tool-call-parser hermes`}</Pre>
      <P>
        Endpoint: <Code>http://&lt;host&gt;:8000/v1</Code>. The two
        tool-call flags are required for MCP tool use to work — without
        them, vLLM will return tool calls as raw text and the provider CLI
        will treat them as a normal message.
      </P>

      <H3 id="llama-cpp">llama.cpp (most portable)</H3>
      <P>
        Smallest dependency surface. CPU works; with a GPU it&apos;s fast
        too. Ships <Code>llama-server</Code> as its OpenAI-compatible
        endpoint.
      </P>
      <Pre lang="bash">{`# from a release binary, or build from source
llama-server \\
  -m ./qwen2.5-coder-32b-instruct-q5_k_m.gguf \\
  --host 0.0.0.0 \\
  --port 8080 \\
  --jinja \\
  --chat-template-file qwen2.5-coder.jinja`}</Pre>
      <P>
        Endpoint: <Code>http://&lt;host&gt;:8080/v1</Code>.{" "}
        <Code>--jinja</Code> enables the chat template required for tool
        calls.
      </P>

      <H3 id="lm-studio">LM Studio (GUI-friendly)</H3>
      <P>
        Native macOS / Windows / Linux app. Browse models in a UI, flip the
        local server on in one click. Endpoint:{" "}
        <Code>http://localhost:1234/v1</Code>. Good for Mac users who
        don&apos;t want to live in the terminal.
      </P>

      <H2 id="wire-into-genosyn">Step 2 — Wire it into Genosyn</H2>
      <P>
        The provider CLI on the employee&apos;s side is what actually talks
        to your local server. Two options.
      </P>

      <H3 id="path-opencode">Path A — opencode (recommended)</H3>
      <P>
        Opencode is a model-router CLI: it speaks OpenAI-compatible HTTP
        natively and lets you add custom providers without touching code.
        On the Genosyn side it&apos;s already supported.
      </P>
      <OL>
        <LI>
          In Genosyn, create an AI Employee and pick{" "}
          <Strong>OpenCode</Strong> as the AI Model provider. Sign in
          (subscription) or skip the sign-in if you only intend to use the
          custom provider.
        </LI>
        <LI>
          Open a terminal{" "}
          <em>inside the employee&apos;s data directory</em> so opencode
          writes its config to the right place:
          <Pre lang="bash">{`cd data/companies/<co-slug>/employees/<emp-slug>
XDG_DATA_HOME="$(pwd)/.opencode" opencode auth login`}</Pre>
          Pick &quot;Custom provider&quot; in the menu. Enter:
          <UL>
            <LI>
              <Strong>Name</Strong>:{" "}
              <Code>local</Code> (or any slug you like)
            </LI>
            <LI>
              <Strong>Base URL</Strong>:{" "}
              <Code>http://localhost:11434/v1</Code> (or wherever your
              server runs)
            </LI>
            <LI>
              <Strong>API key</Strong>: any string — most local servers
              ignore the key but a non-empty value is required by the
              OpenAI client spec. Use <Code>not-needed</Code>.
            </LI>
          </UL>
        </LI>
        <LI>
          Back in Genosyn, edit the AI Model and set the model string to{" "}
          <Code>local/qwen2.5-coder:32b</Code> — the format is{" "}
          <Code>&lt;provider-slug&gt;/&lt;model-name&gt;</Code>, matching
          what opencode now knows about. Save.
        </LI>
        <LI>
          Run any Routine or send a chat message. The runner spawns{" "}
          <Code>opencode run --model local/qwen2.5-coder:32b</Code> inside
          the employee&apos;s directory and opencode hits your local
          endpoint.
        </LI>
      </OL>

      <H3 id="path-goose">Path B — goose</H3>
      <P>
        Goose has an interactive <Code>configure</Code> TUI that adds an
        OpenAI-compatible provider. Same idea, different UX.
      </P>
      <OL>
        <LI>
          Create an AI Employee with provider <Strong>Goose</Strong>. The
          Genosyn UI launches <Code>goose configure</Code> in the embedded
          terminal — pick &quot;Configure providers&quot;, then{" "}
          <Code>openai</Code> (this branch supports a custom host).
        </LI>
        <LI>
          When prompted:
          <UL>
            <LI>
              <Strong>OPENAI_HOST</Strong>:{" "}
              <Code>http://localhost:11434</Code>
            </LI>
            <LI>
              <Strong>OPENAI_BASE_PATH</Strong>: <Code>/v1/chat/completions</Code>
            </LI>
            <LI>
              <Strong>OPENAI_API_KEY</Strong>: <Code>not-needed</Code>
            </LI>
          </UL>
        </LI>
        <LI>
          Set the AIModel <Code>model</Code> field to{" "}
          <Code>openai/qwen2.5-coder:32b</Code>. The runner splits this on
          the slash and injects <Code>GOOSE_PROVIDER=openai</Code> +{" "}
          <Code>GOOSE_MODEL=qwen2.5-coder:32b</Code> at spawn time.
        </LI>
      </OL>

      <Callout kind="info" title="Why not claude-code or codex?">
        Both are hard-wired to a single vendor — <Code>claude-code</Code>{" "}
        always talks to Anthropic, <Code>codex</Code> always talks to
        OpenAI. There&apos;s no supported way to redirect them at a local
        endpoint. Use a router CLI (opencode / goose / openclaw) when the
        brain isn&apos;t hosted by a major lab.
      </Callout>

      <H2 id="docker-networking">Docker networking</H2>
      <P>
        If you installed Genosyn through <Code>genosyn install</Code>, the
        app runs inside a Docker container. <Code>localhost</Code> inside
        the container is <Strong>not</Strong> the same as on your host —
        the LLM server on the host won&apos;t be reachable as{" "}
        <Code>http://localhost:11434</Code> from the employee&apos;s cwd.
      </P>
      <KeyList
        rows={[
          {
            term: "macOS / Win",
            def: (
              <>
                Use <Code>http://host.docker.internal:11434</Code>. Docker
                Desktop wires this magic hostname to the host automatically.
              </>
            ),
          },
          {
            term: "Linux",
            def: (
              <>
                Add <Code>--add-host=host.docker.internal:host-gateway</Code>{" "}
                to your <Code>docker run</Code>, or run the LLM server bound
                to <Code>0.0.0.0</Code> and use the host&apos;s LAN IP.
              </>
            ),
          },
          {
            term: "Same machine, second container",
            def: (
              <>
                Easiest is a shared user-defined network (<Code>docker
                network create genosyn-net</Code>) and reference the LLM
                container by name.
              </>
            ),
          },
        ]}
      />

      <H2 id="hardware">Hardware sizing</H2>
      <P>
        Rough rules of thumb for picking weights against your GPU memory.
        Quantized GGUFs at q4_k_m or q5_k_m are the practical baseline —
        the quality loss vs the original is small and the memory savings
        are large.
      </P>
      <KeyList
        rows={[
          {
            term: "8–12 GB VRAM",
            def: "7B–8B models at q4. Good for chat. Light tool use; expect occasional plan errors on multi-step routines.",
          },
          {
            term: "16–24 GB VRAM",
            def: "13B–14B at q5, or 32B at q4. The sweet spot for a single solid employee.",
          },
          {
            term: "32–48 GB VRAM",
            def: "32B at q6/q8, or 70B at q4. Comparable to mid-tier closed models on most code/ops tasks.",
          },
          {
            term: "80+ GB VRAM (or M-series Mac with 64+ GB unified)",
            def: "70B at q5+ or DeepSeek-V3 with offloading. State of the art for open weights.",
          },
        ]}
      />

      <H2 id="troubleshooting">Troubleshooting</H2>
      <UL>
        <LI>
          <Strong>Model replies but never calls a tool.</Strong> Almost
          always the chat template / tool-call parser. Check that your
          server has tool-call support enabled (<Code>--jinja</Code> for
          llama.cpp, <Code>--enable-auto-tool-choice</Code> for vLLM, and a
          chat template that emits a function-call block).
        </LI>
        <LI>
          <Strong>Runs hang on the first message.</Strong> Network — the
          provider CLI inside the container can&apos;t reach your host.
          See the Docker networking section above.
        </LI>
        <LI>
          <Strong>Model loops or hallucinates tool names.</Strong>{" "}
          Context window. Genosyn injects the Soul + every Skill + the MCP
          tool catalog at each turn; that&apos;s often 8k–16k tokens before
          the first user message. Run models with at least 32k context for
          serious work.
        </LI>
        <LI>
          <Strong>Slow.</Strong> Quantize down (q8 → q5), enable batching
          on vLLM, or pin the layers to GPU (<Code>--n-gpu-layers</Code> in
          llama.cpp). If your GPU is saturated, the answer is more
          hardware, not more tuning.
        </LI>
      </UL>

      <Callout kind="tip" title="Mix and match.">
        You don&apos;t have to choose. One employee can run on Claude
        through <Code>claude-code</Code> for general work; another runs on
        a local Qwen through <Code>opencode</Code> for data-sensitive
        tasks. They share Channels, Notes, and Integrations — only the
        brain differs. See <DocLink to="/docs/models">AI Models</DocLink>{" "}
        for the bigger picture.
      </Callout>
    </>
  );
}
