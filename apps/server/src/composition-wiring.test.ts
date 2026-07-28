/**
 * Composition-root wiring (regression).
 *
 * The embedding client was created in `createRuntimeStartup` and handed only
 * to the compile worker; `startServer` was called without it. Every real
 * deployment therefore wrote embeddings during compilation and then served
 * `POST /v1/search` and every MCP tool in permanent `fts-only` mode, however
 * the provider was configured. Nothing caught it because `AppDeps` already
 * accepted an optional `embeddingClient` and `app.ts` already wired it
 * through — only the call site omitted it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./index.ts', import.meta.url)),
  'utf8',
);

describe('createRuntimeStartup — HTTP surface receives the embedding client', () => {
  it('passes embeddingClient to startServer, not only to the worker', () => {
    // Read the composition root rather than booting it: the defect is a
    // missing property at one call site, and asserting it here needs neither a
    // database nor a provider key.
    const call = /startServer\(\s*undefined,\s*\{([\s\S]*?)\}\s*\)/.exec(source);
    expect(call, 'startServer(undefined, { ... }) call not found').not.toBeNull();
    expect(call![1]).toContain('embeddingClient');
  });

  it('creates the embedding client from the same provider as the LLM client', () => {
    // A second provider resolution here would let search and compilation
    // disagree about which provider is in use.
    expect(source).toContain('createEmbeddingClient(llmProvider)');
  });
});
