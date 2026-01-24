#!/usr/bin/env bash
#
# Reindeer Coder - Complete GCP Deployment Script
#
# This script automates the entire deployment process:
# 1. Creates/configures GCP project
# 2. Enables required APIs
# 3. Creates service accounts with proper IAM roles
# 4. Sets up Cloud SQL PostgreSQL database
# 5. Creates secrets in Secret Manager
# 6. Sets up Artifact Registry
# 7. Builds and deploys to Cloud Run
# 8. Runs database migrations
#
# Usage: ./scripts/deploy.sh [config-file]
#        ./scripts/deploy.sh --help
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

#------------------------------------------------------------------------------
# Logging functions
#------------------------------------------------------------------------------
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_step() { echo -e "\n${GREEN}==>${NC} ${BLUE}$1${NC}"; }

#------------------------------------------------------------------------------
# Help
#------------------------------------------------------------------------------
show_help() {
    cat << EOF
Reindeer Coder - Complete GCP Deployment Script

USAGE:
    ./scripts/deploy.sh [OPTIONS] [CONFIG_FILE]

OPTIONS:
    -h, --help          Show this help message
    -i, --interactive   Interactive mode - prompts for all configuration
    -c, --config FILE   Path to configuration file (default: scripts/deploy.config)
    -n, --dry-run       Show what would be done without executing
    --status            Show deployment status (what exists, what's missing)
    --skip-build        Skip Docker build (use existing image)
    --skip-db           Skip database creation (use existing)
    --skip-secrets      Skip secret creation (use existing)
    --from-step N       Resume from step N (1-10)
    --destroy           Destroy all resources (USE WITH CAUTION)

IDEMPOTENCY:
    This script is safe to re-run. It checks if resources exist before creating
    them. If the script fails partway through, just run it again.

    To see what's already deployed:
        ./scripts/deploy.sh --status

    To resume from a specific step:
        ./scripts/deploy.sh --from-step 5

STEPS:
    1. Create GCP Project
    2. Enable APIs
    3. Setup IAM (service accounts & roles)
    4. Create Cloud SQL database
    5. Create secrets in Secret Manager
    6. Setup Artifact Registry
    7. Setup firewall rules
    8. Build and push Docker image
    9. Deploy to Cloud Run
    10. Run database migrations

MODES:
    Interactive (recommended for first-time setup):
        ./scripts/deploy.sh --interactive

    Config file:
        cp scripts/deploy.config.example scripts/deploy.config
        # Edit the config file with your values
        ./scripts/deploy.sh

REQUIREMENTS:
    - gcloud CLI installed and authenticated
    - Docker installed (for building)
    - jq installed (for JSON parsing)

OPTIONAL SECRETS:
    The script will ask for API keys, but they are all OPTIONAL:
    - Anthropic API Key: If not set, users must login to Claude during sessions
    - OpenAI API Key: If not set, users must login to Codex during sessions
    - GitLab Token: If not set, only public repos can be cloned
    - Linear API Key: If not set, Linear integration is disabled

EXAMPLES:
    # Interactive setup (recommended)
    ./scripts/deploy.sh -i

    # Check what's already deployed
    ./scripts/deploy.sh --status

    # Resume from step 5 (secrets)
    ./scripts/deploy.sh --from-step 5

    # Dry run to see what would happen
    ./scripts/deploy.sh --dry-run --interactive

    # Update existing deployment (skip DB and secrets)
    ./scripts/deploy.sh --skip-db --skip-secrets

EOF
    exit 0
}

#------------------------------------------------------------------------------
# Interactive prompts
#------------------------------------------------------------------------------
prompt_value() {
    local var_name="$1"
    local prompt_text="$2"
    local default_value="${3:-}"
    local is_secret="${4:-false}"
    local is_required="${5:-false}"

    local current_value="${!var_name:-$default_value}"
    local display_default=""

    if [[ -n "$current_value" ]]; then
        if [[ "$is_secret" == "true" ]]; then
            display_default=" [****hidden****]"
        else
            display_default=" [$current_value]"
        fi
    elif [[ "$is_required" == "true" ]]; then
        display_default=" (required)"
    else
        display_default=" (optional, press Enter to skip)"
    fi

    local input
    if [[ "$is_secret" == "true" ]]; then
        echo -en "${BLUE}$prompt_text${NC}$display_default: "
        read -rs input
        echo ""
    else
        echo -en "${BLUE}$prompt_text${NC}$display_default: "
        read -r input
    fi

    if [[ -n "$input" ]]; then
        eval "$var_name=\"$input\""
    elif [[ -z "$current_value" && "$is_required" == "true" ]]; then
        log_error "$var_name is required"
        return 1
    fi
}

interactive_config() {
    log_step "Interactive Configuration"
    echo ""
    echo "This wizard will guide you through the deployment configuration."
    echo "Press Enter to accept defaults shown in [brackets]."
    echo ""

    #--- GCP Project ---
    echo -e "${GREEN}=== GCP Project Settings ===${NC}"
    prompt_value GCP_PROJECT_ID "GCP Project ID" "" false true
    prompt_value GCP_BILLING_ACCOUNT "GCP Billing Account ID" "" false false
    prompt_value GCP_REGION "GCP Region" "us-central1" false false
    prompt_value GCP_ZONE "GCP Zone" "us-central1-a" false false
    echo ""

    #--- Auth0 ---
    echo -e "${GREEN}=== Auth0 Configuration ===${NC}"
    echo -e "${YELLOW}Note: You need an Auth0 account. Create one at https://auth0.com${NC}"
    prompt_value AUTH0_DOMAIN "Auth0 Domain (e.g., myapp.us.auth0.com)" "" false true
    prompt_value AUTH0_CLIENT_ID "Auth0 Client ID" "" false true
    prompt_value AUTH0_AUDIENCE "Auth0 API Audience (e.g., https://myapi.example.com)" "" false true
    prompt_value AUTH0_ORG_ID "Auth0 Organization ID" "" false false
    echo ""

    #--- Git/GitLab ---
    echo -e "${GREEN}=== Git Configuration ===${NC}"
    prompt_value GIT_BASE_URL "Git server URL" "https://gitlab.com" false false
    prompt_value GIT_ORG "Git organization/group name" "" false false
    prompt_value GITLAB_API_URL "GitLab API URL" "https://gitlab.com/api/v4" false false
    echo ""

    #--- Application ---
    echo -e "${GREEN}=== Application Settings ===${NC}"
    prompt_value SERVICE_NAME "Cloud Run service name" "reindeer-coder" false false
    prompt_value EMAIL_DOMAIN "Allowed email domain (e.g., mycompany.com)" "" false false
    prompt_value APP_URL "Custom application URL" "" false false
    echo -e "${YELLOW}  (Leave empty to use auto-generated Cloud Run URL)${NC}"
    echo ""

    #--- VM Settings ---
    echo -e "${GREEN}=== VM Configuration ===${NC}"
    prompt_value VM_MACHINE_TYPE "VM machine type" "e2-standard-4" false false
    prompt_value VM_USER "VM username" "vibe" false false
    echo ""

    #--- Secrets ---
    echo -e "${GREEN}=== API Keys & Secrets ===${NC}"
    echo ""
    echo -e "${YELLOW}These are OPTIONAL. If not provided:${NC}"
    echo -e "  - Anthropic API Key: Users must login to Claude during sessions"
    echo -e "  - OpenAI API Key: Users must login to Codex during sessions"
    echo -e "  - GitLab Token: Won't be able to clone private repos or create MRs"
    echo -e "  - Linear API Key: Linear integration won't work"
    echo ""

    prompt_value ANTHROPIC_API_KEY "Anthropic API Key (sk-ant-...)" "" true false
    if [[ -z "$ANTHROPIC_API_KEY" ]]; then
        echo -e "  ${YELLOW}→ Skipped: Users will need to authenticate Claude during sessions${NC}"
    fi

    prompt_value OPENAI_API_KEY "OpenAI API Key (sk-...)" "" true false
    if [[ -z "$OPENAI_API_KEY" ]]; then
        echo -e "  ${YELLOW}→ Skipped: Users will need to authenticate Codex during sessions${NC}"
    fi

    prompt_value GITLAB_TOKEN "GitLab Personal Access Token (glpat-...)" "" true false
    if [[ -z "$GITLAB_TOKEN" ]]; then
        echo -e "  ${YELLOW}→ Skipped: Only public repos can be cloned${NC}"
    fi

    prompt_value LINEAR_API_KEY "Linear API Key (lin_api_...)" "" true false
    if [[ -z "$LINEAR_API_KEY" ]]; then
        echo -e "  ${YELLOW}→ Skipped: Linear integration disabled${NC}"
    fi

    echo ""

    #--- Summary ---
    echo -e "${GREEN}=== Configuration Summary ===${NC}"
    echo -e "  Project:        $GCP_PROJECT_ID"
    echo -e "  Region:         $GCP_REGION"
    echo -e "  Service:        $SERVICE_NAME"
    echo -e "  Auth0 Domain:   $AUTH0_DOMAIN"
    echo -e "  Anthropic Key:  ${ANTHROPIC_API_KEY:+configured}${ANTHROPIC_API_KEY:-not set}"
    echo -e "  OpenAI Key:     ${OPENAI_API_KEY:+configured}${OPENAI_API_KEY:-not set}"
    echo -e "  GitLab Token:   ${GITLAB_TOKEN:+configured}${GITLAB_TOKEN:-not set}"
    echo -e "  Linear Key:     ${LINEAR_API_KEY:+configured}${LINEAR_API_KEY:-not set}"
    echo ""

    read -rp "Proceed with deployment? [Y/n]: " confirm
    if [[ "$confirm" =~ ^[Nn] ]]; then
        log_info "Deployment cancelled"
        exit 0
    fi
}

#------------------------------------------------------------------------------
# Configuration defaults
#------------------------------------------------------------------------------
set_defaults() {
    # GCP Project Settings
    GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
    GCP_BILLING_ACCOUNT="${GCP_BILLING_ACCOUNT:-}"
    GCP_REGION="${GCP_REGION:-us-central1}"
    GCP_ZONE="${GCP_ZONE:-us-central1-a}"

    # Service names
    SERVICE_NAME="${SERVICE_NAME:-reindeer-coder}"

    # Service Accounts
    CLOUD_RUN_SA_NAME="${CLOUD_RUN_SA_NAME:-reindeer-coder}"
    VM_SA_NAME="${VM_SA_NAME:-reindeer-vm}"

    # Cloud SQL
    CLOUDSQL_INSTANCE_NAME="${CLOUDSQL_INSTANCE_NAME:-reindeer-apps}"
    CLOUDSQL_TIER="${CLOUDSQL_TIER:-db-f1-micro}"
    CLOUDSQL_STORAGE_SIZE="${CLOUDSQL_STORAGE_SIZE:-10}"
    DB_NAME="${DB_NAME:-vibe_coding}"

    # Artifact Registry
    ARTIFACT_REGISTRY_REPO="${ARTIFACT_REGISTRY_REPO:-containers}"

    # Cloud Run
    CLOUD_RUN_MEMORY="${CLOUD_RUN_MEMORY:-1Gi}"
    CLOUD_RUN_CPU="${CLOUD_RUN_CPU:-2}"
    CLOUD_RUN_MAX_INSTANCES="${CLOUD_RUN_MAX_INSTANCES:-10}"
    CLOUD_RUN_CONCURRENCY="${CLOUD_RUN_CONCURRENCY:-80}"
    CLOUD_RUN_TIMEOUT="${CLOUD_RUN_TIMEOUT:-300}"

    # VM defaults
    VM_MACHINE_TYPE="${VM_MACHINE_TYPE:-e2-standard-4}"
    VM_IMAGE_FAMILY="${VM_IMAGE_FAMILY:-ubuntu-2204-lts}"
    VM_IMAGE_PROJECT="${VM_IMAGE_PROJECT:-ubuntu-os-cloud}"
    VM_USER="${VM_USER:-vibe}"

    # Network
    GCP_NETWORK="${GCP_NETWORK:-default}"
    GCP_SUBNET="${GCP_SUBNET:-}"

    # Auth0 (required)
    AUTH0_DOMAIN="${AUTH0_DOMAIN:-}"
    AUTH0_CLIENT_ID="${AUTH0_CLIENT_ID:-}"
    AUTH0_AUDIENCE="${AUTH0_AUDIENCE:-}"
    AUTH0_ORG_ID="${AUTH0_ORG_ID:-}"

    # Git configuration
    GIT_BASE_URL="${GIT_BASE_URL:-https://github.com}"
    GIT_ORG="${GIT_ORG:-}"
    GIT_USER="${GIT_USER:-x-access-token}"
    GITLAB_API_URL="${GITLAB_API_URL:-}"

    # GitHub App configuration (for GitHub-based deployments)
    GITHUB_APP_ID="${GITHUB_APP_ID:-}"
    GITHUB_INSTALLATION_ID="${GITHUB_INSTALLATION_ID:-}"
    GITHUB_APP_PRIVATE_KEY_FILE="${GITHUB_APP_PRIVATE_KEY_FILE:-}"

    # Application URL
    APP_URL="${APP_URL:-}"

    # Email domain for allowed users
    EMAIL_DOMAIN="${EMAIL_DOMAIN:-}"

    # API Keys (will be stored in Secret Manager)
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
    OPENAI_API_KEY="${OPENAI_API_KEY:-}"
    GITLAB_TOKEN="${GITLAB_TOKEN:-}"
    LINEAR_API_KEY="${LINEAR_API_KEY:-}"

    # Flags
    DRY_RUN="${DRY_RUN:-false}"
    SKIP_BUILD="${SKIP_BUILD:-false}"
    SKIP_DB="${SKIP_DB:-false}"
    SKIP_SECRETS="${SKIP_SECRETS:-false}"
    DESTROY_MODE="${DESTROY_MODE:-false}"
}

#------------------------------------------------------------------------------
# Parse arguments
#------------------------------------------------------------------------------
parse_args() {
    CONFIG_FILE=""
    INTERACTIVE_MODE="false"
    STATUS_MODE="false"
    FROM_STEP=1

    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                ;;
            -i|--interactive)
                INTERACTIVE_MODE="true"
                shift
                ;;
            -c|--config)
                CONFIG_FILE="$2"
                shift 2
                ;;
            -n|--dry-run)
                DRY_RUN="true"
                shift
                ;;
            --status)
                STATUS_MODE="true"
                shift
                ;;
            --from-step)
                FROM_STEP="$2"
                if ! [[ "$FROM_STEP" =~ ^[0-9]+$ ]] || [[ "$FROM_STEP" -lt 1 ]] || [[ "$FROM_STEP" -gt 10 ]]; then
                    log_error "Invalid step number: $FROM_STEP (must be 1-10)"
                    exit 1
                fi
                shift 2
                ;;
            --skip-build)
                SKIP_BUILD="true"
                shift
                ;;
            --skip-db)
                SKIP_DB="true"
                shift
                ;;
            --skip-secrets)
                SKIP_SECRETS="true"
                shift
                ;;
            --destroy)
                DESTROY_MODE="true"
                shift
                ;;
            *)
                if [[ -z "$CONFIG_FILE" && -f "$1" ]]; then
                    CONFIG_FILE="$1"
                else
                    log_error "Unknown option: $1"
                    exit 1
                fi
                shift
                ;;
        esac
    done

    # Default config file location
    if [[ -z "$CONFIG_FILE" ]]; then
        CONFIG_FILE="$SCRIPT_DIR/deploy.config"
    fi
}

#------------------------------------------------------------------------------
# Load configuration
#------------------------------------------------------------------------------
load_config() {
    set_defaults

    if [[ -f "$CONFIG_FILE" ]]; then
        log_info "Loading configuration from: $CONFIG_FILE"
        # shellcheck source=/dev/null
        source "$CONFIG_FILE"
    else
        log_warn "Config file not found: $CONFIG_FILE"
        log_warn "Using environment variables and defaults"
    fi
}

#------------------------------------------------------------------------------
# Validate configuration
#------------------------------------------------------------------------------
validate_config() {
    log_step "Validating configuration"

    local errors=0

    # Required fields
    if [[ -z "$GCP_PROJECT_ID" ]]; then
        log_error "GCP_PROJECT_ID is required"
        ((errors++))
    fi

    if [[ -z "$AUTH0_DOMAIN" ]]; then
        log_error "AUTH0_DOMAIN is required"
        ((errors++))
    fi

    if [[ -z "$AUTH0_CLIENT_ID" ]]; then
        log_error "AUTH0_CLIENT_ID is required"
        ((errors++))
    fi

    if [[ -z "$AUTH0_AUDIENCE" ]]; then
        log_error "AUTH0_AUDIENCE is required"
        ((errors++))
    fi

    # Check for gcloud
    if ! command -v gcloud &> /dev/null; then
        log_error "gcloud CLI is not installed"
        ((errors++))
    fi

    # Check for docker
    if [[ "$SKIP_BUILD" != "true" ]] && ! command -v docker &> /dev/null; then
        log_error "Docker is not installed (use --skip-build to skip)"
        ((errors++))
    fi

    # Check for jq
    if ! command -v jq &> /dev/null; then
        log_error "jq is not installed"
        ((errors++))
    fi

    if [[ $errors -gt 0 ]]; then
        log_error "Configuration validation failed with $errors error(s)"
        exit 1
    fi

    log_success "Configuration validated"
}

#------------------------------------------------------------------------------
# Run command (respects dry-run)
#------------------------------------------------------------------------------
run_cmd() {
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[DRY-RUN] $*"
    else
        "$@"
    fi
}

#------------------------------------------------------------------------------
# Check if resource exists
#------------------------------------------------------------------------------
resource_exists() {
    local type="$1"
    local name="$2"

    case "$type" in
        project)
            gcloud projects describe "$name" &>/dev/null
            ;;
        service-account)
            gcloud iam service-accounts describe "$name@$GCP_PROJECT_ID.iam.gserviceaccount.com" --project="$GCP_PROJECT_ID" &>/dev/null
            ;;
        cloudsql)
            gcloud sql instances describe "$name" --project="$GCP_PROJECT_ID" &>/dev/null
            ;;
        secret)
            gcloud secrets describe "$name" --project="$GCP_PROJECT_ID" &>/dev/null
            ;;
        artifact-registry)
            gcloud artifacts repositories describe "$name" --location="$GCP_REGION" --project="$GCP_PROJECT_ID" &>/dev/null
            ;;
        cloud-run)
            gcloud run services describe "$name" --region="$GCP_REGION" --project="$GCP_PROJECT_ID" &>/dev/null
            ;;
    esac
}

#------------------------------------------------------------------------------
# Show deployment status
#------------------------------------------------------------------------------
show_status() {
    log_step "Deployment Status for: $GCP_PROJECT_ID"
    echo ""

    local check_mark="${GREEN}✓${NC}"
    local cross_mark="${RED}✗${NC}"
    local warning_mark="${YELLOW}?${NC}"

    status_check() {
        local name="$1"
        local exists="$2"
        if [[ "$exists" == "true" ]]; then
            echo -e "  $check_mark $name"
        else
            echo -e "  $cross_mark $name"
        fi
    }

    # Step 1: Project
    echo -e "${BLUE}Step 1: GCP Project${NC}"
    if resource_exists project "$GCP_PROJECT_ID"; then
        status_check "Project: $GCP_PROJECT_ID" "true"
    else
        status_check "Project: $GCP_PROJECT_ID" "false"
        echo ""
        log_warn "Project doesn't exist. Run: ./scripts/deploy.sh --from-step 1"
        return
    fi
    echo ""

    # Step 2: APIs (just check a key one)
    echo -e "${BLUE}Step 2: APIs${NC}"
    if gcloud services list --enabled --project="$GCP_PROJECT_ID" 2>/dev/null | grep -q "run.googleapis.com"; then
        status_check "Core APIs enabled" "true"
    else
        status_check "Core APIs enabled" "false"
    fi
    echo ""

    # Step 3: Service Accounts
    echo -e "${BLUE}Step 3: Service Accounts${NC}"
    if resource_exists service-account "$CLOUD_RUN_SA_NAME"; then
        status_check "Cloud Run SA: $CLOUD_RUN_SA_NAME" "true"
    else
        status_check "Cloud Run SA: $CLOUD_RUN_SA_NAME" "false"
    fi
    if resource_exists service-account "$VM_SA_NAME"; then
        status_check "VM SA: $VM_SA_NAME" "true"
    else
        status_check "VM SA: $VM_SA_NAME" "false"
    fi
    echo ""

    # Step 4: Cloud SQL
    echo -e "${BLUE}Step 4: Cloud SQL Database${NC}"
    if resource_exists cloudsql "$CLOUDSQL_INSTANCE_NAME"; then
        status_check "Instance: $CLOUDSQL_INSTANCE_NAME" "true"
        # Check database
        if gcloud sql databases describe "$DB_NAME" --instance="$CLOUDSQL_INSTANCE_NAME" --project="$GCP_PROJECT_ID" &>/dev/null; then
            status_check "Database: $DB_NAME" "true"
        else
            status_check "Database: $DB_NAME" "false"
        fi
    else
        status_check "Instance: $CLOUDSQL_INSTANCE_NAME" "false"
    fi
    echo ""

    # Step 5: Secrets
    echo -e "${BLUE}Step 5: Secrets${NC}"
    for secret in vibe-coding-anthropic-api-key vibe-coding-openai-api-key reindeer-gitlab-api-token vibe-coding-linear-api-key; do
        if resource_exists secret "$secret"; then
            status_check "$secret" "true"
        else
            status_check "$secret (optional)" "false"
        fi
    done
    echo ""

    # Step 6: Artifact Registry
    echo -e "${BLUE}Step 6: Artifact Registry${NC}"
    if resource_exists artifact-registry "$ARTIFACT_REGISTRY_REPO"; then
        status_check "Repository: $ARTIFACT_REGISTRY_REPO" "true"
    else
        status_check "Repository: $ARTIFACT_REGISTRY_REPO" "false"
    fi
    echo ""

    # Step 7: Firewall
    echo -e "${BLUE}Step 7: Firewall Rules${NC}"
    if gcloud compute firewall-rules describe "allow-iap-ssh" --project="$GCP_PROJECT_ID" &>/dev/null; then
        status_check "IAP SSH firewall rule" "true"
    else
        status_check "IAP SSH firewall rule" "false"
    fi
    echo ""

    # Step 8: Docker Image (check if any image exists)
    echo -e "${BLUE}Step 8: Docker Image${NC}"
    local image_path="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REGISTRY_REPO/$SERVICE_NAME"
    if gcloud artifacts docker images list "$image_path" --project="$GCP_PROJECT_ID" &>/dev/null 2>&1; then
        local image_count
        image_count=$(gcloud artifacts docker images list "$image_path" --project="$GCP_PROJECT_ID" --format="value(package)" 2>/dev/null | wc -l)
        if [[ "$image_count" -gt 0 ]]; then
            status_check "Image: $SERVICE_NAME" "true"
        else
            status_check "Image: $SERVICE_NAME" "false"
        fi
    else
        status_check "Image: $SERVICE_NAME" "false"
    fi
    echo ""

    # Step 9: Cloud Run
    echo -e "${BLUE}Step 9: Cloud Run Service${NC}"
    if resource_exists cloud-run "$SERVICE_NAME"; then
        status_check "Service: $SERVICE_NAME" "true"
        local url
        url=$(gcloud run services describe "$SERVICE_NAME" --region="$GCP_REGION" --project="$GCP_PROJECT_ID" --format="value(status.url)" 2>/dev/null)
        if [[ -n "$url" ]]; then
            echo -e "     URL: $url"
        fi
    else
        status_check "Service: $SERVICE_NAME" "false"
    fi
    echo ""

    # Summary
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    if resource_exists cloud-run "$SERVICE_NAME"; then
        log_success "Deployment appears complete!"
        echo ""
        echo "To redeploy (rebuild & update):"
        echo "  ./scripts/deploy.sh --from-step 8"
    else
        log_warn "Deployment incomplete. Resume with:"
        echo "  ./scripts/deploy.sh"
    fi
}

#------------------------------------------------------------------------------
# Step 1: Create/Configure GCP Project
#------------------------------------------------------------------------------
setup_project() {
    log_step "Step 1: Setting up GCP Project"

    if resource_exists project "$GCP_PROJECT_ID"; then
        log_info "Project $GCP_PROJECT_ID already exists"
    else
        log_info "Creating project: $GCP_PROJECT_ID"
        run_cmd gcloud projects create "$GCP_PROJECT_ID" --name="$GCP_PROJECT_ID"

        if [[ -n "$GCP_BILLING_ACCOUNT" ]]; then
            log_info "Linking billing account"
            run_cmd gcloud billing projects link "$GCP_PROJECT_ID" --billing-account="$GCP_BILLING_ACCOUNT"
        else
            log_warn "No billing account specified - you'll need to link one manually"
        fi
    fi

    # Set as current project
    run_cmd gcloud config set project "$GCP_PROJECT_ID"

    log_success "Project setup complete"
}

#------------------------------------------------------------------------------
# Step 2: Enable Required APIs
#------------------------------------------------------------------------------
enable_apis() {
    log_step "Step 2: Enabling required APIs"

    local apis=(
        "compute.googleapis.com"
        "sqladmin.googleapis.com"
        "sql-component.googleapis.com"
        "run.googleapis.com"
        "artifactregistry.googleapis.com"
        "secretmanager.googleapis.com"
        "iam.googleapis.com"
        "iamcredentials.googleapis.com"
        "cloudresourcemanager.googleapis.com"
        "aiplatform.googleapis.com"
        "cloudbuild.googleapis.com"
    )

    for api in "${apis[@]}"; do
        log_info "Enabling $api"
        run_cmd gcloud services enable "$api" --project="$GCP_PROJECT_ID"
    done

    log_success "APIs enabled"
}

#------------------------------------------------------------------------------
# Step 3: Create Service Accounts and IAM Bindings
#------------------------------------------------------------------------------
setup_iam() {
    log_step "Step 3: Setting up Service Accounts and IAM"

    # Cloud Run Service Account
    local cloud_run_sa="${CLOUD_RUN_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

    if resource_exists service-account "$CLOUD_RUN_SA_NAME"; then
        log_info "Service account $CLOUD_RUN_SA_NAME already exists"
    else
        log_info "Creating Cloud Run service account: $CLOUD_RUN_SA_NAME"
        run_cmd gcloud iam service-accounts create "$CLOUD_RUN_SA_NAME" \
            --display-name="Reindeer Coder Cloud Run Service Account" \
            --project="$GCP_PROJECT_ID"
    fi

    # VM Service Account
    local vm_sa="${VM_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

    if resource_exists service-account "$VM_SA_NAME"; then
        log_info "Service account $VM_SA_NAME already exists"
    else
        log_info "Creating VM service account: $VM_SA_NAME"
        run_cmd gcloud iam service-accounts create "$VM_SA_NAME" \
            --display-name="Reindeer Coder VM Service Account" \
            --project="$GCP_PROJECT_ID"
    fi

    # Grant roles to Cloud Run service account
    log_info "Granting roles to Cloud Run service account"

    local cloud_run_roles=(
        "roles/cloudsql.client"
        "roles/cloudsql.instanceUser"
        "roles/secretmanager.secretAccessor"
        "roles/iam.serviceAccountTokenCreator"
        "roles/compute.instanceAdmin.v1"
        "roles/iam.serviceAccountUser"
        "roles/iap.tunnelResourceAccessor"
    )

    for role in "${cloud_run_roles[@]}"; do
        run_cmd gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
            --member="serviceAccount:$cloud_run_sa" \
            --role="$role" \
            --condition=None \
            --quiet
    done

    # Grant roles to VM service account
    log_info "Granting roles to VM service account"

    local vm_roles=(
        "roles/aiplatform.user"
        "roles/logging.logWriter"
        "roles/monitoring.metricWriter"
    )

    for role in "${vm_roles[@]}"; do
        run_cmd gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
            --member="serviceAccount:$vm_sa" \
            --role="$role" \
            --condition=None \
            --quiet
    done

    # Allow Cloud Run SA to act as VM SA
    log_info "Allowing Cloud Run SA to impersonate VM SA"
    run_cmd gcloud iam service-accounts add-iam-policy-binding "$vm_sa" \
        --member="serviceAccount:$cloud_run_sa" \
        --role="roles/iam.serviceAccountUser" \
        --project="$GCP_PROJECT_ID"

    # Grant roles to Cloud Build service account (for building and pushing images)
    log_info "Granting roles to Cloud Build service account"
    local project_number
    project_number=$(gcloud projects describe "$GCP_PROJECT_ID" --format="value(projectNumber)")
    local cloud_build_sa="${project_number}@cloudbuild.gserviceaccount.com"
    local compute_sa="${project_number}-compute@developer.gserviceaccount.com"

    local cloud_build_roles=(
        "roles/storage.admin"
        "roles/artifactregistry.writer"
    )

    for role in "${cloud_build_roles[@]}"; do
        run_cmd gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
            --member="serviceAccount:$cloud_build_sa" \
            --role="$role" \
            --condition=None \
            --quiet
    done

    # Cloud Build uses the default compute service account for regional builds
    # Grant it the necessary permissions as well
    log_info "Granting roles to default compute service account (used by Cloud Build)"
    local compute_sa_roles=(
        "roles/storage.objectViewer"
        "roles/artifactregistry.writer"
        "roles/logging.logWriter"
    )

    for role in "${compute_sa_roles[@]}"; do
        run_cmd gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
            --member="serviceAccount:$compute_sa" \
            --role="$role" \
            --condition=None \
            --quiet
    done

    log_success "IAM setup complete"
}

#------------------------------------------------------------------------------
# Step 4: Create Cloud SQL Instance and Database
#------------------------------------------------------------------------------
setup_database() {
    if [[ "$SKIP_DB" == "true" ]]; then
        log_info "Skipping database setup (--skip-db)"
        return
    fi

    log_step "Step 4: Setting up Cloud SQL Database"

    local cloud_run_sa="${CLOUD_RUN_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

    if resource_exists cloudsql "$CLOUDSQL_INSTANCE_NAME"; then
        log_info "Cloud SQL instance $CLOUDSQL_INSTANCE_NAME already exists"
    else
        log_info "Creating Cloud SQL instance: $CLOUDSQL_INSTANCE_NAME"
        log_warn "This may take several minutes..."

        run_cmd gcloud sql instances create "$CLOUDSQL_INSTANCE_NAME" \
            --database-version=POSTGRES_15 \
            --tier="$CLOUDSQL_TIER" \
            --region="$GCP_REGION" \
            --storage-size="$CLOUDSQL_STORAGE_SIZE" \
            --storage-type=SSD \
            --database-flags=cloudsql.iam_authentication=on \
            --project="$GCP_PROJECT_ID"
    fi

    # Create database
    log_info "Creating database: $DB_NAME"
    run_cmd gcloud sql databases create "$DB_NAME" \
        --instance="$CLOUDSQL_INSTANCE_NAME" \
        --project="$GCP_PROJECT_ID" 2>/dev/null || log_info "Database $DB_NAME already exists"

    # Create IAM database user
    local db_user="${CLOUD_RUN_SA_NAME}@${GCP_PROJECT_ID}.iam"
    log_info "Creating IAM database user: $db_user"
    run_cmd gcloud sql users create "$db_user" \
        --instance="$CLOUDSQL_INSTANCE_NAME" \
        --type=CLOUD_IAM_SERVICE_ACCOUNT \
        --project="$GCP_PROJECT_ID" 2>/dev/null || log_info "IAM user already exists"

    # Grant database permissions to IAM user
    log_info "Granting database permissions to IAM user"

    # Generate a temporary password for postgres user
    local temp_password
    temp_password=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)

    if [[ "$DRY_RUN" != "true" ]]; then
        # Set postgres password
        gcloud sql users set-password postgres \
            --instance="$CLOUDSQL_INSTANCE_NAME" \
            --project="$GCP_PROJECT_ID" \
            --password="$temp_password" 2>/dev/null

        # Get instance IP
        local instance_ip
        instance_ip=$(gcloud sql instances describe "$CLOUDSQL_INSTANCE_NAME" \
            --project="$GCP_PROJECT_ID" \
            --format="value(ipAddresses[0].ipAddress)")

        # Grant permissions using psql (requires psql to be installed)
        if command -v psql &> /dev/null; then
            log_info "Granting schema permissions to $db_user"
            PGPASSWORD="$temp_password" psql "host=$instance_ip dbname=$DB_NAME user=postgres" -c \
                "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO \"$db_user\"; \
                 GRANT ALL ON SCHEMA public TO \"$db_user\"; \
                 GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$db_user\"; \
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO \"$db_user\";" \
                2>/dev/null || log_warn "Failed to grant permissions - you may need to do this manually"
        else
            log_warn "psql not installed - you'll need to grant database permissions manually:"
            log_warn "  GRANT ALL ON SCHEMA public TO \"$db_user\";"
        fi
    else
        echo "[DRY-RUN] Would grant database permissions to $db_user"
    fi

    log_success "Database setup complete"
}

#------------------------------------------------------------------------------
# Step 5: Create Secrets in Secret Manager
#------------------------------------------------------------------------------
setup_secrets() {
    if [[ "$SKIP_SECRETS" == "true" ]]; then
        log_info "Skipping secrets setup (--skip-secrets)"
        return
    fi

    log_step "Step 5: Setting up Secret Manager secrets"

    create_secret() {
        local name="$1"
        local value="$2"

        if [[ -z "$value" ]]; then
            log_warn "No value provided for secret: $name (skipping)"
            return
        fi

        if resource_exists secret "$name"; then
            log_info "Secret $name already exists, adding new version"
        else
            log_info "Creating secret: $name"
            run_cmd gcloud secrets create "$name" \
                --replication-policy="automatic" \
                --project="$GCP_PROJECT_ID"
        fi

        # Add secret version
        if [[ "$DRY_RUN" != "true" ]]; then
            echo -n "$value" | gcloud secrets versions add "$name" \
                --data-file=- \
                --project="$GCP_PROJECT_ID"
        else
            echo "[DRY-RUN] Would add version to secret: $name"
        fi
    }

    create_secret_from_file() {
        local name="$1"
        local file_path="$2"

        if [[ -z "$file_path" || ! -f "$file_path" ]]; then
            log_warn "No file provided for secret: $name (skipping)"
            return
        fi

        if resource_exists secret "$name"; then
            log_info "Secret $name already exists, adding new version"
        else
            log_info "Creating secret: $name"
            run_cmd gcloud secrets create "$name" \
                --replication-policy="automatic" \
                --project="$GCP_PROJECT_ID"
        fi

        # Add secret version from file
        if [[ "$DRY_RUN" != "true" ]]; then
            gcloud secrets versions add "$name" \
                --data-file="$file_path" \
                --project="$GCP_PROJECT_ID"
        else
            echo "[DRY-RUN] Would add version to secret: $name from file: $file_path"
        fi
    }

    # Create secrets
    create_secret "vibe-coding-anthropic-api-key" "$ANTHROPIC_API_KEY"
    create_secret "vibe-coding-openai-api-key" "$OPENAI_API_KEY"
    create_secret "reindeer-gitlab-api-token" "$GITLAB_TOKEN"
    create_secret "vibe-coding-linear-api-key" "$LINEAR_API_KEY"

    # GitHub App private key (from file)
    create_secret_from_file "github-app-private-key" "$GITHUB_APP_PRIVATE_KEY_FILE"

    log_success "Secrets setup complete"
}

#------------------------------------------------------------------------------
# Step 6: Setup Artifact Registry
#------------------------------------------------------------------------------
setup_artifact_registry() {
    log_step "Step 6: Setting up Artifact Registry"

    if resource_exists artifact-registry "$ARTIFACT_REGISTRY_REPO"; then
        log_info "Artifact Registry repo $ARTIFACT_REGISTRY_REPO already exists"
    else
        log_info "Creating Artifact Registry repository: $ARTIFACT_REGISTRY_REPO"
        run_cmd gcloud artifacts repositories create "$ARTIFACT_REGISTRY_REPO" \
            --repository-format=docker \
            --location="$GCP_REGION" \
            --description="Reindeer Coder container images" \
            --project="$GCP_PROJECT_ID"
    fi

    # Configure Docker authentication
    log_info "Configuring Docker authentication"
    run_cmd gcloud auth configure-docker "$GCP_REGION-docker.pkg.dev" --quiet

    log_success "Artifact Registry setup complete"
}

#------------------------------------------------------------------------------
# Step 7: Build and Push Docker Image (using Cloud Build)
#------------------------------------------------------------------------------
build_and_push() {
    if [[ "$SKIP_BUILD" == "true" ]]; then
        log_info "Skipping build (--skip-build)"
        return
    fi

    log_step "Step 7: Building and pushing Docker image (Cloud Build)"

    local image_tag="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REGISTRY_REPO/$SERVICE_NAME:latest"

    log_info "Building image with Cloud Build: $image_tag"

    # Cloud Build builds and pushes in one step
    run_cmd gcloud builds submit "$PROJECT_ROOT" \
        --project="$GCP_PROJECT_ID" \
        --region="$GCP_REGION" \
        --substitutions="_IMAGE_TAG=$image_tag,_VITE_AUTH0_DOMAIN=$AUTH0_DOMAIN,_VITE_AUTH0_CLIENT_ID=$AUTH0_CLIENT_ID,_VITE_AUTH0_AUDIENCE=$AUTH0_AUDIENCE,_VITE_AUTH0_ORG_ID=$AUTH0_ORG_ID" \
        --config="$PROJECT_ROOT/ci/config/cloudbuild.yaml"

    log_success "Image built and pushed via Cloud Build"
}

#------------------------------------------------------------------------------
# Step 8: Deploy to Cloud Run
#------------------------------------------------------------------------------
deploy_cloud_run() {
    log_step "Step 8: Deploying to Cloud Run"

    local image_tag="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REGISTRY_REPO/$SERVICE_NAME:latest"
    local cloud_run_sa="${CLOUD_RUN_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
    local vm_sa="${VM_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
    local cloudsql_connection="${GCP_PROJECT_ID}:${GCP_REGION}:${CLOUDSQL_INSTANCE_NAME}"
    local db_user="${CLOUD_RUN_SA_NAME}@${GCP_PROJECT_ID}.iam"

    # Get project number for secret paths
    local project_number
    if [[ "$DRY_RUN" != "true" ]]; then
        project_number=$(gcloud projects describe "$GCP_PROJECT_ID" --format="value(projectNumber)")
    else
        project_number="PROJECT_NUMBER"
    fi

    # Determine APP_URL
    local app_url="$APP_URL"
    if [[ -z "$app_url" ]]; then
        app_url="https://${SERVICE_NAME}-${project_number}.${GCP_REGION}.run.app"
    fi

    log_info "Deploying Cloud Run service: $SERVICE_NAME"

    run_cmd gcloud run deploy "$SERVICE_NAME" \
        --image="$image_tag" \
        --region="$GCP_REGION" \
        --project="$GCP_PROJECT_ID" \
        --service-account="$cloud_run_sa" \
        --memory="$CLOUD_RUN_MEMORY" \
        --cpu="$CLOUD_RUN_CPU" \
        --timeout="${CLOUD_RUN_TIMEOUT}s" \
        --max-instances="$CLOUD_RUN_MAX_INSTANCES" \
        --concurrency="$CLOUD_RUN_CONCURRENCY" \
        --add-cloudsql-instances="$cloudsql_connection" \
        --allow-unauthenticated \
        --set-env-vars="NODE_ENV=production" \
        --set-env-vars="APP_URL=$app_url" \
        --set-env-vars="DB_TYPE=postgres" \
        --set-env-vars="DATABASE_URL=/cloudsql/$cloudsql_connection" \
        --set-env-vars="DB_NAME=$DB_NAME" \
        --set-env-vars="DB_USER=$db_user" \
        --set-env-vars="AUTH0_DOMAIN=$AUTH0_DOMAIN" \
        --set-env-vars="AUTH0_CLIENT_ID=$AUTH0_CLIENT_ID" \
        --set-env-vars="AUTH0_AUDIENCE=$AUTH0_AUDIENCE" \
        --set-env-vars="AUTH0_ORG_ID=$AUTH0_ORG_ID" \
        --set-env-vars="GCP_PROJECT_ID=$GCP_PROJECT_ID" \
        --set-env-vars="GCP_ZONE=$GCP_ZONE" \
        --set-env-vars="GCP_NETWORK=$GCP_NETWORK" \
        --set-env-vars="GCP_VM_SERVICE_ACCOUNT=$vm_sa" \
        --set-env-vars="VM_IMAGE_FAMILY=$VM_IMAGE_FAMILY" \
        --set-env-vars="VM_IMAGE_PROJECT=$VM_IMAGE_PROJECT" \
        --set-env-vars="VM_MACHINE_TYPE=$VM_MACHINE_TYPE" \
        --set-env-vars="VM_USER=$VM_USER" \
        --set-env-vars="GIT_BASE_URL=$GIT_BASE_URL" \
        --set-env-vars="GIT_ORG=$GIT_ORG" \
        --set-env-vars="GIT_USER=$GIT_USER" \
        --set-env-vars="GITLAB_API_URL=$GITLAB_API_URL" \
        --set-env-vars="EMAIL_DOMAIN=$EMAIL_DOMAIN" \
        --set-env-vars="GITHUB_APP_ID=$GITHUB_APP_ID" \
        --set-env-vars="GITHUB_INSTALLATION_ID=$GITHUB_INSTALLATION_ID" \
        --set-env-vars="GITHUB_APP_PRIVATE_KEY_SECRET=projects/$project_number/secrets/github-app-private-key/versions/latest" \
        --set-env-vars="ANTHROPIC_API_KEY_SECRET=projects/$project_number/secrets/vibe-coding-anthropic-api-key/versions/latest" \
        --set-env-vars="OPENAI_API_KEY_SECRET=projects/$project_number/secrets/vibe-coding-openai-api-key/versions/latest" \
        --set-env-vars="GITLAB_TOKEN_SECRET=projects/$project_number/secrets/reindeer-gitlab-api-token/versions/latest" \
        --set-env-vars="LINEAR_API_KEY_SECRET=projects/$project_number/secrets/vibe-coding-linear-api-key/versions/latest" \
        --set-env-vars="SECRET_IMPERSONATE_SA=$cloud_run_sa"

    # Get the service URL
    if [[ "$DRY_RUN" != "true" ]]; then
        local service_url
        service_url=$(gcloud run services describe "$SERVICE_NAME" \
            --region="$GCP_REGION" \
            --project="$GCP_PROJECT_ID" \
            --format="value(status.url)")
        log_success "Cloud Run service deployed at: $service_url"
    fi

    log_success "Cloud Run deployment complete"
}

#------------------------------------------------------------------------------
# Step 9: Run Database Migrations
#------------------------------------------------------------------------------
run_migrations() {
    log_step "Step 9: Running database migrations"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[DRY-RUN] Would run database migrations"
        return
    fi

    # Get Cloud Run service URL
    local service_url
    service_url=$(gcloud run services describe "$SERVICE_NAME" \
        --region="$GCP_REGION" \
        --project="$GCP_PROJECT_ID" \
        --format="value(status.url)")

    log_info "Database migrations will run automatically on first request"
    log_info "Testing service health..."

    # Make a health check request (this will trigger migrations)
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "$service_url" || echo "000")

    if [[ "$http_code" == "200" || "$http_code" == "302" ]]; then
        log_success "Service is healthy (HTTP $http_code)"
    else
        log_warn "Service returned HTTP $http_code - check logs for details"
    fi

    log_success "Migrations complete"
}

#------------------------------------------------------------------------------
# Step 10: Setup Firewall Rules for IAP SSH
#------------------------------------------------------------------------------
setup_firewall() {
    log_step "Step 10: Setting up firewall rules for IAP SSH"

    local rule_name="allow-iap-ssh"

    if gcloud compute firewall-rules describe "$rule_name" --project="$GCP_PROJECT_ID" &>/dev/null; then
        log_info "Firewall rule $rule_name already exists"
    else
        log_info "Creating firewall rule for IAP SSH access"
        run_cmd gcloud compute firewall-rules create "$rule_name" \
            --direction=INGRESS \
            --priority=1000 \
            --network="$GCP_NETWORK" \
            --action=ALLOW \
            --rules=tcp:22 \
            --source-ranges=35.235.240.0/20 \
            --target-tags=iap-ssh \
            --project="$GCP_PROJECT_ID"
    fi

    log_success "Firewall rules configured"
}

#------------------------------------------------------------------------------
# Print Summary
#------------------------------------------------------------------------------
print_summary() {
    log_step "Deployment Summary"

    local cloud_run_sa="${CLOUD_RUN_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
    local vm_sa="${VM_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
    local cloudsql_connection="${GCP_PROJECT_ID}:${GCP_REGION}:${CLOUDSQL_INSTANCE_NAME}"

    if [[ "$DRY_RUN" != "true" ]]; then
        local service_url
        service_url=$(gcloud run services describe "$SERVICE_NAME" \
            --region="$GCP_REGION" \
            --project="$GCP_PROJECT_ID" \
            --format="value(status.url)" 2>/dev/null || echo "Not deployed")

        cat << EOF

${GREEN}=== Deployment Complete ===${NC}

${BLUE}GCP Project:${NC}        $GCP_PROJECT_ID
${BLUE}Region:${NC}             $GCP_REGION
${BLUE}Cloud Run URL:${NC}      $service_url

${BLUE}Service Accounts:${NC}
  - Cloud Run:      $cloud_run_sa
  - VM:             $vm_sa

${BLUE}Database:${NC}
  - Instance:       $CLOUDSQL_INSTANCE_NAME
  - Database:       $DB_NAME
  - Connection:     $cloudsql_connection

${BLUE}Secrets Created:${NC}
  - vibe-coding-anthropic-api-key
  - vibe-coding-openai-api-key
  - reindeer-gitlab-api-token
  - vibe-coding-linear-api-key

${YELLOW}Next Steps:${NC}
1. Configure Auth0 Allowed Callback URLs: $service_url
2. Configure Auth0 Allowed Logout URLs: $service_url
3. Configure Auth0 Allowed Web Origins: $service_url
4. Set up Linear webhook (optional)
5. Set up GitHub/GitLab webhook for PR/MR reviews (optional)

${BLUE}Useful Commands:${NC}
  # View logs
  gcloud run services logs read $SERVICE_NAME --region=$GCP_REGION --project=$GCP_PROJECT_ID

  # Update deployment
  ./scripts/deploy.sh --skip-db --skip-secrets

  # Destroy everything
  ./scripts/deploy.sh --destroy

EOF
    fi
}

#------------------------------------------------------------------------------
# Destroy Resources
#------------------------------------------------------------------------------
destroy_resources() {
    log_step "DESTROYING ALL RESOURCES"

    log_warn "This will delete:"
    log_warn "  - Cloud Run service: $SERVICE_NAME"
    log_warn "  - Cloud SQL instance: $CLOUDSQL_INSTANCE_NAME (and all data!)"
    log_warn "  - Service accounts: $CLOUD_RUN_SA_NAME, $VM_SA_NAME"
    log_warn "  - Secrets in Secret Manager"
    log_warn "  - Artifact Registry repository: $ARTIFACT_REGISTRY_REPO"

    echo ""
    read -rp "Are you ABSOLUTELY sure? Type 'yes-destroy-everything' to confirm: " confirm

    if [[ "$confirm" != "yes-destroy-everything" ]]; then
        log_info "Destruction cancelled"
        exit 0
    fi

    # Delete Cloud Run service
    log_info "Deleting Cloud Run service..."
    gcloud run services delete "$SERVICE_NAME" \
        --region="$GCP_REGION" \
        --project="$GCP_PROJECT_ID" \
        --quiet 2>/dev/null || log_warn "Cloud Run service not found"

    # Delete Cloud SQL instance
    log_info "Deleting Cloud SQL instance..."
    gcloud sql instances delete "$CLOUDSQL_INSTANCE_NAME" \
        --project="$GCP_PROJECT_ID" \
        --quiet 2>/dev/null || log_warn "Cloud SQL instance not found"

    # Delete secrets
    log_info "Deleting secrets..."
    for secret in vibe-coding-anthropic-api-key vibe-coding-openai-api-key reindeer-gitlab-api-token vibe-coding-linear-api-key; do
        gcloud secrets delete "$secret" \
            --project="$GCP_PROJECT_ID" \
            --quiet 2>/dev/null || true
    done

    # Delete service accounts
    log_info "Deleting service accounts..."
    gcloud iam service-accounts delete "${CLOUD_RUN_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
        --project="$GCP_PROJECT_ID" \
        --quiet 2>/dev/null || log_warn "Service account not found"
    gcloud iam service-accounts delete "${VM_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
        --project="$GCP_PROJECT_ID" \
        --quiet 2>/dev/null || log_warn "Service account not found"

    # Delete Artifact Registry
    log_info "Deleting Artifact Registry repository..."
    gcloud artifacts repositories delete "$ARTIFACT_REGISTRY_REPO" \
        --location="$GCP_REGION" \
        --project="$GCP_PROJECT_ID" \
        --quiet 2>/dev/null || log_warn "Repository not found"

    log_success "All resources destroyed"
}

#------------------------------------------------------------------------------
# Main
#------------------------------------------------------------------------------
main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║         Reindeer Coder - Auto Deployment Script           ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""

    parse_args "$@"
    load_config

    # Handle --status mode
    if [[ "$STATUS_MODE" == "true" ]]; then
        if [[ -z "$GCP_PROJECT_ID" ]]; then
            log_error "GCP_PROJECT_ID is required for status check"
            log_info "Use: ./scripts/deploy.sh --status -c your-config-file"
            exit 1
        fi
        show_status
        exit 0
    fi

    # If no config file and not explicitly interactive, ask if they want interactive mode
    if [[ ! -f "$CONFIG_FILE" && "$INTERACTIVE_MODE" != "true" && "$DESTROY_MODE" != "true" ]]; then
        log_warn "No configuration file found at: $CONFIG_FILE"
        echo ""
        read -rp "Would you like to run in interactive mode? [Y/n]: " use_interactive
        if [[ ! "$use_interactive" =~ ^[Nn] ]]; then
            INTERACTIVE_MODE="true"
        else
            log_info "Please create a config file:"
            log_info "  cp scripts/deploy.config.example scripts/deploy.config"
            log_info "  # Edit the file with your values"
            log_info "  ./scripts/deploy.sh"
            exit 1
        fi
    fi

    # Run interactive configuration if requested
    if [[ "$INTERACTIVE_MODE" == "true" ]]; then
        interactive_config
    fi

    if [[ "$DESTROY_MODE" == "true" ]]; then
        validate_config
        destroy_resources
        exit 0
    fi

    validate_config

    if [[ "$DRY_RUN" == "true" ]]; then
        log_warn "DRY RUN MODE - No changes will be made"
    fi

    if [[ "$FROM_STEP" -gt 1 ]]; then
        log_info "Resuming from step $FROM_STEP"
    fi

    # Run deployment steps based on FROM_STEP
    [[ "$FROM_STEP" -le 1 ]] && setup_project
    [[ "$FROM_STEP" -le 2 ]] && enable_apis
    [[ "$FROM_STEP" -le 3 ]] && setup_iam
    [[ "$FROM_STEP" -le 4 ]] && setup_database
    [[ "$FROM_STEP" -le 5 ]] && setup_secrets
    [[ "$FROM_STEP" -le 6 ]] && setup_artifact_registry
    [[ "$FROM_STEP" -le 7 ]] && setup_firewall
    [[ "$FROM_STEP" -le 8 ]] && build_and_push
    [[ "$FROM_STEP" -le 9 ]] && deploy_cloud_run
    [[ "$FROM_STEP" -le 10 ]] && run_migrations

    print_summary

    log_success "Deployment complete!"
}

main "$@"
