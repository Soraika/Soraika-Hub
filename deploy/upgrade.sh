#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Soraika's Hub 在线升级脚本
# 用法:  ./deploy/upgrade.sh
# 作用:  备份当前配置 → 拉取最新镜像 → 重建容器（数据卷不动）
# ⚠️ 使用前把下面的 IMAGE 换成你发布的 Docker Hub 镜像地址
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

IMAGE="soraika/soraikas-hub:latest"
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose"

cd "$STACK_DIR"

echo "==> ① 备份当前容器配置（若容器在运行）"
BACKUP_DIR="$STACK_DIR/deploy/backups"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/config.${STAMP}.json"
if docker ps --format '{{.Names}}' | grep -q '^soraikas-hub$'; then
  docker cp soraikas-hub:/data/config.json "$BACKUP_FILE" 2>/dev/null \
    && echo "    已备份 → $BACKUP_FILE" || echo "    容器内暂无 config.json，跳过备份"
else
  echo "    容器未运行，跳过容器备份"
fi

echo "==> ② 拉取最新镜像: $IMAGE"
$COMPOSE pull

echo "==> ③ 重建容器（卷 soraika-data 保留，配置与数据不丢）"
$COMPOSE up -d --force-recreate

echo "==> ④ 等待健康检查"
sleep 5
docker ps --filter "name=soraikas-hub" --format "    状态: {{.Status}}"

echo "==> ✅ 升级完成。若异常：docker compose logs -f soraikas-hub"