import { describe, expect, it } from 'vitest';

import {
  TEKON_CORE_VERSION,
  buildRolePrompt,
  compileRoleToolPolicy,
  generateDynamicWorkflow,
  loadWorkflowTemplate,
  loadRole,
  parseWorkflowTemplate,
  saveDynamicTemplate,
  validateWorkflowConstraints,
} from '../src/index.js';

describe('@tekon/core', () => {
  it('exports the core package version marker', () => {
    expect(TEKON_CORE_VERSION).toBe('0.5.0');
  });

  it('exports phase 2 role system APIs', () => {
    expect(loadRole).toBeTypeOf('function');
    expect(compileRoleToolPolicy).toBeTypeOf('function');
    expect(buildRolePrompt).toBeTypeOf('function');
  });

  it('exports phase 2 workflow and constraint APIs', () => {
    expect(parseWorkflowTemplate).toBeTypeOf('function');
    expect(loadWorkflowTemplate).toBeTypeOf('function');
    expect(generateDynamicWorkflow).toBeTypeOf('function');
    expect(saveDynamicTemplate).toBeTypeOf('function');
    expect(validateWorkflowConstraints).toBeTypeOf('function');
  });
});
