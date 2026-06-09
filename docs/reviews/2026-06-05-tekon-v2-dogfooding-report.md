# Tekon V2 Dogfooding Report

日期：2026-06-05
范围：Phase 3 Task 19，Tekon-on-Tekon 本地自举验收
结论：通过 `scm-dry-run` 级别 dogfooding；真实远端 PR 未创建，保持人工批准边界。

## 1. Evidence Summary

| 字段             | 结果                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| evidenceLevel    | `scm-dry-run`                                                                               |
| fixture repo     | `/tmp/tekon-dogfood-9s5Nno`                                                                 |
| dynamic dry-run  | `dryRun=true phases=4 mutations=conditional-high-risk-human-gate,conditional-rollback-plan` |
| delivery runId   | `run_7a795092-5927-4560-851b-77e102671f86`                                                  |
| human gate runId | `run_40091657-33de-4b53-b745-ea622a1004e0`                                                  |
| SCM dry-run      | `prDryRun=true requiresHumanApproval=true`                                                  |
| Web 状态         | `passed`，Playwright dashboard e2e 通过，含移动和桌面截图输出到 test-results                |
| coverage 状态    | `passed`，Vitest-covered source 总行覆盖率 90.97%                                           |
| PR URL           | `not_created`                                                                               |

## 2. Commands

```bash
mktemp -d /tmp/tekon-dogfood-XXXXXX
git init
npm init -y
npm pkg set scripts.build="node -e \"process.exit(0)\""
npm pkg set scripts.lint="node -e \"process.exit(0)\""
npm pkg set scripts.test="node -e \"process.exit(0)\""
git add package.json
git commit -m init
node packages/cli/dist/index.js init --repo /tmp/tekon-dogfood-9s5Nno
npm exec --yes -- pnpm@10.12.1 exec node packages/cli/dist/index.js run --dynamic --dry-run "整理 Tekon V2 Phase 3 验收材料，高风险数据变更" --agent mock --repo /tmp/tekon-dogfood-9s5Nno
npm exec --yes -- pnpm@10.12.1 exec node packages/cli/dist/index.js run "整理 Tekon V2 Phase 3 验收材料" --template standard-feature --agent mock --repo /tmp/tekon-dogfood-9s5Nno
npm exec --yes -- pnpm@10.12.1 exec node packages/cli/dist/index.js delivery dry-run --run-id run_7a795092-5927-4560-851b-77e102671f86 --repo /tmp/tekon-dogfood-9s5Nno
npm exec --yes -- pnpm@10.12.1 exec node packages/cli/dist/index.js run "修复 Tekon V2 Phase 3 验收材料中的人工确认路径" --template bugfix --agent mock --repo /tmp/tekon-dogfood-9s5Nno
npm exec --yes -- pnpm@10.12.1 exec node packages/cli/dist/index.js resume --run-id run_40091657-33de-4b53-b745-ea622a1004e0 --approve-human --repo /tmp/tekon-dogfood-9s5Nno
```

直接用 `node packages/cli/dist/index.js run ...` 启动过一次 standard-feature，结果为 `status=blocked`，原因是 gate 子进程找不到 `pnpm`：`spawn pnpm ENOENT`。使用 `npm exec --yes -- pnpm@10.12.1 exec node ...` 后同一 fixture 成功通过。这是有效的环境前提，不是 workflow 逻辑失败。

## 3. Delivery Metrics

`run_7a795092-5927-4560-851b-77e102671f86`：

| 指标                 | 结果                                                               |
| -------------------- | ------------------------------------------------------------------ |
| workflowStatus       | `passed`                                                           |
| timeToLocalPackageMs | `648`                                                              |
| timeToPrMs           | `null`                                                             |
| gatePassRate         | `1`                                                                |
| retryCount           | `0`                                                                |
| automationRatio      | `1`                                                                |
| humanInterventions   | `total=0 pending=0 approved=0 rejected=0`                          |
| highRiskActionCount  | `0`                                                                |
| artifactIntegrity    | `45/45 sha256 matched`                                             |
| audit.valid          | `true`                                                             |
| audit.eventCount     | `22`                                                               |
| audit.headHash       | `3632d2845cf5ae4bed32b4b5a389c6fb43124de595556a80da7e670d91eb88dd` |

`run_40091657-33de-4b53-b745-ea622a1004e0` human gate 摘要：

| 指标                | 结果                                                          |
| ------------------- | ------------------------------------------------------------- |
| workflowStatus      | `passed`                                                      |
| gatePassRate        | `0.8571428571428571`                                          |
| humanInterventions  | `total=1 pending=0 approved=1 rejected=0 averageWaitMs=11640` |
| highRiskActionCount | `2`                                                           |
| audit.valid         | `true`                                                        |
| audit.eventCount    | `19`                                                          |

## 4. SCM Dry-run

命令输出：

```text
runId=run_7a795092-5927-4560-851b-77e102671f86 workflowStatus=passed artifacts=45 prDryRun=true requiresHumanApproval=true
```

判断：dry-run 证明 delivery evidence、命令规划和人工批准边界可用；它不证明远端分支已 push，也不证明 GitHub PR 已创建。真实 PR 创建仍需 `gh auth status`、远端权限和人工批准。

## 5. Coverage

真实 coverage 命令：

```bash
npm exec --yes -- pnpm@10.12.1 exec vitest --exclude "**/__manual__/**" --run --coverage
```

结果：46 个 test files、133 个 tests 通过。Vitest-covered source 行覆盖率：

| 范围                             | 行覆盖率 |
| -------------------------------- | -------- |
| All files                        | 90.97%   |
| `packages/core/src`              | 91.17%   |
| `packages/cli/src`               | 90.92%   |
| `packages/web/src/server` 与 API | 87.11%   |

说明：Web 浏览器 UI 由 Playwright e2e 覆盖，未计入 Vitest v8 source coverage；coverage 配置排除了构建产物、配置文件和浏览器端 React bundle。

## 6. Web Dashboard

验证命令：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test:e2e
```

结果：2 个 Chromium e2e 通过。覆盖点：

- dashboard 展示 `概览`、`待人工审批`、`产物`、`Gates`、`审计`、`角色`、`工作流`、`设置`。
- 错误 token 被拒绝，正确 `.tekon/web-session.json` token 可批准 pending human gate。
- release dashboard e2e 生成移动和桌面截图到 Playwright `test-results` 输出目录。

## 7. 已知限制

- 本轮未创建真实远端 PR，PR URL 记录为 `not_created`。
- Web 是本地 dashboard，不是远程多租户服务。
- 真实 LLM workflow、远端 SCM 权限和生产发布仍需单独受控验证。
- 启动 CLI 的环境必须能在 gate 子进程中找到 `pnpm`。
