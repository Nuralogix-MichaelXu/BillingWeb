#!/bin/sh
# 把 BillingWeb 装成 macOS 常驻服务（开机自启 + 崩溃自愈）
#
# 为什么需要它：直接 `node server.js &` 起的进程会在终端关闭 / 注销后消失，
# 重启机器也不会自动回来。交给 launchd 托管才是真正意义上的「部署」。
#
# 用法：sh tools/install-lan-service.sh
set -e

LABEL="ai.nuralogix.billingweb"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

[ -f "$PLIST_SRC" ] || { echo "✗ 找不到 $PLIST_SRC" >&2; exit 1; }

echo "① 停掉手动启动的实例（避免与 launchd 抢端口 4173）"
PIDS="$(lsof -t -nP -iTCP:4173 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
  sleep 1
  echo "   已停止: $PIDS"
else
  echo "   没有手动实例在跑"
fi

echo "② 复制 plist 到 LaunchAgents"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
# 覆盖前先卸载旧版本，否则 bootstrap 会因 label 已存在而失败
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
cp "$PLIST_SRC" "$PLIST_DST"
chmod 644 "$PLIST_DST"
echo "   $PLIST_DST"

echo "③ 装入 launchd"
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"

echo "④ 等待启动…"
sleep 3
if lsof -nP -iTCP:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "   ✓ 已在监听 4173"
  lsof -nP -iTCP:4173 -sTCP:LISTEN | tail -1
else
  echo "   ✗ 未见监听，查看日志："
  tail -15 "$HOME/Library/Logs/BillingWeb.err.log" 2>/dev/null
  exit 1
fi

echo
echo "完成。常用命令："
echo "  状态  launchctl print gui/$UID_NUM/$LABEL | grep -E 'state|pid'"
echo "  停止  launchctl bootout gui/$UID_NUM/$LABEL"
echo "  重载  launchctl kickstart -k gui/$UID_NUM/$LABEL"
echo "  日志  tail -f $HOME/Library/Logs/BillingWeb.log"
echo "  卸载  launchctl bootout gui/$UID_NUM/$LABEL && rm $PLIST_DST"
