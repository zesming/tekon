# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-01 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十四轮全面复审](2026-09-01-tekon-product-runtime-harness-fourteenth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`ccf72726176203b35cb1192c513921901e1e3551`
- **用户本轮整改快照**：`568e79b5750fc4d1441fc0a4cfe9ef1bef153ad3`
- **reviewer 代码修复快照**：`1e16835e9534b8834a6cc9f9106a0fd50f5deb99`
- **当前版本**：`0.20.4`
- **代码自动化状态**：reviewer 代码快照的 Core #368 与 CI #277 均为首次执行 `completed/success`；Core unit 84 文件 / 1036 passed / 3 skipped，Core e2e 8 文件 / 26 passed；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 官方取证基线**：master / `dsh-v0.1.2-alpha.3` `dd6322d604e00eec1ba5e0c8541159906a21094a`
- **当前裁决**：本轮整改与 reviewer 局部修复通过当前代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十四轮确认的用户侧改进

- CHANGELOG 已将 DSH `alpha.3` 的过强“整个合同零差异”收敛为“Tekon 使用的 Headless 兼容锚点未变”；
- CI wiring 文案已从过时的 `needs: [typecheck, audit]` 修正为当前 `needs: typecheck`；audit 仍是独立顶级失败 gate；
- DSH Host Node 要求与 Tekon Node 主合同之间的版本下限断层已被记录；
- 上一轮的 Session snapshot fallback、审批事实层级、DSH L2 版本严格匹配、audit 诊断解耦和版本 lockstep 继续通过回归。

## 本轮首次自动化与真实性裁决

用户整改快照 `568e79...` 的全栈 CI #275 成功，但 focused Core #366 首次执行失败：安静任务在输出目录产生合法文件活动并正常 `close(0)`，仍被 no-progress 检测标记为 `timedOut=true`。同一 workflow rerun 成功说明问题依赖时序，但不能把首次红灯归类为无害基础设施噪声。

本轮因此没有直接复用 rerun 后的绿色结论，而是修复生产判定逻辑、增加边界回归测试，并重新绑定 reviewer 代码快照的首次 Core/CI 终态。

## 本轮 reviewer 直接修复

1. **CommandGateway no-progress 边界竞态**  
   原实现第一次观察到 idle 超阈值就立即终止，文件写入 timer 与检测 interval 在同一事件循环附近到期时可能被一次采样误杀。

2. **两阶段 inactivity watermark**  
   第一次达到阈值只记录 `lastActivityAt` 候选；下一次重新采样 stdout、stderr 与输出目录。watermark 变化则撤销候选，只有同一 watermark 连续超时才终止。

3. **针对性回归测试**  
   新增 `command-gateway-no-progress-boundary.test.ts`，覆盖第一次 idle 候选之后、第二次确认之前产生 artifact 活动，断言正常退出、无 timeout、无 kill 信号。

4. **权威报告与执行方案**  
   新建第十四轮报告，并把第十四轮方案从“纯文档调整”改为绑定真实 runtime 修复与首次自动化证据；不再向第十三轮继续追加当前裁决。

## 已关闭或基本关闭

- CLI unit/e2e 文件命名、lane 分层与 fixture npm warning；
- Corepack shim 与 full-stack/focused-Core package-manager 合同；
- 根与内部 package 数字版本漂移；
- production dependency advisory 无 CI gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session 详情右栏在 Event 缺失时隐藏审批/控制或虚构 running 状态；
- DSH tested pin 的 L1 合同与 L2 版本假通过；
- audit 与 build/test 诊断互相阻塞；
- no-progress 第一次边界采样误杀合法输出目录活动；
- DSH Host Node 版本断层（preflight 硬拦截 + 精确值逃生口 + 结构化结果字段）；
- reviewer 代码快照的 Core、Root、Audit、CLI、Web unit 与 Chromium Playwright 回归门。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；snapshot fallback 只是防御措施；
- **Collaborate**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate→Deliver 仍缺；
- **RunPlan**：尚未成为 execute/resume 唯一事实，未完整绑定 Demand、mode、base/workspace、resolved Provider、权限、网络与 expected Artifacts；
- **长 Session**：在线 replay/pending 已有边界；complete-history export、模型 compaction、统一 retention、真实规模和故障矩阵仍缺；
- **DSH Host Node**：~~preflight 会展示 DSH Node 要求，但尚未在 spawn 前直接比较宿主 Node 版本~~ **已关闭（2026-09-01，§14.5）**：preflight 在 spawn 前硬拦截不兼容宿主 Node，提供精确值逃生口；
- **DSH 实机验证**：alpha.3 L1 合同成立；普通 CI 中 L2 metadata probe 仍跳过，带 API key 的 L3 Provider smoke 仍缺；
- **CommandGateway 维护性**：同一文件仍同时承担 policy、env、spawn、进程组、redaction、filesystem sampler、timeout 与 stream settle；后续应先抽纯 timeout state machine；
- **发布治理**：数字版本已 lockstep；tag、migration、provenance、构建物和 installer/update channel 仍需单一发布流程；
- **供应链治理**：生产依赖有 audit；dev/build tool、SBOM、provenance、dependency review 与签名仍无 gate；
- **仓库治理**：`main` 未保护，required status checks enforcement 关闭；
- **代码卫生**：没有真实 static linter gate，format 历史欠账仍大；
- **可访问性**：仅有 Chromium 和局部组件证据，缺 screen reader、Firefox/WebKit、缩放、对比度与真实弱网验收；
- **PR 可审阅性**：当前 PR 超过百个提交、约 180 个变更文件，建议 squash merge，并把后续架构主线拆独立 PR。

## 仍未关闭的主链路

```text
repo 级 single-owner Runtime
→ executor process/worker 隔离、真实 join 与 restart recovery
→ authoritative Session log / transactional outbox / durable inbox
→ DeepSeek ACP 或其它真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为 execute/resume 唯一输入
→ complete-history export / model compaction / 全链路 retention budget
```

## 允许的成熟度表述

> Tekon v0.20.4 已形成测试覆盖较强、计划与风险边界较透明、Session 在线观察具有基础资源上限的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

## 文档说明

- 本文件与第十四轮报告是当前权威状态；
- 第一至第十三轮报告只读归档，不再追加新 revision 或当前裁决；
- 产品、架构或代码基线变化时新建报告；
- CHANGELOG 只记录版本变化，不作为架构验收权威；
- 本地测试记录不能替代 PR Head 的 GitHub Actions 终态；
- 首次失败与 rerun 结果都必须进入评审证据，不能只展示最终绿色；
- 代码 snapshot 与 `completed/success` 的 Core/CI snapshot 必须成对更新；
- PR Head 若继续变化，必须重新绑定自动化终态；
- 最终建议 squash merge。本轮未执行 merge、release、deploy 或 ruleset 修改。
