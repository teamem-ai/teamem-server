---
okf_version: "0.1"
---
# Teamem OKF bundle

## decisions

- [Design Decisions for Onboarding Wizard Implementation](./decisions/decisions/onboarding-wizard-design.md)
- [Key Minting and Governance Separation Decisions](./decisions/decisions/key-minting-governance-separation.md)
- [Budget Strategy for Context Injection Endpoint](./decisions/decisions/budget-strategy-context-injection.md)
- [Document Trusted Publishing Workflow](./decisions/decisions/document-trusted-publishing-workflow.md)
- [Publishing and Release Steps for the @teamem/schema Package](./decisions/decisions/publish-schema-package.md)
- [Decisions regarding M1 Quality Metrics Report](./decisions/decisions/m1-quality-metrics-report.md)
- [Expose POST /v1/search route with explicit limit validation](./decisions/decisions/expose-v1-search-route.md)
- [Key design decisions for the MCP timeline tool](./decisions/decisions/timeline-tool-design.md)
- [Design Decisions for GET /v1/concepts Endpoint Implementation](./decisions/decisions/get-concepts-endpoint.md)
- [Wired Full F1 to F2 Compilation Pipeline and Minimal F1 Structured-Output Contract Decisions](./decisions/decisions/minimal-f1-structured-output.md)
- [Production Docker Image Build Decision](./decisions/decisions/production-docker-image.md)
- [Design Decisions for PostgreSQL Integration Testing](./decisions/decisions/postgres-testing-helpers.md)
- [Validation of Server Environment Variables](./decisions/decisions/validate-server-env-vars.md)
- [Close the Generic Connector Persistence Seam](./decisions/decisions/close-generic-connector-persistence-seam.md)

## gotchas

- [Cold Start Issues with Postgres Migrations](./gotchas/gotchas/cold-start-postgres-migrations.md)
- [Producer/Consumer Contract Violation in CompileQueue](./gotchas/gotchas/compilequeue-contract-violation.md)
- [Capability Detection Bug in QA Script](./gotchas/gotchas/capability-detection-bug.md)
- [Avoid Using Meaningless Commit Messages](./gotchas/gotchas/meaningless-commit-messages.md)
- [Missing Read Scope Enforcement on `get_page` Tool and ScopeContext](./gotchas/gotchas/missing-read-scope-enforcement.md)

## runbooks

- [End-to-End E2E Script Execution for M3 Check](./runbooks/runbooks/e2e-script-execution.md)
- [How to run the M2 governance and security verification script](./runbooks/runbooks/run-governance-security-script.md)
- [How to Run m0-compose-smoke.sh for Docker Compose Validation](./runbooks/runbooks/run-m0-compose-smoke-script.md)

## services

- [Scoped OKF Bundle Download Endpoint](./services/services/scoped-okf-bundle-download.md)
- [M2 Cold Deploy Acceptance Script](./services/services/m2-cold-deploy-acceptance-script.md)
- [Auth Entry Pages - Login and Invite Acceptance with GitHub OAuth](./services/services/auth-entry-pages.md)
- [Web Session Middleware and Role-Based Authorization Middleware with Append-Only Audit Writer for Sensitive Reads](./services/services/web-session-role-auth.md)
- [F2 Merge Quality Metric Script](./services/services/f2-merge-quality-metric-script.md)
- [M1 why-moment end-to-end demo script](./services/services/m1-why-moment-demo-script.md)
- [mergeIntoConcept – F2 Persistence Layer for Concept Merges](./services/services/merge-into-concept.md)
- [F1 Signal-to-Noise Metric Script](./services/services/f1-signal-to-noise-metric-script.md)
- [MCP Search Tool Implementation & Recall Candidates Service](./services/services/mcp-search-tool.md)
- [memory_write Tool](./services/services/memory-write-tool.md)
- [EmbeddingClient Service for Text-to-Vector Generation](./services/services/embedding-client.md)
- [MCP Streamable HTTP Endpoint](./services/services/mcp-streamable-http-endpoint.md)
- [Events API](./services/services/events-api.md)
- [GitHub Connector with Smoke Test Integration and Pull Request Webhook Normalizer](./services/services/github-connector.md)
- [toConcept Mapper](./services/services/to-concept-mapper.md)
- [GitHub App API Client](./services/services/github-app-api-client.md)
- [Job Repository and enqueueCompilation Service](./services/services/job-repository.md)
- [Concept Page Persistence Repository](./services/services/concept-page-persistence-repository.md)
- [Idempotent Event Repository](./services/services/idempotent-event-repository.md)
- [Principal Upsert Repository](./services/services/upsert-principal-repository.md)
- [Server and Worker Process Entry Points and Hono HTTP Runtime Decision](./services/services/server-worker-entry-points.md)

## concepts

- [OKF Bundle Markdown Renderer Service](./concepts/concepts/okf-bundle-format-contract.md)
- [F2 Merge-Decision Structured Output Contract](./concepts/concepts/f2-merge-decision-structured-output-contract.md)
