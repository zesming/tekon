import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  listWorkflowCatalog,
  loadWorkflowTemplate,
  loadWorkflowTemplateFile,
  captureRunPlan,
  toRunPlanPreview,
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

      const template = isGoal
        ? loadWorkflowTemplate({ name: 'goal' })
        : loadTemplate(context, templateName);
      try {
        return toRunPlanPreview(captureRunPlan(context.projectContext.projectRoot, template, {
        agent: input.agent,
        mode: isGoal ? 'goal' : 'workflow',
        profile: input.profile ?? 'human-web',
        allowDirtyBase: Boolean(input.allowDirtyBase),
        timeoutMs: input.timeoutMs,
        noProgressTimeoutMs: input.noProgressTimeoutMs,
        progressHeartbeatMs: input.progressHeartbeatMs,
        templateId: templateName,
        }), context.planPreviewSigner);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('PLAN_CONFIG_INVALID:')) {
          throw new ApiError('BAD_REQUEST', 'PLAN_CONFIG_INVALID: 无法读取仓库检查配置；请修正 .tekon/repo-profile.yaml 或 package.json 后刷新预览');
        }
        throw error;
      }
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
  } catch {
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
