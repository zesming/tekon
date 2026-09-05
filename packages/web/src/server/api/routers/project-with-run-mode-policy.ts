import { getRunModePolicyIssue } from '@tekon/core';

import type { ProjectRunInput, ServerContext } from '../context.js';
import { assertSessionToken } from '../common.js';
import { ApiError } from '../errors.js';
import { createProjectRouter as createBaseProjectRouter } from './project.js';

/**
 * Keep provider/mode compatibility at the Web composition boundary without
 * mixing product policy into the large legacy project router. The base router
 * remains the owner of draft, clean-base, and orchestration validation.
 */
export function createProjectRouter(
  context: ServerContext,
  options?: { probeProvider?: () => Promise<'available' | 'unavailable'> },
) {
  const base = createBaseProjectRouter(context, options);
  return {
    ...base,
    async run(input: ProjectRunInput) {
      // Preserve the router's auth-before-validation order. The base router
      // repeats this check; keeping the wrapper explicit avoids leaking policy
      // details to an unauthenticated caller.
      assertSessionToken(context.projectContext, input.token);
      const issue = getRunModePolicyIssue({
        agent: input.agent ?? 'codex',
        kind: input.mode === 'goal' ? 'goal' : 'workflow',
        template: input.template,
        profile: input.profile,
      });
      if (issue) {
        throw new ApiError('BAD_REQUEST', issue);
      }
      return base.run(input);
    },
  };
}
