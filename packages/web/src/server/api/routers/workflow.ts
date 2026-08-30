import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  listWorkflowCatalog,
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
      return {
        workflows: listWorkflowCatalog({
          projectWorkflowsDir: context.projectContext.workflowsDir,
        }),
      };
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
