# 天工（Tekon）品牌迁移与用户手册审阅记录

日期：2026-06-09

审阅范围：

- 品牌迁移：CLI、包名、运行态目录、环境变量前缀、交付分支前缀、文档路径、测试断言和隐藏配置。
- 主用户使用手册：`docs/manual/tekon-user-manual.md`。
- 同步文档：`README.md`、`CHANGELOG.md`、`AGENTS.md`。
- 提交前验证：构建、类型检查、测试、格式、Action lint、空白字符和品牌残留扫描。

## 1. Reviewer 结论

本轮使用两个 subagent 做最终审阅。当前 runtime 没有独立“最高思考等级”开关可设置；两个 reviewer 均按最高可用审阅强度执行。

第一轮 reviewer 发现 4 个必须修复项：

- 隐藏 CI 配置仍引用旧包作用域，存在 CI 假绿风险。
- `.gitignore` 仍忽略旧运行态目录，新的 `.tekon/` 运行产物治理不完整。
- 主用户手册的 `delivery ci-watch` 参数表被管道符拆坏。
- 大量文档路径重命名尚未进入 Git index，提交前必须 stage。

第二轮 reviewer 复查结论：

- 前 3 个内容问题已修复。
- 未发现受控源码、隐藏配置、文档、测试中的旧品牌内容残留。
- 主用户使用手册覆盖 overview、Quick Start、核心场景、命令详解、参数、问题处理、可信度判断、边界说明，并已写入“每次迭代后评估是否更新手册”的规则。
- README、CHANGELOG、AGENTS 已同步主手册路径、Tekon 命名和后续迭代手册更新要求。
- 唯一剩余动作是提交前将重命名纳入 Git index。

最终结论：未发现必须修复项。

## 2. 修复摘要

- `.github/workflows/core.yml`：CI filter 改为 `@tekon/core`，避免 core build/test/e2e 未实际命中 workspace 项目。
- `.gitignore`：运行态忽略规则改为 `.tekon/runs/`、`.tekon/worktrees/`、`.tekon/web-session.json`。
- `docs/manual/tekon-user-manual.md`：修复 `delivery ci-watch` 参数表，补充 Tekon 命名来源，以及审批相关参数说明。
- `README.md`：标题和文档入口同步为天工（Tekon），新增主用户使用手册入口。
- `CHANGELOG.md`：记录品牌迁移和主用户使用手册。
- `AGENTS.md`：把主用户使用手册纳入后续迭代必须评估是否更新的交付检查。
- 全仓源码、测试、角色、历史文档路径和 HTML 审阅版同步迁移到 Tekon 命名。

## 3. 验证摘要

已通过的本地验证：

| 验证项               | 命令                                                       | 结果                        |
| -------------------- | ---------------------------------------------------------- | --------------------------- |
| 依赖锁定安装         | `npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile` | 退出 0                      |
| 类型检查             | `npm exec --yes -- pnpm@10.12.1 typecheck`                 | 退出 0                      |
| 构建                 | `npm exec --yes -- pnpm@10.12.1 build`                     | 退出 0                      |
| 全仓测试             | `npm exec --yes -- pnpm@10.12.1 test -- --run`             | 57 files / 205 tests passed |
| 格式检查             | `npm exec --yes -- pnpm@10.12.1 format:check`              | 退出 0                      |
| Action lint          | `npm run lint:actions`                                     | 退出 0                      |
| diff 空白检查        | `git diff --check`                                         | 退出 0                      |
| 受控内容品牌残留扫描 | 隐藏文件扫描，排除 `.git`、依赖、构建和测试产物目录        | 无命中                      |
| 文件名品牌残留扫描   | 文件名扫描，排除 `.git`、依赖、构建和测试产物目录          | 无命中                      |
| staged rename 复核   | `git diff --cached --name-status --find-renames`           | 重命名已进入 index          |

说明：

- 测试运行过程中产生的 `packages/web/test-results/` 截图属于测试产物，未进入待提交列表。
- 当前仓库路径仍是本机工作区目录名，不属于本次 Git 迁移范围。

## 4. 手册更新规则确认

本次迭代已新增主用户使用手册：

```text
docs/manual/tekon-user-manual.md
```

后续每次功能、行为、CLI/Web 入口、参数、错误处理、边界或用户流程发生变化后，都必须评估是否需要更新该手册。若判断不需要更新，应在最终回复或提交说明中说明理由。
