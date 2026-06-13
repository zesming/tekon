import type { DemandShape } from '@tekon/core';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AcceptanceCriteriaProps {
  criteria: DemandShape['acceptanceCriteria'];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the list of acceptance criteria from a demand shape.
 *
 * Each item shows the criterion ID (e.g. AC-1), its description,
 * and a secondary line with the verification method.
 */
export function AcceptanceCriteria({ criteria }: AcceptanceCriteriaProps) {
  if (criteria.length === 0) {
    return (
      <p className="text-sm text-muted" style={{ padding: '8px 0' }}>
        No acceptance criteria defined.
      </p>
    );
  }

  return (
    <ol className="ac-list">
      {criteria.map((criterion) => (
        <li key={criterion.id} className="ac-item">
          <span className="ac-id">{criterion.id}</span>
          {criterion.description}
          <span className="ac-verification">
            验证 Verification: {criterion.verification}
          </span>
        </li>
      ))}
    </ol>
  );
}
