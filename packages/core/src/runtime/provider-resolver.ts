import type { AgentAdapter } from './agent-adapter.js';
import type {
  ApprovalDefault,
  ProviderRuntimeOverrides,
} from './agent-runtime.js';
import {
  createCommandGateway,
  type CommandGateway,
} from './command-gateway.js';
import {
  createBuiltInProviderRegistry,
  type ProviderRegistry,
} from './provider-registry.js';

export interface ResolvedProviderAdapter {
  driver: string;
  adapter: AgentAdapter;
}

/**
 * Node-level adapter resolver that eliminates the single-provider-per-run
 * bottleneck (ROLE_DRIVER_MISMATCH). Each workflow node resolves its own
 * driver independently and caches the adapter instance per run.
 */
export interface ProviderAdapterResolver {
  resolve(driver: string): ResolvedProviderAdapter;
  has(driver: string): boolean;
  defaultDriver: string;
}

export interface CreateProviderAdapterResolverOptions {
  repoPath: string;
  defaultDriver: string;
  gateway?: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
  approvalDefault?: ApprovalDefault;
  registry?: ProviderRegistry;
  /** Optional explicit adapter map (used by tests & multi-provider stubs). */
  adapters?: Record<string, AgentAdapter>;
}

export function createProviderAdapterResolver(
  options: CreateProviderAdapterResolverOptions,
): ProviderAdapterResolver {
  const registry = options.registry ?? createBuiltInProviderRegistry();
  const gateway = options.gateway ?? createCommandGateway();
  const cache = new Map<string, AgentAdapter>();

  if (options.adapters) {
    for (const [driver, adapter] of Object.entries(options.adapters)) {
      cache.set(driver, adapter);
    }
  }

  return {
    defaultDriver: options.defaultDriver,
    has(driver: string): boolean {
      return cache.has(driver) || registry.has(driver);
    },
    resolve(driver: string): ResolvedProviderAdapter {
      const effectiveDriver = driver.trim() || options.defaultDriver;
      const existing = cache.get(effectiveDriver);
      if (existing) {
        return { driver: effectiveDriver, adapter: existing };
      }

      const def = registry.get(effectiveDriver);
      if (!def) {
        throw new Error(
          `PROVIDER_NOT_REGISTERED: 未注册的执行驱动 '${effectiveDriver}'。可用驱动：${[
            ...new Set([...cache.keys(), ...registry.list().map((d) => d.name)]),
          ].join(', ')}`,
        );
      }

      const created = def.create({
        agent: def.name,
        repoPath: options.repoPath,
        gateway,
        runtime: options.runtime,
        approvalDefault: options.approvalDefault,
      });
      cache.set(effectiveDriver, created.adapter);
      return { driver: effectiveDriver, adapter: created.adapter };
    },
  };
}
