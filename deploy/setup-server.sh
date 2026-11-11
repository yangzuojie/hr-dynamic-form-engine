#!/usr/bin/env bash
# 服务器一次性初始化（Ubuntu，需要 sudo）。用法：sudo bash setup-server.sh <域名> [证书通知邮箱]
# 先用 deploy.sh 把发布包上传到 /opt/hr-form，再执行本脚本。
# 做的事：2G swap、Node.js、PostgreSQL（调小内存）、Nginx、certbot、运行用户和目录、数据库和环境变量。
# 可重复执行：已经做过的步骤会跳过。
set -euo pipefail

SERVER_NAME="${1:?用法：setup-server.sh <域名> [邮箱]}"
CERT_EMAIL="${2:-}"

echo "== swap（908MB 内存的机器，防止构建或高峰时 OOM）"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 软件包"
apt-get update -y
apt-get install -y nodejs postgresql nginx certbot python3-certbot-nginx openssl
node --version

echo "== PostgreSQL 调小内存"
PG_CONF_DIR=$(ls -d /etc/postgresql/*/main | head -1)
cat > "$PG_CONF_DIR/conf.d/hr-form.conf" <<'EOF'
shared_buffers = 64MB
work_mem = 4MB
maintenance_work_mem = 32MB
effective_cache_size = 256MB
max_connections = 20
EOF
systemctl restart postgresql

echo "== 运行用户和目录"
id hrform >/dev/null 2>&1 || useradd --system --home /opt/hr-form --shell /usr/sbin/nologin hrform
mkdir -p /opt/hr-form /var/lib/hr-form/uploads /etc/hr-form
chown -R hrform:hrform /var/lib/hr-form
chmod 750 /var/lib/hr-form

echo "== 数据库和环境变量"
if [ ! -f /etc/hr-form/env ]; then
  DB_PASS=$(openssl rand -hex 16)
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<EOF
CREATE ROLE hr_form LOGIN PASSWORD '${DB_PASS}';
CREATE DATABASE hr_form OWNER hr_form;
EOF
  cat > /etc/hr-form/env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres://hr_form:${DB_PASS}@127.0.0.1:5432/hr_form
DB_POOL_MAX=5
JWT_SECRET=$(openssl rand -hex 32)
FILE_SIGNING_SECRET=$(openssl rand -hex 32)
UPLOAD_DIR=/var/lib/hr-form/uploads
FONT_PATH=/opt/hr-form/assets/fonts/NotoSansSC-Regular.otf
MIGRATIONS_DIR=/opt/hr-form/migrations
SEED_PASSWORD=demo1234
EOF
  chmod 600 /etc/hr-form/env
fi

echo "== Nginx"
sed "s/__SERVER_NAME__/${SERVER_NAME}/" /opt/hr-form/deploy/nginx.conf > /etc/nginx/sites-available/hr-form
ln -sf /etc/nginx/sites-available/hr-form /etc/nginx/sites-enabled/hr-form
rm -f /etc/nginx/sites-enabled/default
# 直接用 IP 或其他 Host 访问时，跳转到正式域名（单独一个文件，certbot 不会改写它）
cat > /etc/nginx/sites-available/hr-form-default <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 301 https://${SERVER_NAME}\$request_uri;
}
EOF
ln -sf /etc/nginx/sites-available/hr-form-default /etc/nginx/sites-enabled/hr-form-default
nginx -t
systemctl reload nginx

echo "== systemd"
cp /opt/hr-form/deploy/hr-form.service /etc/systemd/system/hr-form.service
systemctl daemon-reload
systemctl enable hr-form

echo "== HTTPS（Let's Encrypt，需要 80 端口可从外网访问）"
# 不提供邮箱时不注册邮箱（只是收不到到期提醒，certbot 的定时任务会自动续期）
if [ -n "$CERT_EMAIL" ]; then EMAIL_ARGS=(-m "$CERT_EMAIL"); else EMAIL_ARGS=(--register-unsafely-without-email); fi
certbot --nginx --non-interactive --agree-tos "${EMAIL_ARGS[@]}" -d "$SERVER_NAME" --redirect || \
  echo "证书申请失败，暂时只提供 HTTP；排查后重新执行本脚本即可"

echo "初始化完成。"
