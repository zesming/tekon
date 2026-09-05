import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const web = JSON.parse(readFileSync(new URL('packages/web/package.json', root), 'utf8'));
const lock = parse(readFileSync(new URL('pnpm-lock.yaml', root), 'utf8'));

describe('tekon ui 的实际启动依赖进入生产审计', () => {
  for (const dependency of ['tsx', 'vite', '@vitejs/plugin-react']) {
    it(`${dependency} 的 manifest 与 lock importer 均属于生产依赖`, () => {
      // CLI 启动 tsx；server/index.ts 启用 Vite，并加载 React plugin。
      // pnpm audit --prod 依赖这个分类，不能只在安装后检查二进制存在。
      expect(web.dependencies[dependency]).toEqual(expect.any(String));
      expect(web.devDependencies[dependency]).toBeUndefined();
      const importer = lock.importers['packages/web'];
      expect(importer.dependencies[dependency].specifier).toBe(web.dependencies[dependency]);
      expect(importer.devDependencies[dependency]).toBeUndefined();
    });
  }
});
