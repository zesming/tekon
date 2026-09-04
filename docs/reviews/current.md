# Tekon 当前权威产品与架构评审

- **当前详细报告**：[2026-09-04 第二十二轮全面复审](2026-09-04-tekon-product-runtime-harness-twenty-second-review.md)（[HTML 人审版](2026-09-04-tekon-product-runtime-harness-twenty-second-review.html)）
- **本轮收口方案**：[第二十二轮复审批注与收口执行方案](../superpowers/plans/2026-09-04-twenty-second-review-remediation-plan.md)（[HTML 人审版](../superpowers/plans/2026-09-04-twenty-second-review-remediation-plan.html)）
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **本轮被评审代码快照**：`a6daaf40a3544be7f6d21c1a390a3f05894a86a6`
- **当前版本**：`0.21.0`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前复核版本**：`0.1.3-alpha.1`，tag commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`
- **当前裁决**：第 22 轮六项收口切片已通过本地代码门和独立复审；PR 最终文档 Head 的 GitHub Actions 结果以 PR 外部状态为准。Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收。

## 本轮已闭环的局部切片

1. **Production Audit 分类重试**：CI 改用可测试的 JSON 分类器；有效 Advisory、未知结构和非瞬态错误立即失败，只有明确 timeout、DNS/connect 或 HTTP 5xx 在无有效结果时重试一次。真实 `pnpm audit --prod --json` 本地返回零漏洞。
2. **Node 精确 floor 合同**：matrix 改为 `20.19.0`、`22.12.0`、`22.19.0`、`24.x`，并在 setup-node 后校验解析版本。此处只说明 workflow 与合同测试已更新；四腿在新 Head 上的真实 Actions 终态不得由本文件预先声称。
3. **Clean fail-closed**：CLI `tekon clean` 和 Web `project.clean` 均已停止物理删除。CLI 返回 `CLEAN_SUSPENDED`；Web 对合法、范围内请求记录脱敏的 `project.clean.suspended` Audit 后返回 409，Audit 写失败返回固定 500。完整 export、retention 和 lifecycle-safe purge 仍由 #18/#33 承担。
4. **`planDigest` 公开数据流**：SessionService 已向 workflow/goal 的 `prepareRun` 透传非空 digest；WorkflowEngine 在任何目录、数据库和 Audit 副作用前校验 input/options/canonical digest。独立 `planSnapshot` 绑定与完整 Canonical RunPlan Authority 仍属 #20。
5. **Credential / Provider Health 分层**：`project.health` 不再等待 DSH；新增受 token 保护的 `project.providerHealth`，具有 server-side SHA-256 token key、60 秒 TTL、128 项上限和同 key single-flight。TopBar 在凭据有效后异步请求 Provider 状态，并使用有界 opaque auth scope 隔离 token 轮换。Codex/Claude admission、跨平台 launcher 和结构化 capability snapshot 仍属 #28/#29。
6. **版本与文档**：根包和 Core/CLI/Web lockstep 升至 `0.21.0`；README、CHANGELOG、用户手册、技术文档、正式报告及其 HTML 人审版同步。

## 本地验收证据

被评审代码快照 `a6daaf40` 在当前环境完成：

- `pnpm test`：151 files，1614 passed，1 skipped；唯一 skip 是未设置 `DSH_CLI_PATH` 的 opt-in DSH L2 live probe；
- `pnpm -r typecheck`：通过；
- `pnpm -r build`：通过；
- `pnpm --filter @tekon/cli test:e2e`：3 files、8/8，通过真实构建后二进制；
- `pnpm --filter @tekon/web test:e2e`：Chromium 51/51，最终运行零 retry/flake；
- Production Audit 真实调用：首次返回 `No known vulnerabilities found`；
- 320/390/700/1440 截图目视检查：四档均满足 `scrollWidth === clientWidth`，未见错位、重叠、裁切或展示错误；
- 测试质量最终复审：`hasMustFix=false`；
- 代码/安全复审：代码层无 must-fix；权威文档旧结论已在本轮回填后再次送审。

## 仍未闭环

- **#13/#14/#15/#16/#19**：Authoritative Session、ACP persistent stream、quiescent executor、Repo-level single-owner runtime、Collaborate→Deliver；
- **#18/#33**：完整导出、模型压缩、retention 与生命周期安全 purge；本轮只关闭裸删除入口；
- **#20/#22/#31**：完整 RunPlan authority、异常事实绑定、原子且幂等的 Run Admission；
- **#17/#28/#29/#32**：DSH Windows/L3/pin、跨平台 launcher、完整 Provider Admission、凭据与 trusted proxy evidence；
- **#21/#24/#25/#26**：全站 A11y/多浏览器、Node 与发布治理、CommandGateway 拆分、Semantic Lint。

## 证据边界与残余风险

- Node 精确 floor 在新 Head 的真实 GitHub Actions 结果只能由 PR 外部 checks 证明；本地 YAML 合同测试不能替代四档 runner。
- Web 只完成 Chromium 与四视口截图检查，不代表 Firefox、WebKit、真实设备或屏幕阅读器验收。
- 未设置 `DSH_CLI_PATH`，因此本地全量测试跳过 opt-in DSH L2 live probe；tested pin 继续保持 `0.1.2-alpha.3`。
- Provider server cache 从 probe 完成起保留 60 秒，而客户端按固定 60 秒刷新；边界时序下 UI 可能到下一轮刷新才重新探测，最坏接近 120 秒。真实 Run 仍会独立执行 admission preflight，因此该风险不构成安全绕过，后续应按 `checkedAt` 调度刷新。
- PR #11 规模仍过大，建议最终 Squash Merge；后续主问题拆成独立小 PR。

## 允许的成熟度表述

> Tekon v0.21.0 已形成测试覆盖较强、执行计划和风险边界较透明的实验性受控交付执行与观察基础设施；本轮进一步关闭了裸清理入口、Audit 误重试、公开 planDigest 断链和 Credential Health 阻塞。Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子且幂等的 Run Admission、跨平台 Provider Launcher、正式 Provider 凭据/代理/能力证据、可证明的 Shutdown/Restart、完整历史导出和生命周期安全清理仍未闭环。

## 评审资料维护规则

- 本文件是稳定入口，第二十二轮 Markdown/HTML 是当前详细裁决；
- 第一至第二十一轮只读归档，不再追加新裁决；
- 正式人审文档保留一个 Markdown 内容源和一个同步 HTML 人审版，不再复制额外 Closure Plan 或平行裁决源；
- 仓内报告绑定被评审代码快照；包含报告本身的最终 commit/checks 由 PR 外部状态证明；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- PR #11 最终建议 Squash Merge，后续主线不再回填该超大分支。
