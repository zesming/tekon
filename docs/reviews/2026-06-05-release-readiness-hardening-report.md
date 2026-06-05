# Donkey V2 发布就绪加固报告

生成日期：2026-06-05  
分支：`rebuild-v2`  
代码完成提交 SHA：`0d7d14c5f2b34687b27720d1c4f9793123ce30f8`  
代码完成提交远端 Core workflow：`completed/success`  
代码完成提交 workflow URL：`https://github.com/zesming/donkey/actions/runs/27010294512`  
报告提交 SHA：提交后由最终交付说明记录，不回写本文件。  
报告提交远端 Core workflow：提交后由最终交付说明记录，不回写本文件。

## 1. 结论

代码完成提交已通过本地 gate、真实 Claude provider smoke 和远端 Core workflow。PR 创建仍保留为最后动作；本报告提交后的远端 Core workflow 仍需在最终交付说明中确认。

## 2. 本地验证摘要

| 验证项              | 命令                                                             | 结果                        |
| ------------------- | ---------------------------------------------------------------- | --------------------------- |
| 依赖锁定安装        | `npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile`       | 退出 0，lockfile up to date |
| native build gate   | `npm exec --yes -- pnpm@10.12.1 ignored-builds`                  | 退出 0，`None`              |
| 根测试              | `npm exec --yes -- pnpm@10.12.1 test -- --run`                   | 23 files / 89 tests passed  |
| core unit           | `npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit` | 21 files / 87 tests passed  |
| core e2e            | `npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e`  | 2 files / 2 tests passed    |
| build               | `npm exec --yes -- pnpm@10.12.1 build`                           | 退出 0                      |
| typecheck           | `npm exec --yes -- pnpm@10.12.1 typecheck`                       | 退出 0                      |
| GitHub Actions lint | `npm exec --yes -- pnpm@10.12.1 lint:actions`                    | 退出 0                      |
| format gate         | `npm exec --yes -- pnpm@10.12.1 exec prettier --check .`         | 退出 0                      |
| diff whitespace     | `git diff --check`                                               | 退出 0                      |
| 未完成标记扫描      | targeted `rg` scan                                               | 无输出                      |
| 敏感模式扫描        | targeted `rg` scan                                               | 无输出                      |

## 3. 远端 CI 证据：代码完成提交

- workflow: Core
- commit: `0d7d14c5f2b34687b27720d1c4f9793123ce30f8`
- status: `completed/success`
- url: `https://github.com/zesming/donkey/actions/runs/27010294512`

## 4. Claude Provider Smoke 证据

- Claude CLI version: `2.1.163 (Claude Code)`
- command: `npm run smoke:claude-provider`
- enablement: 已显式设置 smoke 开关和命令覆盖，环境变量具体值不记录。
- exit code: 0
- durationMs: 14275
- stdout log path: `/var/folders/p8/xn4n9zv14n13nrq3zyzf9wpm0000gn/T/donkey-claude-smoke-80Niqx/.donkey/smoke/1780656076183-b476d5ed-23c5-4a32-b1ca-d6e42a5623a2.stdout.log`
- stderr log path: `/var/folders/p8/xn4n9zv14n13nrq3zyzf9wpm0000gn/T/donkey-claude-smoke-80Niqx/.donkey/smoke/1780656076183-b476d5ed-23c5-4a32-b1ca-d6e42a5623a2.stderr.log`
- 脱敏说明：未记录 API key、token、认证输出或环境变量值。

## 5. 已完成加固项

- CI：GitHub Actions 增加 actionlint job、Node 24、native dependency build gate、远端 Actions 查询脚本。
- 测试与构建：Vitest 迁移到 `test.projects`，默认测试排除手动 smoke，全仓 Prettier baseline 已建立。
- CommandGateway：stdin、child error、log write、timeout 和环境变量边界已加固。
- Claude provider：真实 smoke fail-closed，手动执行成功，证据报告已脱敏。
- Network policy：阶段一完成静态网络命令拒绝和 provider network evidence mapping，不声称 OS 级断网。
- 文档：README、CHANGELOG、MVP 用户边界手册、Claude smoke 手册和阶段一评估已同步更新。

## 6. 已知边界

- PR 创建仍放在最后，不在本报告提交前执行。
- OS/container 级网络隔离仍是后续增强项；当前阶段只完成静态拒绝和 provider 声明映射。
- 当前没有面向普通用户的 CLI/Web 产品入口，主要可执行对象仍是 `packages/core` 的测试、类型检查和构建。

## 7. Subagent Review

最终最高思考 reviewer 结论：`CHANGES_REQUIRED`，必须修复项 1 个。

- 问题：本报告第 7 节仍保留“最终 reviewer 将在本报告生成后执行”的未更新口径，与提交前最终报告状态冲突。
- 修复摘要：已将最终 reviewer 结论、必须修复项和修复摘要写入本节，并同步更新 HTML 审阅版和 CHANGELOG。
- 复查结果：最终 reviewer 复查结论为 `APPROVED`；未检出剩余必须修复项。

## 8. 报告提交后的远端 CI

报告提交 SHA 和最终远端 Core workflow URL 在最终交付说明记录；不回写本文件，避免为了记录最终 workflow URL 产生新的提交循环。
