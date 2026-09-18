# 2. 岚图 AI Service 后端集成与重构

## 2.1 背景简介

调整原先 GenAI 推理框架，改为采用岚图自研的 aiservice 推理框架。

## 2.2 核心技术路线

增加 aiservice 后端，多后端兼容实现。

## 2.3 aiservice 后端实现

通过 http 请求发送，解析输出。

Agentcore + agent_group 负责消息分发、agent 路由、任务管理、组织数据、预处理后处理等（test、msgdeliver、modelrunner、modelinstance）。

其中 qnnmodel.cpp 调用 `llms.so`，使用 Genai 推理框架负责模型推理。

aiservice.cpp 通过发送 http 请求的方式使用 aiservice 推理框架进行模型的加载和推理，并解析返回的结果。

## 2.4 难点

1. **效果对齐（请求格式）**：保证发送的请求格式与参考实现一致。三场景请求体形状不同——
   - Agent100（舱外车辆）：`{"body":{"request_id","timestamp","car_signal":{...}}}`（有 body 包装）
   - Agent200（衣着/空调）：`{"request_id","timestamp","voice_zone":N}`，**`voice_zone` 只读顶层**、没有 body 包装
   - Agent300（舱外问答）：`{"body":{"request_id","camera_id","timestamp","query":...}}`
   - 判据必须抄参考实现 `example/src/android_sdk_test.cpp` 的 `content[...]` 赋值，**不能抄 app 校验代码读的位置**（app 那处只是打日志校验，SDK dispatcher 拿不到）；`presure` 是上游的拼写（一个 s），照抄不要"纠正"。

2. **服务端扫描与"模型生效"陷阱**：VoyahAIService（`/vendor/bin/`，监听 8090）模型扫描根**硬编码 `/AI/VLM/models`**，且**只在启动时扫描**。`GET /v1/models` 返回 `loaded` **不等于新模型已生效**——进程只认启动时扫到的目录，旧目录改名后 inode 仍活着会继续服务旧包，唯一硬证据是 `/proc/<pid>/maps`。

3. **跨形态结果不可直接对比**：genai 与 aiservice 用的是**两个不同的模型包**（版本、全部 11 个 prefix KV 缓存、LoRA 权重 md5 均不同），输出差异是**模型 build 不同**而非后端数值差异。不要跨版本移植 prefix KV 来"对齐"——KV 是用特定权重预计算的 prefill 状态，混用等于拿可解释差异换不可解释不一致。

4. **服务端无 token 计量**：非流式 `usage` 恒 0（`input_tokens` 客户端不可得，本地也无 tokenizer）、`max_tokens` 被忽略、无 `/metrics` 端点。但 **1 个 SSE 内容帧 = 1 个 token**，数回调次数即 `output_tokens`。

5. **约束解码（stage3 grammar）缺失**：QNN 后端未实现约束解码，缺 EBNF 时仅 warn 后**静默降级**继续，曾导致舱外结果错乱——这是"结果不对"类问题的高发根因，排查时要先确认 grammar 是否真正生效。

6. **SSE 解析与 TTFT 口径**：SSE 开场帧（`delta:{"role":"assistant"}`）标记的是"服务端已受理"**而非 prefill 完成**，TTFT 可拆为"受理 + prefill"两段；`parseSSE` 按 `\n\n` 切帧，对 TCP 粘包免疫。

7. **SELinux（APK 侧上机第一坑）**：`/AI` 标签 `u:object_r:AI_file:s0`，策略不允许 `untrusted_app` 域 search/getattr，症状只有 Java 侧一句 `Model directory NOT FOUND`，极易误判成"模型没放好"。demo 需 `setenforce 0`（重启失效）；量产岚图 App 是 system/vendor 应用，不受此限。

8. **形态解耦（重构）**：`ENABLE_QNN_MODEL` 一个开关同时管住源码/include/链接/install 四层，aiservice 形态关闭 QNN 后包体 378→222MB；回摆只需改一个 flag。
