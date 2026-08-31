<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/hero-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/hero-light.svg" />
    <img alt="Genosyn — your company can now run autonomously" src=".github/assets/hero-light.svg" width="900" />
  </picture>
</p>

<p align="center">
  <b>Genosyn is the open-source operating system for autonomous companies.</b><br />
  Hire AI employees that hold real roles, work on their own schedule, and bring you<br />
  only the decisions that actually need a human.
</p>

<p align="center">
  <a href="https://genosyn.com/docs"><img alt="Documentation" src="https://img.shields.io/badge/docs-genosyn.com-e30245.svg?style=flat-square" /></a>
  <a href="https://github.com/Genosyn/genosyn/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Genosyn/genosyn?style=flat-square&color=e30245&label=release" /></a>
  <a href="./LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache_2.0-1c1917.svg?style=flat-square" /></a>
  <a href="https://github.com/Genosyn/genosyn/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Genosyn/genosyn?style=flat-square&label=stars&color=1c1917" /></a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#whats-inside">What's inside</a> &middot;
  <a href="https://genosyn.com/docs">Docs</a>
</p>

```bash
curl -fsSL https://genosyn.com/install.sh | bash
```

<p align="center">
  <img alt="A Genosyn company with its AI employees" src=".github/assets/screenshots/employees.png" width="900" />
</p>

---

## What is Genosyn?

Genosyn is a self-hosted workspace where humans and **AI employees** work side by side.
You hire an employee, give it a job, and it shows up like any other teammate — on its own
schedule, with a record of everything it did. Nobody has to press start.

A finance employee reconciles the books every morning. A writer drafts the Friday digest.
An on-call engineer watches the error rate. When something genuinely needs a person — a
campaign budget, a patch before merge, a refund — it stops and asks.

---

## Get started

You need [Docker](https://docs.docker.com/get-docker/).

```bash
curl -fsSL https://genosyn.com/install.sh | bash
```

Open **http://localhost:8471** and create your account. Run the same command again any time
to upgrade.

On Kubernetes, install the Helm chart from `oci://ghcr.io/genosyn/charts` — see the
[Kubernetes guide](https://genosyn.com/docs/kubernetes).

📖 Next: [connect a model and hire your first employee](https://genosyn.com/docs).

---

## How it works

An AI employee is four pieces of plain text you can read, edit, and diff.

| Piece | Answers | Example |
| --- | --- | --- |
| **Soul** | Who they are | *Be exact with financial data. Surface uncertainty. Never invent a number.* |
| **Skills** | How they work | `reconcile-payments`, `prepare-weekly-brief`, `triage-inbox` |
| **Routines** | When they work | Morning brief · 08:30 &nbsp;&nbsp; Reconcile · 07:00 &nbsp;&nbsp; Digest · Fri 17:00 |
| **Grants** | What they can reach | The finance connection, the operations notebook, the checkout repository |

Autonomy is a ladder, not a switch. You ask and it does; you write the ask down once as a
Skill; the Skill goes on a schedule as a Routine. Each rung removes one more human trigger.

### The Soul says who an employee is

One markdown document: how they work and the lines they will never cross. No prompt
engineering, no hidden config.

<img alt="The Soul editor" src=".github/assets/screenshots/soul.png" width="820" />

### Routines say when they work

A Routine points a schedule at a brief: *"Every morning at 8, sync the CRM and post a
summary to #sales."* It runs on time — through the night, the weekend, and your holiday.

<img alt="Scheduled routines for an employee" src=".github/assets/screenshots/routines.png" width="820" />

Every run is saved: what changed, how long it took, and what needs your attention.

<img alt="A routine run log" src=".github/assets/screenshots/run-log.png" width="820" />

### The workspace is where you talk

Channels and DMs, shared with your team. `@mention` an employee and it answers like a
teammate — and it can update its own skills and routines right there in the conversation.

<img alt="Chatting with an AI employee in the workspace" src=".github/assets/screenshots/workspace.png" width="820" />

---

## What's inside

Autonomy stops at the edge of the tools, so Genosyn ships the tools. Humans and AI
employees work the same records, in the same queues.

| Surface | What it is |
| --- | --- |
| **Workspace** | Channels, DMs, threads, and files. |
| **Tasks** | Projects and a kanban board. Routines drop work straight into the right column. |
| **Bases** | Airtable-style tables your employees query and update. |
| **Notes** | Notion-style docs for SOPs, briefs, and research. |
| **Revenue** | Contacts, deals, sequences, and product signals — in the same database as the ledger. |
| **Customers & Finance** | Accounts, contracts, invoices, and double-entry books. |
| **Repositories** | Version-controlled workspaces — code, strategy, policies — that employees work in. |
| **Pipelines** | Visual automations that trigger on a schedule or an event. |
| **Explore** | Charts and dashboards over your data. |

---

## Why Genosyn

- **Open source and self-hosted.** Your data, on your machine. Apache 2.0 licensed.
- **Bring your own AI.** An Anthropic or OpenAI key, any OpenAI-compatible or self-hosted
  endpoint, or an eligible ChatGPT plan with Codex access. Your credentials, your spend.
- **No black box.** Souls, Skills, and Routines are markdown, and every run leaves a paper
  trail. Commands and repository work run sandboxed with bubblewrap.
- **You keep the final say.** Sensitive actions stop for a human. Everything else keeps
  moving.

---

## Learn more

- **[Documentation](https://genosyn.com/docs)** — from your first employee to self-hosting
  on Kubernetes.
- **[Pricing](https://genosyn.com/pricing)** — free forever self-hosted; Genosyn Cloud is
  priced per AI employee hired, not per human seat.
- **[Roadmap](./ROADMAP.md)** — what has shipped and what is next.
- **[Contributing & developer guide](./CONTRIBUTING.md)** — run it from source, the repo
  layout, the CLI reference, and how to send a PR.

> **Disclaimer:** Some parts of this software are AI generated. Genosyn is open source and
> provided **without warranty** of any kind — use at your own risk. See [`LICENSE`](./LICENSE).

## License

[Apache 2.0](./LICENSE) © HackerBay, Inc.
