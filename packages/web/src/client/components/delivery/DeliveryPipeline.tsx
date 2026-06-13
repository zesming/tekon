import type { ApiReviewDeliverySurface } from '../../../shared/api-types.js';

// ---------------------------------------------------------------------------
// DeliveryPipeline — 5-step stepper visualization
// ---------------------------------------------------------------------------

interface DeliveryPipelineProps {
  delivery: ApiReviewDeliverySurface;
  workflowStatus: string;
}

type StepState = 'done' | 'current' | 'waiting';

interface Step {
  label: string;
  subLabel?: string;
  state: StepState;
  icon: string;
}

function deriveSteps(
  delivery: ApiReviewDeliverySurface,
  workflowStatus: string,
): Step[] {
  const wfDone = workflowStatus === 'passed' || workflowStatus === 'completed';
  const hasPr = delivery.prUrl !== null;
  const hasPackage = delivery.package !== null && delivery.package.exists;
  const hasBody = delivery.prBody !== null && delivery.prBody.exists;
  const prepared = hasPackage || hasBody;
  const isCreated = delivery.status === 'pr-created' || hasPr;

  // Determine which step is "current"
  let currentIdx = 0;
  if (wfDone) currentIdx = 1;
  if (wfDone && prepared) currentIdx = 2;
  if (wfDone && prepared && delivery.status !== 'pending') currentIdx = 3;
  if (isCreated) currentIdx = 4;

  return [
    {
      label: 'Workflow',
      subLabel: 'Passed',
      state: wfDone ? 'done' : currentIdx === 0 ? 'current' : 'waiting',
      icon: wfDone ? '✓' : '◌',
    },
    {
      label: 'PR Prepared',
      subLabel:
        delivery.diff.branch !== ''
          ? delivery.diff.branch
          : undefined,
      state:
        currentIdx > 1
          ? 'done'
          : currentIdx === 1
            ? 'current'
            : 'waiting',
      icon: currentIdx > 1 ? '✓' : currentIdx === 1 ? '◌' : '→',
    },
    {
      label: 'Awaiting',
      subLabel: 'Approval',
      state:
        currentIdx > 2
          ? 'done'
          : currentIdx === 2
            ? 'current'
            : 'waiting',
      icon: currentIdx > 2 ? '✓' : currentIdx === 2 ? '◌' : '→',
    },
    {
      label: 'Branch',
      subLabel: 'Push',
      state:
        currentIdx > 3
          ? 'done'
          : currentIdx === 3
            ? 'current'
            : 'waiting',
      icon: currentIdx > 3 ? '✓' : currentIdx === 3 ? '◌' : '→',
    },
    {
      label: 'PR Create',
      subLabel: isCreated && delivery.prUrl ? 'view' : 'gh pr create',
      state:
        currentIdx > 4
          ? 'done'
          : currentIdx === 4
            ? 'current'
            : 'waiting',
      icon: currentIdx > 4 ? '✓' : currentIdx === 4 ? '◌' : '→',
    },
  ];
}

export function DeliveryPipeline({
  delivery,
  workflowStatus,
}: DeliveryPipelineProps) {
  const steps = deriveSteps(delivery, workflowStatus);

  return (
    <div className="delivery-card">
      {steps.map((step, idx) => (
        <span key={step.label} style={{ display: 'contents' }}>
          <div className="delivery-step">
            <div className={`delivery-icon ${step.state}`}>{step.icon}</div>
            <div className="delivery-label">
              {step.label}
              {step.subLabel ? (
                <>
                  <br />
                  <span className="text-mono" style={{ fontSize: '10px' }}>
                    {step.subLabel}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          {idx < steps.length - 1 ? (
            <div
              className={`delivery-arrow${step.state === 'done' ? ' done' : ''}`}
            />
          ) : null}
        </span>
      ))}
    </div>
  );
}
