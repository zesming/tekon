import { describe, expect, it } from 'vitest';

import { buildRolePrompt } from '../../src/role/prompt-builder.js';

describe('role prompt builder', () => {
  it('injects role identity, task, skills, tools, knowledge, project context, artifact summaries, and truncation notices', () => {
    const prompt = buildRolePrompt({
      role: {
        role: 'reviewer',
        source: 'built-in',
        agent: { role: 'reviewer', name: 'Reviewer', maxSkills: 3 },
        systemPrompt: 'You review independently.',
        skills: [
          {
            id: 'review',
            name: 'Review',
            priority: 20,
            injectMode: 'append',
            content: 'Check gates and evidence.',
          },
        ],
        knowledge: [{ path: 'knowledge/review.md', content: 'Review policy.' }],
        tools: {
          network: 'disabled',
          allow: [{ tool: 'git', args: ['diff'] }],
          deny: [],
          requiresHumanApproval: [],
        },
      },
      taskInstruction: 'Review the delivery package.',
      projectContext: {
        name: 'tekon',
        repoPath: '/repo',
        currentRunId: 'run_1',
      },
      artifactSummaries: [
        {
          id: 'artifact_123',
          type: 'tech-design',
          path: '.tekon/runs/run_1/artifacts/rd/tech-design.v1.md',
          summary: 'Design summary',
          content: 'A'.repeat(40),
        },
      ],
      maxArtifactChars: 12,
    });

    expect(prompt).toContain('# Role: Reviewer');
    expect(prompt).toContain('You review independently.');
    expect(prompt).toContain('Review the delivery package.');
    expect(prompt).toContain('Check gates and evidence.');
    expect(prompt).toContain('Review policy.');
    expect(prompt).toContain('git diff');
    expect(prompt).toContain('artifactId: artifact_123');
    expect(prompt).toContain('Design summary');
    expect(prompt).toContain('AAAAAAAAAAAA');
    expect(prompt).toContain('[truncated artifact: 28 chars omitted]');
    expect(prompt).toContain('currentRunId: run_1');
  });
});
