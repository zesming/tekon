import type { ArtifactStore } from '../artifact/store.js';
import type {
  AgentAdapterConfig,
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
  /**
   * 取消信号（阶段 1 取消传播链，设计 §2.8）。adapter 应在信号 abort 时
   * 尽快中断子进程并返回 `cancelled: true` 的结果。
   */
  signal?: AbortSignal;
}

export interface AgentRunResult {
  provider: 'mock' | 'claude-code' | 'codex' | 'dsh-headless' | 'custom';
  exitCode: number | null;
  durationMs: number;
  outputFiles: string[];
  artifacts?: Artifact[];
  timedOut?: boolean;
  /** adapter 因 signal abort 提前返回时置 true（exitCode 为 null）。 */
  cancelled?: boolean;
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
  config: AgentAdapterConfig,
): ProviderCapabilityMapping {
  const candidate = config;

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
  // Network egress must be provably contained (disabled/restricted) for every
  // provider — EXCEPT a dsh-headless config that has explicitly acknowledged
  // unrestricted egress (phase 5b, design §17 decision 3 / §18.1). dsh's
  // sandbox governs file effects only; no flag/env can disable network, so an
  // honest declaration is `enabled`. We accept that ONLY behind the explicit
  // acknowledgment bit so the guard stays fail-closed for codex/claude and for
  // a misconfigured dsh; a lie of `restricted` is never how dsh passes.
  const acknowledgedUnrestrictedNetwork =
    candidate.provider === 'dsh-headless' &&
    candidate.acknowledgeUnrestrictedNetwork === true;
  const hasSupportedNetworkMode =
    network === 'disabled' ||
    network === 'restricted' ||
    (network === 'enabled' && acknowledgedUnrestrictedNetwork);
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
      mode: network as 'disabled' | 'restricted' | 'enabled',
      enforcement: 'declared',
      allowHosts: [],
      evidence: acknowledgedUnrestrictedNetwork
        ? [
            'dsh headless sandbox governs file effects only; network egress is ' +
              'unrestricted and explicitly acknowledged (no dsh mechanism can ' +
              'contain it — design §18.1)',
          ]
        : ['provider permission profile declares network control'],
    },
    toolAllow: allow,
    toolDeny: deny,
  };
}
