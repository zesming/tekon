import path from "node:path";
import { defaultRepoProfile } from "./defaults.js";
import { readJson } from "./fs-store.js";
import type { RepoProfile } from "./types.js";

export async function loadRepoProfile(repo: string): Promise<RepoProfile> {
  const profilePath = path.join(repo, ".donkey", "repo-profile.json");
  try {
    const profile = await readJson<RepoProfile>(profilePath);
    return mergeRepoProfileDefaults(profile, repo);
  } catch (error) {
    if (isMissingFile(error)) {
      return defaultRepoProfile(repo);
    }
    throw error;
  }
}

function mergeRepoProfileDefaults(profile: RepoProfile, repo: string): RepoProfile {
  const defaults = defaultRepoProfile(repo);
  const configuredCommands = profile.commands ?? {};
  const configuredRisk = (profile.risk ?? {}) as Partial<RepoProfile["risk"]>;
  return {
    ...defaults,
    ...profile,
    root: profile.root || repo,
    commands: {
      ...defaults.commands,
      ...configuredCommands,
    },
    risk: {
      highRiskKeywords: mergeList(defaults.risk.highRiskKeywords, configuredRisk.highRiskKeywords),
      blockedCommandPatterns: mergeList(defaults.risk.blockedCommandPatterns, configuredRisk.blockedCommandPatterns),
      allowedCommandPatterns: mergeList(defaults.risk.allowedCommandPatterns, configuredRisk.allowedCommandPatterns),
      highRiskPaths: mergeList(defaults.risk.highRiskPaths, configuredRisk.highRiskPaths),
    },
  };
}

function mergeList(defaults: string[], configured?: string[]): string[] {
  return [...new Set([...defaults, ...(configured ?? [])])];
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
