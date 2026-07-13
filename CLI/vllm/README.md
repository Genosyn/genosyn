# Genosyn vLLM model server

A self-contained [vLLM](https://docs.vllm.ai) server that exposes an
**OpenAI-compatible `/v1` API** on a GPU host. Run it on any VM with a GPU,
then point a Genosyn AI Employee at it using the **Custom** provider — no
Anthropic or OpenAI key required.

```
Genosyn (your laptop / another host)
   └─ HTTP to  http://<gpu-vm>:8000/v1   ← this compose
        └─ vLLM  →  open-weight model on the VM's GPU
```

## Requirements (on the GPU VM)

- An NVIDIA GPU with enough VRAM for your model (see the sizing table in the
  [Open-source LLMs doc](https://genosyn.com/docs/open-source-models)).
- NVIDIA driver + Docker + the **nvidia-container-toolkit** (this is what lets
  Docker pass the GPU into the container):
  ```bash
  # Ubuntu / Debian
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
  ```
  Verify with: `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`

## Option A — the `genosyn` CLI (recommended)

The CLI carries an embedded copy of this compose, so you don't even need to
clone the repo:

```bash
# on the GPU VM
curl -fsSL https://genosyn.com/genosyn -o /usr/local/bin/genosyn && chmod +x /usr/local/bin/genosyn

genosyn vllm up --model Qwen/Qwen2.5-Coder-32B-Instruct --api-key "$(openssl rand -hex 24)"
genosyn vllm status      # is it up? what's the connect URL?
genosyn vllm logs -f     # watch the first model download + load
```

`genosyn vllm up` prints the exact **Base URL**, **Model id**, and **API key**
to paste into Genosyn (Settings → AI Model → Custom).

## Option B — docker compose directly

```bash
cp .env.example .env
$EDITOR .env                 # set VLLM_MODEL, VLLM_API_KEY, etc.
docker compose up -d
docker compose logs -f
```

## Connect Genosyn to it

In your **local** Genosyn, open **Settings → AI Model** (or the hire wizard's
Model step) and choose the **Custom** provider:

| Field     | Value                                                        |
| --------- | ------------------------------------------------------------ |
| Base URL  | `http://<gpu-vm-ip>:8000/v1`                                 |
| Model id  | the exact `VLLM_MODEL` string, e.g. `Qwen/Qwen2.5-Coder-32B-Instruct` |
| API key   | your `VLLM_API_KEY` (leave blank only if the port is truly private) |

## Security

The server binds `0.0.0.0`, so anything that can reach the port can use your
GPU. On a cloud VM:

- **Set `VLLM_API_KEY`.** Without it the endpoint is open to anyone who reaches
  the port.
- **Lock the firewall** to just the host running Genosyn. On GCP the default is
  deny; add a rule scoped to your source IP, e.g.
  ```bash
  gcloud compute firewall-rules create genosyn-vllm \
    --allow tcp:8000 --source-ranges <your-ip>/32 --target-tags vllm
  ```
- Prefer a private network / VPN / SSH tunnel over a public IP where you can.

## Common knobs

See [`.env.example`](./.env.example) for the full list. The ones you'll touch
most: `VLLM_MODEL`, `VLLM_TOOL_PARSER` (must match the model family),
`VLLM_TP` (GPUs to shard across), and `VLLM_MAX_MODEL_LEN`.
