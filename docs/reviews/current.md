# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-01 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十三轮全面复审](2026-09-01-tekon-product-runtime-harness-thirteenth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`cf2ccf18d5947331487ca285e1fd5cffb2d68c82`
- **用户 v0.20.4 整改快照**：`1c285e03b017a4935603859f0e1fb1726d3f230e`
- **reviewer 代码快照**：`6917c06369d5cb0da5b681fc61d2bb25d600572d`
- **当前版本**：`0.20.4`
- **代码自动化状态**：reviewer 代码快照的 Core #362 与 CI #271 均为 `completed/success`；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 官方取证基线**：master / `dsh-v0.1.2-alpha.3` `dd6322d604e00eec1ba5e0c8541159906a21094a`
- **当前裁决**：v0.20.4 整改与 reviewer 局部修复通过当前代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十三轮确认的用户侧改进

- DSH tested pin 升到官方 `0.1.2-alpha.3`；Tekon 使用的 headless README、入口实现、Node engines 与 help/config 锚点保持兼容；
- 根产品与 `@tekon/core`、`@tekon/cli`、`@tekon/web` 版本统一为 `0.20.4`，smoke 断言 lockstep；
- 6 个 CLI fixture 不再 spawn `npm init/pkg set`，CLI unit/e2e 的 unknown-config warning 已清理；
- CI 独立执行 `pnpm audit --prod`，生产依赖 advisory gate 已建立；
- smoke 目录过滤和 dirty-base 测试格式耦合已收敛；
- 上一轮的 RunPlan digest、DSH preflight、Session/Workspace SSE backpressure、历史 cursor、长文本和页面窗口上限继续通过回归。

## 本轮 reviewer 直接修复

1. **Session 详情右栏对 best-effort Event 的过度依赖**  
   `session.get` 现在作为 runId、生命周期与 attention 的安全回退；live Event 到达后优先。Event 缺失或尚未追上时，不再隐藏 snapshot 已知的 run/审批读取入口，也不再把未知状态虚构成 `running`。

2. **审批事实层级**  
   Event/Session 只决定何时查询，`gate.list` 决定当前真实 pending decisions；审批后同时失效 Session detail/list、Gate 与 project overview，避免陈旧 snapshot 持续触发旧卡片。

3. **RunControls 状态安全**  
   未知状态 fail-closed；组件以 `runId` 为 key，切换 run 时重置二次取消确认。新增 10 个 snapshot fallback 测试。

4. **DSH L2 probe 真实性**  
   真实二进制 probe 现在要求安装版本精确匹配 tested pin；L1 fixture、L2 metadata probe、L3 带凭据 provider smoke 分层表述。普通 CI 未配置 `DSH_CLI_PATH`，不能把绿色 CI 写成真实 DSH smoke。

5. **Audit 与功能诊断解耦**  
   audit 保持独立顶级失败 gate，但 CLI/Web 只依赖 root build/typecheck；registry/advisory 故障不再压掉全部应用测试。audit install 使用 `--ignore-scripts` 并有 5 分钟上限。

6. **CI 名称真实性**  
   `Root typecheck + lint` 改为 `Root build + typecheck`。当前 package 的 `lint` 仍等价于 TypeScript typecheck，没有真实 JS/TS static linter。

7. **权威文档基线**  
   第十三轮另建新报告；第十二轮及之前转为只读历史，不再继续追加 revision。

## 已关闭或基本关闭

- CLI unit/e2e 文件命名与 lane 分层；
- Corepack shim 与 full-stack/focused-Core package-manager 合同；
- CLI fixture npm unknown-config warning；
- 根与内部 package 数字版本漂移；
- production dependency advisory 无 CI gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session 右栏在 Event 缺失时隐藏审批/控制或虚构 running 状态；
- DSH tested pin 的 L1 合同与 L2 版本假通过；
- 当前 reviewer 代码快照的 Core、Root、Audit、CLI、Web unit 与 Chromium Playwright 回归门。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；本轮 snapshot fallback 是防御措施，不是事实源迁移完成；
- **Collaborate**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate→Deliver 仍缺；
- **RunPlan**：尚未成为 execute/resume 唯一事实，未完整绑定 Demand、mode、base/workspace、resolved Provider、权限、网络和 expected Artifacts；
- **长 Session**：在线 replay/pending 已有边界；complete-history export、模型 compaction、统一 retention、真实规模和故障矩阵仍缺；
- **DSH**：alpha.3 L1 合同成立；未运行真实二进制 L2，也未运行带 API key 的 L3 provider smoke；
- **发布治理**：数字版本已 lockstep；tag、migration、provenance、构建物和 installer/update channel 仍需单一发布流程；
- **供应链治理**：生产依赖有 audit；dev/build tool、SBOM、provenance、dependency review 与签名仍无 gate；
- **仓库治理**：`main` 未保护，required status checks enforcement 关闭；
- **代码卫生**：没有真实 static linter gate，format 历史欠账仍大；
- **可访问性**：仅有 Chromium 和局部组件证据，缺 screen reader、Firefox/WebKit、缩放、对比度和真实弱网验收；
- **PR 可审阅性**：当前 PR 接近百个提交、约 180 个变更文件，建议 squash merge，并把后续架构主线拆独立 PR。

## 仍未关闭的主链路

```text
repo 级 single-owner Runtime
→ executor process/worker 隔离、真实 join 与 restart recovery
→ authoritative Session log / durable inbox
→ DeepSeek ACP 或其它真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为 execute/resume 唯一输入
→ complete-history export / model compaction / 全链路 retention budget
```

## 允许的成熟度表述

> Tekon v0.20.4 已形成测试覆盖较强、计划与风险边界较透明、Session 在线观察具有基础资源上限的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

## 文档说明

- 本文件与第十三轮报告是当前权威状态；
- `CHANGELOG.md` v0.20.4 中“整个 headless 合同零差异”和 `needs: [typecheck, audit]` 代表整改时点，不能覆盖当前代码与第十三轮裁决；
- 第一至第十二轮报告只读归档；
- 产品或架构基线变化时新建报告，不在旧报告尾部继续叠加 revision；
- CHANGELOG 只记录版本变化，不作为架构验收权威；
- 代码 snapshot 与 `completed/success` 的 Core/CI snapshot 必须成对更新；
- PR Head 若继续变化，必须重新绑定自动化终态；
- 最终建议 squash merge。本轮未执行 merge、release、deploy 或 ruleset 修改。
