import { describe, expect, it } from 'vitest';

import {
  SESSION_EVENT_SCHEMA_VERSION,
  sessionEventSchema,
  type SessionEvent,
} from '../../src/index.js';
import {
  buildModelVisibleView,
  DEFAULT_MAX_EVENT_BYTES,
  MODEL_VISIBLE_MAX_BYTES,
  presentEvent,
  presentEvents,
} from '../../src/session/present.js';

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return sessionEventSchema.parse({
    sessionId: 'sess_1',
    seq: 1,
    type: 'test/event',
    version: SESSION_EVENT_SCHEMA_VERSION,
    timestamp: '2026-08-21T00:00:00.000Z',
    ...overrides,
  });
}

describe('presentEvent', () => {
  it('返回脱敏与限长后的事件视图', () => {
    const event = makeEvent({
      seq: 7,
      type: 'agent/status',
      payload: { status: 'passed', kind: 'workflow' },
      correlationId: 'corr_1',
    });
    const presented = presentEvent(event);
    expect(presented).toEqual({
      seq: 7,
      type: 'agent/status',
      timestamp: '2026-08-21T00:00:00.000Z',
      payload: { status: 'passed', kind: 'workflow' },
      visibility: 'ui-only',
      modelVisible: false,
      correlationId: 'corr_1',
    });
  });

  it('剔除 visibility=internal 的事件(不下发)', () => {
    const event = makeEvent({ visibility: 'internal' });
    expect(presentEvent(event)).toBeNull();
  });

  it('递归脱敏 payload 字符串中的密钥模式', () => {
    // 覆盖三种容器形状(顶层字符串 / 嵌套对象 / 数组元素)——证明 redactPayloadDeep
    // 递归到每一层。所用模式必须是 redactSecrets(§3.2 权威脱敏器)实际识别的:
    // sk- OpenAI key、AKIA AWS key。present.ts 不做超出 redactSecrets 的启发式脱敏
    // (那会偏离 §3.2 且在 UI 载荷上产生误报)。
    const event = makeEvent({
      payload: {
        text: 'token is sk-abcdefghijklmnopqrstuvwxyz123456',
        nested: {
          deeper: { apiKey: 'AKIAIOSFODNN7EXAMPLE' },
        },
        list: ['key sk-listsecretabcdefghijklmnopqrst', 'plain'],
      },
    });
    const presented = presentEvent(event);
    expect(presented).not.toBeNull();
    const json = JSON.stringify(presented!.payload);
    expect(json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(json).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(json).not.toContain('sk-listsecretabcdefghijklmnopqrst');
    expect(json).toContain('plain');
  });

  it('ui-only 事件超过 64KB 时截断并带 _truncated 标记', () => {
    const big = 'x'.repeat(DEFAULT_MAX_EVENT_BYTES + 1);
    const event = makeEvent({ payload: { text: big } });
    const presented = presentEvent(event);
    expect(presented).not.toBeNull();
    expect(presented!.payload).toEqual({
      _truncated: true,
      bytes: Buffer.byteLength(JSON.stringify({ text: big }), 'utf8'),
    });
  });

  it('ui-only 事件恰好 64KB 不截断', () => {
    // 64KB 边界:构造 payload 使其 JSON 恰好等于上限
    const text = 'x'.repeat(DEFAULT_MAX_EVENT_BYTES - '{"text":""}'.length);
    const event = makeEvent({ payload: { text } });
    const presented = presentEvent(event);
    expect(presented).not.toBeNull();
    expect(presented!.payload).toEqual({ text });
  });

  it('S8: modelVisible 事件 512KB 不截断(放宽到 1MB)', () => {
    const text = 'x'.repeat(512 * 1024);
    const event = makeEvent({
      modelVisible: true,
      payload: { text },
    });
    const presented = presentEvent(event);
    expect(presented).not.toBeNull();
    expect(presented!.payload).toEqual({ text });
  });

  it('S8: modelVisible 事件 2MB 截断且带 _truncated', () => {
    const text = 'x'.repeat(2 * 1024 * 1024);
    const event = makeEvent({
      modelVisible: true,
      payload: { text },
    });
    const presented = presentEvent(event);
    expect(presented).not.toBeNull();
    expect(presented!.payload).toEqual({
      _truncated: true,
      bytes: Buffer.byteLength(JSON.stringify({ text }), 'utf8'),
    });
  });

  it('MODEL_VISIBLE_MAX_BYTES 为 1MB', () => {
    expect(MODEL_VISIBLE_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe('presentEvents', () => {
  it('空序列返回空数组', () => {
    expect(presentEvents([])).toEqual([]);
  });

  it('过滤 internal 事件,保留其余', () => {
    const events = [
      makeEvent({ seq: 1, type: 'turn/start' }),
      makeEvent({ seq: 2, type: 'internal/step', visibility: 'internal' }),
      makeEvent({ seq: 3, type: 'turn/end' }),
    ];
    const presented = presentEvents(events);
    expect(presented.map((e) => e.seq)).toEqual([1, 3]);
  });

  it('仅 ui-only 事件时正常投影', () => {
    const events = [
      makeEvent({ seq: 1, type: 'workflow/node-started' }),
      makeEvent({ seq: 2, type: 'gate/result' }),
    ];
    const presented = presentEvents(events);
    expect(presented).toHaveLength(2);
    expect(presented.every((e) => e.visibility === 'ui-only')).toBe(true);
  });
});

describe('buildModelVisibleView(模型可见视图)', () => {
  it('空序列返回空数组', () => {
    expect(buildModelVisibleView([])).toEqual([]);
  });

  it('仅 ui-only 事件时模型可见视图为空', () => {
    const events = [
      makeEvent({ seq: 1, type: 'workflow/node-started' }),
      makeEvent({ seq: 2, type: 'gate/result' }),
    ];
    expect(buildModelVisibleView(events)).toEqual([]);
  });

  it('混合可见性:只保留 modelVisible=true 且非 internal 的事件', () => {
    const events = [
      makeEvent({ seq: 1, type: 'user/message', modelVisible: true }),
      makeEvent({ seq: 2, type: 'workflow/node-started' }),
      makeEvent({ seq: 3, type: 'assistant/message', modelVisible: true }),
      makeEvent({
        seq: 4,
        type: 'internal/step',
        visibility: 'internal',
        modelVisible: true,
      }),
      makeEvent({ seq: 5, type: 'agent/status' }),
    ];
    const view = buildModelVisibleView(events);
    expect(view.map((e) => e.seq)).toEqual([1, 3]);
    expect(view.every((e) => e.modelVisible)).toBe(true);
  });

  it('modelVisible 事件经脱敏后进入视图', () => {
    const events = [
      makeEvent({
        seq: 1,
        type: 'user/message',
        modelVisible: true,
        payload: { text: 'key sk-abcdefghijklmnopqrstuvwxyz123456 here' },
      }),
    ];
    const view = buildModelVisibleView(events);
    expect(view).toHaveLength(1);
    expect(JSON.stringify(view[0].payload)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz123456',
    );
  });
});
