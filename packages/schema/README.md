# @teamem/schema

Shared contract types for [teamem](https://github.com/teamem-ai/teamem-server):
concept page schema, ingestion API types, and Zod validators.

**License: MIT** — unlike the rest of this repository (AGPL-3.0-only), this
package is deliberately MIT-licensed. It is the carrier of teamem's open
knowledge format: clients, connectors, and third-party tools are meant to
import it freely, without copyleft obligations.

## Status

Contract v0 is drafted but **not yet frozen**. Zod schemas and TypeScript
types will be generated here upon contract freeze. Until then this package
intentionally exports only its contract status marker — no speculative types.

Build/publish tooling will be added with the first real release.
