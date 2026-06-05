# Donkey V2 Phase 3 Final Review

日期：2026-06-05
范围：Phase 3 Task 16-21 最终代码、测试、Web、文档和验收报告
Reviewer：Turing，最高思考等级 subagent

## 初审结论

`CHANGES_REQUESTED`

## 必须修复项

1. `packages/web/src/server/api/root.ts` 中 `project.pause`、`project.resume`、`project.cancel` 只校验 session token，没有校验 run 是否属于当前 explicit project root。若同一 SQLite 内存在其他 project 的 run，持有 token 的请求可以越界修改状态。
2. `packages/web/src/server/api/root.ts` 中 `project.clean` 同样只校验 token，没有校验 run scope。虽然删除路径位于当前 `.donkey/runs/<runId>`，但仍属于写操作，应绑定 project scope。

## 建议修复项

1. `donkey init` 原先不生成 `.donkey/web-session.json`，而 Web 写操作依赖该 token。真实用户首次使用 Web human approval 缺少明确生成路径。

## 修复摘要

- `project.pause/resume/cancel/clean` 写入前统一调用 `assertRunInScope(db, context, runId)`。
- 新增 Web API 回归测试，覆盖越界 `run_escaped` 对 pause/resume/cancel/clean 的拒绝。
- `donkey init` 生成 `.donkey/web-session.json`，token 为 32 bytes hex。
- CLI unit/e2e 测试补充 session token 文件存在和格式断言。
- README、V2 manual、final acceptance 同步说明 session token 由 `init` 生成且不应提交。

## 复查结论

`APPROVED`

复查确认：前次两个 MUST-FIX 已修复，越界 run 拒绝测试已覆盖，`init` 生成 session token，文档同步完成。Reviewer 复跑通过：

- `@donkey/web` `write-auth.test.ts`：2 tests passed
- `@donkey/cli` `run-cli.test.ts`：1 test passed
- `git diff --check`
- 高置信敏感 token 模式扫描

## 当前剩余边界

- 未创建真实 GitHub PR；PR 创建按用户要求放到最后。
- 自动 merge、生产级真实 LLM workflow 和远程多租户 Web 服务不在本次通过范围内。
