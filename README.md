# Genosyn

Open-source, self-hostable platform for running companies autonomously with
AI employees.

A **Company** has human **Members** and **AI Employees**. Every AI Employee
has a **Soul** (`SOUL.md`), a set of **Skills** (markdown docs), and
**Routines** (scheduled, cron-driven work). Bring your own **AI Models**
(`claude-code`, `codex`, `opencode`) and assign them per employee.

North star: [paperclip.ing](https://paperclip.ing/).

## Repo layout

```
genosyn/
├── App/         # Product app — Express + TypeORM + React + Vite + Tailwind
├── Home/        # Marketing site — React + Vite + Tailwind
├── AGENTS.md    # Instructions for AI coding agents (read this first)
├── ROADMAP.md   # Vocabulary, milestones, backlog
└── CLAUDE.md    # Pointer to AGENTS.md
```

## Quickstart

The App (product) and Home (marketing) are independent. Run either.

### Docker (recommended)

Pre-built images are published to GitHub Container Registry on every push to
`main`.

```bash
# Product app — API + UI on one port
docker run --rm -p 8471:8471 -v genosyn-data:/app/data \
  ghcr.io/genosyn/app:latest
# → http://localhost:8471

# Marketing site
docker run --rm -p 8472:3000 ghcr.io/genosyn/home:latest
# → http://localhost:8472
```

The `genosyn-data` volume holds the SQLite database and the per-company
markdown tree (`SOUL.md`, skills, routines). To override `config.ts` without
rebuilding, mount your own on top:

```bash
docker run --rm -p 8471:8471 \
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

TBD.
