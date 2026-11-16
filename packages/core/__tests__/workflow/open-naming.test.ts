import { describe, expect, it } from 'vitest';

import {
  normalizeExecutableTemplate,
  parseWorkflowTemplate,
} from '../../src/workflow/template.js';

// PD-06 子项 2/3：角色与产物类型开放命名，节点支持自带 prompt。
// reviewer/Gate 可选属于子项 4（后续批次），这里的用例继续用 governance:none
// 隔离审阅者要求，只验证开放字符串与 prompt 字段本身。
describe('open role/artifact naming and node prompt (PD-06)', () => {
  it('accepts custom role ids and custom artifact types in a template', () => {
    const template = parseWorkflowTemplate({
      id: 'custom-naming',
      version: 1,
      governance: 'none',
      phases: [
        {
          id: 'writing',
          name: 'Writing',
          nodes: [
            {
              id: 'draft',
              role: 'writer',
              outputs: [{ id: 'essay', type: 'essay' }],
            },
          ],
        },
      ],
    });

    const node = template.phases[0]!.nodes[0]!;
    expect(node.role).toBe('writer');
    expect(node.outputs).toEqual([{ id: 'essay', type: 'essay' }]);
  });

  it('passes a custom-typed artifact between nodes through declared inputs', () => {
    const template = parseWorkflowTemplate({
      id: 'custom-flow',
      version: 1,
      governance: 'none',
      phases: [
        {
          id: 'p1',
          name: 'One',
          nodes: [
            {
              id: 'author',
              role: 'writer',
              outputs: [{ id: 'draft', type: 'weekly-report' }],
            },
          ],
        },
        {
          id: 'p2',
          name: 'Two',
          dependsOn: ['p1'],
          nodes: [
            {
              id: 'reviewer-custom',
              role: 'editor',
              dependsOn: ['author'],
              inputs: [{ from: 'author', type: 'weekly-report' }],
              outputs: [{ id: 'polished', type: 'weekly-report' }],
            },
          ],
        },
      ],
    });

    const secondNode = template.phases[1]!.nodes[0]!;
    expect(secondNode.inputs).toEqual([
      {
        id: 'weekly-report',
        type: 'weekly-report',
        fromNodeId: 'author',
      },
    ]);
  });

  it('keeps a node-level prompt through parse and executable normalization', () => {
    const template = parseWorkflowTemplate({
      id: 'node-prompt',
      version: 1,
      governance: 'none',
      phases: [
        {
          id: 'p1',
          name: 'One',
          nodes: [
            {
              id: 'brief',
              role: 'writer',
              prompt: '用不超过 200 字总结本周客户反馈，按主题分组。',
              outputs: [{ id: 'summary', type: 'essay' }],
            },
          ],
        },
      ],
    });

    expect(template.phases[0]!.nodes[0]!.prompt).toBe(
      '用不超过 200 字总结本周客户反馈，按主题分组。',
    );

    const executable = normalizeExecutableTemplate(template);
    expect(executable.phases[0]!.nodes[0]!.prompt).toBe(
      '用不超过 200 字总结本周客户反馈，按主题分组。',
    );
  });

  it('omits the optional prompt when the template does not declare one', () => {
    const template = parseWorkflowTemplate({
      id: 'no-prompt',
      version: 1,
      governance: 'none',
      phases: [
        {
          id: 'p1',
          name: 'One',
          nodes: [{ id: 'n1', role: 'goal', outputs: [] }],
        },
      ],
    });

    expect(template.phases[0]!.nodes[0]!.prompt).toBeUndefined();
  });

  it('rejects role and artifact identifiers that are not kebab-case tokens', () => {
    expect(() =>
      parseWorkflowTemplate({
        id: 'bad-role',
        version: 1,
        governance: 'none',
        phases: [
          {
            id: 'p1',
            nodes: [{ id: 'n1', role: 'Senior Writer', outputs: [] }],
          },
        ],
      }),
    ).toThrow(/role|identifier/u);

    expect(() =>
      parseWorkflowTemplate({
        id: 'bad-artifact',
        version: 1,
        governance: 'none',
        phases: [
          {
            id: 'p1',
            nodes: [
              {
                id: 'n1',
                role: 'writer',
                outputs: [{ id: 'x', type: 'Not-Valid' }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/artifact|identifier|type/u);
  });

  it('rejects delivery-reserved artifact types as node outputs at parse time', () => {
    expect(() =>
      parseWorkflowTemplate({
        id: 'reserved-output',
        version: 1,
        governance: 'none',
        phases: [
          {
            id: 'p1',
            nodes: [
              {
                id: 'n1',
                role: 'pmo',
                outputs: [{ id: 'ci', type: 'ci-status' }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/reserved|delivery/u);

    expect(() =>
      normalizeExecutableTemplate({
        id: 'reserved-output-exec',
        name: 'reserved-output-exec',
        version: 1,
        retryPolicy: {
          maxAttempts: 1,
          maxRetries: 0,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
        },
        phases: [
          {
            id: 'p1',
            name: 'p1',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'n1',
                role: 'pmo',
                inputs: [],
                outputs: [{ id: 'ci', type: 'ci-status' }],
                gates: [],
                dependsOn: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(/reserved|delivery/u);
  });

  it('still accepts every built-in role and artifact type', () => {
    const template = parseWorkflowTemplate({
      id: 'built-ins',
      version: 1,
      phases: [
        {
          id: 'p1',
          nodes: [
            {
              id: 'rd-node',
              role: 'rd',
              outputs: [{ id: 'code', type: 'code-changes' }],
              gates: [
                { type: 'build', commandRef: 'build' },
                { type: 'lint', commandRef: 'lint' },
              ],
            },
          ],
        },
        {
          id: 'p2',
          dependsOn: ['p1'],
          nodes: [
            {
              id: 'review-node',
              role: 'reviewer',
              dependsOn: ['rd-node'],
              inputs: [{ from: 'rd-node', type: 'code-changes' }],
              outputs: [{ id: 'review', type: 'review-report' }],
            },
          ],
        },
      ],
    });

    expect(template.phases[0]!.nodes[0]!.role).toBe('rd');
    expect(template.phases[1]!.nodes[0]!.role).toBe('reviewer');
  });
});
