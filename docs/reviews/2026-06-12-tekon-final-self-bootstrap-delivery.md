# Tekon 最终自举交付归档证据

- 日期：2026-06-12
- 归档对象：Tekon 标准交付流程下一阶段自举交付
- 关联主运行：`run_5cfee596-1540-40fd-af31-8e6652e62258`
- 关联补充自举运行：`run_8ea4d449-e688-41f4-9ce8-67a3d35d19a3`
- 关联真实 PR：`PR #5`
- 文档性质：正式审阅证据与人工决策入口，不是自动 merge、release 或 deploy 批准。

## 1. 最终交付范围

事实：本阶段交付不再只是新增归档文档。当前 PR 范围包括 Codex 优先适配、标准全链路流程模板、独立角色评审、QA final signoff、PMO checkpoint、长程任务 timeout/heartbeat/outputDir 进展观测、最终归档文档，以及自举过程中暴露出的 prompt/gate 口径修复。

事实：最终归档文档为 `docs/reviews/2026-06-12-tekon-final-self-bootstrap-delivery.md` 与 `docs/reviews/2026-06-12-tekon-final-self-bootstrap-delivery.html`。

边界：本 PR 已创建并更新真实 PR，但不自动 merge、不 release、不 deploy、不执行生产写操作、不接受高风险残余风险。合入、发布、上线和残余风险接受仍需人类 owner 明确确认。

判断依据：用户明确要求 P0 只做真实 PR 闭环；不要求自动合入或上线。

## 2. 提交与引用口径

最终 PR head 会随本归档文档同步提交继续前进，因此本文不把“当前 HEAD”写成不可变的单一事实；最终交付 ref 以 `PR #5` 的 `headRefOid`、远端 CI 页面和最终交付回复为准。

| 观察点 | 证据 | 说明 |
| --- | --- | --- |
| `9dd2ed3974f57648a8da802150cd3114f87b7a60` | `merge self-bootstrap prompt fixes into delivery PR` | 合并 `run_5` delivery 分支与后续 prompt/schema 修复的基线。 |
| `38ccd853b7bd15fd33180b1fdc535cc4088a2581` | `Tekon run_8ea4... rd-code-change` | `run_8` 生成的最终归档文档提交；QA validation 与 QA release signoff 绑定该 ref。 |
| `9260318e500db38ca5f968acd125e6459b773de5` | `tighten QA criteria evidence prompt` | 修复 QA 类 `criteriaEvidence` prompt，要求一个验收标准一个 evidence item。 |
| `dd74e034b75a95a4bbf3a99be2e698f6fe6caa7f` | `clarify PMO pending decision prompt` | 修复 PMO `humanDecisionEvidence.pending` prompt，要求等于当前 Tekon pending human decision 数量。 |
| 本文所在后续提交 | 归档同步与 `qa-signoff` gate hardening | 修复 reviewer 发现的文档漂移，并让 `qa-signoff` gate 拒绝未知或组合 AC id。 |

判断依据：`run_8` 是 Tekon 自举闭环证据；后续 prompt/gate 修复来自该闭环运行中真实暴露的问题，并通过本地测试与 PR CI 覆盖。

## 3. `run_8ea4d449-e688-41f4-9ce8-67a3d35d19a3` 自举结果

事实：

| 项目 | 结果 |
| --- | --- |
| Workflow status | `passed` |
| Gates | `47` |
| Artifacts | `25` |
| Pending human decisions | `0` |
| 关键节点 | PM demand card/review、RD implementation plan/technical review、QA test plan/review、RD code change、Reviewer change review、QA validation、QA release signoff、QA release signoff review、PMO checkpoint 均已通过。 |
| QA 所测 ref | `sha:38ccd853b7bd15fd33180b1fdc535cc4088a2581` |

判断依据：`node packages/cli/dist/index.js status --run-id run_8ea4d449-e688-41f4-9ce8-67a3d35d19a3 --repo /Users/zhaoensheng/Projects/tekon` 返回 `status=passed currentNode=none gates=47 artifacts=25 pendingHumanDecisions=0`。

局限：`run_8` 的 QA signoff 绑定 `38ccd853...`，不覆盖其后暴露并修复的 prompt/gate hardening 提交；这些后续提交由本地测试、独立 reviewer 复查和 PR CI 覆盖。

## 4. 真实 PR 与 CI

事实：

| 项目 | 结果 |
| --- | --- |
| PR | `PR #5` |
| Base | `main` |
| Head branch | `tekon-delivery/run_5cfee596-1540-40fd-af31-8e6652e62258` |
| PR 状态 | `OPEN`，非 draft |
| Merge state | `CLEAN` |
| GitHub Actions | `Core build and tests` passed；`Lint GitHub Actions workflows` passed |

判断依据：`gh pr view 5 --json ...` 与 `gh pr checks 5` 对 `PR #5` 的 live 查询返回上述结果；Tekon `delivery ci-status` 也为 `run_5cfee596-1540-40fd-af31-8e6652e62258` 记录 `ciStatus=passed checks=2`。

## 5. 本地验证

事实：

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | passed |
| `pnpm lint` | passed |
| `pnpm test` | 58 files / 359 tests passed |
| `pnpm --filter @tekon/web test:e2e` | 2 passed |
| `node packages/cli/dist/index.js workflow show standard-delivery --repo /Users/zhaoensheng/Projects/tekon` | `phases=13` |
| `node packages/cli/dist/index.js workflow preflight standard-delivery --repo /Users/zhaoensheng/Projects/tekon` | command gates resolved |
| `git diff --check` | passed |
| 目标文档非空与禁用占位标记扫描 | passed |

判断依据：这些命令在最终 PR push 前本地执行通过；PR push 后远端 CI 也通过核心 build/test 与 workflow lint。

## 6. 角色评审与职责边界

事实：标准流程已经固化以下独立节点：

- PM 先产出需求卡/PRD，再进行 PM 内部需求评审与需求意图复核。
- RD/QA 分别进行需求接口评审，只看自身职责范围。
- RD 在开发前产出 implementation plan，并由独立 RD technical review 评估技术方案。
- QA 在需求评审后产出 test plan，并通过 QA/PM test plan review 校验测试方案合理性。
- Reviewer 独立审阅 RD code change。
- QA validation 产出 test report 与 AC evidence，QA release signoff 做最终“所测即所得”签署。
- PMO checkpoint 校验每个节点产出、gate、artifact、pending human decision 与交付边界。

判断依据：`run_8` 的节点、gate 和 artifact 全部通过，且 role-scope / independent-review gate 已覆盖相关评审节点。

## 7. 长程任务策略

事实：当前流程支持 `--timeout-ms 7200000`、`--no-progress-timeout-ms 1200000`、`--progress-heartbeat-ms 30000` 等长程任务参数；`run_8` 运行期间多个 Codex 节点使用 `codex --profile internal`，并通过 progress file 记录 `timeoutMs`、`noProgressTimeoutMs`、`heartbeatCount`、stderr bytes 与 outputDir activity。

判断依据：这能把 1h/2h 级任务从简单超时改为“有进展则继续、无进展才阻断”的策略，符合长程任务需求。

## 8. 自举暴露的问题与已修复项

事实：

- QA release signoff 曾把多个 AC 合并为 `AC-DC-1/AC-PRD-1` 形式，导致 gate 无法识别每个 AC 的独立 evidence。已修复 prompt，并新增 `qa-signoff` gate 对未知或组合 AC id 的拒绝逻辑与测试。
- PMO checkpoint 曾把人工审阅点数量写入 `humanDecisionEvidence.pending`，而 gate 要求该字段等于 Tekon 当前 pending human decision 数量。已修复 prompt，并用测试覆盖非零 pending human decision 的提示注入。
- 最终归档文档曾只记录 `38ccd853...` 之前的“仅新增文档”口径，已同步为当前 PR 的真实范围。

判断依据：上述问题均来自本次 Tekon 自举运行与独立 reviewer 复查，不是孤立的主观补丁。

## 9. 剩余人工审阅点

- 人工 owner 决定是否合入 `PR #5`。
- 人工 owner 决定是否 release、deploy 或接受残余风险。
- 若需要把 `run_8` readiness 也提升为 `ready=true`，需要为 `run_8` 单独创建/关联 PR 和远端 CI；当前正式交付 PR 复用 `PR #5`。

## 10. 回滚方案

回滚当前 PR 即可撤回本阶段所有代码、模板、文档和测试变更。若只回滚本归档文档，删除 `docs/reviews/2026-06-12-tekon-final-self-bootstrap-delivery.md` 与 `docs/reviews/2026-06-12-tekon-final-self-bootstrap-delivery.html`。

## 11. README、CHANGELOG 与主用户手册同步判断

事实：本次已经修改流程/prompt/gate 行为，但这些变化面向 Tekon 内部标准交付执行质量和评审产物 schema 约束，不改变最终工具使用者的主入口命令、Web 使用路径或主用户手册描述的操作方式。

判断依据：用户当前要求是完成下一阶段自举 PR 闭环与归档证据；主用户手册若展开内部 gate/prompt 细节，会偏离“用户怎么发起、会得到什么、如何判断结果、当前不能做什么”的手册定位。因此本次不更新 `README.md`、`CHANGELOG.md`、`docs/manual/tekon-user-manual.md` 或 `docs/manual/tekon-user-manual.html`。
