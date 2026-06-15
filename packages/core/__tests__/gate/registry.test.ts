import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  createGateEngine,
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
  createBuiltInGateRegistry,
  COMMAND_GATE_TYPES,
  GOVERNANCE_GATE_TYPES,
  type GateType,
} from '../../src/index.js';

describe('gate registry', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('createBuiltInGateRegistry returns all 12 gate types', () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const registry = createBuiltInGateRegistry({ repositories });

    const allTypes: GateType[] = [
      'ac-evidence',
      'build',
      'test',
      'lint',
      'e2e-pass',
      'schema',
      'independent-review',
      'role-scope',
      'qa-signoff',
      'process-completeness',
      'security-scan',
      'human',
    ];

    expect(registry.list()).toHaveLength(12);
    for (const type of allTypes) {
      expect(registry.has(type)).toBe(true);
      expect(registry.get(type)).toBeDefined();
      expect(registry.get(type)!.type).toBe(type);
    }
    db.close();
  });

  it('each gate has correct metadata shape', () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const registry = createBuiltInGateRegistry({ repositories });

    for (const def of registry.list()) {
      expect(def.metadata).toHaveProperty('commandLike');
      expect(def.metadata).toHaveProperty('humanBlocking');
      expect(def.metadata).toHaveProperty('supportsNotApplicable');
      expect(def.metadata).toHaveProperty('requiredEvidence');
      expect(def.metadata).toHaveProperty('sideEffect');
      expect(def.metadata).toHaveProperty('riskTags');
      expect(typeof def.metadata.commandLike).toBe('boolean');
      expect(typeof def.metadata.humanBlocking).toBe('boolean');
      expect(typeof def.metadata.supportsNotApplicable).toBe('boolean');
      expect(Array.isArray(def.metadata.requiredEvidence)).toBe(true);
      expect(Array.isArray(def.metadata.riskTags)).toBe(true);
      expect(['none', 'creates-artifact', 'creates-decision']).toContain(
        def.metadata.sideEffect,
      );
      expect(['command', 'semantic', 'human', 'review', 'validation']).toContain(
        def.category,
      );
      expect(Array.isArray(def.tags)).toBe(true);
      expect(typeof def.runner).toBe('function');
    }
    db.close();
  });

  it('command gates have correct metadata', () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const registry = createBuiltInGateRegistry({ repositories });

    for (const type of COMMAND_GATE_TYPES) {
      const def = registry.get(type)!;
      expect(def.category).toBe('command');
      expect(def.metadata.commandLike).toBe(true);
      expect(def.metadata.supportsNotApplicable).toBe(true);
      expect(def.metadata.humanBlocking).toBe(false);
    }

    const security = registry.get('security-scan')!;
    expect(security.category).toBe('command');
    expect(security.metadata.commandLike).toBe(true);
    expect(security.metadata.supportsNotApplicable).toBe(false);
    expect(security.metadata.riskTags).toContain('security');
    db.close();
  });

  it('human gate has correct metadata and handlesOwnPersistence', () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const registry = createBuiltInGateRegistry({ repositories });

    const human = registry.get('human')!;
    expect(human.category).toBe('human');
    expect(human.metadata.humanBlocking).toBe(true);
    expect(human.metadata.sideEffect).toBe('creates-decision');
    expect(human.handlesOwnPersistence).toBe(true);
    db.close();
  });

  it('get() returns undefined for unknown type', () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const registry = createBuiltInGateRegistry({ repositories });

    expect(registry.get('nonexistent' as GateType)).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
    db.close();
  });

  it('listByCategory filters correctly', () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const registry = createBuiltInGateRegistry({ repositories });

    const commandGates = registry.listByCategory('command');
    expect(commandGates).toHaveLength(5); // build, test, lint, e2e-pass, security-scan
    for (const def of commandGates) {
      expect(def.category).toBe('command');
    }

    const reviewGates = registry.listByCategory('review');
    expect(reviewGates).toHaveLength(2); // independent-review, role-scope
    for (const def of reviewGates) {
      expect(def.category).toBe('review');
    }

    const semanticGates = registry.listByCategory('semantic');
    expect(semanticGates).toHaveLength(3); // ac-evidence, qa-signoff, process-completeness
    for (const def of semanticGates) {
      expect(def.category).toBe('semantic');
    }

    const validationGates = registry.listByCategory('validation');
    expect(validationGates).toHaveLength(1); // schema
    expect(validationGates[0]!.type).toBe('schema');

    const humanGates = registry.listByCategory('human');
    expect(humanGates).toHaveLength(1); // human
    expect(humanGates[0]!.type).toBe('human');

    // Total: 5 + 2 + 3 + 1 + 1 = 12
    expect(
      commandGates.length +
        reviewGates.length +
        semanticGates.length +
        validationGates.length +
        humanGates.length,
    ).toBe(12);
    db.close();
  });

  it('registry-based engine produces same skipped result as legacy engine', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-registry-skip-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const registry = createBuiltInGateRegistry({ repositories });

    // Registry-based engine
    const registryEngine = createGateEngine({ repositories, registry });
    const registryResult = await registryEngine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: {
        type: 'build',
        skipReason: 'docs-only repo',
      },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    // Legacy engine (no registry)
    const db2 = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db2);
    const repositories2 = createRepositories(db2);
    await createRunFixture(repositories2, repoPath);
    const legacyEngine = createGateEngine({ repositories: repositories2 });
    const legacyResult = await legacyEngine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: {
        type: 'build',
        skipReason: 'docs-only repo',
      },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    // Both should produce skipped results
    expect(registryResult).toMatchObject({
      gateType: 'build',
      status: 'skipped',
      failureClassification: 'not-applicable',
    });
    expect(legacyResult).toMatchObject({
      gateType: 'build',
      status: 'skipped',
      failureClassification: 'not-applicable',
    });

    db.close();
    db2.close();
  });

  it('registry-based engine runs command gates same as legacy engine', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-registry-cmd-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const registry = createBuiltInGateRegistry({
      repositories,
      gateway: createCommandGateway(),
    });

    const registryEngine = createGateEngine({
      repositories,
      gateway: createCommandGateway(),
      registry,
    });
    const registryResult = await registryEngine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: {
        type: 'test',
        command: {
          tool: process.execPath,
          args: ['-e', "process.stdout.write('ok\\n')"],
        },
      },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(registryResult).toMatchObject({
      gateType: 'test',
      status: 'passed',
    });
    expect(await repositories.listGateResults('run_1')).toMatchObject([
      { gateType: 'test', status: 'passed' },
    ]);
    db.close();
  });

  it('COMMAND_GATE_TYPES and GOVERNANCE_GATE_TYPES constants are correct', () => {
    expect(COMMAND_GATE_TYPES).toEqual([
      'build',
      'test',
      'lint',
      'e2e-pass',
    ]);
    expect(GOVERNANCE_GATE_TYPES).toEqual([
      'independent-review',
      'role-scope',
      'ac-evidence',
      'qa-signoff',
      'process-completeness',
    ]);
  });

  it('governance gates have governance risk tags', () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const registry = createBuiltInGateRegistry({ repositories });

    for (const type of GOVERNANCE_GATE_TYPES) {
      const def = registry.get(type)!;
      expect(def.metadata.riskTags).toContain('governance');
      expect(def.metadata.commandLike).toBe(false);
      expect(def.metadata.humanBlocking).toBe(false);
    }
    db.close();
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
  repoPath: string,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Registry test',
    body: 'Test gates.',
    createdAt: '2026-06-15T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath,
    createdAt: '2026-06-15T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'rd',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
}
