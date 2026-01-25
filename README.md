# Reindeer Coder

AI Coding Agents at Scale - Orchestrate coding agents (Claude Code, Gemini CLI, Codex) across cloud VMs with a web dashboard, VS Code extension, and Linear integration.

## Features

### Cloud VM Orchestration
- Spin up GCP VMs with your chosen coding agent (Claude Code, Gemini CLI, or Codex)
- Run multiple coding tasks in parallel
- Automatic resource cleanup after completion

### Web Dashboard
- Create and monitor AI coding tasks
- Live terminal streaming via SSH
- Task history and status tracking

### VS Code Extension
- Create tasks directly from your IDE
- Monitor task progress
- Quick access to terminal sessions

### Linear Integration
- Write task descriptions in Linear and request implementation plans
- Review plans via Linear labels before proceeding
- Label changes trigger automated implementation and PR creation
- Notifications alert you to blockers or completion
- Resources automatically release after PR merge

### Git Provider Support
- **GitHub**: GitHub App authentication for secure repository access
- **GitLab**: Personal access tokens or OAuth
- Automatic provider detection from repository URLs
- Automated PR/MR creation upon task completion

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

To create and run coding tasks, you need GCP credentials for VM provisioning:

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

### VS Code Extension Setup

The VS Code extension connects to your Reindeer Coder server:

1. Build and install the extension:
   ```bash
   cd vscode-extension
   npm install
   npm run build
   # Install the generated .vsix file in VS Code
   ```

2. Configure the extension settings:
   - Set the server URL (e.g., `http://localhost:5173` for local development)
   - The extension will auto-detect authentication settings

## Architecture

```
reindeer-coder/
├── app/                 # SvelteKit web application
│   ├── src/lib/server/  # VM orchestration, Linear integration
│   └── src/routes/      # API endpoints and UI pages
├── vscode-extension/    # VS Code extension for IDE integration
└── ci/                  # CI/CD configuration
```

### How It Works

1. **Task Creation**: Define a coding task with repository URL, branch, prompt, and coding agent
2. **VM Provisioning**: GCP Compute Engine VM spins up with the selected agent pre-installed
3. **Execution**: The coding agent runs autonomously with your specified prompt
4. **Monitoring**: Watch progress via real-time terminal streaming
5. **Intervention**: SSH into the VM anytime to guide or correct the agent
6. **Completion**: Automated PR/MR creation and resource cleanup

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

See [`agent_deploy.md`](./agent_deploy.md) for the comprehensive deployment guide.

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
| `GCP_ZONE` | GCP zone for VMs | `us-central1-a` |
| `GITHUB_APP_ID` | GitHub App ID for repository access | - |
| `GITHUB_INSTALLATION_ID` | GitHub App Installation ID | - |
| `ANTHROPIC_API_KEY` | API key for Claude (can use Secret Manager) | - |

### Database Support

- **SQLite** - For local development and simple deployments
- **PostgreSQL** - For production and Cloud Run deployments

Set `DB_TYPE=sqlite` or `DB_TYPE=postgres` in your environment.

## License

MIT
