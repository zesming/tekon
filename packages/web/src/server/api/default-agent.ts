import { readTekonConfig, resolveDefaultAgent } from '@tekon/core';

/**
 * Resolve the provider agent a Web run uses when the client does not pick one
 * explicitly (PD-24). Reads the same repo config as the CLI so a user's
 * `defaultAgent` applies to both surfaces; falls back to claude-code when the
 * file is absent or sets no value.
 */
export function resolveWebDefaultAgent(projectRoot: string): string {
  return resolveDefaultAgent(readTekonConfig(projectRoot));
}
