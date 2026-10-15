# 调试与工具链（aadkcore 专项）

*aadkcore 框架的日志 / 监控 / Profiling 与真实故障案例*

> [!TIP]
> **本篇讲什么**
>
> **通用排障方法论**（调试工具链、排障决策树、FastRPC 六步法、精度/内存/Crash 排障流程）已归通识篇 [**端侧调试与排障**](../../general/troubleshooting.html)。本篇只记 **aadkcore 框架强相关**的调试内容：
>
> - 真实故障案例（KV Cache 未释放乱码、非标准分辨率 DSP Crash、多音区并发 FastRPC Timeout）
> - aadkcore 日志系统（spdlog 两套宏、按平台分流）
> - aadk\_monitor（日志汇聚 + 数据回传）
> - 性能数据采集（ModelResponse / debug\_info / PERF 日志 / 厂商 SDK 分段 Profiling）
> - 内存排障的 aadkcore 口径（测试程序 VmRSS 口径、内存水位线现状）
>
> **代码基线**：aadkcore 仓库 `aadkapi/aadk_log.hpp`（日志宏与 sink）、`monitor/`（aadk\_monitor\_server 日志汇聚 + 数据回传）、`src/runtime`（ModelResponse / PERF 日志）、`runtime/src/system_agent`（`--dump`/`--upload` 入口）。

## 1. 典型案例分析

### 1.1 量化模型间歇性输出乱码

| 现象 | INT4 量化模型在长时间运行后（~2 小时）偶发输出乱码 token |
| :--- | :--- |
| 排查 | 1. 短时间运行正常 → 排除模型文件损坏 2. 内存监控发现 KV Cache 持续增长 → 存在未释放 3. 乱码出现时 KV Cache 已占满预分配空间，新 token 写入越界 |
| 根因 | 多轮对话清理逻辑中，当用户切换 scenario\_id 时，旧 scenario 的 KV Cache 未被释放 |
| 修复 | 在 scenario 切换时主动调用 KV Cache 清理；增加 KV Cache 使用量的边界检查 |

### 1.2 特定图片输入导致 DSP Crash

| 现象 | 某张图片送入 Vision Encoder 时 DSP 立即 SSR |
| :--- | :--- |
| 排查 | 1. mini-dm 获取 crash dump，PC 地址指向 QNN Conv2D 算子 2. 分析图片：分辨率为 1920×1080（非标准输入尺寸） 3. Vision Encoder 输入要求 448×448，但预处理 resize 未执行就送入了原始分辨率 |
| 根因 | 图像预处理 pipeline 中的 resize 函数在接收 YUV420 格式时路径异常，跳过了 resize 直接送入模型 |
| 修复 | 在 model\_inference.cpp 的 image format conversion 之后增加 shape 校验断言 |

### 1.3 多音区并发导致 FastRPC Timeout

| 现象 | 驾驶员和副驾同时发送语音指令时，偶发 FastRPC timeout（~10% 复现率） |
| :--- | :--- |
| 排查 | 1. Snapdragon Profiler 时间线分析：两个请求的 Prefill 同时到达 HTP 2. 单独执行每个请求均正常 → 并发争抢问题 3. HTP 在处理第一个请求的 Prefill 时，第二个请求的 FastRPC 调用排队等待超过 2s timeout |
| 根因 | ModelScheduler 未对 Prefill 阶段做分片，大 Prompt 的 Prefill 独占 HTP 时间过长 |
| 修复 | 1. Prefill 分片：将长 Prompt 分为多段，每段之间允许插入高优先级请求 2. FastRPC timeout 从 2s 调整为 5s 3. 高优先级请求（车控）可抢占低优先级（闲聊）的 Prefill |

> [!NOTE]
> **"Prefill 分片"即 chunked prefill**
>
> 把长 prompt 切成块、块间交错高优先级请求与在途 decode 步，用少量 TTFT 增加换取 TPOT 抖动与抢占等待的大幅下降；块大小是 TTFT 与 TPOT 平滑度的权衡旋钮，原理见 [LLM 推理原理与性能模型 · 混批干扰与 chunked prefill（§5.5）](../../general/infer-principles.html)。另注意：多请求并发究竟走真 batch 还是时分复用，以"并发 2 时每请求 TPOT 是否 ≈ 2×"为判据，见 [端侧解码与服务化优化 · 端侧可行性（§4.5）](../../general/infer-serving.html)——本案的排队恶化正是单 cDSP 时分复用的表现。

## 2. 日志与监控体系

### 2.1 aadkcore 日志系统

aadkcore 的日志基于 **spdlog**，核心定义在 `aadkapi/aadk_log.hpp`，提供两套宏：

- **带日志器名**：`AADK_LOG_TRACE/DEBUG/INFO/WARN/ERROR/CRITICAL(name, ...)`；
- **按平台分流的简化宏**：`LOG_V/D/I/W/E/F(...)`——Android 平台走 `__android_log_print` 直接进 logcat（tag 为编译期 `TAGNAME`），YunOS 走 `YUNOS_LOG`，Linux 走 spdlog socket 日志器（默认 sink 是 unix socket `/tmp/aadk_log.sock`）。

| 日志级别 | 宏（简化 / 命名） | 典型内容 | 说明 |
| :--- | :--- | :--- | :--- |
| **CRITICAL** | `LOG_F` / `AADK_LOG_CRITICAL` | 致命错误（如日志服务 socket 创建失败） | 最严重级别 |
| **ERROR** | `LOG_E` / `AADK_LOG_ERROR` | 模型加载失败、FastRPC 错误、dump 文件写入失败 | 生产环境始终开启 |
| **WARN** | `LOG_W` / `AADK_LOG_WARN` | 可恢复异常 | 生产环境始终开启 |
| **INFO** | `LOG_I` / `AADK_LOG_INFO` | 关键流程：请求开始/结束、模型加载完成、PERF 性能行（ttft/tps） | 推荐开启 |
| **DEBUG** | `LOG_D` / `AADK_LOG_DEBUG` | 详细调试：preprocess time、first\_token\_time、duration 等 | 运行时默认级别即 debug |
| **TRACE** | `LOG_V` / `AADK_LOG_TRACE` | 最详细追踪 | 默认被编译期裁剪（`SPDLOG_ACTIVE_LEVEL` 缺省为 DEBUG） |

日志格式默认含时间戳、日志器名、线程、级别与源码位置（`[时间] [name] [tid] [level] [file:line:func] message`），编译期定义 `SPDLOG_NO_SOURCE_LOC` 可关闭源码位置。

**日志汇聚链路（Linux 形态）**：各组件 socket sink → `/tmp/aadk_log.sock` → `aadk_monitor_server`（见 §2.2）→ 滚动写入 `/data/logs/aadk.log`；`agentcore.service` 的 stdout/stderr 另进 systemd journal。

```bash
# 端侧日志查看方法

# 1. Android 平台 (logcat)——tag 为各模块编译期 TAGNAME，默认小写 "aadk"，
#    模块可覆盖（如 agent_runtime / ModelScheduler / system_agent / MediaCache）
adb logcat -s aadk:* agent_runtime:* ModelScheduler:* system_agent:*

# 2. Linux 平台：aadk_monitor_server 汇聚日志（滚动文件，默认单文件 25MB）
tail -f /data/logs/aadk.log
# 服务 stdout/stderr（journal）
journalctl -u agentcore.service -f --no-pager

# 3. 数据 dump 调试（输入图像/音频 + 输出文本落盘，DataDump 实现见 src/utils/data_dump.cpp）
# Linux 形态：system_agent 启动参数
system_agent --dump 1            # 可选 --upload 1 同时开启数据回传（§2.2）
# Android SDK 形态：系统属性（model_inference.cpp 在 init 时读取，改属性后需重启服务生效）
adb shell setprop persist.aadk.data_dump 1
# dump 目录为 <data_path>/dump（data_path 即运行时数据目录，Linux 形态如 /opt/agentcore/data/dump）
# 注意：个别分支上 dump 调用点被注释（MsgDeliverImpl::dump_data），开启无生效时先确认调用点是否启用

# 4. mini-dm DSP 日志
mini-dm  # 捕获 Hexagon DSP 实时日志
```

### 2.2 aadk\_monitor：日志汇聚与数据回传

`aadk_monitor` 是 aadkcore 的**日志汇聚 + 数据回传**组件（不是健康监控服务），由两部分组成：

| 组件 | 职责 | 入口 / 出口 |
| :--- | :--- | :--- |
| **aadk\_monitor\_server**（`monitor/src/monitor_server.cpp`，独立进程，systemd 单元 `aadk_monitor.service`，`Restart=always`） | Unix socket 日志汇聚：接收各组件 socket sink 发来的日志行，滚动写盘 | 监听 `/tmp/aadk_log.sock`（`-s` 可配）→ 写 `/data/logs/aadk.log`（`-f` 指定，单文件上限 `-m` 默认 25MB） |
| **aadk\_monitor 库**（`monitor/src/monitor.cpp` + `api_gateway`，链接进 system\_agent 进程） | 数据回传（badcase 收集）：异步上传请求/响应 JSON 及随路图像/音频到云端网关 | `system_agent --upload 1` 开启；走网关接口 `/api/v1/chat/log` 与资源上传接口（HMAC 签名） |

> [!NOTE]
> **常见误解澄清：aadkcore 未内置健康监控**
>
> 进程存活、内存水位、心跳、DSP 状态等健康检查**目前不在 aadkcore 内**：进程崩溃后的自动拉起依赖 systemd `Restart=always`（`agentcore.service`，RestartSec=5s）；内存水位线是建议的扩展方向（见 §3），当前需外部监控脚本按 VmRSS + dma-buf 口径采样实现。把 aadk\_monitor 当"健康监控"会找错排障入口——它的价值在于**统一日志出口**（`/data/logs/aadk.log`）与**线上 badcase 数据回传**。

### 2.3 性能数据采集 (Profiling)

aadkcore 的性能数据来自三个层次（早期厂商侧 `registerProfilingCallback` 上报链已在岚图分支停用删除，见 [岚图 · APK 侧集成](../lantu/apk-integration.html)，主线是否保留需核实）：

1. **框架层 —— `ModelResponse`**（`aadkapi/model_response.hpp`）：每次推理返回 `ttft`（ms）、`input_tokens`、`output_tokens`、`tokens_per_second` 与 `error_code`（`SUCCESS` / `MODEL_NOT_FOUND` / `MODEL_NOT_READY` / `MODEL_SUSPENDED` / `MODEL_GEN_STOPPED` / `MODEL_FAILURE`）。QNN 路径在 `StreamGenerate` 首个流式回调处计 TTFT、按 decode 时长算 TPS（`src/models/qnn/qnn_model.cpp`）。
2. **随响应回传的 `debug_info`**：`MsgDeliverImpl::get_debug_info` 把 `infer_start/infer_end/input_tokens/out_tokens/TTFT/TPS/AEG/VEG` 打进响应 JSON，调用端无需额外接口即可拿到单次请求性能数据。
3. **PERF 日志**：`model_runner.cpp` 输出 `PERF: ModelRunner::inference leave tps: ..., ttft: ..., output_tokens: ...`；`qnn_model.cpp` 另有 `preprocess time` / `first_token_time` / `duration` 等行，可直接 grep 做趋势分析。

> [!NOTE]
> **厂商 SDK 层的分段 Profiling：打开 DSP 黑盒的关键**
>
> 端侧 LLM 延迟排障最难的是"慢在 FastRPC 通信、HTP 计算还是排队等待"分不清。genai\_sdk（`third_party/genai_sdk/.../include/components/profiler.h`）提供 `ProfileEvent` 回调，可把单次推理拆成五段：`QNN_MODEL_EXECUTE`（整次推理）、`GRAPH_EXECUTE_HOST_RPC_TIME`（host 侧 RPC）、`GRAPH_EXECUTE_HTP_RPC_TIME`（HTP RPC）、`GRAPH_EXECUTE_ACCEL_TIME`（加速器执行）、`GRAPH_EXECUTE_ACCEL_EXCL_WAIT_TIME`（加速器独占等待）。**RPC 时间占比高 → 通信/调度问题；ACCEL 占比高 → 纯算力/带宽瓶颈；EXCL\_WAIT 高 → 多负载争抢 HTP**（对应 §1.3 的并发排队场景）。注意：aadkcore 基于它的上层上报链在岚图分支已删除，直接使用需在集成层自行注册回调（接口可用性以所用 SDK 版本为准）。

| 性能指标 | 采集方式 | 典型值（示例参数，非实测） | 异常阈值（示例） |
| :--- | :--- | :--- | :--- |
| **TTFT** | `ModelResponse.ttft` / `debug_info.TTFT` | 600-800 ms (S=350) | > 1500 ms |
| **TPOT** | 由 `tokens_per_second` 换算（TPOT ≈ 1000 / TPS） | 70-100 ms (~10-14 tok/s) | > 200 ms |
| **模型加载时间** | 框架未内置指标，用日志时间戳（load 前后 INFO 行）或外部计时 | 2-5 s (Context Binary) | > 10 s |
| **KV Cache 使用率** | 框架未暴露（由厂商 SDK 内部管理），按 [端侧调试与排障](../../general/troubleshooting.html) §3.2 公式由序列长度估算 | 变化范围 0-100% | 持续 > 80% |
| **NPU 利用率** | aadkcore 不采集，用 Snapdragon Profiler / qnn-profile-viewer | 推理时 > 90% | < 50% (可能有 fallback) |

> [!NOTE]
> **表中数字为示例参数**
>
> "典型值"与"异常阈值"两列均为**示例参数（非实测）**，仅示意量级与告警思路。TTFT 由算力决定（prefill compute-bound）、TPOT 由带宽决定（decode memory-bound），请按自己平台的 roofline/带宽模型推导预期值，再据此设定阈值，推导方法见 [LLM 推理原理与性能模型](../../general/infer-principles.html)；阈值本身应结合产品延迟预算设定。

> [!TIP]
> **调试工具选择指南**
>
> 快速参考（通用排障工具与流程详见 [**端侧调试与排障**](../../general/troubleshooting.html)，下称「通识排障篇」）：**精度问题** → qnn-net-run + AIMET 逐层分析（间歇性精度错误先看通识排障篇 §2.3 cache 一致性）；**性能问题** → qnn-profile-viewer + Snapdragon Profiler，框架侧单请求数据看 `debug_info` / PERF 日志（本篇 §2.3），通信 vs 计算 vs 排队分段看厂商 SDK `ProfileEvent`；**稳定性问题** → mini-dm + dmesg + `/data/logs/aadk.log`（aadk\_monitor\_server 汇聚，本篇 §2.2）；**内存问题** → VmRSS + `dmabuf_dump`（标准口径见通识排障篇 §3.3）；**FastRPC 问题** → 排障六步法（通识排障篇 §1.3）。先确定问题类别，再选对应工具，避免盲目排查。

## 3. 内存排障的 aadkcore 口径

内存构成、KV Cache OOM、VmRSS + dma-buf 监控口径等**通用方法**见 [端侧调试与排障 · §3 内存与 OOM 排障](../../general/troubleshooting.html)。本节只记 aadkcore 框架特有的两点。

> [!NOTE]
> **框架自带测试程序用的就是这套口径**
>
> aadkcore 的运行时测试程序（`runtime/src/test/new_api_test.cpp`）在每个测试步骤前后读取 `/proc/self/status` 的 **VmRSS / VmSize** 并打印前后差值（如 `[step 2] 内存: VmRSS xxxMB -> xxxMB`），用于确认模型加载/释放的内存增量符合预期——与 [端侧调试与排障 · §3.3](../../general/troubleshooting.html) 的标准口径同源。做加载/释放类排障时，可直接复用该测试程序的输出定位“哪一步内存没回落”。注意它只覆盖 CPU 侧 VmRSS，DSP 侧 dma-buf 仍需 `dmabuf_dump` 补测。

> [!WARNING]
> **aadkcore 未内置内存水位检查**
>
> 三级内存水位线（绿/黄/红）的通用设计见 [端侧调试与排障 · §3.3](../../general/troubleshooting.html)，但 **aadkcore 当前未内置该检查**：aadk\_monitor 的实际职责是日志汇聚与数据回传（见 §2.2），水位线检查需外部监控脚本（按 VmRSS + dma-buf 口径采样）或框架扩展实现；进程崩溃后的兜底拉起依赖 systemd `Restart=always`（`agentcore.service`，RestartSec=5s，见 §2.1）。
