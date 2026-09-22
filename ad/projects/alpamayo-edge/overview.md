# Alpamayo-Edge · 8B VLM 边缘量化部署 · 项目简介

*Cosmos-Reason2-8B 在 Jetson Orin 上的 INT4/INT8 量化与端到端推理实战 —— 摘要 · 演示 · 方法总览 · 实验方案*

> [!TIP]
> **关于本页**
>
> 这是「Alpamayo-Edge · 8B VLM 边缘量化部署」项目（2026.07）的简介页，按项目主页 / 论文主页方式组织：**摘要 → 演示视频·结果图 → 方法总览 → 实验方案总览**。完整的量化部署实战细节（含代码与数据）在外部项目主页，见下方链接或首页书架卡片。

## 1. 摘要

本项目把 **Cosmos-Reason2-8B**（8B 视觉语言模型）量化并部署到 **Jetson Orin** 边缘平台，跑通端到端推理，并系统权衡 **INT4 / INT8** 两种量化精度下的延迟、吞吐、显存、功耗与能效。过程中定位并修复了 **sm_87（Orin）上 FMHA（Flash Multi-head Attention）内核崩溃**的问题。成果以独立项目主页形式发布（TensorRT-Edge-LLM 链路）。

## 2. 演示视频 / 结果图

> [!NOTE]
> **待补充**：本节预留演示视频与结果图。完整的延迟/吞吐/显存/功耗/能效图表见外部项目主页 [Cosmos-Reason2-8B · Orin 量化部署实战](https://ranpin.github.io/qwen-trajectory-prediction/)。

## 3. 方法总览

### 3.1 量化与部署链路

INT4/INT8 量化 → TensorRT-Edge-LLM → Jetson Orin 端到端推理。完整步骤、配置与踩坑见外部项目主页 [Cosmos-Reason2-8B · Orin 量化部署实战](https://ranpin.github.io/qwen-trajectory-prediction/)。

### 3.2 sm_87 FMHA 崩溃定位与修复

Orin（sm_87）上 FMHA 内核崩溃的根因定位与修复方案，见外部项目主页对应章节。

## 4. 实验方案总览

评测维度：延迟（TTFT/TPS）、吞吐、显存占用、功耗、能效，INT4 vs INT8 对比。完整实验设置与结果见外部项目主页 [Cosmos-Reason2-8B · Orin 量化部署实战](https://ranpin.github.io/qwen-trajectory-prediction/)。

> [!NOTE]
> **待补充**：本页仅作为项目入口与导读，量化/部署/能效的完整数据与复现步骤以外部项目主页为准。
