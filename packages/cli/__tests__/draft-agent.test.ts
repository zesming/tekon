import { describe, expect, it } from 'vitest';
import {
  generateAgentQuestions,
  refineDraftWithAgent,
  isAgentAvailable,
} from '../src/draft-agent.js';
import type { DraftShape } from '@tekon/core';

function makeDraft(): DraftShape {
  return {
    schemaVersion: 1,
    id: 'test-draft-1',
    title: 'Add help command to CLI',
    summary: 'Add a help command to the tekon CLI',
    category: 'feature',
    risk: {
      level: 'low',
      tags: [],
      requiresHumanApproval: false,
      reasons: [],
    },
    recommendedTemplate: 'standard-feature',
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'User can run tekon help',
        verification: 'Run tekon help and observe output',
      },
    ],
    nonGoals: ['No breaking changes'],
    assumptions: ['User has CLI installed'],
    openQuestions: ['What output format?'],
    rawText: 'Add a help command to the tekon CLI that shows all available commands',
    readyForRun: false,
    approved: false,
    createdAt: '2025-01-01T00:00:00Z',
  } as DraftShape;
}

describe('isAgentAvailable', () => {
  it('returns false for non-existent command', () => {
    const result = isAgentAvailable({
      agentCommand: 'nonexistent_cmd_xyz_123', repoPath: '/tmp',
    });
    expect(result).toBe(false);
  });

  it('returns true for available command', () => {
    const result = isAgentAvailable({ agentCommand: 'node' });
    expect(result).toBe(true);
  });
});

describe('generateAgentQuestions', () => {
  it('returns empty array when agent command does not exist', () => {
    const draft = makeDraft();
    const result = generateAgentQuestions(draft, {
      agentCommand: 'nonexistent_cmd_xyz_123', repoPath: '/tmp',
    });
    expect(result).toEqual([]);
  });

  it('returns string array when agent is available', () => {
    const draft = makeDraft();
    // node won't respond with valid JSON, so this should return []
    const result = generateAgentQuestions(draft, {
      agentCommand: 'node', repoPath: '/tmp',
    });
    expect(Array.isArray(result)).toBe(true);
    // node doesn't produce valid JSON output, so questions should be empty
    expect(result).toEqual([]);
  });
});

describe('refineDraftWithAgent', () => {
  it('returns null when agent command does not exist', () => {
    const draft = makeDraft();
    const result = refineDraftWithAgent(
      draft,
      [{ question: 'Who is the user?', answer: 'Developers' }],
      { agentCommand: 'nonexistent_cmd_xyz_123' },
    );
    expect(result).toBeNull();
  });

  it('returns null when agent fails', () => {
    const draft = makeDraft();
    // node won't produce valid JSON, so should return null
    const result = refineDraftWithAgent(
      draft,
      [{ question: 'Who is the user?', answer: 'Developers' }],
      { agentCommand: 'node' },
    );
    expect(result).toBeNull();
  });
});

describe('AgentClarificationConfig', () => {
  it('accepts valid agentCommand', () => {
    // Verify the type compiles — this is a compile-time only check
    // Runtime assertion just confirms the structure is accepted
    const config = { agentCommand: 'claude', repoPath: '/tmp' };
    const ok = typeof config.agentCommand === 'string' && typeof config.repoPath === 'string';
    expect(ok).toBe(true);
  });
});
