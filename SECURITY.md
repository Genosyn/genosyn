# Security policy

## Reporting a vulnerability

Email **security@genosyn.com** to report a vulnerability in Genosyn. Please do
not open a public GitHub issue, pull request, or discussion for it, and do not
share details publicly until a fix has been released.

A useful report says:

- which part is affected: the App, Genosyn Connect, the `genosyn` CLI, the Helm
  chart, or the marketing site;
- the version (the `VERSION` file, the image tag, or a commit);
- what an attacker needs first (no account, a Member, a company owner or admin,
  a master admin) and what they gain;
- the steps to reproduce it, ideally against a fresh install.

## Supported versions

Fixes are made on `main` and ship in the next release. Only the latest release
is supported: fixes are not backported to earlier versions.

- Installs made with the `genosyn` CLI upgrade to the latest release every day
  by default. Run `genosyn upgrade` to upgrade now.
- On Kubernetes, upgrade to the latest version of the Helm chart.
- The `:latest` image tag is always the newest release. `:main` is unreleased
  code.

## Scope

[`.oss-scanner/threat_model.md`](./.oss-scanner/threat_model.md) describes
Genosyn's trust model: what is a vulnerability, how we rate severity, and what
is by design. In particular, AI Employee commands run directly on the host with
the App's authority, with no OS sandbox. That on its own is not a
vulnerability. A way for someone with less authority to make them run is.
