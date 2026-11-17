import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  inspectTemplateSymlink,
  listWorkflowCatalog,
  loadWorkflowTemplate,
  loadWorkflowTemplateFile,
  captureRunPlan,
  toRunPlanPreview,
  TekonConfigError,
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
        // A malformed .tekon/config.yaml is user-fixable input, not a server fault.
        if (error instanceof TekonConfigError) {
          throw new ApiError(
            'BAD_REQUEST',
            `TEKON_CONFIG_INVALID: ${error.message}`,
          );
        }
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
  const workflowsDir = context.projectContext.workflowsDir;
  for (const extension of ['.yaml', '.yml']) {
    const workflowPath = join(workflowsDir, `${name}${extension}`);
    if (existsSync(workflowPath)) {
      // 统一软链信任边界：项目模板越界/断链软链在读取前拒绝。
      const linkCheck = inspectTemplateSymlink(workflowPath, workflowsDir);
      if (!linkCheck.ok) throw new Error(linkCheck.reason);
      return loadWorkflowTemplateFile(workflowPath);
    }
  }
  return null;
}
