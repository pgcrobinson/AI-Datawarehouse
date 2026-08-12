#!/usr/bin/env python3
"""
GitHub webhook listener.
Verifies HMAC-SHA256 signature, then runs deploy/redeploy.sh on push to main.
Runs as a systemd service (deploy/webhook.service).
"""
import hashlib
import hmac
import http.server
import json
import logging
import os
import subprocess
import threading

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

_SECRET = os.environ.get("GITHUB_WEBHOOK_SECRET", "").encode()
_REPO_DIR = os.environ.get("REPO_DIR", "/opt/app")
_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "redeploy.sh")
_PORT = int(os.environ.get("WEBHOOK_PORT", "9000"))


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/webhook":
            self._reply(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        # Verify signature when a secret is configured
        if _SECRET:
            sig_header = self.headers.get("X-Hub-Signature-256", "")
            expected = "sha256=" + hmac.new(_SECRET, body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig_header, expected):
                log.warning("Webhook signature mismatch — rejected")
                self._reply(401, "Unauthorized")
                return

        # Only act on pushes to main / master
        try:
            payload = json.loads(body)
            ref = payload.get("ref", "")
            if ref not in ("refs/heads/main", "refs/heads/master"):
                log.info("Ignoring push to %s", ref)
                self._reply(200, f"Ignored ({ref})")
                return
        except (json.JSONDecodeError, AttributeError):
            pass

        log.info("Push to main received — scheduling redeploy")
        threading.Thread(target=self._redeploy, daemon=True).start()
        self._reply(200, "Deploying")

    def _redeploy(self):
        try:
            result = subprocess.run(
                ["bash", _SCRIPT, _REPO_DIR],
                capture_output=True,
                text=True,
                timeout=600,
            )
            log.info("Redeploy exit=%d\n%s", result.returncode, result.stdout)
            if result.stderr:
                log.warning("Redeploy stderr: %s", result.stderr)
        except Exception as exc:
            log.error("Redeploy failed: %s", exc)

    def _reply(self, code, text):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(text.encode())

    def log_message(self, fmt, *args):  # suppress default access log
        log.debug(fmt, *args)


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", _PORT), _Handler)
    log.info("Webhook listener on :%d  repo=%s", _PORT, _REPO_DIR)
    server.serve_forever()
