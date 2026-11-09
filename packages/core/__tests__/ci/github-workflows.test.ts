import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
  'continue-on-error'?: unknown;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: unknown };
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

function loadWorkflow(name: string): Workflow {
  return parseYaml(readFileSync(join(workflowsDir, name), 'utf8')) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const found = workflow.jobs?.[name];
  if (!found) throw new Error(`Missing workflow job: ${name}`);
  return found;
}

function steps(found: WorkflowJob): WorkflowStep[] {
  if (!Array.isArray(found.steps)) throw new Error('Workflow job must define steps');
  return found.steps;
}

function stepIndex(list: WorkflowStep[], match: (step: WorkflowStep) => boolean): number {
  const index = list.findIndex(match);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

const runs = (text: string) => (step: WorkflowStep) => step.run?.includes(text) === true;

describe('CI workflow', () => {
  const ci = loadWorkflow('ci.yml');
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    engines: { node: string };
    scripts: Record<string, string>;
  };

  it('keeps one main workflow with a single aggregate check', () => {
    expect(readdirSync(workflowsDir).filter((file) => /\.ya?ml$/u.test(file)).sort()).toEqual(['audit.yml', 'ci.yml']);
    expect(Object.keys(ci.jobs ?? {}).sort()).toEqual(['ci-ok', 'node-compat', 'verify', 'web-e2e']);
  });

  it('runs on every pull request and on main, read-only', () => {
    expect(ci.on).toHaveProperty('pull_request');
    expect((ci.on?.push as { branches?: string[] }).branches).toEqual(['main']);
    expect(ci.permissions).toEqual({ contents: 'read' });
  });

  it('cancels superseded runs only on pull requests, so main never shows a cancelled run as red', () => {
    expect(ci.concurrency?.['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('keeps a root lint script for the lint gates of built-in workflow templates', () => {
    expect(rootPackage.scripts.lint).toBe('pnpm -r typecheck');
  });

  it('never lets a failing job or step pass silently', () => {
    for (const [name, found] of Object.entries(ci.jobs ?? {})) {
      expect([undefined, false]).toContain(found['continue-on-error']);
      expect(found.if, name).toBe(name === 'ci-ok' ? 'always()' : undefined);
      for (const step of steps(found)) {
        expect([undefined, false]).toContain(step['continue-on-error']);
        expect(step.if, name).toBeUndefined();
      }
    }
  });

  it('verifies the whole repo once on the primary Node version', () => {
    const verify = job(ci, 'verify');
    const list = steps(verify);
    expect(list.find((step) => step.uses === 'actions/setup-node@v6')?.with?.['node-version']).toBe(
      '${{ env.NODE_VERSION }}',
    );
    expect(list.some((step) => step.uses?.startsWith('docker://rhysd/actionlint:') === true)).toBe(true);
    expect(list.some(runs('bash -n scripts/install.sh'))).toBe(true);
    expect(list.some(runs('pnpm ignored-builds'))).toBe(true);

    const install = stepIndex(list, runs('pnpm install --frozen-lockfile'));
    const build = stepIndex(list, (step) => step.run === 'pnpm -r build');
    const typecheck = stepIndex(list, (step) => step.run === 'pnpm -r typecheck');
    const test = stepIndex(list, (step) => step.run === 'pnpm test --run');
    const smoke = stepIndex(list, runs('node packages/cli/dist/index.js --version'));
    expect([install, build, typecheck, test, smoke]).toEqual([install, build, typecheck, test, smoke].sort((a, b) => a - b));
  });

  it('tests every declared Node floor, and only those, in a fail-complete matrix', () => {
    const compat = job(ci, 'node-compat');
    const declaredFloors = Array.from(rootPackage.engines.node.matchAll(/(?:\^|>=)(\d+\.\d+\.\d+)/gu), (match) => match[1]);
    expect(Object.keys(compat.strategy?.matrix ?? {})).toEqual(['node-version']);
    expect(compat.strategy?.matrix?.['node-version']).toEqual(declaredFloors);
    expect(compat.strategy?.['fail-fast']).toBe(false);
    expect(String(ci.env?.NODE_VERSION)).toBe('24');

    const list = steps(compat);
    const assertStep = list.find((step) => step.name === 'Assert resolved Node version');
    expect(assertStep?.env?.EXPECTED_NODE_VERSION).toBe('${{ matrix.node-version }}');
    expect(assertStep?.run).toContain('actual !== expected');
    const order = [
      stepIndex(list, (step) => step.run === 'npm install --global corepack@0.34.1'),
      stepIndex(list, runs('pnpm install --frozen-lockfile')),
      stepIndex(list, (step) => step.run === 'pnpm -r build'),
      stepIndex(list, (step) => step.run === 'pnpm --filter @tekon/core test:unit'),
      stepIndex(list, (step) => step.run === 'pnpm --filter @tekon/cli test:unit'),
      stepIndex(list, runs('node packages/cli/dist/index.js --version')),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('runs browser journeys in parallel on a runner Playwright supports', () => {
    const e2e = job(ci, 'web-e2e');
    expect(e2e.needs).toBeUndefined();
    expect(e2e['runs-on']).toBe('ubuntu-24.04');
    const list = steps(e2e);
    expect(list.some(runs('playwright install --with-deps chromium'))).toBe(true);
    expect(list.some((step) => step.run === 'pnpm --filter @tekon/web test:e2e')).toBe(true);
  });

  describe('ci-ok aggregate', () => {
    const aggregate = job(ci, 'ci-ok');
    const script = steps(aggregate)[0]?.run;

    // GitHub runs `run:` scripts with `bash -e {0}` when no shell is set.
    function check(results: string) {
      return spawnSync('bash', ['-e', '-c', script ?? 'exit 99'], {
        env: { PATH: process.env.PATH, RESULTS: results },
        encoding: 'utf8',
      }).status;
    }

    it('waits for every other job even when one fails', () => {
      expect(aggregate.if).toBe('always()');
      expect(steps(aggregate)).toHaveLength(1);
      expect([...(aggregate.needs as string[])].sort()).toEqual(['node-compat', 'verify', 'web-e2e']);
      expect(steps(aggregate)[0]?.env?.RESULTS).toBe("${{ join(needs.*.result, ' ') }}");
    });

    it('passes only when every job succeeded', () => {
      expect(check('success success success')).toBe(0);
      expect(check('success failure success')).not.toBe(0);
      expect(check('success cancelled success')).not.toBe(0);
      expect(check('success skipped success')).not.toBe(0);
      expect(check('failure success success')).not.toBe(0);
    });

    it('fails when a job result is missing', () => {
      expect(check('')).not.toBe(0);
      expect(check('success success')).not.toBe(0);
    });
  });
});

describe('dependency audit workflow', () => {
  const audit = loadWorkflow('audit.yml');

  it('runs when dependencies, the audit script or workflows change', () => {
    const paths = (audit.on?.pull_request as { paths?: string[] } | undefined)?.paths;
    expect(paths).toEqual(
      expect.arrayContaining(['pnpm-lock.yaml', '**/package.json', 'scripts/ci/audit-production.mjs', '.github/workflows/**']),
    );
    expect((audit.on?.push as { paths?: string[] } | undefined)?.paths).toEqual(paths);
    expect((audit.on?.push as { branches?: string[] }).branches).toEqual(['main']);
    expect(audit.permissions).toEqual({ contents: 'read' });
    expect(audit.on).toHaveProperty('workflow_dispatch');
  });

  it('audits without running install scripts and never ignores failures', () => {
    const found = job(audit, 'audit');
    expect([undefined, false]).toContain(found['continue-on-error']);
    const list = steps(found);
    for (const step of list) expect([undefined, false]).toContain(step['continue-on-error']);
    expect(list.some((step) => step.run === 'pnpm install --frozen-lockfile --ignore-scripts')).toBe(true);
    expect(list.some((step) => step.run === 'node scripts/ci/audit-production.mjs')).toBe(true);
  });
});
