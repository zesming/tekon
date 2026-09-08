# Tekon 验收与发布证据索引

维护日期：2026-09-08 · 当前版本以根 `package.json` 为准

这是 `docs/reviews/` 的固定入口。当前产品、交互和运行时口径见[文档总索引](../README.md)；本页只登记正式验收、发布证据和仍需人工判断的边界。历史过程报告不再作为第二套规范。

## 当前结论

本次 2026-09-08 发布审核已归档源码、回归日志、视觉证据与真实 Claude 调用记录。当前结果、失败修复、恢复状态和未覆盖范围统一见[发布审核报告](2026-09-08-release-audit.md)，本索引不重复维护计数或临时运行状态。历史记录仅证明其原始快照，不能宣称所有真实 Provider 或远端交付已通过。

v0.26.0 的 PR #35 已合并。遗留问题的发布影响及 v0.26.1 产物诊断修复统一见[发布影响评估与补修验收](2026-09-08-release-followup.md)；原审核的真实运行与源码证据不回填为补修后的真实 Provider 验收。

当前固定边界：

- `Run`、`Node`、`Job`、`Artifact`、`Gate`、`Audit` 和 `Delivery` 的持久记录是领域事实源；`Session` feed 是观察投影。
- push、创建 PR、合入、上线和权限扩大保留人工控制；`readiness=false` 可能只是缺少真实 PR/CI/QA/安全证据，不表示本地 workflow 一定失败。
- `roles/*/tools.yaml`、`permissionProfile` 和顶层 CommandGateway 不能扩大为 Provider 内部工具或 OS 沙箱。当前编译与顶层调用测试不足以证明阻断 Agent 内部自行执行 `git`、`gh` 或其他外部工具。

## 保留的正式验收与发布证据

| 记录 | 保留原因与证明范围 |
| --- | --- |
| [2026-09-08 v0.26.1 影响评估与补修（MD）](2026-09-08-release-followup.md) · [HTML](2026-09-08-release-followup.html) | 逐项说明发布影响、默认 Provider 验收缺口与历史租约处置；记录诊断补修、兼容回归、独立复核及新源码快照，证据见 [`evidence/2026-09-08-release-followup/`](evidence/2026-09-08-release-followup/)。 |
| [2026-09-08 发布前全面审核（MD）](2026-09-08-release-audit.md) · [HTML](2026-09-08-release-audit.html) | 当前发布审核；记录全量测试、CLI/Chromium e2e、构建/类型/lint/audit、72 张图像与专项交互证据、真实 Claude 生命周期和外部 Provider 验证缺口。摘要、运行记录、源码哈希、日志和截图见 [`evidence/2026-09-08-release/`](evidence/2026-09-08-release/)。 |
| [R27 排队恢复、Gate 关停与交付验收（MD）](2026-09-06-r27-delivery-acceptance.md) · [HTML](2026-09-06-r27-delivery-acceptance.html) | 历史最近专项验收；包含独立宿主恢复、真实 Claude 交付、四档视口、控制反馈和证据边界。原始 JSON、截图和验证摘要见 [`evidence/2026-09-06-r27/`](evidence/2026-09-06-r27/)。 |
| [R26 取消恢复与安全重启验收（MD）](2026-09-06-r26-recovery-acceptance.md) · [HTML](2026-09-06-r26-recovery-acceptance.html) | 正式记录取消补偿、退出证据、owner fence、显式恢复和跨宿主 Claude 生命周期；证据见 [`evidence/2026-09-06-r26/`](evidence/2026-09-06-r26/)。 |
| [最终自举交付归档（MD）](2026-06-12-tekon-final-self-bootstrap-delivery.md) · [HTML](2026-06-12-tekon-final-self-bootstrap-delivery.html) | 早期标准交付自举与真实 PR #5 的历史正式证据；保留原始运行、QA signoff、PR/CI 和人工控制边界，不代表当前版本。 |
| [Codex 自举闭环归档（MD）](2026-06-10-tekon-codex-self-bootstrap-report.md) · [HTML](2026-06-10-tekon-codex-self-bootstrap-report.html) | 早期真实 Codex provider → PR #2 闭环证据；保留 provider 认证、artifact、Gate、PR/CI 和 readiness 局限，不代表当前版本。 |

R23–R25 的视觉证据资产仍保留，报告正文已归并并删除：

- [`assets/r23-v0.22.0/`](assets/r23-v0.22.0/)：Provider/受理/目录未就绪/错误状态的 320/390/700/1440px 截图。
- [`assets/r24-v0.23.0/`](assets/r24-v0.23.0/)：简单/高级入口和 Session/Run 恢复身份绑定截图。
- [`assets/r25-v0.23.1/`](assets/r25-v0.23.1/)：受理回执与 recovery-required 状态截图及 [`evidence.json`](assets/r25-v0.23.1/evidence.json)。

## 证据使用规则

证据声明必须写清代码或文档快照、运行环境、实际命令/Provider、结果和未覆盖范围。单元测试、SQLite 竞争、真实进程 e2e、Chromium 截图和真实 Provider 任务各自只证明对应范围；mock 或只读 smoke 不能替代真实交付。截图需结合人工查看，不能仅用整页宽度或自动化计数推导无裁切、无重叠或可访问性通过。

正式证据中的真实 ID、日志、截图和上游资料保持原始时点，不回填为当前状态。新一轮发布审计应创建新的正式记录，并在本页登记；旧记录不因新版本自动获得更宽证明范围。

## 历史过程资料的归并

重复的增量报告、方案批注和多轮复审正文已从工作树清理，仍适用的判断已写入固定入口：

| 历史资料组 | 归并位置 | 处理 |
| --- | --- | --- |
| 2026-06-08 需求塑形、审批摘要、Gate triage、repo profile、CI、证据导航、secret governance、Web 多运行和工作可用性增量 | [产品范围](../product/tekon-current-product-scope.md)、[运行时合同](../technical/tekon-runtime-contract.md)、[运行控制设计](../design/tekon-run-control-design.md)、[手册](../manual/tekon-user-manual.md) | 正文删除，当前边界保留；历史可由 Git 检索 |
| 2026-06-09–06-13 CLI/手册评审、标准交付 bootstrap、seed run、长程任务和 Web UI 过程记录 | [手册](../manual/tekon-user-manual.md)、[产品范围](../product/tekon-current-product-scope.md)、[运行时合同](../technical/tekon-runtime-contract.md) | 重复过程删除；真实 Codex/最终自举正式记录保留 |
| 2026-08-20–09-06 Harness/replatform、人类可用性、Runtime/产品多轮复审 | [产品范围](../product/tekon-current-product-scope.md)、[运行控制设计](../design/tekon-run-control-design.md)、[运行时合同](../technical/tekon-runtime-contract.md) | 多轮正文删除；R26/R27 正式验收和证据资产保留 |

完整旧目录仍可从[基线 86a3d48 的 docs 目录](https://github.com/zesming/tekon/tree/86a3d48/docs)和 Git 历史检索。技术方案的逐文件迁移对照见[运行时合同 §9.1](../technical/tekon-runtime-contract.md#91-历史方案迁移对照)。

## 维护边界

本页不保存新的过程日志或临时运行态。正式验收、发布决策或用户要求归档时，才在 `docs/reviews/` 增加记录和证据资产；日常实现结论先更新固定产品/设计/技术/手册入口，再由这里登记相应正式证据。
