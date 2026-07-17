# @teamem/schema

Shared contract types for [teamem](https://github.com/teamem-ai/teamem-server):
concept page schema, ingestion API types, and Zod validators.

**License: MIT** — unlike the rest of this repository (AGPL-3.0-only), this
package is deliberately MIT-licensed. It is the carrier of teamem's open
knowledge format: clients, connectors, and third-party tools are meant to
import it freely, without copyleft obligations.

## Status

**Contract v0.2 — FROZEN (2026-07-17, after five review rounds).**
The Zod schemas in `src/` ARE the contract text ("the appendix is the code"):
error envelope, cursor, auth vocabulary, ingestion request/response, batch,
compilations, concept/evidence, event, job, and audit DTOs — each annotated
with the decision (Q/N) it implements. `src/contract.test.ts` pins the
frozen decisions as executable checks. Changes from here bump the contract
version (v0.3); no casual edits.

Build/publish tooling will be added with the first real release.
