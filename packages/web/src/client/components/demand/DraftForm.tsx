import { useState } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DraftFormProps {
  /** Called when the user clicks "澄清需求 Clarify". */
  onSubmit: (demandText: string) => void;
  /** Whether a shape mutation is currently in progress. */
  isPending?: boolean;
  /** Error message to display, if any. */
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Draft input form: a textarea plus a "澄清需求 Clarify" submit button.
 *
 * Matches the "新建需求 New Draft" card in the design mockup.
 */
export function DraftForm({
  onSubmit,
  isPending = false,
  error = null,
}: DraftFormProps) {
  const [demandText, setDemandText] = useState('');

  const handleSubmit = () => {
    if (!demandText.trim()) return;
    onSubmit(demandText.trim());
  };

  return (
    <div className="card mb-6">
      <div className="card-header">
        <span className="card-title">新建需求 New Draft</span>
      </div>
      <div className="card-body">
        <div className="form-group">
          <textarea
            className="textarea"
            aria-label="描述你的需求"
            placeholder="描述你的需求，例如：为 Tekon Web UI 添加运行指标的 API 端点，支持按时间范围查询 gate 通过率、产物数量和审计事件统计"
            value={demandText}
            onChange={(e) => setDemandText(e.target.value)}
            disabled={isPending}
          />
        </div>

        <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={isPending || !demandText.trim()}
            onClick={handleSubmit}
          >
            {isPending ? '⏳ 分析中…' : '✦ 澄清需求 Clarify'}
          </button>
        </div>

        {error && (
          <p
            className="text-sm"
            style={{ color: 'var(--fail)', marginTop: 8 }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backward-compatible deprecated exports
// ---------------------------------------------------------------------------

/** @deprecated Use DraftFormProps instead */
export type DemandFormProps = DraftFormProps;

/** @deprecated Use DraftForm instead */
export const DemandForm = DraftForm;
