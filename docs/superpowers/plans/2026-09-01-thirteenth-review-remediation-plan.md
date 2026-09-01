# 第十三轮复审整改执行方案（2026-09-01）

> 依据：第十二轮复审报告第 17/18 节与第十三轮重新评审。
> 范围：PR #11 当前分支中可独立验证、低耦合的修复；single-owner Runtime、权威 Session log、ACP Collaborate、RunPlan authority 等架构主线继续拆分到后续 PR。

## 1. 用户侧 v0.20.4 整改

| 项 | 落地内容 | 裁决 |
| --- | --- | --- |
| DSH pin | `TESTED_DSH_VERSION` 升至官方 `0.1.2-alpha.3`，fixture、手册与版本提示同步 | Tekon 使用的 headless 兼容锚点通过；不能外推为整个上游仓库无变化 |
| 发布身份 | 根与 `@tekon/core`、`@tekon/cli`、`@tekon/web` 统一为 `0.20.4`，smoke 断言 lockstep | 数字版本身份关闭；发布 provenance/tag 自动化仍是独立治理项 |
| CLI fixture | 6 个 fixture 直接写 `package.json`，不再 spawn `npm init/pkg set` | CLI unit/e2e 的 unknown-config warning 已关闭 |
| 供应链 gate | CI 独立执行 `pnpm audit --prod` | 生产依赖 advisory gate 已建立；dev 依赖、SBOM/provenance 不在覆盖范围 |
| smoke 健壮性 | 扫描 `packages/` 时过滤不存在 `package.json` 的条目 | 关闭 |
| dirty-base 测试 | JSON 解析后改字段，不依赖文本格式 replace | 关闭 |

## 2. 第十三轮新增问题与修复

### 2.1 Session 详情右栏对 best-effort Event 的过度依赖

**问题**：`SessionDetailPage` 虽已从 `session.get` 获得 `runId/status/actionKind`，但右栏只消费 Event projection。Event 尚未到达或迁移期双写缺失时：

- 关联 run 可能没有控制入口；
- `awaiting-approval` 可能没有触发 `gate.list`，从而隐藏审批卡；
- `SessionSidePanel` 把未知状态默认成 `running`，可能短暂展示不合法的暂停/取消；
- 二次取消确认状态可能在组件切换 run 时残留。

**修复**：

- 新增 `mergeSessionSnapshotIntoSidePanel`，将 `session.get` 作为 run binding、生命周期和 attention 状态的安全回退；
- live Event 一旦存在仍优先，避免快照覆盖新状态；
- 未知状态保持 `unknown`，RunControls fail-closed；
- `gate.list` 成为“当前有哪些 pending decision”的权威来源，Event/Session 只决定何时读取；
- 审批后同时失效 `session.detail`、`session.list` 与 gate/project 查询；
- `RunControls` 以 `runId` 为 key，切换 run 时重置二次取消确认；
- 新增 10 个纯函数测试覆盖 7 种 Session→Run 状态映射、审批回退、live 优先和未知状态关闭。

这是一项迁移期 UI 安全修复，不改变“Session Event 仍非权威事实源”的架构裁决。

### 2.2 DSH L2 live probe 的假通过

**问题**：原 opt-in L2 测试遇到安装版本与 tested pin 不一致时，只验证生产 gate 会抛错，测试自身仍通过。这适合单元测试生产拒绝逻辑，却不符合“发布前 live probe”的含义。

**修复**：L2 现在要求 `dsh --version` 精确等于 `TESTED_DSH_VERSION`；版本漂移直接让 live probe 失败。同时把证据层级写清：

- L1：源码交叉核对 fixture；
- L2：真实二进制 `--version/--help/--dump-default-config`，不需要 API key；
- L3：带凭据的一次真实 provider invocation，仍未完成。

### 2.3 Audit gate 与功能诊断解耦

**问题**：audit 虽已拆为独立 job，但 `cli`/`web` 同时 `needs: audit`。registry 故障或新 advisory 会让所有功能测试被跳过，无法同时看到应用回归证据。

**修复**：

- audit 保持独立顶级 job，失败仍使整个 workflow 失败；
- `cli`/`web` 只依赖 root build/typecheck，因此 audit 失败不会压掉功能测试；
- audit 安装使用 `--ignore-scripts`，避免在只读供应链检查中执行依赖 lifecycle script；
- 增加 5 分钟超时；
- CI job 名从不准确的 `Root typecheck + lint` 改为 `Root build + typecheck`。当前仓库没有真实 JS/TS static linter，不再用名称制造已覆盖假象。

## 3. 自动化验收

Reviewer 代码快照：`6917c06369d5cb0da5b681fc61d2bb25d600572d`。

- Core #362：`completed/success`；
- CI #271：`completed/success`；
- Root build + typecheck：成功；
- Production dependency audit：成功；
- CLI build/unit/e2e：成功；
- Web build/typecheck/unit：成功；
- Web unit：36 文件、358 测试通过，其中新 snapshot fallback 测试 10 项通过；
- Chromium Playwright：成功。

L2 DSH 测试在未配置 `DSH_CLI_PATH` 的普通 CI 中按设计跳过，因此上述绿色 CI 不能代替真实二进制或 API provider smoke。

## 4. 明确不在本 PR 继续扩张的项

| 项 | 原因 |
| --- | --- |
| repo single-owner daemon/lock | 跨 CLI/Web composition root、进程生命周期、Git/DB/Provider 资源所有权，需要独立架构 PR |
| executor process/worker 隔离与 restart recovery | 必须设计 kill/join、checkpoint、generation fencing 和故障注入 |
| authoritative Session log / durable inbox | 需要事实源与迁移决策，不应继续在 best-effort dual-write 上叠补丁 |
| ACP Collaborate vertical slice | 需要真实 provider 子进程、persistent session、prompt/cancel/close/resume 的完整纵向验证 |
| RunPlan execute/resume authority | 需统一绑定 Demand、mode、base/workspace、Provider、权限、网络、Artifacts 与 executable plan |
| complete-history export / model compaction | 需服务端流式导出、flush/snapshot、retention 和 token budget 共同设计 |
| 全站 a11y 与多浏览器 | 当前仅 Chromium 自动化和局部 dialog 证据，需专项验收 |
| branch protection/ruleset | 需要仓库 Owner 在 GitHub Settings 配置 |
| ESLint/Biome、全仓 format | 属独立代码卫生 PR，避免在超大 PR 中继续扩大面 |

## 5. 文档裁决

- 第十三轮另建新报告，不再向第十二轮继续追加 revision；
- `docs/reviews/current.md` 改指向第十三轮；
- 第十二轮及之前报告转为只读历史；
- `CHANGELOG.md` v0.20.4 中“整个 headless 合同零差异”与 `needs: [typecheck, audit]` 描述代表整改时点，不作为最终权威状态；当前事实以第十三轮报告、workflow 和代码为准。

## 6. 合并边界

代码快照已通过现有自动化，但 `main` 尚未配置 branch protection/required checks。合并前仍需人工确认 PR Head 与成功 CI 绑定；建议 squash merge。未执行 merge、release、deploy 或仓库 ruleset 修改。
