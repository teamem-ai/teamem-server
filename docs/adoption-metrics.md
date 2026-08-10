# Adoption Metrics — Collection Definition

This document defines **how adoption is measured** for the public release of
`teamem-server`, ahead of the W9–W10 adoption-validation window.

> **This file defines collection, not targets.** Nothing here asserts that any
> adoption threshold has been met. A metric is "wired" when its source, its
> retention limit, its cadence, its owner, and its landing point are all
> written down and have been exercised at least once against the real source.
> Whether the numbers are good is a separate, later judgment (AGENTS.md §10).

Landing point for every metric below: **the snapshot log at the end of this
file**. One dated row per collection run, appended, never rewritten.

---

## 1. Stars

| | |
|---|---|
| **Source** | GitHub Insights → the repository's stargazer count |
| **Command** | `gh api repos/teamem-ai/teamem-server --jq .stargazers_count` |
| **Retention** | Cumulative; GitHub does not expire it |
| **Cadence** | Weekly (any cadence works — the value is never lost) |
| **Records** | `stars`, `forks` |
| **Token scope** | Public read; no special scope |

Stars are a vanity-adjacent number and are collected because the milestone
checklist names them, not because they demonstrate use. They are read
alongside clones, never on their own.

## 2. Clones and views (Insights → Traffic)

| | |
|---|---|
| **Source** | GitHub Insights → Traffic |
| **Commands** | `gh api repos/teamem-ai/teamem-server/traffic/clones`<br>`gh api repos/teamem-ai/teamem-server/traffic/views` |
| **Retention** | **14 days only.** GitHub returns exactly 14 daily buckets and discards older ones permanently |
| **Cadence** | **At most every 14 days**, or history is irrecoverably lost. Weekly is the working cadence, so one missed run does not lose data |
| **Records** | `clones.count`, `clones.uniques`, `views.count`, `views.uniques`, plus the raw daily buckets |
| **Token scope** | **Requires push/admin access** — the traffic API is not public |

Two collection rules that decide whether these numbers mean anything:

- **Read `uniques`, not `count`.** `count` includes automated clones — CI
  checkouts (this repository's own Actions runs clone it on every workflow),
  mirrors, and scrapers. `uniques` (distinct cloners per day) is the
  adoption-relevant figure. The first snapshot below shows the gap plainly:
  3,562 clones against 338 uniques.
- **Archive the daily buckets, not just the totals.** The 14-day total is a
  sliding window; consecutive snapshots overlap. Keeping the per-day buckets
  is what makes a longer series reconstructable after the window slides.

## 3. Question quality (Issues / Discussions / Discord)

The signal that matters for adoption is not *how many* questions arrive, but
*which kind*. Each inbound question is classified into exactly one bucket at
collection time:

| Bucket | Meaning | What it says |
|---|---|---|
| **A — blocked on deploy** | Cannot get the stack up at all | Packaging or quickstart failure |
| **B — blocked on config** | GitHub App, LLM provider key, env vars | Onboarding-docs failure |
| **C — using the knowledge** | `search` / `get_page` / context injection / export / compile quality | **The healthy signal** — the asker got the product running and is now using it |
| **D — product / roadmap** | Feature requests, design questions | Interest without confirmed use |
| **E — bug with a reproduction** | A real defect, reproducible | Healthy: implies sustained real use |

**Reading:** the ratio of **C + E** against **A + B** is the adoption-quality
measure. A stream that is all A and B means the 30-minute deployment promise
is not holding, whatever the star count says. No threshold is set here.

| | |
|---|---|
| **Sources** | GitHub Issues (`gh issue list --repo teamem-ai/teamem-server --state all`), GitHub Discussions, Discord |
| **Retention** | Indefinite for Issues/Discussions; Discord depends on the server's own history |
| **Cadence** | Weekly, classified at collection time |
| **Records** | Count per bucket A–E, and the C+E share |

**Landing points are not all live yet** (see the status table below). Only the
Issues channel is collectable today; that is a finding for the release
workstream, recorded honestly rather than papered over.

---

## Landing-point status

Verified 2026-08-10 against the real repository.

| Landing point | Status | Evidence |
|---|---|---|
| Stars / forks | **Live** | `gh api repos/teamem-ai/teamem-server` → `stargazers_count: 0`, `forks: 0` |
| Traffic (clones / views) | **Live** | `gh api …/traffic/clones` and `…/traffic/views` both return real 14-day series |
| GitHub Issues | **Live** | `hasIssuesEnabled: true`; `bug.yml` / `feature.yml` templates present |
| GitHub Discussions | **NOT live** | `hasDiscussionsEnabled: false`, yet `.github/ISSUE_TEMPLATE/config.yml` offers "Questions and support" pointing at `/discussions`, which returns **HTTP 404**. Either enable Discussions or remove the link |
| Discord | **Does not exist** | No Discord server, invite, or reference anywhere in the repository |

Until Discussions is enabled and a Discord landing point exists, question
quality is collectable **from Issues only**, and the metric must be reported
that way rather than as a full-coverage number.

---

## Snapshot log

Append one row per collection run. Numbers are raw observations, not
judgments.

| Date (UTC) | Stars | Forks | Clones 14d (count / uniq) | Views 14d (count / uniq) | Questions A/B/C/D/E | Collector | Notes |
|---|---|---|---|---|---|---|---|
| 2026-08-10 | 0 | 0 | 3562 / 338 | 114 / 2 | 0/0/0/0/0 | M3-QA-03 acceptance | First snapshot; wiring verification. Repo public since 2026-07-17, not yet announced — no release tag, no launch post, so these are pre-announcement baselines. Clone `count` is dominated by CI checkouts; `uniques` is the meaningful figure. Zero issues opened to date, Discussions disabled, no Discord |

Daily traffic buckets for the first snapshot (2026-07-26 → 2026-08-08),
retained here because GitHub will discard them after 14 days:

```json
{"clones":{"count":3562,"uniques":338,"daily":[
  {"2026-07-26":{"count":57,"uniques":14}},{"2026-07-27":{"count":10,"uniques":9}},
  {"2026-07-28":{"count":206,"uniques":38}},{"2026-07-29":{"count":3,"uniques":3}},
  {"2026-07-30":{"count":815,"uniques":111}},{"2026-07-31":{"count":1370,"uniques":177}},
  {"2026-08-01":{"count":200,"uniques":45}},{"2026-08-02":{"count":734,"uniques":13}},
  {"2026-08-03":{"count":5,"uniques":5}},{"2026-08-04":{"count":4,"uniques":4}},
  {"2026-08-05":{"count":2,"uniques":2}},{"2026-08-06":{"count":34,"uniques":6}},
  {"2026-08-07":{"count":52,"uniques":6}},{"2026-08-08":{"count":70,"uniques":10}}]},
 "views":{"count":114,"uniques":2}}
```

---

## Collection runbook

```sh
# 1. Stars / forks (public read)
gh api repos/teamem-ai/teamem-server --jq '{stars:.stargazers_count, forks:.forks}'

# 2. Traffic — REQUIRES push access; 14-day window, run at least fortnightly
gh api repos/teamem-ai/teamem-server/traffic/clones
gh api repos/teamem-ai/teamem-server/traffic/views

# 3. Questions — classify each into buckets A–E
gh issue list --repo teamem-ai/teamem-server --state all --limit 100
# Discussions and Discord: not collectable until those landing points exist.
```

Append the result as a row in the snapshot log above, in the same pull-request
discipline as any other change to this repository.
