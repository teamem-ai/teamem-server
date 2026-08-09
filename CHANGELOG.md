# Changelog

All notable changes to Teamem will be documented in this file.

The format follows Keep a Changelog, and releases use Semantic Versioning.

## [Unreleased]

### Added

- Initial repository, frozen v0.2 contracts, database schema, and M0 architecture groundwork.
- Job retry distinguishes **Retry failed** (re-run only the failed events) from **Retry all**, mirroring CI re-run semantics; failed events are re-run without redoing already compiled/skipped ones.
- Jobs that finish with a mix of compiled and failed events show a distinct **Completed with errors** status instead of a plain **Completed**.

### Fixed

- Compile jobs left stuck in `processing` after a worker restart are now auto-reclaimed to `failed` on worker startup, so they can be retried instead of blocking retry indefinitely.
- LLM structured-output parsing recovers output that a weaker OpenAI-compatible model wrapped in prose or a Markdown code fence, or mis-encoded (raw control characters, under-escaped backslashes) — reducing spurious `schema_validation_failed` compile failures. An unescaped inner double-quote remains an honest failure rather than risk fabricating content.
- Output cut off by a model's token limit is reported as `output_truncated` instead of masquerading as `schema_validation_failed`, and the default output-token ceiling was raised.
- An LLM request that times out while streaming the response body is classified as `timeout` instead of a misleading `provider_error`.
- Concept detail page renders with its intended layout and typography (styles that were missing from the app were ported from the design system).

[Unreleased]: https://github.com/teamem-ai/teamem-server/compare/v0.0.0...HEAD

