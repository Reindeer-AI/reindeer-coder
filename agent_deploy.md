# Reindeer Coder Deployment Guide

This guide helps you deploy Reindeer Coder to a new GCP project. The deployment script (`scripts/deploy.sh`) automates most of the process, but some manual steps are required.

## Prerequisites

Before starting, ensure you have:

1. **GCP CLI (`gcloud`)** - Authenticated with an account that has project creation permissions
2. **`psql`** - PostgreSQL client for database setup
3. **`jq`** - JSON processor (for parsing)

Verify with:
```bash
gcloud auth list
which psql
which jq
```

## Information to Gather

You'll need the following information from the user:

### Required

| Item | Description | Example |
|------|-------------|---------|
| **GCP Project ID** | Unique project identifier | `my-company-coder` |
| **Auth0 Domain** | Auth0 tenant domain | `myapp.us.auth0.com` |
| **Auth0 Client ID** | SPA application client ID | `abc123...` |
| **Auth0 Audience** | API identifier | `https://api.myapp.com` |

### Optional

| Item | Description | Default |
|------|-------------|---------|
| **GCP Billing Account** | For new projects | User's default |
| **GCP Region** | Deployment region | `us-central1` |
| **Auth0 Org ID** | For Auth0 Organizations | None |
| **Email Domain** | Restrict users to domain | None (all allowed) |
| **Anthropic API Key** | For Claude Code | Users auth individually |
| **OpenAI API Key** | For Codex CLI | Codex disabled |

### Git Provider Setup

The user needs to choose between **GitHub** or **GitLab**:

#### For GitHub
1. Create a GitHub App in the organization
2. Collect: App ID, Installation ID, Private Key (.pem file)

#### For GitLab
1. Create a Personal Access Token with `api`, `read_repository`, `write_repository` scopes
2. Collect: GitLab token

## Step-by-Step Deployment

### 1. Create Configuration File

Create `scripts/deploy.config` with the gathered information:

```bash
# GCP Settings
GCP_PROJECT_ID="<project-id>"
GCP_BILLING_ACCOUNT="<billing-account-id>"  # Find with: gcloud billing accounts list
GCP_REGION="us-central1"
GCP_ZONE="us-central1-a"

# Auth0 Configuration
AUTH0_DOMAIN="<domain>.auth0.com"
AUTH0_CLIENT_ID="<client-id>"
AUTH0_AUDIENCE="<audience>"
AUTH0_ORG_ID=""  # Optional

# Git Configuration (GitHub example)
GIT_BASE_URL="https://github.com"
GIT_ORG="<org-name>"
GIT_USER="x-access-token"
GITHUB_APP_ID="<app-id>"
GITHUB_INSTALLATION_ID="<installation-id>"
GITHUB_APP_PRIVATE_KEY_FILE="scripts/github-app-key.pem"

# Or for GitLab:
# GIT_BASE_URL="https://gitlab.com"
# GIT_USER="oauth2"
# GITLAB_TOKEN="<token>"
# GITLAB_API_URL="https://gitlab.com/api/v4"

# Application
SERVICE_NAME="reindeer-coder"
EMAIL_DOMAIN=""  # Optional: restrict to domain

# API Keys (all optional)
ANTHROPIC_API_KEY=""
OPENAI_API_KEY=""
LINEAR_API_KEY=""
```

### 2. Run the Deployment

```bash
./scripts/deploy.sh
```

The script will:
1. Create GCP project (if new)
2. Enable required APIs
3. Set up service accounts with IAM roles
4. Create Cloud SQL PostgreSQL database
5. Store secrets in Secret Manager
6. Create Artifact Registry
7. Set up firewall rules for IAP SSH
8. Build Docker image via Cloud Build
9. Deploy to Cloud Run
10. Run database migrations

**Expected duration:** 10-15 minutes (mostly Cloud SQL creation)

### 3. Configure Auth0

After deployment, configure Auth0:

#### Application URLs

In your Auth0 Application settings, add:

| Setting | Value |
|---------|-------|
| **Allowed Callback URLs** | `https://<service-url>` |
| **Allowed Logout URLs** | `https://<service-url>` |
| **Allowed Web Origins** | `https://<service-url>` |

The service URL is shown at the end of deployment (e.g., `https://reindeer-coder-xxxxx.us-central1.run.app`).

#### Admin Permissions (Required for Config Management)

The app uses Auth0 permissions to control admin access. Users need the `admin` permission to access the config management page.

**Step 1: Configure API Permissions**

1. Go to **Auth0 Dashboard → Applications → APIs**
2. Select your API (matching `AUTH0_AUDIENCE`)
3. Go to the **Permissions** tab
4. Add a permission:
   - Permission: `admin`
   - Description: `Administrator access`

**Step 2: Enable RBAC**

1. In the same API settings, go to **Settings** tab
2. Scroll to **RBAC Settings**
3. Enable:
   - **Enable RBAC**: ON
   - **Add Permissions in the Access Token**: ON
4. Save changes

**Step 3: Create Admin Role**

1. Go to **Auth0 Dashboard → User Management → Roles**
2. Click **Create Role**
3. Name: `Admin`
4. Description: `Administrator role with full access`
5. Click **Create**
6. Go to the **Permissions** tab
7. Click **Add Permissions**
8. Select your API and check `admin`
9. Click **Add Permissions**

**Step 4: Assign Role to Users**

1. Go to **Auth0 Dashboard → User Management → Users**
2. Select the user who should be admin
3. Go to the **Roles** tab
4. Click **Assign Roles**
5. Select `Admin` and click **Assign**

After these steps, the user's access token will include `"permissions": ["admin"]` and they'll have access to the config management page.

## Troubleshooting

### Build Fails with Permission Error

Cloud Build needs storage and artifact registry permissions:

```bash
PROJECT_NUMBER=$(gcloud projects describe <project-id> --format="value(projectNumber)")

# Grant to Cloud Build SA
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/storage.admin"

gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# Grant to Compute SA (used by regional Cloud Build)
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/logging.logWriter"
```

### Database Connection Fails (503 Error)

The Cloud Run service account needs `cloudsql.instanceUser` role:

```bash
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:reindeer-coder@<project-id>.iam.gserviceaccount.com" \
  --role="roles/cloudsql.instanceUser"
```

### Database Permission Denied

The IAM database user needs schema permissions. Connect as postgres and run:

```sql
GRANT ALL PRIVILEGES ON DATABASE vibe_coding TO "reindeer-coder@<project-id>.iam";
GRANT ALL ON SCHEMA public TO "reindeer-coder@<project-id>.iam";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "reindeer-coder@<project-id>.iam";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO "reindeer-coder@<project-id>.iam";
```

To connect:
```bash
# Set postgres password first
gcloud sql users set-password postgres --instance=reindeer-apps --project=<project-id> --password="<temp-password>"

# Connect
psql "host=<instance-ip> dbname=vibe_coding user=postgres password=<temp-password>"
```

### Cloud Run Returns 503

Check the logs:
```bash
gcloud run services logs read reindeer-coder --region=us-central1 --project=<project-id> --limit=50
```

Common causes:
- Database connection issues (see above)
- Missing environment variables
- Secret Manager access denied

### VM Startup Fails with "PERMISSION_DENIED: Failed to impersonate"

The VM service account needs permission to impersonate the Cloud Run service account to access secrets:

```bash
gcloud iam service-accounts add-iam-policy-binding reindeer-coder@<project-id>.iam.gserviceaccount.com \
  --member="serviceAccount:reindeer-vm@<project-id>.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=<project-id>
```

## Resuming Failed Deployments

If the script fails partway through, resume from a specific step:

```bash
./scripts/deploy.sh --from-step <N>
```

Steps:
1. Create GCP Project
2. Enable APIs
3. Setup IAM
4. Create Cloud SQL
5. Create Secrets
6. Setup Artifact Registry
7. Setup Firewall
8. Build Docker Image
9. Deploy to Cloud Run
10. Run Migrations

## Useful Commands

```bash
# Check deployment status
./scripts/deploy.sh --status

# Skip database/secrets (for updates)
./scripts/deploy.sh --skip-db --skip-secrets

# Dry run (see what would happen)
./scripts/deploy.sh --dry-run

# View Cloud Run logs
gcloud run services logs read reindeer-coder --region=us-central1 --project=<project-id>

# Destroy all resources
./scripts/deploy.sh --destroy
```

## GitHub vs GitLab Support

The codebase currently has some GitLab-specific code paths. When deploying with GitHub:

1. Git cloning works via GitHub App tokens
2. Some features (MR creation, Linear integration with GitLab) may need code updates
3. The `GIT_BASE_URL` and `GIT_USER` settings control the git provider

For full GitHub support, the VM orchestrator code may need updates to handle GitHub-specific authentication and API calls.

## Environment Variables Reference

### Cloud Run Environment Variables

| Variable | Description |
|----------|-------------|
| `AUTH0_DOMAIN` | Auth0 domain (runtime) |
| `AUTH0_CLIENT_ID` | Auth0 client ID (runtime) |
| `AUTH0_AUDIENCE` | Auth0 API audience |
| `AUTH0_ORG_ID` | Auth0 organization ID |
| `GCP_PROJECT_ID` | GCP project for VMs |
| `GCP_ZONE` | Zone for VMs |
| `GCP_NETWORK` | VPC network |
| `GCP_VM_SERVICE_ACCOUNT` | VM service account |
| `GIT_BASE_URL` | Git server URL |
| `GIT_ORG` | Git organization |
| `GIT_USER` | Git auth username |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_INSTALLATION_ID` | GitHub App installation ID |
| `*_SECRET` | Secret Manager paths for API keys |

### Build-time Variables (Vite)

| Variable | Description |
|----------|-------------|
| `VITE_AUTH0_DOMAIN` | Auth0 domain (baked into frontend) |
| `VITE_AUTH0_CLIENT_ID` | Auth0 client ID (frontend) |
| `VITE_AUTH0_AUDIENCE` | Auth0 audience (frontend) |
| `VITE_AUTH0_ORG_ID` | Auth0 org ID (frontend) |
