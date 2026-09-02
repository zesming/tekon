# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-02 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十五轮全面复审](2026-09-02-tekon-product-runtime-harness-fifteenth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`99e00655470f43273bbc0d25228924e838e51652`
- **用户本轮整改快照**：`13c27ebfdd473b7f2e866d6a1faf54c29c087801`
- **reviewer 代码修复快照**：`ebd040e44f66e26c69af449584eb29a699d52726`
- **当前版本**：`0.20.4`
- **代码自动化状态**：reviewer 代码快照的 Core #392 与 CI #301 均为首次执行 `completed/success`；Core unit 84 文件 / 1061 passed / 3 skipped，Core e2e 8 文件 / 26 passed，CLI unit 9 文件 / 64 passed，CLI e2e 3 文件 / 8 passed；Root build/typecheck、production dependency audit、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前官方版本**：`0.1.2-alpha.4`，master/release commit `4e84901e6471b79ec0338099867ebb4606d12bb5`
- **当前裁决**：本轮整改与 reviewer 局部修复通过当前代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十五轮确认的用户侧改进

- DSH preflight 在启动外部二进制前检查 Host Node；
- `DshHostNodeError`、CLI failure kind、文本/JSON 字段可以区分宿主问题与 dsh 未安装；
- CLI/Web 的真正运行路径都接入 Host Node fail-closed；
- `TEKON_DSH_ALLOW_HOST_NODE=<实际版本>` 提供显式 exact-value 风险确认；
- Core、CLI、Web 和用户手册增加对应覆盖；
- 用户整改快照 Core #372 与 CI #281 首次执行均成功。

## 本轮 reviewer 直接修复

1. **稳定 semver 语义**  
   Host Node 只接受完整稳定 `major.minor.patch`；prerelease、partial、malformed 一律 fail-closed。普通 semver 范围不会因为 major/minor 看似满足就接纳 `22.19.0-rc.1`。

2. **compatibility 与 bypass 分离**  
   结果分别记录 `hostNodeCompatible/hostNodeBypassed` 和 `versionCompatible/versionBypassed`。逃生口只代表人工允许继续，不会把不兼容事实改写为兼容。

3. **CLI 结论真实性**  
   精确 tested pin 显示“已验证”；escape hatch 显示“已旁路（无合同保证）”；JSON 保留 admission `compatible`，新增字段承担兼容性事实。

4. **移除公开测试注入**  
   `--host-node-version` 已从公共 CLI 移除，避免为当前机器伪造兼容结果。程序化测试 seam 保留。

5. **Web health 与实际运行同源**  
   `project.health` 现在执行完整 Host Node + exact pin + help anchor + config row preflight，而不是只看 `dsh --version`。健康探测使用 1 秒 metadata 预算，实际运行保留 5 秒默认预算。

6. **可行动诊断**  
   顶栏在 dsh-headless 不可用时提示运行 `tekon provider preflight dsh-headless`，没有为 tooltip 扩张 RPC schema。

7. **外部版本事实**  
   DeepSeek Harness 当前 latest 已是 alpha.4。Tekon 继续 fail-closed 到 tested alpha.3；在完成 alpha.4 L1/L2/L3 与默认 `web_fetch` 风险复核前不盲目升 pin。

## 已关闭或基本关闭

- CLI unit/e2e 文件命名、lane 分层与 fixture npm warning；
- Corepack shim 与 full-stack/focused-Core package-manager 合同；
- 根与内部 package 数字版本漂移；
- production dependency advisory 无 CI gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session detail right rail 在 Event 缺失时隐藏审批/控制或虚构 running 状态；
- CommandGateway no-progress 第一次边界采样误杀合法文件活动；
- DSH Host Node 启动前硬拦截；
- Host Node prerelease/partial/malformed 假兼容；
- Host/version escape hatch 被错误表述为正式兼容；
- 公开 Host Node 测试注入参数；
- Web health 与真正 DSH run admission 不一致；
- reviewer 代码快照的 Core、Root、Audit、CLI、Web unit 与 Chromium Playwright 回归门。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；snapshot fallback 只是防御措施；
- **Collaborate**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate→Deliver 仍缺；
- **RunPlan**：尚未成为 execute/resume 唯一事实，未完整绑定 Demand、mode、base/workspace、resolved Provider、权限、网络与 expected Artifacts；
- **长 Session**：在线 replay/pending 已有边界；complete-history export、模型 compaction、统一 retention、真实规模与故障矩阵仍缺；
- **DSH alpha.4**：upstream 已更新；Tekon 仍测试锁定 alpha.3，普通 CI 的真实 L2 metadata probe 跳过，带 API key 的 L3 smoke 仍缺；
- **Provider exception 审计**：Host/version bypass 仍由进程级环境变量控制，未写入 Provider snapshot 和 Audit；
- **CommandGateway 维护性**：同一文件仍承担 policy、env、spawn、进程组、redaction、filesystem sampler、timeout 与 stream settle；
- **发布治理**：数字版本已 lockstep；tag、migration、provenance、构建物和 installer/update channel 仍需单一发布流程；
- **供应链治理**：生产依赖有 audit；dev/build tool、SBOM、provenance、dependency review 与签名仍无 gate；
- **仓库治理**：`main` 未保护，required status checks enforcement 关闭；
- **代码卫生**：没有真实 static linter gate，format 历史欠账和 Git fixture 日志噪声仍在；
- **可访问性**：仅有 Chromium 和局部组件证据，缺 screen reader、Firefox/WebKit、缩放、对比度与真实弱网验收；
- **PR 可审阅性**：当前 PR 超过百个提交、约 180 个变更文件，建议 squash merge并拆分后续架构主线。

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

> Tekon v0.20.4 已形成测试覆盖较强、计划与风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具备明确 tested-pin 与 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

## 文档说明

- 本文件与第十五轮报告是当前权威状态；
- 第一至第十四轮报告只读归档，不再追加当前裁决；
- 产品、架构或代码基线变化时新建报告；
- CHANGELOG 只记录版本变化，不承担动态 upstream latest 事实；
- 本地测试记录不能替代 PR Head 的 GitHub Actions 终态；
- tested pin、upstream latest、actual installed version 和 bypass admission 必须分开；
- 代码 snapshot 与 `completed/success` 的 Core/CI snapshot 必须成对更新；
- PR Head 若继续变化，必须重新绑定自动化终态；
- 最终建议 squash merge。本轮未执行 merge、release、deploy 或 ruleset 修改。
