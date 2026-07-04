# AIService 后端接入方案

## 1. 背景

### 1.1 当前推理链路

```
agent_group (各Dispatcher)
    → ModelRunner::schedule_run_sync(data_message, lora_name, system_prompt, user_prompt, ...)
        → ModelScheduler (优先级队列)
            → ModelInstance → ModelInstanceInner → BaseLlm
                → LlmRegistry::getLlm(model_name) 按前缀路由
                    ├── QnnModel   ("qnn/qwen.*")
                    ├── Bailian    ("bailian/qwen.*")
                    └── LapeModel  ("lape/Qwen.*")
```

aadkcore 已有完善的后端注册机制：
- `BaseLlm`：抽象基类，定义 `streamGenerate()`、`generate()`、`addLora()`、`preprocessImage()` 等接口
- `LlmRegistry`：工厂注册表，按 model_name 正则匹配路由到对应后端
- `REGISTER_LLM(ClassName, "pattern")`：宏注册，零侵入添加新后端
- `ModelInstance` / `ModelInstanceInner`：PIMPL 封装，对上层透明

### 1.2 目标

新增 AIService 后端，调用 VoyahAIService（`http://127.0.0.1:8090`），同时保持 agent_group 各 Dispatcher 的预处理、后处理、映射逻辑完全不变。

## 2. 需求

### 2.1 核心需求

- agent_group 各 Dispatcher **零改动**
- ModelRunner、ModelInstance **零改动**
- 仅通过修改 `multi_lora_runtime_config.json` 中的 model_name 前缀即可切换后端
- AIService 后端需支持：
  - 流式 SSE（OaiInferenceDispatcher 场景）
  - 非流式 JSON（InCarItemDetectDispatcher 场景）
  - LoRA 按请求动态切换（`extras.lora`）
  - 约束解码（`extras.ebnf_path` / `grammar_root_rule` / `enable_jump_forward`）
  - 图片传输：BGR 裸像素 Data URI（与现有 letterbox 预处理输出对齐）
  - 音频传输：Data URI

### 2.2 本期不包含

| 项目 | 原因 |
|------|------|
| 前缀缓存（prefix_name 的 KV cache 功能）| AIService API 未暴露，服务端内部管理。注：`prefix_name` 作为**每步标识符**用于约束解码的 `grammar_root_rule` 选择（见 §7.5.3），但其原有的 KV cache 前缀功能本期丢弃 |
| DeepStack 多模型级联 | AIService 内部管理，对 HTTP 客户端透明，本期不处理 |
| Embedding 接口 | 当前 agent_group 未使用，本期不接入 |

### 2.3 参数映射表

| aadkcore 现有参数 | AIService HTTP 字段 | 说明 |
|---|---|---|
| **模型与路由** | | |
| model_name（去掉 `aiservice/` 前缀）| `model` | 如 `"aiservice/qwen3-omni-4b"` → `"qwen3-omni-4b"` |
| **采样参数** | | |
| `GenerateConfig.temperature` | `temperature` | 默认 0.7；当 `greedy=true` 时强制为 0.0 |
| `GenerateConfig.top_p` | `top_p` | 默认 1.0 |
| `GenerateConfig.max_output_tokens` | `max_tokens` | 默认 2048 |
| `GenerateConfig.seed` | `seed` | 默认 42 |
| `GenerateConfig.frequency_penalty` | `frequency_penalty` | 默认 0.0 |
| `GenerateConfig.presence_penalty` | `presence_penalty` | 默认 0.0 |
| `GenerateConfig.response_mime_type` | `response_format` | `"application/json"` → `{"type": "json_object"}` |
| `GenerateConfig.stop_sequences` | 不传 | `vector<int>` token ID 无法转为 string，跳过 |
| **约束解码**（AIService 初始化时从 `multi_lora_runtime_config.json` 加载，见 §7.5.3） | | |
| lora_name（`lora_names_[lora_id]`）→ 配置查找 | `extras.ebnf_path` | EBNF 语法文件绝对路径（AIService 初始化时从配置加载，按 lora 名索引） |
| prefix_name（`LlmRequest.prefix_name()`）→ 配置查找 | `extras.grammar_root_rule` | 语法根规则名（AIService 按 `prefix_name` 查找配置中的 `grammar_root_rules` 映射） |
| lora_name → 配置查找 | `extras.enable_jump_forward` | **仅当 ebnf_path 非空时写入**；缺省时服务端默认 true |
| **LoRA** | | |
| `LlmRequest.lora_id()` → `lora_names_[id]` | `extras.lora.lora_adapter` | AIService 内部维护 `lora_names_`，`addLora()` 时存储路径字符串 |
| lora_name → 配置查找 | `extras.lora.lora_alpha` | 从 `multi_lora_runtime_config.json` 的 lora 配置中加载（缺省 2.0） |
| **消息内容** | | |
| `messages[].content`（TextContent）| `messages[].content`（string 或 `{question}` 对象）| 纯文本时 content 为 string |
| `messages[].content`（ImageBlob）| `messages[].content` = `{question, image: "data:image/bgr;..."}` | 裸像素/编码图 Data URI（自定义序列化，不复用 `to_json`） |
| `messages[].content`（AudioBlob）| `messages[].content` = `{question, audio: "data:audio/wav;base64,..."}` | PCM int16 → bytes → base64 Data URI |
| **流式控制** | | |
| `stream=true`（StreamCallback）| `"stream": true` + 自实现 SSE 帧解析 | 不复用 HttpClient 的 streamCallback 前缀剥离 |
| `stream=false`（CompletionCallback）| `"stream": false` | 整包 JSON |
| 新增 | `stream_options.include_usage` | `true`，用于获取 token 统计 |
| **历史消息** | | |
| `LlmRequest.history()` | `messages[]`（按序追加到 messages 数组）| system → history → current messages |
| **其他** | | |
| `prefix_name`（"cnyb-child"、"cnyb-left" 等）| 不传（但用于 AIService 内部约束解码规则查找）| KV cache 前缀功能丢弃；AIService 内部用 prefix_name 选择 `grammar_root_rule`（见 §7.5.3）|

## 3. 架构设计

### 3.1 总体思路

**完全复用现有的 `BaseLlm` → `LlmRegistry` → `REGISTER_LLM` 注册机制**，新增一个 `AIService` 后端类，与 `Bailian`（阿里云百炼 HTTP 后端）实现模式完全一致。

```
agent_group (各Dispatcher，零改动)
    → ModelRunner::schedule_run_sync()        (零改动)
        → ModelScheduler                       (零改动)
            → ModelInstance → ModelInstanceInner (零改动)
                → LlmRegistry::getLlm("aiservice/qwen3-omni-4b")
                    └── AIService (新增，仅此一个类)
                            │
                            │  POST http://127.0.0.1:8090/v1/chat/completions
                            │    model: "qwen3-omni-4b"
                            │    messages[].content = { question, image: "data:image/bgr;..." }
                            │    extras = { lora, ebnf_path, grammar_root_rule, enable_jump_forward }
                            ▼
                            VoyahAIService
```

### 3.2 后端对比

| | QnnModel | Bailian | AIService（新增）|
|---|---|---|---|
| 注册模式 | `"qnn/qwen.*"` | `"bailian/qwen.*"` | `"aiservice/.*"` |
| 通信方式 | 本地 QNN SDK | HTTP（libcurl）| HTTP（libcurl）|
| 流式支持 | 原生 | SSE via HttpClient | SSE 自实现帧解析器 |
| LoRA | `addLora()` + `lora_names_` 内部映射 | 不支持 | `addLora()` + `lora_names_` 内部映射 → `extras.lora` |
| 图片预处理 | `preprocessImage()` 本地 ViT | 不支持 | 不支持（服务端处理）|
| 约束解码 | `SetDecodeFormat(lora_name)` 内部 SDK | 不支持 | AIService 从 `multi_lora_runtime_config.json` 加载：`lora_name` → `ebnf_path`，`prefix_name` → `grammar_root_rule`（见 §7.5.3） |

### 3.3 文件变更

```
aadkcore/
├── include/models/
│   └── aiservice.hpp              # 新增：AIService 类声明（含 lora_names_、SSE buffer）
├── src/models/
│   └── aiservice.cpp              # 新增：AIService 实现（自定义序列化 + SSE 帧解析 + Data URI 编码）
├── include/utils/
│   └── http_client.hpp            # 修改：新增 streamAsyncRaw() 方法
├── src/utils/
│   └── http_client.cpp            # 修改：实现 streamAsyncRaw()
├── CMakeLists.txt                 # 修改：编译 aiservice.cpp
└── runtime/data/config/
    └── multi_lora_runtime_config.json  # 修改：model_name 改为 "aiservice/qwen3-omni-4b"
```

**agent_group：零改动。**

### 3.4 配置切换

仅需修改 `multi_lora_runtime_config.json` 中的 `model_name` 前缀：

```json
{
    "8397": {
        "multi_lora": {
            "base_model": {
                "model_name": "aiservice/qwen3-omni-4b",
                "config_path": "config/qwen3-omni-4b_8397.json"
            },
            "lora": [ ... ]
        },
        "model_name": "aiservice/qwen3-omni-4b",
        "model_config": "config/qwen3-omni-4b_8397.json"
    }
}
```

切换回 QNN 后端只需把 `"aiservice/"` 改回 `"qnn/"`。

## 4. 数据流分析：预处理与 ViT 处理的分层

### 4.1 两层"预处理"的区别

系统中存在两个不同层次的图像处理，需要明确区分：

| 层次 | 执行者 | 工作内容 | 是否改变 |
|------|--------|---------|---------|
| **Dispatcher 预处理** | agent_group 各 Dispatcher | 解码 → flip → letterbox/裁图 → 格式转换 → 输出 BGR/JPEG raw bytes 写入 `DataMessage.image_info` | **不变** |
| **ViT 预处理** | `BaseLlm::preprocessImage()` | BGR bytes → normalize → 选 ViT 档位 (448/1024) → 生成 vision embedding tensor | QNN 做，AIService 不做（由服务端做） |

### 4.2 Dispatcher 预处理（不变）

三个 Agent 在 Dispatcher 层完成的预处理工作完全保留：

**InCarItemDetect (scene_id=1100)**
```
原图 → imdecode/imread → cv::flip(水平翻转)
     → 设置 image_type=BGR, width/height=原图尺寸
     → 传入 ModelRunner（由底层按 resized_width/height 选择 ViT 档位）
```

**DressDetect (scene_id=1200)**
```
原图 → imdecode → cv::flip(水平翻转)
     → crop_by_voice_zone(voice_zone) 按说话人座位裁图
     → 设置 image_type=BGR, resized_width=448, resized_height=448（选择 small veg）
     → 传入 ModelRunner
```

**OutCarQA (scene_id=1300)**
```
原图 → imageInfoToMatBgr → cv::flip(camera_id==5 时)
     → Stage1: fillImageInfoWithJpeg(src, 1024, 768) → JPEG 编码
     → Stage2: crop_by_bbox_pad/crop_vehicle_mat → fillImageInfoWithJpeg(crop, 448, 448)
     → Stage3: 纯文本（无图）
     → 各阶段分别传入 ModelRunner
```

### 4.3 ViT 预处理（后端差异化）

`ModelRunner::inference()` 把 `DataMessage.image_info` 转换为 `message::ImageBlob` 写入 `MessageList`，然后调用 `ModelInstance::streamGenerate(messages, ...)`。

**QNN 后端**：`QnnModel::preprocessImage()` 从 `ImageBlob` 中取出 raw bytes，执行 normalize + ViT 推理生成 embedding tensor。

**AIService 后端**：`AIService::preprocessImage()` 返回 `std::nullopt`（与 `Bailian` 一致）。图片数据不走本地 ViT，而是在 `streamGenerate()` 中编码为 Data URI 通过 HTTP 发送，由 VoyahAIService 服务端完成 vision 预处理。

AIService 接口文档明确说明：
> "预处理：类型 1 与类型 2 均在服务端完成 vision 预处理（含 letterbox、ViT 档位匹配）。类型 2 的 {W}、{H} 可与 ViT 输入尺寸一致，亦可为原始分辨率，由服务端按模型配置处理。"

### 4.4 数据流全链路

```
Dispatcher 层（不变）
    │
    │  flip + letterbox/crop + 格式转换
    │  输出: DataMessage.image_info (BGR raw / JPEG / PNG bytes)
    │  含: width, height, resized_width, resized_height, image_type
    ▼
ModelRunner::inference()  （不变）
    │
    │  data_message.image_info → message::ImageBlob (含 mime_type, W, H, resized_W, resized_H)
    │  写入 MessageList
    ▼
ModelInstance::streamGenerate(messages, lora_id, infer_params)  （不变）
    │
    ├─→ QnnModel:
    │     streamGenerate() → buildLlmsPrompt()
    │       → 对每个 ImageBlob 调用 preprocessImage_deepstack()（私有方法）
    │         → MultiVegModel::get_vit_shape(resized_W, resized_H)
    │           → 1024×768 → veg_model_large_
    │           → 448×448  → veg_model_small_
    │           → 其他     → fallback small
    │         → qwen2_vl_processor::preprocessImage()
    │           → BGR→RGB + letterbox resize + normalize + patch 提取
    │         → MultiVegModel::Predict() → vision embedding tensor
    │       → prompt.Append(Image(tensor))
    │     同理 AudioBlob → preprocessAudio() → AEG embedding
    │     最终 → GenAI SDK 本地推理
    │
    └─→ AIService:
          streamGenerate() → buildOpenAIMessages()（自定义序列化）
            → 对每个 ImageBlob 调用 encodeImageData()
              → base64 → Data URI（含 W/H/channels）
            → 对每个 AudioBlob 调用 encodeAudioData()
              → PCM int16 → bytes → base64 → Data URI
          → buildRequestBody()（含采样参数 + extras）
          → POST /v1/chat/completions
          → 服务端完成:
            - 解码 Data URI
            - letterbox resize（如客户端未做）
            - ViT 档位选择（veg_small / veg_large）
            - normalize + patch + vision embedding
            - 音频: Mel 频谱 + AEG embedding
            - LLM 推理
          → SSE/JSON 响应
```

### 4.5 多 ViT 切换差异分析

QNN 后端在客户端完成 ViT 档位选择，AIService 由服务端完成。两者的选择逻辑等价：

| resized_width × resized_height | QNN 选择 | AIService 服务端选择 | 对应场景 |
|---|---|---|---|
| 448 × 448 | `veg_model_small_` | `veg_small` | DressDetect（裁图后）|
| 1024 × 768 | `veg_model_large_` | `veg_large` | OutCarQA Stage1（JPEG 缩放后）|
| 原图尺寸 | fallback small + warning | 服务端自动 letterbox + 选档 | InCarItemDetect（原图 BGR）|

**AIService 的三种图片传输模式**（对应 `VoyahAIBanmaExample.cpp` 的三种菜单）：

| 模式 | Data URI 格式 | 服务端行为 | 对应本方案 |
|------|-------------|----------|----------|
| 编码图 (PNG/JPG) | `data:image/png;base64,...` | 解码 → letterbox → ViT 选档 | OutCarQA 的 JPEG |
| 原图裸像素 | `data:image/bgr;width=W;height=H;channels=3;base64,...` | letterbox → ViT 选档 | InCarItemDetect 的 BGR |
| 客户端 letterbox 裸像素 | `data:image/bgr;width=1024;height=768;channels=3;base64,...` | 直接选 `veg_large` | DressDetect 448×448 / OutCarQA 1024×768 |

本方案采用**原图裸像素模式**：Data URI 中的 `width`/`height` 取自 `ImageBlob.width`/`height`（即 Dispatcher 输出的实际像素尺寸），服务端根据尺寸自动 letterbox 并选择 ViT 档位。这与 Dispatcher 层的 `resized_width`/`resized_height` 设置一致——Dispatcher 已经完成了裁图/缩放，输出尺寸即为 ViT 期望输入尺寸。

### 4.6 预处理调用链差异

**QNN 后端**：`preprocessImage()` 在 `streamGenerate()` 内部的 `buildLlmsPrompt()` 中被调用（`qnn_model.cpp:1108`），是 QnnModel 的私有方法。调用时机是在构建推理 prompt 时，对 Message 中的每个 `ImageBlob`/`AudioBlob` 即时做 ViT/AEG 推理，生成 embedding tensor 后附加到 `Prompt` 对象。

**AIService 后端**：`preprocessImage()` 返回 `std::nullopt`（与 Bailian 一致）。外部不会调用它，`streamGenerate()` 内部也不需要它——图片/音频以原始 Data URI 形式发送，由服务端完成全部 vision/audio 预处理。

**关键验证**：`ModelRunner::preprocessImage()`（`model_runner.cpp:715`）是一个返回 `std::nullopt` 的 stub，生产环境中**没有任何代码路径**在 `streamGenerate()` 之前外部调用 `preprocessImage()`。唯一的外部调用在 `examples/model_sample/main.cpp:439`（示例代码），不影响生产流程。因此 AIService 返回 `nullopt` 完全安全。

### 4.7 上下文（History）管理差异

**QNN 后端**：使用 `PromptHistroyManager` 维护内部状态。每轮推理后，KV cache 和 vision embedding 被存储在 `PromptHistroy` 对象中。后续轮次通过 `history()` 传入，`buildLlmsPrompt()` 直接引用已缓存的 embedding tensor，**无需重新处理图片**。

**AIService 后端**：每个 HTTP 请求是**无状态**的，包含完整的消息历史。`buildOpenAIMessages()` 将 `request.history()` 和 `request.messages()` 合并为扁平 messages 数组发送给服务端。服务端自行管理 KV cache（对客户端透明）。

**注意**：如果历史消息中包含图片（`ImageBlob`），每次请求都会重新 base64 编码并发送，服务端也会重新处理。对于当前的三个 Agent（InCarItemDetect、DressDetect、OutCarQA），推理流程均为单轮或两轮独立推理（非多轮图片对话），此开销可接受。

> **约束声明**：本方案对无状态图片重传的开销评估依赖于当前 Agent 的单轮/独立多阶段推理模式。如果未来新增多轮图片对话 Agent（例如连续多轮追问同一张图片的细节），每次请求都需重新 base64 编码并上传完整图片数据，带宽和延迟开销将显著增加。届时需重新评估此设计，考虑引入服务端图片缓存机制（如按图片 hash 索引）或切换为有状态会话模式。

### 4.8 两阶段推理兼容性

Agent 100（InCarItemDetect，Legacy scene_id=1100）和 Agent 300（OutCarQA，scene_id=1300）均采用两阶段/三阶段推理：

> **场景 ID 映射说明**：BanmaExample 中 `scenes.json` 的 `scenario_id=100`（`incar_item_left_detection`）与 Legacy `constant_ids.h` 中的 `INCAR_ITEM_DETECT_SCENARIO_ID=1100` 实现相同的业务逻辑（舱内遗留物+儿童检测），但通过完全不同的架构路径——前者是独立的 HTTP 客户端直接读取 `scenes.json` 配置，后者是 C++ Dispatcher 通过 PromptManager + ModelRunner 调用。

- **InCarItemDetect**：Step1（**儿童检测**，prompt key=`person_desc`）和 Step2（**遗留物检测**，prompt key=`incar_item_detect`）是**独立的推理请求**，各自带完整的 system/user prompt 和同一张图片。Step2 不依赖 Step1 的输出。儿童优先于遗留物检测，因为儿童安全优先级更高。
- **OutCarQA**：Stage1（grounding）→ Stage2（caption）→ Stage3（NLG），各阶段独立，Stage2 使用 Stage1 输出的 bbox 裁图后作为新图片输入。

**AIService 兼容性**：`VoyahAIBanmaExample.cpp` 的 Scene 100 实现（:1298-1359）展示了相同的两阶段模式——两次独立的 `httpChatCompletionOnce()` 调用，各自带不同的 `grammar_root_rule`（step1 为 `age_and_pos`，step2 为 `leftover`）。AIService 后端天然支持此模式，因为每次 HTTP 请求都是独立的。Dispatcher 层的多阶段编排逻辑不变。

### 4.9 Prompt 组织与传递链路分析

这是 AIService 后端接入中**最容易被忽视但影响模型输出质量**的关键问题。QNN 和 AIService 两条路径的 prompt 组装方式存在本质差异。

#### 4.9.1 QNN 路径的 prompt 组装（以 Agent 100 InCarItemDetect 为例）

完整调用链路：

1. InCarItemDetectDispatcher 构造时通过 `PromptManager` 加载 YAML 模板文件（`data_path + "/template/incar_item_detect.yaml"`），C++ 中硬编码的是 YAML 文件路径和 prompt key 名称（如 `"incar_item_detect.system_prompt"`、`"person_desc.user_prompt"`），而 prompt 的实际内容存储在 YAML 文件中
2. 推理时通过 `prompt_manager_->getPrompt("person_desc.system_prompt")` 等方法取出 prompt 文本，传入 `ModelRunner::schedule_run_sync()`
3. ModelRunner 构造 MessageList: [SYSTEM: system_prompt, USER: user_prompt + ImageBlob]
4. QnnModel::streamGenerate() 内部调用 buildLlmsPrompt()
5. buildLlmsPrompt() 使用 minja 引擎渲染 Jinja2 chat_template（来自 config.json）
6. 在 user 消息中插入图片和音频标记
7. 最终生成带 Qwen3 special tokens 的完整 prompt 文本
8. 送入 GenAI SDK 做本地推理

关键点：chat_template 的渲染发生在 QnnModel 内部，Dispatcher 只需要提供纯文本 prompt。

#### 4.9.2 AIService 路径的 prompt 组装

AIService 后端将 MessageList 转为 OpenAI 格式的 JSON messages 数组，通过 HTTP POST 发送给服务端。服务端内部有自己的 chat_template 渲染逻辑（来自 prompt.json + config.json）。

关键差异：QNN 在客户端渲染 chat_template，AIService 在服务端渲染。

#### 4.9.3 Prompt 等价性验证（Agent 100 案例分析）

以 InCarItemDetect (scene_id=1100) 为例：

- Dispatcher 通过 PromptManager 从 YAML 文件加载的 system_prompt 和 user_prompt 内容不变
- QNN 路径：Dispatcher → PromptManager 从 YAML 加载 prompt → QnnModel chat_template 渲染 → GenAI SDK
- AIService 路径：Dispatcher → PromptManager 从 YAML 加载 prompt → HTTP messages JSON → 服务端 chat_template 渲染 → 推理

两条路径的 prompt 文本输入完全相同（来自同一个 Dispatcher 的同一个 YAML 文件），差异仅在于 chat_template 的渲染位置不同。

验证方法：对比 QNN 和 AIService 对同一张图片、同一组 prompt 的输出结果，确认模型行为一致。

#### 4.9.4 AIService 示例中的 prompt 配置体系

AIService 提供的示例（VoyahAIBanmaExample）使用了独立的 prompt 管理体系：

- scenes.json: 定义每个场景的 LoRA、EBNF、YAML 模板路径
- YAML 模板: 定义 system_prompt 和 user_prompt 的具体内容
- prompt.json: 定义 chat_template 的特殊 token（与 QNN 的 config.json 等价）

这些配置仅用于示例程序，不影响 AIService C++ 后端的实现。C++ 后端直接使用 Dispatcher 提供的 prompt，不依赖 scenes.json 或 YAML 模板。

#### 4.9.5 两套 Prompt 管理体系对比

| 维度 | Legacy (agent_group + aadkcore) | AIService 示例 (BanmaExample) |
|------|-------------------------------------|------------------------------------|
| Prompt 来源 | Dispatcher 构造时硬编码 YAML 路径，通过 `PromptManager` 加载 | `scenes.json` → `template_file` 动态配置，客户端解析 YAML |
| Prompt Key | C++ 中硬编码（如 `"incar_item_detect.system_prompt"`） | `scenes.json` → `template_key` / `template_key_step2` |
| LoRA 名称 | C++ 常量（如 `LORA_NAME = "incar_item_detect"`） | `scenes.json` → `lora_adapter: "cnyb"` |
| LoRA alpha | 固定值（由 `multi_lora_runtime_config.json` 配置） | `scenes.json` → `lora_alpha`（每场景可独立配置） |
| 约束解码参数 | 不传递（Dispatcher 层无此逻辑） | `scenes.json` → `json_schema_path` + `grammar_root_rule` |
| 结果模板路径 | Dispatcher 构造时硬编码（如 `data_path + "/template/result_template.json"`） | `scenes.json` 根节点 → `result_template_file` |
| Chat Template 格式 | `config.json` 中的 Jinja2 模板（QNN 客户端渲染） | `prompt.json` 定义特殊 token（服务端渲染） |
| 新增场景 | 需编写新 C++ Dispatcher 类 + 注册到 `agent_factory.cpp` | 仅需在 `scenes.json` 添加条目 + YAML 文件 |

本期 AIService C++ 后端走 Legacy 路径（Dispatcher 提供 prompt，不依赖 scenes.json）。长远来看，若要实现“配置化新增场景”，可考虑让 AIService 后端直接读取 scenes.json 配置，从而绕过 Dispatcher 层的硬编码。

## 5. 各 Agent 影响分析

### 5.1 InCarItemDetectDispatcher（scene_id=1100）

| 环节 | 当前实现 | 切换 AIService 后 | 影响 |
|------|---------|-------------------|------|
| 消息解析 | `parse_input()` 解析 content JSON → AgentInput | 不变 | 无 |
| 图像预处理 | flip + 设置 BGR raw | 不变 | 无 |
| Step1 推理（儿童检测） | `schedule_run_sync(msg, "incar_item_detect", person_desc.system_prompt, person_desc.user_prompt, ...)` | 不变（底层路由到 AIService） | 无 |
| Step2 推理（遗留物检测） | `schedule_run_sync(msg, "incar_item_detect", incar_item_detect.system_prompt, incar_item_detect.user_prompt, ...)` | 不变 | 无 |
| 结果解析 | `parse_lora_output()` 区域映射 + 物品映射 | 不变 | 无 |
| 结果组装 | `build_reply()` 填充 result_template | 不变 | 无 |

> **注意**：Step1 和 Step2 使用同一个 LoRA 适配器（`LORA_NAME = "incar_item_detect"`，对应 AIService 的 `"cnyb"`），但 prompt 不同：
>
> | 步骤 | LoRA 名称 | Prompt Key | 内容 |
> |------|------------|-----------|------|
> | Step1（儿童检测） | `incar_item_detect` | `person_desc.system_prompt` / `person_desc.user_prompt` | 乘客年龄/座位识别 |
> | Step2（遗留物检测） | `incar_item_detect` | `incar_item_detect.system_prompt` / `incar_item_detect.user_prompt` | 遗留物品检测 |

### 5.2 DressDetectDispatcher（scene_id=1200）

| 环节 | 当前实现 | 切换 AIService 后 | 影响 |
|------|---------|-------------------|------|
| 消息解析 | `parse_input()` 解析 voice_zone + member_info | 不变 | 无 |
| 图像预处理 | flip + `crop_by_voice_zone()` + 设置 BGR raw | 不变 | 无 |
| 推理 | `schedule_run_sync(msg, "cloth_detect", ...)` | 不变 | 无 |
| 结果解析 | `parse_clothing_output()` + 兜底逻辑 | 不变 | 无 |
| 结果组装 | `build_reply()` 填充 dress_and_state | 不变 | 无 |

### 5.3 OutCarQADispatcher（scene_id=1300）

| 环节 | 当前实现 | 切换 AIService 后 | 影响 |
|------|---------|-------------------|------|
| 消息解析 | `parse_query_from_message()` 解析 query/camera_id | 不变 | 无 |
| Stage1 预处理 | `fillImageInfoWithJpeg(src, 1024, 768)` | 不变 | 无 |
| Stage1 推理 | `schedule_run_sync(msg, "grounding_sr/base", ...)` | 不变 | 无 |
| Stage1 结果 | `parseMaybeEscapedJson()` → label/bbox | 不变 | 无 |
| Stage2 预处理 | `crop_by_bbox_pad()` + `fillImageInfoWithJpeg(crop, 448, 448)` | 不变 | 无 |
| Stage2 推理 | `schedule_run_sync(msg, model_name, ...)` | 不变 | 无 |
| Stage3 推理 | `schedule_run_sync(msg, "visual_assistant", ...)` 纯文本 | 不变 | 无 |
| 流式输出 | 三阶段哨兵 `<STAGE_1/2/3_END>` | 不变 | 无 |
| 结果组装 | `generate_model_result()` + `fill_detected_item_by_label()` | 不变 | 无 |

**结论：三个 Agent 的消息解析、图像处理、推理调用、结果映射全部不受影响。**

## 6. 接口合规性验证

### 6.1 与 AIService 接口文档的对照

| 检查项 | VoyahAIBanmaExample.cpp 示例 | AIService 接口文档 §3.2 | AIService 后端实现 |
|--------|------------------------------|------------------------|-------------------|
| messages content 格式 | `content: { question, image }` | ✅ object 时识别 `question`/`image`/`audio` 键 | ✅ 一致 |
| 图片类型 1（编码图） | `data:image/png;base64,...` | ✅ `image/png` 或 `image/jpg` | ✅ 一致 |
| 图片类型 2（裸像素） | `data:image/bgr;width=W;height=H;channels=3;base64,...` | ✅ `image/bgr` 或 `image/rgba` + width/height/channels | ✅ 一致 |
| extras.lora | `{ lora_adapter, lora_alpha }` | ✅ per-request，与 lora 同现 | ✅ 一致 |
| extras.ebnf_path | 文件绝对路径 | ✅ 非空时启用约束解码 | ✅ 一致 |
| extras.grammar_root_rule | `"age_and_pos"` / `"leftover"` | ✅ 与 ebnf_path 配套，覆盖默认根规则 | ✅ 一致 |
| extras.enable_jump_forward | true/false | ✅ 缺省且 ebnf 非空时默认 true | ✅ 一致 |
| 流式 SSE | `data: {...}\n\n` + `data: [DONE]` | ✅ `choices[].delta.content`，帧间 `\n\n` | ✅ 一致 |
| 非流式 JSON | `choices[0].message.content` | ✅ 整包返回 | ✅ 一致 |
| 错误体 | `{ error: { message, type, param, code } }` | ✅ code: `model_not_found` / `model_not_ready` | ✅ 一致 |
| model 字段 | model id 字符串 | ✅ 与 `GET /v1/models` 返回的 `data[].id` 对应 | ✅ 一致 |

### 6.2 与 VoyahAIBanmaExample.cpp 示例的差异

| 项目 | VoyahAIBanmaExample.cpp | AIService 后端 | 说明 |
|------|------------------------|---------------|------|
| HTTP 客户端 | `httplib::Client` | `HttpClient`（libcurl） | 协议层等价，不引入新依赖 |
| 图片 base64 | 手写 `base64Encode()` | 复用 `xtl::xbase64` | 编码结果一致 |
| SSE 解析 | 手动 buffer + `\n\n` 分割 | AIService 自实现 SSE 帧解析器（buffer + `\n\n` 分割 + `data:` 剥离），不复用 `HttpClient::streamCallback` 的前缀剥离逻辑 | 功能等价；HttpClient 仅剥离首个 `data: ` 前缀，多帧缓冲时会出问题 |
| 场景 100 两阶段 | 客户端编排 step1/step2 | Dispatcher 编排（不变） | 编排逻辑在 Dispatcher 层，不在后端层 |

## 7. 实现细节

### 7.1 AIService 类设计

参照 `Bailian` 的实现模式：

```cpp
// include/models/aiservice.hpp
class AIService : public BaseLlm {
public:
    explicit AIService(const std::string& model_name);

    // BaseLlm 接口实现
    std::vector<std::string> supported_models() override;
    Receiver<std::string> generateContentAsync(const LlmRequest& request, bool stream) override;
    ModelResponse streamGenerate(const LlmRequest& request, StreamCallback stream_callback,
                                 void* user_data, bool stream = true) override;
    void generate(const LlmRequest& request, CompletionCallback completion_callback,
                  void* user_data) override;
    void initFromConfig(const std::string& config_path) override;
    bool is_ready() override { return true; }  // 同 Bailian，服务端管理模型生命周期
    void suspend(bool deinit = true) override {}  // 空操作
    void resume() override {}  // 空操作

    // LoRA 管理：镜像 QnnModel 的 lora_names_ 模式
    // ModelRunner::init_model_instance() 调用 addLora({"cnyb"}) 时存储路径字符串，
    // streamGenerate() 时通过 lora_id 索引恢复字符串写入 extras.lora
    std::vector<int> addLora(std::vector<std::string> lora_paths) override;

    std::optional<std::shared_ptr<std::vector<float>>> preprocessImage(...) override { return std::nullopt; }
    std::optional<std::shared_ptr<std::vector<float>>> preprocessAudio(...) override { return std::nullopt; }
    bool stopGenerate() override { return false; }

private:
    std::string api_host_;       // "http://127.0.0.1:8090/v1/chat/completions"
    std::string model_name_;     // 去掉 "aiservice/" 前缀后的实际 model id

    // LoRA 名称映射（同 QnnModel::lora_names_）
    // addLora() 时追加，lora_id 即为 vector 下标
    std::vector<std::string> lora_names_;

    // 约束解码 + lora_alpha 配置（从 multi_lora_runtime_config.json 加载）
    struct LoraExtraConfig {
        std::string ebnf_path;
        bool enable_jump_forward = true;
        std::unordered_map<std::string, std::string> grammar_root_rules;  // prefix_name → rule
        double lora_alpha = 2.0;  // 缺省值 2.0
    };
    std::unordered_map<std::string, LoraExtraConfig> lora_extra_configs_;  // lora_adapter → config

    // 从 LlmRequest 构建完整的 AIService HTTP JSON body
    nlohmann::json buildRequestBody(const LlmRequest& request, bool stream);
    // 自定义消息序列化（不复用 message.hpp 的 to_json，因其跳过 ImageBlob/AudioBlob）
    nlohmann::json buildOpenAIMessages(const LlmRequest& request);
    // 图片 Data URI 编码
    std::string encodeImageData(const message::ImageBlob& blob);
    // 音频 Data URI 编码（PCM int16 → bytes → base64）
    std::string encodeAudioData(const message::AudioBlob& blob);
    // SSE 帧解析（buffer + \n\n 分割 + data: 剥离 + JSON 解析）
    void parseSSEFrames(const std::string& raw_chunk, StreamCallback callback, void* user_data);
    std::string sse_buffer_;  // SSE 跨 chunk 缓冲
};
```

注册：

```cpp
// src/models/aiservice.cpp
REGISTER_LLM(AIService, "aiservice/.*");
```

### 7.2 HTTP 请求组装

`buildRequestBody()` 核心逻辑：

```
LlmRequest
    ├─ model: model_name_（去掉 aiservice/ 前缀）
    ├─ messages: buildOpenAIMessages() 自定义序列化（见 §7.2.1）
    ├─ 采样参数:
    │   ├─ temperature: config.greedy ? 0.0 : config.temperature
    │   ├─ top_p: config.top_p
    │   ├─ max_tokens: config.max_output_tokens
    │   ├─ seed: config.seed
    │   ├─ frequency_penalty: config.frequency_penalty
    │   ├─ presence_penalty: config.presence_penalty
    │   └─ response_format: {"type": "json_object"}  (当 response_mime_type == "application/json")
    ├─ stream: true/false
    ├─ stream_options: {"include_usage": true}  (用于获取 token 统计)
    └─ extras:
        ├─ lora: { lora_adapter, lora_alpha }   // lora_adapter 从 lora_names_[lora_id] 获取，lora_alpha 从 lora_extra_configs_ 加载（缺省 2.0）（见 §7.5）
        ├─ ebnf_path: "..."                      // AIService 从配置加载：lora_name → ebnf_path（见 §7.5.3）
        ├─ grammar_root_rule: "..."              // AIService 从配置加载：prefix_name → grammar_root_rule（见 §7.5.3）
        └─ enable_jump_forward: true/false       // 仅当 ebnf_path 非空时写入；缺省时服务端默认 true
```

#### 7.2.1 消息序列化：`buildOpenAIMessages()`

**重要**：不复用 `message.hpp` 的 `adl_serializer<ContentType>::to_json`，因为该序列化器**显式跳过 `ImageBlob` 和 `AudioBlob`**（序列化为空 JSON）。需要自定义序列化逻辑。

消息组装顺序（与 OpenAI API 对齐）：

1. `config.system_instruction`（如有）→ `{ "role": "system", "content": "..." }`
2. `request.history()` → 按序追加（历史 user/assistant 轮次）
3. `request.messages()` → 按序追加（当前请求消息）

每条消息的序列化规则：

```cpp
nlohmann::json buildOpenAIMessages(const LlmRequest& request) {
    nlohmann::json messages = nlohmann::json::array();

    // 1. system instruction（如有）
    if (request.config().system_instruction.has_value()) {
        messages.push_back({
            {"role", "system"},
            {"content", *request.config().system_instruction}
        });
    }

    // 2. history + current messages 合并为扁平数组
    auto all_msgs = request.history();
    auto cur = request.messages();
    all_msgs.insert(all_msgs.end(), cur.begin(), cur.end());

    for (const auto& msg : all_msgs) {
        std::string text;
        std::vector<std::string> image_uris;
        std::vector<std::string> audio_uris;

        // 提取各类内容
        for (const auto& c : msg.content) {
            if (auto* tc = std::get_if<message::TextContent>(&c))
                text += tc->text;
            else if (auto* ib = std::get_if<message::ImageBlob>(&c))
                image_uris.push_back(encodeImageData(*ib));
            else if (auto* ab = std::get_if<message::AudioBlob>(&c))
                audio_uris.push_back(encodeAudioData(*ab));
            // FunctionCall / FunctionResponse：当前 Agent 不使用，后续迭代
        }

        nlohmann::json j_msg = {{"role", roleToString(msg.role)}};

        if (image_uris.empty() && audio_uris.empty()) {
            // 纯文本
            j_msg["content"] = text;
        } else if (!image_uris.empty()) {
            // 含图片 → { question, image } 对象
            j_msg["content"] = {
                {"question", text},
                {"image", image_uris[0]}  // 单图
                // 多图待验证：可能需要 {"images", image_uris}
            };
        } else {
            // 含音频 → { question, audio } 对象
            j_msg["content"] = {
                {"question", text},
                {"audio", audio_uris[0]}
            };
        }
        messages.push_back(j_msg);
    }
    return messages;
}
```

**关键差异 vs Bailian**：Bailian 直接用 `nlohmann::json` 序列化 `request.messages()`，依赖 `to_json`（跳过 ImageBlob），所以 Bailian 实际无法发送图片。AIService 必须自定义序列化。

> **设计决策记录**：`buildOpenAIMessages()` 刻意不复用 `message.hpp` 的 `adl_serializer<ContentType>::to_json`。原因是该序列化器对 `ImageBlob` 和 `AudioBlob` 输出空 JSON（显式跳过），而 AIService 需要将这些二进制数据编码为 Data URI。即使后续 `to_json` 被修改为支持 ImageBlob（例如其他后端需要），此处的自定义序列化逻辑仍应独立维护，因为 AIService 的 `{question, image}` 格式与 `to_json` 的通用序列化格式不同。

### 7.3 图片编码

复用 `HttpClient`（基于 libcurl，已链接到 aadkcore），不引入新依赖。

`ModelRunner::inference()` 已将 `DataMessage.image_info` 转为 `ImageBlob` 并设置 mime_type：
- `image_type == BGR` → mime_type = `"image/raw"` → 编码为 `data:image/bgr;width={W};height={H};channels=3;base64,{payload}`
- `image_type == RGBA` → mime_type = `"image/raw"` → 编码为 `data:image/rgba;width={W};height={H};channels=4;base64,{payload}`
- `image_type == JPEG` → mime_type = `"image/jpeg"` → 编码为 `data:image/jpeg;base64,{payload}`
- `image_type == PNG` → mime_type = `"image/png"` → 编码为 `data:image/png;base64,{payload}`

**width/height 来源**：裸像素 Data URI 中的 `W`/`H` 取自 `ImageBlob.width`/`height`（即 Dispatcher 输出的实际像素尺寸，等于 `DataMessage.image_info.width`/`height`）。服务端根据这些尺寸自动选择 ViT 档位并执行 letterbox（见 §4.5）。

注意：`mime_type == "image/raw"` 时需检查 `ImageBlob.channels` 判断实际像素格式（channels==3 → BGR，channels==4 → RGBA），以生成正确的 Data URI。

Base64 编码复用现有的 `xtl::xbase64`（已在 QnnModel 中使用）。

#### 7.3.1 多图处理（extra_images）

`ModelRunner::inference(ModelDetails overload)` 会将 `data_message.extra_images` 作为额外的 `ImageBlob` 追加到同一个 user message。当前 AIService 的 `{question, image}` 格式仅支持单图。

**处理策略**：
- 当一条 message 包含多个 `ImageBlob` 时，取第一张图放入 `content.image`
- 后续图片拆分为独立的 user message（每帧一条消息）
- 需在实际对接时验证 VoyahAIService 是否支持多图数组格式，若支持则改为 `{"images": [...]}`

> **优先级**：在实际对接 VoyahAIService 的第一步即验证多图支持。拆分 message 会改变对话结构，可能影响服务端的多轮上下文理解，因此若服务端支持多图数组格式，应优先采用数组方式。

#### 7.3.2 音频编码

`AudioBlob.data` 是 `std::vector<int16_t>` PCM 数据（16kHz 单声道，由 `loadWavAudioData()` 解析 WAV 后得到）。

编码步骤：
1. 将 `int16_t[]` 转为 `uint8_t[]`（小端序，ARM/x86 原生字节序，直接 `reinterpret_cast`）
2. base64 编码（复用 `xtl::xbase64`）
3. 构造 Data URI：`data:audio/wav;base64,{base64_encoded_data}`

```cpp
std::string encodeAudioData(const message::AudioBlob& blob) {
    const auto* raw_bytes = reinterpret_cast<const uint8_t*>(blob.data.data());
    size_t byte_size = blob.data.size() * sizeof(int16_t);
    std::string b64 = xtl::xbase64::encode(raw_bytes, byte_size);
    return "data:audio/wav;base64," + b64;
}
```

### 7.4 流式回调与 SSE 帧解析

#### 7.4.1 不复用 HttpClient::streamCallback 的原因

`HttpClient::streamCallback`（`http_client.cpp:55-79`）仅剥离 CURL 缓冲区**第一个** `"data: "` 前缀。当 CURL 一次投递多个 SSE 帧时（高吞吐场景常见）：

```
data: {"choices":[{"delta":{"content":"hello"}}]}\n\n
data: {"choices":[{"delta":{"content":" world"}}]}\n\n
data: [DONE]\n\n
```

只有首行 `data: ` 被去掉，后续帧的前缀保留，传入 `JsonStreamHandler` 的 SAX 解析器会导致解析失败。

`VoyahAIBanmaExample.cpp`（:1710-1746）的正确做法：缓冲 → 按 `\n\n` 分割 → 逐帧剥离 `data:` → 解析 JSON。

#### 7.4.2 实现方案

在 `HttpClient` 中新增 `streamAsyncRaw()` 方法（不剥离前缀，传递原始 CURL 数据），AIService 自己实现完整的 SSE 帧解析器：

```cpp
// HttpClient 新增方法
void streamAsyncRaw(const std::string& url, const std::string& api_key,
                    const std::string& json_body, ChunkCallback raw_callback);
// 与 streamAsync 相同，但 CURLOPT_WRITEFUNCTION 使用不剥离前缀的回调

// AIService 的 SSE 帧解析器
void parseSSEFrames(const std::string& raw_chunk, StreamCallback callback, void* user_data) {
    sse_buffer_ += raw_chunk;
    size_t pos;
    bool done_received = false;
    while ((pos = sse_buffer_.find("\n\n")) != std::string::npos) {
        std::string frame = sse_buffer_.substr(0, pos);
        sse_buffer_ = sse_buffer_.substr(pos + 2);

        if (done_received) continue;  // [DONE] 后丢弃残留数据

        // SSE 规范：多行 data 字段拼接（data: line1\ndata: line2 → "line1\nline2"）
        std::string data;
        std::istringstream stream(frame);
        std::string line;
        while (std::getline(stream, line)) {
            if (line.rfind("data: ", 0) == 0)
                data += (data.empty() ? "" : "\n") + line.substr(6);
            else if (line.rfind("data:", 0) == 0)
                data += (data.empty() ? "" : "\n") + line.substr(5);
        }

        // 终止信号
        if (data == "[DONE]") { done_received = true; break; }

        // 解析 JSON，提取 choices[0].delta.content 或 choices[0].message.content
        auto j = nlohmann::json::parse(data, nullptr, false);
        if (j.is_discarded()) {
            // 记录 WARN 日志以便调试 SSE 解析异常
            LOG_WARN("AIService SSE: JSON parse failed, frame=%s", data.substr(0, 128).c_str());
            continue;
        }

        // 兼容流式（delta.content）和非流式（message.content）两种格式
        std::string content;
        if (j.contains("choices") && j["choices"].is_array() && !j["choices"].empty()) {
            const auto& c0 = j["choices"][0];
            if (c0.contains("delta") && c0["delta"].is_object())
                content = c0["delta"].value("content", "");
            else if (c0.contains("message") && c0["message"].is_object())
                content = c0["message"].value("content", "");
        }
        if (!content.empty())
            callback(content, false, user_data);
    }
}
```

**SSE 解析健壮性设计要点**：
- **多行 data 拼接**：SSE 规范允许单帧包含多个 `data:` 行（`data: line1\ndata: line2\n\n`），解析后拼接为 `"line1\nline2"`。虽然多数实现不会使用多行 data，但防御性处理可避免未来兼容问题
- **JSON 解析失败日志**：解析失败时记录 WARN 级别日志（截取前 128 字符），便于排查 SSE 帧格式异常，同时避免日志过大
- **`[DONE]` 后残留处理**：收到 `[DONE]` 信号后，丢弃 `sse_buffer_` 中的残留数据，防止误解析

#### 7.4.3 非流式响应

`stream=false` 时，响应为整包 JSON，直接提取 `choices[0].message.content` 即可，无需 SSE 解析。

### 7.5 LoRA 按请求传递

#### 7.5.1 原方案的问题

原方案提议在 `GenerateConfig` 中新增 `lora_adapter`/`lora_alpha` 字段，由 `ModelRunner::inference()` 填入。但代码追踪发现：

```
ModelRunner::init_model_instance()  (model_runner.cpp:102)
  → instance->addLora({"cnyb"}) → 返回 lora_id=0
  → ModelDetails{lora_id=0}

ModelRunner::inference()  (model_runner.cpp:278)
  → 仅传递 lora_id（int）给 ModelInstance::streamGenerate()
  → ModelInstance 只知道 lora_id，不知道 lora_path 字符串

QnnModel::streamGenerate()  (qnn_model.cpp:822)
  → lora_names_[request.lora_id()] → "cnyb"
  → prompt.Option().SetLora("cnyb")
```

**lora_path 字符串仅存在于后端内部**（`QnnModel::lora_names_`），`ModelRunner` 层只有 integer ID。让 ModelRunner 填充 `lora_adapter` 字段需要改动 ModelRunner，违反零改动约束。

#### 7.5.2 修正方案：镜像 QnnModel 的 `lora_names_` 模式

AIService 内部维护 `std::vector<std::string> lora_names_`，与 QnnModel 完全一致：

```cpp
// addLora()：ModelRunner 初始化时调用，存储 lora 路径字符串
std::vector<int> AIService::addLora(std::vector<std::string> lora_paths) {
    std::vector<int> ids;
    for (auto& name : lora_paths) {
        lora_names_.push_back(name);
        ids.push_back(static_cast<int>(lora_names_.size()) - 1);
    }
    return ids;
}

// streamGenerate() 中解析 lora_id → path：
nlohmann::json buildRequestBody(const LlmRequest& request, bool stream) {
    // ...
    if (request.lora_id() >= 0 && request.lora_id() < static_cast<int>(lora_names_.size())) {
        const auto& adapter = lora_names_[request.lora_id()];
        double alpha = 2.0;  // 缺省值
        auto cfg_it = lora_extra_configs_.find(adapter);
        if (cfg_it != lora_extra_configs_.end())
            alpha = cfg_it->second.lora_alpha;
        body["extras"]["lora"] = {
            {"lora_adapter", adapter},
            {"lora_alpha", alpha}
        };
    }
    // ...
}
```

**关键优势**：
- ModelRunner、ModelInstance、InferParams、ModelConfig 完全零改动
- 仅 AIService 内部维护映射，与 QnnModel 模式一致
- `multi_lora_runtime_config.json` 中的 `lora_path` 字段（如 `"cnyb"`, `"dwsr"`, `"znzs"`）直接作为 `extras.lora.lora_adapter` 值发送给 VoyahAIService

> **lora_alpha 可配置化**
>
> `lora_alpha` 从 `multi_lora_runtime_config.json` 的 lora 配置中加载（见 §7.5.3），缺省值为 2.0。这解决了 OaiInference 场景（`lora_alpha=0.5`）与硬编码值不一致的问题。配置中未显式指定 `lora_alpha` 的 lora 条目使用缺省值 2.0。

### 7.5.3 约束解码配置：从 `multi_lora_runtime_config.json` 加载

QnnModel 通过 `prompt.Option().SetDecodeFormat(lora_names_[request.lora_id()])` 配置约束解码，GenAI SDK 内部将 LoRA 名解析为对应的 EBNF 语法和根规则。AIService 需要显式传递 `ebnf_path`、`grammar_root_rule`、`enable_jump_forward`，采用**配置文件驱动**的方式实现。

**核心思路**：在 `multi_lora_runtime_config.json` 的 lora 配置中增加 `ebnf_path`、`enable_jump_forward`、`grammar_root_rules` 字段，AIService 在 `initFromConfig()` 时加载并构建内部查找表。

**配置文件扩展**（`multi_lora_runtime_config.json`）：

```json
{
    "8397": {
        "multi_lora": {
            "base_model": { "model_name": "aiservice/qwen3-omni-4b", "config_path": "..." },
            "lora": [
                {
                    "scene_id": 1100,
                    "name": "incar_item_detect",
                    "lora_path": "cnyb",
                    "lora_alpha": 2.0,
                    "ebnf_path": "/AI/qwen3-omni-4b/vlm_ebnf/incabin_mm_sf_0420.txt",
                    "enable_jump_forward": true,
                    "grammar_root_rules": {
                        "cnyb-child": "age_and_pos",
                        "cnyb-left": "leftover"
                    }
                },
                {
                    "scene_id": 1200,
                    "name": "cloth_detect",
                    "lora_path": "cnyb",
                    "lora_alpha": 2.0,
                    "ebnf_path": "/AI/qwen3-omni-4b/vlm_ebnf/incabin_mm_sf_0420.txt",
                    "grammar_root_rules": {
                        "cnyb-cloth": "cloth_detect"
                    }
                },
                {
                    "scene_id": 1300,
                    "name": "grounding_sr",
                    "lora_path": "dwsr",
                    "lora_alpha": 2.0,
                    "ebnf_path": "/AI/qwen3-omni-4b/vlm_ebnf/outcar_grounding.txt"
                },
                {
                    "scene_id": 1300,
                    "name": "visual_assistant",
                    "lora_path": "znzs",
                    "lora_alpha": 2.0
                }
            ]
        }
    }
}
```

> **设计要点**：`grammar_root_rules` 是一个以 `prefix_name` 为 key 的映射。这解决了 InCarItemDetect 两步使用同一个 LoRA 但不同 `grammar_root_rule` 的问题——Dispatcher 已为每步传入不同的 `prefix_name`（`"cnyb-child"` vs `"cnyb-left"`），AIService 通过此映射自动选择正确的规则。

**AIService 初始化时加载**：

```cpp
void AIService::initFromConfig(const std::string& config_path) {
    // config_path 为 model config 路径，如 "config/qwen3-omni-4b_8397.json"
    // multi_lora_runtime_config.json 在同一目录下
    auto dir = std::filesystem::path(config_path).parent_path();
    auto mlrc_path = dir / "multi_lora_runtime_config.json";

    std::ifstream file(mlrc_path);
    auto json = nlohmann::json::parse(file);
    // 遍历 multi_lora.lora 数组，以 lora_path 为 key 构建查找表：
    //   lora_extra_configs_["cnyb"] = { ebnf_path, enable_jump_forward, grammar_root_rules, lora_alpha }
    //   lora_extra_configs_["dwsr"] = { ... }
    // 注意：多个 lora 条目可能共享同一个 lora_path（如 cnyb 被 incar_item_detect 和 cloth_detect 共用），
    // 此时 grammar_root_rules 合并（各条目的 prefix_name key 不冲突），lora_alpha 取最后一条的值。
    // ...
}
```

> **config_path 路径解析注意事项**：`initFromConfig` 接收的 `config_path` 可能是相对路径（如 `"config/qwen3-omni-4b_8397.json"`），`std::filesystem::path::parent_path()` 在这种情况下返回 `"config"`，拼接后的 `mlrc_path` 为 `"config/multi_lora_runtime_config.json"`。需确认 aadkcore 启动时的工作目录（cwd）与 `config_path` 的相对路径基准一致。若存在不一致风险，可在 `initFromConfig` 中使用 `std::filesystem::absolute()` 做防护，或要求调用方传入绝对路径。

**在 `buildRequestBody()` 中使用**：

```cpp
if (request.lora_id() >= 0 && request.lora_id() < (int)lora_names_.size()) {
    const auto& adapter = lora_names_[request.lora_id()];

    // LoRA + lora_alpha：从配置加载，缺省 2.0
    double alpha = 2.0;
    auto cfg_it = lora_extra_configs_.find(adapter);
    if (cfg_it != lora_extra_configs_.end()) {
        alpha = cfg_it->second.lora_alpha;
    }
    body["extras"]["lora"] = {{"lora_adapter", adapter}, {"lora_alpha", alpha}};

    // 约束解码：从配置中查找
    if (cfg_it != lora_extra_configs_.end()) {
        const auto& cfg = cfg_it->second;
        if (!cfg.ebnf_path.empty()) {
            body["extras"]["ebnf_path"] = cfg.ebnf_path;
            body["extras"]["enable_jump_forward"] = cfg.enable_jump_forward;

            // grammar_root_rule：按 prefix_name 查找（实现每步不同规则）
            auto gr_it = cfg.grammar_root_rules.find(request.prefix_name());
            if (gr_it != cfg.grammar_root_rules.end()) {
                body["extras"]["grammar_root_rule"] = gr_it->second;
            }
        }
    }
}
```

**各 Agent 约束解码覆盖表**：

| Agent | Step | lora_name (adapter) | prefix_name | ebnf_path | grammar_root_rule | enable_jump_forward |
|---|---|---|---|---|---|---|
| InCarItemDetect | Step1 (儿童) | `cnyb` | `cnyb-child` | `incabin_mm_sf_0420.txt` | `age_and_pos` | true |
| InCarItemDetect | Step2 (遗留物) | `cnyb` | `cnyb-left` | `incabin_mm_sf_0420.txt` | `leftover` | true |
| DressDetect | 单次 | `cnyb` | `cnyb-cloth` | `incabin_mm_sf_0420.txt` | `cloth_detect` | true |
| OutCarQA | Stage1 | `dwsr` | variable | `outcar_grounding.txt` | (default) | true |
| OutCarQA | Stage3 | `znzs` | (none) | (none) | (none) | (none) |
| OaiInference | - | `default_adapter` | (none) | (none) | (none) | (none) |

**关键优势**：
- Dispatcher、ModelRunner、GenerateConfig、InferParams、ModelInstance 全部**零改动**
- 约束解码配置完全**外置到 JSON 文件**，新增/修改 LoRA 的 EBNF 和 grammar 配置**无需重新编译**
- `prefix_name` 已经作为 per-call 参数流过整个调用链，无需新增任何接口
- 与 QnnModel 的 `SetDecodeFormat` 模式功能等价，但更灵活（配置驱动而非 SDK 内置）

### 7.6 错误处理

| AIService 返回 | 处理方式 |
|---|---|
| HTTP 200 + JSON | 正常解析 `choices[0].message.content` |
| HTTP 200 + SSE | 逐帧回调 `stream_callback` |
| HTTP 4xx/5xx + `error` JSON | 返回 `ModelResponse(MODEL_FAILURE)`，记录 error.message |
| 连接失败 | 返回 `ModelResponse(MODEL_NOT_READY)` |
| 请求超时（见下方超时策略）| 返回 `ModelResponse(MODEL_FAILURE)`，记录超时时长 |
| `error.code == "model_not_found"` | 返回 `ModelResponse(MODEL_NOT_FOUND)` |
| `error.code == "model_not_ready"` | 返回 `ModelResponse(MODEL_NOT_READY)` |

#### 7.6.1 超时策略

libcurl 超时分为三个层次，需根据流式/非流式场景差异化配置：

| 超时类型 | CURLOPT 选项 | 非流式请求 | 流式请求 |
|---|---|---|---|
| 连接超时 | `CURLOPT_CONNECTTIMEOUT` | 10s | 10s |
| 总超时 | `CURLOPT_TIMEOUT` | 120s | **不设**（推理时长不可预测） |
| 低速率超时 | `CURLOPT_LOW_SPEED_LIMIT` + `CURLOPT_LOW_SPEED_TIME` | 不启用 | 1 byte/s + 60s（60 秒内无任何数据到达则超时） |

**设计说明**：
- **连接超时 10s**：AIService 与 VoyahAIService 均在同一设备（127.0.0.1），连接应在毫秒级完成，10s 足够覆盖异常情况
- **非流式总超时 120s**：约束解码场景下推理可能耗时较长，120s 覆盖极端情况
- **流式不使用总超时**：流式推理的总时长取决于生成长度，无法预估。改用低速率超时（`LOW_SPEED_LIMIT=1` + `LOW_SPEED_TIME=60`）——如果 60 秒内没有收到任何字节，判定为连接异常或服务端卡死
- **流式首 token 延迟**：若需监控 TTFT（Time To First Token），可在应用层记录首 chunk 到达时间，但不作为超时中断条件

## 8. 约束解码实现策略

本期采用 **配置文件驱动** 方案实现约束解码（见 §7.5.3），无需修改任何现有文件。

### 8.1 与 QnnModel 的等价性

| 维度 | QnnModel | AIService |
|------|----------|----------|
| 约束解码入口 | `SetDecodeFormat(lora_name)` | `lora_extra_configs_[lora_name]` |
| 每步规则选择 | GenAI SDK 内部自动解析 | `grammar_root_rules[prefix_name]` |
| EBNF 语法 | SDK 内部加载 | `extras.ebnf_path` 显式传递 |
| Jump Forward | SDK 内部管理 | `extras.enable_jump_forward` 显式传递 |
| 配置来源 | GenAI SDK 内部映射 | `multi_lora_runtime_config.json` |
| Dispatcher 改动 | 无 | **无** |

### 8.2 为什么不需要修改 GenerateConfig / InferParams

旧方案提议将 `grammar_root_rule` 加入 `GenerateConfig` → `InferParams` → 配置文件 → `ModelInstance` 的传递链。但存在两个问题：

1. **InCarItemDetect 的两步使用同一个 LoRA 但不同的 `grammar_root_rule`**（step1=`age_and_pos`, step2=`leftover`），配置文件级别的 per-LoRA 配置无法表达 per-step 差异
2. 需要修改 `llmrequest.hpp`、`model_config.hpp`、`model_instance.cpp` 三个文件，增加实现复杂度

当前方案通过在 `multi_lora_runtime_config.json` 的 lora 配置中添加 `grammar_root_rules`（以 `prefix_name` 为 key 的映射），自然解决 per-step 差异。AIService 在 `initFromConfig()` 时从同一目录加载该配置，无需修改任何现有文件。

## 9. 实现步骤

| 步骤 | 文件 | 内容 | 改动量 |
|------|------|------|--------|
| 1 | `include/models/aiservice.hpp` | 新增：AIService 类声明（含 `lora_names_`、`LoraExtraConfig` 结构体、`lora_extra_configs_`、SSE buffer、`parseSSEFrames`、`initFromConfig` 配置加载） | ~100 行 |
| 2 | `src/models/aiservice.cpp` | 新增：实现（`initFromConfig` 配置加载含 lora_alpha + `buildOpenAIMessages` 自定义序列化 + `buildRequestBody` 含采样参数 + 约束解码 + SSE 帧解析器（含多行 data 拼接 + WARN 日志） + 图片/音频 Data URI 编码 + `addLora` 路径映射 + 超时配置） | ~600 行 |
| 3 | `include/utils/http_client.hpp` | 修改：新增 `streamAsyncRaw()` 方法声明 | +2 行 |
| 4 | `src/utils/http_client.cpp` | 修改：实现 `streamAsyncRaw()`（不剥离 `data:` 前缀的 CURL 回调） + 超时参数配置 | +20 行 |
| 5 | `CMakeLists.txt` | 修改：编译 `src/models/aiservice.cpp` | +1 行 |
| 6 | `runtime/data/config/multi_lora_runtime_config.json` | 修改：`model_name` 前缀改为 `aiservice/`，并为各 lora 条目添加 `lora_alpha`、`ebnf_path`、`enable_jump_forward`、`grammar_root_rules` 字段 | 改 4-5 处 |

**总计：2 个新文件 + 4 个文件少量修改。agent_group、ModelRunner、GenerateConfig、InferParams、ModelInstance 全部零改动。**

## 10. 验证方式

### 10.1 测试脚本兼容性

现有测试脚本 `android_sdk_test.cpp` **零改动即可使用**。测试脚本的调用链路：

```
android_sdk_test.cpp
    → banma::ModelInference::inference_msg(msg, stream, callback)
        → 内部转发到 agent_group 的 Dispatcher
            → ModelRunner → BaseLlm（按 model_name 前缀路由）
```

测试脚本只关心：
1. 构造 `DataMessage`（填 `scenario_id`、`content` JSON、`image_info`）
2. 调用 `model_inference.inference_msg()`
3. 在 callback 里验证返回的 JSON

它完全不感知底层用的是 QNN 还是 AIService。切换后端后，**同一个测试脚本、同一批测试图片、同一个 `test_cases.json`** 直接运行。

覆盖的测试场景：

| 测试函数 | 对应 Agent | scene_id | 验证内容 |
|---------|-----------|----------|---------|
| `runInCarItemDetectTest()` | InCarItemDetect | 1100 | 遗留物 + 儿童检测两阶段 |
| `runDressDetectTest()` | DressDetect | 1200 | 衣着识别 + voice_zone 裁图 |
| `runOutCarQATest()` | OutCarQA | 1300 | 三阶段流式（grounding → caption → NLG） |
| `runTextOnlyTest()` | OaiInference | 0 | 纯文本多轮对话 |
| `runTextImageWithDataTest()` | OaiInference | 0 | BGR/RGBA/JPEG 三种格式传图 |

### 10.2 验证步骤

1. 启动 VoyahAIService：`adb shell → cd /data/local/tmp/VoyahAIService → ./run_server.sh`
2. 使用 BanmaExample 验证 AIService 正常运行
3. 修改 `multi_lora_runtime_config.json` 为 `aiservice/qwen3-omni-4b`
4. 启动 aadkcore + agent_group
5. 运行 `android_sdk_test`，对比 QNN 与 AIService 输出一致性：
   ```bash
   # 全量测试
   ./android_test --runs 1 --agents 100,200,300
   # 仅舱内遗留物
   ./android_test --agents 100
   # 仅舱外视觉问答，跑 3 轮
   ./android_test --agents 300 --runs 3
   ```
6. 切换回 `qnn/qwen3-omni-4b`，确认 QNN 后端仍正常工作

## 11. 后续迭代（P2）

以下功能本期不实现，记录为后续迭代方向：

### 11.1 工具/函数调用支持

当前三个 Agent（InCarItemDetect、DressDetect、OutCarQA）不使用工具调用。仅 LlmAgent 流程路径使用。

后续需要：
- 序列化 `GenerateConfig.tools` → `body["tools"]`（OpenAI 格式）
- `FunctionCall` → `tool_calls` 数组
- `FunctionResponse` → `{"role": "tool", "tool_call_id": ..., "content": ...}`
- 需修改 `buildOpenAIMessages()` 中的 FunctionCall/FunctionResponse 分支

### 11.2 性能指标提取

- 请求体中加 `"stream_options": {"include_usage": true}`（本期已包含）
- 从 SSE 最终帧解析 `usage` 对象（`prompt_tokens`, `completion_tokens`, `total_tokens`）
- 本地计算 TTFT（记录首 chunk 到达时间）和 tokens/sec
- 填充 `ModelResponse` 的 `ttft`, `output_tokens`, `tokens_per_second` 字段

### 11.3 健康检查与生命周期

- `is_ready()`: 本期返回 `true`（同 Bailian）；后续可定期 ping `GET /v1/models` 检查模型状态
- `suspend()`/`resume()`: 本期空操作；后续可调用 `POST /models/unload` 和 `POST /models/load`
- 连接失败时自动标记 `is_ready_ = false`

### 11.4 配置灵活性

- 本期 API host 硬编码为 `http://127.0.0.1:8090`
- 后续支持环境变量 `AISERVICE_HOST` 覆盖
- 或通过 config JSON `{"api_host": "..."}` 配置

### 11.5 QNN 特有功能（AIService 不需要）

以下 QNN 后端功能由 VoyahAIService 服务端内部管理，AIService 后端无需实现：

| 功能 | QNN 实现方式 | AIService 处理方式 |
|------|-------------|-------------------|
| Chat Template (Jinja2) | `buildLlmsPrompt()` + `minja` 引擎 | 服务端自动应用 |
| ViT 档位选择 (448/1024) | `MultiVegModel::get_vit_shape()` | 服务端根据图片尺寸自动选择 |
| 图片 Normalize/Patch | `qwen2_vl_processor::preprocessImage()` | 服务端完成 |
| 音频 Mel 频谱提取 | `Qwen25AudioProcessor` | 服务端完成 |
| Qwen3/Qwen2.5 模型检测 | `is_qwen3_` 标志位 | 服务端自动识别 |
| KV Cache 管理 | `PromptHistroyManager` | 服务端管理 |
| DeepStack 多模型级联 | `preprocessImage_deepstack()` | 本期不处理 |

### 11.6 配置化场景管理（混合架构的长远方向）

当前 AIService 后端作为 HTTP 传输层，约束解码配置已外置到 `multi_lora_runtime_config.json`（见 §7.5.3），但 prompt 和 LoRA 路由仍由 Dispatcher 层管理（通过 PromptManager + YAML 文件 + 硬编码 key）。

**两套方案的本质区别**：

| 维度 | Legacy 架构（agent_group） | scenes.json 架构（BanmaExample） |
|------|---------------------------|----------------------------------|
| 图片预处理 | 完整（flip、crop、letterbox、bbox） | 无（直接透传） |
| Prompt 管理 | PromptManager + YAML | scenes.json + YAML |
| LoRA 路由 | C++ 常量 + ModelRunner | scenes.json + HTTP extras |
| 输出后处理 | 丰富（区域映射、条目映射、模板渲染） | 无（原始 JSON） |
| 多阶段编排 | Dispatcher 内编排（如 InCarItemDetect 2步、OutCarQA 3阶段） | 示例代码硬编码 |
| 新增 Agent 成本 | ~500+ 行 C++ | ~20 行 JSON + YAML |

**结论**：Legacy 架构适合生产环境（包含丰富的业务逻辑），scenes.json 架构适合简单演示和原型开发。两者服务于不同的场景层级，不存在替代关系。

**长远方向——混合架构**：

保留 Dispatcher 层处理图片预处理、输出后处理、多阶段编排等**业务逻辑**，同时将 Dispatcher 中硬编码的配置（LoRA 名、EBNF 路径、grammar 规则、YAML 路径）外置到配置文件：

- **Dispatcher**：保持业务逻辑（图片操作、输出映射、fallback 逻辑）不变
- **配置**：`multi_lora_runtime_config.json` 作为单一配置入口，承载 LoRA 路由 + 约束解码 + prompt 路径
- **新增 Agent**：仍需 Dispatcher 类处理业务逻辑，但 prompt/LoRA/grammar 配置外置化

这需要解决的问题：

| 问题 | 说明 |
|------|------|
| Scenario ID 映射 | Legacy `constant_ids.h` 中 `INCAR_ITEM_DETECT_SCENARIO_ID=1100`，而 `scenes.json` 中 `scenario_id=100`，需统一或建立映射表 |
| PromptManager 兼容性 | Legacy 用 `PromptManager`（YAML dot-notation key），`scenes.json` 用 `template_key` + `template_key_step2` 索引，需统一访问接口 |
| LoRA 名称映射 | Legacy C++ 中 `LORA_NAME = "incar_item_detect"`，`scenes.json` 中 `lora_adapter = "cnyb"`，需明确映射关系 |
| 约束解码参数传递 | 当前 Dispatcher 不传 EBNF/grammar 参数，本期已通过 AIService 配置加载解决，后续可考虑由 Dispatcher 层统一注入 |
