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

## Install

External consumers install a released version from the public npm registry:

```bash
pnpm add @teamem/schema
```

The package published to npm contains JavaScript and declaration files under
`dist/`. Consumers must use a semver release from the registry; sibling
`file:`, cross-repository `workspace:`, Git URL dependencies, and copied DTOs
are not supported integration paths.

Inside the `teamem-server` monorepo only, applications continue to use
`workspace:*`. That is an internal development link and is never part of the
published CLI dependency graph.

## Release

The first public version is `0.1.0`. Because npm trusted publishing is
configured from an existing package's settings page, the first release is a
one-time authenticated bootstrap:

```bash
pnpm --filter @teamem/schema pack --pack-destination /tmp/teamem-schema-release
npm publish /tmp/teamem-schema-release/teamem-schema-0.1.0.tgz --access public
```

After the first release:

1. Configure the package's npm trusted publisher for
   `teamem-ai/teamem-server` and workflow `publish-schema.yml`.
2. Create an annotated tag `schema-vX.Y.Z` whose version matches this
   package's `package.json`.
3. Push the tag. The workflow verifies, packs, smoke-tests, and publishes the
   exact tarball using short-lived OIDC credentials.

Never add an npm write token to repository secrets for routine releases.
