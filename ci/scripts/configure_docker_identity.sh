#!/usr/bin/env bash

# Configure Docker authentication for Google Artifact Registry
# Uses service account impersonation for secure image push/pull

set -euo pipefail

# Requires 2 arguments
if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <credentials_path> <service_account_email>" >&2
    exit 1
fi

CREDENTIALS_FILE="$1"
SERVICE_ACCOUNT_EMAIL="$2"
REGISTRY_URL="us-central1-docker.pkg.dev"

echo "Downloading docker-credential-gcr..."
wget -q "https://github.com/GoogleCloudPlatform/docker-credential-gcr/releases/download/v2.1.26/docker-credential-gcr_linux_amd64-2.1.26.tar.gz" -O - | tar xz -C /tmp && chmod +x /tmp/docker-credential-gcr && mv /tmp/docker-credential-gcr /usr/bin/

echo "Configuring service account impersonation..."
IMPERSONATION_URL="https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}:generateAccessToken"
jq --arg url "$IMPERSONATION_URL" '. + {"service_account_impersonation_url": $url}' "$CREDENTIALS_FILE" > /tmp/creds.json && mv /tmp/creds.json "$CREDENTIALS_FILE"

docker-credential-gcr configure-docker --registries="$REGISTRY_URL"
echo -e "\033[32m✓\033[0m Docker identity configured successfully"
