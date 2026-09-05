# 第二十四轮整改方案：冻结有效检查与补齐观察链路

日期：2026-09-05。基线：`0a6edc95363965daad081ab23ddf254ce2feaa65`，对应 [PR #11](https://github.com/zesming/tekon/pull/11) 与 [第 24 轮报告](../../reviews/2026-09-05-tekon-product-runtime-harness-twenty-fourth-review.html)。拟提交版本：`0.23.0`；除修复执行/观察缺陷，还新增逐检查绑定预览、配置差异说明和历史绑定状态可见性，按本轮最高级别 MINOR 计。不新增 CLI 命令或改变目录结构；RunPlan 内部格式版本与产品版本分开管理。

状态：方案两轮技术复查及编辑性审阅通过后已实施；Core、服务端、CLI、前端业务与测试的最高等级独立审阅均已放行，前端目录细分状态遗漏经修复后复查关闭。最终本地验收为 178 文件、1989 项通过（1 项既有可选跳过），Chromium 全套 99/99，通过全包 build/typecheck 与生产依赖漏洞审计。完成度复核和最终 Head 交付结果见第 24 轮报告 §11；不另建平行验收报告。

## 1. 目标、事实与裁决

| 事项 | 整改前事实 | 本轮验收目标 |
| --- | --- | --- |
| R24-01 查询中失效 | 已推送的 invalidated 位修复在两文件 20 项定向测试中通过，真实 hook 接线与源码合同一致 | 保留补丁，补真实 React＋SSE 的迟到成功、迟到错误、突发失效与重新挂载证据 |
| R24-02 有效命令未绑定 | 同一 v2 摘要下，受理后将 npm 参数改为另一脚本，真实 Gate 从 passed 变为 exit-code failed；改成不适用则变为 skipped | 用户确认到受理，以及受理到执行、恢复、repair/rework，使用同一份有效命令和适用性事实 |
| R24-03 恢复命名 | “创建失败需恢复”与“请求已受理”混用 | pending 与 recovery_required 均明确已受理；unknown 仍是待确认 |
| 新发现：Workspace 重连 | 首次 SSE catch-up 只设签名基线，客户端进入 live 不重查 | 首次连接、断线重连都能追上服务端最新列表，不依赖下一次变更或手动刷新 |
| 新发现：审批观察 | 审批 SSE 只失效 Session 列表，不失效 Gate 查询 | 另一入口审批或新增审批后，详情中的 Gate 卡片自动反映当前决定 |
| 历史与后续边界 | 已有 Job claim、owner 条件写、heartbeat、取消/关停防护；仍非全域副作用排他 | 不重写执行内核，不把领域 cancelled 误说成所有进程已退出；保留真实 Provider/平台后续验收边界 |

本轮选择**冻结执行事实**，不选择执行到一半才按新 profile 重确认。后者还需要重新判断既有 passed/skipped 结果、计划身份和人工批准的有效性，不能只加漂移提示。新计划执行时不再回读 profile，所以不会因当前配置变化而替换已确认命令。

## 2. RunPlan v3 的数据合同

### 2.1 只捕获实际消费的命令引用

保留完整规范模板，新增 `repoCommands`，内部 `digestVersion` 升为 3。每项为固定引用名、解析来源和一种结果：

```ts
type RepoCommandSource = {
  kind: 'repo-profile' | 'package-json-detection' | 'empty-default';
  resolverVersion: 1;
  profileVersion?: number;
  path?: '.tekon/repo-profile.yaml' | 'package.json';
};

type BoundRepoCommand = {
  commandRef: RepoProfileCommandName;
  source: RepoCommandSource;
} & (
  | { status: 'resolved'; command: { tool: string; args: string[] } }
  | { status: 'not-applicable'; reason: string }
  | { status: 'missing' }
);
```

绑定集合严格等于模板中 `commandRef && !command` 的去重集合，按引用名稳定排序。缺项、多项、重复项、未知引用、非法来源/结果或多余执行字段均拒绝。`missing` 也是必须持久化的决定，避免原本缺失的命令在后续被补入并悄悄执行。

无消费引用时，使用空数组且不读取 profile 或 package.json。内联 `command` 优先，已有 `env/match` 仍由完整模板绑定；不要给 RepoProfile 发明不支持的 env 字段。description、未使用命令、PR/risk 配置和无关 scripts 不进入绑定摘要。

`source` 中的 profileVersion 是配置声明版本，不冒充整个文件的内容版本；有效字段、来源及解析器版本共同进入计划摘要。只记录固定相对来源，不记录绝对路径、用户名或环境秘密。读取与来源必须来自同一次捕获，不能解析文件后又重读另一份内容计算来源。

### 2.2 捕获入口与纯函数边界

新增有文件读取含义的 `captureRepoCommands(repoPath, template)` 和 `captureRunPlan(repoPath, template, context)`；保留纯 `projectRunPlanV3(template, context, repoCommands)`、`validateRunPlanV3` 及纯 `buildPreparedRun`。

新受理链路为：

```text
Web 预览捕获 v3 → 用户确认摘要
  → 新请求再次捕获并比较摘要
  → Provider factory/preflight
  → Engine 新受理分支同步捕获 → 纯 buildPreparedRun 逐份校验
  → 同一 v3 生成快照和执行节点 → 原 SQLite admission 事务
```

CLI 没有普通 Workflow 交互预览，不宣称用户看过每项命令；其合同是“启动请求时捕获并受理”。CLI/Web/直接 Core 使用同一捕获与规范化逻辑。

Engine 构造时不得提前读取或缓存 profile。已受理重放必须仍在环境检查之前；v3 恢复只读持久快照，当前 profile 损坏/删除不能使构造失败。实际捕获放在 `buildAdmissionData` 的新受理同步区间：确定模板，捕获绑定，传入纯 helper，再生成持久描述符。helper 自身不接触文件系统。

输入/选项的每一份 canonicalPlan、snapshot、digest 均与本次实际 v3 重新比较。预览之后、Provider await 期间发生变化，必须在数据库/目录副作用前拒绝。捕获完成后的排队不再重读配置，不能把同一受理拆成多个事实时点。

非法 YAML、非法 package.json 或无法读取所需配置，返回固定、脱敏的计划配置错误及修正指引；不能把原始解析错误/字段值送到浏览器。配置无法读取与旧摘要过期应可区分，前者不能只让用户无限刷新。

### 2.3 将绑定物化进执行 Gate

新增 `runPlanToExecutionPlan(plan, runId)`。v3 先以原模板生成稳定 gateKey，然后物化绑定；v2 使用冻结的旧算法。

| 输入事实 | v3 执行 Gate |
| --- | --- |
| 内联 command | 完整保留 command；移除无效 commandRef |
| ref resolved | 写入被冻结的 tool/args，移除 commandRef |
| ref not-applicable | 沿用现有 skipReason 文本生成规则，移除 commandRef |
| ref missing | 保持无 command，移除 commandRef；无有效 skipReason 的普通命令 Gate 才按原规则失败 |
| security-scan 的 missing/not-applicable | 移除 commandRef，但不产生跳过；继续内置安全扫描 |

不改变现有 Gate 类型对 skipReason 的支持：只有 build/test/lint/e2e-pass 接受此跳过，security-scan 不接受。原模板与绑定仍保留 ref/来源，执行节点没有可回退动态 profile 的入口。不要改 gateKey 的身份，也不要新增第二套 GateConfig 状态机。

模板本来允许 skipReason 与 command/commandRef 共存，必须保留其优先级：inline、ref resolved、ref missing 不删除原 skipReason；ref not-applicable 按当前解析规则覆盖跳过理由；security 始终忽略跳过并保留内置扫描。由物化后的 Gate 及现有执行规则导出“将执行/将跳过/缺命令失败/仍执行内置扫描”的说明，不得仅凭解析 status 推断实际行为。非命令 Gate 不能被描述成会执行外部命令。

受理写入物化节点；执行与恢复从同一快照重建期望节点，保留原始 SQL 字段比较与 Audit 授权检查。重新塞入 commandRef、修改 command/skipReason、缺损 v3 绑定均须拒绝，且在 Gate/skip 结果写入之前失败。完整性错误不能交给自动修复 Agent“修复”。

rework、嵌套 rework 复制物化 Gate；repair 节点不带 Gate，修复后重试原物化 Gate。取消、失主和关停仍沿用现有条件写及检查边界，绑定逻辑不得创建新的终态写入旁路。

## 3. 兼容、观察与用户确认

### 3.1 不重写历史

新受理只生成/接收 v3。冻结 `projectRunPlanV2` 和 `validateRunPlanV2`，不能让旧验证函数改调用 v3 投影。已受理 v2 requestId 重放保留原身份；尚未受理的 v2 预览需刷新后确认 v3。

v2、真实旧 v1、无快照历史沿用原恢复算法，不自动升级：过去确认时的有效命令无法由当前 profile 还原。有 admission 的缺损快照不得降级历史；未知显式版本执行时拒绝。

Core 提供纯 `classifyExecutionBinding`，根据持久 snapshot/digest/kind 与 admission 是否存在分类，不读取 profile、不写库：

- 自洽 v3：`frozen`。
- 自洽 v2，或符合既有历史条件的 v1/无快照：`legacy-unbound`。
- JSON/摘要/版本字段损坏、v3 绑定缺损、单边字段缺失、admission 缺计划或退回 v1：`invalid`。
- 未知显式版本或客户端未收到字段：`unknown`；不能显示为已冻结或自动放行执行。

“frozen”仅说明快照已绑定仓库检查，不替代节点/Audit 完整性校验，也不是整个执行环境的安全认证。

“不得降级”指当前字段能识别的缺损或版本错误；本轮自洽性校验不防御持有全库写权限者同时改写版本、摘要、节点及历史记录，也不为此新增持久密钥或迁移平台。

在 Workflow/Review/Session RPC output 增加可选 `executionBinding`；Web mapper 统一调用 Core 分类，CLI status 复用同函数。Run/Session 详情显示短提示；未关联 Run 的 Session 不显示。历史提示为“历史计划未记录仓库命令绑定；使用 commandRef 时会按当前配置解析”，避免误称 v2 内联命令也未绑定。CLI 保留 key=value 合同，追加机器字段；必要中文说明写 stderr。

### 3.2 脱敏检查预览与变化说明

逐 Gate 脱敏预览增加可选 `gateIndex` 与 `commandBinding`：解析 status（inline/resolved/not-applicable/missing）、source 枚举、commandRef、实际执行行为说明和 fingerprint。实际行为与指纹均从物化后的有效调用/适用性事实及来源导出；修改仍然有效的模板 skipReason 必须定位到对应检查。若原理由已被 ref N/A 覆盖，修改原理由只改变总摘要，不改变该项有效事实指纹。不得返回 tool、args、env、不适用原始 reason 或原始配置，不接受客户端指纹作为授权输入。

公开逐检查指纹不得直接使用无密钥 SHA-256，以免提供低熵隐藏字段的逐项离线猜测入口。Web 组合根每次启动生成随机 32 字节私有 HMAC key 和独立随机 `comparisonScope`，仅保存在进程内。指纹使用 HMAC-SHA-256，包含用途域、Gate 位置及规范化后的私有检查事实；只把不透明结果和非秘密的 comparisonScope 返回客户端，不提供任意消息签名入口。持久 RunPlan 的 SHA-256 摘要与授权校验保持原语义，不包含临时 HMAC key、comparisonScope 或这些显示指纹。

实现接口固定为：`commandBinding.behavior` 使用 execute-command / skip / missing-command / builtin-security / builtin-security-and-command / not-command-gate 枚举；客户端按这个实际行为显示，不自行重建 Gate 优先级。`projectRunPlanPreview(plan, signer?)` 的可选 signer 包含 comparisonScope 和私有事实签名回调，由 Web 根注入；未提供 signer 时省略 fingerprint 与 comparisonScope。RPC 对新字段保持可选兼容，比较仅在相同 scope 且各项指纹存在时成立。签名只发生在白名单投影时，任何临时显示字段都不加入 canonical RunPlan。

HMAC 签名属于 Web 白名单投影阶段；Core 捕获、纯准备及持久投影不能依赖 Web 进程密钥。相同服务实例/仓库与入口认证上下文内可比较；服务重启或切换到另一服务实例会改变 comparisonScope，客户端清除旧比较基线。repo-profile 改为 package.json 自动检测属于可比较的检查配置变化，不轮换 scope。凭据、仓库、模板等上下文改变时，即使 comparisonScope 未变也必须隔离基线；旧响应缺少 scope/指纹时只显示“暂无逐项变化信息”，不能说检查未变。

两个发起入口复用小型 `PlanCommandBindings`，提供简短汇总和可展开详情，不重建大表单。缺命令/不适用须可识别；security 的 missing/N/A 必须显示“仍执行内置安全扫描”，不能说跳过或必然失败。

刷新时在同一入口上下文内保留上一份脱敏预览，以 nodeId/gateIndex 配对比较 fingerprint；tool/args 隐形变化也能指出对应检查。增加/移除检查可按位置显示。若摘要变化而无 Gate 差异，提示模板或运行设置变化；无旧预览不伪造差异。比较基线由持续挂载的入口 hook/父组件持有，不能放在 loading 时会卸载的展示组件；上下文改变时按当前 key 同步隐藏旧差异，不能仅等 passive effect 清空。刷新后仍需再次显式提交，不自动接受新计划。

### 3.3 统一受理状态文案，不改机器枚举

| 持久/查询状态 | 用户用语 |
| --- | --- |
| pending | 已受理，等待目录就绪 |
| recovery_required | 已受理，等待目录恢复；任务尚未执行 |
| unknown/查询错误/无权威快照 | 受理状态待确认；保留原 requestId 查询或重试 |
| not-found | 当前未查到记录，不代表另一在途请求不会受理 |

复用 AdmissionNotice 的共享标签映射覆盖两表单、Session/Run 列表与详情，CLI 同步中文状态。保留机器枚举和错误码、accepted 单调性、原身份重试与 sessionStorage 白名单。不得因为统一前缀，把缺少持久身份的错误改成已受理。

查询失败不能撤销既有受理事实：已有 accepted 记录继续保留身份和受理标签，另提示当前快照不可用，并按原规则限制执行控制；表中的待确认用语只适用于尚无权威受理事实的情形。

## 4. SSE 观察一致性与补证

保留 QueryCache 已实现的 invalidated 位和请求发布权，不更换查询库，也不新增事件总线。

- Workspace stream 每次进入 live（包括第一次连接和重连）失效当前列表，弥合初始读取/订阅窗口及断线期间变化；事件到达继续失效。需要依靠当前 Cache 去重，不并发叠加抓取。
- Session 的审批事件使相应 Gate 查询失效，同时保留列表失效。runId 可确定时采用准确 key；不可确定时使用既有 Gate key 前缀，不从未验证事件数据推断授权。
- 关闭订阅、切换凭据或 Session 后，旧回调不能恢复旧结果；`loadEarlier` 的迟到历史页同样检查订阅 owner，不能合入新 Session。新失效可以触发当前读取，但不能重用旧凭据的请求结果。

新增真实页面＋SQLite＋SSE 浏览器旅程：读取在途时后台变更后释放旧成功/500；多次失效合并；离开/重挂后最终读到新事实；关闭真实流、断线期间更新、重连后无后续事件仍追上；另一入口决定/新增审批且 hasPendingApproval 始终为 true 时卡片更新。断线必须有可控的真实连接关闭证据，不仅模拟一个状态字符串或直接调用 cache.fetch。

## 5. 实施所有权与审阅顺序

1. 本方案由最高等级独立 reviewer 循环审阅；必须项修复后复查，通过后才实施。
2. Core owner：捕获/投影/版本分类/执行图与 Engine 接线；先写纯函数、真实 SQLite 与 Gate 反向测试。保持接口合同后冻结给组合根使用。
3. 前端 owner：观察链路、共享预览差异与恢复提示；先补确定性状态/真实浏览器红测。只修改分配的 client 和测试文件，不碰 Core/server/CLI。
4. 主代理：Web/CLI 捕获入口、RPC/mappers、文档/版本整合；负责唯一 build、全量 Vitest、Playwright 运行。其他 owner 只跑独立定向 lane，运行前报告范围。
5. 代码与测试由未实施对应改动的最高等级 reviewer 循环复查；测试不能只验证 mock，也不能因过时期望改成宽松断言。
6. 完成全套和新 UI 目视后，再做报告逐项完成度复查；本轮新发现的观察缺口必须有关闭证据，不以已有缓存测试代替。

## 6. 必须验证的矩阵

| 层面 | 验收 |
| --- | --- |
| 捕获/摘要 | tool、args、N/A reason/status、missing、来源/解析版本变化均可见；未用 entry/description/PR/risks/无关 scripts 不影响；无 ref 和 inline 优先不访问坏 profile |
| 自动检测 | 单次 package.json 读取产生对应 npm/pnpm 调用与来源；相关 script 存在性/runner 变化可见；不递归冻结 script 正文 |
| 确认→受理 | 预览后、provider await 期间变化拒绝且零新受理；每份输入/选项 snapshot/digest/bindings 都核验，首个 await 外部 mutation 不影响已捕获事实 |
| 受理→执行/恢复 | 工具/参数变更，命令↔N/A，missing 后补命令，profile 删除/损坏，新 Engine 恢复均保持冻结事实；同 requestId 重放不重捕获 |
| Gate/派生 | 普通 N/A 跳过与无 skipReason 时 missing 失败；inline/resolved-ref/missing-ref 各与模板 skipReason 共存的优先级；security＋skipReason 不跳过；repair/返工/嵌套返工保持原命令；稳定 Gate key 与已过结果不漂移 |
| 完整性/历史 | bindings 缺/多/重复/非法、持久 command/skipReason/ref 篡改拒绝；固定 v2、真实 v1、合法无快照恢复；缺损新计划不得降级；观察分类不把无效计划显示已冻结 |
| API/CLI | 真实 HTTP 预览/提交/查询/恢复；完整 CLI 真进程使用冻结计划与状态字段；公开/认证预览均无秘密，配置错误指引脱敏；同 comparisonScope 指纹稳定、有效事实改变可见、不能以公开无密钥 hash 复算，换实例/scope 清空比较基线；模板别名保持 |
| 观察 | 缓存真实 hook＋SSE 成功/错误/突发/重新挂载；Workspace 初连/重连追平；跨入口审批卡片更新；认证与旧响应隔离不回归 |
| UI | 两入口绑定汇总/差异/刷新确认、legacy/invalid/unknown 提示、恢复状态、TopBar 与 Session/Run 详情，320/390/700/1440px 稳定截图；控件/文案不挤压、越界、遮挡且键盘可达 |
| 全量 | `pnpm test --run`、全包 build/typecheck、CLI e2e、Web Playwright 全套、生产依赖漏洞审计；原有取消、失主、关停、恢复测试不能回归 |

已存在的 Job 所有权与取消防护不能被绑定改动绕过；本轮不新建跨进程 owner/daemon，也不把取消受理或数据库终态写入当作进程已静止的证据。真正 Provider 的停止、重启、多轮会话与平台验证仍另行记录，不能凭 mock 或上游资料宣称完成。

## 7. 文档、交付与明确边界

同步 README、CHANGELOG、主用户手册 MD/HTML、当前评审入口及本方案/报告 HTML；保留手册既有版式和中英切换。AGENTS/安装脚本没有规则或流程变化则不改，并说明理由；如实际改安装/更新脚本，按仓库规则执行干净环境全流程 smoketest。

报告保留原 §1–9 时点，在后续章节追加独立批注、命令、Run/Gate 证据、复查与完整验收结果。正式截图及需要保留的证据进入可提交目录；测试临时目录、浏览器 trace/拼图清理前核对归属，不删除历史运行数据。

提交前全仓测试必须通过，四包版本与根一致，中文提交说明包含 `v0.23.0`；非强制推送原 PR 分支并监控最终 Head Core/CI。不得合入、发布、部署或修改仓库规则。

本轮关闭的是 Tekon 解析出的检查调用与适用性决定，不是 package scripts、测试代码、PATH 二进制、依赖、Git/base、Provider 或宿主环境全部不可变。ACP、完整历史导出、全域事件事实、真实多轮 Provider 生命周期及所有外部副作用排他仍是原报告后续方向，不能用本轮通过替代这些能力的验收。

## 8. 资料与判断依据

- [SQLite 原子提交](https://www.sqlite.org/atomiccommit.html)：数据库受理事务已成立；据此保留事务边界，不把执行命令放进事务。
- [React Effect 响应乱序](https://react.dev/reference/react/useEffect)：旧请求不得发布；具体失效与重连正确性仍需本项目真实链路测试。
- [RFC 2104：HMAC](https://www.rfc-editor.org/rfc/rfc2104)：定义带密钥的散列机制；据此使用服务端临时密钥生成不透明比较标识，避免公开逐项无密钥摘要，不将其用作新的授权凭据。
- [固定 DSH ACP 合同](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/acp/acp/README.md)：提供持久会话及 committed semantic updates，不提供 raw deltas/旧更新重放；据此不把上游能力冒充 Tekon 已实现。
- [固定 DSH Safety](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md)：实验性且未经安全审计；tested pin 不是隔离认证。本次上游 fetch 后仍为该 SHA，Tekon pin 保持 `0.1.2-alpha.3`。
- Tekon 具体源码、独立复核与安全 npm 脚本复现记录见第 24 轮报告接续批注；不把此前 source-only 判断写成生产事故。
