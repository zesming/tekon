import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DraftShape } from '@tekon/core';
import { generateAgentQuestions, refineDraftWithAgent } from '../../src/draft-agent.js';

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

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function backend(output: unknown, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-draft-agent-'));
  directories.push(dir);
  const command = join(dir, 'agent.cjs');
  const capture = join(dir, 'capture.json');
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt: fs.readFileSync(0, 'utf8') }));
process.stdout.write(${JSON.stringify(JSON.stringify(output))});
process.exit(${exitCode});
`, { mode: 0o755 });
  return { config: { agentCommand: command, repoPath: dir }, read: () => JSON.parse(readFileSync(capture, 'utf8')) };
}

function expectTextOnly(args: string[]) {
  expect(args).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'default',
    '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
}

describe('draft agent real process', () => {
  it('disables built-in and MCP tools while parsing Claude question envelopes', () => {
    const agent = backend({ type: 'result', result: JSON.stringify({ questions: ['Which format?', '', 7] }) });
    expect(generateAgentQuestions(makeDraft(), agent.config)).toEqual(['Which format?']);
    expectTextOnly(agent.read().args);
    expect(agent.read().prompt).toContain('Add help command to CLI');
  });
  it('uses the same tool-free invocation and applies refinement envelopes', () => {
    const agent = backend({ type: 'result', result: JSON.stringify({ title: '  CLI help  ', nonGoals: ['UI', 5] }) });
    expect(refineDraftWithAgent(makeDraft(), [{ question: 'Format?', answer: 'Plain text' }], agent.config))
      .toEqual({ title: 'CLI help', nonGoals: ['UI'] });
    expectTextOnly(agent.read().args);
    expect(agent.read().prompt).toContain('A: Plain text');
  });
  it('keeps raw JSON compatibility and limits valid questions to six', () => {
    const agent = backend({ questions: ['1', '2', '3', '4', '5', '6', '7', null] });
    expect(generateAgentQuestions(makeDraft(), agent.config)).toEqual(['1', '2', '3', '4', '5', '6']);
    expectTextOnly(agent.read().args);
  });
  it.each([{ type: 'result', is_error: true, result: '{"title":"bad","questions":["bad"]}' }, null])('falls back on error or non-object output %j', (output) => {
    const agent = backend(output);
    expect(generateAgentQuestions(makeDraft(), agent.config)).toEqual([]);
    expect(refineDraftWithAgent(makeDraft(), [], agent.config)).toBeNull();
  });
  it('falls back on a failed process even if stdout looks valid', () => {
    const agent = backend({ title: 'bad', questions: ['bad'] }, 1);
    expect(generateAgentQuestions(makeDraft(), agent.config)).toEqual([]);
    expect(refineDraftWithAgent(makeDraft(), [], agent.config)).toBeNull();
  });
});
