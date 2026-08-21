import { redactSecrets } from '../security/secrets.js';
import type {
  EventVisibility,
  SessionEvent,
} from '../types/session-contract.js';

/**
 * Present 投影(阶段 1 S6)。
 *
 * 设计权威:`docs/superpowers/plans/2026-08-21-phase1-event-spine-detailed-design.md`
 * §3.2(脱敏与限长)、§0.2-21 / S8(modelVisible 放宽到 1MB)。
 *
 * 职责:把 session_events 行投影为可下发给 UI / 模型的视图——
 * - 递归对 payload 字符串值跑 redactSecrets(C5:永不携带 token/密钥);
 * - 剔除 visibility=internal 的事件(不下发);
 * - 限长:modelVisible 事件 1MB(S8 放宽),其余 64KB;超限截断为
 *   `{_truncated: true, bytes: n}`(bytes = 脱敏后 payload 的 JSON 字节数)。
 *
 * 纯函数式投影:输入事件列表 → 输出视图,不触碰 db / bus,便于测试。
 * spill reference 阶段 2 才有,本阶段仅放宽上限(见 MODEL_VISIBLE_MAX_BYTES)。
 */

export const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

/**
 * S8:modelVisible 事件的限长上限放宽到 1MB。
 * TODO(阶段 2):超限改为 spill reference(事件载荷外置 + 引用),而非截断。
 */
export const MODEL_VISIBLE_MAX_BYTES = 1024 * 1024;

export interface PresentedEvent {
  seq: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
  visibility: EventVisibility;
  modelVisible: boolean;
  correlationId: string | null;
}

/**
 * 投影单个事件。internal 事件返回 null(不下发),由 presentEvents 过滤。
 */
export function presentEvent(event: SessionEvent): PresentedEvent | null {
  if (event.visibility === 'internal') {
    return null;
  }
  const redacted = redactPayloadDeep(event.payload) as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(redacted), 'utf8');
  const maxBytes = event.modelVisible
    ? MODEL_VISIBLE_MAX_BYTES
    : DEFAULT_MAX_EVENT_BYTES;
  const payload =
    bytes > maxBytes ? { _truncated: true, bytes } : redacted;
  return {
    seq: event.seq,
    type: event.type,
    timestamp: event.timestamp,
    payload,
    visibility: event.visibility,
    modelVisible: event.modelVisible,
    correlationId: event.correlationId,
  };
}

/**
 * 列表投影:过滤 internal 事件,逐个 presentEvent。
 * 对应 SSE 下发前的传输层视图(§3.1 步骤 9 的 data 字段)。
 */
export function presentEvents(
  events: readonly SessionEvent[],
): PresentedEvent[] {
  const presented: PresentedEvent[] = [];
  for (const event of events) {
    const p = presentEvent(event);
    if (p) {
      presented.push(p);
    }
  }
  return presented;
}

/**
 * 模型可见视图(model-visible projection):从事件列表中投影出
 * modelVisible=true 且非 internal 的事件(经脱敏/限长)。
 * 对应"模型能看到的事件历史"。
 */
export function buildModelVisibleView(
  events: readonly SessionEvent[],
): PresentedEvent[] {
  return presentEvents(events).filter((e) => e.modelVisible);
}

function redactPayloadDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value).content;
  }
  if (Array.isArray(value)) {
    return value.map(redactPayloadDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactPayloadDeep(v),
      ]),
    );
  }
  return value;
}
