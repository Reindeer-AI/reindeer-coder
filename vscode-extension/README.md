# Vibe Coding VS Code Extension

Connect to your Vibe Coding remote workspaces directly from Visual Studio Code.

## Features

- **Task Browser**: View your active Vibe Coding tasks in the sidebar
- **Remote Workspace**: Mount and browse remote VM filesystems using SSHFS
- **Terminal Connection**: Connect to running AI agent tmux sessions
- **Secure Authentication**: OAuth2 PKCE flow with Auth0
- **Seamless Integration**: Edit code while the AI agent works in parallel

## Prerequisites

Before using this extension, you need:

1. **gcloud CLI**: Install from https://cloud.google.com/sdk/docs/install
   ```bash
   # Verify installation
   gcloud --version

   # Authenticate
   gcloud auth login
   ```

2. **SSHFS**: Platform-specific installation
   - **macOS**: `brew install macfuse sshfs`
   - **Linux**: `sudo apt-get install sshfs` (Debian/Ubuntu) or `sudo yum install sshfs` (RHEL/CentOS)
   - **Windows**: Install [SSHFS-Win](https://github.com/winfsp/sshfs-win)

3. **GCP IAP Access**: Ensure you have the `roles/iap.tunnelResourceAccessor` role for the project

## Installation

1. Download the `.vsix` file from releases
2. In VS Code, go to Extensions view (Ctrl+Shift+X / Cmd+Shift+X)
3. Click "..." menu → "Install from VSIX..."
4. Select the downloaded `.vsix` file

## Usage

### 1. Login

- Click the Vibe Coding icon in the sidebar
- Click "Click to login" or run command: `Vibe Coding: Login`
- Complete authentication in your browser

### 2. Browse Tasks

- Your active tasks will appear in the sidebar
- Each task shows its status (Running, Pending, Completed, Failed)
- Click a task to connect

### 3. Connect to Task

When you click a running task:
1. The remote filesystem is mounted via SSHFS
2. VS Code opens the mounted workspace folder
3. A terminal opens and connects to the running tmux session
4. You can now view/edit files while the AI agent works

### 4. Disconnect

- Close the terminal to disconnect
- The filesystem will be automatically unmounted

## Configuration

Access settings via: File → Preferences → Settings → Vibe Coding

**Required Settings:**

| Setting | Description | How to Get It |
|---------|-------------|---------------|
| `vibeCoding.auth0ClientId` | Auth0 client ID | Use same client ID as web app (from `VITE_AUTH0_CLIENT_ID`) |
| `vibeCoding.auth0Domain` | Auth0 domain | Same as web app (from `VITE_AUTH0_DOMAIN`) |

**Optional Settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `vibeCoding.apiUrl` | Vibe Coding API URL | `https://vibe.reindeer.ai` |
| `vibeCoding.auth0Audience` | Auth0 API audience | `https://vibe.reindeer.ai` |
| `vibeCoding.auth0OrganizationId` | Auth0 organization ID (if using orgs) | `` |
| `vibeCoding.gcpProject` | GCP project ID | `reindeer-backend` |
| `vibeCoding.mountPath` | Local mount path (empty = temp dir) | `` |

**Getting Your Auth0 Configuration:**

The extension uses the same Auth0 application as the web app. Get these values from your web app's `.env` file:

```bash
# From web app .env file:
VITE_AUTH0_DOMAIN=your-tenant.auth0.com           → vibeCoding.auth0Domain
VITE_AUTH0_CLIENT_ID=your-client-id               → vibeCoding.auth0ClientId
VITE_AUTH0_AUDIENCE=https://vibe.reindeer.ai      → vibeCoding.auth0Audience
VITE_AUTH0_ORG_ID=org_xxxxx                       → vibeCoding.auth0OrganizationId (optional)
```

**Auth0 Setup:**

To use the same Auth0 application, add this callback URL in your Auth0 dashboard:
- **Allowed Callback URLs**: Add `http://localhost:54321/callback`
- **Allowed Logout URLs**: Add `http://localhost:54321`

## Commands

| Command | Description |
|---------|-------------|
| `Vibe Coding: Login` | Authenticate with Auth0 |
| `Vibe Coding: Logout` | Sign out and clear tokens |
| `Vibe Coding: Refresh Tasks` | Reload task list |

## Troubleshooting

### SSHFS mount fails

- Verify gcloud is authenticated: `gcloud auth list`
- Check IAP permissions: `gcloud projects get-iam-policy PROJECT_ID`
- Ensure VM is running: `gcloud compute instances list`

### Terminal connection fails

- Verify tmux session exists on VM: `tmux ls`
- Check firewall rules allow IAP tunnel
- Ensure SSH keys are configured

### Authentication issues

- Clear stored tokens: Run `Vibe Coding: Logout`
- Check Auth0 configuration
- Verify network connectivity

## Development

```bash
# Clone repository
git clone https://github.com/reindeer-ai/workspace.git
cd experimental/vibe-coding-vscode

# Install dependencies
npm install

# Build extension
npm run build

# Watch mode for development
npm run watch

# Package extension
npm run package
```

## Architecture

```
vibe-coding-vscode/
├── src/
│   ├── extension.ts           # Main entry point
│   ├── auth/
│   │   └── auth0-client.ts    # OAuth2 PKCE flow
│   ├── api/
│   │   └── vibe-client.ts     # API client
│   ├── views/
│   │   └── task-tree-provider.ts  # Sidebar tree view
│   └── connection/
│       ├── sshfs-manager.ts   # Filesystem mounting
│       └── terminal-manager.ts # Terminal connection
├── package.json
└── tsconfig.json
```

## Security

- Tokens stored securely using VS Code Secrets API
- OAuth2 PKCE flow prevents authorization code interception
- SSH connections use IAP tunneling (no exposed SSH keys)
- All API calls use Bearer token authentication

## License

MIT

## Support

For issues or questions:
- GitHub: https://github.com/reindeer-ai/workspace/issues
- Email: support@reindeer.ai
