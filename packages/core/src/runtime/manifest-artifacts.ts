import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  agentArtifactManifestSchema,
  validateArtifactContent,
} from '../artifact/schemas.js';
import type { Artifact, ArtifactType } from '../types/domain.js';
import {
  sanitizeAgentRunDiagnostic,
  type AgentRunDiagnostic,
  type AgentRunInput,
} from './agent-adapter.js';

/** A provider artifact was produced, but its manifest or content is unusable. */
export class ArtifactManifestError extends Error {
  readonly diagnostic: AgentRunDiagnostic;

  constructor(diagnostic: AgentRunDiagnostic) {
    super(diagnostic.message);
    this.name = 'ArtifactManifestError';
    this.diagnostic = diagnostic;
  }
}

export function artifactDiagnosticFromError(
  error: unknown,
): AgentRunDiagnostic | undefined {
  return error instanceof ArtifactManifestError
    ? sanitizeAgentRunDiagnostic(error.diagnostic)
    : undefined;
}

export async function ingestAgentManifestArtifacts(input: {
  runInput: AgentRunInput;
  manifestPath: string;
}): Promise<Artifact[]> {
  if (!input.runInput.artifactStore) {
    return [];
  }
  const manifestPath = resolveExistingManifestPath(
    input.manifestPath,
    input.runInput.outputDir,
  );
  if (!manifestPath) {
    if ((input.runInput.requiredArtifactTypes ?? []).length === 0) {
      return [];
    }
    throw artifactManifestError({
      code: 'artifact-manifest-missing',
      path: displayArtifactPath(input.runInput.outputDir, input.manifestPath),
      message: `artifact manifest missing: file=${displayArtifactPath(
        input.runInput.outputDir,
        input.manifestPath,
      )}`,
    });
  }

  const manifestDisplayPath = displayArtifactPath(
    input.runInput.outputDir,
    manifestPath,
  );
  const manifestContent = readArtifactFileOrThrow({
    outputDir: input.runInput.outputDir,
    path: manifestPath,
    label: 'artifact manifest',
    displayPath: manifestDisplayPath,
  });
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestContent);
  } catch (error) {
    throw artifactManifestError({
      code: 'artifact-manifest-invalid-json',
      path: manifestDisplayPath,
      message: `artifact manifest invalid JSON: file=${manifestDisplayPath}${jsonLocation(
        error,
      )}`,
    });
  }

  let manifest: ReturnType<typeof agentArtifactManifestSchema.parse>;
  try {
    manifest = agentArtifactManifestSchema.parse(parsedManifest);
  } catch (error) {
    throw schemaError({
      code: 'artifact-manifest-schema-invalid',
      label: 'artifact manifest',
      path: manifestDisplayPath,
      error,
    });
  }

  const artifacts: Artifact[] = [];
  for (const entry of manifest.artifacts) {
    const artifactDisplayPath = displayArtifactPath(
      input.runInput.outputDir,
      entry.path,
    );
    const content = readArtifactFileOrThrow({
      outputDir: input.runInput.outputDir,
      path: entry.path,
      label: 'artifact file',
      displayPath: artifactDisplayPath,
      artifactType: entry.type,
    });
    const trimmed = content.trim();
    if (trimmed.startsWith('{')) {
      try {
        JSON.parse(trimmed);
      } catch (error) {
        throw artifactManifestError({
          code: 'artifact-file-invalid-json',
          artifactType: entry.type,
          path: artifactDisplayPath,
          message: `artifact invalid JSON: type=${entry.type} file=${artifactDisplayPath}${jsonLocation(
            error,
          )}`,
        });
      }
    }
    try {
      validateArtifactContent(entry.type, content);
    } catch (error) {
      throw schemaError({
        code: 'artifact-file-schema-invalid',
        label: 'artifact',
        artifactType: entry.type,
        path: artifactDisplayPath,
        error,
      });
    }
    artifacts.push(
      await input.runInput.artifactStore.writeArtifact({
        runId: input.runInput.runContext.runId,
        nodeId: input.runInput.runContext.nodeId,
        type: entry.type,
        content,
        summary: entry.summary,
      }),
    );
  }
  return artifacts;
}

function resolveExistingManifestPath(
  expectedManifestPath: string,
  outputDir: string,
): string | null {
  const candidates = [
    expectedManifestPath,
    'TEKON_ARTIFACT_MANIFEST',
    'manifest.json',
    'artifact-manifest.json',
    'artifacts.manifest.json',
  ];
  for (const candidate of candidates) {
    const resolved = resolveOutputPath(outputDir, candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function readOutputFile(
  outputDir: string,
  path: string,
  label: string,
): string {
  const outputPath = resolveOutputPath(outputDir, path);
  const fileStat = lstatSync(outputPath);
  if (fileStat.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symlink: ${outputPath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`${label} must be a regular file: ${outputPath}`);
  }

  const root = realpathSync(outputDir);
  const target = realpathSync(outputPath);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return readFileSync(outputPath, 'utf8');
  }
  throw new Error(`${label} escapes TEKON_OUTPUT_DIR: ${path}`);
}

export function missingRequiredArtifactTypes(
  required: ArtifactType[] | undefined,
  artifacts: Artifact[],
): ArtifactType[] {
  const seen = new Set(artifacts.map((artifact) => artifact.type));
  return (required ?? []).filter((type) => !seen.has(type));
}

export function createMissingRequiredArtifactsDiagnostic(input: {
  required: ArtifactType[] | undefined;
  artifacts: Artifact[];
}): AgentRunDiagnostic | undefined {
  const missing = missingRequiredArtifactTypes(input.required, input.artifacts);
  if (missing.length === 0) return undefined;
  return createDiagnostic({
    code: 'required-artifacts-missing',
    message: `required artifact types missing: ${missing.join(', ')}`,
  });
}

function resolveOutputPath(outputDir: string, path: string): string {
  const root = resolve(outputDir);
  const target = resolve(root, path);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return target;
  }
  throw new Error(`artifact path escapes TEKON_OUTPUT_DIR: ${path}`);
}

function artifactManifestError(
  diagnostic: Omit<AgentRunDiagnostic, 'message'> & { message: string },
): ArtifactManifestError {
  return new ArtifactManifestError(createDiagnostic(diagnostic));
}

function createDiagnostic(
  diagnostic: Omit<AgentRunDiagnostic, 'message'> & { message: string },
): AgentRunDiagnostic {
  // All values here are metadata derived from paths, schema paths, and enum
  // values. Sanitize once more at the contract boundary for custom adapters
  // and for durable event consumers.
  return sanitizeAgentRunDiagnostic(diagnostic)!;
}

function schemaError(input: {
  code: 'artifact-manifest-schema-invalid' | 'artifact-file-schema-invalid';
  label: 'artifact manifest' | 'artifact';
  artifactType?: ArtifactType;
  path: string;
  error: unknown;
}): ArtifactManifestError {
  const issue = firstSchemaIssue(input.error);
  const field = issue?.field ?? 'root';
  const reason = issue?.code ? ` reason=${issue.code}` : '';
  const typePart = input.artifactType
    ? ` type=${input.artifactType}`
    : '';
  return artifactManifestError({
    code: input.code,
    artifactType: input.artifactType,
    path: input.path,
    field,
    message: `${input.label} schema invalid:${typePart} file=${input.path} field=${field}${reason}`,
  });
}

function firstSchemaIssue(
  error: unknown,
): { code?: string; field?: string } | undefined {
  if (!isRecord(error) || !Array.isArray(error.issues)) return undefined;
  const issue = error.issues.find((candidate) => isRecord(candidate));
  if (!isRecord(issue)) return undefined;
  const path = Array.isArray(issue.path)
    ? issue.path.map((segment) => String(segment)).join('.')
    : '';
  return {
    code: typeof issue.code === 'string' ? issue.code : undefined,
    field: path || undefined,
  };
}

function readArtifactFileOrThrow(input: {
  outputDir: string;
  path: string;
  label: 'artifact manifest' | 'artifact file';
  displayPath: string;
  artifactType?: ArtifactType;
}): string {
  try {
    return readOutputFile(input.outputDir, input.path, input.label);
  } catch (error) {
    const reason = readFailureReason(error);
    const isManifest = input.label === 'artifact manifest';
    const code =
      reason === 'missing'
        ? isManifest
          ? 'artifact-manifest-missing'
          : 'artifact-file-missing'
        : reason === 'invalid-path'
          ? isManifest
            ? 'artifact-manifest-invalid-path'
            : 'artifact-file-invalid-path'
          : isManifest
            ? 'artifact-manifest-unreadable'
            : 'artifact-file-unreadable';
    const typePart = input.artifactType
      ? ` type=${input.artifactType}`
      : '';
    throw artifactManifestError({
      code,
      artifactType: input.artifactType,
      path: input.displayPath,
      message: `${input.label} ${reason}:` +
        `${typePart} file=${input.displayPath}`,
    });
  }
}

function readFailureReason(
  error: unknown,
): 'missing' | 'invalid-path' | 'unreadable' {
  const message = error instanceof Error ? error.message : '';
  if (isNodeError(error) && error.code === 'ENOENT') return 'missing';
  if (/ENOENT|no such file or directory/iu.test(message)) return 'missing';
  if (/symlink|regular file|escapes TEKON_OUTPUT_DIR/iu.test(message)) {
    return 'invalid-path';
  }
  return 'unreadable';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function jsonLocation(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const line = message.match(/line (\d+)/iu)?.[1];
  const column = message.match(/column (\d+)/iu)?.[1];
  if (line && column) return ` line=${line} column=${column}`;
  const position = message.match(/position (\d+)/iu)?.[1];
  return position ? ` position=${position}` : '';
}

function displayArtifactPath(outputDir: string, path: string): string {
  const root = resolve(outputDir);
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (
    relativePath &&
    !relativePath.startsWith(`..${sep}`) &&
    relativePath !== '..' &&
    !isAbsolute(relativePath)
  ) {
    return relativePath.split(sep).join('/');
  }
  return basename(path) || '<unknown>';
}
