import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

export type BindingPreview = Pick<RpcProcedureMap['workflow.plan']['output'], 'digest' | 'comparisonScope' | 'gates'>;
type PreviewGate = BindingPreview['gates'][number];
export interface GateBindingChange {
  kind: 'added' | 'removed' | 'changed';
  nodeId: string;
  gateIndex: number;
  type: string;
}
export interface PlanBindingComparison {
  status: 'initial' | 'unavailable' | 'unchanged' | 'changed';
  changes: GateBindingChange[];
  settingsChanged: boolean;
}

const gatePosition = (gate: PreviewGate) => JSON.stringify([gate.nodeId, gate.gateIndex]);

function hasComparableFacts(plan: BindingPreview): boolean {
  return Boolean(plan.comparisonScope) &&
    plan.gates.every((gate) => Number.isInteger(gate.gateIndex) && gate.gateIndex! >= 0 && Boolean(gate.commandBinding?.fingerprint)) &&
    new Set(plan.gates.map(gatePosition)).size === plan.gates.length;
}

/** 比较服务端提供的不透明标识；不重建命令、摘要或授权决定。 */
export function comparePlanCommandBindings(
  previous: BindingPreview | undefined,
  current: BindingPreview | undefined,
): PlanBindingComparison {
  const empty = { changes: [], settingsChanged: false };
  if (!current || !hasComparableFacts(current)) return { ...empty, status: 'unavailable' };
  if (!previous) return { ...empty, status: 'initial' };
  if (!hasComparableFacts(previous) || previous.comparisonScope !== current.comparisonScope) {
    return { ...empty, status: 'unavailable' };
  }
  const oldGates = new Map(previous.gates.map((gate) => [gatePosition(gate), gate]));
  const changes: GateBindingChange[] = [];
  for (const gate of current.gates) {
    const key = gatePosition(gate);
    const old = oldGates.get(key);
    if (!old || old.commandBinding!.fingerprint !== gate.commandBinding!.fingerprint) {
      changes.push({ kind: old ? 'changed' : 'added', nodeId: gate.nodeId, gateIndex: gate.gateIndex!, type: gate.type });
    }
    oldGates.delete(key);
  }
  for (const gate of oldGates.values()) {
    changes.push({ kind: 'removed', nodeId: gate.nodeId, gateIndex: gate.gateIndex!, type: gate.type });
  }
  const settingsChanged = changes.length === 0 && previous.digest !== current.digest;
  return { status: changes.length > 0 || settingsChanged ? 'changed' : 'unchanged', changes, settingsChanged };
}
