# Tekon MVP 用户手册

生成日期：2026-06-05
适用分支：`rebuild-v2`
适用范围：阶段二本地 mock CLI 验证后的仓库状态

## 1. 当前定位

Tekon 当前可以通过本地 CLI 发起 mock workflow、查看状态、处理人工 gate、查看日志和清理 worktree。它仍不是完整生产产品：Web dashboard、真实 PR 创建、自动 merge、真实 LLM 生产执行和远端发布流程还未完成。

当前可用能力面向研发和评审人员：

- 使用 `tekon init` 初始化本地项目状态。
- 使用 `tekon run --template standard-feature --agent mock` 跑通标准模板并生成本地 delivery package。
- 使用 `tekon run --dynamic --dry-run --agent mock` 查看动态 workflow 预览和约束注入结果。
- 使用 `status`、`pause`、`resume --approve-human`、`cancel`、`log`、`clean` 管理持久化运行状态。
- 使用 `role`、`workflow`、`constraints` 查看和创建本地配置。

## 2. 用户怎么发起

在仓库根目录先构建 CLI：

```bash
npm exec --yes -- pnpm@10.12.1 build
```

在目标 Git 仓库中初始化 Tekon：

```bash
node /path/to/tekon/packages/cli/dist/index.js init --repo /path/to/project
```

运行标准模板：

```bash
node /path/to/tekon/packages/cli/dist/index.js run "给示例模块加批量重试" --template standard-feature --agent mock --repo /path/to/project
```

查看动态 workflow dry-run：

```bash
node /path/to/tekon/packages/cli/dist/index.js run --dynamic --dry-run "给支付模块加退款功能，属于高风险数据变更" --agent mock --repo /path/to/project
```

## 3. 用户会得到什么

模板运行会在 `.tekon/` 下写入 SQLite 状态、run artifacts、gate 结果和 audit events。`standard-feature` mock 路径会到 `passed`，`bugfix` 模板会在 reviewer human gate 处暂停，等待 `resume --approve-human`。

dynamic dry-run 不创建 worktree，也不执行代码改动；它返回 workflow preview 和 constraint mutation 摘要，例如 high-risk human gate 或 rollback-plan 注入。

## 4. 如何判断结果

- `run` 输出 `status=passed` 表示本地 mock 模板跑完。
- `run` 输出 `status=paused humanGate=pending` 表示等待人工 gate。
- `status` 会显示当前 run、current node、gate 数量、artifact 数量和 pending human decisions。
- `log` 会显示 audit event，包括 `run.started`、`human.gate.pending`、`human.gate.approved`。
- 本地验收以 `npm exec --yes -- pnpm@10.12.1 test -- --run`、`build`、`typecheck` 和 `prettier --check .` 通过为准。

## 5. 当前不能做什么

- 不能通过 Web 查看项目、产物、Gate 或审计。
- 不能自动创建、推送、合入 PR。
- 不能替代人类完成上线审批或高风险动作。
- 不能承诺真实 LLM provider 在生产工作流中稳定执行。
- 不能把 `CommandPolicy.network` 理解为 OS 级网络隔离。
- 不能作为普通用户安装后直接使用的完整产品。

## 6. 配置与工具链说明

根 `test` 脚本保持为 `vitest`。Vitest 已迁移到根 `vitest.config.ts` 的 `test.projects`，不再使用旧 workspace 配置文件。

当前代码包包括 `packages/core` 和 `packages/cli`。Web、交付和产品化入口需要在 Phase 3 单独实现、测试和审阅。
