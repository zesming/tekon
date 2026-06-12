import { Card } from '../../components/ui/Card.js';
import { CodeBlock } from '../../components/ui/CodeBlock.js';

// ---------------------------------------------------------------------------
// ConstraintsTab — display constraint rules grouped by severity category
//
// NOTE: There is no constraint.list RPC procedure yet. This tab displays
// a static reference of the project's constraint rules from the architecture.
// Replace with a live query when the backend endpoint is available.
// ---------------------------------------------------------------------------

interface ConstraintRule {
  id: string;
  description: string;
  appliesTo?: string[];
}

const hardConstraints: ConstraintRule[] = [
  { id: 'no-force-push', description: '禁止 git push --force' },
  { id: 'no-rm-rf', description: '禁止 rm -rf / 等危险操作' },
];

const conditionalConstraints: ConstraintRule[] = [
  {
    id: 'human-approval-for-high-risk',
    description: '高风险路径变更需要人工审批',
    appliesTo: ['high-risk-paths'],
  },
];

const softConstraints: ConstraintRule[] = [
  { id: 'prefer-workspace-write', description: '优先使用 workspace-write 沙箱模式' },
];

/** YAML representation for the code-block fallback view. */
const constraintsYaml = `constraints:
  hard:
    - id: no-force-push
      description: "禁止 git push --force"
    - id: no-rm-rf
      description: "禁止 rm -rf / 等危险操作"
  conditional:
    - id: human-approval-for-high-risk
      description: "高风险路径变更需要人工审批"
      appliesTo: ["high-risk-paths"]
  soft:
    - id: prefer-workspace-write
      description: "优先使用 workspace-write 沙箱模式"`;

// ---------------------------------------------------------------------------

export function ConstraintsTab() {
  return (
    <Card title="约束规则 Constraints" full>
      {/* ── Hard constraints ── */}
      <div className="constraint-category">
        <div className="constraint-category-title hard">
          🔴 Hard Constraints
        </div>
        {hardConstraints.map((rule) => (
          <div key={rule.id} className="constraint-item hard">
            <div className="constraint-id">{rule.id}</div>
            <div className="constraint-desc">{rule.description}</div>
          </div>
        ))}
      </div>

      {/* ── Conditional constraints ── */}
      <div className="constraint-category">
        <div className="constraint-category-title conditional">
          🟡 Conditional Constraints
        </div>
        {conditionalConstraints.map((rule) => (
          <div key={rule.id} className="constraint-item conditional">
            <div className="constraint-id">{rule.id}</div>
            <div className="constraint-desc">{rule.description}</div>
            {rule.appliesTo !== undefined && rule.appliesTo.length > 0 && (
              <div className="constraint-applies">
                Applies to:{' '}
                {rule.appliesTo.map((tag) => (
                  <span key={tag} className="badge-tag accent" style={{ marginRight: '4px' }}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Soft constraints ── */}
      <div className="constraint-category">
        <div className="constraint-category-title soft">
          🟢 Soft Constraints
        </div>
        {softConstraints.map((rule) => (
          <div key={rule.id} className="constraint-item soft">
            <div className="constraint-id">{rule.id}</div>
            <div className="constraint-desc">{rule.description}</div>
          </div>
        ))}
      </div>

      {/* ── Raw YAML reference ── */}
      <div style={{ marginTop: '24px' }}>
        <div
          className="detail-section-title"
          style={{ marginBottom: '10px' }}
        >
          Raw YAML
        </div>
        <CodeBlock content={constraintsYaml} />
      </div>
    </Card>
  );
}
