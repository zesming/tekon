# 第十五轮复审整改执行方案（2026-09-02）

> 依据：`docs/reviews/2026-09-02-tekon-product-runtime-harness-fifteenth-review.md`。
> 范围：PR #11 内可安全落地的 DSH Host Node/version/preflight 语义修复、Web 健康状态一致性和权威文档；架构主线继续拆独立 PR。

## 1. 用户本轮已完成且通过复核的调整

| 项 | 落地内容 | 裁决 |
| --- | --- | --- |
| Host Node 启动前检查 | `runDshPreflight` 在执行 `dsh` 前检查宿主 Node | 方向正确；原范围实现不等价于稳定 semver，本轮已修复 |
| 独立错误类型 | `DshHostNodeError` 区分宿主问题与 dsh 未安装 | 通过 |
| CLI 文本/JSON 信息 | 输出 Host Node、要求和 failure kind | 通过；旁路与兼容语义已进一步分离 |
| CLI/Web 实际运行接线 | 两条启动路径在 Provider 执行前做 preflight | 通过 |
| 精确 Host 逃生口 | `TEKON_DSH_ALLOW_HOST_NODE=<实际版本>` | 保留；只表示风险确认，不表示合同兼容 |
| 自动化 | Core、CLI、Web 覆盖 Host Node 路径 | 通过；本轮增加 prerelease、public-seam、health-contract 和 bypass 语义覆盖 |

## 2. 本轮发现并修复的问题

### 2.1 P2-DSH-01：Host Node 解析不等价于 semver

原实现只提取 major/minor，可能把 prerelease 或带垃圾后缀的值当成兼容版本。

已修复：

- 只接受完整稳定 `major.minor.patch`；
- 可接受 build metadata；
- prerelease、partial、malformed 一律 fail-closed；
- 逃生口不能放行 prerelease/malformed；
- 增加表驱动测试。

### 2.2 P2-DSH-02：Host 旁路会抹掉真实不兼容状态

原结果在 exact acknowledgement 命中后把 `hostNodeCompatible` 写成 true。

已修复：

```text
hostNodeCompatible = 实际是否满足范围
hostNodeBypassed = 是否通过精确风险确认放行
```

### 2.3 P2-DSH-03：版本逃生口被显示成正式兼容

`TEKON_DSH_ALLOW_VERSION` / `--allow-version` 允许未测试版本继续运行，但不代表 Tekon 对其提供合同保证。

已修复：

- Core 增加 `versionCompatible` / `versionBypassed`；
- CLI 文本显示“已验证 / 已旁路 / 不兼容”；
- 任意旁路存在时，结论为“已旁路（无合同保证）”；
- JSON 保留 admission `compatible`，新增字段为兼容性权威；
- stderr 输出风险警告。

### 2.4 P2-CLI-01：公开参数泄漏测试注入

原 CLI 允许：

```text
--host-node-version 24.0.0
```

这可以让当前 Node 20 进程对虚构的 Node 24 做检查并返回成功。

已修复：

- 删除公开参数；
- 程序化函数仍保留 `hostNodeVersion`，仅用于确定性测试/嵌入；
- CLI unit 和真实子进程 e2e 断言该参数被拒绝。

### 2.5 P2-UX-01：Web health 与真实 run admission 不同源

原 health 只检查：

```text
Host Node + dsh --version 退出 0
```

实际运行还要求 exact pin、help anchor 和 required config row。

已修复：

- health 直接调用完整 Core preflight；
- metadata probe 使用 1 秒预算；
- actual run 保留 5 秒默认预算；
- alpha.4 在 alpha.3 tested pin 下显示 unavailable；
- help/config 漂移显示 unavailable；
- RPC schema 保持不变；
- 顶栏提示运行 `tekon provider preflight dsh-headless` 查看详情。

### 2.6 P2-DOC-01：外部版本事实变化

DeepSeek Harness 当前 latest/master 已为：

```text
0.1.2-alpha.4
4e84901e6471b79ec0338099867ebb4606d12bb5
```

Tekon 继续测试锁定 alpha.3。第十五轮报告与 `current.md` 作为当前权威入口区分 tested pin 与 upstream latest。

## 3. 实际验收结果

reviewer 代码快照：`ebd040e44f66e26c69af449584eb29a699d52726`。

| Gate | 结果 |
| --- | --- |
| Core #392 | `completed/success`，首次执行 |
| Core unit | 84 文件；1061 passed；3 skipped；0 failed |
| Core e2e | 8 文件；26 passed |
| CI #301 | `completed/success`，首次执行 |
| Root build + typecheck | success |
| Production dependency audit | success |
| CLI unit | 9 文件；64 passed |
| CLI e2e | 3 文件；8 passed |
| Web build/typecheck/unit | success |
| Chromium Playwright | success |

3 个 Core skipped 仍是普通 CI 未设置 `DSH_CLI_PATH` 时按预期跳过的真实 DSH L2 metadata probe。当前绿色自动化不等于完成真实 dsh binary 或带 API key 的 L3 Provider smoke。

## 4. 明确不在本轮关闭的项目

| 项 | 原因 |
| --- | --- |
| repo 级 single-owner Runtime | 需 daemon/lock、迁移窗口和客户端化 |
| executor 隔离、真实 kill/join、restart recovery | 需 process/worker ownership、checkpoint 与故障注入 |
| authoritative Session / transactional outbox / durable inbox | 需先决定事实源与迁移策略 |
| Collaborate streaming/follow-up/cancel/resume | 应以 ACP 或等价 persistent Provider vertical slice 验证 |
| RunPlan execute/resume authority | 需绑定 Demand、mode、base/workspace、Provider、权限、网络和 Artifacts |
| complete-history export / model compaction / retention | 独立产品、数据和资源链路 |
| DSH alpha.4 tested pin | 需先完成 L1/L2/L3 和默认 `web_fetch` 风险复核 |
| Provider exception snapshot/Audit | 环境变量旁路需迁移为可审计配置事实 |
| branch protection / required checks | 需仓库 Owner 配置 ruleset |
| Firefox/WebKit、screen reader、缩放、对比度 | 独立 a11y/兼容性专项 |
| static linter、format debt、SBOM/provenance | 独立工程治理 PR |
| CommandGateway timeout state machine 拆分 | 独立可测试重构，不与 DSH 合同修复混合 |

## 5. 下一阶段建议顺序

1. GitHub ruleset / required Core + CI；
2. single-owner daemon + repo lock；
3. executor process isolation + quiescent restart contract；
4. authoritative Session / outbox / durable inbox；
5. DeepSeek ACP vertical slice；
6. Collaborate → Deliver；
7. RunPlan execute/resume authority；
8. complete-history export + model compaction/retention；
9. alpha.4 L1/L2/L3 + Provider exception Audit；
10. a11y、lint/format、SBOM/provenance 和 release engineering。

## 6. 版本号与合并建议

本轮改变 DSH preflight 的边界语义和 Web health 真实性，但仍属于尚未发布的 v0.20.4 收敛，不单独 bump。

PR #11 已超过百个提交和约 180 个文件，建议最终 squash merge。合并前必须确认最终 PR Head 的 Core 与 CI 都为 `completed/success`。本方案不执行 merge、release、deploy 或 ruleset 修改。

## 7. 冻结项独立 job 拆分（2026-09-02 用户决策）

用户决策：剩余冻结项拆为独立 GitHub issue（job）跟踪，按 §13 顺序推进；`main` 分支保护暂缓。Tracking issue：#27。

| 报告 ID | Issue | §13 顺序 | 备注 |
| --- | --- | --- | --- |
| P0-ARCH-01 | #16 | 2 | single-owner daemon + repo lock |
| P0-ARCH-02 | #15 | 3 | executor 隔离 + restart contract，依赖 #16 |
| P0-DATA-01 | #13 | 4 | authoritative Session / outbox + inbox，依赖 #15 |
| P0-PRODUCT-01a | #14 | 5 | DeepSeek ACP vertical slice，与 #17 协同 |
| P0-PRODUCT-01b | #19 | 6 | Collaborate → Deliver，依赖 #14 |
| P1-PLAN-01 | #20 | 7 | canonical RunPlan authority |
| P1-SESSION-01 | #18 | 8 | 历史导出 + 上下文预算，依赖 #13 |
| P1-DSH-01 | #17 | 9 | alpha.4 验证，阻塞（需 dsh 环境/key） |
| P1-DSH-02 | #22 | 9 | 逃生口审计 |
| P1-A11Y-01 | #21 | 10 | 全站 a11y 验收 |
| P1-GOV-01 | #24 | 1 | 暂缓（用户决策，人工 GitHub 配置） |
| P1-PROCESS-01 | #23 | 贯穿 | PR 体量治理 |
| P2-CODE-01 | #26 | — | lint gate + format debt |
| P2-CODE-02 | #25 | — | command-gateway 拆分 |

每个 job 独立 PR，测试先行，reviewer 循环评审至放行；架构方向变更回到 #27 讨论。
