import { useState } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DemandFormProps {
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
 * Demand input form: a textarea plus a "澄清需求 Clarify" submit button.
 *
 * Matches the "新建需求 New Demand" card in the design mockup.
 */
export function DemandForm({
  onSubmit,
  isPending = false,
  error = null,
}: DemandFormProps) {
  const [demandText, setDemandText] = useState('');

  const handleSubmit = () => {
    if (!demandText.trim()) return;
    onSubmit(demandText.trim());
  };

  return (
    <div className="card mb-6">
      <div className="card-header">
        <span className="card-title">新建需求 New Demand</span>
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
