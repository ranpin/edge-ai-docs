# 智能座舱端侧大模型：从领域知识到量产实践

*一条「领域知识 → 框架研发 → 量产项目」的完整主线*

> [!TIP]
> **本篇讲什么**
>
> 这是智能座舱板块的**总导读**，把三层内容串成一个完整故事：先打**领域知识**地基（芯片/训练/推理），再研发可复用的**端侧 Agent 框架**（aadkcore / agent_group），最后在**岚图 8397 座舱 VLM 量产项目**里把框架真正落地装车。
>
> 建议按「通识 → 框架 → 岚图」的顺序阅读；每一层都引用下一层，读完能完整理解「端侧大模型如何从知识走到量产」。

## 1. 故事主线

```mermaid
flowchart LR
    A["领域知识<br/>芯片 · 训练 · 推理"] --> B["框架研发<br/>aadkcore / agent_group"]
    B --> C["岚图 8397 量产<br/>座舱 VLM 端侧落地"]
    C -.反哺.-> A

    style A fill:#4361ee,color:#fff
    style B fill:#2ecc71,color:#fff
    style C fill:#e74c3c,color:#fff
```

- **第一层 · 领域知识**：理解座舱端侧的硬件底座（SA8397P SoC / Hexagon DSP）、模型训练与微调、推理优化——这是一切的地基。
- **第二层 · 框架研发**：基于领域知识研发可复用的端侧 Agent 框架——aadkcore 统一模型接口与调度，agent_group 以插件承载各场景 Agent。
- **第三层 · 岚图量产**：把框架部署到岚图 8397 座舱，跑通 GenAI 与 AIService 两套推理后端，完成效果/性能验证与运维。

## 2. 三层结构与阅读路径

### 2.1 第一层 · 领域知识（通用部分）

| 文档 | 讲什么 |
| :--- | :--- |
| [硬件与系统底层](general/hardware.html) | SA8397P SoC、Hexagon DSP、FastRPC、Hypervisor、内存带宽、功耗热管理、HTP 架构版本 |
| [模型训练与微调](general/training.html) | DMS/OMS 训练、LoRA/QLoRA、知识蒸馏、端侧微调可行性、SWIFT 工具链 |
| [座舱数据合规、评估与数据飞轮](general/data-pipeline.html) | 数据分类与隐私合规（PIPL/R155/R156）、模型评估体系、数据飞轮 |
| [端侧模型量化与压缩](general/quantization.html) | PTQ/QAT、AIMET、W4A16 机制、量化方案对比 |
| [LLM 推理原理与性能模型](general/infer-principles.html) | Prefill/Decode、Roofline、KV Cache、FlashAttention、Genie/QAIRT、Tokenizer |
| [端侧解码与服务化优化](general/infer-serving.html) | 前缀缓存、投机采样、约束解码、Continuous Batching、TTFT/端到端延迟 |
| [Android 开发 & JNI 基础](general/android-jni.html) | Android 工程结构、JNI 桥接、SELinux、RegisterNatives、端侧服务化与安全 |
| [面试指南](general/interview.html) | 51 道精选题，覆盖上述领域知识 |

### 2.2 第二层 · 框架研发（aadkcore / agent_group）

| 文档 | 讲什么 |
| :--- | :--- |
| [座舱端侧 Agent 总览](projects/agent-framework/overview.html) | 框架整体架构与模块划分 |
| [设备部署](projects/agent-framework/deploy.html) | QNN 推理框架、多平台构建矩阵、Service 量产部署 |
| [aadkcore 核心框架](projects/agent-framework/agent-core.html) | 架构总览、统一模型接口、模型调度、多音区对话管理、RAG |
| [协议与运行时执行](projects/agent-framework/agent-protocols.html) | MCP/A2A 协议、运行时与插件机制、LLM Flow 与 Tool Use、端云协同与安全沙箱 |
| [场景 Agent 应用](projects/agent-framework/agent-group.html) | 场景 Agent 插件机制（车控/主动视觉/闲聊/GUI 等） |
| [调试与工具链](projects/agent-framework/debug.html) | 精度/内存/Crash 排障、日志与监控 |

### 2.3 第三层 · 岚图 8397 量产项目

| 文档 | 讲什么 |
| :--- | :--- |
| [GenAI 方案架构总览](projects/lantu/genai-architecture.html) | 模型制备链路、多 VIT、LoRA/prefix 映射、三阶段推理 |
| [AIService 后端集成与重构](projects/lantu/aiservice-integration.html) | 岚图自研 AIService 推理后端的集成与验证 |
| [APK 集成与端侧服务化](projects/lantu/apk-integration.html) | 宿主 APK 内部结构、JNI 与 ModelInference API、HTTP 服务化、安全暴露面 |
| [设备部署与上车流程](projects/lantu/device-deployment.html) | SDK 构建 → 设备目录 → adb push → 运行 → 部署验证、两个模型根目录 |
| [效果、性能与稳定性](projects/lantu/effect-perf-stability.html) | 效果指标、性能指标、优化量化贡献、热/内存/稳定性 |
| [两方案选型决策与端到端对比](projects/lantu/genai-vs-aiservice.html) | GenAI vs AIService 选型决策表 + 端到端对比 |
| [运维、安全与功能安全](projects/lantu/ops-security.html) | 运维排查、SELinux、功能安全、数据隐私、OTA、模型加密与密钥管理 |

## 3. 一条完整的落地链路

把三层串起来，一个端侧大模型上车的完整链路是：

1. **懂底座**（领域知识）：理解 SA8397P 的 DSP/NPU、内存带宽与功耗约束，知道端侧推理的瓶颈在哪。
2. **造框架**（框架研发）：用 aadkcore 统一模型接口与调度、agent_group 承载场景 Agent，支持多平台构建与 Service 量产部署。
3. **做集成**（岚图项目）：把框架部署到岚图 8397——GenAI 方案直跑 QNN，AIService 方案经岚图自研推理服务；宿主 APK 经 JNI 调用 SDK 并对外提供 HTTP 服务。
4. **验效果**（岚图项目）：效果/性能/稳定性测试，GenAI 与 AIService 两套后端对比，持续优化。
5. **保运行**（岚图项目）：设备部署上车、运维与安全（OTA、模型加密设计）。

> [!NOTE]
> **为什么这样分层**
>
> 领域知识是可迁移的地基，框架是可复用的资产，岚图项目是框架的一次具体落地。框架研发时不绑定具体项目（主线 `agent_core_dev` 多平台通用），岚图项目则基于岚图分支（`lantu_sdk_dev` / `lantu_aiservice_dev`）做具体实现——这正是「框架可复用、项目可落地」的工程实践。
