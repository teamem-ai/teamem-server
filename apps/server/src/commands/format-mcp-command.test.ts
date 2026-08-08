/**
 * Unit tests for MCP `claude mcp add` command formatter (DUA-211 / M1-MCP-06).
 *
 * Covers:
 *  - Correctly formatted command with baseUrl + token
 *  - Custom domain and reverse-proxy (no explicit port) base URLs
 *  - Non-standard ports preserved
 *  - Bearer token embedded exactly once in the command
 */

import { describe, expect, it } from 'vitest';
import { formatMcpAddCommand } from './format-mcp-command.js';

const FAKE_TOKEN = 'tm_test-token-0123456789abcdef0123456789abcdef';

describe('formatMcpAddCommand', () => {
  it('generates a correctly formatted command from a baseUrl and token', () => {
    const cmd = formatMcpAddCommand({ baseUrl: 'http://example.com:8080' }, FAKE_TOKEN);

    expect(cmd).toBe(
      `claude mcp add --transport http teamem http://example.com:8080/mcp --header "Authorization: Bearer ${FAKE_TOKEN}"`,
    );
    // Token appears exactly once
    const tokenOccurrences = cmd.split(FAKE_TOKEN).length - 1;
    expect(tokenOccurrences).toBe(1);
  });

  it('uses localhost when baseUrl is the default', () => {
    const cmd = formatMcpAddCommand({ baseUrl: 'http://localhost:8080' }, FAKE_TOKEN);

    expect(cmd).toContain('http://localhost:8080/mcp');
  });

  it('preserves a custom domain as-is', () => {
    const cmd = formatMcpAddCommand({ baseUrl: 'http://teamem.internal.example:3000' }, FAKE_TOKEN);

    expect(cmd).toContain('http://teamem.internal.example:3000/mcp');
  });

  it('carries https and omits the port for a reverse-proxy deployment on 443', () => {
    const cmd = formatMcpAddCommand({ baseUrl: 'https://team.liduan.net' }, FAKE_TOKEN);

    expect(cmd).toContain('https://team.liduan.net/mcp');
    expect(cmd).not.toContain(':443');
  });

  it('includes the Bearer token in the Authorization header', () => {
    const cmd = formatMcpAddCommand({ baseUrl: 'http://localhost:8080' }, FAKE_TOKEN);

    expect(cmd).toContain(`--header "Authorization: Bearer ${FAKE_TOKEN}"`);
  });

  it('works with non-standard ports', () => {
    const cmd = formatMcpAddCommand({ baseUrl: 'http://host:9443' }, FAKE_TOKEN);

    expect(cmd).toContain(':9443/mcp');
  });
});
