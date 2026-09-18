# 7. 运维及安全

*设备安装 · 系统升级 · SELinux · OTA / 模型加密设计 · 常用排查命令*

> [!TIP]
> **本篇讲什么**
>
> 岚图 8397 座舱 VLM 上机的运维流程与安全相关设计：
>
> - 设备安装与上机前置检查
> - 系统升级（刷机 / OTA）
> - SELinux（上机第一坑）
> - OTA 升级与模型加密的设计方案
> - 常用排查命令速查
>
> **说明**：多为上机实操记录与设计草稿；其中 OTA 升级、模型加密两节是**设计方案，尚未落地实现**。

## 1. 设备安装与上机前置

- **硬件安装**：接线、水冷安装、USB 云机挂载
- **上机前置检查**（顺序固定）：
  - `getenforce` 确认 SELinux 状态（demo 需 Permissive，见第 3 节）
  - `adb shell curl 127.0.0.1:8090/v1/models` 确认服务端能看到模型
  - 再看 app `/health`；等就绪要 grep `"model_ready":true`（**不能只 grep `model_ready`**——它在 `false` 时也命中，会误判就绪）

## 2. 系统升级

- PCAT 刷机
- OTA 升级

## 3. SELinux（上机第一坑）

- `/AI` 标签 `u:object_r:AI_file:s0`，策略不允许 `untrusted_app` 域 search/getattr
- 症状只有 Java 侧一句 `Model directory NOT FOUND`，而 `adb shell`（root）看得见目录、md5 全对，**极易误判成「模型没放好」或「我改坏了路径」**
- demo 需 `setenforce 0`（**重启后失效**）；量产岚图 App 是 system/vendor 应用，不受此限
- 详见 [APK 集成与端侧服务化](apk-integration.html) 难点 5.7

## 4. OTA 升级（设计方案，未做）

- 提供所有模型文件的 md5 值
- 升级前进行计算匹配，得到不同的文件
- 下载对应的资源包，存放在固定位置，读取替换

## 5. 模型加密（设计方案，未做）

- **打包工具**：负责将 bin 打包成 img（创建一个稍大一点的文件，再利用加密算法）
- **load 进程**：
  - 负责加载 img 文件、进行 mount 得到 bin 文件，并控制访问权限（shell 不可见）
  - 负责结束时 umount 上述 img 镜像
- **VLM 推理进程访问 bin 的两种方式**（二选一，待结合量产权限模型确认）：

| 方案 | 做法 | 优劣 |
| :--- | :--- | :--- |
| **固定路径** | 经 load 进程挂载后的固定路径访问，配合 SELinux/文件权限，仅 VLM 进程域可读、shell 域不可见 | 实现简单，但依赖 SELinux 域隔离 |
| **fd 传递** | 由 load 进程通过 fd（文件描述符）经 IPC 传递给 VLM 进程，bin 路径完全不暴露 | 隔离性更强，但需 load 与 VLM 进程建立 IPC 通道 |

## 6. 常用排查命令

| 用途 | 命令 |
| :--- | :--- |
| SELinux 状态 | `getenforce` |
| 服务端模型可见性 | `adb shell curl -s 127.0.0.1:8090/v1/models` |
| 重启 AIService 服务 | `adb shell setprop ctl.restart vendor.VoyahAIService` |
| 模型是否真生效（硬证据） | `adb shell cat /proc/<pid>/maps`（看 lora `.bin` 真实路径，`loaded` 不等于生效） |
| DSP/NPU 显存占用 | `adb shell dmabuf_dump <pid>` |
| 进程 CPU 侧内存 | `adb shell dumpsys meminfo <pid>` |
| FastRPC / cDSP 内核日志 | `adb -s $D shell "dmesg \| grep -iE \"fastrpc\|cdsp\" \| tail -20"` |
| 本机联调（免写设备临时文件） | `adb forward tcp:18080 tcp:8080` 后从本机 curl |
