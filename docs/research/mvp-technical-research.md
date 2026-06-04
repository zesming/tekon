# Donkey MVP 技术调研

本文档记录 Donkey MVP 技术方案使用的外部技术调研。调研优先使用官方文档、标准组织文档和项目官方资料。

## 1. Agent 编排与运行时

| 方向 | 资料 | 关键内容 | 对 Donkey 的启发 |
|-|-|-|-|
| LangGraph | [LangGraph workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) | LangGraph 区分 workflow 与 agent，强调持久化、流式输出、调试和部署。 | Donkey 需要把确定性流程和动态 Agent 分开：流程主干可控，局部任务交给 Agent。 |
| CrewAI | [CrewAI documentation](https://docs.crewai.com/) | CrewAI 面向多 Agent 系统，包含 crews、flows、guardrails、memory、knowledge、observability。 | 角色化 Agent 和 Flow 适合作为参考，但 Donkey 不应被某个框架锁死。 |
| Microsoft AutoGen | [AutoGen documentation](https://microsoft.github.io/autogen/stable/index.html) | AutoGen 是事件驱动的多 Agent 框架，支持确定性和动态 Agent workflow。 | 多 Agent 协作成熟度提升，但产品层仍需要自己的状态、权限、证据和风险模型。 |
| OpenAI Agents SDK | [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | SDK 支持工具执行、handoffs、guardrails、sessions、tracing、sandbox agents。 | 适合作为 OpenAI-first Agent runtime 备选，尤其适合结构化 handoff 和 guardrail。 |

## 2. Agent 协议与工具连接

| 方向 | 资料 | 关键内容 | 对 Donkey 的启发 |
|-|-|-|-|
| MCP | [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) | MCP 官方安全实践强调授权流、安全边界和 OAuth 相关风险。 | Donkey 的工具连接层应采用最小权限、工具白名单、审计和敏感操作拦截。 |
| A2A | [A2A official docs](https://a2a-protocol.org/latest/) | A2A 是开放 Agent 间通信标准，目标是不同框架和厂商 Agent 的互操作。 | MVP 不必直接实现 A2A，但 Agent Adapter 要保留未来接入异构 Agent 的空间。 |
| ACP | [Agent Communication Protocol](https://agentcommunicationprotocol.dev/introduction/welcome) | ACP 是 Linux Foundation 下的开放 Agent 通信标准，后续与 A2A 生态收敛。 | Agent 通信协议仍在演进，Donkey 应避免把内部对象模型绑定到单一协议。 |

## 3. Coding Agent 与代码交付

| 工具 | 资料 | 关键内容 | 对 Donkey 的启发 |
|-|-|-|-|
| OpenAI Codex | [Codex cloud docs](https://developers.openai.com/codex/cloud) | Codex 可在云端后台处理任务，连接 GitHub 并创建 PR。 | Donkey MVP 可把 Codex 作为 RD Agent Adapter，而不是自研完整代码编辑 Agent。 |
| Codex Environments | [Codex environments](https://developers.openai.com/codex/cloud/environments) | Codex cloud task 在环境中检出仓库、运行配置命令并执行任务。 | Coding Agent Adapter 不能假设所有执行者都用同一种任务/权限/日志模型，需要定义最小合同。 |
| Claude Code | [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions) | Claude 可通过 GitHub Actions 在 issue/PR 中分析代码、创建 PR、实现功能和修复 bug。 | Donkey 需要抽象“代码执行者”，支持 Claude Code、Codex 等多后端。 |
| Cursor | [Cursor docs](https://cursor.com/docs) | Cursor 官方文档覆盖 Agent、Rules、MCP、Skills、CLI 与团队能力。 | Repo Profile 中的规则和指令文件应作为 Agent 工作的关键上下文。 |
| Devin | [Devin PR templates docs](https://docs.devin.ai/integrations/pr-templates) | Devin 可使用仓库 PR 模板生成 PR 描述。 | Donkey 应规范 PR 证据包模板，让外部 Coding Agent 也能稳定输出可验收 PR。 |
| Factory Droids | [Factory Droids](https://factory.ai/product/droids) | Droids 面向自动计划、编码、测试和交付代码。 | 行业方向已从补全代码走向任务级交付，Donkey 的差异应是流程治理和证据验收。 |

## 4. 持久化工作流与任务调度

| 方向 | 资料 | 关键内容 | 对 Donkey 的启发 |
|-|-|-|-|
| Temporal | [Temporal Workflows](https://docs.temporal.io/workflows) | Temporal workflow 可长期运行，面对底层失败仍能保持可靠、持久和可扩展。 | Donkey 的 Orchestrator 应具备长任务、重试、暂停、恢复和审计能力。 |
| Inngest | [Inngest docs](https://www.inngest.com/docs) | Inngest 是事件驱动的 durable execution 平台，支持 TypeScript、Python、Go、步骤执行、队列和观测。 | 若团队更偏 Node/Serverless，Inngest 是轻量备选。 |
| Hatchet | [Hatchet docs](https://docs.hatchet.run/home) | Hatchet 支持 durable workflows、任务持久化、重试、replay、监控、告警和日志。 | Hatchet 与 Agent/任务调度场景贴近，可作为轻量自托管备选。 |
| Dagger | [Dagger](https://dagger.io/) | Dagger 用容器化函数构建可编程软件交付环境，适合复杂 CI 与 AI Agent 场景。 | Donkey 可借鉴“可编程、可复现、容器化”的执行环境思路。 |

## 5. 安全、风险与供应链

| 方向 | 资料 | 关键内容 | 对 Donkey 的启发 |
|-|-|-|-|
| OWASP LLM Top 10 | [OWASP Top 10 for LLM Applications 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf) | OWASP 总结 LLM 应用的主要风险，包括 prompt injection、敏感信息泄露、供应链等。 | Donkey 必须把仓库内容、文档和用户输入视为不可信上下文。 |
| OWASP Agentic AI | [Agentic AI Threats and Mitigations](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/) | OWASP 针对 Agent 工具使用、自治决策和多 Agent 协作提出威胁与缓解思路。 | Donkey 的高危动作 Gate、工具权限和审计日志是核心设计，不是附加项。 |
| Codex Internet Access | [Codex internet access](https://developers.openai.com/codex/cloud/internet-access) | Codex 官方文档将网络访问与 prompt injection、代码/secret 外泄、恶意依赖等风险关联。 | Donkey 的执行环境要有网络 egress 策略、secret 隔离和工具审计，不能只靠分支隔离。 |
| NIST GenAI Profile | [NIST AI RMF Generative AI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) | NIST 为生成式 AI 风险管理提供跨行业 profile。 | Donkey 应以风险识别、度量、治理和反馈闭环组织安全能力。 |
| SLSA | [SLSA](https://slsa.dev/) | SLSA 是软件供应链完整性框架，关注防篡改、构建完整性和基础设施安全。 | Donkey 生成 PR 时应保留执行记录、依赖变更和验证证据，支持后续供应链治理。 |

## 6. CI/E2E 与可观测性

| 方向 | 资料 | 关键内容 | 对 Donkey 的启发 |
|-|-|-|-|
| Playwright | [Playwright](https://playwright.dev/) | Playwright Test 支持自动等待、断言、trace、并行和多浏览器 E2E。 | Test Agent 应把 E2E 结果、trace、截图和日志纳入交付证据包。 |
| GitHub Actions | [GitHub Actions CI](https://docs.github.com/en/actions/get-started/continuous-integration) | GitHub Actions 支持在仓库中创建 CI workflow，自动运行构建和测试。 | Donkey 不替代 CI，而是消费 CI 结果并把它转成验收证据。 |
| GitLab CI | [GitLab workflow rules](https://docs.gitlab.com/ci/yaml/workflow/) | GitLab 支持分支 pipeline 与 MR pipeline 规则。 | Donkey 的代码仓库适配层要抽象 GitHub/GitLab 差异。 |
| OpenTelemetry | [OpenTelemetry docs](https://opentelemetry.io/docs/) | OpenTelemetry 是供应商中立的 traces、metrics、logs 标准。 | Donkey 的 AgentRun、ToolRun、WorkflowRun 应可关联 trace、metric 和 audit log。 |
