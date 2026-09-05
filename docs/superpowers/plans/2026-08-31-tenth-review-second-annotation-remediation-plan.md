# 第十轮报告第二轮批注整改执行方案

- **日期**：2026-08-31
- **依据**：`docs/reviews/2026-08-31-tekon-human-first-harness-tenth-review.md` 第 17 节批注
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)（分支 `review/human-first-harness-2026-08-28`）
- **基线快照**：`479b941`（`pnpm test` 137 文件 / 1472 通过 / 3 跳过）
- **DSH 官方基线**：`0a53fb55bea101816fa226bb964ae2bed71c343b`（`dsh@0.1.2-alpha.2`）
- **版本 bump 评估**：PATCH（`0.20.1 → 0.20.2`），理由：安全补丁 + CI 修复 + 文档勘误 + pin 升级（pin 是测试合同更新，非新功能）

## 1. 范围

本方案只收敛批注 17.3 锁定的四项，全部满足"证据明确 + 改动局部 + 有明确验收信号"。

**在范围内**：

1. DSH tested pin 升级 `0.1.2-alpha.1 → 0.1.2-alpha.2`（P1-DSH-01 pin 部分）；
2. CI e2e 脚本修复（`engine-rework.e2e.test.ts` 被遗漏）；
3. `react-router` 安全升级（`^7.17.0 → ^7.18.2`）；
4. HTML 标签语法修复（`follow-up-review.html:669`）。

**明确不在范围内**（保持报告原裁决，登记为后续顺序）：8 项 P0/P1 架构重构、GateEngine 冗余清理、CI 多 Node 矩阵、子包版本号同步、手册命令补全。

## 2. 产品细节

### 2.1 DSH pin 升级（用户可感知）

- preflight 输出的 tested 版本更新为 `0.1.2-alpha.2`；
- 安装指引中的版本号同步更新；
- 手册 §5.7 的"当前 `0.1.2-alpha.1`"更新为 `0.1.2-alpha.2`；
- **诚实标注**：fixture 头部注释保持"源码级交叉校验，非本机实测"，不声称已完成真实 provider smoke。

### 2.2 CI e2e 修复（开发者可感知）

- `packages/core/package.json` 的 `test:e2e` 改为按 `.e2e.test` 子串匹配（精确命中 `.e2e.test.ts` 后缀），避免未来新增 e2e 文件再次被遗漏；
- CI 的 `core` workflow 现在会执行全部 8 个 e2e 测试文件。

### 2.3 react-router 安全升级（用户不可感知）

- 修复 2 个 high（CSRF 绕过、未认证 DoS）+ 3 个 moderate 漏洞；
- 无 API breaking change（7.17→7.18 是 minor 升级）；
- 本仓库为 Vite SPA 模式（无 SSR/`__manifest` 端点），实际暴露面有限，升级主要为消除 audit 告警与依赖卫生。

### 2.4 HTML 标签修复（无功能影响）

- 修复 `follow-up-review.html:669` 的未闭合 `<code>` 标签；
- `pnpm format:check` 恢复通过。

## 3. 设计细节

### 3.1 DSH pin 升级

- `packages/core/src/runtime/dsh-bridge-probe.ts`：`TESTED_DSH_VERSION = '0.1.2-alpha.2'`；
- `packages/core/__tests__/fixtures/dsh/version.txt`：更新为 `0.1.2-alpha.2`；
- `packages/core/__tests__/fixtures/dsh/headless-dump-default-config.txt`：头部注释的 commit hash 更新为 `0a53fb55`，版本号更新为 `0.1.2-alpha.2`；
- `headless-help.txt`：无需改动（alpha.2 的 help 输出与 alpha.1 完全一致）；
- CLI 测试中的 `TESTED_DSH_VERSION` 引用自动更新（从 core 导入）。

### 3.2 CI e2e 修复

- `packages/core/package.json`：`"test:e2e": "vitest --run .e2e.test"`（前导点子串，精确匹配 `.e2e.test.ts` 后缀，排除 `-e2e.test.ts` 命名反例）；
- 验证：本地执行 `pnpm --filter @tekon/core test:e2e` 确认 8 个文件全部被执行。

### 3.3 react-router 升级

- `packages/web/package.json`：`"react-router": "^7.18.2"`；
- `pnpm install` 更新 lockfile；
- 验证：`pnpm --filter @tekon/web build` + `pnpm --filter @tekon/web test` + Playwright e2e 全绿。

### 3.4 HTML 标签修复

- `docs/reviews/2026-08-28-tekon-human-first-harness-follow-up-review.html:669`：`<code>job-runner.stop()`` → `<code>job-runner.stop()</code>`；
- 验证：该文件不再被 prettier 报 parse error（`format:check` 全仓存量待办不在本轮范围）。

## 4. 实现顺序（测试先行）

1. **DSH pin**：先改 fixture 与 `TESTED_DSH_VERSION`，跑 core 测试确认全绿（fixture 是源码级交叉校验，help/config 内容不变，只有版本号和注释 hash 变化）；
2. **CI e2e**：改 `test:e2e` 脚本，本地验证 8 个文件全部执行；
3. **react-router**：升级版本，`pnpm install`，跑 web build + test + Playwright；
4. **HTML 修复**：改标签，跑 `format:check`；
5. 全量 `pnpm test`；
6. reviewer 循环（最高思考等级）：方案评审 → 代码评审 → 验收评审；
7. 提交到 PR #11，提交信息含 `v0.20.2`。

## 5. 验收标准

- `pnpm test` 全绿：通过用例数 ≥ 基线（1472），跳过数不增（仍为 3）；
- `pnpm --filter @tekon/core test:e2e` exit 0 且恰好命中 8 个 `.e2e.test.ts` 文件（含 `engine-rework.e2e.test.ts`），不含 `session-job-e2e.test.ts`；
- `pnpm audit --prod` 无 high 漏洞；
- HTML 标签闭合修复（`follow-up-review.html` 的 parse error 消除）；`format:check` 全仓存量待办不在本轮范围；
- preflight 输出 tested 版本为 `0.1.2-alpha.2`；
- 手册 §5.7 版本号同步；
- Playwright e2e 全绿（react-router 升级无 UI 回归）；
- reviewer 最终一轮未检出必须修复项。

## 6. 风险与回退

- DSH pin 升级：alpha.2 与 alpha.1 的 headless 合同零差异（help/config/Node engines 均未变；headless + base 两个合同相关 bundle 的 cordis.patch.yml diff 为空，sdk-minimal/web-app bundle 的变化不在 headless 合同路径上），风险极低；若真实 smoke 发现问题，可回退 pin 到 alpha.1；
- react-router 升级：7.17→7.18 是安全补丁 minor，无 API 变更；Playwright e2e 覆盖主要 UI 路径；
- CI e2e 子串匹配：仓库存在 `session-job-e2e.test.ts`（`-e2e` 后缀）命名反例，必须用带前导点的 `.e2e.test` 子串规避，不能用裸 `e2e.test` 子串；
- HTML 修复：纯标签闭合，无内容变化。
