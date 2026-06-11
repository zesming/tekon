# Standard Delivery Seed Run 归档记录

日期：2026-06-11  
Run ID：`run_04b37267-2686-42c6-a0a4-9b37410f65f7`  
结论：P1-0 seed run 未完成，状态为 `interrupted`。这次运行证明 RD 节点在 300 秒内未完成 manifest 交付，并暴露出 seed 任务粒度过大和默认 provider 超时偏短的风险；它不证明 `standard-delivery` 方向不可行。

## 1. 运行输入

命令：

```bash
node packages/cli/dist/index.js run "为 Tekon 新增 standard-delivery workflow 模板初版，并同步角色边界说明。范围：1. 新增 workflows/standard-delivery.yaml，包含 PM 内审、RD/QA 需求接口评审、RD 技术评审、QA 测试方案评审、QA final signoff、PMO checkpoint 等节点。2. 更新 roles/pm|rd|qa|reviewer|pmo/system.md，写明角色评审范围和不越权边界。3. 新增或更新 workflow template 测试，确保模板能被加载且关键节点存在。4. 不实现 independent-review、role-scope、qa-signoff、ac-evidence 等新 gate runner。5. 使用 Codex provider 创建真实 PR，不自动 merge。" --template standard-feature --agent codex --repo /Users/zhaoensheng/Projects/tekon
```

Provider snapshot：

- provider：`codex`
- command：`codex`
- profile：`internal`
- promptMode：`stdin`
- timeoutMs：`300000`
- sandbox：`workspace-write`
- network：`restricted`

## 2. 运行结果

`status` 输出：

```text
runId=run_04b37267-2686-42c6-a0a4-9b37410f65f7 repo=/Users/zhaoensheng/Projects/tekon status=interrupted currentNode=run_04b37267-2686-42c6-a0a4-9b37410f65f7_rd-implementation gates=1 artifacts=2 pendingHumanDecisions=0
```

节点状态：

| 节点                          | 角色     | 状态        | 说明                                        |
| ----------------------------- | -------- | ----------- | ------------------------------------------- |
| `pm-intake`                   | PM       | passed      | 产出 demand-card 和 PRD，schema gate 通过   |
| `rd-implementation`           | RD       | interrupted | Codex provider 300 秒超时，无 manifest 入库 |
| `qa-validation`               | QA       | pending     | 未开始                                      |
| `reviewer-independent-review` | reviewer | pending     | 未开始                                      |
| `pmo-delivery`                | PMO      | pending     | 未开始                                      |

已入库 artifact：

- `.tekon/runs/run_04b37267-2686-42c6-a0a4-9b37410f65f7/artifacts/run_04b37267-2686-42c6-a0a4-9b37410f65f7_pm-intake/demand-card.v1.md`
- `.tekon/runs/run_04b37267-2686-42c6-a0a4-9b37410f65f7/artifacts/run_04b37267-2686-42c6-a0a4-9b37410f65f7_pm-intake/prd.v1.md`

Gate：

| Gate                    | 结果                       |
| ----------------------- | -------------------------- |
| PM `demand-card` schema | passed                     |
| PM `prd` schema         | previously-passed / passed |

## 3. 失败证据

Audit event：

```text
node.interrupted {"nodeId":"run_04b37267-2686-42c6-a0a4-9b37410f65f7_rd-implementation","error":"agent timed out: provider=codex"}
```

RD provider 日志：

- stdout：0 bytes
- stderr：209902 bytes
- stderr 显示 Codex 启动参数包含 `workdir`、`model`、`approval: never`、`sandbox: workspace-write`、`reasoning effort: xhigh`。

RD worktree 残留：

- worktree 中有 `packages/core/__tests__/workflow/template.test.ts` 的部分修改。
- 未发现 RD 节点 `artifact-manifest.json`。
- 主 workflow 没有创建 PR，未执行 merge 或 release。

## 4. 判断

事实：

- 需求卡和 PRD 可以由 Codex PM 节点生成并通过 schema gate。
- RD 节点在 300 秒内没有完成必需 artifact manifest，workflow 按中断处理。
- 任务范围同时包含模板、角色、测试、PR 交付，超过单个 seed 节点的稳定粒度。

推断：

- 300 秒默认超时对真实 Codex 长程任务偏短。
- 即使拉长超时，也需要进展观测，否则卡死任务只会占用更久。
- P1-A 首版模板必须避免未实现 artifact/gate runner，否则会在 parser 层失败。

建议：

- 将 P1-0 调整为 P1-0R 失败归档。
- 将 P1-A 拆成最小兼容模板、角色边界和长程 provider 支持三个小粒度任务。
- 把真实 provider 默认超时提升到 1 小时，并在后续补充 heartbeat、manifest mtime、artifact 文件变化和无进展超时。
- 后续再用 `standard-delivery` 跑小型 Tekon 自身需求，创建真实 PR，不自动 merge。

## 5. 本轮跟进

本轮已按上述结论调整方案：

- `docs/superpowers/plans/2026-06-11-tekon-standard-delivery-next-phase.md`
- `docs/superpowers/plans/2026-06-11-tekon-standard-delivery-next-phase.html`

并在实现范围中加入：

- parser-compatible `workflows/standard-delivery.yaml`
- 角色边界 `roles/*/system.md`
- 真实 provider 默认 1 小时超时和 CLI/Web snapshot 测试
