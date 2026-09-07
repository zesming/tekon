import type { DecisionOutput } from '../../shared/api-types.js';

export function approvalFeedback(result: DecisionOutput) {
  return result.resumeOutcome === 'enqueued'
    ? { variant: 'success' as const, message: '审批已记录，运行恢复已入队。' }
    : { variant: 'warning' as const, message: `审批已记录，运行尚未恢复。${result.resumeMessage ?? '请核对当前运行状态后处理。'}` };
}
