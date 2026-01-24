# Reindeer Coder

Coding Agents Orchestration - Manage AI-powered coding agents with a web dashboard and VSCode extension.

## Quick Start (UI Preview)

Preview the UI locally with SQLite and no authentication:

```bash
# Clone and install
git clone https://github.com/Reindeer-AI/reindeer-coder.git
cd reindeer-coder/app
npm install

# Start with auth disabled
npm run dev:noauth
```

Open http://localhost:5173 to explore the UI. Note: Creating tasks requires GCP setup (see below).

## Local Development (Full Features)

To actually create and run coding tasks, you need GCP credentials for VM provisioning:

```bash
# Copy and configure .env
cp .env.example .env

# Required for task creation:
# - GCP_PROJECT_ID, GCP_ZONE - for VM provisioning
# - GCP_VM_SERVICE_ACCOUNT - VM service account with Vertex AI access
# - ANTHROPIC_API_KEY (or other AI provider keys)
# - GitHub/GitLab credentials for repo access

# Authenticate with GCP
gcloud auth application-default login

# Start development server
npm run dev:noauth  # or npm run dev with Auth0 configured
```

### Using with VSCode Extension

The VSCode extension works with your local server:

1. Build and install the extension:
   ```bash
   cd vscode-extension
   npm install
   npm run build
   # Install the .vsix file in VSCode
   ```

2. Configure the extension to use your local server URL: `http://localhost:5173`

## Components

- `/app` - SvelteKit web application for managing coding agents
- `/vscode-extension` - VSCode extension for direct IDE integration
- `/ci` - CI/CD configuration for deployment

## Features

- Create and monitor AI coding tasks
- Linear integration for issue tracking
- Real-time terminal streaming via SSH
- GitHub and GitLab integration for code review

## Production Deployment

### GCP Cloud Run (Recommended)

For production deployments with Auth0 authentication, PostgreSQL, and full features:

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

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_TYPE` | Database type (`sqlite` or `postgres`) | `sqlite` |
| `DISABLE_AUTH` | Disable Auth0 authentication | `false` |
| `GCP_PROJECT_ID` | GCP project for VM provisioning | - |
| `GITHUB_APP_ID` | GitHub App ID for repository access | - |
| `GITHUB_INSTALLATION_ID` | GitHub App Installation ID | - |

### Git Provider Support

Reindeer Coder supports both **GitHub** and **GitLab**:

- **GitHub**: Uses GitHub App authentication for secure repository access
- **GitLab**: Uses personal access tokens or OAuth

The system automatically detects the git provider from repository URLs.

## Database Support

- **SQLite** - For local development and simple deployments
- **PostgreSQL** - For production and Cloud Run deployments

Set `DB_TYPE=sqlite` or `DB_TYPE=postgres` in your environment.
