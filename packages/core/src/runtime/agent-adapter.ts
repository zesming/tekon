import type { ArtifactStore } from '../artifact/store.js';
import type { CommandPolicy, RunContext, WorktreeLease } from '../types/config.js';
import type { Artifact, Role } from '../types/domain.js';

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
  artifactStore?: ArtifactStore;
}

export interface AgentRunResult {
  provider: 'mock' | 'claude-code' | 'custom';
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

export interface ProviderCapabilityMapping {
  sandbox: string;
  approval: string;
  filesystemScope: string[];
  network: string;
  toolAllow: string[];
  toolDeny: string[];
}

export function assertAgentProviderCapabilities(config: unknown): ProviderCapabilityMapping {
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
      network: 'disabled',
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
  const cannotProveControls =
    !profile.sandbox ||
    !profile.approval ||
    !profile.filesystemScope?.length ||
    !profile.network ||
    profile.sandbox === 'danger-full-access' ||
    profile.approval === 'never' ||
    profile.filesystemScope.includes('/') ||
    profile.network === 'enabled' ||
    (allow.includes('*') && deny.length === 0);

  if (cannotProveControls) {
    throw new Error('cannot prove safe provider controls for real agent execution');
  }

  const { sandbox, approval, filesystemScope, network } = profile as {
    sandbox: string;
    approval: string;
    filesystemScope: string[];
    network: string;
  };

  return {
    sandbox,
    approval,
    filesystemScope,
    network,
    toolAllow: allow,
    toolDeny: deny,
  };
}
