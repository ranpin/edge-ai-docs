# 岚图 8397 座舱 VLM 端侧量产 · 项目简介

*Qwen3-Omni-4B 座舱多模态大模型在 SA8397P 车机上的端侧离线量产落地 —— 摘要 · 演示 · 方法总览 · 实验方案*

> [!TIP]
> **关于本页**
>
> 这是「岚图 8397 座舱 VLM 端侧量产」项目（2026 至今）的简介页，按项目主页 / 论文主页方式组织：**摘要 → 演示视频·结果图 → 方法总览 → 实验方案总览**。各模块工程详解见首页该项目书架，或方法总览各节链接。

## 1. 摘要

本项目把 **Qwen3-Omni-4B** 座舱多模态大模型落地到岚图 8397（SA8397P，Hexagon NPU）车机，目标是端侧离线、车规可量产。工程围绕两条推理形态展开——**GenAI**（QNN/QAIRT → Context Binary → Genie 自研链路）与 **AIService**（岚图自研推理框架，HTTP/SSE 服务化），并打通从模型制备到上车运维的全链路：AIMET INT4 量化与模型制备、多 VIT 档位动态切换、7 条 LoRA / 11 组 prefix KV 缓存映射、前缀缓存与 DeepStack、三阶段推理链路、宿主 APK 端侧服务化（JNI + NanoHTTPD + 前台服务自愈）、SDK 构建与 adb 部署上车、效果/性能/稳定性评测、两方案选型决策，以及 SELinux/功能安全/隐私/OTA/模型加密等运维安全。

> [!NOTE]
> 两条形态的结果**不可直接横向对比**：模型包不同（版本、是否带全部 11 个 prefix KV 缓存），且 QNN 后端在 AIService 形态下的实现程度不同。对比须以同一模型包、同一口径为前提，详见 [**两方案选型决策与端到端对比**](genai-vs-aiservice.html)。

## 2. 演示视频 / 结果图

> [!NOTE]
> **待补充**：本节预留演示视频与结果图。可放置：舱内/舱外多模态交互演示、三阶段推理链路录屏、TTFT/TPS 实测截图、热/内存稳定性曲线等。

## 3. 方法总览

### 3.1 GenAI 方案架构

Qwen3-Omni-4B 端侧部署整体架构：模型制备链路（AIMET INT4 → Context Binary → Genie）、多 VIT 动态切换、7 条 LoRA / 11 prefix 映射、前缀缓存、DeepStack、三阶段推理链路。详见 [**GenAI 方案架构总览**](genai-architecture.html)。

### 3.2 AIService 后端集成与重构

从 GenAI 切换到岚图自研 aiservice 推理框架：多后端兼容、请求格式对齐、SSE 解析、HTTP 失败面与超时、SELinux 等难点与验证。详见 [**AIService 后端集成与重构**](aiservice-integration.html)。

### 3.3 APK 集成与端侧服务化

宿主 APK 三层架构、JNI 桥接与 ModelInference API、NanoHTTPD 本地服务、多模态协议转换、前台服务自愈、QNN Skel 打包、网络暴露面安全。详见 [**APK 集成与端侧服务化**](apk-integration.html)。

### 3.4 设备部署与上车流程

岚图 8397 SDK 构建 → 设备目录 → adb push → android_test/APK 运行 → 部署验证；两个模型根目录、工具链、SELinux 对比（岚图分支专属）。详见 [**设备部署与上车流程**](device-deployment.html)。

### 3.5 两方案选型决策

GenAI 与 AIService 选型决策表（包体/内存/时延/部署复杂度/可维护性/可回摆性）+ 端到端对比与口径前提。详见 [**两方案选型决策与端到端对比**](genai-vs-aiservice.html)。

### 3.6 运维、安全与功能安全

设备安装/排查、SELinux、功能安全（ISO 26262/SOTIF）、数据隐私（PIPL）、OTA 原子性/双槽/验签、模型加密与密钥管理。详见 [**运维、安全与功能安全**](ops-security.html)。

## 4. 实验方案总览

效果指标（舱内/舱外、版本演进）、性能指标（逐场景逐阶段、TTFT/TPS 口径）、优化手段量化贡献、热/内存/稳定性与消融实验设计，见 [**效果、性能与稳定性**](effect-perf-stability.html)。

> [!NOTE]
> **口径前提**：服务端 usage 恒为 0、max_tokens 被忽略、无独立 metrics 端点，性能数据须按既定口径采集；跨形态对比须同模型包同口径。具体实验矩阵与消融结果待补充。
