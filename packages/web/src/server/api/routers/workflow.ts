import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadWorkflowTemplate,
  loadWorkflowTemplateFile,
  projectRunPlan,
  type WorkflowTemplate,
} from '@tekon/core';

import type { ServerContext, WorkflowPlanInput } from '../context.js';
import { assertSafeName } from '../common.js';
import { ApiError } from '../errors.js';

export function createWorkflowRouter(context: ServerContext) {
  return {
    async list() {
      return { workflows: listWorkflows(context) };
    },

    async plan(input: WorkflowPlanInput) {
      const isGoal = input.mode === 'goal';
      const templateName = isGoal
        ? 'goal'
        : input.template?.trim() || 'standard-delivery';

      assertSafeName(templateName, 'template');

      const template = loadTemplate(context, templateName);
      return projectRunPlan(template, {
        agent: input.agent,
        mode: input.mode,
      });
    },
  };
}

function loadTemplate(context: ServerContext, name: string): WorkflowTemplate {
  const custom = loadProjectWorkflowIfPresent(context, name);
  if (custom) {
    return custom;
  }
  try {
    return loadWorkflowTemplate({ name });
  } catch (error) {
    throw new ApiError(
      'NOT_FOUND',
      `Workflow template not found: ${name}`,
    );
  }
}

function loadProjectWorkflowIfPresent(
  context: ServerContext,
  name: string,
): WorkflowTemplate | null {
  for (const extension of ['.yaml', '.yml']) {
    const workflowPath = join(
      context.projectContext.workflowsDir,
      `${name}${extension}`,
    );
    if (existsSync(workflowPath)) {
      return loadWorkflowTemplateFile(workflowPath);
    }
  }
  return null;
}

function listWorkflows(
  context: ServerContext,
): Array<{ id: string; name: string; path: string }> {
  const workflowsDir = context.projectContext.workflowsDir;
  if (!existsSync(workflowsDir)) {
    return [];
  }

  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => {
      const path = join(workflowsDir, entry.name);
      const content = readFileSync(path, 'utf8');
      return {
        id:
          extractYamlScalar(content, 'id') ??
          entry.name.replace(/\.ya?ml$/u, ''),
        name: extractYamlScalar(content, 'name') ?? entry.name,
        path,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function extractYamlScalar(content: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(content);
  return match?.[1]?.trim().replace(/^["']|["']$/gu, '');
}
