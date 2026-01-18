# Dockerfile for Reindeer Coder
# Multi-stage build for minimal production image

# Build stage - use Node for better native module support
FROM node:20-bookworm AS builder
WORKDIR /app

# Build arguments for Auth0 configuration (needed at build time for Vite)
ARG VITE_AUTH0_DOMAIN
ARG VITE_AUTH0_CLIENT_ID
ARG VITE_AUTH0_AUDIENCE
ARG VITE_AUTH0_ORG_ID

# Set as environment variables for Vite build
ENV VITE_AUTH0_DOMAIN=${VITE_AUTH0_DOMAIN}
ENV VITE_AUTH0_CLIENT_ID=${VITE_AUTH0_CLIENT_ID}
ENV VITE_AUTH0_AUDIENCE=${VITE_AUTH0_AUDIENCE}
ENV VITE_AUTH0_ORG_ID=${VITE_AUTH0_ORG_ID}

# Install bun
# hadolint ignore=DL3016
RUN npm install -g bun

# Install build dependencies for node-pty (requires Python and build tools)
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy monorepo dependency manifests (better layer caching)
COPY package.json bun.lock ./
COPY app/package.json ./app/
COPY vscode-extension/package.json ./vscode-extension/

# Install ALL dependencies (needed for build)
RUN bun install --frozen-lockfile

# Copy app source code
COPY app ./app

# Build the application
WORKDIR /app/app
RUN bun run build
WORKDIR /app

# Production stage
FROM node:20-bookworm-slim
WORKDIR /app

# Install bun
# hadolint ignore=DL3016
RUN npm install -g bun

# Install runtime dependencies for node-pty, gcloud SDK, and SSH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    gnupg \
    apt-transport-https \
    ca-certificates \
    openssh-client \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list \
    && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# Copy monorepo dependency manifests
COPY package.json bun.lock ./
COPY app/package.json ./app/
COPY vscode-extension/package.json ./vscode-extension/

# Install ONLY production dependencies
RUN bun install --frozen-lockfile --production

# Copy built artifacts from builder into the app workspace
COPY --from=builder /app/app/build ./app/build

# Copy database adapter files (needed for runtime)
COPY app/src/lib/server/db ./app/src/lib/server/db

# Set environment variables
ENV NODE_ENV=production \
    PORT=8080

# Expose port
EXPOSE 8080

# Run the application from the app workspace
WORKDIR /app/app
CMD ["bun", "run", "build/index.js"]
