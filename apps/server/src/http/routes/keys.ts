/**
 * Web-side API key minting route (DUA-230).
 *
 * POST /v1/teams/:teamId/keys — mint an API key via web session (admin+).
 *
 * The minted key has ONLY data-plane scopes. It can NEVER gain admin
 * capability — governance belongs to web-session roles exclusively.
 *
 * Security invariants:
 *   - The plaintext token is returned EXACTLY ONCE in the mint response.
 *     It is NEVER logged, NEVER stored (only SHA-256 hash in api_keys),
 *     and subsequent requests can NEVER retrieve it.
 *   - Key binding follows N6: normal keys bind a project; team-wide keys
 *     require explicit allProjects=true.
 *   - The N7 scope superset rule is enforced at the database level
 *     (CHECK constraint) and validated at the application layer.
 *   - Only admin+ can mint keys. member/viewer get 403.
 *   - The projectId, if provided, must belong to the same team (scoped
 *     query using team_id from the session).
 *   - Cross-team access returns 404 via requireTeamMembership middleware.
 */
import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { AppDb } from '../../db/client.js';
import { formatMcpAddCommand, type McpCommandConfig } from '../../commands/format-mcp-command.js';
import {
  requireWebSession,
  requireTeamMembership,
  getWebSession,
} from '../session.js';
import { requireRole } from '../../auth/rbac.js';
import {
  InvalidRequestError,
  NotFoundError,
  InternalError,
  REQUEST_ID_KEY,
} from '../errors.js';
import {
  mintKeyRequest as mintKeyRequestSchema,
  type MintKeyResponse,
  type ApiScope,
} from '@teamem/schema';
import { validateApiKeyScopes } from '../../db/repositories/api-keys.js';

// ── Token generation ────────────────────────────────────────────────────────

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'tm_';

function generateApiKeyToken(): string {
  const randomPart = randomBytes(TOKEN_BYTES)
    .toString('base64url')
    .replace(/=/g, '');
  return `${TOKEN_PREFIX}${randomPart}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface KeysDeps {
  db: AppDb;
  /** MCP command config for generating the pasteable command. */
  mcpConfig?: McpCommandConfig;
}

// ── Route builder ───────────────────────────────────────────────────────────

export function buildKeysRoutes(deps: KeysDeps): Hono {
  const { db, mcpConfig } = deps;
  const routes = new Hono();

  // ── Auth middleware stack — scoped to team-prefixed paths so :teamId ──
  // is captured and available to requireTeamMembership's c.req.param().
  routes.use('/v1/teams/:teamId/*', requireWebSession(db));
  routes.use('/v1/teams/:teamId/*', requireTeamMembership(db));

  // ── POST /v1/teams/:teamId/keys ────────────────────────────────────────
  // Mint a new API key. Requires admin+ role.
  routes.post('/v1/teams/:teamId/keys', requireRole('admin'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;

    // Parse and validate request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError('Request body is not valid JSON');
    }

    const parsed = mintKeyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidRequestError('Request body validation failed', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      } as unknown as Record<string, unknown>);
    }

    const req = parsed.data;

    // Validate scopes (defense-in-depth: DB CHECK constraint is primary)
    let validatedScopes: ApiScope[];
    try {
      validatedScopes = validateApiKeyScopes(req.scopes);
    } catch {
      throw new InvalidRequestError('Invalid scopes: read:payload requires read');
    }

    // If a projectId is specified, verify it belongs to this team
    let projectId: string | null = null;
    if (req.projectId) {
      const projectResult = await db.$client.query(
        `SELECT id FROM projects WHERE id = $1 AND team_id = $2 LIMIT 1`,
        [req.projectId, teamId],
      );
      if (projectResult.rows.length === 0) {
        // Project not found in this team — return 404 (same as genuinely
        // missing; does NOT reveal whether the project exists in another team)
        throw new NotFoundError();
      }
      projectId = req.projectId;
    }

    // Generate the API key token
    const plaintextToken = generateApiKeyToken();
    const tokenHash = hashToken(plaintextToken);
    const keyId = `key_${randomBytes(12).toString('hex')}`;

    // SECURITY: The plaintext token is NEVER logged and NEVER persisted.
    // Only the SHA-256 hash is stored.

    try {
      await db.$client.query(
        `INSERT INTO api_keys
         (id, team_id, project_id, name, token_hash, scopes, all_projects)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          keyId,
          teamId,
          projectId,
          req.name,
          tokenHash,
          validatedScopes,
          req.allProjects ?? false,
        ],
      );
    } catch (err) {
      throw new InternalError('Failed to create API key', { cause: err });
    }

    // Generate the pasteable claude mcp add command
    let mcpCommand = '';
    if (mcpConfig) {
      mcpCommand = formatMcpAddCommand(mcpConfig, plaintextToken);
    }

    const response: MintKeyResponse = {
      id: keyId,
      name: req.name,
      token: plaintextToken,
      mcpCommand,
      scopes: validatedScopes,
      allProjects: req.allProjects ?? false,
      projectId,
      createdAt: new Date().toISOString(),
    };

    // Log the key minting event (no token — only keyId for audit)
    console.info(
      JSON.stringify({
        event: 'api_key_minted',
        requestId,
        keyId,
        teamId,
        projectId,
        allProjects: req.allProjects ?? false,
        scopes: validatedScopes,
        mintedByUserId: ws.userId,
      }),
    );

    return c.json({ requestId, data: response }, 201);
  });

  return routes;
}
