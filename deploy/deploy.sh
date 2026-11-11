#!/usr/bin/env bash
# 本地构建并部署到服务器。用法：
#   SSH_TARGET=ubuntu@<服务器> SSH_KEY=~/.ssh/<私钥> bash deploy/deploy.sh [--seed]
# 服务器上只需要 Node.js 运行时，不安装 node_modules：后端打包成单文件，前端是静态文件。
set -euo pipefail

: "${SSH_TARGET:?请设置 SSH_TARGET，例如 ubuntu@1.2.3.4}"
SSH_OPTS=(-o IdentitiesOnly=yes)
[ -n "${SSH_KEY:-}" ] && SSH_OPTS+=(-i "$SSH_KEY")

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "== 检查与测试"
pnpm check
pnpm test

echo "== 构建"
pnpm --filter @hr/server fetch-font
pnpm --filter @hr/server build
pnpm --filter @hr/web build

echo "== 打包"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/hr-form/assets/fonts"
cp -r apps/server/dist apps/server/migrations deploy "$STAGE/hr-form/"
cp apps/server/assets/fonts/NotoSansSC-Regular.otf "$STAGE/hr-form/assets/fonts/"
cp -r apps/web/dist "$STAGE/hr-form/web"
tar -C "$STAGE" -czf "$STAGE/release.tgz" hr-form

echo "== 上传并安装"
scp "${SSH_OPTS[@]}" "$STAGE/release.tgz" "$SSH_TARGET:/tmp/hr-form-release.tgz"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "SEED=${1:-}" 'bash -s' <<'REMOTE'
set -euo pipefail
sudo rm -rf /tmp/hr-form-new && mkdir -p /tmp/hr-form-new
tar -C /tmp/hr-form-new -xzf /tmp/hr-form-release.tgz
sudo mkdir -p /opt/hr-form
sudo rsync -a --delete /tmp/hr-form-new/hr-form/ /opt/hr-form/
sudo chown -R root:root /opt/hr-form
if [ ! -f /etc/systemd/system/hr-form.service ]; then
  echo "发布包已上传到 /opt/hr-form。首次部署请先执行：sudo bash /opt/hr-form/deploy/setup-server.sh <域名>，再重新运行 deploy.sh"
  exit 0
fi
if [ "$SEED" = "--seed" ]; then
  # 重置演示数据时一并清空上传目录，否则磁盘上会留下数据库里已不存在的文件
  sudo find /var/lib/hr-form/uploads -mindepth 1 -delete
  # env 文件权限 600、属主 root（systemd 以 root 读取），所以 seed 也用 root 读取后执行；它只连数据库，不写文件。
  sudo bash -c 'set -euo pipefail; set -a; . /etc/hr-form/env; set +a; cd /opt/hr-form && node dist/seed.js --reset'
fi
sudo systemctl restart hr-form
sleep 2
curl -fsS http://127.0.0.1:3000/api/health && echo " 部署完成"
REMOTE
rm -rf "$STAGE"
