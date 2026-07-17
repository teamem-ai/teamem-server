/**
 * Authorization vocabulary. (Contract v0.2 Appendix A — N6/N7.)
 */
import { z } from 'zod';

/**
 * API key scopes (N7 — deliberately four, no admin scope: purge, key
 * management and configuration changes belong to web-session roles).
 * Mint-time superset rule: `read:payload` requires `read` to also be
 * granted — a key with payload access but no list access cannot exist.
 */
export const apiScope = z.enum([
  'events:write',
  'read', // concepts/jobs/event-list summaries
  'read:payload', // raw (post-strip) payload detail — every read audited
  'audit:read',
]);
export type ApiScope = z.infer<typeof apiScope>;

/**
 * Web-session roles and their capability ladder (N6). Each level includes
 * everything below it:
 * - viewer: browse concepts/jobs lists
 * - member: + search/context, concept detail
 * - admin:  + key mint/revoke, source & LLM config, audit:read, payload detail
 * - owner:  + purge, role management, team deletion
 */
export const teamRole = z.enum(['viewer', 'member', 'admin', 'owner']);
export type TeamRole = z.infer<typeof teamRole>;
