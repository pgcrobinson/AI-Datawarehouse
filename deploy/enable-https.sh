#!/usr/bin/env bash
# Upgrades the app from HTTP to HTTPS using Let's Encrypt (free).
# Prerequisite: Azure DNS label must already point at this VM's IP.
#
# Usage:
#   sudo bash deploy/enable-https.sh myapp.eastus.cloudapp.azure.com your@email.com
#
# What it does:
#   1. Installs certbot
#   2. Stops nginx (frees port 80 for cert challenge)
#   3. Gets a Let's Encrypt certificate for the domain
#   4. Writes HTTPS nginx.conf
#   5. Updates .env with https:// URLs
#   6. Restarts docker compose
#   7. Schedules auto-renewal via cron
set -euo pipefail

DOMAIN="${1:?Usage: enable-https.sh <domain> <email>}"
EMAIL="${2:?Usage: enable-https.sh <domain> <email>}"
APP_DIR="${3:-/opt/app}"

cd "$APP_DIR"

# ── Install certbot ───────────────────────────────────────────────────────────
echo "=== Installing certbot ==="
apt-get update -q
apt-get install -y -q certbot

# ── Stop nginx so port 80 is free for standalone challenge ────────────────────
echo "=== Stopping nginx container ==="
docker compose stop nginx

# ── Obtain certificate ────────────────────────────────────────────────────────
echo "=== Obtaining Let's Encrypt certificate for $DOMAIN ==="
certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"

# ── Write HTTPS nginx.conf ────────────────────────────────────────────────────
echo "=== Writing HTTPS nginx config ==="
cat > "$APP_DIR/nginx/nginx.conf" <<NGINX
# HTTP → HTTPS redirect
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Long timeout for dbt commands
    proxy_read_timeout 600s;
    proxy_connect_timeout 10s;
    proxy_send_timeout 600s;

    # ── Backend API ──────────────────────────────────────────────────────────
    location /api/ {
        proxy_pass http://backend:8000;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # Required for streaming NDJSON responses (dbt live output)
        proxy_buffering    off;
        proxy_cache        off;
        proxy_http_version 1.1;
    }

    # ── Frontend ─────────────────────────────────────────────────────────────
    location / {
        proxy_pass http://frontend:3000;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

# ── Update docker-compose to mount the certs into nginx ──────────────────────
# Add /etc/letsencrypt mount if not already present
if ! grep -q "letsencrypt" "$APP_DIR/docker-compose.yml"; then
    sed -i '/nginx.conf:ro/a\      - /etc/letsencrypt:/etc/letsencrypt:ro' \
        "$APP_DIR/docker-compose.yml"
fi

# Add port 443 to nginx if not already present
if ! grep -q '"443:443"' "$APP_DIR/docker-compose.yml"; then
    sed -i 's/      - "80:80"/      - "80:80"\n      - "443:443"/' \
        "$APP_DIR/docker-compose.yml"
fi

# ── Update .env with HTTPS URLs ───────────────────────────────────────────────
echo "=== Updating .env with HTTPS URLs ==="
sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://$DOMAIN|" "$APP_DIR/.env"
sed -i "s|BACKEND_URL=.*|BACKEND_URL=https://$DOMAIN|"   "$APP_DIR/.env"

# ── Restart everything ────────────────────────────────────────────────────────
echo "=== Restarting docker compose ==="
docker compose up -d --build nginx

# ── Auto-renewal cron (runs twice daily, standard certbot recommendation) ─────
echo "=== Setting up auto-renewal ==="
# Renewal stops nginx, renews, then restarts
RENEW_CMD="cd $APP_DIR && docker compose stop nginx && certbot renew --quiet && docker compose start nginx"
(crontab -l 2>/dev/null | grep -v "certbot renew"; echo "0 3 * * * $RENEW_CMD") | crontab -

echo ""
echo "============================================================"
echo "  HTTPS ENABLED"
echo "============================================================"
echo "  App URL: https://$DOMAIN"
echo ""
echo "  NEXT STEP — add redirect URIs in Google Cloud Console:"
echo "  https://console.cloud.google.com/apis/credentials"
echo "  → Your OAuth 2.0 Client → Authorised redirect URIs → Add both:"
echo ""
echo "    https://$DOMAIN/api/auth/google/callback"
echo "    https://$DOMAIN/api/database/bigquery/oauth/callback"
echo ""
echo "  Also open port 443 in Azure → VM → Networking → Inbound rules."
echo "============================================================"
