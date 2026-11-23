import { describe, expect, it } from 'vitest';
import { resolveAgentIconKind } from '../../src/client/components/workbench/AgentIcon.js';

describe('resolveAgentIconKind', () => {
  it('maps known agent families to distinct brand icon kinds', () => {
    expect(resolveAgentIconKind('chatgpt')).toBe('chatgpt');
    expect(resolveAgentIconKind('openai-cli')).toBe('chatgpt');
    expect(resolveAgentIconKind('antigravity')).toBe('antigravity');
    expect(resolveAgentIconKind('gemini-cli')).toBe('antigravity');
    expect(resolveAgentIconKind('dsh-headless')).toBe('antigravity');
    expect(resolveAgentIconKind('codex')).toBe('codex');
    expect(resolveAgentIconKind('claude-code')).toBe('claude');
  });

  it('falls back to generic icon kind for custom or unknown agents', () => {
    expect(resolveAgentIconKind('my-custom-agent')).toBe('generic');
    expect(resolveAgentIconKind('')).toBe('generic');
    expect(resolveAgentIconKind(undefined)).toBe('generic');
  });
});
