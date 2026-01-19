# Dockerfile for Reindeer Coder
# Multi-stage build for minimal production image

# Build stage
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

# Install build dependencies for node-pty (requires Python and build tools)
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy app dependency manifest
COPY app/package.json app/package-lock.json* ./

# Install ALL dependencies (needed for build)
RUN npm install

# Copy app source code
COPY app ./

# Build the application
RUN npm run build

# Production stage
FROM node:20-bookworm-slim
WORKDIR /app

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

# Copy app dependency manifest
COPY app/package.json app/package-lock.json* ./

# Install ONLY production dependencies
RUN npm install --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/build ./build

# Copy database adapter files (needed for runtime)
COPY app/src/lib/server/db ./src/lib/server/db

# Set environment variables
ENV NODE_ENV=production \
    PORT=8080

# Expose port
EXPOSE 8080

# Run the application
CMD ["node", "build/index.js"]
