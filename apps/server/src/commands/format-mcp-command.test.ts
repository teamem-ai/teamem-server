/**
 * Unit tests for MCP `claude mcp add` command formatter (DUA-211 / M1-MCP-06).
 *
 * Covers:
 *  - Correctly formatted command with host + port + token
 *  - 0.0.0.0 → localhost substitution
 *  - Custom host preserved as-is
 *  - Bearer token embedded exactly once in the command
 */

import { describe, expect, it } from 'vitest';
import { formatMcpAddCommand } from './format-mcp-command.js';

const FAKE_TOKEN = 'tm_test-token-0123456789abcdef0123456789abcdef';

describe('formatMcpAddCommand', () => {
  it('generates a correctly formatted command with host, port, and token', () => {
    const cmd = formatMcpAddCommand(
      { host: 'example.com', port: 8080 },
      FAKE_TOKEN,
    );

    expect(cmd).toBe(
      `claude mcp add --transport http teamem http://example.com:8080/mcp --header "Authorization: Bearer ${FAKE_TOKEN}"`,
    );
    // Token appears exactly once
    const tokenOccurrences = cmd.split(FAKE_TOKEN).length - 1;
    expect(tokenOccurrences).toBe(1);
  });

  it('substitutes localhost for 0.0.0.0', () => {
    const cmd = formatMcpAddCommand(
      { host: '0.0.0.0', port: 8080 },
      FAKE_TOKEN,
    );

    expect(cmd).toContain('http://localhost:8080/mcp');
    expect(cmd).not.toContain('0.0.0.0');
  });

  it('preserves a custom host as-is', () => {
    const cmd = formatMcpAddCommand(
      { host: 'teamem.internal.example', port: 3000 },
      FAKE_TOKEN,
    );

    expect(cmd).toContain('http://teamem.internal.example:3000/mcp');
  });

  it('includes the Bearer token in the Authorization header', () => {
    const cmd = formatMcpAddCommand(
      { host: 'localhost', port: 8080 },
      FAKE_TOKEN,
    );

    expect(cmd).toContain(`--header "Authorization: Bearer ${FAKE_TOKEN}"`);
  });

  it('works with non-standard ports', () => {
    const cmd = formatMcpAddCommand(
      { host: 'host', port: 9443 },
      FAKE_TOKEN,
    );

    expect(cmd).toContain(':9443/mcp');
  });
});
