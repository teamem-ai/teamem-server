/**
 * Bootstrap command (DUA-175 / M0-DATA-02).
 *
 * Idempotently creates a team, project, optional service principal, and an
 * M0 API key with explicit data-plane scopes. The plaintext token is printed
 * exactly once (on creation or rotation); only the SHA-256 hash is persisted.
 *
 * Idempotency: existing entities are matched by name within tenant scope and
 * reused — the command never silently creates a second team/project/key.
 *
 * Security:
 * - Tokens are 256-bit random, prefixed `tm_`, hashed with SHA-256.
 * - Plaintext is printed to stdout exactly once; never logged, stored, or
 *   included in error messages.
 * - The `--rotate` flag revokes the old key and mints a new one, printing
 *   the new token.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @teamem/server bootstrap -- \
 *     --team-name M0 --project-name demo [--principal-name my-service] [--rotate]
 */
import { randomUUID } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { createDb, closeDb, type AppDb } from '../db/client.js';
import * as schema from '../db/schema.js';
import { generateApiKeyToken, hashToken } from '../auth/api-key.js';
import { formatMcpAddCommand, type McpCommandConfig } from './format-mcp-command.js';
import { parseServerEnv } from '../config/env.js';
import type { ApiScope } from '@teamem/schema';

// ── Argument types ───────────────────────────────────────────────────────────

export interface BootstrapArgs {
  readonly teamName: string;
  readonly projectName: string;
  readonly principalName?: string;
  readonly rotate: boolean;
}

export interface BootstrapResult {
  readonly team: { id: string; name: string; action: 'created' | 'reused' };
  readonly project: { id: string; name: string; action: 'created' | 'reused' };
  readonly principal: {
    id: string;
    name: string;
    kind: 'service';
    action: 'created' | 'reused';
  } | null;
  readonly key: {
    id: string;
    name: string;
    scopes: readonly ApiScope[];
    allProjects: boolean;
    /** Present ONLY on creation or rotation; never persisted. */
    token?: string;
    action: 'created' | 'reused' | 'rotated';
    /**
     * Pasteable `claude mcp add` command (DUA-211).
     *
     * Present ONLY when `token` is present. Contains the plaintext token —
     * the caller must print it exactly once and NEVER log or persist it.
     */
    mcpAddCommand?: string;
  };
}

// ── CLI argument parsing ─────────────────────────────────────────────────────

/**
 * Parse bootstrap arguments from process.argv.
 *
 * Expected form:
 *   node dist/index.js --bootstrap --team-name <name> --project-name <name>
 *     [--principal-name <name>] [--rotate]
 */
export function parseBootstrapArgs(argv: string[] = process.argv): BootstrapArgs {
  const args = argv.slice(2); // skip node + script path

  const bootstrapIdx = args.indexOf('--bootstrap');
  if (bootstrapIdx === -1) {
    throw new Error(
      'not a bootstrap invocation — --bootstrap flag missing',
    );
  }

  // Collect the arguments that follow --bootstrap
  const relevant = args.slice(bootstrapIdx + 1);

  const getFlag = (flag: string): boolean => {
    const idx = relevant.indexOf(flag);
    if (idx !== -1) {
      // Remove the flag so it isn't consumed as a value
      relevant.splice(idx, 1);
      return true;
    }
    return false;
  };

  const getValue = (flag: string): string | undefined => {
    const idx = relevant.indexOf(flag);
    if (idx !== -1 && idx + 1 < relevant.length) {
      const value = relevant[idx + 1]!;
      // Remove flag + value
      relevant.splice(idx, 2);
      return value;
    }
    return undefined;
  };

  const teamName = getValue('--team-name');
  const projectName = getValue('--project-name');
  const principalName = getValue('--principal-name');
  const rotate = getFlag('--rotate');

  if (!teamName) {
    throw new Error('--team-name is required');
  }
  if (!projectName) {
    throw new Error('--project-name is required');
  }

  return { teamName, projectName, principalName, rotate };
}

// ── ID generation ────────────────────────────────────────────────────────────

function freshTeamId(): string {
  return `team_${randomUUID().replace(/-/g, '')}`;
}

function freshProjectId(): string {
  return `prj_${randomUUID().replace(/-/g, '')}`;
}

function freshPrincipalId(): string {
  return `pri_${randomUUID().replace(/-/g, '')}`;
}

function freshKeyId(): string {
  return `key_${randomUUID().replace(/-/g, '')}`;
}

/** Stable bootstrap principal providerUserId — derived from the name. */
function bootstrapProviderUserId(name: string): string {
  return `bootstrap:${name}`;
}

const BOOTSTRAP_KEY_NAME = 'M0 Bootstrap Key';
const BOOTSTRAP_PROVIDER_KIND = 'teamem';

// ── Core bootstrap logic ─────────────────────────────────────────────────────

/**
 * Run the bootstrap operation. Connects to the database, creates or reuses
 * entities, and returns the result. The caller is responsible for printing
 * the result (and the one-time token) and closing the database.
 */
export async function runBootstrap(
  db: AppDb,
  args: BootstrapArgs,
  /** Server host/port for the pasteable MCP command (DUA-211). */
  mcpConfig?: McpCommandConfig,
): Promise<BootstrapResult> {
  // --- Team (idempotent by name) ---
  const teamResult = await ensureTeam(db, args.teamName);

  // --- Project (idempotent by team_id + name) ---
  const projectResult = await ensureProject(db, teamResult.id, args.projectName);

  // --- Principal (optional, idempotent by team_id + provider identity) ---
  let principalResult: BootstrapResult['principal'] = null;
  if (args.principalName) {
    principalResult = await ensurePrincipal(
      db,
      teamResult.id,
      args.principalName,
    );
  }

  // --- API Key ---
  const keyResult = await ensureBootstrapKey(
    db,
    teamResult.id,
    projectResult.id,
    principalResult?.id ?? null,
    args.rotate,
    mcpConfig,
  );

  return {
    team: teamResult,
    project: projectResult,
    principal: principalResult,
    key: keyResult,
  };
}

// ── Entity helpers ───────────────────────────────────────────────────────────

interface EntityResult<T extends string = string> {
  id: string;
  name: T;
  action: 'created' | 'reused';
}

async function ensureTeam(
  db: AppDb,
  name: string,
): Promise<EntityResult> {
  const existing = await db
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(eq(schema.teams.name, name))
    .limit(1);

  if (existing[0]) {
    return { id: existing[0].id, name, action: 'reused' };
  }

  const id = freshTeamId();
  await db.insert(schema.teams).values({ id, name });
  return { id, name, action: 'created' };
}

async function ensureProject(
  db: AppDb,
  teamId: string,
  name: string,
): Promise<EntityResult> {
  const existing = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.teamId, teamId),
        eq(schema.projects.name, name),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return { id: existing[0].id, name, action: 'reused' };
  }

  const id = freshProjectId();
  await db.insert(schema.projects).values({ id, teamId, name });
  return { id, name, action: 'created' };
}

async function ensurePrincipal(
  db: AppDb,
  teamId: string,
  name: string,
): Promise<NonNullable<BootstrapResult['principal']>> {
  const providerUserId = bootstrapProviderUserId(name);

  // Use the existing findPrincipal pattern from the principals repository,
  // but inline to avoid a circular dependency on the full repository module.
  const existing = await db
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.teamId, teamId),
        eq(schema.principals.provider, 'external'), // teamem → external bucket
        eq(schema.principals.providerKind, BOOTSTRAP_PROVIDER_KIND),
        eq(schema.principals.providerUserId, providerUserId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return {
      id: existing[0].id,
      name,
      kind: 'service',
      action: 'reused',
    };
  }

  const id = freshPrincipalId();
  await db.insert(schema.principals).values({
    id,
    teamId,
    kind: 'service',
    provider: 'external',
    providerKind: BOOTSTRAP_PROVIDER_KIND,
    providerUserId,
    displayLogin: name,
  });

  return { id, name, kind: 'service', action: 'created' };
}

const M0_BOOTSTRAP_SCOPES: readonly ApiScope[] = [
  'read',
  'read:payload',
  'events:write',
];

async function ensureBootstrapKey(
  db: AppDb,
  teamId: string,
  projectId: string,
  principalId: string | null,
  rotate: boolean,
  /** Server host/port for the pasteable MCP command (DUA-211). */
  mcpConfig?: McpCommandConfig,
): Promise<BootstrapResult['key']> {
  // Look for an existing, non-revoked bootstrap key for this project
  const existing = await db
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      scopes: schema.apiKeys.scopes,
      allProjects: schema.apiKeys.allProjects,
    })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.teamId, teamId),
        eq(schema.apiKeys.projectId, projectId),
        eq(schema.apiKeys.name, BOOTSTRAP_KEY_NAME),
        isNull(schema.apiKeys.revokedAt),
      ),
    )
    .limit(1);

  if (existing[0] && !rotate) {
    // Key exists and we're not rotating — return metadata only, no token.
    return {
      id: existing[0].id,
      name: existing[0].name,
      scopes: existing[0].scopes as ApiScope[],
      allProjects: existing[0].allProjects,
      action: 'reused',
      // No token — plaintext was printed only on first creation and is not recoverable.
    };
  }

  // Revoke the existing key if rotating
  if (existing[0] && rotate) {
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, existing[0].id));
  }

  // Mint a new key
  const token = generateApiKeyToken();
  const tokenHash = hashToken(token);
  const keyId = freshKeyId();

  await db.insert(schema.apiKeys).values({
    id: keyId,
    teamId,
    projectId,
    principalId,
    name: BOOTSTRAP_KEY_NAME,
    tokenHash,
    scopes: [...M0_BOOTSTRAP_SCOPES] as string[],
    allProjects: false,
  });

  // Build the pasteable claude mcp add command (DUA-211).
  // Host/port come from the validated server config, threaded through
  // runBootstrap so we never re-parse raw process.env.
  const mcpAddCommand = mcpConfig
    ? formatMcpAddCommand(mcpConfig, token)
    : undefined;

  return {
    id: keyId,
    name: BOOTSTRAP_KEY_NAME,
    scopes: M0_BOOTSTRAP_SCOPES,
    allProjects: false,
    token, // <-- THE ONLY PLACE the plaintext token exists
    mcpAddCommand, // <-- pasteable command (DUA-211)
    action: rotate ? 'rotated' : 'created',
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/**
 * Parse args, run bootstrap, print JSON, and exit.
 *
 * This is the function invoked when the process is started with --bootstrap.
 * It handles its own database lifecycle and exits the process on completion
 * or failure.
 */
export async function bootstrapMain(args?: BootstrapArgs): Promise<void> {
  const databaseUrl = process.env['TEAMEM_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL or TEAMEM_DATABASE_URL is required');
    process.exit(1);
  }

  let parsedArgs: BootstrapArgs;
  try {
    parsedArgs = args ?? parseBootstrapArgs();
  } catch (err) {
    console.error(
      'bootstrap:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  const db = createDb(databaseUrl);

  try {
    // Verify connectivity
    await db.$client.query('SELECT 1');

    // Read validated server host/port for the pasteable MCP command (DUA-211).
    // Uses the same Zod-validated parser the server itself uses — no
    // hand-rolled Number() or duplicate validation.
    const { host, port } = parseServerEnv();
    const mcpConfig = { host, port };

    const result = await runBootstrap(db, parsedArgs, mcpConfig);

    // Print the result as JSON. The token (if present) is printed exactly once here.
    // SECURITY: do NOT log this output — it contains a plaintext token.
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');

    await closeDb(db);
    process.exit(0);
  } catch (err) {
    // SECURITY: never include the plaintext token in error output.
    const message = err instanceof Error ? err.message : String(err);
    console.error('bootstrap failed:', message);
    try {
      await closeDb(db);
    } catch {
      // Best-effort close
    }
    process.exit(1);
  }
}
