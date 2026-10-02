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
            You don&apos;t have to ship traffic to Anthropic or OpenAI. Run a local model behind an
            OpenAI-compatible endpoint and point a Genosyn employee at it from the UI — no terminal,
            no config files to edit by hand.
          </>
        }
      />

      <H2 id="why">Why run a local model</H2>
      <UL>
        <LI>
          <Strong>Privacy.</Strong> Soul, Skills, and tool I/O never leave your network. Critical
          when an employee touches customer data, a Postgres replica, or finance records.
        </LI>
        <LI>
          <Strong>Cost.</Strong> No per-token bill. Routines that run on a tight cron can become
          uneconomical on the big closed models; locally hosted Llama / Qwen / Mistral don&apos;t
          care how often you call them.
        </LI>
        <LI>
          <Strong>Model choice.</Strong> The open ecosystem ships specialized weights —
          coding-tuned, retrieval-tuned, JSON-tuned — that the big labs don&apos;t. You can also
          stay on a stable model forever; nobody deprecates a checkpoint you downloaded.
        </LI>
      </UL>

      <Callout kind="warn" title="Open-source models vary wildly at tool use.">
        Genosyn relies on the model calling MCP tools — to write a Note, post a message, or query
        Postgres. The big labs&apos; models are excellent at this; open weights are catching up but
        uneven. As of early 2026, the safest picks for an autonomous employee are Qwen2.5-Coder
        32B+, Llama 3.3 70B, and DeepSeek-V3 / R1. Smaller models work for chat but will trip on
        multi-step tool plans.
      </Callout>

      <H2 id="the-shape">The shape of the integration</H2>
      <P>
        Genosyn starts its bundled OpenCode runtime, which talks to your model over an
        OpenAI-compatible HTTP API. You configure the endpoint in Genosyn; no separate OpenCode
        setup is needed. The runtime path is:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-2xl border border-line bg-paper-raised px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-ink-600">
        {`Genosyn runner + chat
   └─ managed OpenCode runtime
        └─ HTTP to an OpenAI-compatible /v1/chat/completions endpoint
             └─ your local server (Ollama / vLLM / llama.cpp / LM Studio)
                  └─ the model weights on your GPU or Mac`}
      </pre>
      <P>So you need two pieces wired up:</P>
      <OL>
        <LI>
          <Strong>A local server</Strong> that exposes an OpenAI-compatible API. Most popular
          runtimes do this out of the box.
        </LI>
        <LI>
          <Strong>An AI Model on the employee</Strong>, configured from Settings → AI Model with the
          provider kind set to <Code>Custom</Code>. Paste the base URL + model id (+ an optional
          key). Done.
        </LI>
      </OL>

      <H2 id="run-a-server">Step 1 — Run a local server</H2>
      <P>
        Pick one of these. They all expose <Code>/v1/chat/completions</Code> and{" "}
        <Code>/v1/models</Code> so any OpenAI-compatible client just works.
      </P>

      <H3 id="ollama">Ollama (easiest)</H3>
      <P>
        Best for a Mac, a single GPU, or just kicking the tires. Ships a model registry and serves
        on <Code>http://localhost:11434</Code>.
      </P>
      <Pre lang="bash">{`# install
curl -fsSL https://ollama.com/install.sh | sh

# pull a tool-capable model
ollama pull qwen2.5-coder:32b

# serve (auto-starts on macOS; this is for Linux/manual)
ollama serve`}</Pre>
      <P>
        Ollama exposes the OpenAI-compatible API at <Code>http://localhost:11434/v1</Code>.
      </P>

      <H3 id="vllm">vLLM (best throughput)</H3>
      <P>
        For a real GPU box. Highest tokens/sec, batches concurrent requests across multiple
        employees. Native OpenAI-compatible server.
      </P>

      <Callout kind="tip" title="One command: genosyn vllm up">
        The <Code>genosyn</Code> CLI ships a managed, Dockerized vLLM server so you don&apos;t have
        to hand-write install or tool-call flags. On a GPU VM with Docker + the{" "}
        <Code>nvidia-container-toolkit</Code>:
        <Pre lang="bash">{`curl -fsSL https://genosyn.com/genosyn -o /usr/local/bin/genosyn && chmod +x /usr/local/bin/genosyn

genosyn vllm up --model Qwen/Qwen2.5-Coder-32B-Instruct --api-key "$(openssl rand -hex 24)"
genosyn vllm status   # prints the Base URL, Model id, and API key to paste below`}</Pre>
        It writes a <Code>docker-compose.yml</Code> + <Code>.env</Code> to{" "}
        <Code>~/.genosyn/vllm</Code>, sets the tool-call flags for you, and persists downloaded
        weights across restarts. See the <DocLink to="/docs/cli">CLI reference</DocLink> for{" "}
        <Code>status</Code>, <Code>logs</Code>, and <Code>down</Code>.
      </Callout>

      <P>Prefer to run it by hand instead? The bare server is one pip install:</P>
      <Pre lang="bash">{`pip install vllm

vllm serve Qwen/Qwen2.5-Coder-32B-Instruct \\
  --host 0.0.0.0 \\
  --port 8000 \\
  --enable-auto-tool-choice \\
  --tool-call-parser hermes`}</Pre>
      <P>
        Endpoint: <Code>http://&lt;host&gt;:8000/v1</Code>. The two tool-call flags are required for
        MCP tool use to work — without them, vLLM will return tool calls as raw text and the agent
        will treat them as a normal message.
      </P>
      <H3 id="vllm-tuning">Tune vLLM for Routines</H3>
      <P>
        A Routine is not a chat. Every step resends the whole conversation so far — often 100k–230k
        tokens — then writes a long reply, often after thinking first, and two or three Routines
        may share the GPU. vLLM&apos;s defaults suit short chats. This configuration runs a
        company&apos;s Routines on Qwen3.8-27B with one 80 GB A100 and vLLM 0.30:
      </P>
      <Pre lang="bash">{`export VLLM_API_KEY="$(openssl rand -hex 24)"   # paste the same value into Genosyn

docker run -d --name vllm --restart unless-stopped --gpus all --ipc=host -p 8000:8000 \\
  -v ~/.cache/huggingface:/root/.cache/huggingface -e VLLM_API_KEY \\
  vllm/vllm-openai:v0.30.0 \\
  --model Qwen/Qwen3.8-27B \\
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3 \\
  --max-model-len 262144 --gpu-memory-utilization 0.92 \\
  --enable-prefix-caching --mamba-cache-mode align \\
  --kv-cache-dtype fp8 --max-num-seqs 32 \\
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'`}</Pre>
      <P>What each setting is for:</P>
      <KeyList
        rows={[
          {
            term: "--tool-call-parser qwen3_coder --reasoning-parser qwen3",
            def: (
              <>
                Qwen3.5 and later write tool calls in their own format. Without the matching parser
                vLLM returns them as plain text and the employee never calls a tool. The reasoning
                parser keeps the model&apos;s thinking out of the reply Genosyn reads. Other
                families need their own parser: <Code>hermes</Code> for Qwen2.5,{" "}
                <Code>llama3_json</Code> for Llama 3.x.
              </>
            ),
          },
          {
            term: "--max-model-len 262144",
            def: (
              <>
                The model&apos;s full native window. A Routine&apos;s conversation reaches
                100k–230k tokens before OpenCode compacts it, so a 32k window — the CLI&apos;s
                default — compacts almost every step. Enter the same number as the model&apos;s{" "}
                <a href="#context-window">context window</a> in Genosyn.
              </>
            ),
          },
          {
            term: "--gpu-memory-utilization 0.92",
            def: "Whatever is left after the weights becomes the cache that holds conversations. vLLM keeps part of it for CUDA graphs; lower it if startup runs out of memory.",
          },
          {
            term: "--enable-prefix-caching --mamba-cache-mode align",
            def: (
              <>
                With prefix caching the server reads only the new part of each resent conversation;
                without it, every step re-reads everything and the GPU spends most of its time doing
                so. vLLM caches by default for ordinary models but not for hybrid linear-attention
                ones (Qwen3.5 and later, Qwen3-Next), which also need the <Code>align</Code> cache
                mode. In Routines the <Code>Prefix cache hit rate</Code> in the log settles at
                70–90%.
              </>
            ),
          },
          {
            term: "--kv-cache-dtype fp8",
            def: "Stores that cache in 8 bits instead of 16. On the A100 above it grew from about 300k to 560k tokens: room for two long Routines at once instead of one. vLLM warns it can cost a little accuracy; Routines have run on it without a difference we could see.",
          },
          {
            term: "--speculative-config (multi-token prediction)",
            def: (
              <>
                Models that ship multi-token prediction weights (Qwen3.5 and later) propose several
                tokens per step — three, as configured above — and the server keeps only those the
                full model agrees with. With
                two Routines, generation rose from about 49 to 80–90 tokens a second. Use vLLM 0.30
                or later: on 0.24 the same setting crashed a Qwen3.8 server with prefix caching
                about every half hour (<Code>device-side assert triggered</Code> in its log).
              </>
            ),
          },
          {
            term: "--max-num-seqs 32",
            def: "Caps how many requests vLLM batches at once. The default reserves memory for far more requests than a few Routines make, and with multi-token prediction that reservation ran the A100 out of memory at startup.",
          },
          {
            term: "Image vllm/vllm-openai:v0.30.0",
            def: "Pin the image version instead of latest, so a restart never changes vLLM under your Routines. Upgrade on purpose, then watch the log.",
          },
        ]}
      />
      <P>Then set the same numbers in Genosyn, on the AI Model&apos;s card:</P>
      <UL>
        <LI>
          <Strong>Model id</Strong>: leave it blank. Genosyn uses the model vLLM serves and follows
          it when you restart vLLM with another (
          <a href="#follow-the-server">Change the model on the server</a>).
        </LI>
        <LI>
          <Strong>Context window</Strong>: the server&apos;s <Code>--max-model-len</Code>,{" "}
          <Code>262144</Code> above.
        </LI>
        <LI>
          <Strong>Concurrent Routine Runs</Strong>: no more than the startup log&apos;s{" "}
          <Code>Maximum concurrency for 262,144 tokens per request</Code> — how many full
          conversations fit in the cache at once. For the setup above it reads 1.97x, so 2. A
          model with this limit runs no parallel workers, so each Run is one conversation. See{" "}
          <a href="#busy-model">When the model is busy</a>.
        </LI>
      </UL>
      <P>
        With the CLI, <Code>genosyn vllm up</Code> takes the common settings as flags. Put the rest
        in <Code>~/.genosyn/vllm/.env</Code>, then run <Code>genosyn vllm up</Code> again to
        restart the server with them:
      </P>
      <Pre lang="bash">{`genosyn vllm up --model Qwen/Qwen3.8-27B --tag v0.30.0 --parser qwen3_coder \\
  --max-model-len 262144 --gpu-util 0.92 --api-key "$(openssl rand -hex 24)"

# ~/.genosyn/vllm/.env — keep the single quotes around the JSON
VLLM_EXTRA_ARGS=--reasoning-parser qwen3 --enable-prefix-caching --mamba-cache-mode align --kv-cache-dtype fp8 --max-num-seqs 32 --speculative-config '{"method":"mtp","num_speculative_tokens":3}'`}</Pre>
      <P>To check it is working, read the server log:</P>
      <UL>
        <LI>
          At startup, <Code>GPU KV cache size</Code> says how many tokens of conversation fit;
          the line after it gives the maximum concurrency.
        </LI>
        <LI>
          <Code>Prefix cache hit rate</Code> climbs to 70–90% once Routines run. Near zero means
          the prefix-caching flags are missing.
        </LI>
        <LI>
          <Code>SpecDecoding metrics</Code> shows a <Code>Mean acceptance length</Code> around
          2.5–3 with three speculative tokens.
        </LI>
        <LI>
          If <Code>Waiting: N reqs</Code> stays above zero, the GPU is saturated. Another
          application sending bursts of parallel requests to the same server slows Routines
          sharply; give it its own server, or lower Concurrent Routine Runs.
        </LI>
        <LI>
          A rising <Code>vllm:num_preemptions_total</Code> on the server&apos;s{" "}
          <Code>/metrics</Code> means the cache is too small for the requests sharing it.
        </LI>
      </UL>
      <P>
        Changing a flag means restarting the server, which takes 2–6 minutes while it loads the
        weights, compiles and captures CUDA graphs. Running Routines wait for it and carry on (
        <a href="#busy-model">When the model is busy</a>).
      </P>

      <H3 id="llama-cpp">llama.cpp (most portable)</H3>
      <P>
        Smallest dependency surface. CPU works; with a GPU it&apos;s fast too. Ships{" "}
        <Code>llama-server</Code> as its OpenAI-compatible endpoint.
      </P>
      <Pre lang="bash">{`# from a release binary, or build from source
llama-server \\
  -m ./qwen2.5-coder-32b-instruct-q5_k_m.gguf \\
  --host 0.0.0.0 \\
  --port 8080 \\
  --jinja \\
  --chat-template-file qwen2.5-coder.jinja`}</Pre>
      <P>
        Endpoint: <Code>http://&lt;host&gt;:8080/v1</Code>. <Code>--jinja</Code> enables the chat
        template required for tool calls.
      </P>

      <H3 id="lm-studio">LM Studio (GUI-friendly)</H3>
      <P>
        Native macOS / Windows / Linux app. Browse models in a UI, flip the local server on in one
        click. Endpoint: <Code>http://localhost:1234/v1</Code>. Good for Mac users who don&apos;t
        want to live in the terminal.
      </P>

      <H2 id="wire-into-genosyn">Step 2 — Wire it into Genosyn</H2>
      <P>
        From the app, either during the hire wizard (Step 2: Model) or afterwards at{" "}
        <Code>Settings → AI Model</Code>:
      </P>
      <OL>
        <LI>
          Pick the <Code>Custom</Code> provider kind — any OpenAI-compatible endpoint.
        </LI>
        <LI>
          <Strong>Base URL</Strong>: <Code>http://host.docker.internal:11434/v1</Code> for Ollama on
          the same Mac/Windows host, or the full LAN URL of your GPU box.
        </LI>
        <LI>
          <Strong>Model id</Strong>: the raw model name your server exposes — e.g.{" "}
          <Code>qwen2.5-coder:32b</Code>. Leave it blank for a server that serves one model, such
          as vLLM: Genosyn uses that model and follows it when the server changes model (
          <a href="#follow-the-server">Change the model on the server</a>).
        </LI>
        <LI>
          <Strong>API key</Strong>: leave blank for Ollama / vLLM / llama.cpp. Most local servers
          ignore the key entirely.
        </LI>
        <LI>
          Click <Code>Continue</Code>. That&apos;s it — the next chat or routine run hits your
          endpoint.
        </LI>
        <LI>
          <Strong>Check the context window</Strong> on the model card. Genosyn asks your server for
          it on save; if it reads <Strong>Unknown</Strong>, set it by hand — see below.
        </LI>
      </OL>

      <H3 id="follow-the-server">Change the model on the server</H3>
      <P>
        A server that serves a single model, such as vLLM, decides which model your employees use.
        Restart it with another <Code>--model</Code> and Genosyn moves to that model on its own:
        when the server answers that the old model does not exist, the turn carries on with the
        model it serves, and the AI Model&apos;s card switches to it, taking the new model&apos;s
        context window from the server. A Run that was working through the restart waits for the
        server and carries on with the new model. The Run log notes the change.
      </P>
      <P>
        A server that lists several models (Ollama, LM Studio, a gateway) is never guessed at: an
        id it no longer serves fails as before, and you choose the replacement on the card.
      </P>

      <H3 id="context-window">Tell Genosyn your context window</H3>
      <P>
        OpenCode manages history and compaction using the context window Genosyn supplies. Set an
        accurate window so the runtime can compact before a request grows too large. Self-hosted
        servers differ in what they publish on <Code>/v1/models</Code>:
      </P>
      <KeyList
        rows={[
          {
            term: "vLLM",
            def: (
              <>
                Reports <Code>max_model_len</Code> — whatever you passed to{" "}
                <Code>--max-model-len</Code>. Detected automatically.
              </>
            ),
          },
          {
            term: "LM Studio",
            def: (
              <>
                Reports <Code>max_context_length</Code>. Detected automatically.
              </>
            ),
          },
          {
            term: "llama.cpp",
            def: (
              <>
                Reports <Code>n_ctx</Code> — what you passed to <Code>-c</Code>. Detected
                automatically.
              </>
            ),
          },
          {
            term: "Ollama",
            def: (
              <>
                Reports nothing. Set it by hand: it defaults to a <Code>num_ctx</Code> of 4096
                unless your Modelfile or <Code>OLLAMA_CONTEXT_LENGTH</Code> says otherwise — far
                smaller than the weights allow, and a common surprise.
              </>
            ),
          },
        ]}
      />
      <P>
        Use <Strong>Set manually</Strong> on the model card for anything not detected. A number you
        type always wins over the probe, so it survives key rotations and re-saves;{" "}
        <Strong>Clear</Strong> hands the field back.
      </P>
      <P>
        For everything Genosyn does detect, it re-asks your server{" "}
        <Strong>every three hours</Strong> — so restarting vLLM with a longer{" "}
        <Code>--max-model-len</Code>, or swapping the weights behind the same model id, lands on the
        card without you touching anything. A check that can&apos;t reach the box keeps the last
        known number, and <Strong>Ask the provider</Strong> runs it immediately when you don&apos;t
        want to wait.
      </P>
      <Callout kind="warn" title="Small windows fill up fast.">
        The system prompt carries the Soul, every Skill, and the whole tool catalog on{" "}
        <em>every</em> turn — easily 30k tokens on a well-equipped employee. On a 64k model
        that&apos;s half the window gone before the first tool runs. If routines keep compacting
        away work you wanted kept, trim the employee&apos;s Skills or serve the model at a longer{" "}
        <Code>--max-model-len</Code> before reaching for a bigger box.
      </Callout>

      <Callout kind="tip" title="Credentials never touch disk.">
        The base URL, model id, and any API key you enter are stored encrypted (AES-256-GCM) in the
        Genosyn database — never written to a config file or a credential dir. They&apos;re
        decrypted only in-memory when the agent calls your endpoint. Remove the model or fire the
        employee and the encrypted row is deleted.
      </Callout>

      <H2 id="busy-model">When the model is busy</H2>
      <P>
        A local model server is usually one GPU. Routines that share it at the same time slow each
        other down, and every Run&apos;s time limit keeps counting while it waits for the model —
        so a busy afternoon used to end as a row of timeout Errors. Genosyn handles this for you:
      </P>
      <UL>
        <LI>
          <Strong>One Run at a time by default.</Strong> A <Code>Custom</Code> endpoint on this
          machine or a private network (<Code>localhost</Code>, <Code>host.docker.internal</Code>,
          a LAN or Tailscale address, a single-word Docker service name) serves one Routine Run at
          a time. Others wait in the queue and start as soon as it finishes; a waiting Run&apos;s
          time limit starts when it does, and its log says what it is waiting for.
        </LI>
        <LI>
          <Strong>Shared across employees.</Strong> Every AI Employee pointed at the same base URL
          and model id shares the limit, because they share the hardware.
        </LI>
        <LI>
          <Strong>Change it on the model card.</Strong> <Strong>Concurrent Routine Runs</Strong>{" "}
          takes <Code>Default</Code>, a number, or <Code>No limit</Code>. Raise it for a server that
          batches well (vLLM with memory to spare); set it to 1 for a self-hosted server on a
          public address, which Genosyn cannot tell apart from a hosted gateway. Hosted models and
          other endpoints have no limit unless you set one.
        </LI>
        <LI>
          <Strong>No parallel workers on a limited model.</Strong> A model with a Concurrent
          Routine Runs limit, which a local server has by default, does not offer{" "}
          <Code>delegate_parallel_work</Code>; a Run does that work itself. Each worker is one more
          long conversation on the same GPU, and the limit is how many the server holds well. Four
          conversations on a cache that held about three evicted each other&apos;s cached prompts,
          and every step read its whole conversation again.
        </LI>
        <LI>
          <Strong>Slow answers are waited for.</Strong> A busy server can take minutes to start
          answering a long conversation. A <Code>Custom</Code> endpoint gets 15 minutes to start
          answering, and between the parts of an answer, instead of the usual five. A request given
          up at five minutes is sent again from the start, adding to the load.
        </LI>
        <LI>
          <Strong>Time checks near the deadline.</Strong> In the last part of a Run&apos;s time
          limit, tool results carry a short note with the minutes left, so a slow model saves its
          progress and writes its report instead of being cut off mid-step. Unfinished work is
          continued automatically only while enough of the shared time limit remains for the
          continuation to do something.
        </LI>
        <LI>
          <Strong>Started work finishes first.</Strong> A continuation of unfinished work starts
          ahead of Runs that have not begun, and its wait for the model does not count against the
          time its earlier Run left. When a Run hands its work to a continuation, the model&apos;s
          slot waits the few seconds until that continuation is queued instead of going to the
          next Run.
        </LI>
        <LI>
          <Strong>A restart does not end the work.</Strong> When the model server stops answering
          mid-Run — a restart, an upgrade, a crash — the Run waits for it, asking every few seconds,
          and carries on in the same conversation once it answers. It waits up to about 25 minutes,
          and the wait counts against its time limit; its log notes when the server stopped and when
          it came back.
        </LI>
        <LI>
          <Strong>A restart does not cost the queue.</Strong> When a Run fails because the model
          server stopped answering for longer than that, the queue asks the server before starting
          the next Run on it and keeps waiting Runs queued until it answers again, instead of
          starting each one only to fail.
        </LI>
        <LI>
          <Strong>No backlog of the same Routine.</Strong> When a Routine&apos;s next scheduled
          time arrives while its last scheduled Run is still waiting for the model, that waiting Run
          covers both occurrences instead of a second Run queueing behind it. The Run shows{" "}
          <Code>+1 missed</Code> and its brief asks the employee to cover the whole period since
          the last Run.
        </LI>
      </UL>
      <P>
        If Routines still run out of time, the model is doing more work than one hour of its
        throughput allows: raise the Routine&apos;s time limit, split it into smaller Routines, or
        give the server more GPU.
      </P>

      <H2 id="docker-networking">Docker networking</H2>
      <P>
        If you installed Genosyn through <Code>genosyn install</Code>, the app runs inside a Docker
        container. <Code>localhost</Code> inside the container is <Strong>not</Strong> the same as
        on your host — the LLM server on the host won&apos;t be reachable as{" "}
        <Code>http://localhost:11434</Code> from the employee.
      </P>
      <KeyList
        rows={[
          {
            term: "macOS / Win",
            def: (
              <>
                Use <Code>http://host.docker.internal:11434</Code>. Docker Desktop wires this magic
                hostname to the host automatically.
              </>
            ),
          },
          {
            term: "Linux",
            def: (
              <>
                Add <Code>--add-host=host.docker.internal:host-gateway</Code> to your{" "}
                <Code>docker run</Code>, or run the LLM server bound to <Code>0.0.0.0</Code> and use
                the host&apos;s LAN IP.
              </>
            ),
          },
          {
            term: "Same machine, second container",
            def: (
              <>
                Easiest is a shared user-defined network (
                <Code>docker network create genosyn-net</Code>) and reference the LLM container by
                name.
              </>
            ),
          },
        ]}
      />

      <H2 id="hardware">Hardware sizing</H2>
      <P>
        Rough rules of thumb for picking weights against your GPU memory. Quantized GGUFs at q4_k_m
        or q5_k_m are the practical baseline — the quality loss vs the original is small and the
        memory savings are large.
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
          <Strong>Model replies but never calls a tool.</Strong> Almost always the chat template /
          tool-call parser. Check that your server has tool-call support enabled (
          <Code>--jinja</Code> for llama.cpp, <Code>--enable-auto-tool-choice</Code> for vLLM, and a
          chat template that emits a function-call block).
        </LI>
        <LI>
          <Strong>Runs hang on the first message.</Strong> Network — the agent inside the container
          can&apos;t reach your host. See the Docker networking section above.
        </LI>
        <LI>
          <Strong>Model loops or hallucinates tool names.</Strong> Context window. Genosyn injects
          the Soul + every Skill + the MCP working set of tools at each turn; that&apos;s roughly
          4k–5k tokens before the first user message. Run models with at least 32k context for
          serious work.
        </LI>
        <LI>
          <Strong>&quot;This model&apos;s maximum context length is N tokens.&quot;</Strong> The
          prompt outgrew the window. Set the model&apos;s context window on its card so OpenCode can
          manage compaction against the actual limit. Reduce large Skills or attached material if
          the initial request itself exceeds the window.
        </LI>
        <LI>
          <Strong>&quot;The AI Model&apos;s response was cut off at its output limit.&quot;</Strong>{" "}
          A reasoning model can think past its response allowance before calling a tool. With a
          known context window, a <Code>Custom</Code> model may answer with up to 32K tokens (at
          most a quarter of the window); with an unknown window it gets 8K. Set the window on the
          model card.
        </LI>
        <LI>
          <Strong>Employee forgets what a tool told it earlier.</Strong> Long sessions may require
          OpenCode to compact earlier history. Give the model a longer context, trim the Skills that
          accompany each turn, or save durable findings in a Workstream.
        </LI>
        <LI>
          <Strong>Slow, or Routines end as timeout Errors.</Strong> First check that the server
          reuses prompts (<a href="#vllm-tuning">Tune vLLM for Routines</a>) and that Routines are
          not all sharing the GPU at once (<a href="#busy-model">When the model is busy</a>). Then
          quantize down (q8 → q5) or pin the layers to GPU (<Code>--n-gpu-layers</Code> in
          llama.cpp). If your GPU is still saturated, the answer is more hardware, not more tuning.
        </LI>
      </UL>

      <Callout kind="tip" title="Mix and match.">
        You don&apos;t have to choose one path for the whole company. One employee can run on Claude
        via an Anthropic API key; another runs on a local Qwen via a <Code>Custom</Code> endpoint.
        They share Channels, Notes, and Integrations — only the brain differs. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for the bigger picture.
      </Callout>
    </>
  );
}
