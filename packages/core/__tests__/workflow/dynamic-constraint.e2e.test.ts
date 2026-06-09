import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  AgentAdapter,
  AgentRunInput,
  AgentRunResult,
} from '../../src/runtime/agent-adapter.js';
import {
  generateDynamicWorkflow,
  type WorkflowSpecDraft,
} from '../../src/workflow/dynamic.js';

describe('dynamic workflow constraint integration', () => {
  it('rejects a code-change draft that omits reviewer and validation coverage', async () => {
    await expect(
      generateDynamicWorkflow({
        demandText: '改登录鉴权代码',
        adapter: createDraftAdapter({
          demandSummary: '修改登录鉴权代码',
          phases: [
            {
              id: 'rd',
              name: 'RD',
              nodes: [
                {
                  id: 'rd-auth-change',
                  role: 'rd',
                  artifactOutputs: ['code-changes'],
                  gates: [{ type: 'build' }, { type: 'lint' }],
                },
              ],
            },
          ],
          riskTags: ['auth'],
          assumptions: [],
          openQuestions: [],
        }),
      }),
    ).rejects.toThrow(/hard-independent-reviewer.*hard-validation-or-e2e/u);
  });

  it('injects a human gate for high-risk dynamic workflows', async () => {
    const preview = await generateDynamicWorkflow({
      demandText: '给支付模块加退款功能，属于高风险数据变更',
      adapter: createDraftAdapter({
        demandSummary: '为支付模块增加退款功能',
        phases: [
          {
            id: 'rd',
            name: 'RD',
            nodes: [
              {
                id: 'rd-refund-implementation',
                role: 'rd',
                artifactOutputs: ['code-changes'],
                gates: [{ type: 'build' }, { type: 'lint' }],
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
        riskTags: ['payment', 'data', 'high-risk'],
        riskLevel: 'high',
        assumptions: ['退款链路已有基础审计日志'],
        openQuestions: [],
      }),
    });

    const rdNode = preview.workflow.phases
      .flatMap((phase) => phase.nodes)
      .find((node) => node.id === 'rd-refund-implementation');

    expect(preview.constraints.valid).toBe(true);
    expect(rdNode?.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'constraint-gate-human-high-risk',
          type: 'human',
          source: 'constraint',
        }),
      ]),
    );
    expect(preview.constraints.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'conditional-high-risk-human-gate' }),
        expect.objectContaining({ id: 'conditional-rollback-plan' }),
      ]),
    );
  });
});

function createDraftAdapter(draft: WorkflowSpecDraft): AgentAdapter {
  return {
    async runAgent(input) {
      return writeAdapterOutput(input, JSON.stringify(draft));
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
