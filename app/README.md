# Reindeer Coder - Web App

Remote AI-powered coding platform. Spawn cloud VMs, run Claude Code, Gemini CLI, or Codex on your repositories.

## Features

- **Multi-Agent Support**: Claude Code, Gemini CLI, Codex
- **Automatic VM Provisioning**: GCP Compute Engine integration
- **Real-time Terminal Streaming**: Watch agents work in real-time via SSE
- **Interactive Instructions**: Send follow-up instructions to running agents
- **Branch Management**: Auto-creates feature branches for each task
- **Linear Integration**: Automated task execution from Linear tickets with agent labels

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│  SvelteKit + TailwindCSS + xterm.js                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Backend API                              │
│  - POST /api/tasks (create)                                  │
│  - GET /api/tasks (list)                                     │
│  - GET /api/tasks/:id (get)                                  │
│  - GET /api/tasks/:id/terminal (SSE stream)                 │
│  - PATCH /api/tasks/:id (send instructions)                 │
│  - DELETE /api/tasks/:id (stop & cleanup)                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  VM Orchestration Layer                      │
│  - GCP Compute Engine API                                    │
│  - gcloud compute ssh (IAP tunneling)                        │
│  - Terminal session streaming                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Cloud VMs                                 │
│  - Pre-configured Ubuntu with coding CLIs                   │
│  - Git credentials                                           │
│  - Running agent process                                     │
└─────────────────────────────────────────────────────────────┘
```

## Setup

1. Copy environment template:
   ```bash
   cp .env.example .env
   ```

2. Configure environment variables:
   - Auth0 credentials
   - GCP project and service account
   - API keys for agents (Anthropic, Google, OpenAI)
   - SSH keys for VM access

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run development server:
   ```bash
   npm run dev
   ```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AUTH0_DOMAIN` | Auth0 tenant domain |
| `VITE_AUTH0_DOMAIN` | Auth0 domain (client-side) |
| `VITE_AUTH0_CLIENT_ID` | Auth0 client ID |
| `VITE_REINDEER_ORG_ID` | Auth0 organization ID |
| `GCP_PROJECT_ID` | GCP project for VMs |
| `GCP_ZONE` | Default GCP zone |
| `GCP_VM_SERVICE_ACCOUNT` | Service account for VMs (has Vertex AI access) |
| `ANTHROPIC_API_KEY` | For Claude Code |
| `OPENAI_API_KEY` | For Codex |
| `GITLAB_TOKEN` | GitLab Personal Access Token for API access and cloning |

**Note**: No SSH keys or Google API keys required:
- VM access uses `gcloud compute ssh` with IAP tunneling
- Gemini CLI uses the VM's default service account for Vertex AI authentication

## API Endpoints

### POST /api/tasks
Create a new coding task.

```json
{
  "repository": "https://github.com/user/repo.git",
  "base_branch": "main",
  "task_description": "Add user authentication",
  "coding_cli": "claude-code",
  "system_prompt": "Optional custom instructions"
}
```

### GET /api/tasks
List all tasks for the authenticated user.

### GET /api/tasks/:id
Get a specific task.

### GET /api/tasks/:id/terminal?token=JWT
Server-Sent Events stream for terminal output.

### PATCH /api/tasks/:id
Send instruction to running task.

```json
{
  "instruction": "Also add password reset functionality"
}
```

### DELETE /api/tasks/:id
Stop and delete a task.

## Tech Stack

- **Frontend**: SvelteKit, TailwindCSS, xterm.js
- **Backend**: SvelteKit API routes (Node.js)
- **Database**: SQLite or PostgreSQL
- **VM Management**: GCP Compute Engine API
- **Terminal Streaming**: Server-Sent Events + gcloud compute ssh
- **Auth**: Auth0
- **Task Automation**: Linear API integration with agent monitoring
