import path from "node:path";
import { defaultRepoProfile } from "./defaults.js";
import { readJson } from "./fs-store.js";
import type { RepoProfile } from "./types.js";

export async function loadRepoProfile(repo: string): Promise<RepoProfile> {
  const profilePath = path.join(repo, ".donkey", "repo-profile.json");
  try {
    const profile = await readJson<RepoProfile>(profilePath);
    return {
      ...profile,
      root: profile.root || repo,
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return defaultRepoProfile(repo);
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
