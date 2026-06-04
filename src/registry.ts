import type { AgentProfile } from "./types.js";

export interface AgentRegistry {
  list(): AgentProfile[];
  get(versionedId: string): AgentProfile;
}

export function createAgentRegistry(profiles: AgentProfile[]): AgentRegistry {
  const byId = new Map<string, AgentProfile>();
  for (const profile of profiles) {
    byId.set(`${profile.name}@${profile.version}`, profile);
  }

  return {
    list() {
      return [...byId.values()];
    },
    get(versionedId: string) {
      const profile = byId.get(versionedId);
      if (!profile) {
        throw new Error(`Agent profile not found: ${versionedId}`);
      }
      return profile;
    },
  };
}
