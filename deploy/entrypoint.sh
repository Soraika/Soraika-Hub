#!/bin/sh
# Soraika's Hub 容器入口
# 以 root 启动，将 /data 数据目录归属调整为目标 uid/gid（PUID/PGID），
# 再降权回普通用户运行服务 —— 兼容绑定挂载 / 命名卷，部署无需手动 chmod。
set -e

# 默认 1000:1000（常见 NAS 首个用户），可通过环境变量覆盖，如 PUID=$(id -u)
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

echo "[entrypoint] PUID=${PUID} PGID=${PGID}"

# 1. 数据目录存在且归属目标 uid/gid（root 才能 chown，绑定挂载也生效）
mkdir -p /data
chown -R "${PUID}:${PGID}" /data 2>/dev/null \
  || echo "[entrypoint] warn: chown /data 失败，将以当前权限继续（可能无法写入配置）"

# 2. 尽量把容器内 app 用户 uid/gid 也调整一致（失败不致命，运行用数字 uid）
if id app >/dev/null 2>&1; then
  usermod -o -u "${PUID}" app 2>/dev/null || true
  groupmod -o -g "${PGID}" app 2>/dev/null || true
fi

echo "[entrypoint] starting as uid=${PUID} gid=${PGID}"

# 3. 降权运行（su-exec 用数字 uid:gid，不依赖 usermod 结果）
exec su-exec "${PUID}:${PGID}" node app.js
