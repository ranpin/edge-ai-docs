#!/usr/bin/env bash
# 本地预览 edge-ai-docs —— 无需公开仓库。
# 构建 md→html 并起本地服务，打开 http://localhost:8000 即可预览。
# 用法: ./preview.sh [端口]   （默认 8000）
set -e
cd "$(dirname "$0")"
python3 _build/build.py
PORT="${1:-8000}"
echo ""
echo "→ 预览地址: http://localhost:${PORT}/"
echo "（Ctrl+C 退出）"
cd dist && python3 -m http.server "${PORT}"
