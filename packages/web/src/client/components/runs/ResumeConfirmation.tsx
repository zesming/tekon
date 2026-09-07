import type { ApiWorkflow } from '../../../shared/api-types.js';

export function ResumeConfirmation({ recovery, checked, disabled, onChange }: {
  recovery?: ApiWorkflow['recovery']; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  const resume = recovery?.resumeRecovery;
  if (!resume?.requiresConfirmation) return null;
  return (
    <label className="run-recovery-confirmation">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      旧进程退出未确认。我已检查并停止旧进程（{resume.previousJobId ?? '历史运行：无 Job 记录'}），确认恢复此运行。
    </label>
  );
}
