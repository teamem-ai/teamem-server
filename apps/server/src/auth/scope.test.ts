/**
 * ScopeContext tests — success paths, validation failures, narrowing,
 * and boundary isolation for the tagged discriminated union.
 */
import { describe, expect, it } from 'vitest';
import {
  projectScope,
  allProjectsScope,
  isProjectScope,
  isAllProjectsScope,
  getTeamId,
  getProjectId,
  type ScopeContext,
} from './scope.js';

const TEAM = 'team_alice123';
const PROJECT = 'prj_demo456';

// ── Construction ──────────────────────────────────────────────────────────────

describe('projectScope', () => {
  it('creates a project scope with correct kind and IDs', () => {
    const scope = projectScope(TEAM, PROJECT);
    expect(scope).toEqual({ kind: 'project', teamId: TEAM, projectId: PROJECT });
  });

  it('kind is "project"', () => {
    expect(projectScope(TEAM, PROJECT).kind).toBe('project');
  });
});

describe('allProjectsScope', () => {
  it('creates an all-projects scope with correct kind and teamId', () => {
    const scope = allProjectsScope(TEAM);
    expect(scope).toEqual({ kind: 'allProjects', teamId: TEAM });
  });

  it('does not carry a projectId property', () => {
    expect('projectId' in allProjectsScope(TEAM)).toBe(false);
  });
});

// ── Narrowing ─────────────────────────────────────────────────────────────────

describe('isProjectScope', () => {
  it('narrows a ProjectScope correctly', () => {
    const scope: ScopeContext = projectScope(TEAM, PROJECT);
    expect(isProjectScope(scope)).toBe(true);
  });

  it('narrows an AllProjectsScope to false', () => {
    const scope: ScopeContext = allProjectsScope(TEAM);
    expect(isProjectScope(scope)).toBe(false);
  });
});

describe('isAllProjectsScope', () => {
  it('narrows an AllProjectsScope correctly', () => {
    const scope: ScopeContext = allProjectsScope(TEAM);
    expect(isAllProjectsScope(scope)).toBe(true);
  });

  it('narrows a ProjectScope to false', () => {
    const scope: ScopeContext = projectScope(TEAM, PROJECT);
    expect(isAllProjectsScope(scope)).toBe(false);
  });
});

// ── Exhaustive match ──────────────────────────────────────────────────────────

describe('exhaustive discrimination', () => {
  function scopeLabel(scope: ScopeContext): string {
    switch (scope.kind) {
      case 'project':
        return `project:${scope.projectId}`;
      case 'allProjects':
        return 'allProjects';
    }
  }

  it('labels a project scope with its projectId', () => {
    expect(scopeLabel(projectScope(TEAM, PROJECT))).toBe(`project:${PROJECT}`);
  });

  it('labels an all-projects scope without a projectId', () => {
    expect(scopeLabel(allProjectsScope(TEAM))).toBe('allProjects');
  });
});

// ── Team identity preservation ────────────────────────────────────────────────

describe('getTeamId', () => {
  it('returns teamId from a project scope', () => {
    expect(getTeamId(projectScope(TEAM, PROJECT))).toBe(TEAM);
  });

  it('returns teamId from an all-projects scope', () => {
    expect(getTeamId(allProjectsScope(TEAM))).toBe(TEAM);
  });
});

describe('getProjectId', () => {
  it('returns projectId from a project scope', () => {
    expect(getProjectId(projectScope(TEAM, PROJECT))).toBe(PROJECT);
  });

  it('accepts a narrowed ProjectScope from a ScopeContext', () => {
    const scope: ScopeContext = projectScope(TEAM, PROJECT);
    if (isProjectScope(scope)) {
      expect(getProjectId(scope)).toBe(PROJECT);
    }
  });
});

// ── Zod validation failures ───────────────────────────────────────────────────

describe('projectScope validation', () => {
  it('rejects empty teamId', () => {
    expect(() => projectScope('', PROJECT)).toThrow();
  });

  it('rejects teamId without prefix', () => {
    expect(() => projectScope('alice', PROJECT)).toThrow();
  });

  it('rejects teamId with invalid characters', () => {
    expect(() => projectScope('team_a-l-i-c-e', PROJECT)).toThrow();
  });

  it('rejects empty projectId', () => {
    expect(() => projectScope(TEAM, '')).toThrow();
  });

  it('rejects projectId without prefix', () => {
    expect(() => projectScope(TEAM, 'demo')).toThrow();
  });

  it('rejects projectId with invalid characters', () => {
    expect(() => projectScope(TEAM, 'prj_d e m o')).toThrow();
  });
});

describe('allProjectsScope validation', () => {
  it('rejects empty teamId', () => {
    expect(() => allProjectsScope('')).toThrow();
  });

  it('rejects teamId without prefix', () => {
    expect(() => allProjectsScope('alice')).toThrow();
  });

  it('rejects teamId with invalid characters', () => {
    expect(() => allProjectsScope('team_x!')).toThrow();
  });
});

// ── Scope isolation ───────────────────────────────────────────────────────────

describe('scope isolation', () => {
  it('two scopes for different teams are distinct', () => {
    const a = allProjectsScope('team_alice');
    const b = allProjectsScope('team_bob');
    expect(getTeamId(a)).not.toBe(getTeamId(b));
  });

  it('project scope and all-projects scope for the same team carry the same teamId', () => {
    const p = projectScope(TEAM, PROJECT);
    const a = allProjectsScope(TEAM);
    expect(getTeamId(p)).toBe(getTeamId(a));
  });
});
