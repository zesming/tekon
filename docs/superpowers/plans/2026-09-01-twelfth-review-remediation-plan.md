# 第十二轮复审批注整改执行方案

- **日期**：2026-09-01
- **依据**：`docs/reviews/2026-08-31-tekon-product-runtime-harness-twelfth-review.md` 第 13、14、17 节
- **基线**：分支 `review/human-first-harness-2026-08-28`，HEAD `cf2ccf1`，版本 `0.20.3`
- **范围原则**：仅收敛报告第 17.2 节四项低风险项；P0/P1 架构主线维持冻结，分独立 PR 推进。

## 1. 整改项与验收标准

### 1.1 DSH tested pin 升级 alpha.2 → alpha.3

**问题**：DSH 已发布 `0.1.2-alpha.3`（master 推进 117 提交），Tekon 仍钉死 alpha.2。

**事实**（Zeno 逐项核对）：alpha.3 的 Node engines、headless help anchor、5 个 required plugin ids、reasoning streaming、exit code 语义与 alpha.2 完全一致；headless 执行器代码 0 修改；alpha.3 移除 SQLite 持久化后端（确立 JSONL 为唯一 provider），与 Tekon 绑定的 `session-persistence-jsonl` 方向一致。

**改动**：
1. `packages/core/src/runtime/dsh-bridge-probe.ts`：`TESTED_DSH_VERSION = '0.1.2-alpha.3'`
2. `packages/core/__tests__/fixtures/dsh/version.txt`：`0.1.2-alpha.3`
3. `packages/core/__tests__/fixtures/dsh/headless-dump-default-config.txt`：头部注释 commit hash → `dd6322d6`，版本 → `0.1.2-alpha.3`
4. `packages/core/__tests__/runtime/dsh-bridge-contract.test.ts`：注释 commit hash → `dd6322d6`
5. `docs/manual/tekon-user-manual.md` + `.html`：tested pin → `0.1.2-alpha.3`
6. `docs/reviews/current.md`：DSH tested pin → `0.1.2-alpha.3`

**验收**：
- `pnpm test` 全量通过（含 dsh-bridge-contract、provider-preflight unit/e2e）
- `pnpm --filter @tekon/cli test:e2e` 通过
- 手册 MD/HTML 版本号一致

### 1.2 P1-RELEASE-01 版本身份统一（lockstep）

**问题**：根版本 `0.20.3`，内部 package（core/cli/web）仍 `0.7.0`，导致 `TEKON_CORE_VERSION` 与 CLI `getVersion()` 输出不一致。

**改动**：`packages/core/package.json`、`packages/cli/package.json`、`packages/web/package.json` 的 `version` 统一改为 `0.20.3`。

**验收**：
- `pnpm test` 通过
- `pnpm --filter @tekon/cli test:unit` 通过（CLI --version 测试）
- lockfile 无需更新（workspace 依赖用 `workspace:*`，不绑定版本）
- 补真断言：在 `packages/core/__tests__/smoke.test.ts` 增加 `expect(pkg.version).toBe(rootPkg.version)` 断言，防止版本身份再次漂移（现有 `TEKON_CORE_VERSION === pkg.version` 是同源恒真断言，无验证力）

### 1.3 P2-CI-03 fixture npm warning 清理

**问题**：6 个 CLI 测试文件用 `execFileSync('npm', ['init', '-y'])` + `npm pkg set` 生成 fixture，继承 pnpm 注入的 `npm_config_*` 打印弃用警告。

**方案 B（推荐）**：用 `writeFileSync` 直接写 `package.json`，完全替代 `npm init`/`npm pkg set`。

**改动**（6 文件 19 处）：
1. `packages/cli/__tests__/approval-terminal.test.ts:207-210`
2. `packages/cli/__tests__/run-mode-policy.test.ts:116`
3. `packages/cli/__tests__/run-snapshot.test.ts:175-187`
4. `packages/cli/__tests__/run-cli.test.ts:1640-1652`
5. `packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:412-428`
6. `packages/cli/__tests__/e2e/release-flow.e2e.test.ts:341-353`

每处把 `npm init -y` + `npm pkg set scripts.X=...` 替换为：
```ts
writeFileSync(
  join(repoPath, 'package.json'),
  JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { ... } }, null, 2) + '\n',
);
```
**注意**：`run-mode-policy.test.ts` 是唯一只调 `npm init -y` 不调 `npm pkg set` 的 fixture，它依赖 `npm init -y` 隐式生成的 `scripts.test`。替换时必须保留一个 `test` script（如 `"test": "echo \"Error: no test specified\" && exit 1"`），否则 `detectRepoProfile` 的 `commands.test` 检测会静默漂移。

**验收**：
- `pnpm --filter @tekon/cli test:unit` 通过
- `pnpm --filter @tekon/cli test:e2e` 通过
- 6 个 fixture 构造点不再 spawn `npm` 子进程（用 `rg "execFileSync.*'npm'"` 确认 0 匹配）
- CI 日志中 `npm warn Unknown env config` 计数从当前值降到 0（需先在当前 CI run 中取证基线）

### 1.4 P2-DEPS-01 供应链 gate

**问题**：override 进入 lockfile 但无强制 audit gate。

**改动**：`.github/workflows/ci.yml` 的 `typecheck` job 在 `Install dependencies` 后加一步：
```yaml
      - name: Audit production dependencies
        run: pnpm audit --prod
```

**验收**：
- CI `typecheck` job 通过（当前 `pnpm audit --prod` 退出码 0）
- 未来新增不安全生产依赖时 CI 自动拦截
- **边界**：`--prod` 只覆盖 50 个生产依赖包，不覆盖构建链（vite/tsx/esbuild 等 232 个 dev 包）。gate 加在 `typecheck` job（其余 job `needs: typecheck`），audit 失败会连锁阻断整条 CI。在 CHANGELOG 中如实标注此边界，不外推为「供应链治理已闭环」

## 2. 不做的事（维持冻结）

- 不动 P0/P1 架构项
- 不改 `scripts/install.sh`/`update.sh`（需干净环境 smoketest，留独立 PR）
- 不改 `packages/cli/src/commands/ui.ts` 的 `npm exec`（生产代码改动需独立评估）
- 不改根 `package.json` 的 `smoke:claude-provider` 脚本（仍用 `npm exec`，不在 CI 路径上，留独立 PR）
- 不设置 GitHub branch protection（需用户在 GitHub 设置中操作）

## 3. 执行顺序

1. 1.1 DSH pin 升级（最小改动，先验证测试）
2. 1.2 版本身份统一（一行 × 3 文件）
3. 1.3 fixture warning 清理（6 文件，机械替换）
4. 1.4 CI audit gate（一行 YAML）
5. 全量 `pnpm test` + `pnpm -r build` + web Playwright e2e
6. 委派 reviewer 循环评审
7. 提交到 PR #11

## 4. 文档同步

- `CHANGELOG.md`：新增 `v0.20.4`（PATCH：DSH pin 升级、版本身份统一、fixture warning 清理、CI audit gate）
- `package.json` version：`0.20.3` → `0.20.4`
- `docs/reviews/current.md`：版本号、DSH pin、整改状态同步
- `AGENTS.md`：无需更新（e2e 命名规则已在上轮补充）
