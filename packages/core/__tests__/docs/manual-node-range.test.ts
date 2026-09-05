import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const manualFiles = [
  join(repoRoot, 'docs/manual/tekon-user-manual.md'),
  join(repoRoot, 'docs/manual/tekon-user-manual.html'),
];

describe('用户手册 Node 版本声明一致性', () => {
  it.each(manualFiles)('%s 不再宣称 Node 18 可用', (file) => {
    const content = readFileSync(file, 'utf8');
    expect(content).not.toContain('>=18');
    expect(content).not.toMatch(/node[^\n]{0,20}18/iu);
  });

  it.each(manualFiles)('%s 声明与 package.json 一致的 Node 范围', (file) => {
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('20.19.0');
    expect(content).toContain('22.12.0');
  });
});
