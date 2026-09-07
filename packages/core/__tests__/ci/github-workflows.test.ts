import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface WorkflowStep {
  name?: string;
  env?: Record<string, unknown>;
  if?: unknown;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}

interface WorkflowJob {
  if?: unknown;
  needs?: unknown;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: unknown;
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: Record<string, unknown>;
  };
  steps?: WorkflowStep[];
}

interface Workflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

function loadWorkflow(name: string): Workflow {
  return parseYaml(
    readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8'),
  ) as Workflow;
}

function requireJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return job;
}

function requireSteps(job: WorkflowJob): WorkflowStep[] {
  if (!Array.isArray(job.steps)) {
    throw new Error('Workflow job must define steps');
  }
  return job.steps;
}

describe('GitHub Actions Node compatibility contract', () => {
  const ci = loadWorkflow('ci.yml');
  const core = loadWorkflow('core.yml');
  const rootPackage = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ) as { engines: { node: string } };

  it('runs an independent, fail-complete matrix at every declared boundary', () => {
    const job = requireJob(ci, 'node-compat');
    const versions = job.strategy?.matrix?.['node-version'];

    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.strategy?.['fail-fast']).toBe(false);
    expect(versions).toEqual(['20.19.0', '22.12.0', '22.19.0', '24.x']);
    expect(job.strategy?.matrix?.exclude).toBeUndefined();

    const declaredFloors = Array.from(
      rootPackage.engines.node.matchAll(/(?:\^|>=)(\d+\.\d+\.\d+)/gu),
      (match) => match[1],
    );
    expect(versions).toEqual(expect.arrayContaining(declaredFloors));

    const primaryNode = String(ci.env?.NODE_VERSION);
    expect(versions).toContain(`${primaryNode}.x`);
    const coreSetup = requireSteps(requireJob(core, 'core')).find(
      (step) => step.uses === 'actions/setup-node@v6',
    );
    expect(coreSetup?.with?.['node-version']).toBe(primaryNode);
  });

  it('installs, builds, typechecks, tests Core and CLI, then smokes the built CLI', () => {
    const job = requireJob(ci, 'node-compat');
    const steps = requireSteps(job);
    expect(steps.length).toBeGreaterThanOrEqual(10);

    const setupNode = steps.find(
      (step) => step.uses === 'actions/setup-node@v6',
    );
    expect(setupNode?.with?.['node-version']).toBe(
      '${{ matrix.node-version }}',
    );
    const resolvedStep = steps.find(
      (step) => step.name === 'Assert resolved Node version',
    );
    expect(resolvedStep).toBeDefined();
    expect(resolvedStep?.env?.EXPECTED_NODE_VERSION).toBe(
      '${{ matrix.node-version }}',
    );
    expect(resolvedStep?.run).toContain(
      'process.env.EXPECTED_NODE_VERSION',
    );
    expect(resolvedStep?.run).not.toMatch(/\$\{/u);
    expect(resolvedStep?.run).toContain('expected.endsWith(".x")');
    expect(resolvedStep?.run).toContain('actual.startsWith(prefix + ".")');
    expect(resolvedStep?.run).toContain('actual !== expected');
    expect(resolvedStep?.run).toContain('throw new Error');

    const orderedStepIndexes = [
      steps.findIndex((step) => step.uses === 'actions/checkout@v6'),
      steps.findIndex((step) => step.uses === 'actions/setup-node@v6'),
      steps.indexOf(resolvedStep!),
      steps.findIndex(
        (step) => step.run === 'npm install --global corepack@0.34.1',
      ),
      steps.findIndex((step) => step.run === 'corepack enable pnpm'),
      steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile'),
      steps.findIndex((step) => step.run === 'pnpm -r build'),
      steps.findIndex((step) => step.run === 'pnpm -r typecheck'),
      steps.findIndex(
        (step) => step.run === 'pnpm --filter @tekon/core test:unit',
      ),
      steps.findIndex(
        (step) => step.run === 'pnpm --filter @tekon/cli test:unit',
      ),
      steps.findIndex(
        (step) =>
          step.run?.includes('node packages/cli/dist/index.js --version') ===
          true,
      ),
    ];
    expect(orderedStepIndexes.every((index) => index >= 0)).toBe(true);
    expect(orderedStepIndexes).toEqual(
      [...orderedStepIndexes].sort((left, right) => left - right),
    );

    const smoke = steps[orderedStepIndexes.at(-1) ?? -1]?.run;
    expect(smoke).toContain(
      'expected="v$(node -p "require(\'./package.json\').version")"',
    );
    expect(smoke).toContain(
      'test "$(node packages/cli/dist/index.js --version)" = "$expected"',
    );
    expect(smoke).toContain('node packages/cli/dist/index.js --help');

    const existingActions = new Set(
      Object.entries(ci.jobs ?? {})
        .filter(([name]) => name !== 'node-compat')
        .flatMap(([, otherJob]) => requireSteps(otherJob))
        .map((step) => step.uses)
        .filter((uses): uses is string => typeof uses === 'string'),
    );
    for (const action of steps
      .map((step) => step.uses)
      .filter((uses): uses is string => typeof uses === 'string')) {
      expect(existingActions).toContain(action);
    }
  });

  it('does not allow a failed compatibility leg or step to pass', () => {
    const job = requireJob(ci, 'node-compat');
    expect([undefined, false]).toContain(job['continue-on-error']);
    for (const step of requireSteps(job)) {
      expect([undefined, false]).toContain(step['continue-on-error']);
      expect(step.if).toBeUndefined();
    }
  });
});

describe('GitHub Actions production audit contract', () => {
  const ci = loadWorkflow('ci.yml');

  it('runs production audit using the classified retry runner with no continue-on-error', () => {
    const job = requireJob(ci, 'audit');
    expect([undefined, false]).toContain(job['continue-on-error']);
    const steps = requireSteps(job);
    for (const step of steps) {
      expect([undefined, false]).toContain(step['continue-on-error']);
    }

    const auditStep = steps.find((step) =>
      step.run?.includes('node scripts/ci/audit-production.mjs'),
    );
    expect(auditStep).toBeDefined();
  });
});
