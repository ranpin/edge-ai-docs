# 1. 座舱端侧 Agent 总览

*端侧大模型选型、Agent 框架设计概述与场景应用概览*

> [!TIP]
> **本篇讲什么**
>
> 座舱端侧 Agent 系统总览。系统由两个核心库组成：
>
> - **aadkcore**：提供统一模型接口、调度器、MCP/A2A 协议等基础设施（编译为 `libaadkcore.so`）
> - **agent\_group**：基于 aadkcore 的插件接口实现各场景 Agent（编译为 `libagent_group.so`，运行时动态加载）
>
> 本篇覆盖端侧大模型选型、Agent 框架设计概述与场景应用概览；aadkcore 的详解分为「运行时与模型」和「协议与运行时执行」两篇，加上场景 Agent 应用，见下方「核心模块导读」。

## 1. 核心模块导读

### 1.1 aadkcore 核心框架 · 运行时与模型

统一模型接口（ModelInstance）、模型调度器（ModelScheduler）、多音区对话管理（ChatHistory）、RAG 知识增强

`C++17` · `ModelScheduler` · `ChatHistory` · `RAG`

### 1.2 aadkcore · 协议与运行时执行

MCP 工具协议、A2A 协议、运行时与插件机制、LLM Flow 与 Tool Use、端云协同与安全沙箱（设计方向）

`MCP` · `A2A` · `插件` · `Tool Use`

### 1.3 场景 Agent 应用

车辆控制 Agent（30+ 技能）、主动视觉 Agent（6 大模式）、闲聊 Agent、GUI Agent、Prompt 模板工程、数据通路与 Fusion 通信

`车控` · `主动视觉` · `闲聊` · `GUI Agent`

## 2. 座舱大模型 Agent 架构

先看框架的实际分层：应用层的场景 Agent 构建在 aadkcore 的统一 API 之上，内部实现调度、对话与 Tool 流程，最终通过平台适配层对接不同推理后端：

```mermaid
graph TD
    subgraph APP["应用层 (agent_group)"]
        A1["车控 / 闲聊 / 主动视觉 / GUI Agent"]
    end

    subgraph API["API 层 (aadkapi/)"]
        B1["ModelInstance / ChatHistory / RagInstance"]
        B2["McpServer / A2AServer / ModelRunner"]
    end

    subgraph CORE["内部实现层"]
        C1["BaseAgent / LlmFlow / ModelScheduler"]
        C2["AgentRuntime / BaseTool"]
    end

    subgraph PLATFORM["平台适配层"]
        D1["QNN — SA8397P"]
        D2["Lape — Jetson Orin"]
        D3["Bailian — Cloud x86"]
    end

    APP --> API
    API --> CORE
    CORE --> PLATFORM

    style APP fill:#4361ee,color:#fff
    style API fill:#7b8cff,color:#fff
    style CORE fill:#f39c12,color:#fff
    style PLATFORM fill:#2ecc71,color:#fff
```

> 完整分层（代码目录结构、平台支持矩阵）见 [**aadkcore 核心框架**](agent-core.html)。

### 2.1 端侧 LLM 选型对比

在 SA8397P 级别硬件上（Hexagon NPU 约 70 TOPS INT8），可运行的端侧大模型需要兼顾推理速度、模型质量和内存占用。当前座舱场景的首选是 **Qwen3-Omni-4B**——原生支持文本、图像、音频、视频四种模态输入，非常契合座舱多模态交互需求：

| 模型 | 参数量 | 量化精度 | 生成速度 (tok/s) | 内存占用 | 中文能力 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Qwen3-Omni-4B** | 4B | INT4 | ~10 | ~2.5 GB | 优秀 | 多模态座舱 Agent (语音+视觉+车控) |
| **Qwen3-4B** | 4B | INT4 | ~12 | ~2.5 GB | 优秀 | 纯文本 Function Calling、对话 |
| **Qwen3-1.7B** | 1.7B | INT4 | ~28 | ~1.2 GB | 良好 | 轻量级意图识别、低延迟场景 |
| **Llama3.2-3B** | 3B | INT4 | ~15 | ~2.0 GB | 中等 | 多语言场景、海外车型 |

表中生成速度与内存占用为 INT4 量化下的量级示例，实际取决于具体平台带宽与算力，请按自己的平台代入推导（方法见 [**LLM 推理原理与性能模型**](../../general/infer-principles.html)）。

> [!TIP]
> **选型建议**
>
> 国内座舱场景首选 **Qwen3-Omni-4B**：原生支持音频输入/输出，省去独立 ASR+TTS 模块，系统架构更简洁；中文能力和 Function Calling 能力在同尺寸模型中领先。INT4 量化后内存约 2.5GB，SA8397P 可承载。如果延迟预算极紧，可用 Qwen3-1.7B 做意图识别前端 + Qwen3-Omni-4B 做复杂推理的级联架构——注意该前端只适用于**短 prompt 的纯意图分类**场景：端侧 TTFT 包含完整 prefill，随 prompt 长度增长，具体延迟预算应按带宽/roofline 模型推导，而非拍一个固定毫秒数。

### 2.2 多模态输入与车态注入

座舱 Agent 的输入是异构的：语音、图像、车辆状态、上下文。aadkcore 的做法是 **prompt 注入式**数据流——车辆状态与上下文以文本形式注入 prompt，图像/音频走模型的原生多模态输入，最终由 LLM Flow 分发到执行器：

```mermaid
graph LR
    subgraph 输入层
        A1["语音ASR 文本 / 原生音频"]
        A2["视觉车内/前向摄像头图像帧"]
        A3["车辆状态CAN 信号"]
        A4["上下文时间/位置/天气/乘客"]
    end

    subgraph Prompt 组装层
        B["PromptManager占位符替换 +[CAR_STATE] 注入"]
    end

    subgraph 推理层
        C["端侧 LLMQwen3-Omni-4B原生多模态输入"]
    end

    subgraph 执行层
        D["LLM Flow / Tool Router"]
        E1["语音回复TTS"]
        E2["车辆控制Car Control"]
        E3["UI 更新"]
        E4["安全告警"]
    end

    A1 --> B
    A3 --> B
    A4 --> B
    B --> C
    A2 --> C
    C --> D
    D --> E1
    D --> E2
    D --> E3
    D --> E4
```

具体分工：语音经 ASR 转为文本进入用户消息（或使用 Qwen3-Omni 的原生音频输入）；图像帧作为 VLM 的原生多模态内容直接送入模型；车辆状态由 `CarSignalManager` 读取 CAN 信号后，以 `[CAR_STATE]` 文本（如"空调24度, 车窗关闭, 风速3档"）注入 system prompt；时间、位置、天气、乘客信息等上下文由 `PromptManager` 做占位符替换。

> [!NOTE]
> **为什么不是 token 级 embedding 融合**
>
> 文献中常见的"理想化多模态融合架构"是用独立的多模态编码器把各模态对齐到统一 embedding 空间、车态也编码为结构化 token。aadkcore **没有**采用这种方式，而是 prompt 注入：LLM 只看到"文本 prompt + 原生多模态内容"，车态就是 prompt 里的结构化文本。这样无需定制融合编码器、不增加训练成本，新增车态信号只需扩展 prompt 模板。占位符替换机制与场景模板详见 [**场景 Agent 应用**](agent-group.html)。

## 3. 端侧 Agent 框架设计

### 3.1 Function Calling 流程

端侧 Agent 的核心能力是 Function Calling：用户发出自然语言指令，LLM 解析意图后调用注册的 Tool 完成操作，最后将结果汇总回复用户。下面以一个典型的复合指令为例：

```mermaid
sequenceDiagram
    participant U as 用户
    participant LLM as 端侧 LLM
    participant TR as Tool Router
    participant AC as 空调 API
    participant NAV as 导航 API

    U->>LLM: "太热了，调空调22度，导航去加油站"
    LLM->>LLM: 意图解析：识别2个意图1. 空调控制 → set_ac(22°C)2. 导航 → navigate(nearest_gas_station)
    LLM->>TR: 分发 Tool Calls
    TR->>AC: set_temperature(22)
    AC-->>TR: {"status":"ok","current_temp":"22°C"}
    TR->>NAV: search_and_navigate("加油站")
    NAV-->>TR: {"station":"中石化(前方2.3km)","eta":"4min"}
    TR-->>LLM: 汇总两个 Tool 结果
    LLM->>U: "已把空调调到22度。最近的加油站是中石化，前方2.3公里，约4分钟到达，已为您开始导航。"
```

### 3.2 Tool Use 设计要点

端侧 Agent 的 Tool 体系需要兼顾灵活性和安全性。以下是关键设计考量：

| 设计要点 | 方案 | 说明 |
| :--- | :--- | :--- |
| **工具注册** | JSON Schema 描述 | 每个工具通过 JSON Schema 定义函数名、参数类型、必填项和描述。LLM 根据 Schema 生成结构化调用参数，无需 Few-shot 示例。 |
| **安全沙箱** | L1 / L2 / L3 三级分级 | 只读 / 可逆 / 不可逆分级确认，防止误操作与危险操作。分级定义与安全检查流水线见 [**协议与运行时执行**](agent-protocols.html)（设计方向）。 |
| **延迟预算** | < 2s 端到端（示例目标） | 从用户说完到执行完成 < 2 秒。以下数字为**预算分配示例（非实测）**：ASR ~300ms，LLM 推理 ~800ms，Tool 执行 ~500ms，TTS ~400ms。其中 LLM 项应按平台 roofline/带宽模型推导（TTFT 看算力、decode 看带宽），不要拍固定毫秒数，推导方法见 [**LLM 推理原理与性能模型**](../../general/infer-principles.html) 与 [**端侧解码与服务化优化**](../../general/infer-serving.html)。 |
| **离线能力** | 本地优先 + 云端 fallback | 核心 Tools（车控、本地音乐、导航缓存）全部本地化。联网后自动同步云端 Tools（在线搜索、实时路况）。 |
| **错误处理** | 重试 + 降级 + 告知 | Tool 调用失败时：先重试 1 次 → 尝试降级方案 → 告知用户并建议替代操作。 |
| **并发调度** | A2A 并行分发 + ModelScheduler 优先级调度 | 已记录的两层并发机制：Agent 层由 SystemAgent 把意图拆分为子任务，经 A2A **并行分发**给各场景 Agent（如上例空调和导航可并行）后汇总结果，见 [**协议与运行时执行**](agent-protocols.html) §2.4；模型层由 ModelScheduler 对多音区并发请求做优先级/抢占调度。基于 DAG 依赖分析的 Tool 自动并行为设计方向（未实现）。 |

### 3.3 记忆系统

端侧 Agent 的记忆分三层：**短期记忆**（KV Cache 与对话窗口，随对话实时更新）、**长期记忆**（用户偏好与驾驶习惯，本地持久化、按需注入上下文）、**情景记忆**（行程/交互/事件记录，按需检索补充）。aadkcore 中由 ChatHistory（多音区对话历史）与 memory 模块承载；实现细节与端侧/云端记忆取舍见 [**aadkcore 核心框架**](agent-core.html)。座舱场景下驾驶习惯与个人偏好属高敏感数据，端侧记忆（零上传、零网络延迟、完全离线可用）是首选方案。

## 4. 座舱场景 Agent 应用

典型座舱场景由 agent\_group 插件库中的各 Agent 落地，涵盖语音交互、主动安全、个性化推荐和多模态融合：

- **智能语音助手**：ASR → LLM 意图理解 → Function Calling → TTS 的核心对话与车控链路
- **主动安全提醒**：LLM 综合 DMS、车辆状态、驾驶时长做分级告警，而非简单阈值触发
- **个性化推荐**：长期记忆 + 实时上下文（时间/位置/车辆状态）主动推荐，无需用户发起对话
- **多模态车控**：语音与注视/手势融合消歧，消除自然语言指代歧义后精准车控

各 Agent 的技能体系、Prompt 模板与数据通路见 [**场景 Agent 应用**](agent-group.html)。

> [!NOTE]
> **LLM 推理优化**
>
> KV Cache、Roofline、推理引擎对比 → [**LLM 推理原理与性能模型**](../../general/infer-principles.html)；投机采样、约束解码、TTFT/端到端延迟优化 → [**端侧解码与服务化优化**](../../general/infer-serving.html)；量化 → [**端侧模型量化与压缩**](../../general/quantization.html)
