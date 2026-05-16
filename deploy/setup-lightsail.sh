#!/usr/bin/env bash
# One-shot provisioning for an Ubuntu 22.04+ AWS Lightsail / EC2 instance.
# Cheapest config: Lightsail $3.50/mo (512MB) is enough for low traffic;
# bump to $5/mo (1GB) if you expect many concurrent pilgrims.
#
# Usage (as ubuntu user with sudo):
#   curl -fsSL https://raw.githubusercontent.com/<you>/hajjduaa/main/deploy/setup-lightsail.sh | bash -s -- your-domain.example
# OR after `git clone`:
#   bash deploy/setup-lightsail.sh your-domain.example
#
# What it does:
#   1. installs node, nginx, certbot, pm2
#   2. clones (or updates) the repo into /opt/hajjduaa
#   3. installs deps, creates .env if missing
#   4. starts via pm2 + auto-start on boot
#   5. wires nginx + lets-encrypt
set -euo pipefail

DOMAIN="${1:-}"
REPO_URL="${REPO_URL:-https://github.com/uthmanq/hajjduaa.git}"
APP_DIR="${APP_DIR:-/opt/hajjduaa}"

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <your-domain.example>"
  exit 1
fi

echo ">>> Updating apt and installing system packages..."
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates git build-essential nginx

if ! command -v node >/dev/null 2>&1; then
  echo ">>> Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo ">>> Installing PM2..."
  sudo npm install -g pm2
fi

echo ">>> Cloning / updating repo into $APP_DIR..."
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo git clone "$REPO_URL" "$APP_DIR"
fi
sudo chown -R "$USER":"$USER" "$APP_DIR"
git -C "$APP_DIR" pull --ff-only || true

cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

if [[ ! -f .env ]]; then
  echo ">>> Creating .env from .env.example (REMEMBER to edit it!)"
  cp .env.example .env
  RAND=$(openssl rand -hex 32 || head -c 64 /dev/urandom | base64)
  sed -i "s|^COOKIE_SECRET=.*|COOKIE_SECRET=$RAND|" .env
fi

mkdir -p data
sudo mkdir -p /var/log/hajjduaa
sudo chown -R "$USER":"$USER" /var/log/hajjduaa

echo ">>> Starting app via PM2..."
pm2 startOrReload ecosystem.config.js
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

echo ">>> Configuring nginx..."
sudo cp deploy/nginx.conf /etc/nginx/sites-available/hajjduaa
sudo sed -i "s|your-domain.example|$DOMAIN|g" /etc/nginx/sites-available/hajjduaa
sudo ln -sf /etc/nginx/sites-available/hajjduaa /etc/nginx/sites-enabled/hajjduaa
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

if ! command -v certbot >/dev/null 2>&1; then
  echo ">>> Installing certbot..."
  sudo apt-get install -y certbot python3-certbot-nginx
fi

echo ">>> Provisioning HTTPS via Let's Encrypt..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || \
  echo "[!] Certbot failed (DNS not pointing here yet?). Re-run: sudo certbot --nginx -d $DOMAIN"

echo ""
echo "============================================================"
echo "  Done. Edit $APP_DIR/.env to add your TURNSTILE keys, then:"
echo "    pm2 reload hajjduaa"
echo "  Visit: https://$DOMAIN"
echo "============================================================"
