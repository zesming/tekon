// ---------------------------------------------------------------------------
// CheckList — pass/fail checklist with evidence and optional severity
//
// Primary display uses natural-language Chinese labels.
// Technical check IDs appear as tooltips when different from labels.
// "Why this matters" tooltip shown via ⓘ info icon.
// Failed checks show a "what to do" suggestion row beneath.
// ---------------------------------------------------------------------------

import { Fragment } from 'react';
import {
  getCheckLabel,
  getCheckSuggestion,
  getCheckDescription,
  checkState,
  checkStateLabel,
} from '../../lib/check-labels.js';

interface CheckItem {
  id: string;
  passed: boolean;
  state?: 'passed' | 'failed' | 'not-started' | null;
  evidence: string;
  severity?: 'required' | 'recommended' | 'context';
}

interface CheckListProps {
  items: CheckItem[];
}

export function CheckList({ items }: CheckListProps) {
  return (
    <div className="check-list">
      {items.map((check) => {
        const labelText = getCheckLabel(check.id);
        const desc = getCheckDescription(check.id);
        const state = checkState(check);
        const failedSuggestion = state === 'failed'
          ? getCheckSuggestion(check.id)
          : null;
        const iconClass =
          state === 'passed' ? 'pass' : state === 'not-started' ? 'idle' : 'fail';

        return (
          <Fragment key={check.id}>
            <div className="check-item">
              <span className={`check-icon ${iconClass}`} title={checkStateLabel(state)}>
                {state === 'passed' ? '✓' : state === 'not-started' ? '—' : '✕'}
              </span>
              <span
                className="check-label"
                title={check.id !== labelText ? `ID: ${check.id}` : undefined}
              >
                {labelText}
                {check.severity && (
                  <span className={`check-severity ${check.severity}`}>
                    {check.severity}
                  </span>
                )}
                {desc && (
                  <span className="check-info-icon" title={desc}>
                    ⓘ
                  </span>
                )}
              </span>
              <span
                className="check-evidence"
                style={state === 'failed' ? { color: 'var(--fail)' } : undefined}
                title={check.evidence}
              >
                {check.evidence}
              </span>
            </div>
            {failedSuggestion && (
              <div className="check-suggestion">
                <span className="check-suggestion-label">建议 </span>
                {failedSuggestion}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
