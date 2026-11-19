import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Puts placeholder provider commands first on PATH so the start/resume
 * provider check finds them. A placeholder exits 1 at once, so a run that
 * does reach it fails fast and a real provider on the host is never started.
 * Returns the cleanup that restores PATH.
 */
export function installFakeProviderCommands(...commands: string[]): () => void {
  const binDir = mkdtempSync(join(tmpdir(), 'tekon-web-provider-bin-'));
  for (const command of commands) {
    const path = join(binDir, command);
    writeFileSync(path, '#!/bin/sh\necho "placeholder provider for tests" >&2\nexit 1\n');
    chmodSync(path, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ''}`;
  return () => {
    process.env.PATH = previousPath;
    rmSync(binDir, { recursive: true, force: true });
  };
}
