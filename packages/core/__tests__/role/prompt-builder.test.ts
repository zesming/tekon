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

  it('falls back to role when agent has no name', () => {
    const prompt = buildRolePrompt({
      role: {
        role: 'architect',
        source: 'custom',
        agent: { role: 'architect', maxSkills: 2 },
        systemPrompt: 'Design the system.',
        skills: [],
        knowledge: [],
        tools: {
          network: 'disabled',
          allow: [],
          deny: [],
          requiresHumanApproval: [],
        },
      },
      taskInstruction: 'Draft architecture.',
      projectContext: { repoPath: '/tmp/repo' },
    });

    expect(prompt).toContain('# Role: architect');
    expect(prompt).toContain('source: custom');
    expect(prompt).toContain('roleId: architect');
    expect(prompt).toContain('Draft architecture.');
  });

  it('renders "none" for empty skills, knowledge, and artifacts', () => {
    const prompt = buildRolePrompt({
      role: {
        role: 'executor',
        source: 'built-in',
        agent: { role: 'executor', name: 'Executor', maxSkills: 1 },
        systemPrompt: 'Execute commands.',
        skills: [],
        knowledge: [],
        tools: {
          network: 'disabled',
          allow: [],
          deny: [],
          requiresHumanApproval: [],
        },
      },
      taskInstruction: 'Run the build.',
      projectContext: { repoPath: '/repo' },
      artifactSummaries: [],
    });

    expect(prompt).toContain('## Skills\nnone');
    expect(prompt).toContain('## Knowledge\nnone');
    expect(prompt).toContain('## Artifacts\nnone');
  });

  it('omits artifactId and summary lines when optional fields are absent', () => {
    const prompt = buildRolePrompt({
      role: {
        role: 'tester',
        source: 'project',
        agent: { role: 'tester', name: 'Tester', maxSkills: 2 },
        systemPrompt: 'Run tests.',
        skills: [],
        knowledge: [],
        tools: {
          network: 'disabled',
          allow: [],
          deny: [],
          requiresHumanApproval: [],
        },
      },
      taskInstruction: 'Test the module.',
      projectContext: { repoPath: '/repo' },
      artifactSummaries: [
        {
          type: 'test-report',
          path: '/tmp/report.xml',
          content: '<results/>',
          // no id, no summary
        },
      ],
    });

    expect(prompt).not.toContain('artifactId:');
    expect(prompt).not.toContain('summary:');
    expect(prompt).toContain('### test-report');
    expect(prompt).toContain('path: /tmp/report.xml');
    expect(prompt).toContain('<results/>');
  });

  it('truncates only the artifacts whose content exceeds maxArtifactChars', () => {
    const prompt = buildRolePrompt({
      role: {
        role: 'scanner',
        source: 'built-in',
        agent: { role: 'scanner', name: 'Scanner', maxSkills: 3 },
        systemPrompt: 'Scan artifacts.',
        skills: [],
        knowledge: [],
        tools: {
          network: 'disabled',
          allow: [],
          deny: [],
          requiresHumanApproval: [],
        },
      },
      taskInstruction: 'Scan the deliverables.',
      projectContext: { repoPath: '/repo' },
      artifactSummaries: [
        {
          id: 'small',
          type: 'log',
          path: '/tmp/small.log',
          content: 'abc',
        },
        {
          id: 'large',
          type: 'log',
          path: '/tmp/large.log',
          content: 'X'.repeat(50),
        },
      ],
      maxArtifactChars: 10,
    });

    // Small artifact fits entirely — no truncation text next to it
    expect(prompt).toContain('abc');
    // Large one is truncated
    expect(prompt).toContain('[truncated artifact: 40 chars omitted]');
    // Verify both artifacts appear
    expect(prompt).toContain('artifactId: small');
    expect(prompt).toContain('artifactId: large');
  });

  it('falls back to skill id when skill has no name', () => {
    const prompt = buildRolePrompt({
      role: {
        role: 'helper',
        source: 'project',
        agent: { role: 'helper', name: 'Helper', maxSkills: 5 },
        systemPrompt: 'Assist the user.',
        skills: [
          {
            id: 'util-cleanup',
            priority: 5,
            injectMode: 'inline',
            content: 'Remove temp files.',
            // no name
          },
        ],
        knowledge: [],
        tools: {
          network: 'disabled',
          allow: [],
          deny: [],
          requiresHumanApproval: [],
        },
      },
      taskInstruction: 'Clean up.',
      projectContext: { repoPath: '/repo' },
    });

    expect(prompt).toContain('### util-cleanup');
    expect(prompt).toContain('priority: 5');
    expect(prompt).toContain('injectMode: inline');
    expect(prompt).toContain('Remove temp files.');
  });
});
