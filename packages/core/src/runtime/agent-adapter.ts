import type { ArtifactStore } from '../artifact/store.js';
import type {
  CommandPolicy,
  RunContext,
  WorktreeLease,
} from '../types/config.js';
import type {
  Artifact,
  ArtifactType,
  Node,
  NodeStatus,
  Role,
} from '../types/domain.js';

export interface RoleConfig {
  role: Role;
  name?: string;
}

export interface AgentRunInput {
  roleConfig: RoleConfig;
  prompt: string;
  worktreeLease: WorktreeLease;
  outputDir: string;
  commandPolicy: CommandPolicy;
  runContext: RunContext;
  nodeInputs?: Node['inputs'];
  nodeDependencies?: string[];
  deliveryRef?: string;
  priorNodes?: Array<{
    id: string;
    role: Role;
    status: NodeStatus;
    outputs?: Node['outputs'];
    gates?: Node['gates'];
  }>;
  artifactStore?: ArtifactStore;
  requiredArtifactTypes?: ArtifactType[];
}

export interface AgentRunResult {
  provider: 'mock' | 'claude-code' | 'codex' | 'custom';
  exitCode: number | null;
  durationMs: number;
  outputFiles: string[];
  artifacts?: Artifact[];
  timedOut?: boolean;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface AgentAdapter {
  runAgent(input: AgentRunInput): Promise<AgentRunResult>;
}

export type NetworkEnforcement =
  | 'declared'
  | 'provider-enforced'
  | 'os-enforced';

export interface NetworkCapabilityEvidence {
  mode: 'disabled' | 'restricted' | 'enabled';
  enforcement: NetworkEnforcement;
  allowHosts: string[];
  evidence: string[];
}

export interface ProviderCapabilityMapping {
  sandbox: string;
  approval: string;
  filesystemScope: string[];
  network: NetworkCapabilityEvidence;
  toolAllow: string[];
  toolDeny: string[];
}

export function assertAgentProviderCapabilities(
  config: unknown,
): ProviderCapabilityMapping {
  const candidate = config as {
    provider?: string;
    permissionProfile?: {
      sandbox?: string;
      approval?: string;
      filesystemScope?: string[];
      network?: string;
      tools?: { allow?: string[]; deny?: string[] };
    };
  };

  if (candidate.provider === 'mock') {
    return {
      sandbox: 'in-process',
      approval: 'not-required',
      filesystemScope: [],
      network: {
        mode: 'disabled',
        enforcement: 'declared',
        allowHosts: [],
        evidence: ['mock provider does not spawn a child process'],
      },
      toolAllow: [],
      toolDeny: [],
    };
  }

  if (!candidate.permissionProfile) {
    throw new Error('permission profile is required for real agent providers');
  }

  const profile = candidate.permissionProfile;
  const allow = profile.tools?.allow ?? [];
  const deny = profile.tools?.deny ?? [];
  const network = profile.network;
  const hasSupportedNetworkMode =
    network === 'disabled' || network === 'restricted';
  if (!hasSupportedNetworkMode) {
    throw new Error(
      'cannot prove safe provider controls for real agent execution',
    );
  }

  const cannotProveControls =
    !profile.sandbox ||
    !profile.approval ||
    !profile.filesystemScope?.length ||
    profile.sandbox === 'danger-full-access' ||
    profile.approval === 'never' ||
    profile.filesystemScope.includes('/') ||
    (allow.includes('*') && deny.length === 0);

  if (cannotProveControls) {
    throw new Error(
      'cannot prove safe provider controls for real agent execution',
    );
  }

  const { sandbox, approval, filesystemScope } = profile as {
    sandbox: string;
    approval: string;
    filesystemScope: string[];
  };

  return {
    sandbox,
    approval,
    filesystemScope,
    network: {
      mode: network as 'disabled' | 'restricted',
      enforcement: 'declared',
      allowHosts: [],
      evidence: ['provider permission profile declares network control'],
    },
    toolAllow: allow,
    toolDeny: deny,
  };
}
