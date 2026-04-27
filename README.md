# Genosyn

Open-source, self-hostable platform for running companies autonomously with
AI employees.

A **Company** has human **Members** and **AI Employees**. Every AI Employee
has a **Soul** (their constitution), a set of **Skills** (markdown playbooks),
and **Routines** (scheduled, cron-driven work) — all stored in the database.
Bring your own **AI Models** (`claude-code`, `codex`, `opencode`) and assign
them per employee.

North star: [paperclip.ing](https://paperclip.ing/).

> **Disclaimer:** This software is vibecoded. Use at your own risk. It is
> open source and provided **without warranty** of any kind — see
> [`LICENSE`](./LICENSE).

## Repo layout

```
genosyn/
├── App/         # Product app — Express + TypeORM + React + Vite + Tailwind
├── Home/        # Marketing site — React + Vite + Tailwind
├── CLI/         # `genosyn` cluster-maintainer CLI (bash)
├── AGENTS.md    # Instructions for AI coding agents (read this first)
├── ROADMAP.md   # Vocabulary, milestones, backlog
└── CLAUDE.md    # Pointer to AGENTS.md
```

## Quickstart

### One-command install (recommended)

```bash
curl -fsSL https://genosyn.com/install.sh | bash
```

This installs the `genosyn` CLI to `/usr/local/bin` (falls back to
`~/.local/bin` without sudo), pulls the latest image, and starts a container
on port `8471` with a persistent `genosyn-data` volume. Re-run it any time to
upgrade.

Day-to-day management:

```bash
genosyn status           # show running state, image, volume, port
genosyn upgrade          # pull latest image and recreate container
genosyn logs -f          # tail server logs
genosyn backup           # tarball the data volume
genosyn restore <file>   # restore a backup
genosyn stop | start | restart
genosyn uninstall [--purge]
genosyn help             # full command reference
```

Defaults can be overridden with flags (`--port`, `--name`, `--volume`,
`--image`) or env vars (`GENOSYN_PORT`, `GENOSYN_NAME`, `GENOSYN_VOLUME`,
`GENOSYN_IMAGE`).

### Docker (manual)

Pre-built images are published to GitHub Container Registry on every push to
`main`.

```bash
# Product app — API + UI on one port
docker run -d --name genosyn -p 8471:8471 \
  -v genosyn-data:/app/data \
  ghcr.io/genosyn/app:latest
# → http://localhost:8471

# Marketing site
docker run -d --name genosyn-home -p 8472:3000 \
  ghcr.io/genosyn/home:latest
# → http://localhost:8472
```

The `genosyn-data` volume holds the SQLite database (Soul, Skill, Routine,
and Run content live there) plus per-employee provider credentials on disk.
It persists across restarts and image upgrades.

To override `config.ts` without rebuilding, mount your own on top:

```bash
docker run -d --name genosyn -p 8471:8471 \
  -v genosyn-data:/app/data \
  -v "$PWD/config.ts:/app/config.ts:ro" \
  ghcr.io/genosyn/app:latest
```

### From source

```bash
# Product app — API + UI on one port
cd App && npm install && npm run dev
# → http://localhost:8471

# Marketing site
cd Home && npm install && npm run dev
# → http://localhost:8472
```

See [`App/README.md`](./App/README.md) and [`Home/README.md`](./Home/README.md)
for production builds, config, and scripts.

## Contributing

Read [`AGENTS.md`](./AGENTS.md) before opening a PR — it covers the
project vocabulary (Routine, Soul, Skill, AI Employee), the stack, and
code conventions. Check [`ROADMAP.md`](./ROADMAP.md) for what's in
flight and what's next.

## License

[MIT](./LICENSE) © HackerBay, Inc.
