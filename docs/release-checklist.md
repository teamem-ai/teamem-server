# Release Checklist — M3 public release

This document is the operational runbook for cutting a `teamem-server` public
release. It covers **placement** (where artifacts, demo media, and release
notes live) and a **checklist** to work through before tagging. The actual
*content* of the release notes and demo media is founder-owned — this file
does not attempt to write that content, it only defines where it must go and
what must be true before the tag is pushed.

Authoritative release *process* is in [`docs/GITFLOW.md`](./GITFLOW.md)
(English) — this checklist is the concrete gate list for `M3-REL-01`.

## 1. Release artifacts (the machine-made parts)

A release consists of exactly four immutable artifacts, produced by
`.github/workflows/release.yml` from an annotated `vMAJOR.MINOR.PATCH` tag:

| Artifact | Produced by | Location |
|---|---|---|
| Git tag | maintainer (annotated) | `vX.Y.Z` on `main` |
| Source commit | workflow verify | the tagged commit |
| GitHub Release | workflow `github-release` job | `https://github.com/teamem-ai/teamem-server/releases` |
| Container image | workflow `container` job | `ghcr.io/teamem-ai/teamem-server` (`:vX.Y.Z`, `:X.Y`, `:X`, `:latest`), with build provenance attestation |

The release workflow **never deploys to a hosted environment**. `.github/scripts/check-no-deploy.mjs`
is enforced on every PR and re-checked at tag time; a future change that adds a
deploy step to `release.yml` fails CI and fails the release.

## 2. Pre-release gates (all must pass)

Run these before creating the `release/vX.Y.Z` preparation PR:

- [ ] `pnpm lint` — clean.
- [ ] `pnpm typecheck` — clean (server, web, schema, scripts).
- [ ] `pnpm license:check` — boundary intact: root/server/web AGPL-3.0-only, `packages/schema` MIT, no bleed.
- [ ] `pnpm build` — server + web SPA build clean.
- [ ] `pnpm test` — unit suite green against the codebase baseline.
- [ ] DB-backed integration suite green against real PostgreSQL/pgvector
      (`string(env.TEST_DATABASE_URL)` with committed migrations applied,
      `pnpm --filter @teamem/server test:integration`).
- [ ] Honest skips reviewed: every skipped test logs a reason (missing BYO LLM
      provider, missing GitHub App credentials, missing `TEST_DATABASE_URL`).
      A green CI with unexplained skips is not a green release.
- [ ] Real end-to-end smoke with a BYO provider and a real GitHub event
      (see `scripts/e2e.sh`, `docs/m2-acceptance.md`) — release verification
      uses the same criteria as M2 acceptance.
- [ ] Both Compose topologies smoke-tested: standard three-container and
      `TEAMEM_ALL_IN_ONE=true` (`scripts/m0-compose-smoke.sh`).
- [ ] `.github/scripts/check-no-deploy.mjs` passes on `release.yml`.
- [ ] `CHANGELOG.md` has the `## [X.Y.Z] - YYYY-MM-DD` heading (fail-fast check
      in `.github/scripts/verify-release.mjs`).
- [ ] Root, `apps/server`, `apps/web` `package.json` versions match the tag
      (fail-fast check in `verify-release.mjs`). `packages/schema` is
      **not** bumped by product releases — it has its own `schema-vX.Y.Z` train.

## 3. Release-note placement

Release notes are written by the founder and pasted into the GitHub Release
body when the workflow creates it (`--generate-notes` drafts a skeleton that is
then edited). Source of truth: **the GitHub Release body** for the tag.

Keep the notes durable and findable:

- [ ] Paste the finalized notes into the GitHub Release body for `vX.Y.Z`
      (title: `Teamem vX.Y.Z`).
- [ ] Mirror a *short* "Release notes" section into `CHANGELOG.md` under the
      version heading (the workflow does not do this automatically).
- [ ] If the release changes the default user experience, link the notes from
      the README (top status line) for the period of the release.

### Demo GIF placement

The demo GIF is founder-owned media. Its canonical location for a release is
**the GitHub Release body**; the README may reference it for a short window
around the release.

- [ ] Record the demo GIF (e.g., `docs/assets/demo-vX.Y.Z.gif`, committed to
      the repo so the release notes can link it).
- [ ] Embed it in the GitHub Release body:
      `![Teamem vX.Y.Z demo](https://raw.githubusercontent.com/teamem-ai/teamem-server/vX.Y.Z/docs/assets/demo-vX.Y.Z.gif)`
      (pin the URL to the immutable tag, not `main`).
- [ ] Keep the GIF free of private payloads: use the public demo dataset or
      scrub any real customer data. The redaction rules in `AGENTS.md` §5.3
      apply to anything that will be published.

## 4. Release-note template (founder-owned)

Structure suggested by `.github/release.yml` categories. Content is written by
the founder; placeholders are `[...]`.

```markdown
## Teamem vX.Y.Z

**[one-paragraph punchline: what this release lets a team do]**

![Demo](https://raw.githubusercontent.com/teamem-ai/teamem-server/vX.Y.Z/docs/assets/demo-vX.Y.Z.gif)

### Features
- [...]

### Fixes
- [...]

### Notable
- Container: `ghcr.io/teamem-ai/teamem-server@sha256:...` (provenance attestation available)
- License boundary: server/web AGPL-3.0-only; `@teamem/schema` MIT.

### Upgrade notes
- [database migrations? new environment variables?]
- [anything that breaks a previous deploy]
```

## 5. Post-release verification

Releasing publishes; it does **not** deploy. After the workflow completes:

- [ ] Workflow run is green: `verify` → `container` → `github-release`.
- [ ] GitHub Release exists for `vX.Y.Z`, is `latest`, notes are finalized.
- [ ] GHCR image is pullable: `docker pull ghcr.io/teamem-ai/teamem-server:vX.Y.Z`.
- [ ] Smoke-test the image the way a user would (`docker compose up` with the
      image tag) — this is release verification, not deployment.
- [ ] Confirm no workflow step contacted a hosted runtime (no SSH, no cloud
      platforms) — `.github/scripts/check-no-deploy.mjs` enforces this on the
      workflow file, per-tag.