import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerContext } from '../context.js';
import { assertRunInScope } from '../queries.js';
import { redactString } from '../redaction.js';

function mapProgressFile(
  content: Record<string, unknown>,
  _filePath: string,
): {
  nodeId: string | null;
  status: string;
  startedAt: string | null;
  updatedAt: string | null;
  elapsedMs: number;
  timeoutMs: number | null;
  noProgressTimeoutMs: number;
  timeoutReason: string | null;
  lastOutputAt: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  lastOutputDirAt: string | null;
  outputDirFileCount: number;
  heartbeatCount: number;
  approachingTimeout: boolean;
  secondsRemaining: number;
  redactedCommand: string;
} {
  const now = Date.now();
  const updatedAtStr =
    typeof content.updatedAt === 'string' ? content.updatedAt : null;
  const lastUpdated = updatedAtStr ? new Date(updatedAtStr).getTime() : 0;
  const noProgressTimeoutMs =
    typeof content.noProgressTimeoutMs === 'number'
      ? content.noProgressTimeoutMs
      : 900000;
  const elapsed = lastUpdated ? now - lastUpdated : 0;
  const remainingMs = Math.max(0, noProgressTimeoutMs - elapsed);

  return {
    nodeId: typeof content.nodeId === 'string' ? content.nodeId : null,
    status: typeof content.status === 'string' ? content.status : 'unknown',
    startedAt:
      typeof content.startedAt === 'string' ? content.startedAt : null,
    updatedAt: updatedAtStr,
    elapsedMs:
      typeof content.elapsedMs === 'number' ? content.elapsedMs : 0,
    timeoutMs:
      typeof content.timeoutMs === 'number' ? content.timeoutMs : null,
    noProgressTimeoutMs,
    timeoutReason:
      typeof content.timeoutReason === 'string'
        ? content.timeoutReason
        : null,
    // Activity metadata (NOT full content)
    lastOutputAt:
      typeof content.lastOutputAt === 'string'
        ? content.lastOutputAt
        : null,
    stdoutBytes:
      typeof content.stdoutBytes === 'number' ? content.stdoutBytes : 0,
    stderrBytes:
      typeof content.stderrBytes === 'number' ? content.stderrBytes : 0,
    lastOutputDirAt:
      typeof content.lastOutputDirAt === 'string'
        ? content.lastOutputDirAt
        : null,
    outputDirFileCount:
      typeof content.outputDirFileCount === 'number'
        ? content.outputDirFileCount
        : 0,
    heartbeatCount:
      typeof content.heartbeatCount === 'number'
        ? content.heartbeatCount
        : 0,
    // Risk assessment
    approachingTimeout: remainingMs < noProgressTimeoutMs * 0.2,
    secondsRemaining: Math.round(remainingMs / 1000),
    // Redacted command
    redactedCommand: redactString(
      typeof content.command === 'string' ? content.command : 'not recorded',
    ),
  };
}

export function createProgressRouter(context: ServerContext) {
  return {
    async list(progressInput: { runId: string }) {
      assertRunInScope(context.db, context.projectContext, progressInput.runId);
      const runDir = join(
        context.projectContext.dataDir,
        'runs',
        progressInput.runId,
      );
      if (!existsSync(runDir)) {
        return { runId: progressInput.runId, progressFiles: [] };
      }
      const resolvedRunDir = realpathSync(runDir);
      const progressFiles: ReturnType<typeof mapProgressFile>[] = [];
      let entries: string[];
      try {
        entries = readdirSync(resolvedRunDir);
      } catch {
        return { runId: progressInput.runId, progressFiles: [] };
      }
      for (const entry of entries) {
        if (!entry.endsWith('.progress.json')) continue;
        const filePath = join(resolvedRunDir, entry);
        try {
          const stat = lstatSync(filePath);
          if (stat.isSymbolicLink()) continue;
          const realPath = realpathSync(filePath);
          if (!realPath.startsWith(resolvedRunDir + '/')) continue;
          const raw = readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          progressFiles.push(mapProgressFile(parsed, filePath));
        } catch {
          // Skip malformed progress files silently
        }
      }
      return { runId: progressInput.runId, progressFiles };
    },
  };
}
