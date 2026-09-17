# Edge AI Docs

端侧 AI 学习文档与面试指南 —— 覆盖 **智能座舱 / 通用机器人 / 自动驾驶** 三大领域，贯穿算法训练、部署优化、Agent 框架三条主线。

🔗 线上：<https://ranpin.github.io/edge-ai-docs/>

## 架构

**Markdown 源 + GitHub Actions 构建 + Pages 部署**（`build_type: workflow`）：

- 所有文档以 `.md` 编写，本仓库即唯一源。
- `_build/build.py`（python-markdown）把 `.md` 渲染成统一模板的 `.html`，输出到 `dist/`。
- push 到 `main` → Actions（`.github/workflows/deploy.yml`）自动构建并部署到 Pages。
- `dist/` 不入库（见 `.gitignore`），完全由 CI 生成。

## 目录结构

```
├── index.html                 # 首页/目录页（唯一保留的 html）
├── docs.json                  # 导航与目录的单一事实源（分类 → 项目 → 文档）
├── nav.js                     # 共享顶部导航：读 docs.json 渲染下拉，注入「✎ 编辑此页」深链
├── _build/
│   ├── build.py               # md → html 构建器
│   ├── template.css           # 页面样式模板（明暗主题）
│   └── template_tail.html     # 尾部脚本（mermaid 初始化 / 主题切换 / TOC 高亮）
├── cockpit/                   # 智能座舱
│   ├── general/               #   通识：面试 / 硬件 / 训练 / 推理 / Android-JNI
│   └── projects/
│       ├── agent-framework/   #   项目：大模型 Agent 框架（总览/部署/核心/场景/调试/APK）
│       └── lantu/             #   项目：岚图 8397 座舱 VLM 端侧量产
├── robot/                     # 通用机器人：general + projects/edge-deploy
└── ad/                        # 自动驾驶：general + projects/bev
```

## 编辑文档

**在线（推荐）**：在任意文档页点右上角「✎ 编辑此页」→ 跳转 GitHub 网页编辑器（已定位到该 `.md`）→ 改完 commit → Actions 约 30 秒自动重建部署。

**本地预览**：

```bash
pip install markdown
python3 _build/build.py                 # 生成 dist/
cd dist && python3 -m http.server 8000  # 打开 http://localhost:8000
```

## 新增一篇文档

1. 在对应目录新建 `xxx.md`。
2. 在 `docs.json` 相应分类/项目下加一条：`{ "title", "file": "路径/xxx.html", "badge", "status", "desc", "tags" }`（`file` 写 `.html`，构建时由同名 `.md` 生成）。
3. push → Actions 自动构建部署，导航随即出现。

> 只有被 `docs.json` 引用的 `.md` 才会被构建发布；未登记的 `.md` 视为草稿，不发布。

## 写作约定（构建器自动转换）

| Markdown 写法 | 渲染结果 |
| :-- | :-- |
| ` ```mermaid ` 代码块 | 流程图 / 时序图（mermaid@10）|
| ` ```mermaid ` 内 `xychart-beta` | 柱状图 / 折线图 |
| `> [!NOTE]` `> [!TIP]` `> [!WARNING]` `> [!CAUTION]` | 彩色提示框（info-box）|
| `<details><summary>问题</summary> …答案… </details>` | 点击展开的折叠块（面试答题卡）|
| 标准 markdown 表格 | 自动包横向滚动容器（移动端不溢出）|
| `##` / `###` 标题 | 自动生成左侧目录（TOC）并锚点高亮 |

## 关联

本站是个人站 [ranpin.github.io](https://ranpin.github.io/) 「技术文档」板块的内容源；主站 `DocsSection.tsx` 运行时 fetch 本仓库的 `docs.json` 渲染目录，因此这里增删文档无需改主站。
