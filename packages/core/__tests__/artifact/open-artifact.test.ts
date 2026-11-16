import { describe, expect, it } from 'vitest';

import {
  agentArtifactManifestSchema,
  agentArtifactTypeSchema,
  validateArtifactContent,
  validateArtifactPayload,
} from '../../src/index.js';

// PD-06 子项 3：产物类型开放命名。内置类型保留专用 payload schema，
// 自定义类型回落到通用 Markdown payload 校验（可选注册项语义）。
describe('open artifact types (PD-06)', () => {
  it('validates a custom artifact type against the generic markdown payload', () => {
    const payload = validateArtifactPayload('essay', {
      title: '周报',
      body: '本周完成三项客户访谈。',
    });

    expect(payload.title).toBe('周报');
    expect(payload.body).toContain('客户访谈');
  });

  it('still enforces non-empty title/body for custom artifact types', () => {
    expect(() => validateArtifactPayload('essay', {})).toThrow();
  });

  it('parses markdown content for a custom artifact type', () => {
    const parsed = validateArtifactContent(
      'weekly-report',
      '# 本周摘要\n\n客户反馈按主题归并。',
    );

    expect(parsed.title).toBe('本周摘要');
    expect(parsed.body).toBe('客户反馈按主题归并。');
  });

  it('accepts custom kebab-case types in the agent manifest', () => {
    const parsed = agentArtifactManifestSchema.parse({
      artifacts: [
        { type: 'essay', path: 'essay.md', summary: '自定义产物' },
        { type: 'weekly-report', path: 'weekly.md' },
      ],
    });

    expect(parsed.artifacts).toHaveLength(2);
    expect(parsed.artifacts[0]!.type).toBe('essay');
    expect(parsed.artifacts[1]!.type).toBe('weekly-report');
  });

  it('still rejects delivery-reserved ci-status in agent manifests', () => {
    expect(() =>
      agentArtifactManifestSchema.parse({
        artifacts: [{ type: 'ci-status', path: 'ci.json' }],
      }),
    ).toThrow();

    const direct = agentArtifactTypeSchema.safeParse('ci-status');
    expect(direct.success).toBe(false);
    if (!direct.success) {
      expect(direct.error.issues[0]!.message).toMatch(
        /reserved|delivery/u,
      );
    }
  });

  it('rejects manifest artifact types that are not identifiers', () => {
    expect(() =>
      agentArtifactManifestSchema.parse({
        artifacts: [{ type: 'not valid', path: 'x.md' }],
      }),
    ).toThrow();
  });
});
