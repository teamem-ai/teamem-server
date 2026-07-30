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
import type { AppDb } from '../../db/client.js';
import { formatMcpAddCommand, type McpCommandConfig } from '../../commands/format-mcp-command.js';
import { generateApiKeyToken, hashToken } from '../../auth/api-key.js';
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
  type KeyEntry,
  type RevokeKeyResponse,
  type RotateKeyResponse,
} from '@teamem/schema';
import { validateApiKeyScopes } from '../../db/repositories/api-keys.js';

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

  // ── GET /v1/teams/:teamId/keys ────────────────────────────────────────
  // List all API keys in the team. Requires admin+ role.
  routes.get('/v1/teams/:teamId/keys', requireRole('admin'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;

    try {
      const result = await db.$client.query(
        `SELECT ak.id, ak.name, ak.scopes, ak.all_projects, ak.project_id,
                ak.created_at, ak.last_used_at, ak.revoked_at,
                p.name AS project_name
         FROM api_keys ak
         LEFT JOIN projects p ON p.id = ak.project_id AND p.team_id = ak.team_id
         WHERE ak.team_id = $1
         ORDER BY ak.created_at DESC`,
        [teamId],
      );

      const keys: KeyEntry[] = result.rows.map((row) => ({
        id: row['id'] as string,
        name: row['name'] as string,
        scopes: row['scopes'] as ApiScope[],
        allProjects: row['all_projects'] as boolean,
        projectId: (row['project_id'] as string) ?? null,
        projectName: (row['project_name'] as string) ?? null,
        createdAt: (row['created_at'] as Date).toISOString(),
        lastUsedAt: row['last_used_at'] ? (row['last_used_at'] as Date).toISOString() : null,
        revoked: row['revoked_at'] !== null,
        revokedAt: row['revoked_at'] ? (row['revoked_at'] as Date).toISOString() : null,
      }));

      return c.json({ requestId, data: keys });
    } catch (err) {
      throw new InternalError('Failed to list API keys', { cause: err });
    }
  });

  // ── POST /v1/teams/:teamId/keys/:keyId/revoke ────────────────────────
  // Revoke an API key. Requires admin+ role.
  routes.post('/v1/teams/:teamId/keys/:keyId/revoke', requireRole('admin'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;
    const keyId = c.req.param('keyId');

    if (!keyId) {
      throw new InvalidRequestError('Missing keyId parameter');
    }

    try {
      const result = await db.$client.query(
        `UPDATE api_keys SET revoked_at = NOW()
         WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL
         RETURNING id, revoked_at`,
        [keyId, teamId],
      );

      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError();
      }

      const response: RevokeKeyResponse = {
        id: row['id'] as string,
        revoked: true,
        revokedAt: (row['revoked_at'] as Date).toISOString(),
      };

      console.info(
        JSON.stringify({
          event: 'api_key_revoked',
          requestId,
          keyId,
          teamId,
          revokedByUserId: ws.userId,
        }),
      );

      return c.json({ requestId, data: response });
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new InternalError('Failed to revoke API key', { cause: err });
    }
  });

  // ── POST /v1/teams/:teamId/keys/:keyId/rotate ────────────────────────
  // Rotate: mint a new key and revoke the old one simultaneously.
  // Requires admin+ role.
  routes.post('/v1/teams/:teamId/keys/:keyId/rotate', requireRole('admin'), async (c: Context) => {
    const requestId = c.get(REQUEST_ID_KEY) as string;
    const ws = getWebSession(c);
    const teamId = ws.scope.teamId;
    const oldKeyId = c.req.param('keyId');

    if (!oldKeyId) {
      throw new InvalidRequestError('Missing keyId parameter');
    }

    try {
      // Fetch the old key details first
      const oldKeyResult = await db.$client.query(
        `SELECT id, name, scopes, all_projects, project_id, revoked_at
         FROM api_keys
         WHERE id = $1 AND team_id = $2
         LIMIT 1`,
        [oldKeyId, teamId],
      );

      const oldKey = oldKeyResult.rows[0];
      if (!oldKey) {
        throw new NotFoundError();
      }

      if (oldKey['revoked_at']) {
        throw new InvalidRequestError('Key is already revoked');
      }

      // Generate new key
      const plaintextToken = generateApiKeyToken();
      const tokenHash = hashToken(plaintextToken);
      const newKeyId = `key_${randomBytes(12).toString('hex')}`;
      const newName = `${oldKey['name'] as string} (rotated)`;
      const scopes = oldKey['scopes'] as ApiScope[];
      const allProjects = oldKey['all_projects'] as boolean;
      const projectId = oldKey['project_id'] as string | null;

      await db.$client.query('BEGIN');
      try {
        // Revoke old key
        await db.$client.query(
          `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND team_id = $2`,
          [oldKeyId, teamId],
        );

        // Mint new key
        await db.$client.query(
          `INSERT INTO api_keys (id, team_id, project_id, name, token_hash, scopes, all_projects)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newKeyId, teamId, projectId, newName, tokenHash, scopes, allProjects],
        );

        await db.$client.query('COMMIT');
      } catch (err) {
        await db.$client.query('ROLLBACK');
        throw err;
      }

      let mcpCommand = '';
      if (mcpConfig) {
        mcpCommand = formatMcpAddCommand(mcpConfig, plaintextToken);
      }

      const response: RotateKeyResponse = {
        id: newKeyId,
        name: newName,
        token: plaintextToken,
        mcpCommand,
        scopes,
        allProjects,
        projectId,
        createdAt: new Date().toISOString(),
        revokedKeyId: oldKeyId,
      };

      console.info(
        JSON.stringify({
          event: 'api_key_rotated',
          requestId,
          oldKeyId,
          newKeyId,
          teamId,
          rotatedByUserId: ws.userId,
        }),
      );

      return c.json({ requestId, data: response }, 201);
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof InvalidRequestError) throw err;
      throw new InternalError('Failed to rotate API key', { cause: err });
    }
  });

  return routes;
}
