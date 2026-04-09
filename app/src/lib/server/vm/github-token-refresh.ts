/**
 * Standalone bash script that re-mints a GitHub App installation token.
 * Written to /opt/github/refresh.sh on the VM and run by cron every 50 min.
 *
 * Reads GitHub App credentials from GCE instance metadata (same source as
 * the initial mint in the startup script), generates a JWT, exchanges it
 * for an installation token, and overwrites /opt/github/credentials +
 * /opt/github/token. Since /opt/github is bind-mounted into containers,
 * the fresh token is visible instantly — no restart needed.
 */
export const GITHUB_TOKEN_REFRESH_SCRIPT = `#!/bin/bash
set -euo pipefail

META() {
  curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" \\
    -H "Metadata-Flavor: Google" || true
}

SA=$(META SECRET_IMPERSONATE_SA)
IMPERSONATE=""
[ -n "$SA" ] && IMPERSONATE="--impersonate-service-account=$SA"

APP_ID=$(META GITHUB_APP_ID)
INST_ID=$(META GITHUB_INSTALLATION_ID)
PK_SECRET=$(META GITHUB_APP_PRIVATE_KEY_SECRET)

# Bail silently if GitHub App isn't configured
[[ "$APP_ID" =~ ^[0-9]+$ ]] || exit 0
[ -n "$APP_ID" ] && [ -n "$INST_ID" ] && [ -n "$PK_SECRET" ] || exit 0

PK=$(gcloud secrets versions access "$PK_SECRET" $IMPERSONATE 2>/dev/null) || exit 1
# Write PEM to /opt/github (already 0700) instead of world-listable /tmp
PEM=/opt/github/.refresh.pem
( umask 077 && printf '%s' "$PK" > "$PEM" )

NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))
HDR=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
PLD=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID" | base64 -w 0 | tr '+/' '-_' | tr -d '=')
SIG=$(printf '%s' "$HDR.$PLD" | openssl dgst -sha256 -sign "$PEM" | base64 -w 0 | tr '+/' '-_' | tr -d '=')
rm -f "$PEM"

RESP=$(curl -s -w "\\n%{http_code}" -X POST \\
  -H "Authorization: Bearer $HDR.$PLD.$SIG" \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/app/installations/$INST_ID/access_tokens")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
TOKEN=$(echo "$BODY" | jq -r '.token // empty')

if [ -z "$TOKEN" ]; then
  echo "[github-refresh] Token exchange failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi

printf 'https://x-access-token:%s@github.com\\n' "$TOKEN" > /opt/github/credentials
printf '%s' "$TOKEN" > /opt/github/token
chown -R 1000:1000 /opt/github
chmod -R u=rwX,g=,o= /opt/github
`;
