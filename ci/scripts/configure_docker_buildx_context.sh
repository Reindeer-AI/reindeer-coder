#!/usr/bin/env bash

# Configure Docker buildx context for GitLab CI/CD
# Creates a builder context using the Docker-in-Docker service

set -euo pipefail

echo "Creating Docker buildx context..."
docker context create builder --docker "host=tcp://docker:2376,ca=/certs/client/ca.pem,cert=/certs/client/cert.pem,key=/certs/client/key.pem"

echo "Creating and using buildx builder..."
docker buildx create builder --use

echo -e "\033[32m✓\033[0m Docker buildx context configured successfully"
