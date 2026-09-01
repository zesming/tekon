# 第十四轮复审整改执行方案（2026-09-01）

> 依据：第十四轮复审报告（`docs/reviews/2026-09-01-tekon-product-runtime-harness-fourteenth-review.md`）。
> 范围：本 PR（`review/human-first-harness-2026-08-28` → `main`，PR #11）内可安全落地的文档真实性与 `command-gateway` no-progress 边界修复；架构主线继续拆独立 PR。

## 1. 用户本轮已完成且通过复核的调整

| 项 | 落地内容 | 裁决 |
| --- | --- | --- |
| DSH 表述收敛 | CHANGELOG 将“alpha.2→alpha.3 整个合同零差异”改为“Tekon 使用的 Headless 兼容锚点未变” | 通过；与官方 alpha.3 事实一致 |
| CI wiring 文案 | 将过时的 `needs: [typecheck, audit]` 修正为当前 `needs: typecheck` | 通过；audit 仍是独立顶级失败 gate |
| DSH Host Node 断层 | 记录 Tekon Node 合同与 DSH `^22.19.0 || >=24.0.0` 的差异 | 问题成立，运行时直接版本比较仍未实现 |
| 评审资料补充 | 第十三轮报告追加交叉评估、同步 `current.md`、新增本方案 | 内容有价值，但继续向旧报告叠 revision 不符合既定维护规则 |

## 2. 本轮发现的阻断项

### 2.1 P1-RUNTIME-03：no-progress 首次边界采样可能误杀正常任务

用户整改快照 `568e79b5750fc4d1441fc0a4cfe9ef1bef153ad3` 的全栈 CI #275 成功，但 focused Core #366 首次执行失败：

```text
command gateway
→ treats output directory file changes as progress for quiet long-running commands
→ expected timedOut=false
→ received timedOut=true
→ exitCode=0
```

同一 workflow rerun 成功，只能证明问题依赖时序，不能把首次失败归类为无害噪声。`timedOut=true` 与 `exitCode=0` 同时出现，说明 gateway 在文件活动被下一次采样看见前已经触发了 no-progress 终止。

### 2.2 根因

原逻辑在第一次观察到：

```text
Date.now() - lastActivityAt >= noProgressTimeoutMs
```

时立即调用 `triggerTimeout('no-progress')`。文件写入 timer、close timer 和检测 interval 在同一事件循环附近到期时，一次采样可能落在合法文件活动之前，任务失去下一次纠错机会。

## 3. 已实施修复

### 3.1 两阶段 inactivity watermark

`packages/core/src/runtime/command-gateway.ts` 现采用连续确认：

1. 第一次达到 no-progress 阈值时，保存当前 `lastActivityAt` watermark；
2. 下一次检测重新采样 stdout、stderr 和输出目录；
3. watermark 变化则撤销候选超时；
4. watermark 未变化且仍超时，才执行 no-progress 终止。

该实现不改变总超时，真正静默任务最多多等待一个检测间隔；也不通过放大用户配置阈值掩盖问题。

### 3.2 针对性回归测试

新增：

```text
packages/core/__tests__/runtime/command-gateway-no-progress-boundary.test.ts
```

覆盖：第一次 idle 候选之后、第二次确认之前产生 artifact 文件活动；预期正常 `close(0)`，`timedOut=false`，且无 SIGTERM/SIGKILL。

### 3.3 代码快照

- 用户整改快照：`568e79b5750fc4d1441fc0a4cfe9ef1bef153ad3`
- reviewer 代码修复快照：`1e16835e9534b8834a6cc9f9106a0fd50f5deb99`

## 4. 实际验收结果

reviewer 代码快照的首次自动化结果：

| Gate | 结果 |
| --- | --- |
| Core #368 | `completed/success` |
| Core unit | 84 文件；1036 passed；3 skipped；0 failed |
| 新 no-progress 边界测试 | 1 passed |
| 原 command-gateway 单测 | 29 passed |
| Core e2e | 8 文件；26 passed |
| CI #277 | `completed/success` |
| Root build + typecheck | success |
| Production dependency audit | success |
| CLI build/unit/e2e | success |
| Web build/typecheck/unit | success |
| Chromium Playwright | success |

3 个 skipped 仍是未设置 `DSH_CLI_PATH` 时按预期跳过的真实 DSH L2 metadata probe；当前绿色自动化不等于完成了真实 DSH 二进制或带 API key 的 L3 Provider smoke。

## 5. 文档收敛

- 新建第十四轮权威报告，不再向第十三轮追加当前裁决；
- `docs/reviews/current.md` 改为指向第十四轮报告，并绑定用户整改、reviewer 代码修复与自动化快照；
- 第一至第十三轮报告转为只读历史；
- CHANGELOG 继续只记录版本变化，不作为架构验收权威。

## 6. 明确不在本轮关闭的项目

| 项 | 原因 |
| --- | --- |
| repo 级 single-owner Runtime | 破坏性架构重构，需 daemon/lock 与迁移窗口 |
| executor 隔离、真实 kill/join、restart recovery | 需 process/worker ownership、checkpoint 与故障注入 |
| authoritative Session / transactional outbox / durable inbox | 需先决定事实源角色与迁移方案 |
| Collaborate streaming/follow-up/cancel/resume | 应通过 ACP 或等价 persistent Provider vertical slice 验证 |
| RunPlan execute/resume authority | 需完整绑定 Demand、mode、base/workspace、Provider、权限、网络与 Artifacts |
| complete-history export / model compaction / retention | 独立产品与数据链路 |
| DSH Host Node 直接比较 | P1 诊断改进；与真实 L2/L3 smoke 独立推进 |
| branch protection / required checks | 需仓库 Owner 配置 ruleset |
| Firefox/WebKit、screen reader、缩放、对比度 | 独立 a11y/兼容性专项 |
| static linter、format debt、SBOM/provenance | 独立工程治理 PR |

## 7. 版本号与合并建议

本轮修复改变了命令无进展判定的边界行为，但仍属于 v0.20.4 未发布快照内的 PATCH 收敛，不单独 bump。

PR 已超过百个提交、约 180 个变更文件，建议最终 squash merge。合并前必须确认最终 PR Head 的 Core 与 CI 都保持 `completed/success`；本方案不执行 merge、release、deploy 或 ruleset 修改。
