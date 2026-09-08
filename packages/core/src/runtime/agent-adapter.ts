import type { ArtifactStore } from '../artifact/store.js';
import { redactSecrets } from '../security/secrets.js';
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
import { artifactTypeSchema } from '../types/domain.js';

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

/**
 * A bounded, redaction-safe reason for a provider run that reached the
 * adapter boundary but cannot be accepted as successful.  Keep the
 * structured fields small and stable: durable events and node interruption
 * audits must explain the failure without persisting provider output.
 */
export type AgentRunDiagnosticCode =
  | 'artifact-manifest-missing'
  | 'artifact-manifest-invalid-json'
  | 'artifact-manifest-schema-invalid'
  | 'artifact-manifest-invalid-path'
  | 'artifact-manifest-unreadable'
  | 'artifact-file-missing'
  | 'artifact-file-invalid-json'
  | 'artifact-file-schema-invalid'
  | 'artifact-file-invalid-path'
  | 'artifact-file-unreadable'
  | 'required-artifacts-missing';

export interface AgentRunDiagnostic {
  code: AgentRunDiagnosticCode;
  message: string;
  artifactType?: ArtifactType;
  /** Display-safe relative artifact or manifest path. */
  path?: string;
  /** Display-safe schema field path, when a schema issue identifies one. */
  field?: string;
}

const MAX_AGENT_DIAGNOSTIC_MESSAGE_CHARS = 500;
const MAX_AGENT_DIAGNOSTIC_FIELD_CHARS = 160;
const AGENT_RUN_DIAGNOSTIC_CODES = new Set<AgentRunDiagnosticCode>([
  'artifact-manifest-missing',
  'artifact-manifest-invalid-json',
  'artifact-manifest-schema-invalid',
  'artifact-manifest-invalid-path',
  'artifact-manifest-unreadable',
  'artifact-file-missing',
  'artifact-file-invalid-json',
  'artifact-file-schema-invalid',
  'artifact-file-invalid-path',
  'artifact-file-unreadable',
  'required-artifacts-missing',
]);

/** Keep custom adapter diagnostics safe before they enter durable events. */
export function sanitizeAgentRunDiagnostic(
  diagnostic: AgentRunDiagnostic | undefined,
): AgentRunDiagnostic | undefined {
  if (!diagnostic) return undefined;
  const code = AGENT_RUN_DIAGNOSTIC_CODES.has(diagnostic.code)
    ? diagnostic.code
    : 'artifact-file-unreadable';
  const artifactType = artifactTypeSchema.safeParse(diagnostic.artifactType);
  return {
    code,
    message: boundRedactedText(
      diagnostic.message,
      MAX_AGENT_DIAGNOSTIC_MESSAGE_CHARS,
    ),
    ...(artifactType.success ? { artifactType: artifactType.data } : {}),
    ...(diagnostic.path
      ? { path: boundRedactedText(diagnostic.path) }
      : {}),
    ...(diagnostic.field
      ? { field: boundRedactedText(diagnostic.field) }
      : {}),
  };
}

export function formatAgentRunDiagnostic(
  diagnostic: AgentRunDiagnostic | undefined,
): string | undefined {
  return sanitizeAgentRunDiagnostic(diagnostic)?.message;
}

function boundRedactedText(
  value: string,
  max = MAX_AGENT_DIAGNOSTIC_FIELD_CHARS,
): string {
  const redacted = redactSecrets(String(value)).content;
  return redacted.length > max
    ? `${redacted.slice(0, Math.max(0, max - 1))}…`
    : redacted;
}

export interface AgentRunResult {
  provider: 'mock' | 'claude-code' | 'codex' | 'dsh-headless' | 'custom';
  exitCode: number | null;
  durationMs: number;
  outputFiles: string[];
  artifacts?: Artifact[];
  /** Final assistant prose when the provider exposes a documented boundary. */
  assistantText?: string;
  timedOut?: boolean;
  /** adapter 因 signal abort 提前返回时置 true（exitCode 为 null）。 */
  cancelled?: boolean;
  /** Structured, redaction-safe reason for an adapter-level failure. */
  diagnostic?: AgentRunDiagnostic;
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
