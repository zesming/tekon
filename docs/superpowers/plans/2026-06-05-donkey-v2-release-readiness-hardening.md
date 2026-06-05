# Donkey V2 发布就绪加固实施计划

> **给 agentic workers：** 必须使用 `superpowers:subagent-driven-development` 按任务执行本计划。步骤使用 checkbox（`- [ ]`）跟踪。每个任务完成后必须启动最高思考等级 reviewer 复查；若检出阻断项，先修复再复查。

**目标：** 在创建 PR 之前完成阶段一剩余发布就绪项：远端 CI 绿灯确认、GitHub Actions lint、Vitest 配置迁移、基础文档、真实 Claude provider 手动 smoke、网络策略能力边界和最终验收报告。

**架构：** 保持 `packages/core` 阶段一内核为主线，不提前引入 CLI/Web 产品入口。可自动验证的内容进入 CI、Vitest 和静态检查；需要凭证或外部权限的真实 provider smoke 与远端 Actions 状态必须作为强门禁记录证据，不能降级为“未确认但完成”。

**技术栈：** TypeScript, pnpm 10.12.1, Vitest 3.2.x `test.projects`, GitHub Actions, actionlint 1.7.12, SQLite with `better-sqlite3`, Zod, Claude Code CLI manual smoke, Markdown and HTML review docs.

---

## 0. 硬门禁

以下门禁不满足时，本计划不能标记完成，只能标记 blocked：

- 最终提交已 push 到 `origin/rebuild-v2` 后，必须确认远端 `Core` workflow 对该提交成功。
- 真实 Claude provider smoke 必须在人工凭证环境执行成功，并把脱敏证据写入 release readiness report。
- 若当前 runtime 同时缺少 `GITHUB_TOKEN` 和已认证 `gh`，或缺少 Claude CLI / Claude auth，执行线程必须停止并报告阻塞条件，不能把这些项改写为建议项。
- PR 创建明确放在最后；本计划完成后只允许输出 PR 准备状态，不创建 PR。

## 1. Subagent 执行模型

- 控制线程按任务顺序执行，不并行修改共享文件。
- 每个任务使用一个 worker subagent 执行具体改动。
- 每个任务完成后启动两个最高思考等级 reviewer：先做 spec compliance review，再做 code quality review。
- reviewer 检出必须修复项时，回到同一任务 worker 修复，再复查。
- 所有 reviewer 结果写入最终发布就绪报告。

## 2. 调研结论

| 来源                     | 结论                                                                                                                                 | 对本计划的影响                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| CI/actionlint subagent   | 本机没有 `gh`/`actionlint`；远端 Actions 需要 `gh` 或 GitHub REST API token 才能确认；actionlint 应纳入本地和 CI                     | 新增 `scripts/ci/actionlint.sh`、`lint:actions`、workflow actionlint job、远端 Actions 状态脚本 |
| Claude provider subagent | 真实 Claude smoke 不应进入默认测试；CommandGateway 当前默认透传 `process.env`，需要 env allowlist/exact mode；smoke 必须 fail-closed | 新增手动 smoke、env 控制、凭证脱敏说明；未启用 smoke 或未认证时脚本失败                         |
| Network policy subagent  | `CommandPolicy.network` 目前不是能力边界；需要静态拒绝明显网络命令，并把 provider/network assurance 结构化                           | 增加 network command denial tests、provider mapping tests、文档纠偏                             |
| Vitest/docs subagent     | `vitest.workspace.ts` 应迁移到 `test.projects`；README/CHANGELOG 应创建；用户手册只能说明当前边界                                    | 新增 `vitest.config.ts`，删除 workspace 文件，创建 README/CHANGELOG/manual boundary             |

## 3. 文件结构

```text
donkey/
├── .github/workflows/core.yml
├── CHANGELOG.md
├── README.md
├── package.json
├── vitest.config.ts
├── packages/core/package.json
├── packages/core/src/runtime/agent-adapter.ts
├── packages/core/src/runtime/claude-code-adapter.ts
├── packages/core/src/runtime/command-gateway.ts
├── packages/core/__manual__/claude-code-provider.smoke.test.ts
├── packages/core/__tests__/runtime/agent-adapter.test.ts
├── packages/core/__tests__/runtime/claude-code-adapter.test.ts
├── packages/core/__tests__/runtime/command-gateway-env.test.ts
├── packages/core/__tests__/runtime/command-gateway-network.test.ts
├── scripts/ci/actionlint.sh
├── scripts/ci/check-github-actions.mjs
├── docs/manual/claude-provider-smoke.md
├── docs/manual/claude-provider-smoke.html
├── docs/manual/donkey-mvp-user-manual.md
├── docs/manual/donkey-mvp-user-manual.html
├── docs/reviews/2026-06-05-claude-provider-smoke-evidence.md
├── docs/reviews/2026-06-05-claude-provider-smoke-evidence.html
├── docs/reviews/2026-06-05-release-readiness-hardening-report.md
├── docs/reviews/2026-06-05-release-readiness-hardening-report.html
├── docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.md
├── docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html
├── docs/technical/donkey-v2-technical-plan.md
└── docs/technical/donkey-v2-technical-plan.html
```

`vitest.workspace.ts` 在任务 2 中删除。

## 4. 任务 1：CI actionlint 与远端 Actions 门禁

**文件：**

- 修改：`.github/workflows/core.yml`
- 修改：`package.json`
- 创建：`scripts/ci/actionlint.sh`
- 创建：`scripts/ci/check-github-actions.mjs`
- 修改：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md`
- 修改：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html`

- [ ] **步骤 1：编写 actionlint wrapper**

创建 `scripts/ci/actionlint.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

if command -v actionlint >/dev/null 2>&1; then
  exec actionlint -color "$@"
fi

if command -v docker >/dev/null 2>&1; then
  exec docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color "$@"
fi

cat >&2 <<'ACTIONLINT_MISSING'
actionlint is required but was not found.
Install actionlint locally or run with Docker available.
ACTIONLINT_MISSING
exit 127
```

- [ ] **步骤 2：增加根脚本**

修改 `package.json` 的 scripts，加入：

```json
{
  "lint:actions": "bash scripts/ci/actionlint.sh"
}
```

- [ ] **步骤 3：加固 workflow**

Update `.github/workflows/core.yml`:

```yaml
name: Core

on:
  push:
    branches:
      - rebuild-v2
      - main
  pull_request:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  actionlint:
    name: Lint GitHub Actions workflows
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Check workflow files
        uses: docker://rhysd/actionlint:1.7.12
        with:
          args: -color

  core:
    name: Core build and tests
    runs-on: ubuntu-latest
    needs: actionlint
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Install dependencies
        run: npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile

      - name: Verify native dependency builds
        run: |
          set -euo pipefail
          ignored="$(npm exec --yes -- pnpm@10.12.1 ignored-builds)"
          echo "$ignored"
          echo "$ignored" | grep -Eq "^[[:space:]]*None[[:space:]]*$"

      - name: Build core
        run: npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build

      - name: Run core unit tests
        run: npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit

      - name: Run core e2e tests
        run: npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
```

- [ ] **步骤 4：编写远端 Actions 状态脚本**

创建 `scripts/ci/check-github-actions.mjs`：

```js
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const owner = process.env.GITHUB_OWNER ?? 'zesming';
const repo = process.env.GITHUB_REPO ?? 'donkey';
const token = process.env.GITHUB_TOKEN;
const sha =
  process.env.GITHUB_SHA_TO_CHECK ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const url = new URL(
  `https://api.github.com/repos/${owner}/${repo}/actions/runs`,
);
url.searchParams.set('branch', 'rebuild-v2');
url.searchParams.set('head_sha', sha);
url.searchParams.set('per_page', '10');

if (!token) {
  console.error('GITHUB_TOKEN is required to verify remote GitHub Actions.');
  console.error(`Target: ${owner}/${repo}@${sha}`);
  process.exit(2);
}

const response = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

if (!response.ok) {
  console.error(
    `GitHub API request failed: ${response.status} ${response.statusText}`,
  );
  console.error(await response.text());
  process.exit(1);
}

const payload = await response.json();
const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
const coreRuns = runs.filter((run) => run.name === 'Core');

if (coreRuns.length === 0) {
  console.error(`No Core workflow run found for ${sha}.`);
  process.exit(1);
}

const latest = coreRuns[0];
console.log(
  `${latest.name} #${latest.run_number}: ${latest.status}/${latest.conclusion ?? 'pending'}`,
);
console.log(latest.html_url);

if (latest.status !== 'completed' || latest.conclusion !== 'success') {
  process.exit(1);
}
```

- [ ] **步骤 5：验证**

运行：

```bash
chmod +x scripts/ci/actionlint.sh scripts/ci/check-github-actions.mjs
bash -n scripts/ci/actionlint.sh
node --check scripts/ci/check-github-actions.mjs
npm exec --yes -- prettier --check .github/workflows/core.yml package.json scripts/ci/check-github-actions.mjs
bash scripts/ci/actionlint.sh
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
```

预期：

```text
actionlint exits 0
core build exits 0
unit: 18 test files passed, 33 tests passed
e2e: 2 test files passed, 2 tests passed
```

- [ ] **步骤 6：提交**

```bash
git add .github/workflows/core.yml package.json scripts/ci/actionlint.sh scripts/ci/check-github-actions.mjs docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html
git commit -m "ci: harden core workflow gates"
```

## 5. 任务 2：Vitest projects 迁移与基础文档

**文件：**

- 创建：`vitest.config.ts`
- 删除：`vitest.workspace.ts`
- 修改：`package.json`
- 创建：`README.md`
- 创建：`CHANGELOG.md`
- 创建：`docs/manual/donkey-mvp-user-manual.md`
- 创建：`docs/manual/donkey-mvp-user-manual.html`
- 修改：`docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.md`
- 修改：`docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html`
- 修改：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md`
- 修改：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html`

- [ ] **步骤 1：替换 Vitest workspace 配置**

创建 `vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
```

删除 `vitest.workspace.ts`。

- [ ] **步骤 2：保留简单根测试脚本**

保留根 `package.json`：

```json
{
  "scripts": {
    "test": "vitest"
  }
}
```

- [ ] **步骤 3：创建 README**

创建 `README.md`，正文使用以下中文内容：

````markdown
# Donkey

Donkey V2 是本地 Agent workflow 系统的重构分支。当前 `rebuild-v2` 已完成阶段一 core 内核；还没有面向终端用户的 CLI 或 Web 产品入口。

## 当前状态

- 已可用：`packages/core` TypeScript API，包括 CommandGateway、WorktreeManager、SQLite recovery、Artifact Store、Audit hash chain、GateEngine、HumanGate、Mock Agent、Claude Code adapter contract。
- 暂不可用：`donkey` CLI 命令、Web dashboard、自动 PR 创建、动态 workflow 产品流、面向用户的项目初始化入口。

## 本地验证

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm run lint:actions
```

## 文档入口

- 技术方案：`docs/technical/donkey-v2-technical-plan.html`
- 三阶段计划：`docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html`
- 阶段一评估：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html`
- 当前 MVP 边界：`docs/manual/donkey-mvp-user-manual.html`
````

- [ ] **步骤 4：创建 CHANGELOG**

创建 `CHANGELOG.md`：

```markdown
# 变更日志

## 未发布

### 新增

- 阶段一 `@donkey/core` 安全可恢复内核。
- GitHub Actions core validation workflow 和 native dependency build gate。
- actionlint workflow validation。
- README 和当前 MVP 边界手册。

### 变更

- Vitest 配置从 `vitest.workspace.ts` 迁移到 `vitest.config.ts` 的 `test.projects`。

### 说明

- Donkey 尚未发布面向终端用户的 CLI、Web dashboard 或自动 PR 创建流程。
```

- [ ] **步骤 5：创建 MVP 边界手册**

创建 `docs/manual/donkey-mvp-user-manual.md`：

````markdown
# Donkey MVP 用户边界手册

生成日期：2026-06-05
适用分支：`rebuild-v2`

## 当前可用范围

当前阶段只提供 `packages/core` 内核 API 和本地验证命令。普通用户还不能通过 `donkey` 命令发起需求、查看状态、打开 Web dashboard 或创建 PR。

## 用户现在如何判断结果

维护者可以通过以下命令判断阶段一内核是否健康：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
```

## 当前不能做什么

- 不能运行 `donkey init`、`donkey run`、`donkey status`、`donkey pause`、`donkey resume`。
- 不能通过 Donkey 创建远端 PR。
- 不能打开 Donkey Web dashboard。
- 不能把 `CommandPolicy.network` 理解为 OS 级网络隔离。

## 下一阶段预期

阶段二开始补 CLI、角色化 workflow、动态 workflow、普通用户入口和更严格的权限边界。维护者侧真实 provider smoke 已在本计划中提供手动执行路径。
````

创建同章节的 `docs/manual/donkey-mvp-user-manual.html`，不得加入当前不存在的产品 quickstart。

- [ ] **步骤 6：更新正式文档**

Update:

```text
docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.md
docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html
docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md
docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html
```

Required wording:

```text
Vitest 已迁移到根 `vitest.config.ts` 的 `test.projects`，不再使用旧 workspace 配置文件。
```

- [ ] **步骤 7：验证**

运行：

```bash
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- prettier --check README.md CHANGELOG.md docs/manual/donkey-mvp-user-manual.md docs/manual/donkey-mvp-user-manual.html vitest.config.ts package.json
test -f README.md
test -f CHANGELOG.md
test -f docs/manual/donkey-mvp-user-manual.html
```

运行未完成标记扫描；出现任何输出均失败。扫描范围只包含本任务预期新增或修改的交付物：

```bash
if rg -n "TB[D]|TO[D]O|FIXM[E]|placeholde[r]|待[补]|占[位]" README.md CHANGELOG.md docs/manual/donkey-mvp-user-manual.md docs/manual/donkey-mvp-user-manual.html docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html package.json packages/core vitest.config.ts; then
  exit 1
fi
```

运行 Vitest 迁移残留扫描；出现任何输出均失败。扫描范围故意排除本加固计划，避免匹配当前计划里的实施说明：

```bash
if rg -n "vitest[.]workspace[.]ts|defineWorkspac[e]" package.json packages docs/manual docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.md docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html vitest.config.ts; then
  exit 1
fi
```

预期：

```text
全部 test/build/typecheck 命令退出 0
手册 HTML 文件存在
未完成标记扫描无输出
迁移残留扫描无输出
```

- [ ] **步骤 8：提交**

```bash
git add README.md CHANGELOG.md docs/manual/donkey-mvp-user-manual.md docs/manual/donkey-mvp-user-manual.html vitest.config.ts package.json docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.md docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html
git rm vitest.workspace.ts
git commit -m "docs: add release readiness baseline"
```

## 6. 任务 3：CommandGateway 环境边界与 fail-closed Claude provider smoke

**文件：**

- 修改：`packages/core/src/runtime/command-gateway.ts`
- 创建：`packages/core/__tests__/runtime/command-gateway-env.test.ts`
- 创建：`packages/core/__manual__/claude-code-provider.smoke.test.ts`
- 修改：`packages/core/package.json`
- 修改：`package.json`
- 创建：`docs/manual/claude-provider-smoke.md`
- 创建：`docs/manual/claude-provider-smoke.html`
- 创建：`docs/reviews/2026-06-05-claude-provider-smoke-evidence.md`
- 创建：`docs/reviews/2026-06-05-claude-provider-smoke-evidence.html`

- [ ] **步骤 1：增加失败的 env 边界测试**

创建 `packages/core/__tests__/runtime/command-gateway-env.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCommandGateway,
  type SpawnImpl,
} from '../../src/runtime/command-gateway.js';

describe('command gateway environment boundary', () => {
  it('does not pass sensitive parent environment variables by default', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-env-'));
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'secret-value';
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnImpl = (_command, _args, options) => {
      receivedEnv = options.env;
      throw new Error('stop before spawn');
    };

    const gateway = createCommandGateway({ spawnImpl });
    const result = await gateway.run({
      command: { tool: 'node', args: ['-v'] },
      cwd,
      policy: {
        allow: [{ tool: 'node', args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    if (previous === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previous;
    }

    expect(result.status).toBe('rejected');
    expect(receivedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(receivedEnv?.PATH).toBeTruthy();
  });

  it('supports exact env for manual provider smoke', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-env-'));
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnImpl = (_command, _args, options) => {
      receivedEnv = options.env;
      throw new Error('stop before spawn');
    };

    const gateway = createCommandGateway({ spawnImpl });
    await gateway.run({
      command: { tool: 'node', args: ['-v'] },
      cwd,
      policy: {
        allow: [{ tool: 'node', args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
      envMode: 'exact',
      env: { PATH: '/usr/bin', HOME: '/tmp/donkey-home' },
    });

    expect(receivedEnv).toEqual({ PATH: '/usr/bin', HOME: '/tmp/donkey-home' });
  });
});
```

运行：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test -- __tests__/runtime/command-gateway-env.test.ts --run
```

预期：失败，原因是 `envMode` 尚未支持，且父进程环境变量仍会透传。

- [ ] **步骤 2：实现 env 控制**

修改 `packages/core/src/runtime/command-gateway.ts`：

```ts
export type CommandEnvironmentMode = 'safe-default' | 'inherit' | 'exact';

const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
] as const;

function buildChildEnv(input: {
  env?: NodeJS.ProcessEnv;
  envMode?: CommandEnvironmentMode;
}): NodeJS.ProcessEnv {
  if (input.envMode === 'inherit') {
    return { ...process.env, ...(input.env ?? {}) };
  }
  if (input.envMode === 'exact') {
    return { ...(input.env ?? {}) };
  }
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) {
      safeEnv[key] = process.env[key];
    }
  }
  return { ...safeEnv, ...(input.env ?? {}) };
}
```

Add `envMode?: CommandEnvironmentMode` to `CommandGatewayRunInput`, then pass `buildChildEnv(input)` into `runProcess`.

- [ ] **步骤 3：增加 fail-closed 的手动 Claude smoke**

创建 `packages/core/__manual__/claude-code-provider.smoke.test.ts`：

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter, createCommandGateway } from '../src/index.js';

describe('claude-code provider manual smoke', () => {
  it('requires explicit enablement and authenticated Claude CLI', async () => {
    if (process.env.DONKEY_CLAUDE_PROVIDER_SMOKE !== '1') {
      throw new Error(
        'DONKEY_CLAUDE_PROVIDER_SMOKE=1 is required; this smoke is fail-closed.',
      );
    }

    const claudeCommand = process.env.DONKEY_CLAUDE_COMMAND ?? 'claude';
    const version = execFileSync(claudeCommand, ['--version'], {
      encoding: 'utf8',
    }).trim();
    execFileSync(claudeCommand, ['auth', 'status'], { stdio: 'pipe' });

    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-claude-smoke-'));
    writeFileSync(
      join(repoPath, 'README.md'),
      'DONKEY_CLAUDE_PROVIDER_SMOKE_FIXTURE\n',
      'utf8',
    );
    const dataDir = join(repoPath, '.donkey');
    const outputDir = join(dataDir, 'smoke');
    const adapter = createClaudeCodeAdapter(
      {
        provider: 'claude-code',
        command: claudeCommand,
        promptMode: 'stdin',
        outputFormat: 'json',
        timeoutMs: 120_000,
        args: ['-p'],
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: [repoPath],
          network: 'restricted',
          tools: {
            allow: ['Read'],
            deny: ['Bash(rm *)', 'Bash(git push *)', 'WebFetch', 'WebSearch'],
          },
        },
      },
      createCommandGateway(),
    );

    const result = await adapter.runAgent({
      roleConfig: { role: 'reviewer' },
      prompt:
        'Read README.md and print DONKEY_CLAUDE_PROVIDER_SMOKE_OK. Do not edit files.',
      worktreeLease: {
        id: 'lease_smoke',
        runId: 'run_smoke',
        nodeId: 'node_claude',
        role: 'reviewer',
        repoPath,
        worktreePath: repoPath,
        branchName: 'donkey/run_smoke/node_claude-reviewer',
        createdAt: new Date().toISOString(),
      },
      outputDir,
      commandPolicy: {
        allow: [{ tool: claudeCommand, args: ['-p'] }],
        deny: [],
        cwdScope: [repoPath],
        network: 'restricted',
      },
      runContext: {
        projectId: 'manual',
        runId: 'run_smoke',
        nodeId: 'node_claude',
        repoPath,
        dataDir,
      },
    });

    expect(version.length).toBeGreaterThan(0);
    expect(result.provider).toBe('claude-code');
    expect(result.exitCode).toBe(0);
    expect(result.outputFiles).toHaveLength(2);
    expect(readFileSync(result.outputFiles[0]!, 'utf8')).toContain(
      'DONKEY_CLAUDE_PROVIDER_SMOKE_OK',
    );
  });
});
```

- [ ] **步骤 4：增加 smoke 脚本**

修改 `packages/core/package.json`：

```json
{
  "scripts": {
    "smoke:claude-provider": "vitest --run __manual__/claude-code-provider.smoke.test.ts"
  }
}
```

修改根 `package.json`：

```json
{
  "scripts": {
    "smoke:claude-provider": "pnpm --filter @donkey/core smoke:claude-provider"
  }
}
```

- [ ] **步骤 5：创建手册和证据模板**

创建中文 `docs/manual/claude-provider-smoke.md`：

````markdown
# Claude Provider Smoke 手动验证手册

## 目的

本手册验证 Donkey 能通过 CommandGateway 启动真实 Claude Code provider。该 smoke 不进入默认 CI，必须由维护者在已认证环境显式执行。

## 前置条件

- 本机已安装 Claude Code CLI。
- `claude auth status` 返回成功。
- 不把 API key、token、认证输出或环境变量值写入命令行、报告或 git。

## 命令

```bash
DONKEY_CLAUDE_PROVIDER_SMOKE=1 \
DONKEY_CLAUDE_COMMAND=claude \
npm run smoke:claude-provider
```

## 成功标准

- 命令退出 0。
- stdout 包含 `DONKEY_CLAUDE_PROVIDER_SMOKE_OK`。
- 报告只记录 Claude CLI version、exit code、duration、stdout/stderr 文件路径和脱敏说明。

## 当前边界

该 smoke 不证明 OS 级网络隔离。它只验证 Donkey 命令构造、权限模式不 bypass、cwd scope、env 控制、timeout 和日志捕获。
````

创建同章节 HTML。

运行 smoke 后创建 `docs/reviews/2026-06-05-claude-provider-smoke-evidence.md`：

```markdown
# Claude Provider Smoke 证据

生成日期：2026-06-05

## 结论

真实 Claude provider smoke 已执行成功。

## 证据

- Claude CLI version: 填入 `claude --version` 的输出
- command: `DONKEY_CLAUDE_PROVIDER_SMOKE=1 DONKEY_CLAUDE_COMMAND=claude npm run smoke:claude-provider`
- exit code: 0
- stdout log path: 填入本次 smoke 生成的 stdout 文件路径
- stderr log path: 填入本次 smoke 生成的 stderr 文件路径

## 脱敏说明

未记录 API key、token、认证输出或环境变量值。
```

创建同章节 evidence HTML。

- [ ] **步骤 6：验证**

运行：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test -- __tests__/runtime/command-gateway-env.test.ts --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- prettier --check packages/core/__manual__/claude-code-provider.smoke.test.ts docs/manual/claude-provider-smoke.md docs/manual/claude-provider-smoke.html docs/reviews/2026-06-05-claude-provider-smoke-evidence.md docs/reviews/2026-06-05-claude-provider-smoke-evidence.html
```

运行 fail-closed smoke；该命令是完成门禁，不能跳过：

```bash
DONKEY_CLAUDE_PROVIDER_SMOKE=1 DONKEY_CLAUDE_COMMAND=claude npm run smoke:claude-provider
```

预期：

```text
env tests pass
unit and e2e pass
Claude smoke exits 0 and evidence report is written
```

- [ ] **步骤 7：提交**

```bash
git add packages/core/src/runtime/command-gateway.ts packages/core/__tests__/runtime/command-gateway-env.test.ts packages/core/__manual__/claude-code-provider.smoke.test.ts packages/core/package.json package.json docs/manual/claude-provider-smoke.md docs/manual/claude-provider-smoke.html docs/reviews/2026-06-05-claude-provider-smoke-evidence.md docs/reviews/2026-06-05-claude-provider-smoke-evidence.html
git commit -m "test(core): add claude provider smoke boundary"
```

## 7. 任务 4：Network policy 能力边界

**文件：**

- 修改：`packages/core/src/runtime/agent-adapter.ts`
- 修改：`packages/core/src/runtime/claude-code-adapter.ts`
- 修改：`packages/core/src/runtime/command-gateway.ts`
- 修改：`packages/core/__tests__/runtime/agent-adapter.test.ts`
- 修改：`packages/core/__tests__/runtime/claude-code-adapter.test.ts`
- 创建：`packages/core/__tests__/runtime/command-gateway-network.test.ts`
- 修改：`docs/technical/donkey-v2-technical-plan.md`
- 修改：`docs/technical/donkey-v2-technical-plan.html`
- 修改：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md`
- 修改：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html`

- [ ] **步骤 1：增加失败的网络拒绝测试**

创建 `packages/core/__tests__/runtime/command-gateway-network.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCommandGateway,
  type SpawnImpl,
} from '../../src/runtime/command-gateway.js';

describe('command gateway network policy', () => {
  it.each([
    { tool: 'curl', args: ['https://example.com'] },
    { tool: 'wget', args: ['https://example.com'] },
    { tool: 'ssh', args: ['git@example.com'] },
    { tool: 'git', args: ['fetch'] },
    { tool: 'git', args: ['push'] },
    { tool: 'npm', args: ['install'] },
    { tool: 'pnpm', args: ['install'] },
    { tool: 'npx', args: ['some-package'] },
  ])(
    'rejects known network command $tool $args before spawn when network is disabled',
    async (command) => {
      const cwd = mkdtempSync(join(tmpdir(), 'donkey-network-'));
      let spawnCalls = 0;
      const spawnImpl: SpawnImpl = () => {
        spawnCalls += 1;
        throw new Error('spawn should not run');
      };
      const gateway = createCommandGateway({ spawnImpl });

      const result = await gateway.run({
        command,
        cwd,
        policy: {
          allow: [command],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      });

      expect(result).toEqual({
        status: 'rejected',
        reason: 'network command is not allowed by policy',
      });
      expect(spawnCalls).toBe(0);
    },
  );
});
```

运行：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test -- __tests__/runtime/command-gateway-network.test.ts --run
```

预期：失败，原因是 network policy 尚未生效。

- [ ] **步骤 2：实现静态网络命令拒绝**

修改 `packages/core/src/runtime/command-gateway.ts`：

```ts
function isKnownNetworkCommand(command: CommandInvocation): boolean {
  const tool = basename(command.tool);
  if (['curl', 'wget', 'ssh', 'scp', 'sftp', 'npx'].includes(tool)) {
    return true;
  }
  if (tool === 'git') {
    return [
      'fetch',
      'pull',
      'push',
      'clone',
      'ls-remote',
      'submodule',
    ].includes(command.args[0] ?? '');
  }
  if (tool === 'npm' || tool === 'pnpm') {
    return ['install', 'add', 'update', 'dlx', 'exec'].includes(
      command.args[0] ?? '',
    );
  }
  if (tool === 'gh') {
    return ['api', 'pr', 'repo', 'run'].includes(command.args[0] ?? '');
  }
  return false;
}
```

Call after dangerous remove/force push checks:

```ts
if (policy.network !== 'enabled' && isKnownNetworkCommand(command)) {
  return 'network command is not allowed by policy';
}
```

- [ ] **步骤 3：结构化 provider network assurance**

修改 `packages/core/src/runtime/agent-adapter.ts`：

```ts
export type NetworkEnforcement =
  | 'declared'
  | 'provider-enforced'
  | 'os-enforced';

export interface NetworkCapabilityEvidence {
  mode: 'disabled' | 'restricted' | 'enabled';
  enforcement: NetworkEnforcement;
  allowHosts: string[];
  evidence: string[];
}
```

For mock provider, return:

```ts
network: {
  mode: "disabled",
  enforcement: "declared",
  allowHosts: [],
  evidence: ["mock provider does not spawn a child process"],
}
```

For real provider, require `permissionProfile.network !== "enabled"` and map:

```ts
network: {
  mode: network as "disabled" | "restricted",
  enforcement: "declared",
  allowHosts: [],
  evidence: ["provider permission profile declares network control"],
}
```

除非 OS/container runner probe 已执行并通过，否则不得使用 `os-enforced`。

- [ ] **步骤 4：拒绝不安全 Claude args**

修改 `packages/core/src/runtime/claude-code-adapter.ts`：

```ts
function assertSafeClaudeArgs(args: string[]): void {
  if (
    args.some(
      (arg) =>
        arg === '--permission-mode' || arg.startsWith('--permission-mode='),
    )
  ) {
    throw new Error('claude permission mode is controlled by Donkey');
  }
  if (
    args.some(
      (arg) =>
        arg === 'bypassPermissions' ||
        arg.startsWith('--dangerously-skip-permissions') ||
        arg.includes('bypassPermissions'),
    )
  ) {
    throw new Error('claude bypass permissions mode is not allowed');
  }
}
```

在 `buildClaudeCodeCommand` 开始处调用。

- [ ] **步骤 5：增加 provider 测试**

修改 `packages/core/__tests__/runtime/claude-code-adapter.test.ts`，增加以下测试：

```ts
const safeConfig = {
  provider: 'claude-code' as const,
  command: 'claude',
  args: [],
  promptMode: 'stdin' as const,
  outputFormat: 'json' as const,
  timeoutMs: 1000,
  permissionProfile: safePermissionProfile('/tmp/repo'),
};

expect(() =>
  buildClaudeCodeCommand(
    { ...safeConfig, args: ['--permission-mode', 'bypassPermissions'] },
    { prompt: 'x' },
  ),
).toThrow('permission mode is controlled by Donkey');

expect(() =>
  buildClaudeCodeCommand(
    { ...safeConfig, args: ['--permission-mode=bypassPermissions'] },
    { prompt: 'x' },
  ),
).toThrow('permission mode is controlled by Donkey');

expect(() =>
  buildClaudeCodeCommand(
    { ...safeConfig, args: ['--dangerously-skip-permissions'] },
    { prompt: 'x' },
  ),
).toThrow('bypass permissions mode is not allowed');
```

修改 `packages/core/__tests__/runtime/agent-adapter.test.ts`，断言结构化 network evidence：

```ts
const mapping = assertAgentProviderCapabilities({ provider: 'mock' });
expect(mapping.network).toEqual({
  mode: 'disabled',
  enforcement: 'declared',
  allowHosts: [],
  evidence: ['mock provider does not spawn a child process'],
});
```

- [ ] **步骤 6：修正正式文档**

Update:

```text
docs/technical/donkey-v2-technical-plan.md
docs/technical/donkey-v2-technical-plan.html
docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md
docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html
```

Required wording:

```text
`bypassPermissions` 不作为 Donkey 默认或推荐模式。只有在外层 OS/container sandbox 已验证、HumanGate 已批准、并且证据报告记录隔离方式时，才允许作为受控实验配置。

`CommandPolicy.network` 当前分为静态命令拒绝、provider 声明映射和后续 OS 级隔离三个层级。阶段一只能声明前两个层级，不声称已实现 OS 级断网。
```

- [ ] **步骤 7：验证**

运行：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test -- __tests__/runtime/command-gateway-network.test.ts --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test -- __tests__/runtime/agent-adapter.test.ts __tests__/runtime/claude-code-adapter.test.ts --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
```

运行：

```bash
if rg -n "bypassPermissions" docs/technical/donkey-v2-technical-plan.md docs/technical/donkey-v2-technical-plan.html docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html packages/core; then
  echo "Review every match and keep only explicitly unsafe/historical references."
fi
```

预期：

```text
network tests 通过
agent adapter tests 通过
claude adapter tests 通过
剩余 bypassPermissions 命中都明确标注为非默认模式，且说明没有外层 sandbox 时不安全
```

- [ ] **步骤 8：提交**

```bash
git add packages/core/src/runtime/command-gateway.ts packages/core/src/runtime/agent-adapter.ts packages/core/src/runtime/claude-code-adapter.ts packages/core/__tests__/runtime/command-gateway-network.test.ts packages/core/__tests__/runtime/agent-adapter.test.ts packages/core/__tests__/runtime/claude-code-adapter.test.ts docs/technical/donkey-v2-technical-plan.md docs/technical/donkey-v2-technical-plan.html docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html
git commit -m "fix(core): clarify and enforce network policy boundary"
```

## 8. 任务 5：最终发布就绪报告与远端 CI 证据

**文件：**

- 创建：`docs/reviews/2026-06-05-release-readiness-hardening-report.md`
- 创建：`docs/reviews/2026-06-05-release-readiness-hardening-report.html`
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：运行全量本地验证**

运行：

```bash
git status --short --branch
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm run lint:actions
npm exec --yes -- prettier --check .
git diff --check
```

运行未完成标记扫描；出现任何输出均失败。扫描范围只包含本计划实际新增或修改的交付物，故意排除实施计划自身：

```bash
if rg -n "TB[D]|TO[D]O|FIXM[E]|placeholde[r]|待[补]|占[位]" README.md CHANGELOG.md docs/manual/donkey-mvp-user-manual.md docs/manual/donkey-mvp-user-manual.html docs/manual/claude-provider-smoke.md docs/manual/claude-provider-smoke.html docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html docs/reviews/2026-06-05-claude-provider-smoke-evidence.md docs/reviews/2026-06-05-claude-provider-smoke-evidence.html docs/reviews/2026-06-05-release-readiness-hardening-report.md docs/reviews/2026-06-05-release-readiness-hardening-report.html packages/core .github/workflows/core.yml scripts/ci package.json pnpm-workspace.yaml vitest.config.ts; then
  exit 1
fi
```

- [ ] **步骤 2：推送代码完成提交**

运行：

```bash
git push origin rebuild-v2
CODE_COMPLETE_SHA="$(git rev-parse HEAD)"
git ls-remote --heads origin rebuild-v2
```

预期：远端 `rebuild-v2` SHA 等于 `CODE_COMPLETE_SHA`。这个 SHA 表示代码和基础文档完成提交，不是最终报告提交。

- [ ] **步骤 3：确认代码完成提交的远端 Actions**

运行以下任一方式。使用脚本方式时，先在 shell 环境中提供只读 `GITHUB_TOKEN`，不要把 token 写入报告或 git：

```bash
GITHUB_SHA_TO_CHECK="$CODE_COMPLETE_SHA" node scripts/ci/check-github-actions.mjs
```

或：

```bash
gh run list --repo zesming/donkey --workflow core.yml --branch rebuild-v2 --commit "$CODE_COMPLETE_SHA" --limit 10
gh run view "$RUN_ID" --log-failed
```

预期：代码完成提交对应的 `Core` workflow 为 `completed/success`。

如果既没有 `GITHUB_TOKEN` 也没有已认证 `gh`，停止并报告 blocked。不得创建声称“除 PR 外均已完成”的最终报告。

- [ ] **步骤 4：创建发布就绪报告草稿**

创建 `docs/reviews/2026-06-05-release-readiness-hardening-report.md`：

```markdown
# Donkey V2 发布就绪加固报告

生成日期：2026-06-05
分支：`rebuild-v2`
代码完成提交 SHA：步骤 2 记录的 `CODE_COMPLETE_SHA`
代码完成提交远端 Core workflow：`completed/success`
代码完成提交 workflow URL：步骤 3 输出的 workflow URL
报告提交 SHA：提交后产生，最终交付说明记录。
报告提交远端 Core workflow：提交后确认，最终交付说明记录。

## 1. 结论

代码完成提交已通过本地 gate 和远端 Core workflow。最终“除 PR 外均已完成”结论必须等本报告提交后的远端 Core workflow 也通过后，才能在交付说明中声明。

## 2. 本地验证摘要

记录每条本地命令、退出状态、测试数量。

## 3. 远端 CI 证据：代码完成提交

- workflow: Core
- commit: 步骤 2 记录的 `CODE_COMPLETE_SHA`
- status: completed/success
- url: 步骤 3 输出的 workflow URL

## 4. Claude Provider Smoke 证据

- Claude CLI version: 填入 `claude --version` 的输出
- command: `DONKEY_CLAUDE_PROVIDER_SMOKE=1 DONKEY_CLAUDE_COMMAND=claude npm run smoke:claude-provider`
- exit code: 0
- stdout log path: 填入本次 smoke 生成的 stdout 文件路径
- stderr log path: 填入本次 smoke 生成的 stderr 文件路径
- 脱敏说明：未记录 API key、token、认证输出或环境变量值。

## 5. 已知边界

- PR 创建仍放在最后。
- OS 级网络隔离仍是后续增强项，当前只完成静态拒绝和 provider evidence mapping。

## 6. Subagent Review

最终 reviewer 待步骤 7 执行。本节在 reviewer 通过后补写：reviewer 结论、必须修复项、修复摘要和复查结果。

## 7. 报告提交后的远端 CI

报告提交 SHA 和最终远端 Core workflow URL 在最终交付说明记录；不回写本文件，避免为了记录最终 workflow URL 产生新的提交循环。
```

创建同章节 HTML。

- [ ] **步骤 5：更新 changelog 的已验证事实**

追加到 `CHANGELOG.md`：

```markdown
### 已验证

- 发布就绪加固本地 gate 已通过。
- 代码完成提交的远端 Core workflow 已通过。
- Claude provider 手动 smoke 已在认证本地环境通过。
```

- [ ] **步骤 6：验证报告、HTML 和 changelog**

运行：

```bash
npm exec --yes -- prettier --check docs/reviews/2026-06-05-release-readiness-hardening-report.md docs/reviews/2026-06-05-release-readiness-hardening-report.html CHANGELOG.md
test -f docs/reviews/2026-06-05-release-readiness-hardening-report.md
test -f docs/reviews/2026-06-05-release-readiness-hardening-report.html
if rg -n "TB[D]|TO[D]O|FIXM[E]|placeholde[r]|待[补]|占[位]" docs/reviews/2026-06-05-release-readiness-hardening-report.md docs/reviews/2026-06-05-release-readiness-hardening-report.html CHANGELOG.md; then
  exit 1
fi
git diff --check
```

预期：报告和 changelog 相关验证均退出 0。

- [ ] **步骤 7：最终 subagent review**

委派最高思考等级 reviewer：

```text
审阅全部 release readiness hardening 变更。检查需求覆盖、安全边界声明、测试、文档、CI、Claude smoke 证据，以及 PR 是否为唯一剩余事项。不要修改文件。返回 APPROVED 或 CHANGES_REQUIRED。
```

预期：reviewer 返回 `APPROVED`。若返回 `CHANGES_REQUIRED`，先修复，再重新执行步骤 6 和步骤 7。

- [ ] **步骤 8：补写最终 review 结果**

若步骤 7 返回 `APPROVED`，更新报告的第 6 节，并在 `CHANGELOG.md` 的 `### 已验证` 下追加：

```markdown
- 最高思考等级 subagent review 已通过，未检出必须修复项。
```

如果 reviewer 提出过必须修复项，报告第 6 节必须列出问题、修复摘要和复查结论。

- [ ] **步骤 9：最终本地复验**

运行：

```bash
npm exec --yes -- prettier --check docs/reviews/2026-06-05-release-readiness-hardening-report.md docs/reviews/2026-06-05-release-readiness-hardening-report.html CHANGELOG.md
if rg -n "TB[D]|TO[D]O|FIXM[E]|placeholde[r]|待[补]|占[位]" docs/reviews/2026-06-05-release-readiness-hardening-report.md docs/reviews/2026-06-05-release-readiness-hardening-report.html CHANGELOG.md; then
  exit 1
fi
git diff --check
```

预期：所有命令退出 0。

- [ ] **步骤 10：提交报告并推送**

```bash
git add docs/reviews/2026-06-05-release-readiness-hardening-report.md docs/reviews/2026-06-05-release-readiness-hardening-report.html CHANGELOG.md
git commit -m "docs: add release readiness hardening report"
git push origin rebuild-v2
REPORT_SHA="$(git rev-parse HEAD)"
```

- [ ] **步骤 11：确认报告提交的远端 Actions**

运行以下任一方式。使用脚本方式时，沿用 shell 环境中的只读 `GITHUB_TOKEN`：

```bash
GITHUB_SHA_TO_CHECK="$REPORT_SHA" node scripts/ci/check-github-actions.mjs
```

或：

```bash
gh run list --repo zesming/donkey --workflow core.yml --branch rebuild-v2 --commit "$REPORT_SHA" --limit 10
gh run view "$RUN_ID" --log-failed
```

预期：报告提交对应的 `Core` workflow 为 `completed/success`，并在最终交付说明中记录报告提交 SHA 和 workflow URL。

如果报告提交的远端 workflow 不是 green，计划保持 active 并修复失败；不得宣称所有非 PR 项已完成。

- [ ] **步骤 12：PR 准备保持最后**

只有步骤 11 通过后才能输出：

```text
除 PR 外的发布就绪项均已完成。剩余最终动作：创建从 rebuild-v2 到 main 的 PR。
```

## 9. 外部资料依据

| 主题                          | URL                                                             | 用途                                            |
| ----------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| GitHub workflow runs REST API | `https://docs.github.com/en/rest/actions/workflow-runs`         | 没有 `gh` 时查询远端 Actions 状态               |
| actionlint 安装和使用         | `https://github.com/rhysd/actionlint/blob/main/docs/install.md` | 增加本地和 CI workflow lint                     |
| Vitest projects               | `https://vitest.dev/guide/projects`                             | 用 `test.projects` 替代旧 workspace 配置文件    |
| Claude Code CLI reference     | `https://code.claude.com/docs/en/cli-reference`                 | 定义手动 provider smoke 的命令和成功标准        |
| Claude Code permissions       | `https://code.claude.com/docs/en/permissions`                   | 避免把 prompt 规则误当作 provider-enforced 权限 |
| pnpm ignored builds           | `https://pnpm.io/10.x/cli/ignored-builds`                       | 保留 native dependency build gate               |
| Docker none network           | `https://docs.docker.com/engine/network/drivers/none/`          | 作为后续 OS 级 network isolation 的候选实现     |

## 10. 自检

- 需求覆盖：覆盖远端 CI 确认、actionlint、真实 provider smoke、network 边界、Vitest 迁移、README、CHANGELOG、manual 边界和最终报告，并把 PR 创建保留为最后动作。
- 门禁严格性：远端 Actions 和 Claude smoke 都是硬门禁；缺少凭证或工具时是 blocked，不是成功。
- 类型一致性：smoke 示例包含 `WorktreeLease` 和 `RunContext` 的全部必填字段。
- 安全声明：在 OS/container runner probe 通过前，不声称已实现 OS 级网络隔离。
- 执行模式：使用 subagent-driven development，并在每个任务后执行 reviewer 复查循环。
