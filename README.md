# Reindeer Coder

Coding Agents Orchestration - Manage AI-powered coding agents with a web dashboard and VSCode extension.

## Components

- `/app` - SvelteKit web application for managing coding agents
- `/vscode-extension` - VSCode extension for direct IDE integration
- `/ci` - GitLab CI/CD pipelines for deployment

## Features

- Create and monitor AI coding tasks
- Linear integration for issue tracking
- Real-time terminal streaming via SSH
- GitLab integration for code review

## Deployment

### GCP Cloud Run (Recommended)

Use the automated deployment script with an AI agent:

```bash
# See agent_deploy.md for detailed instructions
./scripts/deploy.sh --interactive
```

The deployment script handles:
- GCP project setup
- Cloud SQL PostgreSQL database
- Secret Manager for API keys
- Cloud Build for container images
- Cloud Run deployment
- IAM and service accounts

**Prerequisites:**
- `gcloud` CLI authenticated
- `psql` PostgreSQL client
- `jq` JSON processor

See [`agent_deploy.md`](./agent_deploy.md) for comprehensive deployment guide.

### Self-Hosted

- Run with PM2 or Docker
- SQLite or PostgreSQL database support
- See `app/deployment/ecosystem.config.cjs`

## Database Support

- **SQLite** - For local development and simple deployments
- **PostgreSQL** - For production and Cloud Run deployments

Set `DB_TYPE=sqlite` or `DB_TYPE=postgres` in your environment.

## Quick Start

```bash
# Web App
cd app
npm install
cp .env.example .env  # Configure your environment
npm run dev

# VSCode Extension
cd vscode-extension
npm install
npm run build
```
