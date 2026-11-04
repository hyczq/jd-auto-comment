#!/bin/sh
# start-desktop.sh —— 启动虚拟桌面 + VNC + noVNC，供人工登录京东
#
# 用法（宿主机执行）：
#   sh start-desktop.sh
# 然后在你自己电脑上执行：
#   ssh -L 6080:127.0.0.1:6080 root@<服务器IP>
# 浏览器打开 http://127.0.0.1:6080/vnc.html


CONTAINER="${CONTAINER:-qinglong}"
DISP="${DISPLAY_NUM:-:99}"
VNC_PORT="${VNC_PORT:-5900}"
WEB_PORT="${WEB_PORT:-6080}"
VNC_PASS="${VNC_PASS:-Zx7kQ2mN9p}"

echo "==> 检查依赖"
docker exec "$CONTAINER" sh -c 'which Xvfb x11vnc websockify >/dev/null 2>&1' || {
  echo "容器内缺少 Xvfb/x11vnc/websockify，正在安装..."
  docker exec "$CONTAINER" sh -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq x11vnc novnc websockify'
}

echo "==> 启动 Xvfb $DISP"
docker exec "$CONTAINER" sh -c "pkill -f '[X]vfb $DISP' 2>/dev/null || true"
docker exec -d "$CONTAINER" sh -c "Xvfb $DISP -screen 0 1440x900x24 -ac +extension RANDR > /tmp/xvfb.log 2>&1"
sleep 2

echo "==> 设置 VNC 密码"
docker exec "$CONTAINER" sh -c "mkdir -p /root/.vnc && x11vnc -storepasswd '$VNC_PASS' /root/.vnc/passwd >/dev/null 2>&1"

echo "==> 启动 x11vnc :$VNC_PORT"
docker exec "$CONTAINER" sh -c "pkill -f '[x]11vnc -display' 2>/dev/null || true"
docker exec -d "$CONTAINER" sh -c "x11vnc -display $DISP -rfbport $VNC_PORT -rfbauth /root/.vnc/passwd -forever -shared -quiet -xkb -noxdamage -rfbversion 3.8 > /tmp/x11vnc.log 2>&1"
sleep 2

echo "==> 启动 noVNC :$WEB_PORT"
docker exec "$CONTAINER" sh -c "pkill -f '[w]ebsockify --web' 2>/dev/null || true"
docker exec -d "$CONTAINER" sh -c "websockify --web /usr/share/novnc $WEB_PORT 127.0.0.1:$VNC_PORT > /tmp/websockify.log 2>&1"
sleep 2

echo "==> 宿主机端口转发 :$WEB_PORT"
CIP=$(docker inspect "$CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
pkill -f "[s]ocat.*TCP-LISTEN:$WEB_PORT" 2>/dev/null || true
nohup socat "TCP-LISTEN:$WEB_PORT,fork,reuseaddr" "TCP:$CIP:$WEB_PORT" > /tmp/socat-$WEB_PORT.log 2>&1 &
sleep 1

echo ""
echo "=================================================="
echo "  桌面已就绪"
echo "=================================================="
echo "  容器 IP     : $CIP"
echo "  VNC 密码    : $VNC_PASS"
echo ""
echo "  在你自己的电脑上执行（保持窗口不关）："
echo "    ssh -L $WEB_PORT:127.0.0.1:$WEB_PORT root@<服务器IP>"
echo ""
echo "  然后浏览器打开："
echo "    http://127.0.0.1:$WEB_PORT/vnc.html"
echo ""
echo "  下一步在容器内运行登录初始化（把 <脚本目录> 换成实际路径）："
echo "    docker exec -d $CONTAINER sh -c \\"
echo "      'cd /ql/data/scripts/<脚本目录> && node login-setup.js'"
echo "=================================================="
