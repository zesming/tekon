import type { LoadedRole } from './loader.js';
import { compileRoleToolPolicy } from './tool-policy.js';

export interface RolePromptArtifactSummary {
  id?: string;
  type: string;
  path: string;
  summary?: string;
  content?: string;
}

export interface BuildRolePromptInput {
  role: LoadedRole;
  taskInstruction: string;
  projectContext: Record<string, string>;
  artifactSummaries?: RolePromptArtifactSummary[];
  maxArtifactChars?: number;
}

export function buildRolePrompt(input: BuildRolePromptInput): string {
  const maxArtifactChars = input.maxArtifactChars ?? 16_000;
  const roleName = input.role.agent.name ?? input.role.role;
  const toolSummary = compileRoleToolPolicy({
    repoPath: input.projectContext.repoPath ?? '.',
    role: input.role.role,
    tools: input.role.tools,
  }).promptSummary;

  return [
    `# Role: ${roleName}`,
    '',
    `source: ${input.role.source}`,
    `roleId: ${input.role.role}`,
    '',
    '## System',
    input.role.systemPrompt,
    '',
    '## Task',
    input.taskInstruction,
    '',
    '## Project Context',
    formatRecord(input.projectContext),
    '',
    '## Tools',
    toolSummary,
    '',
    '## Skills',
    formatSkills(input.role.skills),
    '',
    '## Knowledge',
    formatKnowledge(input.role.knowledge),
    '',
    '## Artifacts',
    formatArtifacts(input.artifactSummaries ?? [], maxArtifactChars),
  ].join('\n');
}

function formatRecord(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function formatSkills(skills: LoadedRole['skills']): string {
  if (skills.length === 0) {
    return 'none';
  }
  return skills
    .map(
      (skill) =>
        `### ${skill.name ?? skill.id}\npriority: ${skill.priority}\ninjectMode: ${skill.injectMode}\n${skill.content}`,
    )
    .join('\n\n');
}

function formatKnowledge(knowledge: LoadedRole['knowledge']): string {
  if (knowledge.length === 0) {
    return 'none';
  }
  return knowledge
    .map((item) => `### ${item.path}\n${item.content}`)
    .join('\n\n');
}

function formatArtifacts(
  artifacts: RolePromptArtifactSummary[],
  maxArtifactChars: number,
): string {
  if (artifacts.length === 0) {
    return 'none';
  }

  return artifacts
    .map((artifact) => {
      const content = artifact.content ?? '';
      const visibleContent =
        content.length > maxArtifactChars
          ? `${content.slice(0, maxArtifactChars)}\n\n[truncated artifact: ${
              content.length - maxArtifactChars
            } chars omitted]`
          : content;

      return [
        `### ${artifact.type}`,
        artifact.id ? `artifactId: ${artifact.id}` : undefined,
        `path: ${artifact.path}`,
        artifact.summary ? `summary: ${artifact.summary}` : undefined,
        visibleContent,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n');
    })
    .join('\n\n');
}
