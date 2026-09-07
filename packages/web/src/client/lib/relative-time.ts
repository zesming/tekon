const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 将 ISO 时间格式化为中文相对时间。
 * `nowMs` 由调用方显式传入，使同一列表渲染共享同一个时钟，也让边界测试保持确定性。
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const timestampMs = Date.parse(iso);
  if (Number.isNaN(timestampMs) || !Number.isFinite(nowMs)) return iso;

  const diffMs = nowMs - timestampMs;
  if (diffMs < 0 || diffMs < MINUTE_MS) return '刚刚';
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}分钟前`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}小时前`;

  const diffDays = Math.floor(diffMs / DAY_MS);
  if (diffDays <= 7) return `${diffDays}天前`;
  return new Date(timestampMs).toLocaleDateString('zh-CN');
}
