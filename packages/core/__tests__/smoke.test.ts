import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

describe('@tekon/core', () => {
  it('exports the core package version marker', () => {
    expect(TEKON_CORE_VERSION).toBe(pkg.version);
  });

  it('keeps every internal package version in lockstep with the root product version', () => {
    // P1-RELEASE-01: 防止内部 package 版本与根产品版本再次漂移。
    // 根 package.json 是唯一产品版本来源；所有内部 package 必须 lockstep。
    const rootPkg = require('../../../package.json') as { version: string };
    expect(pkg.version).toBe(rootPkg.version);
    const packageDir = join(import.meta.dirname, '..', '..');
    let scanned = 0;
    for (const name of readdirSync(packageDir)) {
      // 只扫描含 package.json 的包目录，避免 .DS_Store、残留目录或断链
      // symlink 触发 MODULE_NOT_FOUND 而非语义化断言。
      if (!existsSync(join(packageDir, name, 'package.json'))) {
        continue;
      }
      scanned += 1;
      const sibling = require(join(packageDir, name, 'package.json')) as {
        version: string;
      };
      expect(sibling.version).toBe(rootPkg.version);
    }
    // 下界断言：确保过滤没有静默跳过所有包（防假通过）。
    expect(scanned).toBeGreaterThan(0);
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
