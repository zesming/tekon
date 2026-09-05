# 第十一轮复审批注整改执行方案

- **日期**：2026-08-31
- **依据**：`docs/reviews/2026-08-31-tekon-product-runtime-harness-eleventh-review.md` 第 12、13、16 节
- **基线**：分支 `review/human-first-harness-2026-08-28`，HEAD `19deedf`，版本 `0.20.2`
- **范围原则**：仅收敛报告第 16.3 节三项低风险过程/卫生项；P0/P1 架构主线（single-owner Runtime、权威 Session、ACP vertical slice、RunPlan authority、模型 compaction、全站 a11y）维持冻结，分独立 PR 推进，不在本 PR 伪装关闭。

## 1. 整改项与验收标准

### 1.1 P2-TEST-02：CLI e2e 文件命名与 lane 语义对齐

**问题**：`packages/cli/__tests__/e2e/` 下三个文件命名为 `*.test.ts`，匹配不上 `--exclude "**/*.e2e.test.ts"`，导致真实子进程 e2e 用例同时进入 unit lane 与 e2e lane 各跑一遍，破坏「快速 unit gate / 慢速 e2e gate」分层。

**根因对比**：`packages/core` 已用 `*.e2e.test.ts` 约定，`test:e2e` 选择器为 `.e2e.test`；`packages/cli` 用 `*.test.ts` + 目录选择器 `__tests__/e2e`，两套约定不一致。

**改动**：
1. 重命名三个文件（纯 `git mv`，不改内容）：
   - `packages/cli/__tests__/e2e/cli-flow.test.ts` → `cli-flow.e2e.test.ts`
   - `packages/cli/__tests__/e2e/provider-preflight.test.ts` → `provider-preflight.e2e.test.ts`
   - `packages/cli/__tests__/e2e/release-flow.test.ts` → `release-flow.e2e.test.ts`
2. `packages/cli/package.json` 的 `test:e2e` 脚本从 `pnpm --filter @tekon/core build && pnpm --filter @tekon/cli build && vitest --run __tests__/e2e` 改为 `pnpm --filter @tekon/core build && pnpm --filter @tekon/cli build && vitest --run .e2e.test`（只替换末段选择器，保留两段 build 前缀，与 core 包对齐）。
3. `test` / `test:unit` 的 `--exclude "**/*.e2e.test.ts"` 不变，现在能真正排除这三个文件。

**验收**：
- `pnpm --filter @tekon/cli test:unit` 不再执行这三个 e2e 文件（用 `--reporter=verbose` 确认文件列表不含 e2e）。
- `pnpm --filter @tekon/cli test:e2e` 仍执行这三个文件且全部通过。
- 全量 `pnpm test` 通过。

### 1.2 CI npm env warning 噪音清理

**问题**：CI 中 `npm exec --yes -- pnpm@10.12.1 ...` 透传 `npm_config_*` 触发 npm 未知 env config 弃用警告，不阻断但降低真实错误信噪比。

**改动**：把 `.github/workflows/ci.yml` 中所有 `npm exec --yes -- pnpm@10.12.1` 替换为 `corepack pnpm`。根 `package.json` 的 `packageManager: "pnpm@10.12.1"` 已钉死版本，corepack 会按该字段解析，本地验证 `corepack pnpm --version` = `10.12.1`。

**注意**：`actions/setup-node@v4` 默认不启用 corepack，需在每个 job 的 setup-node 后加一步 `run: corepack enable`（或直接用 `corepack pnpm`，corepack 0.32+ 自带 shim 解析）。采用后者更简单：直接 `corepack pnpm ...`，无需 enable。

**验收**：
- CI 日志不再出现 `npm warn config ... Unknown env config`。
- 所有 CI job（typecheck / cli / web / web-e2e）仍成功。
- 本地 `corepack pnpm -r build` / `corepack pnpm test` 通过。

### 1.3 devDependencies 漏洞治理

**问题**：全量 `pnpm audit` 检出 12 项（9 High / 1 Moderate / 2 Low），全部来自 devDependencies，不暴露于生产运行时。

**改动**：在根 `package.json` 增加 `pnpm.overrides`（最终落地形态，按 reviewer 建议从 `>=` 范围收紧为精确钉版）：
```json
"pnpm": {
  "overrides": {
    "brace-expansion@^2.0.0": "2.1.4",
    "brace-expansion@^5.0.0": "5.0.9",
    "postcss@^8.0.0": "8.5.26",
    "nanoid@^3.0.0": "3.3.18"
  }
}
```
- `brace-expansion` 按声明范围分桶：`minimatch@9` 声明 `^2.0.2` → `2.1.4`，`minimatch@10` 声明 `^5.0.5` → `5.0.9`。
- **不设 3.x/4.x 桶**：当前依赖树只装 2.x 与 5.x（`minimatch@9`→2.x、`minimatch@10`→5.x），无 3.x/4.x 实例，advisory `>=3.0.0 <5.0.7` 当前无暴露面。精确钉版比 `>=` 范围更可控（避免 pnpm 把范围 value 解析到最新主版本导致跨主版本漂移）。代价是失去未来防护：若将来引入 3.x/4.x brace-expansion，需重新评估并加桶。
- `postcss` / `nanoid` 是单一主版本，直接锁修补版。
- **esbuild 不 override**：vite 要求 `^0.27.0`，而修补版是 `0.28.1`，强升会破坏 semver 兼容、可能击穿 vite 构建。保留 2 项 Low，在方案与 CHANGELOG 中说明理由。
- **installer/update 脚本的同类 npm warning 不在本次范围**：`scripts/install.sh`、`scripts/update.sh`、root `smoke:claude-provider` 仍用 `npm exec --yes -- pnpm`，会向真实用户发同类告警。本次只清理 CI（§16.3 范围）；改 installer 会触发 AGENTS.md 强制干净环境 smoketest，留独立 PR。CHANGELOG 记一句避免误认已全量清理。

**验收**：
- `pnpm install` 后 `pnpm audit` 的 High/Moderate 降为 0（仅剩 2 项 esbuild Low）。
- `pnpm -r build` / `pnpm test` / `pnpm --filter @tekon/web build` 全部通过（证明 override 未击穿 vite/vitest）。
- `pnpm-lock.yaml` 同步更新。

## 2. 不做的事（维持冻结）

- 不新增 Profile / Automation job / Driver wrapper / 展示事件 / Workflow 语法。
- 不重构 `sse.ts`（报告第 10.3 节：语义刚稳定，先冻结状态机测试，后续独立 PR 再提取通用 backpressure writer）。
- 不动 P0/P1 架构项。
- 不 merge / release / deploy。

## 3. 执行顺序

1. 1.1 重命名 + 选择器对齐（纯文件移动 + 一行脚本改动）。
2. 1.3 overrides + lockfile 更新（先跑 install 验证不击穿构建）。
3. 1.2 CI workflow 替换。
4. 全量 `pnpm test` + `pnpm -r build` + web build 本地验证。
5. 委派 reviewer 循环评审方案与实现，直到达成一致。
6. 全功能 e2e + UI 验证。
7. 提交到 PR #11，清理临时产物。

## 4. 文档同步

- `CHANGELOG.md`：新增 `v0.20.3`（PATCH：测试 lane 对齐、CI warning 清理、devDeps 安全 override）。
- `package.json` version：`0.20.2` → `0.20.3`。
- `AGENTS.md`：第 38 行 e2e 规则只约束目录不约束命名，补一句「文件须命名为 `*.e2e.test.ts` 以进入 e2e lane」，防止后续新增 e2e 掉回 unit lane。
- `docs/manual/tekon-user-manual.md` / `.html`：检查是否提及 e2e lane 或 CI 命令，若无需改则在提交说明中简述。
- `docs/reviews/current.md`：**必须**同步——版本号 `0.20.2` → `0.20.3`，并更新绑定的 reviewer/整改快照 commit hash 与 CI 状态（本次 bump 触发条件已确定，不用「若…则」措辞）。
