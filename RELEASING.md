# Releasing

How to ship a new Genosyn release. Driven by two GitHub Actions workflows
([`.github/workflows/release.yml`](.github/workflows/release.yml) and
[`.github/workflows/docker.yml`](.github/workflows/docker.yml)) plus the
single-source-of-truth [`VERSION`](VERSION) file at the repo root.

## TL;DR

```bash
# from a clean main with the work you want to ship already merged
echo "0.3.3" > VERSION                           # bump (semver)
git add VERSION && git commit -m "chore: bump VERSION to 0.3.3"
git push origin main                             # ship code to main
git push origin main:release                     # fast-forward release → fires release.yml
```

The release workflow then:

1. Reads `VERSION`, validates semver.
2. Creates a `v<version>` GitHub release with auto-generated notes (skipped
   if a release with that tag already exists — bump `VERSION` to ship a new
   one).
3. Dispatches [`docker.yml`](.github/workflows/docker.yml) against the new
   tag so semver-tagged images land on GHCR
   (`ghcr.io/genosyn/genosyn-app:v0.3.3` etc.).

## Versioning

Pre-1.0 we bump **patch** for both features and fixes; reserve **minor** for
larger reshapes (e.g. dropping a provider, swapping the storage layer).
The `VERSION` file is the single source of truth — do not maintain version
numbers in `package.json` files; the build scripts read `VERSION`.

The release workflow refuses to run if `VERSION` isn't valid semver
(`MAJOR.MINOR.PATCH` with optional `-pre.release` suffix).

## Branches

- **`main`** — where work lands. Merging to main does *not* publish a release.
- **`release`** — release tracker. Pushing to release fires
  [`release.yml`](.github/workflows/release.yml). In normal operation
  `release` is a fast-forward of `main`.

## Step by step

### 1. Make sure `main` is shippable

- CI green on the commit you're about to release.
- The dev image (`docker.yml`'s `main`-trigger run) successfully built — if
  the `main`-tagged image is broken, the same image tagged `v<version>` will
  also break.
- Skim `git log --oneline origin/release..main` to confirm the commits look
  right for a release.

### 2. Bump `VERSION`

```bash
# Pick the next semver. Pre-1.0 — patch for features and fixes:
echo "0.3.3" > VERSION
git add VERSION
git commit -m "chore: bump VERSION to 0.3.3"
git push origin main
```

If you forget this step, the release workflow runs but does nothing — it
emits a `::notice::` saying the tag already exists. Re-run after bumping.

### 3. Fast-forward `release` to `main`

```bash
git push origin main:release
```

This is a fast-forward by default; if it isn't (someone pushed straight to
`release`, or you cherry-picked something), reconcile first — never
`--force` push `release`.

### 4. Watch the workflows

```bash
gh run list --workflow=release.yml --limit 3
gh run watch <id>                              # release.yml: ~30s
gh run list --workflow=docker.yml --limit 3
gh run watch <id>                              # docker.yml: ~3-5 min
```

The release workflow output should report:
- `version=0.3.3` and `tag=v0.3.3` from the "Read VERSION" step.
- A new release at `https://github.com/Genosyn/genosyn/releases/tag/v0.3.3`.
- A dispatch line for `docker.yml --ref v0.3.3`.

The docker workflow then publishes:
- `ghcr.io/genosyn/genosyn-app:v0.3.3`
- `ghcr.io/genosyn/genosyn-home:v0.3.3`

(plus `:0.3.3`, `:0.3`, `:latest` aliases per `docker.yml`).

### 5. Verify

```bash
gh release view v0.3.3
docker pull ghcr.io/genosyn/genosyn-app:v0.3.3
```

If anything looks off, the release row on GitHub can be edited in place;
the GHCR images are immutable but you can publish a `v0.3.4` over the top.

## Recovery

### "I pushed to `release` but the release workflow didn't fire"

Most likely the VERSION already matched an existing tag. The workflow logs
will show the `::notice::Release v0.3.x already exists — bump VERSION` line.
Bump `VERSION` and push to main, then fast-forward release again.

### "The release was created but no GHCR images appeared"

The "Trigger image build for new tag" step needs `actions: write`
permission (already in `release.yml`). If a token-permission change has
broken it, manually dispatch:

```bash
gh workflow run docker.yml --ref v0.3.3
```

### "The docker.yml run for `main` failed but I want to ship anyway"

Don't. The release workflow will re-build the same image off the tag. If
the build is broken on `main`, fix it on `main` first, then bump VERSION.
Shipping a known-broken image is worse than slipping a release.

### "I bumped VERSION but something's wrong — can I un-release?"

You can `gh release delete v0.3.3` and `git push --delete origin v0.3.3`,
but the GHCR image tags will stay (registry deletes are manual). It is
almost always cleaner to ship a `v0.3.4` with the fix than to try to
rewind.

## Files involved

- [`VERSION`](VERSION) — semver string, no leading `v`.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) —
  reads `VERSION` and creates the GitHub release.
- [`.github/workflows/docker.yml`](.github/workflows/docker.yml) —
  builds and publishes GHCR images for `main` (dev tag) and `v*.*.*` tags
  (semver tags).
- [`App/Dockerfile`](App/Dockerfile) /
  [`Home/Dockerfile`](Home/Dockerfile) — what gets built.
