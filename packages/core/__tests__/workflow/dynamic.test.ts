import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentAdapter,
  AgentRunInput,
  AgentRunResult,
} from '../../src/runtime/agent-adapter.js';
import {
  generateDynamicWorkflow,
  saveDynamicTemplate,
  type WorkflowSpecDraft,
} from '../../src/workflow/dynamic.js';
import { loadWorkflowTemplate } from '../../src/workflow/template.js';

describe('dynamic workflow generation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs the PM adapter, validates WorkflowSpecDraft JSON, and returns a dry-run preview', async () => {
    const calls: AgentRunInput[] = [];
    const adapter = createJsonAdapter(validDraft(), calls);

    const preview = await generateDynamicWorkflow({
      demandText: '给支付模块加退款功能，需要回滚方案',
      adapter,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.roleConfig.role).toBe('pm');
    expect(calls[0]?.prompt).toContain('WorkflowSpecDraft');
    expect(calls[0]?.commandPolicy).toMatchObject({
      allow: [],
      deny: [],
      requiresHumanApproval: [],
      network: 'disabled',
    });
    expect(calls[0]?.runContext.nodeId).toBe('dynamic-pm-draft');
    expect(preview.dryRun).toBe(true);
    expect(preview.draft).toMatchObject({
      demandSummary: '为支付模块增加退款功能',
      riskTags: ['payment', 'data'],
      assumptions: ['已有支付订单状态机'],
      openQuestions: ['退款是否需要财务复核'],
    });
    expect(preview.workflow.phases.map((phase) => phase.id)).toContain('rd');
    expect(preview.constraints.valid).toBe(true);
    expect(preview.constraints.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'conditional-rollback-plan' }),
      ]),
    );
  });

  it('rejects malformed PM JSON before constraints are applied', async () => {
    await expect(
      generateDynamicWorkflow({
        demandText: '给支付模块加退款功能',
        adapter: createRawAdapter('{not-json'),
      }),
    ).rejects.toThrow(/invalid PM workflow JSON/u);
  });

  it('saves a schema-validated workflow YAML template under a safe name', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-dynamic-template-'));
    tempDirs.push(root);
    const workflowsDir = join(root, 'workflows');

    const result = saveDynamicTemplate(validDraft(), 'refund-flow', {
      workflowsDir,
    });

    expect(result.path).toBe(join(workflowsDir, 'refund-flow.yaml'));
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, 'utf8')).toContain('id: refund-flow');
    expect(
      loadWorkflowTemplate({ name: 'refund-flow', workflowsDir }),
    ).toMatchObject({
      id: 'refund-flow',
      phases: expect.arrayContaining([
        expect.objectContaining({ id: 'reviewer' }),
      ]),
    });
  });

  it('rejects save-as path traversal and malformed template specs', () => {
    expect(() => saveDynamicTemplate(validDraft(), '../evil')).toThrow(
      /invalid dynamic template name/u,
    );

    expect(() =>
      saveDynamicTemplate(
        {
          ...validDraft(),
          phases: [],
        },
        'empty-flow',
      ),
    ).toThrow(/invalid dynamic workflow spec/u);
  });
});

function validDraft(): WorkflowSpecDraft {
  return {
    demandSummary: '为支付模块增加退款功能',
    phases: [
      {
        id: 'pm',
        name: 'PM',
        nodes: [
          {
            id: 'pm-refund-demand',
            role: 'pm',
            artifactOutputs: ['demand-card', 'prd'],
            gates: [{ type: 'schema', artifactType: 'demand-card' }],
          },
        ],
      },
      {
        id: 'rd',
        name: 'RD',
        dependsOn: ['pm'],
        nodes: [
          {
            id: 'rd-refund-implementation',
            role: 'rd',
            dependsOn: ['pm-refund-demand'],
            artifactOutputs: ['tech-design', 'code-changes'],
            gates: [
              { type: 'build' },
              { type: 'lint' },
              { type: 'schema', artifactType: 'code-changes' },
            ],
          },
        ],
      },
      {
        id: 'validation',
        name: 'Validation',
        dependsOn: ['rd'],
        nodes: [
          {
            id: 'qa-refund-validation',
            role: 'qa',
            dependsOn: ['rd-refund-implementation'],
            artifactOutputs: ['test-report'],
            gates: [{ type: 'test' }],
          },
        ],
      },
      {
        id: 'reviewer',
        name: 'Independent Review',
        dependsOn: ['validation'],
        nodes: [
          {
            id: 'reviewer-refund-review',
            role: 'reviewer',
            dependsOn: ['qa-refund-validation'],
            artifactOutputs: ['review-report'],
            gates: [{ type: 'human' }],
          },
        ],
      },
    ],
    riskTags: ['payment', 'data'],
    assumptions: ['已有支付订单状态机'],
    openQuestions: ['退款是否需要财务复核'],
  };
}

function createJsonAdapter(
  draft: WorkflowSpecDraft,
  calls: AgentRunInput[],
): AgentAdapter {
  return {
    async runAgent(input) {
      calls.push(input);
      return writeAdapterOutput(input, JSON.stringify(draft));
    },
  };
}

function createRawAdapter(content: string): AgentAdapter {
  return {
    async runAgent(input) {
      return writeAdapterOutput(input, content);
    },
  };
}

function writeAdapterOutput(
  input: AgentRunInput,
  content: string,
): AgentRunResult {
  const outputPath = join(input.outputDir, 'workflow-spec.json');
  writeFileSync(outputPath, content, 'utf8');
  return {
    provider: 'mock',
    exitCode: 0,
    durationMs: 1,
    outputFiles: [outputPath],
    timedOut: false,
  };
}
