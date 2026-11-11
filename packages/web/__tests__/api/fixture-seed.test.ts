import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '@tekon/core';

import { seedMinimalRun, type WebFixtureProject } from '../fixtures/project.js';

let fixture: WebFixtureProject | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

async function readSeeded(projectRoot: string) {
  const db = openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
  migrateDatabase(db);
  const repositories = createRepositories(db);
  try {
    return {
      runs: [
        await repositories.getWorkflowInstance('run_0'),
        await repositories.getWorkflowInstance('run_1'),
      ],
      gates: await repositories.listGateResults('run_1'),
      decisions: await repositories.listHumanDecisions('run_1'),
      audit: await repositories.listAuditEvents('run_1'),
    };
  } finally {
    db.close();
  }
}

describe('seedMinimalRun', () => {
  it('omits gate, delivery and audit data when those options are off', async () => {
    fixture = await seedMinimalRun({
      withGates: false,
      withDelivery: false,
      withAudit: false,
    });
    const runDir = join(fixture.projectRoot, '.tekon', 'runs', 'run_1');
    expect(existsSync(join(runDir, 'gates'))).toBe(false);
    expect(existsSync(join(runDir, 'delivery'))).toBe(false);

    const seeded = await readSeeded(fixture.projectRoot);
    expect(seeded.runs.map((run) => run?.id)).toEqual(['run_0', 'run_1']);
    expect(seeded.gates).toEqual([]);
    expect(seeded.decisions).toEqual([]);
    expect(seeded.audit).toEqual([]);
  });

  it('writes the full dataset by default', async () => {
    fixture = await seedMinimalRun();
    const runDir = join(fixture.projectRoot, '.tekon', 'runs', 'run_1');
    expect(existsSync(join(runDir, 'gates', 'human.txt'))).toBe(true);
    expect(existsSync(join(runDir, 'delivery', 'pr-body.md'))).toBe(true);

    const seeded = await readSeeded(fixture.projectRoot);
    expect(seeded.gates.map((gate) => gate.id)).toEqual(['gate_1']);
    expect(seeded.decisions.map((decision) => decision.id)).toEqual([
      'decision_1',
    ]);
    expect(seeded.audit.length).toBeGreaterThan(0);
  });
});
