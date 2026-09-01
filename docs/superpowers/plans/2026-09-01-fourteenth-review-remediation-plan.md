# 第十四轮复审整改执行方案（2026-09-01）

> 依据：第十三轮复审报告（`docs/reviews/2026-09-01-tekon-product-runtime-harness-thirteenth-review.md`）第 17 节（主 Agent 第二轮四路交叉评估批注）。
> 范围：本 PR（`review/human-first-harness-2026-08-28` → `main`，PR #11）内可安全落地的调整；架构冻结项（第 17.4 节）不在本方案范围。

## 1. 已完成项

| 项               | 落地内容                                                                          | 证据                   |
| ---------------- | --------------------------------------------------------------------------------- | ---------------------- |
| P2-DOC-02 清理   | CHANGELOG "零差异"→"兼容锚点未变"；`needs: [typecheck, audit]`→`needs: typecheck` | `CHANGELOG.md:9,12,17` |
| 报告第 17 节批注 | 四路交叉评估结论 + 新发现 3 项                                                    | 第十三轮报告第 17 节   |

## 2. 本轮新增调整

### 2.1 DSH Host Node 版本下限断层（第 17.2 节第 2 项）

- **问题**：Tekon 允许 Node `^20.19.0 || >=22.12.0`，DSH 要求 `^22.19.0 || >=24.0.0`。preflight 已 fail-closed 且输出含 `DSH Node 要求`，但全仓无 `process.version` 与 `DSH_NODE_REQUIREMENT` 的比对，缺运行时 Node 版本比对与硬拦截。
- **决策**：记录，不在本轮修复。理由：属诊断改进而非安全缺口，优先级低于 L3 smoke，与 L3 smoke 一起在独立 PR 中处理。

### 2.2 文档同步

- `docs/reviews/current.md`：同步第 17 节结论。
- `CHANGELOG.md`：已在 P2-DOC-02 清理中同步。

## 3. 明确不做的项（维持冻结或交用户决策）

| 项                                                                                             | 理由                                                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P0-ARCH-01/02、P0-DATA-01、P0-PRODUCT-01、P1-PLAN-01、P1-SESSION-01、P1-A11Y-01、P1-PROCESS-01 | 架构冻结项，第 17.1 节四路评估逐项核对代码证据后确认冻结裁决成立，按报告第 14 节顺序分独立 PR 推进 |
| P1-GOV-01 main 分支保护                                                                        | 需仓库 Owner 在 GitHub Settings 操作，非代码可解决                                                 |
| DSH Host Node 版本诊断改进                                                                     | 属诊断改进而非安全缺口，与 L3 smoke 一起在独立 PR 处理                                             |
| P2-CODE-01 真实 static lint gate                                                               | 独立评估，不在本 PR                                                                                |
| P2-CODE-02 Session/Workflow status 统一投影                                                    | 架构级重构，不在本 PR                                                                              |
| 全仓 prettier 格式化                                                                           | 独立提交，不混入本 PR                                                                              |

## 4. 验收标准

1. `pnpm test` 全量通过（139 文件，1487 passed / 3 skipped，0 失败；3 skipped 为 L2 probe 无 `DSH_CLI_PATH` 时按预期跳过）。
2. `pnpm --filter @tekon/cli test:e2e` 通过且 0 npm warn。
3. `pnpm audit --prod` 退出码 0。
4. 第十三轮报告第 17 节、CHANGELOG、current.md 内容一致，无占位符。
5. reviewer 循环评审本方案与实施代码，直到未检出必须修复项。
6. 全功能 e2e（CLI + Web Playwright）通过。
7. UI 人工目视检查：本轮 diff 只碰 CHANGELOG 与三个 docs 文件，无 UI 代码变更，此项 N/A。

## 5. 版本号评估

本轮改动为纯文档修正（CHANGELOG 时点表述清理、报告第 17 节批注、current.md 同步、方案文档），无代码/功能/行为变化。v0.20.4 尚未发布（无 git tag），本轮改动吸收进 v0.20.4，不单独 bump。
