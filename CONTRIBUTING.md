# Contributing & developer guide

Thanks for hacking on Genosyn. This guide covers running the project, the repo layout,
and how to get a change merged. For the product vision and milestones, see
[`ROADMAP.md`](./ROADMAP.md); for the coding conventions every change must follow, see
[`AGENTS.md`](./AGENTS.md) — it's the source of truth and **what gets a PR rejected**.

---

## Repo layout

```
genosyn/
├── App/         # Product app — Express + TypeORM + React + Vite + Tailwind
├── Home/        # Marketing site + docs — React + Vite + Tailwind
├── CLI/         # `genosyn` self-host CLI (bash)
├── AGENTS.md    # Code conventions & vocabulary (read before you change code)
├── ROADMAP.md   # Product plan and milestones
└── CLAUDE.md    # Pointer to AGENTS.md for AI coding agents
```

---

## Run it from source

You need **Node 22+** (see [`.nvmrc`](./.nvmrc)).

```bash
# Product app — API + UI on one port
cd App && npm install && npm run dev
# → http://localhost:8471

# Marketing site + docs
cd Home && npm install && npm run dev
# → http://localhost:8472
```

Open http://localhost:8471 and sign up. In the App, the API and the Vite-built UI are
served by the same Express process on the same port, in dev and in production.

See [`App/README.md`](./App/README.md) and [`Home/README.md`](./Home/README.md) for
production builds and the full script list.

### Useful scripts

Both `App/` and `Home/` implement these (CI runs them on every push):

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint — **run before every commit; CI rejects errors** |
| `npm run typecheck` | `tsc --noEmit` |
| `npm start` | Run the production build |

`App/` also exposes the TypeORM migration scripts (`migration:generate`, `migration:run`,
`migration:revert`, …). **Never hand-write a migration** — see [`AGENTS.md`](./AGENTS.md) §7.

### Config

There is no `.env` file. All runtime settings live in `App/config.ts` as one commented
object. Flip `config.db.driver` from `"sqlite"` to `"postgres"` to switch databases.

---

## Run it with Docker

Pre-built images are published to GitHub Container Registry on every push to `main`.

```bash
# Product app — API + UI on one port
docker run -d --name genosyn -p 8471:8471 \
  -v genosyn-data:/app/data \
  ghcr.io/genosyn/app:latest
# → http://localhost:8471

# Marketing site
docker run -d --name genosyn-home -p 8472:8472 \
  ghcr.io/genosyn/home:latest
# → http://localhost:8472
```

The `genosyn-data` volume holds the SQLite database (Souls, Skills, Routines, and run
logs) plus per-employee provider credentials. It persists across restarts and upgrades.

To override `config.ts` without rebuilding, mount your own on top:

```bash
docker run -d --name genosyn -p 8471:8471 \
  -v genosyn-data:/app/data \
  -v "$PWD/config.ts:/app/config.ts:ro" \
  ghcr.io/genosyn/app:latest
```

---

## The `genosyn` CLI

For day-to-day self-hosting, the one-command installer wraps everything above:

```bash
curl -fsSL https://genosyn.com/install.sh | bash
```

It installs the `genosyn` CLI (to `/usr/local/bin`, falling back to `~/.local/bin`
without sudo), pulls the latest image, and starts a container on port `8471` with a
persistent `genosyn-data` volume. Re-run it any time to upgrade.

```bash
genosyn status              # container state, image, volume, and URL
genosyn upgrade             # self-update the CLI, pull latest image, recreate
genosyn self-upgrade        # update only the CLI script
genosyn logs -f             # tail server logs (--tail N for a window)
genosyn backup [--out FILE] # tarball the data volume
genosyn restore <file> [-y] # restore a backup (destructive)
genosyn prune [--dry-run]   # remove orphaned images from prior upgrades
genosyn start | stop | restart
genosyn uninstall [--purge] # --purge also deletes the data volume
genosyn version             # CLI + image versions
genosyn help                # full command reference
```

Defaults can be overridden with flags (`--port`, `--name`, `--volume`, `--image`) or env
vars (`GENOSYN_PORT`, `GENOSYN_NAME`, `GENOSYN_VOLUME`, `GENOSYN_IMAGE`).

`CLI/genosyn` and `CLI/install.sh` are the canonical source — they're synced into the
Home site's public assets at build time, so edit them in `CLI/`.

---

## Sending a pull request

1. **Read [`AGENTS.md`](./AGENTS.md) first.** It covers the vocabulary (Routine, Soul,
   Skill, AI Employee), the locked-in stack, and the conventions a PR is checked against.
2. **Check [`ROADMAP.md`](./ROADMAP.md).** New features should map to a milestone — add
   one before building something that isn't there yet.
3. **Run `npm run lint` and `npm run build` in both `App/` and `Home/`** before pushing.
   CI runs the same commands and rejects errors.
4. **Update the docs in the same PR.** If you change something a user sees, update the
   docs under `Home/client/docs/pages/` (see [`AGENTS.md`](./AGENTS.md) §10).
5. **Write a clear PR description** referencing the milestone and the manual test steps
   you ran.

Releases follow a separate scripted ritual — see [`RELEASING.md`](./RELEASING.md). Don't
bump version numbers or tag manually.

---

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
