# 4. 设备部署与上车流程

*岚图 8397 · SDK 构建 → adb push → 设备目录 → android\_test / APK 运行 → 部署验证 · SELinux*

> [!TIP]
> **本篇讲什么**
>
> 岚图 8397 上 GenAI 方案 SDK 的**设备部署与上车流程**——这是从框架层 [设备部署](../agent-framework/deploy.html) 下沉的**岚图分支专属**部分（主线 agent\_core\_dev 不含 android\_sdk / android\_test）：
>
> - 可执行文件部署：`build_8397_android.sh` 构建（工具链与关键开关）→ adb push → `/AI/vllm_sdk/` 设备目录 → `android_test` 运行 → 部署成功判据
> - APK 部署：设备文件放置对照、**两个模型根目录**（`/AI/vllm_sdk/models` vs `/AI/VLM/models/qwen3-omni-4b`）的权威目录树与谁读谁、SELinux 域差异（为什么 `android_test` 能跑、APK 却撞墙）
>
> JNI 接口、`ModelInference` API、`DataMessage` 结构与 C++ 调用示例统一收敛在 [3. APK 集成与端侧服务化](apk-integration.html) 第 6 节，**本篇不再重复**；APK 应用层内部结构（MyApplication / 前台服务 / HTTP 服务化）见该篇第 3~5 节。
>
> **代码基线**：aadkcore 仓库 `lantu_sdk_dev` 分支 `runtime/src/android_sdk/`（`model_inference.cpp/h`、`MsgDeliverImpl`、`data_message.h`）；构建开关与产物判据按 2026-09 岚图分支状态核实。

## 1. 可执行文件部署（android\_test）

可执行文件部署主要用于 SA8397P Android 平台的**开发调试和功能验证**。通过 NDK 交叉编译生成 `android_test` 可执行文件，adb push 到设备后直接运行，无需 APK 集成，方便快速迭代。

### 1.1 构建工具链与关键开关

| 项 | 值 / 说明 |
| :--- | :--- |
| NDK | `android-ndk-r27c`（`ANDROID_NDK_HOME` 指向它；本仓库实测版本） |
| CMake | **3.28 必须在 PATH 上**——`build_8397_android.sh` 直接调 `cmake`；系统老版本 CMake（如 3.16）会对 Android+LTO 强加 `-fuse-ld=gold` 而构建失败 |
| ABI | `arm64-v8a`（aarch64，匹配车机 SoC；APK 侧同样用 `abiFilters` 限定此 ABI） |
| Platform | `ANDROID_PLATFORM=android-33`（脚本内写死） |
| STL | 脚本**未显式传** `-DANDROID_STL`（用 NDK 工具链默认）；交付包 `lib/` 随附 `libc++_shared.so`（厂商 GenAI 预编译库依赖）。上机前建议 `readelf -d libaadkcore.so libllms.so | grep NEEDED` 核对两者 libc++ 口径——自身 `.so` 与 vendor `.so` 若一个静链、一个动链 libc++，跨边界传 STL 对象/异常有 ODR 风险 |
| 构建类型 | **Release 型构建**（`-O3 -ffast-math -funroll-loops -fomit-frame-pointer -fopenmp` + IPO/LTO，aarch64 加 `-march=armv8-a`），**未 strip** 故保留符号——这是下面目录树里 `.so` 体积偏大的原因，见 1.2 注 |

> [!NOTE]
> **构建类型由顶层 CMakeLists 写死，脚本传的 `-DCMAKE_BUILD_TYPE=Release` 被覆盖**
>
> 顶层 `CMakeLists.txt` 里有一句 `set(CMAKE_BUILD_TYPE "RELEASE")`（无条件赋值，不带 `CACHE`/`FORCE`），它**覆盖**了 `build_8397_android.sh` 传入的 `-DCMAKE_BUILD_TYPE=Release`。真正生效的是 `STREQUAL "RELEASE"` 分支（全大写），由此加上 `-O3 -ffast-math` 等优化与 IPO/LTO。aadkcore 自身 CMake 并**没有** `-g`；产物体积大是「未 strip + 优化信息」而非 debug 段。`libllms.so`（约 105MB）是 `genai_sdk-sa8397.rel-android` 的**厂商预编译**库，不是本仓库编出来的。`-ffast-math`/LTO 会改变浮点数值行为，与推理结果的可复现性讨论相关，见 [GenAI 方案架构总览](genai-architecture.html) 的确定性一节。

`build_8397_android.sh` 的关键开关有两个（彼此正交）：

| 开关 | 管什么 |
| :--- | :--- |
| `ENABLE_LANTU_SDK` | 岚图项目闸门：agent\_group 是否编入三个场景 dispatcher（dress\_detect / incar\_item\_detect / outcar\_qa）与岚图形态的模板安装规则（只装编入 dispatcher 实际打开的模板，见 1.2） |
| `ENABLE_QNN_MODEL` | GenAI/QNN 后端：**四层**——源码（`qnn_model.cpp` 是否编入）、include 路径、链接项、install 规则（`lib/` 相关库 + 整个 `libqnn/` 目录） |

现行岚图构建脚本（`build_8397_android.sh`）传 `-DENABLE_QNN_MODEL=ON -DENABLE_LANTU_SDK=ON -DENABLE_ANDROID_NDK=ON -DENABLE_AGENT_GROUP_BUILD=ON`，外加一串 `-DFEATURE_*=OFF`（car_control / chit_chat / active_vision / gui / car_sentinel / rain_dection / soprt_mode / welcome_mode / video_chat / chery_project，**仅** `FEATURE_OAI_INFERENCE=ON`），并指定 `-DGENAI_SDK_ANDROID_NAME="genai_sdk-sa8397.rel-android"`、`-DCMAKE_INSTALL_PREFIX=vllm_sdk`、`-DAADK_TARGET_PLATFORM=android`、`-DAADK_ENV_PATH=<repo>/aadk_lib`。它是**纯 GenAI 形态**：全仓库 CMakeLists 里 grep 不到 `ENABLE_AISERVICE_MODEL`，脚本也不传任何 AIService 后端开关，即 genai 形态构建**不含** AIService 后端开关/源码。运行期按配置里 `model_name` 前缀路由后端（`qnn/…` → 进程内 QNN，`aiservice/…` → HTTP 8090）的机制**属 aiservice 形态分支**，genai 形态不编入该后端，详见 [AIService 后端集成与重构](aiservice-integration.html)。

> [!NOTE]
> **芯片宏由 `GENAI_SDK_ANDROID_NAME` 字符串解析而来（写错包名会静默走错平台分支）**
>
> 顶层 `CMakeLists.txt` 用正则 `-sa([0-9]+)\.` 从 SDK 包名里抠出 SoC 代号，再据此 `add_compile_definitions`：命中 `8397` → `ENABLE_ANDROID_LLM_8397_PLAINTEXT`（另有 8295 / 9075 分支）。脚本传 `genai_sdk-sa8397.rel-android` 正好命中 8397。若包名写错（漏了 `-sa8397.` 之类），CMake 只打一条 `Could not detect SoC ID from SDK name` 的 **warning 就静默跳过该宏**，编译照样通过，但运行期平台分支会走错——改 SDK 包名时务必确认 configure 日志里没出现这条 warning。`ENABLE_QNN_MODEL` 的四层闸门（源码 `qnn_model.cpp` / include / 链接 / install）也都在同一 `if(ENABLE_QNN_MODEL)` 块里：install 把 `genai_sdk` 包 `lib/*.so*`（含 `libllms.so`）装进 `lib/`、把 `third_party/lib/*` 装进 `libqnn/`。

**编译与安装**：

```
# NDK 交叉编译（需设置 ANDROID_NDK_HOME 环境变量，CMake 3.28 在 PATH 上）
./build_8397_android.sh

# 编译产物位于 build_8397_android/vllm_sdk/
# 推送到设备
adb push build_8397_android/vllm_sdk/ /AI/vllm_sdk/
```

> [!WARNING]
> **构建是增量的，install 只拷不删**
>
> `build_8397_android.sh` 不清空构建目录，`make install` 只拷贝、从不删除——调整 install 排除规则后，旧 `build_8397_android/vllm_sdk/` 里被排除的文件**仍然在**（时间戳是很久以前的），只有 install 日志里「出现 0 次」才是真相。验证排除规则是否生效要先 `rm -rf build_8397_android/vllm_sdk && make install`（不重编，几秒）。

### 1.2 设备目录结构（/AI/vllm\_sdk/）

```
/AI/vllm_sdk/
├── lib/                        # 运行时依赖库（Release 型、未 strip 口径，见下注）
│   ├── libaadkcore.so          # 核心框架 (~71MB)
│   ├── libagent_group.so       # Agent 插件 (~19MB)
│   ├── libandroid_sdk.so       # Android SDK 接口层 (~5.5MB)
│   ├── libllms.so              # GenAI 推理引擎 (~105MB，厂商预编译)
│   ├── libaisa.so              # AISA 模型库 (~7MB)
│   └── ...                     # OpenCV, curl, libc++_shared 等
│                               # 注：flash_attn/cpu_profiler/perfetto/libz 被 EXCLUDE_FILES 排除（见下注）
├── libqnn/                     # QNN 后端库（ENABLE_QNN_MODEL=ON 才安装）
│   ├── libQnnHtp.so            # HTP 后端
│   ├── libQnnCpu.so            # CPU 后端
│   ├── libQnnGpu.so            # GPU 后端
│   ├── libGenie.so             # Genie 推理引擎
│   └── ...                     # Stub/Skel/Profiler 等
├── models/                     # ★ 运行时配置/模板根（不是权重！见 2.2）
│   ├── config/
│   │   ├── runtime_config.json         # 运行时配置（平台/模型切换；8397 块指向 qwen2.5-vl，见 2.2 注）
│   │   ├── multi_lora_runtime_config.json  # 多 LoRA 主配置（genai 形态无 model_root；经 model_config 指向下方 json）
│   │   └── qwen3-omni-4b_8397.json     # model_path（绝对路径权重根）/ veg_params（多 VIT 档位），仅 GenAI 形态读
│   └── template/               # YAML Prompt 模板（SDK 自带副本，PromptManager 读这份）
│       ├── dress_detect.yaml       # 着装识别（Agent200）
│       ├── incar_item_detect.yaml  # 车内遗留物（Agent100）
│       ├── outcar_qa.yaml          # 舱外问答（Agent300）
│       └── result_template.json    # 结果帧模板
├── include/                    # 对外头文件
│   ├── model_inference.h       # ModelInference 接口（详见 APK 篇 6.2）
│   └── data_message.h          # DataMessage 结构定义（详见 APK 篇 6.3）
├── example/
│   ├── bin/android_test        # 测试可执行文件（三场景用例）★ android_sdk_run.sh 当前入口
│   ├── bin/new_api_test        # 新 API 测试程序（android_sdk_run.sh 里被注释，非当前入口）
│   ├── src/                    # 测试源码（android_sdk_test.cpp + new_api_test.cpp）
│   └── data/                   # 测试图片（img_test.jpg + demo_test_0416/）与 test_cases.json
├── android_sdk_run.sh          # 运行脚本
└── version.txt                 # 版本号（上机后第一眼要看的，见 1.4）
```

> [!NOTE]
> **`.so` 体积是 Release 型、未 strip 口径**
>
> 产物为 Release 型构建（`-O3 -ffast-math` + IPO/LTO）但**未 strip**，仍保留符号与优化信息：`libaadkcore.so` ~71MB、`libllms.so` ~105MB 都是**未 strip 体积**（`libllms.so` 是厂商预编译库，见 1.1 注）。APK 侧经 AGP 默认 strip 后 `libaadkcore.so` 约 36.5MB（唯一例外是 `libQnnHtpV81Skel.so` 不能 strip，见 APK 篇 2.3）。量产交付应明确 strip 策略与体积预算，别直接引用未 strip 数字。
>
> 另：岚图 Android 构建（`ENABLE_ANDROID_NDK AND ENABLE_LANTU_SDK`）下，顶层 CMakeLists 用 `EXCLUDE_FILES` 把 `libflash_attn.so` / `libcpu_profiler.so` / `libperfetto.so` / `libz.so` 从 `install(... DESTINATION lib)` 中剔除——它们是 aarch64-**glibc** 构建（`DT_NEEDED` 含 `libc.so.6`/`libstdc++.so.6`，flash_attn 还带 `libcudart.so.12`），在 Android bionic 上根本装不起来，且岚图形态 `ENABLE_LAPE_MODEL=OFF` 无人链接，白占体积。所以 `lib/` 里**没有** flash_attn（与 APK 篇 2.3 的 jniLibs 口径一致）。

> [!NOTE]
> **`template/` 只有 4 个文件，是岚图实际集合**
>
> 岚图构建（`ENABLE_LANTU_SDK=ON`）下，`agent_group/CMakeLists.txt` 只 install 四个文件：`dress_detect.yaml` / `incar_item_detect.yaml` / `outcar_qa.yaml` / `result_template.json`（来源 **agent\_group 仓库**，由 `ENABLE_LANTU_SDK` 闸门控制）。`build_8397_android.sh` 里 `FEATURE_CAR_CONTROL` / `FEATURE_ACTIVE_VISION` / `FEATURE_CHIT_CHAT` 全 OFF，所以车控/主动视觉/闲聊等模板**不会**被装进来——这与 1.1「只装编入 dispatcher 实际打开的模板」一致。非岚图构建（`ENABLE_LANTU_SDK=OFF`）才走 `install(DIRECTORY ...)` 装整个 `data/template/`。

> [!NOTE]
> **本目录树服务可执行文件部署；APK 不读 `lib/` 与 `libqnn/`**
>
> APK GenAI 形态把核心库与 QNN 后端的**另一份**打进 jniLibs（37 个 `.so`），运行期不读 `/AI/vllm_sdk/lib*`；APK 只读 `/AI/vllm_sdk/models`（配置根）。两份库应同源同版本，核对方法见 1.4。

### 1.3 运行方式与环境变量

```
# adb shell 进入设备
adb shell
cd /AI/vllm_sdk

# 设置环境变量并运行（android_sdk_run.sh 内容）
export GENAI_THIRTY_LIB=/AI/vllm_sdk/libqnn
export ADSP_LIBRARY_PATH="/vendor/dsp/cdsp;/vendor/lib/rfsa/adsp;/system/lib/rfsa/adsp;/dsp;$GENAI_THIRTY_LIB;"
export LD_LIBRARY_PATH=/AI/vllm_sdk/lib:$GENAI_THIRTY_LIB

# 运行测试程序
./example/bin/android_test
```

> [!NOTE]
> **`GENAI_THIRTY_LIB`：疑似 `THIRD` 的笔误，但照抄上游拼写**
>
> 按命名意图它应是 `GENAI_THIRD_LIB`（third-party 库目录），`THIRTY` 疑似上游笔误。但这是 `android_sdk_run.sh` / `test_cases.json` 里的**字面变量名**（照抄上游拼写，与协议里 `presure` 字段同类），脚本按该名读写——手工 export 时**必须一字不差**，不要在自己的脚本里「顺手修正」拼写，否则变量不生效、QNN 后端加载失败。

> [!WARNING]
> **环境变量说明**
>
> `ADSP_LIBRARY_PATH` 是 Hexagon DSP 加载 skeleton 库的搜索路径，必须包含 QNN 后端库目录。`GENAI_THIRTY_LIB` 指向 QNN 库目录，用于 GenAI SDK 定位 HTP/CPU/GPU 后端。如果这两个变量配置错误，会导致 QNN 后端加载失败，模型推理报 `AEE_ECONNREFUSED` 错误。

> [!NOTE]
> **运行入口与用例控制**
>
> - `android_sdk_run.sh` 当前实际拉起的是 **`android_test`**（活跃行 `./example/bin/android_test "$@"`；`new_api_test` 那行被注释）。`--agents 100,200,300` 本就是 `android_test` 的 **default**，所以直接 `./android_sdk_run.sh` 即可跑三场景回归用例（Agent100/200/300），无需额外传 `--agents`。
> - 可用参数（`android_test --help`）：`--runs <n>`（循环总轮数，default 1；**浸泡/确定性测试靠它**，如 `--runs 5`）、`--sleep <s>`（agent 之间散热间隔，default 0）、`--json <path>`（覆盖用例文件路径）、`--camera <id>`（default 0）、`--agents <ids>`（逗号分隔，default 全跑）。
> - `--start` / `--count` 是**死参数**（只解析不使用，源码里赋值后从不读取）；限制用例数只能改 `example/data/test_cases.json` 里每条的 `enabled` 字段，测完恢复。
> - `test_cases.json` **不在源码树**——它随交付包提供，运行期从设备固定路径 `/AI/vllm_sdk/example/data/test_cases.json` 加载（可用 `--json` 覆盖）。

### 1.4 部署成功判据

「推完了」不等于「部署对了」。按强度递增的判据：

| 层级 | 判据 | 方法 / 说明 |
| :--- | :--- | :--- |
| **版本** | `version.txt` 与预期一致 | `cat /AI/vllm_sdk/version.txt`（两行：`versionNameInternal=fp0603_qat0610_arn256_qnn246-sdk_<时间戳>` / `versionName=H47A3632017DA.<YYmmdd>01`），上机后第一眼先看它——但它只编码构建时刻，见下注 |
| **形态** | 目录形状与预期形态一致 | GenAI 形态有 `libqnn/`；AIService 形态没有 `libqnn/` 且 `lib/` 文件数明显更少。防「推错包」 |
| **完整性** | 产物与构建侧一致 | md5 比对**只对同一构建路径的产物可复现**——产物 Release 型但**未 strip**，仍嵌构建目录等路径信息，换机/换目录构建 md5 必变；跨环境比对改用 `llvm-nm -D` 动态符号（去掉地址列）、归一化后的 `strings`、`readelf -SW` 节区大小 |
| **加载** | 库与模型真实映射 | `cat /proc/<pid>/maps`：确认进程映射了哪些 `.so`、哪些模型 `.bin` 及其真实路径。aiservice 形态下 `GET /v1/models` 说 `loaded` **不等于**新模型已生效——`VoyahAIService` 只在启动时扫描，硬证据是 maps 里 lora `.bin` 的真实路径 |
| **功能** | 用例结果，而非退出码 | GenAI 形态即使三链路全部跑通，teardown 阶段也会 **SIGABRT**（`FORTIFY: pthread_mutex_lock called on a destroyed mutex`，RC=134，改动前后指纹一致的既有问题）；判据是输出里的 `ran=N` 与 `RESULT` JSON 内容，**不要看退出码** |
| **APK 侧** | 包内 3 个 `.so` 的 md5 定版 | 核对 APK 配的是哪版 SDK，比包内 `libaadkcore` / `libagent_group` / `libandroid_sdk` 的 md5，别信构建时间戳（每次构建都变） |

> [!NOTE]
> **`version.txt` 只编码「哪天编的」，不编码「哪版代码」**
>
> `build_8397_android.sh` 末尾用 `date` 现场拼出两行，先写到仓库**父目录** `../version.txt` 再 `cp` 进 `build_8397_android/vllm_sdk/`：前缀 `fp0603_qat0610_arn256_qnn246-sdk_` 与 `H47A3632017DA.` 都是脚本里**写死的字面量**，只有尾部时间戳随构建时刻变。因此两次不同代码、同一脚本的构建，`version.txt` 只差时间戳——它能回答「这是哪天编的包」，**不能**回答「这是哪版代码」。定版仍要靠上表「完整性 / APK 侧」的符号或 md5 判据，别把 `version.txt` 当代码版本用。

## 2. APK 部署与设备文件放置

APK 集成是 SA8397P Android 平台的**量产部署方案**。Android 应用通过 JNI 加载 `libandroid_sdk.so`，调用 `ModelInference` C++ 接口完成模型推理。核心 `.so` 库（含 QNN 后端）打包在 APK 内；模型权重与运行时配置部署在设备文件系统。

> [!IMPORTANT]
> **JNI 接口收敛在 APK 篇**
>
> `ModelInference` API（接口停用删除后剩 4 个方法）、`DataMessage` 结构、JNI 句柄模型 / 跨线程回调与 C++ 调用示例，统一见 [3. APK 集成与端侧服务化](apk-integration.html) 第 6 节，本篇不再重复。本节只回答部署侧的问题：**哪些文件放哪、谁读谁、SELinux 怎么过**。

### 2.1 部署拓扑

```mermaid
flowchart TB
    subgraph APK["Android APK（GenAI 形态：native 库全部打包 jniLibs）"]
        JAVA["Java/Kotlin 层UI + 业务逻辑"]
        JNI["JNI 桥接层libmodelinfer.so"]
        SDK["libandroid_sdk.soAndroid SDK 接口"]
        AADK["libaadkcore.so核心框架"]
        AG["libagent_group.soAgent 插件"]
        LLMS["libllms.soGenAI 推理引擎"]
        QNNP["libQnnHtp + V81 Skel/StubQNN 后端（包内）"]
        JAVA --> JNI --> SDK --> AADK
        AADK --> AG
        AADK --> LLMS --> QNNP
    end

    subgraph Device["设备文件系统"]
        CFG["/AI/vllm_sdk/models/运行时配置 + 模板（2.2）"]
        MODELS["/AI/VLM/models/qwen3-omni-4b/模型权重 (Context Binary)"]
        QNN_LIB["/AI/vllm_sdk/libqnn/QNN 后端库（可执行文件部署用）"]
    end

    subgraph HW["硬件"]
        NPU["Hexagon NPUHTP + HMX"]
    end

    SDK -->|"init(model_path)"| CFG
    CFG -.->|"model_config→model_path（绝对路径）"| MODELS
    LLMS -->|"装载权重"| MODELS
    QNNP --> NPU
    QNN_LIB -.->|"仅 android_test 经 LD_LIBRARY_PATH"| NPU

    style APK fill:#4361ee,color:#fff
    style SDK fill:#7b8cff,color:#fff
    style AADK fill:#3498db,color:#fff
    style NPU fill:#e74c3c,color:#fff
```

### 2.2 两个模型根目录：谁读谁

部署中最容易混淆的是把 `/AI/vllm_sdk/models` 当成「模型目录」。实际上有**两个根目录**，职责不同：

- **`/AI/vllm_sdk/models` = 运行时配置/模板根**（「怎么跑」）：是 `ModelInference::init(model_path)` 的入参，里面只有 JSON 配置与 YAML 模板，**没有权重**；
- **`/AI/VLM/models/qwen3-omni-4b` = 模型权重/Context Binary 根**（「跑什么」）：`qwen3-omni-4b` 是内部定制模型型号，genai 形态由 `qwen3-omni-4b_8397.json` 的 `model_path`（绝对路径）直连到这一层；其**父目录** `/AI/VLM/models` 才是 aiservice 形态 `VoyahAIService` 的模型扫描根（**硬编码**，扫到的是其下各模型包）。

两者**刻意解耦**：配置/模板根随 SDK 交付包走（CMake `install` 进 `vllm_sdk/models`，与 `.so` 同版本同生命周期），权重根是独立交付/OTA 的模型包（体积大、aiservice 形态下由 `VoyahAIService` 管 OTA 双槽）——升级 SDK 不动权重、OTA 权重不动 SDK。这也是为什么「把权重塞进 `/AI/vllm_sdk/models`」是高频坑（见 2.2 末 WARNING ①）。

genai 形态下，权重根**不是**靠 `model_root` 相对跟随定位的——`multi_lora_runtime_config.json` 里**没有** `model_root` 字段。实际链路是：`multi_lora_runtime_config.json` 的 `model_config` → `config/qwen3-omni-4b_8397.json` 的 `model_path`（**绝对路径** `/AI/VLM/models/qwen3-omni-4b`）直接定位权重根；`model_root` 相对跟随是 **aiservice 形态**的机制。此外 `veg_params` 还引用**第三个根** `/AI/VLM/models/raw_src/`（VIT 的 `position_ids`/`pixel_values` `.raw` 文件，按 448×448 / 1024×768 两档分目录）。权威目录树：

```
/AI/
├── vllm_sdk/models/                   ← 配置/模板根 = init(model_path) 入参
│   ├── config/
│   │   ├── runtime_config.json            # ModelScheduler 读 capacity / worker_count / timeout_s
│   │   │                                  # 8397 块 model_name 指向 qwen2.5-vl（与 multi_lora 打架，见下注）
│   │   ├── multi_lora_runtime_config.json # 主配置：model_name 定后端（qnn/…）；genai 形态无 model_root
│   │   │                                  # model_config → qwen3-omni-4b_8397.json
│   │   └── qwen3-omni-4b_8397.json        # model_path（绝对路径权重根）/ veg_params（多 VIT 档：veg_448_448 小档、
│   │                                      #   veg_1024_768 大档；各业务走哪档见 genai-architecture §3.2），仅 GenAI 形态读
│   └── template/                          # YAML Prompt 模板（SDK 自带副本，PromptManager 读这份）
└── VLM/models/                          ← 权重根 = VoyahAIService 扫描根（硬编码）
    ├── qwen3-omni-4b/                   ← 模型包
    │   ├── info.json                    # 模型元数据（id: qwen3_omni）
    │   ├── base/                        # 基模 config.json + Context Binary / KV 缓存 (.bin)
    │   │                                #   VIT 两档 bin 在 base/omni3/veg_448_448_8397.bin / veg_1024_768_8397.bin
    │   ├── loras/                       # 场景 LoRA 权重 (.bin)
    │   ├── prefix/                      # 前缀缓存（与配置中 prefix_name 1:1 对应）
    │   ├── vlm_ebnf/                    # 约束解码 grammar
    │   └── template/                    # 包内模板副本（厂商 Example 读这份；与 SDK 自带副本内容实测相同）
    └── raw_src/                         ← 第三个根：VIT 预处理 .raw（qwen3-omni-4b_8397.json 的 veg_params 引用）
        ├── 448_448/                     # position_ids_cos/sin.raw + pixel_values.raw（小档；衣着走这档）
        └── 1024_768/                    # 同上（大档；舱内遗留物 / 舱外问答走这档——非「舱内一律小档」，见 genai-architecture §3.2）
```

> [!WARNING]
> **`runtime_config.json` 与 `multi_lora_runtime_config.json` 指向不同模型，谁权威？**
>
> `runtime_config.json` 的 `8397` 块 `model_name` 指向 **`qnn/qwen2.5-vl`**（`model_config: config/qwen2.5-vl_8397.json`），而 `multi_lora_runtime_config.json` 指向 **`qnn/qwen3-omni-4b`**。两者**打架**。genai 形态实际生效的是 **multi\_lora 这条**（`qwen3-omni-4b`）：岚图 install 规则（`ENABLE_ANDROID_NDK AND ENABLE_LANTU_SDK`）只交付 `multi_lora_runtime_config.json` / `qwen3-omni-4b_8397.json` / `runtime_config.json` 三个配置，**并不安装** `runtime_config.json` 8397 块指向的 `qwen2.5-vl_8397.json`——该块引用的配置文件在设备上根本不存在，自然不会被用来路由。核对部署时以 `multi_lora_runtime_config.json` + `qwen3-omni-4b_8397.json` 为准；`runtime_config.json` 在 genai 形态主要被 `ModelScheduler` 读 `capacity` / `worker_count` / `timeout_s`（见 APK 篇 8 的 35s 超时窗口）。

**读者对照**：

| 读者 | 读什么 | 说明 |
| :--- | :--- | :--- |
| `ModelInference::init(model_path)`（APK / android\_test） | `/AI/vllm_sdk/models` | APK 侧硬编码于 `TestInjectService.java:81`；只读配置，不直接碰权重 |
| GenAI 形态（`qnn_model.cpp`） | `/AI/VLM/models/qwen3-omni-4b` 的 Context Binary / LoRA / veg\_params | 进程内 QNN/HTP 装载权重 |
| AIService 形态（`VoyahAIService`，厂商系统服务） | `/AI/VLM/models`（扫描根**硬编码**） | 只在启动时扫描；换包/搬家后必须 `setprop ctl.restart vendor.VoyahAIService` 再 `POST /models/load` |
| PromptManager（我方 SDK） | `/AI/vllm_sdk/models/template/*.yaml` | 厂商 Example 读包内 `template/`；两份内容实测逐字节相同——**改模板要认准是哪一份** |

> [!WARNING]
> **三个高频坑**
>
> ① **把权重放 `/AI/vllm_sdk/models`**——那是配置根，权重放那无效；`VoyahAIService` 扫不到模型时表现为 `GET /v1/models` 返回空 + `Model is not listed in scanned models`。
> ② **在 C++ 里写死 `/AI/VLM/models`**——aiservice 形态的服务端二进制里有 OTA 双槽（`models_new` / `_old` + `models -> models_old` 链接翻转），扫描根会变，所以 aiservice 形态用配置里的 `model_root` 相对跟随；genai 形态则是 `qwen3-omni-4b_8397.json` 的 `model_path` 绝对路径直连权重根（见上）。两种机制别混用，也别在业务代码里再写死一遍。
> ③ **假设模型包布局不变**——包的布局历史上变过（扫描根下扁平放置 vs 带 `qwen3-omni-4b/` 一层），上机后先 `ls` 确认实际布局再写配置。

### 2.3 设备文件放置对照表

| 文件类别 | 来源 | 部署位置 | 说明 |
| :--- | :--- | :--- | :--- |
| **SDK 接口库** | vllm\_sdk/lib/libandroid\_sdk.so | APK jniLibs/arm64-v8a/ | 打包进 APK，JNI 加载 |
| **核心框架库** | vllm\_sdk/lib/libaadkcore.so 等 | APK：jniLibs 打包；可执行文件：/AI/vllm\_sdk/lib/ | APK 用包内副本；`android_test` 经 `LD_LIBRARY_PATH` 加载 |
| **QNN 后端库** | vllm\_sdk/libqnn/ | APK：jniLibs 打包（GenAI 形态，含 V81 Skel/Stub）；可执行文件：/AI/vllm\_sdk/libqnn/ | APK 内 Skel 不可 strip（见 APK 篇 2.3） |
| **DSP Skeleton 库** | vllm\_sdk/libqnn/ 中的 Skel 文件 | APK：`ADSP_LIBRARY_PATH`（含 nativeLibDir）；可执行文件：`GENAI_THIRTY_LIB` 目录 | Hexagon DSP 侧加载 |
| **模型权重** | 模型包 qwen3-omni-4b（Context Binary .bin / loras / prefix 等） | /AI/VLM/models/qwen3-omni-4b/ | genai 形态由 `qwen3-omni-4b_8397.json` 的 `model_path`（绝对路径）定位；aiservice 形态由 `model_root` 相对跟随，`VoyahAIService` 扫描根为 /AI/VLM/models（见 2.2） |
| **VIT 预处理 .raw** | raw\_src（position\_ids / pixel\_values，按 448×448 / 1024×768 两档） | /AI/VLM/models/raw\_src/ | `qwen3-omni-4b_8397.json` 的 `veg_params` 引用的**第三个根**，仅 GenAI 形态读（见 2.2） |
| **运行时配置** | vllm\_sdk/models/config/ | /AI/vllm\_sdk/models/config/ | runtime\_config.json / multi\_lora\_runtime\_config.json 等 |
| **Prompt 模板** | vllm\_sdk/models/template/ | /AI/vllm\_sdk/models/template/ | YAML 格式的 Agent 模板（SDK 自带副本，PromptManager 读这份） |

### 2.4 SELinux：同一份 /AI，为什么 android\_test 能跑、APK 却撞墙

同一套设备目录，两种进程访问时 SELinux 身份完全不同——这是可执行文件部署与 APK 部署最大的差异点：

| | android\_test | lantu\_demo APK |
| :--- | :--- | :--- |
| 启动方式 | `adb shell` 手工执行 | 安装应用，系统拉起 |
| 进程域 | `shell` / root（adb 守护进程） | `untrusted_app_32`（第三方应用域） |
| 访问 `/AI`（`u:object_r:AI_file:s0`） | 策略允许，**无阻碍** | 策略**不允许** search/getattr，直接拒绝 |
| 症状 | — | Java 侧只有一句 `CRITICAL: Model directory NOT FOUND: /AI/vllm_sdk/models` |

APK 侧的 avc 记录实例：

```
avc: denied { search } for comm="model-init-thre" name="/" dev="vdy" ino=2
  scontext=u:r:untrusted_app_32:s0:c131,... tcontext=u:object_r:AI_file:s0
  permissive=0 app=com.example.myapplication
```

> [!WARNING]
> **这个拒绝会伪装成「模型没放好」**
>
> `adb shell`（root）看得见目录、md5 全对，APK 却说 NOT FOUND——极易误判成部署错误或路径写错，实际是**域**的问题，不是文件的问题。两个推论：
>
> - **`run-as` 不能当判据**：`run-as` 的域是 `runas_app`，不是 app 真实的 `untrusted_app_XX`；确认现场域要读 `/proc/<pid>/attr/current` 再按 pid 找 avc 记录。
> - **demo 解法是 `setenforce 0`**（整机 permissive，**重启后失效**，是大锤不是方案）；量产岚图 App 是 system/vendor 应用，但仍需正确的 file context + 对应域的 allow 规则，并非自动免疫。策略细节与量产方向（自定义策略 / 独立域）见 [运维、安全与功能安全](ops-security.html) 第 3 节与 [AIService 后端集成与重构](aiservice-integration.html) 的 5.7 节。

> [!NOTE]
> **调试数据录制**
>
> 调试时可通过 Android 系统属性控制数据录制：`adb shell setprop persist.aadk.data_dump 1` 开启，设为 0 关闭。
