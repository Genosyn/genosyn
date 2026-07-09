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
            Genosyn employee at it from the UI — no terminal, no config files
            to edit by hand.
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
        Genosyn&apos;s in-process agent loop talks to your model over an
        OpenAI-compatible HTTP API — no CLI to install, nothing to spawn. The
        runtime path is always:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-zinc-700">
        {`Genosyn agent loop (in-process, runner + chat)
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
          <Strong>An AI Model on the employee</Strong>, configured from
          Settings → AI Model with the provider kind set to{" "}
          <Code>Custom</Code>. Paste the base URL + model id (+ an optional
          key). Done.
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
        <Code>http://localhost:11434/v1</Code>.
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
        them, vLLM will return tool calls as raw text and the agent will
        treat them as a normal message.
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
        From the app, either during the hire wizard (Step 2: Model) or
        afterwards at <Code>Settings → AI Model</Code>:
      </P>
      <OL>
        <LI>
          Pick the <Code>Custom</Code> provider kind — any
          OpenAI-compatible endpoint.
        </LI>
        <LI>
          <Strong>Base URL</Strong>: <Code>http://host.docker.internal:11434/v1</Code>{" "}
          for Ollama on the same Mac/Windows host, or the full LAN URL of
          your GPU box.
        </LI>
        <LI>
          <Strong>Model id</Strong>: the raw model name your server exposes
          — e.g. <Code>qwen2.5-coder:32b</Code>.
        </LI>
        <LI>
          <Strong>API key</Strong>: leave blank for Ollama / vLLM /
          llama.cpp. Most local servers ignore the key entirely.
        </LI>
        <LI>
          Click <Code>Continue</Code>. That&apos;s it — the next chat or
          routine run hits your endpoint.
        </LI>
      </OL>

      <Callout kind="tip" title="Credentials never touch disk.">
        The base URL, model id, and any API key you enter are stored
        encrypted (AES-256-GCM) in the Genosyn database — never written to
        a config file or a credential dir. They&apos;re decrypted only
        in-memory when the agent calls your endpoint. Remove the model or
        fire the employee and the encrypted row is deleted.
      </Callout>

      <H2 id="docker-networking">Docker networking</H2>
      <P>
        If you installed Genosyn through <Code>genosyn install</Code>, the
        app runs inside a Docker container. <Code>localhost</Code> inside
        the container is <Strong>not</Strong> the same as on your host —
        the LLM server on the host won&apos;t be reachable as{" "}
        <Code>http://localhost:11434</Code> from the employee.
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
          agent inside the container can&apos;t reach your host. See the
          Docker networking section above.
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
        You don&apos;t have to choose one path for the whole company. One
        employee can run on Claude via an Anthropic API key; another runs
        on a local Qwen via a <Code>Custom</Code> endpoint. They share
        Channels, Notes, and Integrations — only the brain differs. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for the bigger
        picture.
      </Callout>
    </>
  );
}
