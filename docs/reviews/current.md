# Tekon 当前权威产品与架构评审

[第二十六轮 HTML 人审版](2026-09-05-tekon-product-runtime-harness-twenty-sixth-review.html) · [Markdown 完整报告](2026-09-05-tekon-product-runtime-harness-twenty-sixth-review.md) · [PR #11](https://github.com/zesming/tekon/pull/11) · [本索引 HTML](current.html)

**日期：2026-09-05；版本：0.23.1。**

- 用户基线：`1e277464dbf9eeb9f97620421405d7a5913bc067`；Core #444 / CI #353 成功。
- 实际修复：`ed7e0bb0768c622357357d24eb20b726708cd66d`，原 PR 分支非强制快进。
- 代码检查：[Core #445](https://github.com/zesming/tekon/actions/runs/33967697106) / [CI #354](https://github.com/zesming/tekon/actions/runs/33967697121) 均 completed/success；新增 Core 7 项、Web 5 项回归实际执行。
- Core 单测 1343 passed / 1 项既有条件跳过、e2e 43 passed；Web 单测 572 passed。文档自身的最终 Head 与 Checks 由 PR 描述单独记录，不复用代码 Head 的绿色。

## 当前裁决

**R25 回执整改有效。本轮取消投递 P1 和终态提示 P2 已局部修复并通过集成回归；未再确认必须阻断本次增量的新问题。** 该结论不等于所有 Provider、操作系统、负载与完整持续协作已经验收。

## 本轮具体修复

**R26-01：**Run 已写为 cancelled 后，Session 查询或事件写入失败原先会阻止 Job 收到取消；重试又因 written=false 早返回。现在先按既有 JobRunner 协议向活动 Job 投递取消，再处理 Session 观察；已经 cancelled 仍可显式重试投递。passed/failed 的终态赢家不被推翻，正常重复调用不重复发送生命周期事件。

**R26-02：**取消接口返回 HTTP 成功但实际 Run 已 passed/failed 时，页面原先仍提示 cancelled。现在依据返回的真实终态反馈；cancelled 只表示已记录取消，不宣称全部后台进程退出。

本地源码定向复现分别为 4 失败/2 通过 → 6/6，以及 4 失败 → 4/4。Core 新测试使用真实 SQLite/JobRunner；Web 新测试调用实际组件处理函数、控制 Hook/RPC 端口。不将端口测试冒充真实浏览器或跨进程 Provider 验证。

## 不再重复报告的旧问题

R25 回执合并、目录恢复重试、scope/错误归属和异步导航已改进。RunPlan v3 有效命令绑定、同库原子/幂等受理、目录就绪屏障、共享提交控制器、Credential/Provider 分层及停用裸 clean 继续成立。

## 后续范围

先用一个真实 Provider 验证执行、取消、确认退出、关闭与重启恢复，再独立推进只读完整历史导出。此次先保证取消控制投递；观察错误仍可能返回、缺失事件不自动补齐，崩溃后的自动重试及完整进程树终止不在本补丁保证内。

已排除“后台 Gate 未注入 signal”的主路径误判：workflow-job-executor 在组合根统一向 gateway 注入 signal 与 registry。单一执行所有权是需求，daemon、ACP 或事件溯源是方案，不能按名称缺失一概判 P0。

DSH 官方发布观察为 `0.1.3-alpha.1`；Tekon pin 保持 `0.1.2-alpha.3`。Headless 仍为一次性任务，ACP 不等于 raw deltas、旧更新重放或完整 transcript replay/fork。

## 证据与维护

容器 DNS 不可用，未执行本地全仓 pnpm test；完整集成来自绑定 SHA 的远端检查。无独立 subagent、新应用截图/读屏、Windows、真实 DSH L2/L3 或负载演练。报告 HTML 只检查自身 320/1440 排版。

第二十六轮 Markdown 为内容源，HTML 同步呈现，旧报告保留历史。修复纳入未合并的 v0.23.1；不另发布、不改安装与协作规则。未合并、发布、部署、强推或修改仓库规则。
