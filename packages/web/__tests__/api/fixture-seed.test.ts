import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '@tekon/core';

import {
  createWebFixtureProject,
  seedMinimalRun,
  type WebFixtureProject,
} from '../fixtures/project.js';

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
  const runIds = ['run_0', 'run_1'];
  try {
    const perRun = async <T>(list: (runId: string) => Promise<T[]>) =>
      (await Promise.all(runIds.map(list))).flat();
    return {
      runs: await Promise.all(
        runIds.map((runId) => repositories.getWorkflowInstance(runId)),
      ),
      gates: await perRun((runId) => repositories.listGateResults(runId)),
      decisions: await perRun((runId) => repositories.listHumanDecisions(runId)),
      leases: await perRun((runId) => repositories.listWorktreeLeases(runId)),
      audit: await perRun((runId) => repositories.listAuditEvents(runId)),
    };
  } finally {
    db.close();
  }
}

function seededDirs(projectRoot: string) {
  const tekonDir = join(projectRoot, '.tekon');
  return {
    gates: ['run_0', 'run_1'].some((runId) =>
      existsSync(join(tekonDir, 'runs', runId, 'gates')),
    ),
    delivery: existsSync(join(tekonDir, 'runs', 'run_1', 'delivery')),
    worktrees: existsSync(join(tekonDir, 'worktrees')),
  };
}

describe('seedMinimalRun', () => {
  it('writes only the run skeleton by default', async () => {
    fixture = await seedMinimalRun();

    expect(seededDirs(fixture.projectRoot)).toEqual({
      gates: false,
      delivery: false,
      worktrees: false,
    });
    const seeded = await readSeeded(fixture.projectRoot);
    expect(seeded.runs.map((run) => run?.id)).toEqual(['run_0', 'run_1']);
    expect(seeded.gates).toEqual([]);
    expect(seeded.decisions).toEqual([]);
    expect(seeded.leases).toEqual([]);
    expect(seeded.audit).toEqual([]);
  });

  it('keeps audit to run.started events when gates are off', async () => {
    fixture = await seedMinimalRun({ withAudit: true });

    const seeded = await readSeeded(fixture.projectRoot);
    expect(seeded.audit.map((event) => [event.runId, event.type])).toEqual([
      ['run_0', 'run.started'],
      ['run_1', 'run.started'],
    ]);
    expect(seeded.leases).toEqual([]);
  });
});

describe('createWebFixtureProject', () => {
  it('turns every data class on', async () => {
    fixture = await createWebFixtureProject();

    expect(seededDirs(fixture.projectRoot)).toEqual({
      gates: true,
      delivery: true,
      worktrees: true,
    });
    const seeded = await readSeeded(fixture.projectRoot);
    expect(seeded.gates.map((gate) => gate.id)).toEqual(['gate_0', 'gate_1']);
    expect(seeded.decisions.map((decision) => decision.id)).toEqual([
      'decision_1',
    ]);
    expect(seeded.leases).toHaveLength(1);
    expect(seeded.audit.map((event) => event.type)).toEqual([
      'run.started',
      'gate.passed',
      'run.started',
      'worktree.lease.created',
      'human.decision.pending',
    ]);
  });
});
