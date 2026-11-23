import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  findExecutable,
  probeProvider,
  type ProviderAuthKind,
  type ProviderProbeDeps,
} from './provider-probe.js';

export type DiscoveredAgentStatus =
  | 'ready'
  | 'unauthenticated'
  | 'not_installed'
  | 'unsupported';

export interface DiscoveredAgent {
  id: string;
  name: string;
  iconKey: string;
  status: DiscoveredAgentStatus;
  executable?: boolean;
  authKind?: ProviderAuthKind;
  version?: string;
  loginHint?: string;
  installHint?: string;
  unsupportedHint?: string;
  models: string[];
  efforts: string[];
  modelEfforts?: Record<string, string[]>;
  source: 'built-in' | 'user-config';
}

export interface AgentDiscoverySnapshot {
  probedAt: string;
  agents: DiscoveredAgent[];
}

const userAgentEntrySchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/u),
    name: z.string().min(1).max(80).optional(),
    iconKey: z.string().min(1).max(40).optional(),
    command: z.string().min(1).max(256).optional(),
    models: z.array(z.string().min(1).max(128)).min(1),
    efforts: z.array(z.string().min(1).max(32)).default(['default']),
    modelEfforts: z
      .record(z.string().min(1), z.array(z.string().min(1).max(32)).min(1))
      .optional(),
    loginHint: z.string().max(240).optional(),
    installHint: z.string().max(240).optional(),
  })
  .strict();

const userAgentsFileSchema = z
  .object({
    agents: z.array(userAgentEntrySchema).default([]),
  })
  .strict();

export type UserAgentEntry = z.infer<typeof userAgentEntrySchema>;

const BUILT_IN_AGENT_CATALOG: Record<
  'claude-code' | 'codex' | 'dsh-headless',
  {
    name: string;
    iconKey: string;
    models: string[];
    efforts: string[];
    modelEfforts?: Record<string, string[]>;
    loginHint: string;
    installHint: string;
  }
> = {
  'claude-code': {
    name: 'Claude Code',
    iconKey: 'claude-code',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    efforts: ['default'],
    loginHint: '在终端运行 `claude auth login` 或配置 ANTHROPIC_API_KEY',
    installHint: '安装 Claude Code CLI 后重启或刷新探测',
  },
  codex: {
    name: 'Codex',
    iconKey: 'codex',
    models: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5-codex', 'o3'],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    modelEfforts: {
      'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5-codex': ['low', 'medium', 'high'],
      o3: ['low', 'medium', 'high'],
    },
    loginHint: '在终端运行 `codex login` 或配置 OPENAI_API_KEY',
    installHint: '安装 Codex CLI (`npm i -g @openai/codex`) 后刷新探测',
  },
  'dsh-headless': {
    name: 'DSH Headless',
    iconKey: 'antigravity',
    models: ['default'],
    efforts: ['default'],
    loginHint: '检查本机 dsh headless 配置与登录状态',
    installHint: '安装并配置 dsh CLI 后刷新探测',
  },
};

export interface CreateAgentDiscoveryOptions {
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  ttlMs?: number;
  probeDeps?: ProviderProbeDeps;
  includeMock?: boolean;
  now?: () => Date;
}

export interface AgentDiscoveryRegistry {
  getSnapshot(options?: { forceRefresh?: boolean }): Promise<AgentDiscoverySnapshot>;
  refresh(): Promise<AgentDiscoverySnapshot>;
  getAgent(id: string): Promise<DiscoveredAgent | undefined>;
}

/**
 * Reads user-home custom agent declarations strictly from `~/.tekon/agents.yaml`.
 * Never reads executable commands from any repository `.tekon/config.yaml`.
 */
export function readUserAgentsConfig(userHome?: string): UserAgentEntry[] {
  const home = userHome ?? process.env.HOME ?? homedir();
  if (!home) return [];
  const filePath = join(home, '.tekon', 'agents.yaml');
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = userAgentsFileSchema.safeParse(parseYaml(raw));
    return parsed.success ? parsed.data.agents : [];
  } catch {
    return [];
  }
}

/**
 * Best-effort non-secret model hint extraction from local CLI config files.
 * Never reads API keys, OAuth tokens, or auth.json contents.
 */
function readLocalConfiguredModels(
  provider: 'claude-code' | 'codex',
  userHome: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const found: string[] = [];
  try {
    if (provider === 'claude-code') {
      const settingsPath = join(userHome, '.claude', 'settings.json');
      if (existsSync(settingsPath)) {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
          model?: unknown;
        };
        if (typeof parsed.model === 'string' && parsed.model.trim()) {
          found.push(parsed.model.trim());
        }
      }
    } else if (provider === 'codex') {
      const codexHome = env.CODEX_HOME || join(userHome, '.codex');
      const configPath = join(codexHome, 'config.toml');
      if (existsSync(configPath)) {
        const text = readFileSync(configPath, 'utf8');
        const match = text.match(/^\s*model\s*=\s*["']([^"'\n]+)["']/mu);
        if (match?.[1]?.trim()) {
          found.push(match[1].trim());
        }
      }
    }
  } catch {
    // Non-fatal: fall back to curated built-in catalog
  }
  return found;
}

function uniqueNonEmpty(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function authToStatus(installed: boolean, auth: ProviderAuthKind): DiscoveredAgentStatus {
  if (!installed) return 'not_installed';
  if (auth === 'none') return 'unauthenticated';
  return 'ready';
}

export function createAgentDiscoveryRegistry(
  options: CreateAgentDiscoveryOptions = {},
): AgentDiscoveryRegistry {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  let cached: { snapshot: AgentDiscoverySnapshot; expiresAt: number } | null = null;

  async function probeAll(): Promise<AgentDiscoverySnapshot> {
    const env = options.env ?? process.env;
    const userHome = options.userHome ?? env.HOME ?? homedir();
    const probeDeps: ProviderProbeDeps = {
      env,
      includeVersion: true,
      ...options.probeDeps,
      timeoutMs: Math.min(options.probeDeps?.timeoutMs ?? 5_000, 5_000),
    };

    const [claudeProbe, codexProbe] = await Promise.all([
      probeProvider('claude-code', probeDeps),
      probeProvider('codex', probeDeps),
    ]);

    const agents: DiscoveredAgent[] = [];

    // 1. claude-code
    {
      const cat = BUILT_IN_AGENT_CATALOG['claude-code'];
      const localModels = readLocalConfiguredModels('claude-code', userHome, env);
      agents.push({
        id: 'claude-code',
        name: cat.name,
        iconKey: cat.iconKey,
        status: authToStatus(claudeProbe.installed, claudeProbe.auth),
        authKind: claudeProbe.auth,
        version: claudeProbe.version,
        loginHint: cat.loginHint,
        installHint: cat.installHint,
        models: uniqueNonEmpty([...localModels, ...cat.models]),
        efforts: [...cat.efforts],
        source: 'built-in',
      });
    }

    // 2. codex
    {
      const cat = BUILT_IN_AGENT_CATALOG.codex;
      const localModels = readLocalConfiguredModels('codex', userHome, env);
      agents.push({
        id: 'codex',
        name: cat.name,
        iconKey: cat.iconKey,
        status: authToStatus(codexProbe.installed, codexProbe.auth),
        authKind: codexProbe.auth,
        version: codexProbe.version,
        loginHint: cat.loginHint,
        installHint: cat.installHint,
        models: uniqueNonEmpty([...localModels, ...cat.models]),
        efforts: [...cat.efforts],
        modelEfforts: cat.modelEfforts ? { ...cat.modelEfforts } : undefined,
        source: 'built-in',
      });
    }

    // 3. dsh-headless (only probe executable presence to keep fast and side-effect-free)
    {
      const cat = BUILT_IN_AGENT_CATALOG['dsh-headless'];
      const dshExe = findExecutable('dsh', env);
      if (dshExe) {
        agents.push({
          id: 'dsh-headless',
          name: cat.name,
          iconKey: cat.iconKey,
          status: 'ready',
          authKind: 'unknown',
          loginHint: cat.loginHint,
          installHint: cat.installHint,
          models: [...cat.models],
          efforts: [...cat.efforts],
          source: 'built-in',
        });
      }
    }

    // 4. Optional mock agent (for local dev/testing when explicitly enabled)
    if (options.includeMock) {
      agents.push({
        id: 'mock',
        name: 'Mock Agent',
        iconKey: 'generic',
        status: 'ready',
        authKind: 'unknown',
        models: ['mock-default', 'mock-fast'],
        efforts: ['low', 'medium', 'high'],
        source: 'built-in',
      });
    }

    // 5. User-home custom agents (~/.tekon/agents.yaml only)
    for (const entry of readUserAgentsConfig(userHome)) {
      const existingIdx = agents.findIndex((a) => a.id === entry.id);
      const installed = entry.command ? Boolean(findExecutable(entry.command, env)) : true;
      const discovered: DiscoveredAgent = {
        id: entry.id,
        name: entry.name ?? entry.id,
        iconKey: entry.iconKey ?? entry.id,
        status: installed ? 'ready' : 'not_installed',
        loginHint: entry.loginHint,
        installHint: entry.installHint,
        models: uniqueNonEmpty(entry.models),
        efforts: uniqueNonEmpty(entry.efforts.length ? entry.efforts : ['default']),
        ...(entry.modelEfforts ? { modelEfforts: entry.modelEfforts } : {}),
        source: 'user-config',
      };
      if (existingIdx >= 0) {
        // Merge user-declared models/efforts onto built-in entry without weakening status
        const prev = agents[existingIdx]!;
        agents[existingIdx] = {
          ...prev,
          models: uniqueNonEmpty([...discovered.models, ...prev.models]),
          efforts:
            discovered.efforts.length > 0 && discovered.efforts[0] !== 'default'
              ? discovered.efforts
              : prev.efforts,
          modelEfforts: {
            ...(prev.modelEfforts ?? {}),
            ...(discovered.modelEfforts ?? {}),
          },
        };
      } else {
        agents.push(discovered);
      }
    }

    const snapshot: AgentDiscoverySnapshot = {
      probedAt: now().toISOString(),
      agents,
    };
    cached = {
      snapshot,
      expiresAt: now().getTime() + ttlMs,
    };
    return snapshot;
  }

  return {
    async getSnapshot(opts) {
      if (!opts?.forceRefresh && cached && now().getTime() < cached.expiresAt) {
        return cached.snapshot;
      }
      return probeAll();
    },
    async refresh() {
      return probeAll();
    },
    async getAgent(id) {
      const snap = await this.getSnapshot();
      return snap.agents.find((a) => a.id === id);
    },
  };
}

/** Resolves effective supported effort values for an agent + optional model. */
export function isAgentExecutable(
  agent: Pick<DiscoveredAgent, 'status' | 'executable'> | undefined,
): boolean {
  return Boolean(agent && agent.status === 'ready' && agent.executable !== false);
}

/**
 * Projects runtime adapter registration onto a discovery snapshot so Settings,
 * Hero preflight, and backend execution share the exact same executability rule.
 */
export function applyAgentExecutability(
  snapshot: AgentDiscoverySnapshot,
  isDriverRegistered: (id: string) => boolean,
): AgentDiscoverySnapshot {
  return {
    probedAt: snapshot.probedAt,
    agents: snapshot.agents.map((a) => {
      const registered = isDriverRegistered(a.id);
      if (!registered) {
        return {
          ...a,
          status: a.status === 'ready' ? 'unsupported' : a.status,
          executable: false,
          unsupportedHint:
            a.unsupportedHint ??
            `当前运行时未注册执行驱动「${a.id}」，请在设置中切换为可用 Agent`,
        };
      }
      return {
        ...a,
        executable: a.status === 'ready',
      };
    }),
  };
}

export function resolveSupportedEfforts(
  agent: Pick<DiscoveredAgent, 'efforts' | 'modelEfforts'>,
  model?: string,
): string[] {
  if (model && agent.modelEfforts && agent.modelEfforts[model]?.length) {
    return agent.modelEfforts[model]!;
  }
  return agent.efforts.length > 0 ? agent.efforts : ['default'];
}
