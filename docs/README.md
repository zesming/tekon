# Tekon 文档入口

维护日期：2026-09-08 · 当前版本以根 `package.json` 为准

这里是 Tekon 文档的固定入口。当前行为、产品边界、交互规则和运行时不变式只在下表的现行文档中维护；正式验收与发布证据进入 `docs/reviews/`。过程计划、复审批注和旧方案不再作为第二套规范，历史需要时从 Git 检索。

## 先看哪一份

| 文档 | 适合回答的问题 | 权威范围 |
| --- | --- | --- |
| [产品范围](product/tekon-current-product-scope.md) · [HTML](product/tekon-current-product-scope.html) | Tekon 当前解决什么问题？哪些路径已开放？哪些动作仍由人控制？ | 当前用户价值、开放场景、未开放能力、发布口径 |
| [运行控制设计](design/tekon-run-control-design.md) · [HTML](design/tekon-run-control-design.html) | Web 页面如何发起、观察、暂停、取消、恢复和进入证据？ | 页面责任、反馈、错误、可访问性、视口与证据导航 |
| [运行时与 Harness 合同](technical/tekon-runtime-contract.md) · [HTML](technical/tekon-runtime-contract.html) | Run、Session、Job、Gate、Artifact、恢复和 Provider 的事实源与边界是什么？ | 持久状态、事务、owner fence、退出证据、代次恢复、Harness 接入 |
| [用户使用手册](manual/tekon-user-manual.md) · [HTML](manual/tekon-user-manual.html) | 用户怎样安装、发起、审阅、恢复和判断结果？ | CLI/Web 操作、参数、故障处理和限制 |
| [验收与发布证据](reviews/current.md) · [HTML](reviews/current.html) | 哪些行为有正式证据？证据覆盖到哪里？ | 当前验收索引、保留的正式记录和证据资产 |

## 当前边界

Tekon 是本地、单项目优先的 Agent workflow 工作台。标准交付会收集需求、角色产物、Gate、Audit、diff 和 PR 准备材料；push、创建 PR、合入、上线及权限扩大仍需人工控制。`Session` feed 是观察投影，不能代替领域记录、完整模型历史或持续协作接口。

角色 `tools.yaml`、`permissionProfile` 和 workflow helper 主要提供提示和顶层策略；它们不是 Provider 内部工具或 OS 沙箱。CommandGateway、工作树和 human gate 只覆盖 Tekon 管理且能观测到的动作，不能据编译或顶层调用测试宣称阻断 Agent 在 Provider 内部自行调用 `git`、`gh` 或其他外部工具。

## 维护规则

- 用户可见的路径、限制和判断口径先更新[产品范围](product/tekon-current-product-scope.md)或[用户手册](manual/tekon-user-manual.md)。
- 状态、事务、恢复、Provider 和安全边界先更新[运行时合同](technical/tekon-runtime-contract.md)；页面行为先更新[运行控制设计](design/tekon-run-control-design.md)。
- 正式发布或验收的命令结果、截图、真实 Provider 记录保留在 `docs/reviews/`，并从[验收索引](reviews/current.md)进入。测试通过不自动扩大产品声明。
- Markdown 主稿修改后同步 HTML 人审版；仅修改文档时检查差异、链接、章节、占位内容和 Markdown/HTML 一致性，不把文档检查写成运行验收。

## 历史资料与清理边界

以下旧入口的有效结论已归并，重复正文已从工作树移除：

| 旧资料 | 归并位置 |
| --- | --- |
| `technical/tekon-v2-technical-plan.*` | [运行时合同](technical/tekon-runtime-contract.md)与[产品范围](product/tekon-current-product-scope.md) |
| `technical/tekon-web-architecture.*` | [运行控制设计](design/tekon-run-control-design.md)与[运行时合同](technical/tekon-runtime-contract.md) |
| `technical/tekon-replatform-current-scope.*`、`technical/adr-0001-*` | [运行时合同的历史方案迁移对照](technical/tekon-runtime-contract.md#91-历史方案迁移对照) |
| `reviews/` 中的多轮过程报告 | 产品、设计、技术和手册的当前边界；正式验收文件与证据资产按[验收索引](reviews/current.md)保留 |

删除只针对重复的过程正文；旧报告、计划和批注可在[基线 86a3d48 的 docs 目录](https://github.com/zesming/tekon/tree/86a3d48/docs)及 Git 历史中检索。`design/tekon-cockpit-mockup.html` 保留为历史视觉输入，`research/2026-06-10-external-research-report.md` 保留为带日期的外部资料，不代表当前实现或验收结论。
