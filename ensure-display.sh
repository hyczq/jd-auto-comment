#!/bin/sh
# ensure-display.sh —— 确保 Xvfb 虚拟显示器在运行
# 青龙容器重启后 Xvfb 会丢失，脚本运行前需保证 :99 存在

DISP="${DISPLAY_NUM:-:99}"
W=1440
H=900

if pgrep -f "Xvfb $DISP" >/dev/null 2>&1; then
    exit 0
fi

nohup Xvfb "$DISP" -screen 0 "${W}x${H}x24" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
sleep 1

if pgrep -f "Xvfb $DISP" >/dev/null 2>&1; then
    echo "Xvfb $DISP 已启动"
else
    echo "Xvfb $DISP 启动失败，详见 /tmp/xvfb.log" >&2
    exit 1
fi
