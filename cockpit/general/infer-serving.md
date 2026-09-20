# 6. 端侧解码与服务化优化

*基于 Qualcomm SA8397P 平台  |  前缀缓存 · 投机采样 · 约束解码 · Continuous Batching · 端到端延迟*

> [!TIP]
> **本篇讲什么**
>
> 座舱端侧 LLM 的**工程加速手段**——从原《推理优化》拆出的实战部分，面试最常问：
>
> - 前缀缓存（Prefix Caching）：System Prompt / 多轮对话的 KV 复用
> - 投机采样（Speculative Decoding）：标准加速比公式，以及"端侧到底划不划算"
> - 约束解码（Constrained Decoding）：语法约束 vs 取值域约束
> - Continuous Batching：迭代级调度与 KV 动态管理
> - 端到端延迟优化：把 TTFT 和端到端首屏响应拆成两个指标分别优化
>
> 这些手段都建立在 [LLM 推理原理与性能模型](infer-principles.html) 的 Prefill/Decode 与 Roofline 框架之上；量化方法见 [端侧模型量化与压缩](quantization.html)。

> [!NOTE]
> **锚点模型与数据口径（与全站一致）**
>
> 本篇以 **Qwen3-Omni-4B** 为锚点模型（项目内部定制的 4B 级全模态模型，非公开 Qwen3-Omni 30B-A3B MoE），结构 36 层 / 32 Q head / 8 KV head（GQA）/ head\_dim 128 / 约 4B 参数。平台为 SA8397P：带宽约 68 GB/s、**1 个 cDSP**（HTP 多 graph 时分复用）。完整口径见 [硬件架构](hardware.html) 顶部 NOTE。
>
> 本篇遵循全站「**只讲方法不给数**」约定：文中出现的个别数值一律为**示例参数**，仅用于演示方法、不代表实测，请代入你自己的平台与模型配置计算。

## 1. 前缀缓存 (Prefix Caching)

### 1.1 问题背景

座舱 Agent 每次请求都携带固定的 **System Prompt**（工具定义、人设、安全规则），标准流程中这段相同前缀每次都重新做 Prefill 计算 KV Cache，造成重复计算：

```text
[System Prompt: 固定前缀] + [对话历史] + [视觉 token] + [用户输入]
        ↑ 每次重算 KV = 浪费          ↑ 真正变化的部分
```

### 1.2 前缀缓存原理

```mermaid
flowchart TB
    A["新请求到达"] --> B{"前缀 KV Cache是否命中?"}
    B -->|"命中"| C["直接加载已缓存 KV仅对新 token 做 Prefill"]
    B -->|"未命中"| D["对完整 Prompt 做 Prefill"]
    D --> E["将前缀 KV序列化到共享缓冲"]
    E --> F["写入缓存Key = hash(前缀 tokens)"]
    C --> G["拼接: 缓存 KV + 新 KV"]
    F --> G
    G --> H["开始 Decode"]

    style B fill:#f39c12,color:#fff
    style C fill:#2ecc71,color:#fff
    style D fill:#e74c3c,color:#fff
    style H fill:#4361ee,color:#fff
```

### 1.3 节省比例：给推导，不给"60~80%"

> [!IMPORTANT]
> **前缀缓存的节省比例 = 缓存命中的前缀 token 数 ÷ 总 Prefill token 数。**
>
> 这个比例**高度依赖 prompt 结构**，不能拍一个"60~80%"。尤其多模态场景下，总 Prefill token 里含大量**视觉 token**，而文本前缀缓存覆盖不到它们：

```text
示例（非实测）:
  System Prompt 前缀 = 300 文本 token（可缓存）
  视觉 token        = 576（每帧，不可被文本前缀缓存覆盖）
  用户输入          = 50
  总 Prefill token  = 300 + 576 + 50 = 926

  命中时节省比例 = 300 / 926 ≈ 32%   ← 远达不到 80%
```

**结论**：视觉 token 占比越高，文本前缀缓存的收益越低。要真正省 Prefill，得连视觉侧一起想办法（如视觉 token 的缓存/复用、降低单帧视觉 token 数）。

### 1.4 实现方案

```python
import hashlib
import numpy as np

class PrefixKVCache:
    """前缀 KV Cache 管理器：按字节预算淘汰（条目大小由原理篇 KV 公式推出）"""
    def __init__(self, memory_budget_bytes=512 * 1024 * 1024,
                 kv_bytes_per_token=144 * 1024):
        self.cache = {}          # key -> (kv_data, size_bytes)
        self.lru_order = []
        self.memory_budget = memory_budget_bytes
        # 每条目大小 = prefix_len × 每 token KV 字节
        # （原理篇 §3.1：2×n_layers×n_kv_heads×head_dim×bytes_per_elem，
        #   锚点 FP16 = 144 KB/token，INT8 = 72 KB/token）
        self.kv_bytes_per_token = kv_bytes_per_token
        self.used_bytes = 0

    def compute_key(self, token_ids, model_id, quant, lora_id,
                    position_offset, kv_dtype):
        # key 必须包含所有"会改变 KV 内容"的因素：
        #   前缀 tokens + 模型/量化（权重不同 KV 不同）+ LoRA id
        #   （adapter 改 k/v 投影）+ position offset（位置编码相位）+ KV dtype
        payload = np.array(token_ids, dtype=np.int32).tobytes() + \
            f"|{model_id}|{quant}|{lora_id}|{position_offset}|{kv_dtype}".encode()
        return hashlib.sha256(payload).hexdigest()[:16]

    def get(self, key):
        if key in self.cache:
            self.lru_order.remove(key)
            self.lru_order.append(key)
            return self.cache[key][0]
        return None

    def put(self, key, kv_data, prefix_len):
        size = prefix_len * self.kv_bytes_per_token
        if size > self.memory_budget:      # 单条目超预算：不缓存
            return
        while self.used_bytes + size > self.memory_budget and self.lru_order:
            old_key = self.lru_order.pop(0)              # LRU 淘汰
            self.used_bytes -= self.cache[old_key][1]
            del self.cache[old_key]
        self.cache[key] = (kv_data, size)
        self.lru_order.append(key)
        self.used_bytes += size

    def prefill_with_cache(self, model, full_prompt_tokens, prefix_len, key_ctx):
        prefix = full_prompt_tokens[:prefix_len]
        suffix = full_prompt_tokens[prefix_len:]
        key = self.compute_key(prefix, **key_ctx)
        cached_kv = self.get(key)
        if cached_kv is not None:
            return model.prefill(suffix, past_kv=cached_kv)   # 命中：只 prefill 后缀
        kv = model.prefill(full_prompt_tokens)                # 未命中：全量 + 缓存前缀
        self.put(key, kv.slice(0, prefix_len), prefix_len)
        return kv
```

两个实现要点：

- **按字节预算淘汰，而不是按条目数**：每条缓存的大小 = `prefix_len × 每 token KV 字节`（[KV Cache 公式](infer-principles.html)），长短前缀混存时按条目数限容会让内存占用不可控。
- **key 不只含前缀 tokens**：KV 是特定权重对特定前缀的 prefill 产物，凡改变 KV 内容的因素都要进 key——模型版本、量化、LoRA id、position offset（KV 与绝对位置绑定）、KV dtype。漏掉任何一项，命中的就是"长得像但内容错"的 KV。

### 1.5 多轮对话的分层缓存

| 缓存层级 | 缓存内容 | 缓存时机 |
| :--- | :--- | :--- |
| **L1: System Prompt** | 工具定义 + 人设 + 安全规则 | 应用启动时预计算，常驻内存 |
| **L2: 对话历史** | 前 N 轮对话的 KV | 每轮结束后更新 |
| **L3: 高频模板** | "导航到XX""调空调XX度"等模式 | 统计频率后预计算 |

> [!TIP]
> **Best Practice: Prompt 模板设计**
>
> 为最大化命中率，遵循**"静态在前、动态在后"**：前缀（固定）= System 人设 → 工具定义 → 安全规则 → 输出格式；后缀（变化）= 对话历史 → 车辆状态 → 用户输入。工具集合动态变化时，把稳定的本地工具放前面、动态工具放后面。缓存的前缀 KV 占用可由 [KV Cache 公式](infer-principles.html) 直接算出，据此决定常驻多少。

> [!WARNING]
> **"L1 常驻"与 ring buffer 回绕冲突**
>
> 端侧 KV Cache 以 graph I/O 形式表达，是每套编译图自己的**环形缓冲（ring buffer）**，容量按上下文上限一次性划定、写满回绕（[原理篇 §7](infer-principles.html)）。长多模态对话下（视觉 token 是 KV 大头，每帧 ≈576 token），回绕会**最先覆盖最旧的 System Prompt KV**——恰恰是 L1 最想常驻的那段。两个对策：① System Prompt KV 单独存一份，回绕后重新拼回；② 按轮数/帧数主动截断历史，让总长度不进回绕区。
>
> 另注意：**多轮对话应增量追加**——每轮只对新 token 做 prefill、把新 KV 追加到 ring buffer 尾部，**不要重算历史**。重算历史正是前缀缓存要消除的浪费。

### 1.6 成本侧：break-even、换出与多 LoRA

前缀缓存不是"白省"，先给 break-even 推导（示例参数）：

```text
重算一个已缓存 token 的成本（prefill 已 compute-bound，见 §5.2）:
  ≈ 2N ÷ (FP16 峰值 × MFU)
  = 2×4e9 ÷ (35e12 × 0.3) ≈ 0.76 ms    （保守峰值 17e12 × 0.3 → ≈ 1.57 ms）

读回一个 token 的缓存 KV 的成本（memory-bound）:
  ≈ 每 token KV 字节 ÷ 带宽 = 144 KB ÷ 68 GB/s ≈ 2 µs

→ 读回比重算便宜约 360~750×：只要 KV 留在 DDR 里，前缀缓存几乎总是划算。
```

> [!WARNING]
> **KV 一旦换出 DDR，这个 break-even 就翻转。**
>
> 上面的结论前提是缓存 KV **常驻内存**。若为省内存把 KV 换出到 flash，读回变成 flash I/O（比 DDR 带宽慢一个量级以上），重算省下的时间会被 I/O 吃回去——**宁可重算，不要换出**。缓存容量按"内存里能常驻多少 KV"规划，而不是"flash 上能存多少"。

**多 LoRA 注意**：LoRA adapter 会修改 k/v 投影，同一段前缀在不同 adapter 下 prefill 出的 KV **不同**——前缀 KV **不可跨 adapter 共享**，每个 (prefix, adapter) 组合各存一份，缓存条目数 = prefix 数 × adapter 数。本站岚图项目即 11 个 prefix × 5 个 adapter（对应关系见 [GenAI 架构 §3.1](../projects/lantu/genai-architecture.html)），做缓存内存预算时按组合数而不是 prefix 数算。

## 2. 投机采样 (Speculative Decoding)

### 2.1 核心思想

标准自回归解码每个 token 都要等前一个生成完，严格串行、受带宽限制。**投机采样**用一个小的"草稿模型"快速生成 K 个候选 token，再由大的"目标模型"在一次前向中并行验证，把多步串行解码压成一步验证：

```mermaid
sequenceDiagram
    participant Draft as 草稿模型(小)
    participant Target as 目标模型(锚点 4B)
    participant Output as 最终输出

    Note over Draft,Target: 一轮迭代 (K=4)
    Draft->>Draft: 自回归生成 4 个候选 token
    Draft->>Target: 发送 [t1,t2,t3,t4]
    Target->>Target: 一次前向验证全部 4 个
    Target->>Output: t1,t2,t3 接受 / t4 拒绝并重采样
    Note right of Output: 本轮净产出 = 接受数 + 1 个重采样 token
```

### 2.2 验证与接受机制

投机采样是**无损采样**——最终输出分布与直接用目标模型采样一致。对草稿 token `t_i`：

- 接受概率 `min(1, p_target(t_i)/p_draft(t_i))`；随机数 < 接受概率则**接受**，继续验证下一个。
- 否则**拒绝**，从修正分布 `norm(max(0, p_target − p_draft))` 重采样（`norm` = 归一化：逐点取差后非负但不再求和为 1，须重新归一化才是合法分布）；拒绝后后续草稿 token 全部丢弃。

### 2.3 加速比：用标准公式，别用错版

> [!IMPORTANT]
> **标准加速比公式**
>
> ```text
> Speedup = E[每轮产出 token 数] / E[每轮成本(以目标单步为单位)]
>         = [(1 - α^(K+1)) / (1 - α)] / (1 + K·c)
>
>   α = 单 token 接受率
>   K = 每轮草稿 token 数
>   c = 草稿单步耗时 / 目标单步耗时
> ```
>
> 分子 `(1-α^(K+1))/(1-α)` 是每轮期望产出（含拒绝后白送的 1 个 token，α→1 时趋于 K+1）；分母 `1+K·c` 是每轮成本（1 次目标验证 + K 次草稿生成）。**忽略草稿开销（c）的公式会严重高估加速比。**

### 2.4 端侧的诚实结论：单 HTP 上收益有限

> [!WARNING]
> **在单个 cDSP 上，草稿与目标只能串行：α 在现实区间 0.7~0.9 时收益仅约 1.1~1.6×（理论上界 (K+1)/(1+K·c)，α→1 时 ≈1.92×），加上独立草稿权重很可能净亏损。**
>
> 云端可让草稿与目标**并发**（不同器件），c 趋近 0，加速比 ≈ 分子（α=0.85、K=4 时约 3.7×）。但端侧只有 **1 个 cDSP**，draft 与 target 时分串行，**c 由权重比决定**（草稿 ~1.0 GB / 目标 ~2.5 GB → c ≈ 0.4；且这还是下界，见 §2.7 的 LM head 论证），分母被显著抬高。

```text
示例推导（非实测，c=0.4, K=4 → 每轮成本 = 1 + 4×0.4 = 2.6）:
  α=0.6 → 分子 2.31 → Speedup ≈ 0.89×  (反而更慢)
  α=0.7 → 分子 2.77 → Speedup ≈ 1.07×
  α=0.8 → 分子 3.36 → Speedup ≈ 1.29×
  α=0.85→ 分子 3.71 → Speedup ≈ 1.43×
  α=0.9 → 分子 4.10 → Speedup ≈ 1.58×
```

**K 也不是越大越好：最优 K\* 由 (α, c) 共同决定。** K 越大，分母 (1+K·c) 线性变贵，而草稿 token 的边际期望产出按 α 的幂衰减，两者平衡处才是 K\*。端侧 c 大 → K\* 偏小：示例参数 c=0.4、α=0.8 时 **K\*=2 优于 K=4**（≈1.36× vs ≈1.29×）。别默认 K=4——把加速比公式写出来，对 (α, c) 数值扫描一阶条件，取你平台上的最优 K。

即便接受率很高，端侧加速也就 **~1.1~1.6×**；而代价是草稿模型 ~1.0 GB 权重 + 它自己的 KV Cache 常驻内存。**在内存紧张、又要与 DMS 等模型共存的车机上，"独立草稿模型"这笔账很可能是负的。** 注意该结论限定**独立草稿模型**这一种方案——端侧真正可行的替代见 §2.7。这个"独立草稿不划算"的判断，比一个乐观的加速比数字有价值得多。

### 2.5 两条容易忽略的限制

- **草稿模型必须与目标模型共享 tokenizer / 词表**——否则拒绝采样无从对齐 token，机制直接失效。
- **多模态场景下草稿模型看不到图像**：锚点是全模态模型，但小草稿模型通常只处理文本。涉及视觉 grounding 的 token，草稿与目标分布差异大，**接受率会崩塌**——而这恰恰是座舱多模态请求的常态。

### 2.6 Token Tree Verification

进阶方案让草稿生成一棵 **Token 树**（每位置扩 2~3 个分支），目标一次前向验证整棵树、取最长有效路径。同等接受率下每轮产出更高——但端侧仍受 §2.4 的串行成本约束，收益上限不变。

> [!WARNING]
> **何时不适合投机采样**
>
> * 输出很短（分类仅 1~3 token）：草稿 + 验证开销反而增加延迟
> * 内存极度紧张：两模型共存挤占其他子系统
> * 接受率过低（< 50%）：频繁拒绝，加速不明显甚至变慢
> * 高创造性任务（高 temperature）：草稿与目标分布差异大，接受率下降

### 2.7 端侧可行的替代方案与草稿成本的硬下界

§2.4 的"不划算"限定**独立草稿模型**。端侧真正可行的替代都绕开了它的两个痛点——草稿权重常驻内存、c 太大：

| 方案 | 原理 | 为什么适合端侧 |
| :--- | :--- | :--- |
| **Medusa / EAGLE 头** | 在目标模型最后一层接多个轻量预测头，并行提议后续若干位置的 token，仍由目标模型一次前向验证 | **复用 target 的权重与 KV**，无独立草稿模型，额外内存只有几个头本身（与 [面试篇 Q37](interview.html) 的"端侧推荐方案三"一致） |
| **n-gram / prompt-lookup decoding** | 零草稿模型：从上下文与高频模板里检索候选续写（n-gram 匹配），交给目标模型验证 | 草稿成本 ≈ 0（CPU 侧检索）、零额外内存；座舱车控话术高度模板化（"导航到XX""空调调到XX度"），n-gram 命中率天然高 |
| **jump-forward decoding** | grammar 约束解码（§3）进入确定段（固定 key、标点、枚举值）时，直接把这些 token 写进结果，不做模型前向 | 零接受率风险、零草稿成本；与 Function Calling 的 grammar 天然协同 |

> [!IMPORTANT]
> **c 有硬下界：任何输出全词表 logits 的草稿，每步都必须读一遍 LM head**
>
> §2.4 用权重比（草稿权重 ÷ 目标权重）估 c，这会**系统性低估**草稿成本。锚点模型 LM head = vocab × hidden × 2B ≈ 150K × 2560 × 2 ≈ **768 MB**（示例参数，[原理篇 §2.3](infer-principles.html)），任何要输出全词表分布的草稿每步都要对它做全量 GEMV——单块就占每 token 带宽读取的 **~30%**。所以哪怕草稿"权重为零"，c 也有 **~0.3 的硬下界**；再叠加每步固定开销（graph launch、sampling、detokenize、同步），实际 c 只会更高。**端侧结论比权重比推算更悲观**——这既是否定独立草稿的另一条理由，也解释了上表替代为何可行：jump-forward 根本不读 LM head，Medusa/EAGLE 与 n-gram 验证把提议成本摊进了目标模型本来就要做的那次前向。

## 3. 约束解码 (Constrained Decoding)

### 3.1 问题背景

座舱 Agent 需要 LLM 输出结构化 JSON 调用 Function Calling：

```json
{"function": "set_ac_temperature", "arguments": {"temp": 24}}
```

但 LLM 是自由生成，可能产出格式错误（缺引号、括号不匹配、字段名拼错），每次错误都意味着一次失败交互和重试成本。

### 3.2 约束解码原理

核心思想：每步生成时，根据已生成内容和目标格式规则，**遮蔽 (mask) 所有不合法 token**，只允许生成合法 token：

```mermaid
stateDiagram-v2
    [*] --> START
    START --> IN_OBJECT: 左花括号
    IN_OBJECT --> IN_KEY: 引号
    IN_KEY --> KEY_DONE: function/arguments
    KEY_DONE --> COLON: 冒号
    COLON --> IN_VALUE: 引号/数字/左花括号
    IN_VALUE --> VALUE_DONE: 值结束
    VALUE_DONE --> COMMA: 逗号
    VALUE_DONE --> END_OBJECT: 右花括号
    COMMA --> IN_KEY: 引号
    END_OBJECT --> [*]
    note right of IN_KEY: 仅允许预定义 key
    note right of IN_VALUE: 值类型由 Schema 约束
```

### 3.3 三种主要方法

| 方法 | 原理 | 表达能力 | 典型实现 |
| :--- | :--- | :--- | :--- |
| **JSON Schema 引导** | 按 Schema 的类型/枚举/必选字段过滤不合法 token | 中，覆盖标准 JSON | vLLM structured output, Outlines |
| **有限状态机 (FSM)** | 预定义状态转移图，仅允许合法转移的 token | 中，适合正则可描述格式 | Outlines FSM, lm-format-enforcer |
| **上下文无关文法 (CFG)** | BNF/GBNF 定义语法，下推自动机跟踪解析栈 | 最强，支持递归嵌套 | llama.cpp GBNF, guidance |

### 3.4 座舱 Function Calling 约束示例

```text
# GBNF: 座舱 Function Calling 输出约束（按函数分支，函数与参数绑定）
root        ::= ac-call | nav-call | music-call | window-call | seat-call | vol-call

# 每个函数一条独立分支：函数名字面量 + 它自己的 arguments 规则
ac-call     ::= "{" ws "\"function\"" ws ":" ws "\"set_ac_temperature\"" ws "," ws "\"arguments\"" ws ":" ws ac-args ws "}"
nav-call    ::= "{" ws "\"function\"" ws ":" ws "\"navigate_to\"" ws "," ws "\"arguments\"" ws ":" ws nav-args ws "}"
music-call  ::= "{" ws "\"function\"" ws ":" ws "\"play_music\"" ws "," ws "\"arguments\"" ws ":" ws music-args ws "}"
window-call ::= "{" ws "\"function\"" ws ":" ws "\"window_control\"" ws "," ws "\"arguments\"" ws ":" ws window-args ws "}"
seat-call   ::= "{" ws "\"function\"" ws ":" ws "\"seat_heater\"" ws "," ws "\"arguments\"" ws ":" ws seat-args ws "}"
vol-call    ::= "{" ws "\"function\"" ws ":" ws "\"set_volume\"" ws "," ws "\"arguments\"" ws ":" ws vol-args ws "}"

# 各函数的 arguments：key 用字面量枚举，取值域直接写进各自分支
ac-args     ::= "{" ws "\"temp\"" ws ":" ws ac-temp ws "}"
ac-temp     ::= [0-9] | [1-3] [0-9]                       # 空调温度 0~39℃
nav-args    ::= "{" ws "\"destination\"" ws ":" ws string ws "}"
music-args  ::= "{" ws "\"song\"" ws ":" ws string ws "}"
window-args ::= "{" ws "\"position\"" ws ":" ws win-pos ws "," ws "\"action\"" ws ":" ws win-action ws "}"
win-pos     ::= "\"driver\"" | "\"passenger\"" | "\"rear_left\"" | "\"rear_right\"" | "\"all\""
win-action  ::= "\"open\"" | "\"close\""
seat-args   ::= "{" ws "\"level\"" ws ":" ws [0-3] ws "}"  # 座椅加热 0~3 档
vol-args    ::= "{" ws "\"volume\"" ws ":" ws vol-num ws "}"
vol-num     ::= [0-9] | [1-9] [0-9] | "100"                # 音量 0~100

# string：补全 JSON 转义序列，并排除控制字符
string      ::= "\"" char* "\""
char        ::= [^"\\\x00-\x1F] | "\\" (["\\bfnrt] | "u" hex hex hex hex)
hex         ::= [0-9a-fA-F]
ws          ::= [ \t\n]*
```

此语法从 `root` 就按函数分支：函数名只能是 6 个字面量之一（杜绝拼错或幻觉调用不存在的工具），且每个分支绑定**自己的** arguments 规则——参数 key 是字面量枚举、取值域写进分支，杜绝"函数与参数串线"。`string` 规则补上了 JSON 转义（`\"` `\\` `\b\f\n\r\t` `\uXXXX`）并排除控制字符——朴素写法 `[^"\\]*` 会放行裸换行等 JSON 非法字符，埋下解析雷。

> [!NOTE]
> 分支里的取值域写法（如 `ac-temp ::= [0-9] | [1-3][0-9]`）只是演示 grammar 的表达力——把数值范围写死进 grammar 有实打实的工程代价，更稳的做法见 §3.5。

### 3.5 语法约束 ≠ 取值域约束

> [!IMPORTANT]
> **区分两类约束——这是专家级的关键认知。**
>
> - **语法约束（grammar/FSM 可做到 100%）**：输出一定符合 JSON 结构、函数名一定在枚举内、括号一定匹配。GBNF 能严格保证这一层。
> - **取值域约束（grammar 本身保证不了）**：`{"temp": -5}` **语法完全合法**，但语义非法（空调温度不该为负）。若参数值用通用数字规则（如 `number ::= "-"? [0-9]+`），它恰恰**允许负温度**——§3.4 示例为此把每个参数的取值域写进了各自分支，但这又有自己的工程代价（见下方 WARNING）。
>
> 要约束取值域，有两条路：① **在 grammar 里把范围写死**（如 `temp ::= [0-9] | [1-3][0-9]` 限定 0~39，§3.4 示例即此写法）；② **交给执行器校验**，非法值拒绝并重试。把"格式有效率 100%"当成"参数一定正确"是范畴错误。

> [!WARNING]
> **范围写死进 grammar 的工程代价**
>
> - **粒度错配**：mask 是 **token 级**的，范围是**字符级**的——同一个数字有多种 BPE 切分（"24" 可能是一个 token，也可能是 "2"+"4" 两个），enforcer 必须对每个候选 token 逐一模拟 FSM 转移才能判断合法性。
> - **扭曲数值分布**：不同切分路径的概率质量被重新分配，最终生成的数值分布会偏离模型先验（模型"想输出 24"与"grammar 允许哪条切分路径走到 24"是两回事）。
> - **截断风险**："3" 本身就是 "35" 的合法前缀——若 grammar 在该位置也允许收尾（如 `[0-9]` 分支已满足），模型可能提前终止在 "3"，产出一个"合法但错误"的值。
>
> 所以更稳的做法是：**枚举合法值字面量**（如温度 0~39 直接枚举 40 个字面量让模型选，没有切分歧义），或**把数值级校验交给执行器**——grammar 只保证"这是个数字"，范围由执行器校验、越界重试或兜底。

### 3.6 约束解码的权衡

> [!WARNING]
> **上线前必须做的两项验证：grammar 真的生效了 + 内容质量没有劣化**
>
> - **确认运行时真实现了约束解码**。本站项目实测：QNN 后端未实现约束解码，缺 EBNF 时仅 warn 一条日志后**静默降级**继续生成——你以为输出有约束，其实没有（[岚图 AI Service 集成 · 难点 5.5](../projects/lantu/aiservice-integration.html)）。验证方法：故意构造会被 grammar 拦截的输入，确认输出真的被约束住了，而不是只检查"配置里挂了 EBNF"。
> - **A/B 验证内容质量**。grammar 与模型先验冲突时会显著劣化输出：本站项目实测，一个只约束外壳 `{"nlg": ...}`、不约束内容的 grammar，使完整句输出仅 **2/17**；去掉该 grammar 后 **17/17** 干净。grammar 的收益是"格式合法"，不自动等于"内容更好"——两者冲突时必须用 A/B 数据决定去留。

> [!NOTE]
> **权衡**
>
> **好处**：消除语法错误、消除因格式失败的重试、降低端到端延迟；工具名枚举防幻觉调用。
>
> **代价一（内容）**：对自由文本回复（闲聊、解释）不适用——过度约束降低自然性，甚至与模型先验冲突劣化输出（见上方 WARNING）。
>
> **代价二（每 token CPU 开销）**：mask 是 **host 侧 CPU** 的工作——每个 decode step 要对全词表（示例 ~150K）写一遍 allowed-token mask、并推进 FSM 状态，这部分**直接叠加进 TPOT**；端侧 CPU 弱、词表大时更显著。优化手段：预编译 token→FSM 转移表、按状态缓存 allowed-token bitmask（同一状态不重算）、用 trie 前缀剪枝避免全词表扫描。
>
> **推荐策略**：LLM 先生成一个 `action_type` token 判断是 `tool_call` 还是 `text_reply`；前者启用 GBNF 约束，后者关闭约束自由生成。
>
> **注意**：约束解码省的是"重试"，作用在**端到端延迟**，对 **TTFT 零影响**（见 §5）。

## 4. Continuous Batching

### 4.1 静态批处理的局限

传统静态批处理要求同 batch 内所有请求同时开始、同时结束。由于生成长度不固定，短请求必须等最长请求完成才能释放资源：

| 时刻 | 静态批处理行为 | 问题 |
| :--- | :--- | :--- |
| t=0 | 请求 A（长回复）进入 NPU | — |
| t=0.5 | 请求 B（短回复）到达 | 必须排队等 A |
| t=2.0 | A 完成，释放 NPU | B 白等了 1.5s |
| t=3.2 | B 完成 | B 端到端延迟被 A 拖长 |

座舱多音区场景中，驾驶员/副驾可能在不同时刻发起指令，静态批处理要么串行（延迟高）、要么整 batch 等待（利用率低）。

### 4.2 Continuous Batching 原理

Continuous Batching（Yu et al., 2022, Orca）把调度粒度从**请求级**细化到**迭代级**：每完成一次 Decode 迭代就重新调度——已完成的请求立即释放 KV Cache，新请求可插入当前 batch 做 Prefill。

```mermaid
flowchart TB
    A["新请求到达"] --> B["加入等待队列"]
    B --> C{"当前 Batch 有空位?"}
    C -->|"有"| D["加入 Batch 执行 Prefill"]
    C -->|"无"| E["继续等待"]
    E --> C
    D --> F["参与迭代 Decode"]
    F --> G{"生成完毕?"}
    G -->|"是"| H["返回结果 释放 KV Cache"]
    G -->|"否"| F
    H --> C

    style A fill:#4361ee,color:#fff
    style H fill:#2ecc71,color:#fff
    style E fill:#f39c12,color:#fff
```

| 对比维度 | 静态批处理 | Continuous Batching |
| :--- | :--- | :--- |
| **调度粒度** | 请求级（同进同出） | 迭代级（逐 token 调度） |
| **新请求** | 等当前 batch 全部完成 | 下一迭代即可加入 |
| **完成请求** | 等最慢请求 | 立即释放 KV |
| **NPU 利用率** | 低（padding 浪费） | 高（接近持续满载） |
| **平均延迟** | 短请求被拖慢 | 各请求独立完成 |
| **实现复杂度** | 低 | 高（需动态 KV 管理） |

### 4.3 座舱多音区调度

端侧推理框架由**调度器**负责多请求调度。座舱场景的特殊性：

| 座舱特点 | 对调度的影响 | 应对策略 |
| :--- | :--- | :--- |
| **多音区并发** | 驾驶员/副驾/后排可能同时说话 | 按请求来源/会话区分，支持同 batch 内多音区共存 |
| **优先级差异** | 安全告警 > 车控指令 > 闲聊 | 分级优先级调度，高优先级可抢占 |
| **延迟敏感** | 车控指令要求端到端有界 | 高优先级请求跳过等待队列，立即加入 batch |
| **KV 受限** | 端侧内存需多模型共享 | 动态 KV 分配 + 按优先级淘汰低优先级缓存 |
| **请求长度差异大** | 车控短 vs 闲聊长 | 短请求快速释放，避免阻塞后续 |

> [!NOTE]
> **端侧 vs 云端 Batching 差异**
>
> 云端 vLLM 面对数百并发，重点是**吞吐最大化**。端侧座舱通常同时只有 2~4 个请求，Continuous Batching 的核心价值不在吞吐，而在**降低短请求排队延迟**和**支持优先级抢占**——例如副驾闲聊时驾驶员发出紧急车控，车控请求能在下一迭代立即加入，而非等闲聊生成完。
>
> **注意这个判断有前提**：所用运行时不支持编译期 batch 维、只能多 graph 时分。若运行时支持真 batching，吞吐 ≈ ×B，"核心价值不在吞吐"就不成立——分支与判据见 §4.5。

### 4.4 KV Cache 动态管理

Continuous Batching 的核心挑战是 KV 的动态分配与回收。PagedAttention（Kwon et al., 2023, vLLM）把 KV 按固定大小的**页**分配，类似操作系统虚拟内存：

| KV 管理方式 | 内存分配 | 利用率 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **静态预分配** | 按 max\_seq\_len 预留 | 低（大量 padding） | 单请求、固定长度 |
| **动态连续分配** | 按实际长度申请 | 中（碎片化） | 请求数少 |
| **PagedAttention** | 按页（如 16 token/页）分配 | 高（页级管理） | 高并发、变长序列 |

端座舱并发少（2~4 个），动态连续分配通常够用；但引入前缀缓存（多请求共享 System Prompt KV）时，PagedAttention 的页级共享能显著减少重复存储。

### 4.5 端侧可行性：不是所有运行时都做得了 Orca 式 batching

> [!IMPORTANT]
> **先看两条端侧事实**（[原理篇 §7](infer-principles.html)）：
>
> - prefill 与 decode 是**两套静态 shape 的编译图**（prefill 按固定 chunk、decode seq=1），张量 shape 不同；
> - KV Cache 以 graph I/O 表达，每套图有自己的 **ring buffer**，容量编译期划定。
>
> 所以 Orca 式"把新请求的 prefill 插入当前 decode batch"在端侧**做不到**——两套图 shape 不同，混不进同一个 batch。PagedAttention 同理有前提：attention kernel 必须支持**按 page table 间接寻址取 KV**，HTP 上的 kernel 是否支持，以所用运行时为准，不能默认有。

于是端侧"batching"按运行时能力分成两条分支：

| 运行时能力 | 实际形态 | 性能后果 |
| :--- | :--- | :--- |
| **支持 batch 维**（编译期固定 B + 多请求共享 KV 池） | B 个请求进同一套 decode graph 并行 | B=2~4 时 decode AI = 4·B = 8~16，仍远低于 Knee（[原理篇 §2.2](infer-principles.html)）→ **每步 decode 时间几乎不变、吞吐 ≈ ×B**，batching 优于时分 |
| **不支持 batch 维** | 多请求在多套 graph 间时分复用 | 每请求 TPOT 随并发数**线性恶化**——这是时分，不是 batching |

> [!TIP]
> **一条判据分清两条分支**：分别 profile"单请求 TPOT"与"并发 2 的每请求 TPOT"。并发 2 时 TPOT ≈ 不变 → 真 batch，吞吐收益成立；TPOT ≈ 2× → 时分，§4.3 的"核心价值不在吞吐"成立、且每请求延迟随并发恶化。端侧谈 Continuous Batching，先确认运行时落在哪条分支，再谈收益。

## 5. 端到端延迟优化

### 5.1 先分清两个指标，再给统一分解式

> [!IMPORTANT]
> **TTFT ≠ 端到端首屏响应。把"生成剩余 token"算进 TTFT 是定义错误。**
>
> - **TTFT（Time To First Token）= tokenize + ViT 编码 + Prefill 前向（末位 logits 即首 token）+ 采样/detokenize**。它是"用户多久看到第一个字"。注意首 token 由 Prefill 前向的**末位 logits** 产出——"Prefill + 首 token 生成"不是一次额外的前向，别重复计数。
> - **端到端首屏响应 = TTFT + 生成完整首屏回复的剩余 decode**（如一条完整 Function Call JSON）。
>
> 二者优化手段不同，必须分开列。

统一分解式——本篇所有优化手段都归位到其中某一项：

```text
E2E = T_queue + TTFT + (N_out − 1) · T_POT + T_tail

  T_queue : 请求排队等待（端侧单 cDSP、多 graph 时分，忙时排队不可免）
  TTFT    = T_tokenize + T_vit + T_prefill (+ 首 token 采样/detokenize)
  T_POT   : 即 TPOT（Time Per Output Token），decode 阶段每 token 耗时
            ≈ 每 token 读取字节 ÷ 有效带宽（原理篇 §2.3）
            锚点理想值 ≈ 2.5 GB ÷ 68 GB/s ≈ 37 ms/token（示例参数）
  T_tail  : 末段 detokenize / 回调等收尾
```

三个容易被忽略的点：

- **排队项归入用户感知的"首 token 延迟"**：T_queue 在 TTFT 之前，用户视角都是"等第一个字"。所以 Continuous Batching / 优先级调度降排队，也是 TTFT 侧的优化（见 §5.3）。
- **N_out 是端侧最被低估的杠杆**：TPOT ~37 ms × N_out 往往远大于 TTFT——把输出从 200 token 压到 30 token，decode 段就从 ≈7.4 s 降到 ≈1.1 s（示例参数），比任何 decode 加速手段都有效。在不伤体验的前提下用 prompt 约束与 max_tokens 压输出长度。
- **decode 加速要按 Amdahl 定律打折**：投机采样的 1.43×（§2.4 示例）只作用在 decode 项。设 f = decode 段占 E2E 的比例，端到端收益 = 1/((1−f) + f/1.43)。示例：N_out=30、decode 段 ≈1.1 s、TTFT ≈0.5 s → f ≈ 0.68，端到端收益 ≈ **1.25×** 而非 1.43×。

### 5.2 TTFT 的推导（方法，不是拍数字）

TTFT 的两段主要耗时都用 [Roofline](infer-principles.html) 推：

```text
① Prefill 时间 ≈ Prefill FLOPs ÷ (FP16 峰值 × MFU)
   Prefill FLOPs ≈ 2 × N_params × S_total
   示例（非实测）: N=4B
     纯文本短 prompt S=350 → 2×4e9×350 = 2.8 TFLOP
       峰值 ~35 TFLOPS(常见) × MFU 0.3 → ≈ 2.8/(35×0.3) ≈ 275 ms
       峰值 ~17 TFLOPS(保守) × MFU 0.3 → ≈ 2.8/(17×0.3) ≈ 550 ms
       区间 (峰值 17~35 × MFU 0.2~0.4) → ≈ 200~820 ms
     含单帧视觉的真实请求 S=926（对齐 §1.3：300 文本 + 576 视觉 + 50 输入）
       → 2×4e9×926 ≈ 7.4 TFLOP，同法 → ≈ 530~2180 ms

② ViT 编码时间 ≈ ViT FLOPs ÷ (峰值算力 × MFU)
   推导骨架: ViT FLOPs ≈ 2 × N_vit × S_patch（再加每层 S_patch² 注意力项）
     N_vit = ViT 参数量, S_patch = 每帧视觉 patch 数（= 视觉 token 数，锚点 576/帧）
   单帧纯计算通常在数十 ms 量级（示例）
```

**TTFT 的不确定度主要由 MFU 与峰值取值决定，所以给区间、不给点值**——面试与文档里写"TTFT ≈ X ms"而不声明 MFU/峰值假设，等于拍数字。

> [!WARNING]
> **两个常见数字陷阱**
>
> - **Prefill 别拍一个与 Roofline 差好几倍的值**（如凭空写 1500ms）。要么给推导（含视觉 token 数、MFU 假设），要么落到与 Roofline 自洽的量级。
> - **ViT 耗时区分"纯计算"与"含排队"**：单帧 ViT 纯计算是数十 ms 量级；若看到数百 ms，多半是**含在单 cDSP 上排队等待**的端到端数字（见 [多 graph 时分复用](infer-principles.html)），必须标注清楚，否则会和纯计算值差出一个数量级。

### 5.3 TTFT 优化（只列真正影响 TTFT 的手段）

| 优化手段 | 对 TTFT 的作用 | 原理 |
| :--- | :--- | :--- |
| **前缀缓存** | 降低 | 跳过 System Prompt 的 Prefill（节省比例见 §1.3） |
| **降低视觉 token 数** | 降低 | 直接缩短 Prefill 序列 S |
| **Continuous Batching / 优先级调度** | 降低 TTFT 的排队分量 (T_queue) | 排队是用户感知"首 token 延迟"的一部分（§5.1） |
| **ViT 优先级调度** | 降低排队部分 | 让活跃请求的 ViT 少排队（§5.2 陷阱②） |
| **Context Binary** | 降低（限冷启动首次请求） | 离线编译，消除运行时图编译；后续请求图已加载，不再重复受益 |
| ~~权重量化 (W4A16)~~ | **基本无影响**（典型 prompt 已 compute-bound） | W4A16 的 matmul 仍走 FP16 通路、峰值不变，dequant 反加开销；TTFT 收益仅在 prefill 仍 memory-bound（S 低于 Knee）时成立。它真正降的是**内存占用、首次加载时间、decode TPOT**（见 §5.4） |
| ~~投机采样~~ | **无影响** | 只加速 decode，对 Prefill/TTFT 零作用 |
| ~~约束解码~~ | **无影响** | 省的是重试，属端到端，不属 TTFT |

### 5.4 端到端首屏响应优化

| 优化手段 | 对端到端的作用 | 原理 |
| :--- | :--- | :--- |
| **压缩输出长度 N_out** | 降低（端侧最大杠杆） | decode 段 = (N_out−1)·TPOT，常远大于 TTFT（§5.1） |
| **投机采样及其变体** | 降低（α 0.7~0.9 时 ~1.1~1.6×，且只作用 decode 项、按 Amdahl 打折，见 §2.4/§5.1） | 一次验证 K 个 token，加速 decode；端侧可行变体见 §2.7 |
| **权重量化 (W4A16)** | 降低 decode 段 | 减每 token 权重读取 → 降 TPOT；同时降内存占用与首次加载时间 |
| **约束解码** | 降低 | 消除格式失败的重试 |
| **Continuous Batching** | 降低排队 | 短请求不被长请求拖慢；真 batch 还提吞吐（见 §4.5） |
| **decode 带宽优化** | 降低 | KV INT8 / GQA 减少每 token 读取（见 [原理篇](infer-principles.html)） |
| **时分重叠（多 graph）** | 提升吞吐，**不降单请求延迟** | 见 [原理篇 §5.4](infer-principles.html) |

### 5.5 优化技术栈总览

```mermaid
flowchart TB
    A["量化 W4A16降内存/加载/decode TPOT(TTFT 收益仅限 prefill 仍 memory-bound)"] --> B["前缀缓存跳过 System Prompt Prefill"]
    B --> C["KV 优化GQA + INT8降 decode 带宽"]
    C --> D["投机采样decode 加速(独立草稿端侧有限, 替代见 §2.7)"]
    D --> E["约束解码消除重试"]
    E --> F["Continuous Batching降排队延迟"]

    style A fill:#3498db,color:#fff
    style B fill:#f39c12,color:#fff
    style C fill:#9b59b6,color:#fff
    style D fill:#2ecc71,color:#fff
    style E fill:#4361ee,color:#fff
    style F fill:#e74c3c,color:#fff
```

> [!TIP]
> **实战部署建议（按性价比）**
>
> * **必做**：W4A16 量化 + Context Binary——成本最低；量化降内存占用、首次加载时间与 decode TPOT（TTFT 收益仅在 prefill 仍 memory-bound 时成立，见 §5.3），Context Binary 消除冷启动编译。
> * **强烈推荐**：前缀缓存 + KV INT8/GQA——直接砍 Prefill 与 decode 带宽；再叠加 §5.1 的 N_out 控制（端侧最大杠杆）。
> * **谨慎评估**：投机采样——独立草稿在端侧单 cDSP 上收益有限且吃内存（§2.4），先算账再上；需要时优先 §2.7 的替代（Medusa/EAGLE 头、n-gram、jump-forward）。
> * **按场景**：约束解码——Function Calling 场景收益明确，自由对话场景关闭；上线前按 §3.6 验证 grammar 真生效且内容质量未劣化。
>
> 所有具体延迟值请用 §5.2 的推导链代入你自己的平台参数得出，不要照搬任何"标准答案"。
