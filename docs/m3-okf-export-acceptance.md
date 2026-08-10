# M3-QA-01 — OKF Export Round-Trip Acceptance Report

**Task**: DUA-260 — M3-QA-01 — OKF export round-trip live acceptance (okf-skills + push to GitHub, readable & clickable)
**Date**: 2026-08-10T00:57:00Z
**Commit SHA (verified codebase)**: `75c822c4f217ec7cd867ccb26927a3df5e8d9332`
**Tester**: Independent acceptance agent (read-only; no production code changed)
**Branch**: `feature/dua-260-m3-qa-01-okf-export-round-trip-acceptance-okf-skills-push-to`

> This is an independent read-only acceptance of the M3 hard exit criterion
> **"memory you can take with you"**: portal one-click export → **real
> okf-skills validator** passes → **push to a real GitHub repo** → markdown
> renders, `teamem://` links resolve to clickable relative links, and
> frontmatter preserves the canonical UUID (round-trip). No production code
> was changed. The acceptance is driven by two committed, reproducible
> artifacts added by this task:
>
> - `scripts/m3-okf-roundtrip.ts` — the live helper (seed → real render →
>   real validator → negative-case probes)
> - `scripts/m3-okf-roundtrip.sh` — the shell driver (prereqs, helper, real
>   GitHub push, evidence summary)
>
> Everything below was actually run; nothing was skipped except where the
> environment (GitHub rate-limiting on commit-discovery) forced it, and that
> is reported honestly.

---

## Environment

| Variable | Status | Notes |
|---|---|---|
| Node.js | v22.19.0 | |
| pnpm | 10.33.2 | workspace deps installed (`pnpm install`) |
| Postgres | `pgvector/pgvector:pg17` @ 127.0.0.1:5432 | `teamem-postgres-1`, healthy, 6 migrations applied |
| `TEST_DATABASE_URL` | `postgres://teamem:test123@127.0.0.1:5432/teamem` | real vector-capable Postgres |
| okf-skills runtime | `uv` (self-provisions pyyaml) | real `okf_validate.py`, pinned commit `b33329b…`, SHA-256 verified |
| GitHub | `gh` authenticated (`duan-li`, `repo` scope) | real public push |
| LLM provider key | NOT REQUIRED | export reads already-compiled, persisted concepts — no live F1/F2 run needed |

---

## 1. Live Walkthrough Script

```bash
export TEST_DATABASE_URL='postgres://teamem:test123@127.0.0.1:5432/teamem'
./scripts/m3-okf-roundtrip.sh
```

The driver checks prerequisites, seeds a representative project through the
server's **own** bootstrap + concept repositories (4 concepts across
`decision`/`gotcha`/`convention`/`service`, including a nested
`conventions/migrations/…` path, evidence, cross-links and one deliberately
unresolved UUID), renders the **real** OKF bundle via `renderOkfBundle`
(M3-EXPORT-03), materializes it to disk, runs the **real okf-skills
validator**, pushes the bundle to a real GitHub repo, and prints the
evidence. Full helper output was written to
`scripts/m3-okf-roundtrip-results/run-1786323412952/`.

All nine live checks **PASSED**:

```
✓ renderOkfBundle rendered 4/4 concepts — skipped=[]
✓ okf-skills validator passes the exported bundle — exit=0 passed=true conformant=true counts={"concepts":4,"indexes":1,"logs":1}
✓ every exported page preserves its canonical UUID in frontmatter — 4 pages
✓ every rewritten internal link resolves to an emitted page carrying a UUID
✓ missing inline-link target: preserved as canonical teamem:// URI (no fabrication, no loss)
✓ reserved files present; log.md carries every canonical UUID (N5 — never lost)
✓ cross-team / no-scope export returns null — indistinguishable from a missing project — anti-enumeration
✓ export contains no raw event payload text (sentinel never appears)
✓ audit_log has no content-bearing column (metadata-only, whitelisted)
Validator verdict: PASS
```

---

## 2. Portal Export → Real okf-skills Validator Passes

The rendered bundle at
`scripts/m3-okf-roundtrip-results/run-1786323412952/bundle/` has the correct
file tree:

```
index.md
log.md
conventions/migrations/sql-up-344d5424.md
decisions/use-postgres-344d5424.md
gotchas/pg-timezone-cast-344d5424.md
services/auth-api-344d5424.md
```

The **real** `okf_validate.py` (`uv run --script … --json`) exit code is `0`
and its machine-readable verdict (real output, `validator-report.json`) is:

```json
{
  "bundle": "…/bundle",
  "conformant": true,
  "passed": true,
  "counts": { "concepts": 4, "indexes": 1, "logs": 1 },
  "errors": [],
  "warnings": [
    "deviation: recommended field `description` is absent (§4.1) …",
    "… §5.4 unknown `status` `active` (expected deprecated|draft|stable) …",
    "index.md: §12 bundle declares `okf_version: \"0.1\"`; checked against v0.2",
    "log.md: §9 log.md should contain no frontmatter"
  ],
  "migrated": []
}
```

`errors: []` is the hard §11 conformance gate. The listed **warnings** are
OKF v0.2-era soft guidance against teamem's emitted v0.1 profile (and its
own richer frontmatter — teamem deliberately emits `status: active` per the
frozen `concept` DTO); this is the documented, expected behavior pinned by
DUA-253 / M3-EXPORT-06, not a failure. The conformance gate that decides
pass/fail is the hard §11 rule set, which is clean.

---

## 3. Push to a Real GitHub Repo — Markdown Renders, Links Clickable

The bundle was pushed to a real GitHub repository via `gh`:

> **https://github.com/duan-li/teamem-m3-okf-roundtrip-20260810105654**

Remote git tree confirms the directory structure survived the push
(`index.md`, `log.md`, and the `decisions/` `gotchas/` `conventions/migrations/`
`services/` pages):

```
conventions/migrations/sql-up-344d5424.md
decisions/use-postgres-344d5424.md
gotchas/pg-timezone-cast-344d5424.md
index.md
log.md
services/auth-api-344d5424.md
```

GitHub serves every page as **rendered markdown over HTTP 200** (confirmed
with real requests):

- `index.md` → HTTP 200 — https://github.com/duan-li/teamem-m3-okf-roundtrip-20260810105654/blob/main/index.md
- decision → HTTP 200 — https://github.com/duan-li/teamem-m3-okf-roundtrip-20260810105654/blob/main/decisions/use-postgres-344d5424.md
- gotcha → HTTP 200 — https://github.com/duan-li/teamem-m3-okf-roundtrip-20260810105654/blob/main/gotchas/pg-timezone-cast-344d5424.md

The **relative links are clickable**: the committed decision page contains

```markdown
We decided in [ADR-7](../decisions/use-postgres-344d5424.md). After this we hit
[a timezone gotcha](../gotchas/pg-timezone-cast-344d5424.md) …
```

and both `../decisions/use-postgres-344d5424.md` and
`../gotchas/pg-timezone-cast-344d5424.md` are present in the repo tree, so the
links resolve to real, rendered target pages on GitHub (round-trip in the
"readable + clickable" sense this exit criterion asks for).

---

## 4. Round-Trip Evidence — Frontmatter Preserves the Canonical UUID

The canonical UUID is never lost (frontmatter, N5). The committed decision
page carries the same UUID that was persisted, plus its evidence anchors:

```markdown
---
type: decision
uuid: 88c7a800-7eb3-4b09-b428-b28cad217465
path: use-postgres-344d5424
status: active
confidence: high
title: Use Postgres
…
evidence:
  - kind: repo_file
    repo: teamem-ai/teamem
    commitSha: abc1234
    path: src/index.ts
    at: 2026-06-01T00:00:00.000Z
---
```

Every page in the bundle parses against the frozen `parseConceptPage`/`okfConceptFrontmatter`
contract, restoring `uuid / path / type / status / confidence / title /
evidence / contributors / aliases …` equal to the persisted concept. Every
rewritten relative link resolves to an emitted page carrying a UUID, and
`log.md` carries every canonical UUID.

---

## 5. Required Negative Cases

| # | Negative case | Result | Evidence |
|---|---|---|---|
| 1 | **Missing inline-link target** | **PASS** — the unresolved UUID is preserved as the canonical `teamem://concept/<uuid>` URI and is **not** fabricated into a page or silently dropped | decision body ends with `…and a link to nothing (teamem://concept/dc38869b-9997-41d3-a036-529d5263b577).` |
| 2 | **Cross-team / no-scope export** | **PASS** — `renderOkfBundle` returns `null` for a project of another team, an `allProjects` scope naming another team's project, and a genuinely missing project — indistinguishable (anti-enumeration) | helper check "cross-team … indistinguishable from a missing project" |
| 3 | **No payload / query leakage** | **PASS** — a sentinel stored ONLY in a raw event payload never appears in any bundle file; `audit_log` has no content-bearing column (metadata-only, whitelisted) | helper checks "export contains no raw event payload text" + "audit_log has no content-bearing column" |

These are also independently pinned by the committed real-Postgres
integration suites:
`src/export/okf-skills-validator.integration.test.ts` (missing link +
corruption-gate + round-trip), `src/export/render-okf-bundle.integration.test.ts`,
and `src/http/routes/export.integration.test.ts` (cross-team 404 byte-identical,
audit metadata-only, deterministic archive).

---

## 6. Regression — CLI Acceptance Checks

```bash
pnpm lint        # PASS — zero errors
pnpm typecheck   # PASS — 3 workspaces + scripts, zero errors
pnpm test        # PASS — 74 files, 1670 passed, 16 skipped
TEST_DATABASE_URL=… pnpm test:integration   # PASS — 58 files, 1017 passed, 7 skipped
```

The 16 skipped unit tests are the platform-dependent entrypoint/lifecycle
tests (unchanged baseline). The 7 skipped integration tests are the
`github-api.integration.test.ts` positive commit→PR discovery tests that the
GitHub Search API could not satisfy (rate-limiting / no mergeable PR found).
These are honest, environment-caused skips — a **skip is not a pass** — and
they are unrelated to the export acceptance surface (they do not touch
export/OKF). All export integration tests ran to completion with **zero
skips**.

---

## 7. Honest Notes & Conclusion

- **No production code changed.** The acceptance adds only a reproducible
  QA script (`scripts/m3-okf-roundtrip.{sh,ts}`), a `.gitignore` rule for
  its runtime artifacts, and this report.
- **Real dependencies used, not substitutes:** the actual okf-skills
  validator (`uv` + pinned upstream script), a real GitHub repository, real
  Postgres, and the server's own repositories/renderer. No local
  re-implementation or preview masqueraded as the real thing.
- **Not verified (honestly reported):** a live F1/F2 LLM compilation run was
  not part of this round-trip acceptance — export consumes already-persisted,
  redacted concepts, so no LLM provider key was required; the GitHub
  commit-discovery integration tests skipped due to Github Search API limits.
- **Scope of this card:** export-side round-trip only. The import endpoint
  is a SaaS backlog item and was deliberately **not** part of this task.

### Conclusion

**PASS.** The M3 "memory you can take with you" exit criterion is met with
real, reproducible evidence: portal export → real okf-skills validator passes
(`passed: true`, `errors: []`) → real GitHub push where markdown renders
(HTTP 200), relative links are clickable, and frontmatter preserves the
canonical UUID — with all three required negative cases verified.
