import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { redactSecrets } from '../security/secrets.js';
import type { Artifact, ArtifactType } from '../types/domain.js';
import type { AgentRunInput, AgentRunResult } from './agent-adapter.js';

export interface ParsedProviderStdout {
  assistantText?: string;
  providerThreadId?: string;
  tokenUsage?: AgentRunResult['tokenUsage'];
}

/**
 * Extracts assistant prose, session/thread ID, and real token usage (including
 * prompt cache read tokens) from Claude Code json/stream-json or Codex jsonl stdout.
 */
export function parseProviderStdout(
  provider: 'claude-code' | 'codex',
  stdoutPath: string,
): ParsedProviderStdout {
  if (!existsSync(stdoutPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(stdoutPath, 'utf8');
  } catch {
    return {};
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (provider === 'claude-code') {
    // Try single JSON object first (`--output-format json`)
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return extractClaudeRecord(parsed);
    } catch {
      // NDJSON (`--output-format stream-json --verbose`)
    }
    const merged: ParsedProviderStdout = {};
    const textParts: string[] = [];
    for (const line of trimmed.split(/\r?\n/u)) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const obj = JSON.parse(s) as Record<string, unknown>;
        const rec = extractClaudeRecord(obj);
        if (rec.providerThreadId) merged.providerThreadId = rec.providerThreadId;
        if (rec.tokenUsage) merged.tokenUsage = rec.tokenUsage;
        if (rec.assistantText) textParts.push(rec.assistantText);
      } catch {
        // skip non-JSON line
      }
    }
    if (textParts.length > 0) {
      merged.assistantText = textParts[textParts.length - 1];
    }
    return merged;
  }

  // Codex JSONL (`codex exec --json`) or plain text
  const merged: ParsedProviderStdout = {};
  const messages: string[] = [];
  let sawJson = false;
  for (const line of trimmed.split(/\r?\n/u)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      sawJson = true;
      if (typeof obj.thread_id === 'string' && obj.thread_id) {
        merged.providerThreadId = obj.thread_id;
      }
      if (typeof obj.usage === 'object' && obj.usage !== null) {
        const u = obj.usage as Record<string, unknown>;
        merged.tokenUsage = {
          ...(typeof u.input_tokens === 'number' ? { inputTokens: u.input_tokens } : {}),
          ...(typeof u.cached_input_tokens === 'number'
            ? { cachedInputTokens: u.cached_input_tokens }
            : {}),
          ...(typeof u.output_tokens === 'number' ? { outputTokens: u.output_tokens } : {}),
        };
      }
      const item = obj.item as Record<string, unknown> | undefined;
      if (item && typeof item.text === 'string' && item.text.trim()) {
        messages.push(item.text.trim());
      } else if (typeof obj.message === 'string' && obj.message.trim()) {
        messages.push(obj.message.trim());
      }
    } catch {
      // ignore non-json
    }
  }
  if (messages.length > 0) {
    merged.assistantText = messages[messages.length - 1];
  } else if (!sawJson) {
    merged.assistantText = trimmed;
  }
  return merged;
}

function extractClaudeRecord(obj: Record<string, unknown>): ParsedProviderStdout {
  const out: ParsedProviderStdout = {};
  if (typeof obj.session_id === 'string' && obj.session_id) {
    out.providerThreadId = obj.session_id;
  }
  if (typeof obj.result === 'string' && obj.result.trim()) {
    out.assistantText = obj.result.trim();
  }
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === 'object') {
    const inputTokens =
      typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
    const cachedInputTokens =
      typeof usage.cache_read_input_tokens === 'number'
        ? usage.cache_read_input_tokens
        : undefined;
    const outputTokens =
      typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
    const costUsd =
      typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
    if (
      inputTokens !== undefined ||
      cachedInputTokens !== undefined ||
      outputTokens !== undefined ||
      costUsd !== undefined
    ) {
      out.tokenUsage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    }
  }
  return out;
}

export interface GeneralOutputIngestion {
  artifacts: Artifact[];
  handoffBrief?: string;
}

/**
 * Slim v2 artifact protocol & graceful fallback for general linear workflow nodes:
 * 1. Reads optional `<outputDir>/handoff.json` for structured handoff summary.
 * 2. Reads optional `<outputDir>/<docKey>.md` for each requested artifact type.
 * 3. Falls back to `assistantText` when no file was explicitly written.
 */
/**
 * Reads an agent-emitted file under `outputDir` fail-closed: rejects symlinks,
 * non-regular files, and any resolved path escaping `realpathSync(outputDir)`.
 */
function readSafeOutputFile(outputDir: string, fileName: string): string | undefined {
  if (!existsSync(outputDir)) return undefined;
  let rootReal: string;
  try {
    rootReal = realpathSync(outputDir);
  } catch {
    return undefined;
  }
  const candidatePath = resolve(outputDir, fileName);
  if (!existsSync(candidatePath)) return undefined;
  const stat = lstatSync(candidatePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `UNSAFE_AGENT_OUTPUT_FILE: 拒绝读取非普通文件或符号链接 '${fileName}'。`,
    );
  }
  const candidateReal = realpathSync(candidatePath);
  if (
    candidateReal !== rootReal &&
    !candidateReal.startsWith(`${rootReal}${sep}`)
  ) {
    throw new Error(
      `UNSAFE_AGENT_OUTPUT_FILE: 输出文件 '${fileName}' 越界逃逸输出目录。`,
    );
  }
  return readFileSync(candidateReal, 'utf8');
}

export async function ingestGeneralNodeOutput(input: {
  runInput: AgentRunInput;
  assistantText?: string;
  docTitle?: string;
}): Promise<GeneralOutputIngestion> {
  const { runInput, assistantText, docTitle } = input;
  let handoffBrief: string | undefined;
  let parsedDocTitle = docTitle;
  let parsedDocSummary: string | undefined;

  const handoffRaw = readSafeOutputFile(runInput.outputDir, 'handoff.json');
  if (handoffRaw !== undefined) {
    try {
      const parsed = JSON.parse(handoffRaw) as {
        summary?: unknown;
        docTitle?: unknown;
        docSummary?: unknown;
      };
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        handoffBrief = redactSecrets(parsed.summary.trim()).content.slice(0, 1500);
      }
      if (typeof parsed.docTitle === 'string' && parsed.docTitle.trim()) {
        parsedDocTitle = redactSecrets(parsed.docTitle.trim()).content;
      }
      if (typeof parsed.docSummary === 'string' && parsed.docSummary.trim()) {
        parsedDocSummary = redactSecrets(parsed.docSummary.trim()).content;
      }
    } catch {
      // malformed handoff.json falls back cleanly to assistantText
    }
  }

  if (!handoffBrief && assistantText?.trim()) {
    handoffBrief = redactSecrets(assistantText.trim()).content.slice(0, 1500);
  }

  const artifacts: Artifact[] = [];
  if (runInput.artifactStore) {
    const types: ArtifactType[] = runInput.requiredArtifactTypes ?? [];
    for (const type of types) {
      const fileRaw = readSafeOutputFile(runInput.outputDir, `${type}.md`);
      let content: string | undefined;
      if (fileRaw !== undefined) {
        content = fileRaw;
      } else if (assistantText && assistantText.trim().length >= 20) {
        content = assistantText.trim();
      }
      if (content && content.trim()) {
        const stored = await runInput.artifactStore.writeArtifact({
          runId: runInput.runContext.runId,
          nodeId: runInput.runContext.nodeId,
          type,
          docKey: type,
          title: parsedDocTitle,
          summary: parsedDocSummary,
          content,
        });
        artifacts.push(stored);
      }
    }
  }

  return { artifacts, handoffBrief };
}
