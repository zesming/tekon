/**
 * Format plan attributes for human presentation.
 */

/**
 * Format milliseconds into human-readable duration (e.g. 3600000 -> "60 分钟", 60000 -> "1 分钟", 30000 -> "30 秒").
 */
export function formatTimeout(timeoutMs?: number | null): string {
  if (
    timeoutMs === undefined ||
    timeoutMs === null ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return '无限制';
  }
  if (timeoutMs < 1000) {
    return `${timeoutMs} 毫秒`;
  }
  const seconds = Math.round(timeoutMs / 1000);
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600} 小时`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} 分钟`;
}

/**
 * Format phase execution mode into readable text.
 */
export function formatPhaseParallel(parallel: boolean): string {
  return parallel ? '并行阶段' : '顺序阶段';
}
