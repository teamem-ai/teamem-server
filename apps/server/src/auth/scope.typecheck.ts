/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Compile-time type-safety assertions for ScopeContext.
 *
 * This file is NOT a test suite — it is only checked by `tsc --noEmit`.
 * Each @ts-expect-error line must be followed by exactly ONE line that must
 * NOT compile. If the annotated line compiles successfully, tsc will error
 * ("Unused '@ts-expect-error' directive"), which is the desired behavior:
 * it proves the type system is no longer rejecting the illegal pattern.
 *
 * Run: pnpm typecheck (from repo root or apps/server)
 */
import {
  projectScope,
  allProjectsScope,
  getProjectId,
  type ScopeContext,
} from './scope.js';

declare const scope: ScopeContext;

// ── Assertion 1: AllProjectsScope has no 'projectId' property ─────────────────
// Accessing .projectId on an all-projects scope must be a compile error.
// @ts-expect-error — AllProjectsScope has no 'projectId' property
allProjectsScope('team_x').projectId;

// ── Assertion 2: getProjectId rejects ScopeContext that might be allProjects ──
// Passing a ScopeContext (union) to getProjectId must fail — the caller must
// narrow to ProjectScope first.
// @ts-expect-error — ScopeContext is not assignable to ProjectScope
getProjectId(scope);

// ── Assertion 3: narrowed ProjectScope compiles fine ───────────────────────────
// This is the positive case — proving getProjectId works after narrowing.
const projectScopeValue = projectScope('team_x', 'prj_y');
const _legalProjectId: string = getProjectId(projectScopeValue);
