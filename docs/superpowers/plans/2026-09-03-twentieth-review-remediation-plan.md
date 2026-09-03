# 第二十轮复审整改执行方案（2026-09-03）

> **依据**：`docs/reviews/2026-09-03-tekon-product-runtime-harness-twentieth-review.md`
>
> **基线快照**：Commit `6fd86ee` / Core #419 / CI #328
>
> **整改前自动化基线**：144 个测试文件 / 1541 passed / 3 skipped（Core e2e 26 passed、CLI e2e 8 passed、Web Playwright 42 passed；最终数字在整改后按实跑更新）
>
> **目标版本**：`0.20.6`（四包同步 lockstep）
>
> **所属分支**：`review/human-first-harness-2026-08-28`
>
> **范围控制与治理例外**：PR #11 原则上不承载跨 PR 架构演进。本轮对 reviewer 检出的 DSH metadata probe 直接环境缺陷执行一次窄范围治理例外收口；其余中长期问题继续保持独立 issue 推进。

---

## 1. 执行摘要、根因分析与收口目标

### 1.1 背景与现状

在第十九轮收口与第二十轮全面复审中，Tekon 验证了 Advanced Run 的纯状态准入选择器、默认与高级入口的同步单飞锁（`useRef` latch）、草案 plan approval 门、移动端单列布局以及 DSH 正式 Run 的 telemetry hard opt-out。Reviewer 随后在 commit `b2bfa45` 中对 metadata probe 实施了最小环境变量白名单并实现了 config/help 顺序执行。

然而，二十轮深度安全审计与架构复核表明，当前实现仍存在以下 5 项具体缺陷与根因：

1. **DSH Preflight 宿主环境依赖与自动 fallback 隐式读取风险**：
   - _根因精确界定_：上游 `dsh@0.1.2-rc.1` 的源码实现表明，DSH 在启动加载环境时仅精确读取 `<invocation cwd>/.env` 与 `$DSH_HOME/.env`，并不向上递归遍历父级目录树；同时 `credentials-local` 插件会读取 `$DSH_HOME/.credentials.yaml`。此外，`--version` 与 `--dump-default-config` 属于 boot-free 命令，并不调用 `loadLayeredEnv`；只有 `--profile headless --help` 在启动 profile 与插件阶段会加载分层环境。前轮修复虽然移除了敏感环境变量，但探测进程仍直接在宿主调用方的 cwd 中执行，并透传了宿主 `DSH_HOME` 与 `DSH_AGENTS_HOME`。这导致当宿主调用方 cwd 存在 `.env` 或宿主 `DSH_HOME` 存在残留配置时，rc.1 的自动 fallback 机制仍会隐式读取宿主文件凭据。
   - _隔离边界澄清_：为探测进程分配独立临时工作目录（下称“隔离临时 probe workspace”），只能有效切断 rc.1 经测试验证的自动 fallback 与共享状态路径。它不是操作系统级沙箱（OS sandbox，未启用内核 cgroups/chroot/seccomp 隔离），也无法阻止同 UID 下运行的任意恶意二进制主动读取宿主文件。方案将其严格表述为“隔离临时 probe workspace”，不使用“彻底隔离”、“杜绝凭据外泄”等夸大表述。
   - _平台防御_：白名单遗漏了 Windows 平台可能依赖的 `SystemDrive`、`windir` 与 `WINDIR`。由于当前 CI 环境缺少原生 Windows runner，将其界定为兼容性纵深防御变量，不宣称为“已确认必需”。
2. **切换工作目录导致的相对路径命令解析失效风险**：
   - _根因_：若将 probe 切换到隔离临时 probe workspace 运行，外部传入的形如 `./bin/dsh` 或 `../dsh` 等带有路径分隔符的相对命令将因当前工作目录（cwd）的改变而找不到目标二进制（`ENOENT`）；而纯命令名（如 `dsh`）必须保留以便子进程依靠系统的 `PATH` 机制进行解析。
3. **测试断言语义过度宣称（Mock 顺序冒充物理锁）**：
   - _根因_：现有针对 `config` 与 `help` 的 mock 串行测试仅能验证 Tekon 应用层调度 Promise 的先后顺序（scheduling order），无法也不应宣称为操作系统底层的物理文件互斥锁。测试用例命名与断言应实事求是。
4. **SessionComposer 交互闭环与测试规范性遗漏**：
   - _根因_：默认 Session 启动入口在 `plan && !planDigest` 分支下仅渲染了静态错误文本，缺少重试按钮（`refetchPlan`），导致计划摘要生成异常时用户无法在当前界面原地恢复；同时，在首次 `project.run` 失败后，尽管代码中有 `finally { startInFlightRef.current = false; }`，但缺少真实 Chromium 场景断言证明 latch 释放且允许用户重试；此外，新增的 e2e 测试文件命名为 `session-composer-admission.test.ts`，未遵循 `AGENTS.md` 约定的 `*.e2e.test.ts` 文件命名规范。
5. **上游基线与证据分级混淆风险**：
   - _根因_：DeepSeek Harness 官方于 2026-09-03 发布了 `0.1.2-rc.1`。需严格防范将官方发布 tag（`a66e4702047846cdaa10c66c9d3df3951f5ea70d`）与 github `master` 分支（`76fda729799fe9b3848dbe2c211d4b231032b81e`）混为一谈。虽然二者 `package.json` 中的版本号相同，但 master 分支包含未发布的代理配置与持久化重构。目前已通过真实 Node 22.19 环境完成官方 npm rc.1 的裸命令执行基准（raw binary smoke），但在完成整改后的包装复测（wrapped L2）与带凭据模型调用（L3）前，Tekon 生产 tested pin 必须维持 `0.1.2-alpha.3`。

### 1.2 本轮收口目标

本整改方案聚焦于解决上述 5 项具体风险，交付可验证、可审计的干净增量：

1. **DSH Preflight 隔离临时 probe workspace 机制**：为每次内置 preflight 分配独立临时目录，统一建立规范目录结构（`cwd = root`，`DSH_HOME = root/dsh-home`，`DSH_AGENTS_HOME = root/agents-home`）；只要任一 probe 为 default 就创建并在 `finally` 中通过 `safeWarnCleanup` 清理；切 cwd 前将相对路径命令绝对化，保留裸命令 PATH 查找与分阶段 ENOENT 语义，清理失败仅记录 warning。
2. **环境变量白名单严密闭环**：补充 Windows 兼容性防御变量（`SystemDrive`、`windir`、`WINDIR`），维持对动态链接注入变量（`LD_LIBRARY_PATH`、`DYLD_*`、`LD_PRELOAD`、`NODE_OPTIONS` 等）和网络代理/凭据的严格 fail-closed。
3. **TDD 测试先行与语义规范**：先红后绿扩展 Core 隔离测试集（含受控 callerDir seam、ambient 凭据切断断言、分阶段 ENOENT 断言、双故障与 safe warning sink 断言、3 种 probe 组合用例），将 mock 顺序测试正名为调度顺序测试，严格遵守测试卫生。
4. **SessionComposer 交互完备与测试命名合规**：补齐缺摘要分支重试按钮，补全真实 Chromium 失败后重试与摘要重新拉取断言，规范 e2e 文件命名，Web 端到端测试由 42 项增至至少 44 项。
5. **事实与追踪对齐**：解耦 rc.1 tag 与 master 分支并固定 commit 引用，确立基于隔离 npm 安装与 production build 的 Wrapped L2 复测断言标准，更新 #17、#27、#32，梳理 #13–#33 职责并补全遗漏的 #23。
6. **四包 lockstep 升级**：全仓四包版本统一提升至 `0.20.6`，同步更新变更日志（使用 `## v0.20.6` 标题）与相关文档。

---

## 2. 已定决策与产品/设计细节

### 2.1 隔离临时 Probe Workspace 机制与路径结构

- **统一路径结构定义**：
  - 根目录：`const root = mkdtempSync(join(tmpdir(), 'tekon-dsh-probe-'));`；
  - 工作目录：子进程 `cwd = root`；
  - 探测状态目录：环境变量 `DSH_HOME = join(root, 'dsh-home')`；
  - 代理配置目录：环境变量 `DSH_AGENTS_HOME = join(root, 'agents-home')`；
  - _设置原则_：三者拥有清晰的层级关系，`cwd` 为根目录 `root`，`DSH_HOME` 与 `DSH_AGENTS_HOME` 分别为其独立子路径，严禁表述为“三者同一路径”。无需提前 `mkdirSync` 子目录，避免设置阶段泄漏与额外系统调用，由外部命令按需自建；`mkdtempSync` 成功后立即进入 `try / finally` 块。
- **创建与生命周期触发条件**：
  - 只要 `probeVersion`、`probeHelp`、`probeConfig` 中有任一为默认 probe，就必须创建该临时工作区并在 `finally` 块中清理；
  - 默认 probe 使用绝对化后的命令 + 隔离 options（`cwd: root`, `env: probeEnv`）；
  - 自定义 probe（custom probe）继续接收调用方传入的原始未修改 `dshCommand` 与其自身环境；
  - 若三项 probe 全部传入自定义函数，则不创建任何临时目录，避免无谓的文件系统开销；
  - 在 Core 测试集中覆盖“全默认”、“部分自定义”、“全自定义”三类组合。
- **切断 Fallback 与共享状态路径**：
  - 子进程在空临时目录 `root` 中执行，切断向 `<invocation cwd>/.env` 的隐式读取；
  - 外部环境（ambient）中的 `process.env.DSH_HOME` 与 `process.env.DSH_AGENTS_HOME` 不传给子进程，切断向宿主 `$DSH_HOME/.env` 与 `$DSH_HOME/.credentials.yaml` 的回退路径。
- **清理容错、双故障保障与 Safe Warning Sink**：
  - 实现专用辅助函数 `safeWarnCleanup(root: string, options?: RunDshPreflightOptions): Promise<void>`；
  - 清理操作在 `finally` 块中执行：`rmSync(root, { recursive: true, force: true })`（或调用 `options?.probeCleanup` seam）；
  - 双故障语义明确：
    - 主流程正常且清理异常：正常返回主探测结果，将清理异常格式化后记入 `onWarn`；
    - 主流程抛错且清理异常：必须重新抛出主探测异常，将清理异常格式化后记入 `onWarn`，绝不因清理错误掩盖主异常；
    - Safe Warning Sink：`options?.onWarn` 调用必须被内部 `try ... catch` 包裹。若用户提供的 `onWarn` 回调自身发生异常，该异常被内部静默丢弃（sink 保护），绝不击穿并覆盖主结果或主异常。
- **命令路径解析安全与分阶段 ENOENT 契约**：
  - 相对命令解析：若传入的 `dshCommand` 包含路径分隔符（`dshCommand.includes('/') || dshCommand.includes('\\')`），在切换 cwd 之前通过 `path.resolve(options?.probeInvocationCwd ?? process.cwd(), dshCommand)` 转换为绝对路径，确保切入临时 cwd 后依然可执行；
  - 裸命令解析：若为纯命令名（如 `'dsh'`），保持原样，依托子进程的 `PATH` 环境寻找二进制；
  - 分阶段 ENOENT 契约明确：
    - 全默认模式下版本探测缺失裸命令：`defaultProbeVersion` 执行 `execFileAsync(bareCommand, ...)` 失败，系统原样抛出带有 `error.code === 'ENOENT'` 且 `error.path === bareCommand` 的系统级错误；
    - 自定义 version 成功但后续 default config 探测缺失命令：按照既有 `dsh-bridge-probe.ts` 契约，`probeConfig` 抛错后被 `runDshPreflight` 外层的 `catch` 捕获并包装为 `new DshCapabilityError(error.message, actualVersion)`。该场景下不保留底层的 code 与 path 属性，方案实事求是，不虚构 code/path 原样保留；
    - 上述两类阶段均需断言 `finally` 中的 workspace 清理逻辑已被完整执行。

### 2.2 环境变量白名单加固与 Fail-Closed 原则

- **Windows 兼容性防御变量**：
  - 将 `SystemDrive`、`windir`、`WINDIR` 加入 `DSH_PROBE_SAFE_ENV_KEYS` 白名单；
  - _定位澄清_：由于 CI 仅在 Linux runner 上执行，缺乏原生 Windows smoke 测试，因此此项界定为跨平台兼容性纵深防御，不写为“已确认必需”。
- **严格封堵注入攻击面**：
  - 严禁放行动态链接器控制变量：`LD_LIBRARY_PATH`、`DYLD_LIBRARY_PATH`、`DYLD_INSERT_LIBRARIES`、`LD_PRELOAD` 等；
  - 严禁放行 Node 运行时注入变量：`NODE_OPTIONS` 等；
  - 严禁放行代理与网络凭据变量：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 等；
  - 严禁放行模型与平台凭据：`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`GH_TOKEN` 等。
- _设计考量_：Metadata probe 的职责仅为提取版本号、帮助文本与默认配置行，无需动态装载外部共享库或发起带凭据的网络访问。动态链接变量具备直接的进程注入面，必须保持严格 fail-closed。

### 2.3 SessionComposer 准入完备性与重试机制

- **缺失校验摘要分支支持重试**：
  - 在 `SessionComposer.tsx` 的 `plan && !planDigest` 渲染分支中，增加与 `planError` 风格一致的“重试”按钮，点击调用 `refetchPlan`：
    ```tsx
    <div className="flex items-center gap-2 text-danger" role="alert">
      <span>执行计划缺少校验摘要，已阻止启动。请重新读取计划后再试。</span>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={refetchPlan}
      >
        重试
      </button>
    </div>
    ```
- **失败后 Latch 释放与重试保证**：
  - 验证首次 `project.run` RPC 失败（例如 500 异常或网络中断）后，`startInFlightRef.current = false` 正常生效，错误提示正常展示，提交按钮恢复可点击态，用户无需刷新页面即可重新提交。
- **真实 Chromium E2E 场景补充（两个新场景，最低 44 tests）**：
  - 场景 1（提交失败重试）：通过 Playwright 拦截 `project.run` RPC，模拟首次调用返回 HTTP 500，断言错误提示正常呈现，提交按钮重新变为可点击（`toBeEnabled`）；恢复正常路由后再次点击，断言成功发起第二次 RPC 请求并完成会话创建与页面跳转；
  - 场景 2（摘要缺失重试）：通过 Playwright 拦截 `workflow.plan` RPC，模拟首次返回缺少 `digest` 的畸形数据，断言界面呈现缺少摘要警告与“重试”按钮；点击“重试”按钮后，必须严格断言 `workflow.plan` 的 RPC 调用计数增加，返回正常 digest，且提交按钮恢复为可用状态。
- **E2E 测试文件规范化**：
  - 将 `packages/web/__tests__/e2e/session-composer-admission.test.ts` 重命名为 `packages/web/__tests__/e2e/session-composer-admission.e2e.test.ts`；
  - _原因界定_：重命名理由仅为严格遵守 `AGENTS.md` 约定的 `*.e2e.test.ts` 文件命名规范，不声称当前 Web unit lane 存在双跑（因 Web unit 配置已将 `__tests__/e2e/**` 排除）；
  - _范围界定_：验收标准仅要求本轮新增与重命名的文件合规，不强制重构既有遗留 Web e2e 测试文件。补充上述 2 个新场景后，Web 端到端测试由 42 项增至至少 44 项。

### 2.4 UI 边界控制（克制设计原则）

- **不增加不可达的默认网络确认控件**：默认 Session 启动模式为 `mode: 'workflow'`，在当前系统配置下并不请求非受限网络访问（unrestricted network）。增加网络确认对话框或复选框属于当前阶段不可达的冗余代码，坚决不做。
- **不进行过早的跨组件 Hook 抽取**：虽然 `SessionComposer` 与 `StartRunForm` 在启动准入与单飞逻辑上有相似性，但在单一 Runtime 权威（#16）与规范 RunPlan 准入（#31）尚未成型前，抽取大而全的表单 Hook 会过早锁定接口，带来二次重构成本。
- **UI 重复逻辑保留为 Backlog 跟踪项**：两套启动界面的准入状态机重复作为 P2 待办继续在 Issue 中跟踪，当前通过分层测试保障各自的 fail-closed。

### 2.5 DeepSeek Harness 事实基线与官方资料引用

- **发布 Tag 与 Master 分支严格分离**：
  - 官方发布 Tag：`dsh-v0.1.2-rc.1`（Commit: `a66e4702047846cdaa10c66c9d3df3951f5ea70d`）。基于 `git diff --name-status dsh-v0.1.2-alpha.5..dsh-v0.1.2-rc.1` 分析，变更的全部 252 个文件均仅涉及 package.json 中的版本号更新，无运行时源码行为差异。
  - GitHub Master 分支：Commit `76fda729799fe9b3848dbe2c211d4b231032b81e`。该分支在 `package.json` 中虽然也标注为 `0.1.2-rc.1`，但包含了未经发布的网络代理参数改动、持久化逻辑调整和会话抽象修改。
  - _裁决_：Tekon 方案与断言仅锚定官方 release tag 与 npm 发布的二进制，绝不引入 master 未发布代码。
- **官方资料引用列表（明确区分并固定 Commit）**：
  - **Release Tag `dsh-v0.1.2-rc.1`（Commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`）**：
    - CLI 执行入口：[rc.1 apps/cli/src/bin.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/apps/cli/src/bin.ts)
    - 应用引导与分层环境加载：[rc.1 packages/boot/app-boot/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/boot/app-boot/src/index.ts)
    - 本地凭据读取实现：[rc.1 credentials-local](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/credentials/credentials-local/README.md)
    - Headless 契约说明：[rc.1 Headless README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/bundle/headless/README.md)
  - **GitHub Master 分支（Commit `76fda729799fe9b3848dbe2c211d4b231032b81e`）**：
    - 出站代理策略架构笔记：[master outbound-proxy-policy.md](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/.agents/notes/implemented/architecture/2026-08-27-outbound-proxy-policy.md)
    - 网络代理用户指南：[master network-proxy.md](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/docs/user/guide/network-proxy.md)
- **Tested Pin 保持策略**：
  - Tekon 生产配置 `TESTED_DSH_VERSION` 保持 `0.1.2-alpha.3`。
  - 裸命令执行基准证明 rc.1 在 CLI 命令面、帮助文本锚点和五项插件配置行上符合契约；但在完成整改后的包装复测与带凭证 L3 交互前，不盲目升 pin。

### 2.6 Issue #13–#33 职责矩阵、#23 补全与治理例外声明

- **单次治理例外声明**：
  此前权威评审决议要求 #17/#27/#32 等后续任务拆分到独立 PR 推进。针对二十轮发现的 DSH probe 隔离直接缺陷，用户明确要求在本轮 PR #11 中收口。本方案对此记录为一次窄范围治理例外：仅收敛已验证的 probe 临时工作区直接缺陷，#32 仅关闭其内部的 `probe-home` 子项，#32 issue 整体继续保持 OPEN（因 Run credential provenance 与内部工具执行管控仍未完成），绝不将其他长期架构演进回填到 PR #11。

梳理完整的治理矩阵与术语定义：

| Issue ID | 严重度 | 领域       | 核心职责与边界（术语纠偏）                                                         | 本轮整改关系                 |
| :------- | :----- | :--------- | :--------------------------------------------------------------------------------- | :--------------------------- |
| **#13**  | P0     | Data       | Authoritative Session / Event Outbox / Durable Inbox                               | 架构主线，本轮不闭环         |
| **#14**  | P0     | Product    | ACP (**Agent Client Protocol**，代理客户端协议) 双向流式切片                       | 架构主线，本轮不闭环         |
| **#15**  | P0     | Runtime    | Executor 静默与确定性退出（**Quiescent Executor / Process Settlement**）及重启恢复 | 架构主线，本轮不闭环         |
| **#16**  | P0     | Arch       | Repo 级 Single-Owner Runtime 物理互斥锁与守护生命周期                              | 架构主线，本轮不闭环         |
| **#17**  | P1     | DSH        | DSH 0.1.2-rc.1 验证（L1 源码合同分析已完成，Wrapped L2 待复测，L3 待启动）         | 记录 L2 复测方案与 L3 缺口   |
| **#18**  | P1     | Lifecycle  | 完整生命周期治理：模型 Compaction、导出归档、安全 Purge                            | 架构主线，本轮不闭环         |
| **#19**  | P0     | Product    | Collaborate 模式与 Deliver 受控轨道的双轨交互演进                                  | 架构主线，本轮不闭环         |
| **#20**  | P1     | Workflow   | RunPlan 权威化（作为准入、执行与恢复的唯一事实）                                   | 架构主线，本轮不闭环         |
| **#21**  | P1     | A11y       | 全站屏幕阅读器、多浏览器矩阵、缩放与弱网体验验收                                   | 质量主线，本轮不闭环         |
| **#22**  | P1     | DSH        | Provider 例外准入知情同意、快照绑定与审计                                          | 架构主线，本轮不闭环         |
| **#23**  | P1     | Process    | **PR 体量治理（PR Scale Governance，超大 PR 拆解与防膨胀）**                       | **本轮补全职责说明**         |
| **#24**  | P1     | Governance | 发布工程：Required Checks、SBOM、代码签名与 Release 渠道                           | 工程治理，本轮不闭环         |
| **#25**  | P2     | Code       | CommandGateway 重构：剥离超时状态机与进程采样职责                                  | 代码健康，本轮不闭环         |
| **#26**  | P2     | Code       | 静态分析治理：真实语义级 Lint 与格式技术债务收敛                                   | 代码健康，本轮不闭环         |
| **#27**  | P1     | Tracking   | 架构重构主线任务追踪（Checklist 索引）                                             | 同步更新任务状态             |
| **#28**  | P1     | Provider   | Provider 命令身份推断统一与参数帧安全合同                                          | 架构主线，本轮不闭环         |
| **#29**  | P1     | Admission  | Provider 凭证健康、能力检测与请求级准入三层解耦                                    | 架构主线，本轮不闭环         |
| **#30**  | P3     | Process    | 追踪平台化扩展（已按 not_planned 关闭，保持轻量）                                  | 维持关闭状态                 |
| **#31**  | P1     | Admission  | **原子 Run admission / saga 补偿状态机**与请求幂等性（非分布式事务）               | 架构主线，本轮不闭环         |
| **#32**  | P1     | Security   | DSH 运行环境与能力证据（**仅关闭 probe-home 子项，issue 整体保持 OPEN**）          | 记录窄范围例外收口           |
| **#33**  | P1     | Security   | `project.clean` 入口安全防误删防护（全量 fail-closed）                             | 维持独立 Issue，本轮不改代码 |

---

## 3. 实现细节与文件级变更计划

### 3.1 `packages/core/src/runtime/dsh-bridge-probe.ts`

- **扩展白名单与环境构建**：
  - 在 `DSH_PROBE_SAFE_ENV_KEYS` 中增加 `'SystemDrive'`, `'windir'`, `'WINDIR'`；
  - 确保白名单中排除 `'DSH_HOME'`, `'DSH_AGENTS_HOME'`（改由隔离临时 probe workspace 注入）；
  - 重构环境构建函数签名：`buildProbeTelemetryEnv(tempHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv`；
  - 强制设置 `DSH_TELEMETRY_DISABLED = '1'`，并覆盖设置 `env.DSH_HOME = join(tempHome, 'dsh-home')` 与 `env.DSH_AGENTS_HOME = join(tempHome, 'agents-home')`。
- **程序化测试 Seam（不暴露至 CLI/RPC）**：
  - 在 `RunDshPreflightOptions` 中增加仅供测试的字段：
    - `probeInvocationCwd?: string`：相对命令解析的基准工作目录（受控 callerDir），实现优先使用此 seam，避免全局 `process.chdir` 污染测试运行器；
    - `probeCleanup?: (dir: string) => void | Promise<void>`：用于确定性测试清理异常触发 `onWarn`。
- **命令执行与沙箱生命周期控制**：
  - 修改 `defaultProbeVersion`、`defaultProbeHelp`、`defaultProbeConfig` 签名，接受 `{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }`，在 `execFileAsync` 中传入 `cwd`；
  - 在 `runDshPreflight` 中判断是否需要创建临时工作区：若 `!options?.probeVersion || !options?.probeHelp || !options?.probeConfig`（即任一 probe 为默认实现），创建临时工作区 `const root = mkdtempSync(join(tmpdir(), 'tekon-dsh-probe-'))`；
  - 若三者均由外部自定义传入，则 `root = null`，不创建任何文件系统目录；
  - 相对命令解析：若 `dshCommand.includes('/') || dshCommand.includes('\\')`，则 `resolvedDshCommand = path.resolve(options?.probeInvocationCwd ?? process.cwd(), dshCommand)`；否则保留原始 bare command（如 `'dsh'`）；
  - 建立安全清理辅助函数 `safeWarnCleanup`：
    ```ts
    async function safeWarnCleanup(
      root: string,
      options?: RunDshPreflightOptions,
    ): Promise<void> {
      try {
        if (options?.probeCleanup) {
          await options.probeCleanup(root);
        } else {
          rmSync(root, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        try {
          options?.onWarn?.(
            `[dsh bridge] failed to clean up probe workspace: ${cleanupError}`,
          );
        } catch {
          // Safe warning sink: ignore consumer callback crashes.
        }
      }
    }
    ```
  - `try ... finally` 块严格包裹 probe 调度，并在 `finally` 中调用 `await safeWarnCleanup(root, options)`；
  - ENOENT 错误处理分阶段锁定：
    - `defaultProbeVersion` 阶段找不到命令时，原生抛出带有 `error.code === 'ENOENT'` 与 `error.path === bareCommand` 的错误；
    - 后续 `defaultProbeConfig` 或 `defaultProbeHelp` 阶段抛错时，按现有合同包装为 `DshCapabilityError` 并保留 `actualVersion`，不虚称保留原生 code/path；
    - 两类情况均在 `finally` 中执行 `safeWarnCleanup`。

### 3.2 `packages/core/__tests__/runtime/dsh-bridge-probe-isolation.test.ts`

- **测试卫生准则**：严禁调用全局 `process.chdir`；严禁向 git 仓库工作树写入 `.env` 或测试临时文件；所有测试必须在各自的 `mkdtemp` 临时 caller 目录中完成。
- **扩充 TDD 隔离断言套件**：
  1. _规范路径结构断言_：验证三个 probe 记录的子进程 `cwd` 为 `root`，`DSH_HOME` 为 `join(root, 'dsh-home')`，`DSH_AGENTS_HOME` 为 `join(root, 'agents-home')`；
  2. _Ambient 凭据切断断言_：在测试传入的宿主 `DSH_HOME` 目录中写入 `.env`（含 `DEEPSEEK_API_KEY=ambient-secret`）与 `.credentials.yaml` 凭证哨兵，验证在旧实现下子进程会读取宿主值，而在新实现下被切断且子进程读不到这些哨兵；
  3. _受控 CallerDir 隔离断言_：从测试进程启动辅助 Node 进程，并通过该子进程的 `{ cwd: callerDir }` 令 `callerDir` 成为调用 `runDshPreflight` 时的真实进程 cwd；在 callerDir 写入 `.env` 哨兵，由 recording DSH 模拟读取执行 cwd 下的 `.env`。旧实现因默认 probe 继承 callerDir 而读取哨兵并 RED；新实现即使同时把 `probeInvocationCwd` 指向 callerDir，也必须把默认 probe 的子进程 cwd 切换为隔离 `root`，从而读不到哨兵并 GREEN。全程不调用测试运行器的全局 `process.chdir`；
  4. _正常与异常退出清理断言_：在 probe 执行成功、以及触发 contract 校验失败（如配置缺失行）时，均验证临时工作区目录 `root` 被完全移除；
  5. _ENOENT 分阶段契约断言_：
     - 全默认模式下传入不存在的命令，断言抛出的异常满足 `error.code === 'ENOENT'`，`error.path === bareCommand`，且 `root` 被清理；
     - 自定义 version 成功但 default config 阶段命令缺失，断言抛出 `DshCapabilityError` 且其 `actualVersion` 保持正确，`root` 被清理；
  6. _双故障与 Safe Warning Sink 断言_：
     - 主流程抛错 + cleanup 抛错：断言依然抛出主异常，且 `onWarn` 记录清理警告；
     - 主流程成功 + cleanup 抛错：断言正常返回探测结果，且 `onWarn` 记录清理警告；
     - `onWarn` 自身抛出未捕获异常：断言被 `safe warning sink` 吸收，绝不覆盖主结果或主异常；
  7. _相对路径命令可执行断言_：利用 `probeInvocationCwd` 传入相对路径 `./recording-dsh.mjs`，断言命令在切换 cwd 后依然成功执行；
  8. _Windows 安全变量透传断言_：宿主环境中若存在 `SystemDrive`、`windir`、`WINDIR`，断言其被正确透传至 probe 子进程；
  9. _三种组合测试_：
     - 全默认 probe：验证创建临时工作区并在 finally 中清理，三个 default probe 都收到隔离 cwd、隔离环境和绝对化后的相对命令；
     - 部分自定义 probe：验证创建临时工作区并在 finally 中清理；每个 default probe 都收到隔离 cwd、隔离环境和绝对化后的相对命令，而 custom probe 收到调用方传入的原始 `dshCommand`；
     - 全自定义 probe：验证完全不调用 `mkdtempSync`，无文件系统开销，三个 custom probe 都收到原始 `dshCommand`。
- **规范化调度顺序测试描述**：更新已有的 `finishes default-config validation before starting the help probe` 测试说明，明确声明该测试仅验证应用层 Promise 调度顺序（scheduling order），不冒充底层文件排他锁。

### 3.3 `packages/web/src/client/components/sessions/SessionComposer.tsx`

- 在 `plan && !planDigest` 分支渲染重试按钮，对齐 `StartRunForm.tsx` 与 `planError` 分支的恢复体验。

### 3.4 `packages/web/__tests__/e2e/session-composer-admission.e2e.test.ts`

- **测试文件重命名**：将 `packages/web/__tests__/e2e/session-composer-admission.test.ts` 重命名为 `packages/web/__tests__/e2e/session-composer-admission.e2e.test.ts`，遵守 `AGENTS.md` 命名规范；
- **补充真实 Chromium 断言（2 个新场景，最低 44 tests）**：
  - 用例 1（首次失败后释放 latch 允许重试）：模拟首次 `project.run` RPC 失败（500 错误），断言错误提示正常呈现，提交按钮重新启用，第二次点击成功发起调用并跳转会话详情页；
  - 用例 2（缺少 planDigest 时点击重试重新拉取计划）：模拟计划缺少摘要时呈现重试按钮，点击后必须断言 `workflow.plan` 的 RPC 请求计数增加，返回正常 digest，且提交按钮恢复为可用状态。
- 重命名与扩充后，Web 端到端测试由 42 项增至至少 44 项。

### 3.5 版本、变更日志与文档同步

- **四包 Lockstep 升级**：根目录与 `core`、`cli`、`web` 四个 `package.json` 版本统一递增至 `0.20.6`；
- **CHANGELOG.md**：新增 `## v0.20.6` 条目（规范标题格式），详细说明 DSH preflight 隔离临时 probe workspace、Windows 兼容性防御变量、SessionComposer 缺摘要原地重试与端到端测试命名规范化；
- **README.md 与用户手册**：
  - `README.md`：保持受控交付的高层阐述，不展开内部临时目录等实现细节；
  - `docs/manual/tekon-user-manual.md` 与 `.html`：同步核实 DSH 环境依赖与沙箱边界说明；
- **第二十轮复审报告与当前权威指针**：
  - `docs/reviews/2026-09-03-tekon-product-runtime-harness-twentieth-review.md`：追加主 Agent 视角批注并生成同名 HTML；
  - `docs/reviews/current.md`：删除“不再生成重复的 HTML 报告镜像”冲突描述，恢复双入口导航；
  - _Head / CI 绑定机制_：在最终整改代码与文档提交推送到远端分支后，按实际产生的 commit sha、Core workflow run ID 与 CI workflow run ID 更新权威记录，不预留占位标记。

---

## 4. TDD 测试先行与 RED-GREEN 预期

遵循严格的测试先行工程原则，在修改任何业务代码前先建立明确的失败断言：

```text
[Phase 1: RED]
1. 扩展 dsh-bridge-probe-isolation.test.ts:
   - 断言 probeInvocationCwd seam 下子进程 cwd 与受控 callerDir 不同 (旧接口缺少该 seam / 记录 cwd 仍等于真实进程 cwd: 失败)
   - 断言 ambient DSH_HOME/.env 和 .credentials 哨兵对子进程不可见 (旧实现透传宿主路径能够读取: 失败)
   - 断言全默认模式下缺失裸命令抛出原生 code === 'ENOENT' 且 path === bareCommand (旧实现未切入隔离逻辑或缺少断言: 失败)
   - 断言主异常 + cleanup 抛错时抛出主异常且记录 onWarn (旧接口无 probeCleanup seam: 失败)
   - 断言 onWarn 自身抛错时被 safe warning sink 吸收 (旧接口无 safeWarnCleanup: 失败)
   - 断言全自定义 probe 时完全不调用 mkdtempSync (当前无区分逻辑: 失败)
2. 重命名并扩充 session-composer-admission.e2e.test.ts:
   - 增加 project.run 首次 500 失败后重新点击成功的 Playwright 断言
   - 增加 planDigest 缺失时点击“重试”按钮触发 workflow.plan 请求计数增加并恢复 digest 的 Playwright 断言 (当前缺少重试按钮: 失败)

[Phase 2: GREEN]
1. 实现 dsh-bridge-probe.ts 隔离工作区逻辑:
   - mkdtempSync 创建独立工作区，设置隔离 cwd / DSH_HOME / DSH_AGENTS_HOME
   - path.resolve 基于 probeInvocationCwd 预处理相对命令
   - DSH_PROBE_SAFE_ENV_KEYS 增加 SystemDrive, windir, WINDIR
   - safeWarnCleanup 保证工作区清理与 safe warning sink 兜底
   → Core 隔离测试集全部断言转绿 (GREEN)
2. 实现 SessionComposer.tsx 重试按钮:
   - 补充 plan && !planDigest 状态下的重试按钮与 refetchPlan 绑定
   → Web Chromium e2e 测试全部转绿 (GREEN，共至少 44 项通过)
```

---

## 5. 真实 DSH 0.1.2-rc.1 验证分级与事实基线

### 5.1 验证层级定义

- **L1（源码与 Fixture 合同分析）**：通过分析官方源码与本地 fixture，核验 CLI 参数、输出数据结构与插件配置树。已在二十轮评审中完成。
- **Raw Binary Smoke（裸命令执行基准）**：在隔离环境（Node.js v22.19.0）下直接执行官方发布包 `@deepseek-ai/dsh@0.1.2-rc.1`（Release Tag: `a66e4702047846cdaa10c66c9d3df3951f5ea70d`）的裸命令基准：
  - `dsh --version`：**54ms**
  - `dsh --profile headless --dump-default-config`：**70ms**
  - `dsh --profile headless --help`：**558ms**
  - 输出包含全部 5 个核心插件行：`headless-runner`、`sandbox-policy`、`approval`、`session-persistence-jsonl`、`agent-default-model`；
  - Headless 帮助文本包含契约锚点：`print the final assistant message`。
- **Wrapped L2（Tekon 生产封装复测）**：通过 Tekon 生产构建的 `runDshPreflight` 进行集成调用复测（详见 5.2）。
- **L3（真实模型交互与全链路验证）**：配置真实 API Key，运行端到端任务并验证 ACP 协议与长会话恢复。当前尚未开展。

### 5.2 整改后的 Wrapped L2 验收规范

整改实现后，必须按照以下完整规范执行 Wrapped L2 复测：

1. **隔离 npm 安装与完整性核对**：
   - 在独立临时目录中安装 `@deepseek-ai/dsh@0.1.2-rc.1`；
   - 严格记录 npm 发布元数据中的 `dist.integrity`：
     `sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA==`；
2. **无凭据受控执行环境**：
   - 运行环境：Node.js v22.19.0 / Linux x64 / 无 API key（确保环境未注入真实 `DEEPSEEK_API_KEY`）；
   - npm 安装与 Node runner 启动时不设置无效代理或 `NODE_OPTIONS` 哨兵；runner 成功启动并载入 Tekon 构建产物后，再通过 `probeEnvSource`（或等价的运行期 `process.env` 修改）注入 `DEEPSEEK_API_KEY=parent-secret`、`HTTP_PROXY=http://parent.invalid`、`NODE_OPTIONS=--require=/tmp/parent-hook.js`，避免不存在的 require hook 在 recorder 启动前终止 Node 进程；
3. **Delegating Recorder Wrapper 转发与记录**：
   - 编写代理记录脚本，记录 Tekon 传给实际 `dsh` rc.1 的 `cwd` 与环境变量字典，并将所有输入输出及退出码透传给真实 rc.1 二进制；
4. **生产构建导出调用**：
   - 执行 `pnpm build`，通过 Node.js 直接调用构建产物 `packages/core/dist/index.js` 导出的 `runDshPreflight`；
5. **断言清单**：
   - runner 启动后注入上述哨兵，再调用 `runDshPreflight(wrapperExecutable, { allowVersion: '0.1.2-rc.1', probeEnvSource })`（若采用运行期修改 `process.env`，则在 `finally` 中恢复原值）；
   - `result.versionCompatible === false`；
   - `result.versionBypassed === true`；
   - 捕获到预期的版本 bypass 警告日志（`onWarn`）；
   - 5 项核心插件行与 help 契约锚点（`print the final assistant message`）校验通过；
   - 父环境注入的哨兵变量均未流入实际命令；
   - `clean-home` 产生的所有配置与状态文件仅出现在隔离临时目录 `root`（及其子路径 `dsh-home`/`agents-home`）内；
   - 探测完成后临时目录被完全清理；
   - 进程退出码与预期一致。

完成上述包装复测后，方可在报告与文档中记为“L2 验证通过”。

### 5.3 维持 Pin 版本的裁决理由

即使 Wrapped L2 验证通过，**Tekon 生产 tested pin 仍必须维持 `0.1.2-alpha.3`**。原因在于：L3 真实模型联调与 ACP（Agent Client Protocol）流式交互尚未完成验证。维持 alpha.3 的 fail-closed 门禁是保护系统稳定性的必要底线。

---

## 6. 验证矩阵

| 验证层级                      | 执行命令 / 路径                                             | 检验目标与准入标准                                                                                                                                  |
| :---------------------------- | :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| **定向单元测试（RED→GREEN）** | `pnpm --filter @tekon/core test dsh-bridge-probe-isolation` | 验证工作区 cwd 隔离、ambient 凭据切断、受控 callerDir、相对路径绝对化、Windows 防御变量、分阶段 ENOENT、双故障/safe warning sink 与 3 类 probe 组合 |
| **Core 端到端测试**           | `pnpm --filter @tekon/core test:e2e`                        | 确保 8 个 Core e2e 测试文件、26 项测试全量通过（Core26 基线）                                                                                       |
| **CLI 端到端测试**            | `pnpm --filter @tekon/cli test:e2e`                         | 确保 3 个 CLI e2e 测试文件、8 项测试全量通过（CLI8 基线）                                                                                           |
| **Web Chromium 端到端**       | `pnpm --filter @tekon/web test:e2e`                         | 确保至少 44 项 Playwright 浏览器用例全绿（含失败重试、摘要重试与规范命名文件）                                                                      |
| **全仓单元与集成回归**        | `pnpm test`                                                 | 全量 144+ 测试文件、1541+ 项用例通过，无意外回归                                                                                                    |
| **静态类型与规范检查**        | `pnpm lint && pnpm typecheck`                               | 全仓无 TypeScript 类型错误；说明：当前 lint 脚本主要由 `tsc -p tsconfig.json --noEmit` 执行，不声称 ESLint                                          |
| **生产构建验证**              | `pnpm build`                                                | 全包构建产物正常生成，无打包报错                                                                                                                    |
| **安全依赖审计**              | `pnpm audit --prod`                                         | 生产依赖无中高危已知安全漏洞                                                                                                                        |
| **响应式多视口视觉验收**      | Playwright Viewport Matrix (320px / 390px / 700px / 1440px) | 验证 SessionComposer 与 StartRunForm 无文字截断、按钮无换行错位、无横向滚动条；说明：当前自动化覆盖 390/700/1440px，320px 为专用/人工视口检测       |
| **多角色 Review**             | 代码/测试审查、技术架构审查、文档编辑审查                   | 独立最高思考等级审查，达成 `hasMustFix=false`                                                                                                       |
| **远端 CI 状态绑定**          | GitHub Actions Workflow (`core.yml` & `ci.yml`)             | 提交推送到远端后，按实际 Actions Run 绑定终态 `completed/success`                                                                                   |

---

## 7. 风险与回滚方案

### 7.1 识别风险与防护机制

1. **临时工作区目录清理异常风险**：
   - _风险_：在受限文件系统或 Windows 下，`rmSync` 可能偶发 `EBUSY` 或 `EPERM`，若未捕获将导致 preflight 意外崩溃。
   - _防护_：清理操作必须由 `safeWarnCleanup` 统一处理，捕获异常后降级为 `options?.onWarn?.(...)`，且吞掉 `onWarn` 自身可能抛出的异常，绝不覆盖主探测结果或主异常。
2. **相对路径命令解析歧义风险**：
   - _风险_：若使用者传入形如 `.\\dsh.cmd` 的相对路径，切换 cwd 后可能找不到文件。
   - _防护_：利用 Node 原生 `path.resolve` 基于 `probeInvocationCwd ?? process.cwd()` 绝对化命令；纯命令名继续交由底层系统的 `PATH` 解析。
3. **Windows 环境变量大小写敏感性**：
   - _风险_：Windows 环境变量大小写不敏感，但 Node.js 的 `process.env` 可能保留大小写特征。
   - _防护_：白名单同时包含 `windir` 与 `WINDIR`，`Path` 与 `PATH`，消除键名漂移隐患。

### 7.2 回滚策略

本次整改所有变更均被约束在受控的单分支内。若在实施或 CI 阶段发现不可预测的系统性衰退，可通过 Git 单 commit 原子回退（`git revert`）恢复至基线状态 `6fd86ee`，保持受控低爆炸半径。

---

## 8. 文档、版本与 Issue 状态同步

### 8.1 版本与文件同步判断说明

- **四包 Lockstep `0.20.6`**：Core 核心探测、Web 启动交互组件与端到端测试均有代码与规范变更，按语义化版本统一递增至 `0.20.6`；
- **CHANGELOG.md**：必须同步。新增 `## v0.20.6` 标题条目，向终端用户与下游集成方明确说明 DSH preflight 隔离临时 probe workspace 的安全隔离意义、Windows 兼容性防御变量以及界面重试交互改善；
- **README.md 与用户手册**：
  - `README.md`：保持受控交付的高层阐述，不展开内部临时目录等实现细节；
  - `docs/manual/tekon-user-manual.md` 与 `.html`：同步核实 DSH 环境依赖与沙箱边界说明；
- **AGENTS.md**：不修改 `AGENTS.md` 本身。严格遵守其关于 e2e 测试命名（`*.e2e.test.ts`）的现有规则，通过重命名测试文件主动向其规范靠拢。

### 8.2 Issue 状态更新

- **Issue #17（DSH rc.1 验证）**：记录官方 npm rc.1 裸命令耗时数据（54ms / 70ms / 558ms）与契约匹配事实，明确标注基于生产构建的 Wrapped L2 验收规范，保持 tested pin 为 alpha.3，标注 L3 缺口；
- **Issue #27（主线架构追踪）**：更新治理清单，保持架构主线与 PR #11 收口的明确分界；
- **Issue #32（DSH 环境与凭据管理）**：明确标注 Probe 执行层的 `probe-home` 临时工作区隔离子项已关闭；正式 Run 阶段的凭据来源（credential provenance）与内部工具执行管控依然保持 OPEN；
- **Issue #23（PR 体量治理）**：正式纳入管理清单，明确超大 PR 风险，确立后续主线架构必须通过独立小 PR 推进的原则；
- **Issue #33（Clean 目录防误删安全防护）**：确认生产代码保持不变，完整物理清理与生命周期继续在独立 issue 中推进。

### 8.3 `current.md` 规则修复与基线绑定

- 纠正此前“不再生成重复的 HTML 报告镜像”的规则冲突，恢复规范的双入口导航（Markdown 源码 + 单文件无依赖自包含 HTML）；
- 准确记录二十轮基线（`6fd86ee` / Core #419 / CI #328），并明确整改提交推送到远端分支后，按实际产生的 commit sha、Core workflow run ID 与 CI workflow run ID 更新权威记录。

---

## 9. 验收标准与非目标

### 9.1 验收标准清单

1. **临时工作区隔离有效性**：Core 隔离测试证明默认 probe 在隔离临时 probe workspace 中运行（`cwd = root`，`DSH_HOME = root/dsh-home`，`DSH_AGENTS_HOME = root/agents-home`），不继承宿主 DSH_HOME，无法读取宿主工作区中的 `.env`，相对命令与 Windows 变量正确处理。
2. **Probe 组合与清理保证**：覆盖全默认、部分自定义、全自定义三类 probe 组合；存在默认 probe 时无论成功或异常均执行清理；全自定义时不创建目录；清理异常仅记录 warning，不覆盖主结果。
3. **ENOENT 错误契约完整**：版本探测阶段不存在命令时抛出 `code === 'ENOENT'`，`path` 为原 bare command；配置阶段缺失时正确包装 `DshCapabilityError`；两阶段清理逻辑均被执行。
4. **双故障与 Warning 吸收**：主异常或主结果不被 cleanup 异常覆盖；`onWarn` 回调自身崩溃被 safe warning sink 吸收。
5. **SessionComposer 交互闭环**：缺少 planDigest 时界面渲染“重试”按钮，点击重新请求计划；首次提交失败后用户可直接再次点击重试。
6. **测试套件规范与 e2e 命名合规**：本轮新增与重命名的 e2e 测试文件均以 `*.e2e.test.ts` 命名，Web 端到端测试总数达到至少 44 项。
7. **全量门禁全绿**：`pnpm test`、`pnpm lint`（`tsc -p tsconfig.json --noEmit`）、`pnpm typecheck`、`pnpm build`、`pnpm audit --prod` 以及 Core/CLI/Web 各自的 `test:e2e` 全部无错误通过。
8. **响应式布局无横溢**：320px、390px、700px 与 1440px 视口下无任何元素横向溢出或文本重叠。
9. **无占位内容**：方案、代码与报告中无任何 `TBD`、`TODO`、`FIXME` 或 placeholder。
10. **版本一致性**：四包版本号严格统一为 `0.20.6`。
11. **HTML 与 Markdown 双向同步**：HTML 文件样式精简、自包含且与 Markdown 内容严格一致。
12. **Reviewer 签收**：独立最高思考等级 Reviewer 审查给出 `hasMustFix=false` 结论。

### 9.2 明确非目标（Explicit Non-Goals）

为了守住 PR #11 的收口边界，以下事项明确**不在本轮执行**：

- 不实现 `project.clean` 的短期全量 fail-closed 或生命周期清理（保持 #33 独立处理）；
- 不实现单一所有权运行时（#16）与守护进程生命周期；
- 不实现执行器静默重启（#15）；
- 不实现原子 Run 准入事务或 Saga 补偿机制（#31）；
- 不重构 RunPlan 成为唯一执行事实权威（#20）；
- 不重写权威 Session 事实源与持久化收件箱（#13）；
- 不接入 ACP 协议或实现持续流式协作（#14、#19）；
- 不开展 DSH rc.1 的 L3 真实模型联调，不提升生产 tested pin；
- 不修改仓库的分支保护规则（Branch Protection Rules）；
- 不执行 Git Merge、PR 合入或版本 Release 操作。

---

## 10. 阶段实施顺序与甘特安排

```text
阶段 1: TDD RED 扩展 (Core 单元隔离断言 + Web 重试 e2e 先行)
  └── 编写 dsh-bridge-probe-isolation.test.ts 9 项新断言与 3 类组合测试
  └── 重命名并扩充 session-composer-admission.e2e.test.ts (失败重试 + 计划摘要重新拉取)
  └── 运行测试确认红灯 (RED)

阶段 2: GREEN 生产代码修复
  └── packages/core/src/runtime/dsh-bridge-probe.ts 隔离工作区、safeWarnCleanup 与 Windows 白名单实现
  └── packages/web/src/client/components/sessions/SessionComposer.tsx 重试按钮实现
  └── 重新运行上述测试确认全部转绿 (GREEN)

阶段 3: 真实 Wrapped L2 规范复测
  └── 生产构建 pnpm build 后，调用 packages/core/dist/index.js 针对本地 rc.1 执行包装复测并记录证据

阶段 4: 文档、报告、批注、HTML 与版本号同步
  └── 提升四包版本号至 0.20.6
  └── 同步 CHANGELOG.md (## v0.20.6) 与用户手册
  └── 第二十轮报告追加批注并生成同名 HTML
  └── current.md 消除冲突规则并链接双入口

阶段 5: 全量验证、多角色 Review 与 CI 终态绑定
  └── 代码与文档就绪后执行最终 pnpm test、分包 test:e2e、Playwright 全量回归 (>= 44 tests)
  └── 执行 pnpm lint / typecheck / build / audit 全门禁
  └── 代码审查、技术方案审查与文档编辑审查达成 hasMustFix=false
  └── 推送后按实际产生的 commit / Actions ID 绑定最新 GitHub Actions Core / CI 终态
```
