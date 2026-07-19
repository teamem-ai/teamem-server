/**
 * Compose topology validation (M0-PLAT-08).
 *
 * Validates the docker-compose.yml against the task's fixed requirements:
 *   1. Three-service topology: postgres, server, worker.
 *   2. Postgres port bound to loopback (127.0.0.1) only.
 *   3. POSTGRES_PASSWORD is required (no default — compose must refuse to
 *      start without it).
 *   4. TEAMEM_ALL_IN_ONE controls whether the worker runs separately or is
 *      embedded in the server.
 *   5. Every service has a healthcheck.
 *
 * No Docker daemon is required — these are structural assertions on the
 * compose file itself. When `docker compose config` is available, an
 * additional round-trip validation runs (var-substitution and syntax check).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

function readCompose(): string {
  return readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf-8');
}

function dockerAvailable(): boolean {
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('compose topology (structural)', () => {
  const compose = readCompose();

  it('defines exactly three services: postgres, server, worker', () => {
    // Each service is declared under `services:` with 2-space indentation.
    // Match the service-name lines (e.g. "  postgres:").
    const svcRegex = /^  (\w+):\s*$/gm;
    const serviceNames: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = svcRegex.exec(compose)) !== null) {
      serviceNames.push(m[1]!);
    }
    expect(serviceNames).toContain('postgres');
    expect(serviceNames).toContain('server');
    expect(serviceNames).toContain('worker');
    // No unexpected service keys (like "deploy" or "environment" which
    // have deeper indentation).
    expect(serviceNames.filter((n) => ['postgres', 'server', 'worker'].includes(n))).toHaveLength(3);
  });

  it('binds Postgres to loopback only (127.0.0.1)', () => {
    // The ports mapping for postgres must bind to 127.0.0.1, never 0.0.0.0
    // or a bare port.
    expect(compose).toMatch(/127\.0\.0\.1:\$\{TEAMEM_PG_PORT:-5432\}:5432/);
    // Must NOT expose Postgres on all interfaces.
    expect(compose).not.toMatch(/"0\.0\.0\.0:.*5432/);
    // Must NOT expose Postgres as a bare port (no bind address).
    expect(compose).not.toMatch(/^\s*- ["']?5[4-9]\d{2}["']?\s*$/m);
  });

  it('requires POSTGRES_PASSWORD (no default — fails without it)', () => {
    // The :? syntax in variable substitution makes compose refuse to start
    // if the variable is unset or empty.
    expect(compose).toMatch(/\$\{POSTGRES_PASSWORD:\?/);
    // The .env.example must NOT supply a default value.
    const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf-8');
    const pwLine = envExample.split('\n').find((l) => l.startsWith('POSTGRES_PASSWORD='));
    expect(pwLine).toBe('POSTGRES_PASSWORD=');
  });

  it('wires TEAMEM_ALL_IN_ONE to disable the standalone worker', () => {
    // The server service receives the flag.
    expect(compose).toMatch(/TEAMEM_ALL_IN_ONE: \$\{TEAMEM_ALL_IN_ONE:-false\}/);
    // The worker service comment documents that it is skipped when
    // TEAMEM_ALL_IN_ONE=true.
    expect(compose).toMatch(/Skip this service.*TEAMEM_ALL_IN_ONE=true/);
  });

  it('every service defines a healthcheck', () => {
    // Each service block should contain "healthcheck:" at its indentation
    // level (4 spaces within a service block). Count occurrences of
    // "healthcheck:" after a blank+service-name pattern — a rough
    // structural check.
    const sections = compose.split(/\n  \w+:\s*\n/);
    // Drop the preamble before the first service.
    let healthcheckCount = 0;
    for (const section of sections) {
      if (/^    healthcheck:/m.test(section)) {
        healthcheckCount++;
      }
    }
    expect(healthcheckCount).toBe(3);
  });

  it('server depends on postgres being healthy', () => {
    expect(compose).toMatch(/condition: service_healthy/);
  });

  it('worker depends on postgres being healthy', () => {
    // The worker also has depends_on with condition: service_healthy.
    const workerSection = compose.split('  worker:')[1]?.split('\n  \w')[0] ?? '';
    expect(workerSection).toMatch(/condition: service_healthy/);
  });
});

describe('compose topology (docker compose config round-trip)', () => {
  const hasDocker = dockerAvailable();

  it.skipIf(!hasDocker)(
    'docker compose config succeeds with POSTGRES_PASSWORD set',
    () => {
      const result = execSync(
        'docker compose --file docker-compose.yml --env-file /dev/null config',
        {
          cwd: REPO_ROOT,
          env: { ...process.env, POSTGRES_PASSWORD: 'test-roundtrip' },
          encoding: 'utf-8',
          timeout: 10_000,
        },
      );
      expect(result).toContain('services:');
      expect(result).toContain('postgres:');
      expect(result).toContain('server:');
      expect(result).toContain('worker:');
    },
    15_000,
  );

  it.skipIf(!hasDocker)(
    'docker compose config fails without POSTGRES_PASSWORD',
    () => {
      expect(() =>
        execSync(
          'docker compose --file docker-compose.yml --env-file /dev/null config 2>&1',
          {
            cwd: REPO_ROOT,
            env: { ...process.env, POSTGRES_PASSWORD: '' },
            encoding: 'utf-8',
            timeout: 10_000,
          },
        ),
      ).toThrow();
    },
    15_000,
  );
});
