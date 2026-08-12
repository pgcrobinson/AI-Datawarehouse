#!/usr/bin/env bash
# One-time setup for an Ubuntu 22.04 Azure VM.
# Run as root (or with sudo) after provisioning the VM:
#   sudo bash deploy/setup-vm.sh https://github.com/YOUR/REPO.git
set -euo pipefail

REPO_URL="${1:?Usage: setup-vm.sh <github-repo-url>}"
APP_DIR="/opt/app"

# ── Detect public IP ──────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -sf https://checkip.amazonaws.com || curl -sf https://api.ipify.org || echo "YOUR_VM_IP")
echo "VM public IP: $PUBLIC_IP"

# ── Docker ────────────────────────────────────────────────────────────────────
echo "=== Installing Docker ==="
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list

apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin git

# Let the default non-root user run docker without sudo
usermod -aG docker azureuser
echo "Docker installed."

# ── Clone repo ────────────────────────────────────────────────────────────────
echo "=== Cloning repo ==="
git clone "$REPO_URL" "$APP_DIR"

# ── Generate webhook secret ───────────────────────────────────────────────────
WEBHOOK_SECRET=$(openssl rand -hex 32)

# ── Write .env ────────────────────────────────────────────────────────────────
cat > "$APP_DIR/.env" <<EOF
FRONTEND_URL=http://$PUBLIC_IP
BACKEND_URL=http://$PUBLIC_IP
GITHUB_WEBHOOK_SECRET=$WEBHOOK_SECRET
NEXT_PUBLIC_API_URL=
EOF
chmod 600 "$APP_DIR/.env"
echo ".env written."

# ── Install webhook systemd service ──────────────────────────────────────────
cp "$APP_DIR/deploy/webhook.service" /etc/systemd/system/webhook.service
systemctl daemon-reload
systemctl enable webhook
systemctl start webhook
echo "Webhook service started."

# ── Open firewall port for webhook ────────────────────────────────────────────
# You also need to allow TCP 9000 in the Azure Network Security Group (NSG).
ufw allow 9000/tcp 2>/dev/null || true

# ── First deploy ─────────────────────────────────────────────────────────────
echo "=== Running first deploy ==="
cd "$APP_DIR"
# newgrp docker doesn't work in scripts — use sg instead
sg docker -c "docker compose up -d --build"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  SETUP COMPLETE"
echo "============================================================"
echo "  App URL:       http://$PUBLIC_IP"
echo "  Webhook URL:   http://$PUBLIC_IP:9000/webhook"
echo "  Webhook secret: $WEBHOOK_SECRET"
echo ""
echo "  NEXT STEPS:"
echo "  1. Go to GitHub repo → Settings → Webhooks → Add webhook"
echo "     URL:          http://$PUBLIC_IP:9000/webhook"
echo "     Content type: application/json"
echo "     Secret:       $WEBHOOK_SECRET"
echo "     Events:       Just the push event"
echo ""
echo "  2. In Azure Portal → VM → Networking → Add inbound rule:"
echo "     Port 80  (HTTP for the app)"
echo "     Port 9000 (webhook listener)"
echo ""
echo "  3. Enable HTTPS so BigQuery OAuth works (free, no domain purchase):"
echo "     a) In Azure Portal → VM → Public IP → Configuration"
echo "        Set a DNS name label, e.g. 'myapp' → gives myapp.REGION.cloudapp.azure.com"
echo "     b) Open port 443 in Azure → VM → Networking → Inbound rules"
echo "     c) Run: sudo bash /opt/app/deploy/enable-https.sh myapp.REGION.cloudapp.azure.com you@email.com"
echo "     d) In Google Cloud Console → APIs & Services → Credentials"
echo "        → Your OAuth Client → Authorised redirect URIs → add:"
echo "        https://myapp.REGION.cloudapp.azure.com/api/database/bigquery/callback"
echo "============================================================"
