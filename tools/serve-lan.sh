#!/bin/sh
# 局域网部署启动器 —— 由 launchd 托管（label: ai.nuralogix.billingweb）
#
# 作用：动态解析 node 路径后启动 server.js。之所以不把 node 绝对路径直接写进
# plist，是因为托管运行时位于带版本号的目录（.../versions/22.22.2-3/bin/node），
# 版本一旦升级目录名就变，plist 会静默失效。
#
# 手动运行也可以：sh tools/serve-lan.sh
# 传参透传：      sh tools/serve-lan.sh 8080    → 换端口
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1) 优先 PATH（launchd 下 PATH 很干净，通常取不到）
NODE="$(command -v node 2>/dev/null || true)"
# 2) 回落到托管运行时（按版本号排序取最新，避免多版本时选错）
if [ -z "$NODE" ]; then
  NODE="$(ls -d "$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -x "$NODE" ] || NODE=""
fi
# 3) 再回落常用安装位置
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && NODE="$c"
  done
fi

if [ -z "$NODE" ]; then
  echo "✗ 找不到 node 可执行文件。请安装 node 或把 node 所在目录加入 PATH。" >&2
  exit 1
fi

cd "$DIR"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 BillingWeb 局域网服务，node=$NODE" >&2
exec "$NODE" server.js "$@"
