#!/usr/bin/env bash
# Bible Songs — deploy script.
# Usage:
#   CF_API_TOKEN=... bash deploy.sh
#   CF_API_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... bash deploy.sh
#
# Primary path: wrangler (auto-enables workers.dev subdomain on this account).
# Fallback: versions API (POST .../versions → POST .../deployments).
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "ERROR: CF_API_TOKEN is required (Cloudflare API token)." >&2
  exit 1
fi

node build.js

ACCOUNT_ID="${CF_ACCOUNT_ID:-d21711ae11a362bc4d57d4fd48deae61}"
WORKER="bible-songs"

if command -v npx >/dev/null 2>&1; then
  echo "→ Deploying via wrangler…"
  CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx -y wrangler@latest deploy
  echo "✅ Deployed: https://${WORKER}.walusimbileon1.workers.dev"
  exit 0
fi

echo "→ wrangler not available; using versions API…"
API="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER}"

VERSION_ID=$(curl -s -X POST "${API}/versions" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -F "metadata={\"body_part\":\"script\",\"main_module\":\"worker.js\",\"compatibility_date\":\"2024-11-01\"};type=application/json" \
  -F "script=@dist/worker.js;type=application/javascript+module" \
  | jq -r '.result.id // empty')

if [ -z "$VERSION_ID" ]; then
  echo "ERROR: version upload failed." >&2
  exit 1
fi

curl -s -X POST "${API}/deployments" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"version_id\":\"${VERSION_ID}\"}" | jq -r '.success' >/dev/null

echo "✅ Deployed version ${VERSION_ID}"

# Secrets (idempotent, only if provided)
if [ -n "${DISCORD_CLIENT_ID:-}" ] && [ -n "${DISCORD_CLIENT_SECRET:-}" ]; then
  curl -s -X PUT "${API}/secrets" -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"DISCORD_CLIENT_ID\",\"text\":\"${DISCORD_CLIENT_ID}\",\"type\":\"secret_text\"}" >/dev/null
  curl -s -X PUT "${API}/secrets" -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"DISCORD_CLIENT_SECRET\",\"text\":\"${DISCORD_CLIENT_SECRET}\",\"type\":\"secret_text\"}" >/dev/null
  echo "✅ Secrets set"
fi
