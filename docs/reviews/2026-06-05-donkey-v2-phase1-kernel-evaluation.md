# Donkey V2 阶段一安全可恢复内核评估报告

生成日期：2026-06-05
实现分支：`phase1-kernel`；当前已合入：`rebuild-v2`
范围：`packages/core` 阶段一安全可恢复内核、TDD 证据、E2E 验收、已知风险。

## 1. 结论

阶段一核心能力已完成本地实现并通过验证：monorepo/test harness、领域类型与运行时配置、SQLite/WAL 持久化与恢复、Artifact Store、Audit hash chain、CommandGateway、WorktreeManager、AgentAdapter/Mock/Claude runner、GateEngine/HumanGate，以及阶段一出口 E2E。

最高思考等级 reviewer 初审检出 3 个阻断项：schema gate 只检查存在性、Artifact/Worktree ID 路径穿越风险、CommandGateway 危险命令拒绝过窄。已在 `90855a9` 修复，并新增对应 RED/GREEN 回归测试；复查 reviewer 返回 `APPROVED`，未检出必须修复项。

## 2. 提交清单

| Commit | 内容 |
|---|---|
| `9355487` | `feat(core): scaffold monorepo and test harness` |
| `7fa23cd` | `feat(core): define domain types and runtime config schemas` |
| `5d1dcdd` | `feat(core): add durable sqlite persistence and recovery queue` |
| `5fc5695` | `feat(core): add artifact store and append-only audit log` |
| `9b53423` | `feat(core): add command gateway with argv policy enforcement` |
| `b0be361` | `feat(core): add git worktree isolation manager` |
| `4669c76` | `feat(core): add agent adapter contract and claude runner` |
| `41b1286` | `feat(core): add deterministic gate engine and human approvals` |
| `584589a` | `test(core): add phase 1 kernel e2e coverage` |
| `8f49918` | `fix(core): pass stdin prompts through command gateway` |
| `90855a9` | `fix(core): harden phase 1 gate and path safety` |

## 3. TDD 证据

| 任务 | RED 证据 | GREEN 证据 |
|---|---|---|
| Task 1 Monorepo | `smoke.test.ts` 引用缺失的 `../src/index.js`，失败为 `Cannot find module '../src/index.js'` | `DONKEY_CORE_VERSION` 实现后，`@donkey/core` smoke test 通过；build/typecheck 通过 |
| Task 2 Types/Config | domain/config 测试调用未导出的 schema，失败为 `Cannot read properties of undefined (reading 'parse')` | domain/config schema 实现后，5 个测试通过；typecheck/build 通过 |
| Task 3 SQLite | DB 测试调用未实现的 `openDonkeyDatabase`/`createWriteQueue`，失败为 `is not a function` | migrations/repositories/recovery/write queue 测试通过；typecheck/build 通过 |
| Task 4 Artifact/Audit | artifact/audit 测试调用未实现的 `createArtifactStore`/`createAuditLogger`，失败为 `is not a function` | artifact versioning、schema、truncation、missing file、audit tamper detection 测试通过 |
| Task 5 CommandGateway | gateway/gate runner 测试调用未实现的 `createCommandGateway`，失败为 `is not a function` | dangerous command、cwd scope、human approval boundary、stdout/stderr streaming、gate runner 测试通过 |
| Task 6 WorktreeManager | worktree 测试调用未实现的 `createWorktreeManager`，失败为 `is not a function` | dirty base、真实 git worktree lease/release/prune E2E 通过 |
| Task 7 AgentAdapter | adapter 测试调用未实现的 `assertAgentProviderCapabilities`/`createMockAgentAdapter`/`createClaudeCodeAdapter`，失败为 `is not a function` | provider capability check、mock artifacts、Claude command builder、large stdout/stderr、timeout 测试通过 |
| Task 8 GateEngine/HumanGate | gate 测试调用未实现的 `createGateEngine`/`createHumanGate`，失败为 `is not a function` | command/schema/human gate、GateResult persistence、autoFix repair node 测试通过 |
| stdin 修复 | `promptMode: stdin` 测试失败，实际结果 `timedOut: true`、`exitCode: null` | CommandGateway 写入 stdin 后，Claude stdin 测试通过 |
| E2E 脚本 | 初始 `test:e2e` glob 未匹配文件，失败为 `No test files found` | 显式 e2e 文件列表后，2 个 e2e 测试通过 |
| Reviewer 阻断项修复 | 新增回归测试确认无效 artifact 仍通过 schema gate、`../escape` ID 可写出受管目录、空 allow list/`rm -r -f`/`git push --force-with-lease` 未被稳定拒绝 | schema gate 读取并校验 artifact 内容；Artifact/Worktree 路径段只允许 `[a-zA-Z0-9_-]`；CommandGateway 默认拒绝空 allow list、递归强制删除和 force push 变体；20 个测试文件、35 个测试通过 |

## 4. E2E 覆盖

阶段一新增 E2E 覆盖：

- `packages/core/__tests__/runtime/worktree-manager.e2e.test.ts`
  - 创建真实临时 git repo。
  - lease 两个独立 worktree。
  - 验证分支、路径和文件隔离。
  - release 后确认 worktree 已清理，并执行 `git worktree prune`。
- `packages/core/__tests__/phase1/kernel.e2e.test.ts`
  - 创建 run、project、demand、node。
  - 创建 worktree lease。
  - 执行 mock Agent。
  - 写入 9 类内置 artifact。
  - 执行 schema gate，校验 artifact 内容并持久化 GateResult。
  - 写入并验证 audit hash chain。
  - 验证 `rm -rf` 在 spawn 前被拒绝。
  - 验证 human gate pause/resume。
  - 验证缺少 sandbox/approval/permission mapping 的真实 Agent 配置被拒绝。
  - release/prune worktree 并确认清理完成。

## 5. 验证命令

最后一次阶段一验证结果：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test -- --run
# 20 test files passed, 31 tests passed
# 修复 reviewer 阻断项后：20 test files passed, 35 tests passed

npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
# tsc -p tsconfig.json passed

npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e -- --run
# 2 test files passed, 2 tests passed
```

## 6. 风险与后续建议

- `better-sqlite3` 是原生依赖。当前环境中 pnpm 安装后未自动生成 binding，需要执行过一次定向 `better-sqlite3` build。后续 CI 应显式允许或缓存该原生构建。
- Claude adapter 的真实 Claude CLI 调用未在阶段一执行；当前测试覆盖的是命令构造、权限能力检查、输出流、timeout 和 stdin。真实 provider smoke 建议放到阶段二或独立人工凭证环境。
- Worktree dirty 检测会忽略 Donkey 自己生成的 `.donkey/` 未跟踪目录，避免第二个 lease 被自身运行产物阻塞；用户工作区的已跟踪改动仍会阻断。
- Artifact Store 和 WorktreeManager 现在拒绝包含路径分隔符或其他非安全字符的 run/node/role 路径段；如果后续业务需要更宽松的 ID，需要先定义独立的 ID 到路径映射层，不能直接拼路径。
- 当前 core API 是阶段一内核 API，尚未提供 CLI/Web 产品入口；因此本阶段未更新用户手册。

## 7. Subagent 执行情况

本阶段按用户要求尝试使用 subagent：

- Task 1 worker 曾因模型名错误中断。
- 重新委派 worker 后未能在共享 worktree 留下有效 TDD 产物，主线程按 TDD 接手完成。
- Task 1 的两个 reviewer subagent 均因 `429 Too Many Requests` 中断。
- 阶段一最终 reviewer 成功返回 `CHANGES_REQUIRED`，3 个阻断项已在 `90855a9` 修复。
- 修复后重新委派最高思考等级 reviewer 复查，结论为 `APPROVED`；仅保留一项建议：`CommandPolicy.network` 目前是策略字段，不是 OS 级网络隔离。

合入 `rebuild-v2` 后，主工作区重新执行本地 build、unit、e2e 和文档占位符检查；结果记录见最终交付说明。
