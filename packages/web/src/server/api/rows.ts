export interface ProjectRow {
  id: string;
  name: string;
  repo_path: string;
  created_at: string;
}

export interface WorkflowRow {
  id: string;
  project_id: string;
  demand_id: string;
  status: string;
  current_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GateRow {
  id: string;
  run_id: string;
  node_id: string;
  gate_type: string;
  status: string;
  output_path: string | null;
  duration_ms: number;
  retries: number;
  fix_attempt_id: string | null;
  failure_classification: string | null;
  created_at: string;
}

export interface NodeRow {
  id: string;
  run_id: string;
  phase_id: string | null;
  role: string;
  status: string;
  gates: string;
  dependencies: string;
  created_at: string;
  updated_at: string;
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  node_id: string;
  type: string;
  version: number;
  path: string;
  sha256: string;
  size_bytes: number;
  summary: string | null;
  created_at: string;
}

export interface HumanDecisionRow {
  id: string;
  run_id: string;
  node_id: string;
  gate_result_id: string | null;
  status: string;
  actor: string | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}
