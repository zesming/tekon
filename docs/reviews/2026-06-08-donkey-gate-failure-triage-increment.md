# Donkey Gate 失败诊断增量报告

日期：2026-06-08

范围：补齐 review surface 中的 Gate Failure Triage，让失败 gate 不只呈现日志正文，还能给出分类、日志锚点、是否建议重试和下一步命令。本文不改变 gate 执行策略，不新增自动重试，也不放宽任何安全或人工审批边界。

## 1. 背景判断

真实工作中，Donkey 的失败体验不能只停留在“某个 gate failed”。用户需要快速知道失败属于命令缺失、退出码失败、安全扫描、artifact schema 问题还是人工审批阻塞，并能跳到对应日志，判断是该修 repo profile、修代码、补 artifact，还是人工审批后继续。

本轮把这类判断做成结构化 review surface 字段，CLI 和 Web 共用同一诊断结果，避免终端和 dashboard 各自拼接解释。

## 2. 已完成能力

| 能力                         | 实现位置                                                                                                                                           | 说明                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate Failure Triage 数据结构 | `packages/core/src/review/surface.ts`                                                                                                              | 新增 `gateFailureTriage`，包含 gateId、nodeId、gateType、status、classification、retry、summary、suggestedCommand 和 logHref。                                                      |
| 分类到建议映射               | `packages/core/src/review/surface.ts`                                                                                                              | 覆盖 `missing-command`、`exit-code`、`timeout`、`human-approval`、`blocked-for-approval`、`security-findings`、artifact 缺失/非法、policy rejected 和 unsupported gate 等常见分类。 |
| CLI 输出                     | `packages/cli/src/index.ts`                                                                                                                        | `review --run-id` 新增 `## Gate Failure Triage` 区块，展示 classification、retry、log href、summary 和 suggestedCommand。                                                           |
| Web 展示                     | `packages/web/src/client/App.tsx`                                                                                                                  | dashboard 新增 Gate Failure Triage 面板，按当前选中 run 展示失败 gate 诊断，并把诊断行链接到对应 gate log。                                                                         |
| 回归测试                     | `packages/core/__tests__/review/surface.test.ts`、`packages/cli/__tests__/run-cli.test.ts`、`packages/web/__tests__/e2e/release-dashboard.test.ts` | 覆盖 failed gate triage、CLI review 区块、human approval after-approval 路径、security-findings 路径和 Web 面板内容。                                                               |

## 3. 当前边界

- Gate Failure Triage 是审阅与诊断能力，不会自动修改 repo profile、代码、artifact 或 workflow。
- `suggestedCommand` 是下一步排查入口，不代表命令一定能自动修复问题。
- `missing-command` 仍要求用户显式修正 `.donkey/repo-profile.yaml` 或配置 `notApplicable`；Donkey 不会因为命令缺失静默跳过 gate。
- `human-approval` 和 `blocked-for-approval` 只给出 `after-approval` 建议；用户必须先审阅待处理审批和风险，再显式运行 approve 命令继续。
- `security-findings` 仍必须先修复并移除 finding；本增量不会放宽安全扫描。
- 真实 provider 的失败分类仍需要更多样本校准，当前先覆盖已有 gate classification。

## 4. 验证记录

本轮阶段性验证：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit -- --run packages/core/__tests__/review/surface.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web typecheck
```

本轮最终收口验证：

```bash
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
```

新增覆盖点：

- `review/surface.test.ts` 覆盖 `exit-code` 失败 gate 输出 `retry=after-fix`、日志锚点和 `donkey log --run-id` 建议命令。
- `review/surface.test.ts` 覆盖 `missing-command` 输出 repo profile preflight 建议。
- `review/surface.test.ts` 覆盖 command gateway `blocked-for-approval`、human gate `human-approval`、旧 human gate 缺失 classification 时的归一化，以及 `security-findings`。
- CLI `review` 输出包含 `## Gate Failure Triage`，并断言 human approval 显示为 `retry=after-approval`。
- Web release dashboard e2e 覆盖 Gate Failure Triage 面板内容可见，并展示 human approval 的 after-approval 建议命令。

## 5. 后续仍需

1. 用真实 provider 失败样本校准 triage summary 和 suggestedCommand 是否足够可操作。
2. 对连续失败后的阻断策略、上下文保留和是否自动生成修复任务继续打磨。
3. 把无 checks、CI 权限失败等远端状态异常也纳入类似 triage 结构。

## 6. Reviewer 结论

结论：APPROVED。

必须修复项：无。

复查摘要：

- 第一轮 reviewer 指出的 human gate blocked 误归为 `after-fix` 已修复：`human-approval`、`blocked-for-approval` 和旧 human gate 缺失 classification 的 blocked 状态都会输出 `retry=after-approval`，并提示必须先审阅 pending decision 和 risk。
- Web Gate Failure Triage 已改为链接到对应 gate log，不再只是展示纯文本。
- `security-findings` 仍保持 `after-fix`，建议命令为 `donkey review --run-id ...`，不提示绕过安全扫描。
- Core/CLI/Web 覆盖已补齐 human approval、command blocked approval、security findings、missing command 和 exit-code 路径。

非阻断建议：后续可考虑只对每个 node/gate 的最新失败结果输出 triage，避免 auto-fix 后历史失败产生噪音。
