import { describe, expect, it } from 'vitest';

import { parseWorkflowTemplate } from '../../src/workflow/template.js';

// CD-24：`parallel` 是从未实现的假能力（解析后始终串行执行），删除该字段与
// UI 文案，节点级 dependsOn 保留。为兼容旧模板/旧快照，YAML 里残留的
// parallel 键被接受但忽略，不再出现在解析结果上。
describe('CD-24: parallel phase flag removal', () => {
  it('accepts a legacy parallel flag in YAML but drops it from the parsed phase', () => {
    const template = parseWorkflowTemplate(`
id: legacy-parallel
version: 1
governance: none
phases:
  - id: p1
    name: One
    parallel: true
    nodes:
      - id: n1
        role: goal
  - id: p2
    name: Two
    dependsOn: [p1]
    parallel: false
    nodes:
      - id: n2
        role: goal
        dependsOn: [n1]
`);

    expect(template.phases).toHaveLength(2);
    for (const phase of template.phases) {
      expect(phase).not.toHaveProperty('parallel');
    }
    // dependsOn 仍然有效，连通性校验不受影响。
    expect(template.phases[1]!.dependsOn).toEqual(['p1']);
    expect(template.phases[1]!.nodes[0]!.dependsOn).toEqual(['n1']);
  });

  it('parses templates that never declare parallel', () => {
    const template = parseWorkflowTemplate({
      id: 'no-parallel',
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

    expect(template.phases[0]).not.toHaveProperty('parallel');
  });
});
