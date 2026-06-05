import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const injectModeSchema = z
  .enum(['prepend', 'append', 'replace'])
  .default('append');
export type InjectMode = z.infer<typeof injectModeSchema>;

export const roleSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  priority: z.number().int().default(0),
  injectMode: injectModeSchema,
  content: z.string(),
  sourcePath: z.string().min(1),
});
export type RoleSkill = z.infer<typeof roleSkillSchema>;

export function loadSkillsFromRoleDir(roleDir: string): RoleSkill[] {
  const skillsDir = join(roleDir, 'skills');
  if (!existsSync(skillsDir)) {
    return [];
  }

  return readdirSync(skillsDir)
    .filter((entry) => entry.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => {
      const absolutePath = join(skillsDir, entry);
      const raw = readFileSync(absolutePath, 'utf8');
      const parsed = parseMarkdownFrontmatter(raw);
      return roleSkillSchema.parse({
        id: parsed.frontmatter.id ?? basename(entry, extname(entry)),
        name: parsed.frontmatter.name,
        priority: parsed.frontmatter.priority ?? 0,
        injectMode: parsed.frontmatter.injectMode ?? 'append',
        content: parsed.content.trim(),
        sourcePath: relative(roleDir, absolutePath),
      });
    });
}

export function parseMarkdownFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const normalized = raw.replace(/^\uFEFF/u, '');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, content: normalized };
  }

  const closingIndex = normalized.indexOf('\n---', 4);
  if (closingIndex === -1) {
    return { frontmatter: {}, content: normalized };
  }

  const frontmatterRaw = normalized.slice(4, closingIndex);
  const bodyStart = normalized.startsWith('\n', closingIndex + 4)
    ? closingIndex + 5
    : closingIndex + 4;
  const frontmatter = parseYaml(frontmatterRaw) as Record<string, unknown>;
  return {
    frontmatter: frontmatter ?? {},
    content: normalized.slice(bodyStart),
  };
}
