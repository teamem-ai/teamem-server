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

### Initial bootstrap

The first public version, `0.1.0`, was published manually because npm trusted
publishing can only be configured from an existing package's settings page.
The one-time bootstrap procedure was:

```bash
mkdir -p /tmp/teamem-schema-release
pnpm --filter @teamem/schema pack --pack-destination /tmp/teamem-schema-release
npm publish /tmp/teamem-schema-release/teamem-schema-0.1.0.tgz --access public
npm view @teamem/schema@0.1.0 version
```

Do not run this procedure again for `0.1.0`, and do not push a
`schema-v0.1.0` tag after the manual publication: npm package versions are
immutable, so the automated workflow would attempt to publish a version that
already exists.

### Configure npm trusted publishing

Configure this once after the initial package publication:

1. Sign in to npm and open the `@teamem/schema` package.
2. Open **Settings**, find **Trusted Publisher**, and select
   **GitHub Actions**.
3. Enter the following values exactly:

   | Field | Value |
   | --- | --- |
   | Organization or user | `teamem-ai` |
   | Repository | `teamem-server` |
   | Workflow filename | `publish-schema.yml` |
   | Environment name | Leave blank |
   | Allowed actions | `npm publish` |

   The workflow field accepts the filename only, not
   `.github/workflows/publish-schema.yml`. The environment must remain blank
   because the publish job does not declare a GitHub environment.
4. Save the trusted publisher.

npm does not validate these values when they are saved. Field values are
case-sensitive, and a mismatch is only reported when a workflow attempts to
publish.

The workflow uses a GitHub-hosted runner, Node 24, npm 11.5.1, and
`id-token: write`, which satisfy npm's OIDC requirements. It does not require
an `NPM_TOKEN`; npm exchanges the GitHub OIDC identity for a short-lived
publishing credential and automatically records package provenance.

### Publish a subsequent version

All releases after `0.1.0` use the
`.github/workflows/publish-schema.yml` trusted-publishing workflow:

1. Update `packages/schema/package.json` to the intended semver version.
2. Build, test, pack, and smoke-test the package in the release pull request.
3. Merge the pull request into `main`.
4. From the updated `main`, create and push an annotated tag whose version
   exactly matches the package manifest:

   ```bash
   git switch main
   git pull --ff-only
   git tag -a schema-v0.1.1 -m "Release @teamem/schema 0.1.1"
   git push origin schema-v0.1.1
   ```

5. Watch the **Publish schema package** GitHub Actions run. The workflow:
   verifies that the tag is annotated, matches the manifest version, and
   points to `main`; runs repository validation; creates the release tarball;
   installs it in an isolated consumer project; and publishes that exact
   tarball to npm through OIDC.
6. Verify the public release:

   ```bash
   npm view @teamem/schema@0.1.1 version
   ```

Replace `0.1.1` in the example with the intended release version. Never reuse
or move an existing release tag, and never add a long-lived npm write token to
repository secrets.

If publishing fails with `ENEEDAUTH`, first confirm that the npm trusted
publisher fields match the repository and workflow filename exactly and that
the workflow still has `id-token: write`.
