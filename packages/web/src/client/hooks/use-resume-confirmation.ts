import { useState } from 'react';
import type { ApiWorkflow } from '../../shared/api-types.js';

/** 用户确认只绑定当前 Run / Job 代次，不推导物理退出。 */
export function useResumeConfirmation(runId: string | null, recovery: ApiWorkflow['recovery']) {
  const [confirmation, setConfirmation] = useState<{ runId: string; previousJobId: string | null } | null>(null);
  const resume = recovery?.resumeRecovery;
  const required = Boolean(resume?.requiresConfirmation);
  const confirmed = Boolean(resume && confirmation?.runId === runId && confirmation?.previousJobId === resume.previousJobId);
  return {
    required,
    confirmed,
    setConfirmed: (checked: boolean) => setConfirmation(checked && runId && resume ? { runId, previousJobId: resume.previousJobId } : null),
    input: required && confirmed && resume ? { confirmStopped: true, previousJobId: resume.previousJobId } : {},
  };
}
