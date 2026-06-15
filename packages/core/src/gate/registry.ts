import type { GateResult, GateType } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { CommandGateway } from '../runtime/command-gateway.js';
import type { GateRunnerInput } from './helpers.js';
import { buildCommandGateDefinitions } from './runners/command.js';
import { securityScanGateDefinition } from './runners/security.js';
import { schemaGateDefinition } from './runners/schema.js';
import { reviewGateDefinitions } from './runners/review.js';
import { semanticGateDefinitions } from './runners/semantic.js';
import { humanGateDefinition } from './runners/human.js';

// ---------------------------------------------------------------------------
// Registry interfaces
// ---------------------------------------------------------------------------

export interface GateMetadata {
  /** Uses external command execution */
  commandLike: boolean;
  /** Can create pending human decisions */
  humanBlocking: boolean;
  /** Supports skipReason / not-applicable */
  supportsNotApplicable: boolean;
  /** Artifact types this gate validates */
  requiredEvidence: string[];
  /** Side effect classification */
  sideEffect: 'none' | 'creates-artifact' | 'creates-decision';
  /** Risk tags, e.g. ['security'], ['quality'] */
  riskTags: string[];
}

export type GateCategory =
  | 'command'
  | 'semantic'
  | 'human'
  | 'review'
  | 'validation';

export interface GateDefinition {
  type: GateType;
  category: GateCategory;
  tags: string[];
  metadata: GateMetadata;
  /** When true the runner is responsible for recording its own GateResult. */
  handlesOwnPersistence?: boolean;
  runner: (input: GateRunnerInput) => Promise<GateResult>;
}

export interface GateRegistry {
  get(type: GateType): GateDefinition | undefined;
  list(): GateDefinition[];
  listByCategory(category: GateCategory): GateDefinition[];
  has(type: string): boolean;
}

// ---------------------------------------------------------------------------
// Well-known gate type sets (used by eval / readiness modules)
// ---------------------------------------------------------------------------

export const COMMAND_GATE_TYPES: readonly GateType[] = [
  'build',
  'test',
  'lint',
  'e2e-pass',
] as const;

export const GOVERNANCE_GATE_TYPES: readonly GateType[] = [
  'independent-review',
  'role-scope',
  'ac-evidence',
  'qa-signoff',
  'process-completeness',
] as const;

// ---------------------------------------------------------------------------
// Built-in registry factory
// ---------------------------------------------------------------------------

export function createBuiltInGateRegistry(deps: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateRegistry {
  const definitions: GateDefinition[] = [
    ...buildCommandGateDefinitions(deps),
    securityScanGateDefinition(deps),
    schemaGateDefinition(deps),
    ...reviewGateDefinitions(deps),
    ...semanticGateDefinitions(deps),
    humanGateDefinition(deps),
  ];

  const byType = new Map<GateType, GateDefinition>();
  for (const def of definitions) {
    byType.set(def.type, def);
  }

  return {
    get(type: GateType): GateDefinition | undefined {
      return byType.get(type);
    },

    list(): GateDefinition[] {
      return [...definitions];
    },

    listByCategory(category: GateCategory): GateDefinition[] {
      return definitions.filter((def) => def.category === category);
    },

    has(type: string): boolean {
      return byType.has(type as GateType);
    },
  };
}
