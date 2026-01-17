#!/bin/bash
# Setup script for vibe-coding service account
# Fill in these variables based on your setup

# Configuration - UPDATE THESE
PROJECT_ID="reindeer-vibe"
CLOUDSQL_INSTANCE="reindeer-vibe:us-central1:reindeer-apps"  # format: project:region:instance
DB_NAME="vibe_coding"
REGION="us-central1"

# Service account details
SA_NAME="reindeer-coder"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
COMPUTE_SA="527751278708-compute@developer.gserviceaccount.com"

echo "=================================================="
echo "Vibe Coding Service Account Setup"
echo "=================================================="
echo "Project: $PROJECT_ID"
echo "Service Account: $SA_EMAIL"
echo "CloudSQL Instance: $CLOUDSQL_INSTANCE"
echo "Database: $DB_NAME"
echo "=================================================="

# Step 1: Create service account
echo ""
echo "[1/6] Creating service account..."
gcloud iam service-accounts create $SA_NAME \
  --display-name="Vibe Coding Agent" \
  --description="Service account for vibe-coding application with CloudSQL access" \
  --project=$PROJECT_ID

# Step 2: Grant Cloud SQL Client role
echo ""
echo "[2/6] Granting Cloud SQL Client role..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudsql.client"

# Step 3: Allow compute SA to impersonate vibe-coding SA
echo ""
echo "[3/6] Granting impersonation permission..."
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:$COMPUTE_SA" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=$PROJECT_ID

# Step 4: Create database (if needed)
echo ""
echo "[4/6] Creating database (this may fail if it already exists)..."
INSTANCE_NAME=$(echo $CLOUDSQL_INSTANCE | cut -d: -f3)
gcloud sql databases create $DB_NAME \
  --instance=$INSTANCE_NAME \
  --project=$PROJECT_ID 2>/dev/null || echo "Database may already exist"

# Step 5: Create IAM database user
echo ""
echo "[5/6] Creating IAM database user..."
gcloud sql users create $SA_EMAIL \
  --instance=$INSTANCE_NAME \
  --type=CLOUD_IAM_SERVICE_ACCOUNT \
  --project=$PROJECT_ID 2>/dev/null || echo "IAM user may already exist"

# Step 6: Grant database permissions
echo ""
echo "[6/6] Granting database permissions..."
echo "Starting Cloud SQL Proxy to grant permissions..."

# Start proxy
./cloudsql_proxy/cloud-sql-proxy-v2 \
  --impersonate-service-account=$SA_EMAIL \
  --unix-socket=/tmp/ \
  --auto-iam-authn \
  $CLOUDSQL_INSTANCE &

PROXY_PID=$!
sleep 5

# Grant permissions
psql -h /tmp/$CLOUDSQL_INSTANCE -U $SA_EMAIL -d $DB_NAME <<EOF
-- Grant all privileges
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO "$SA_EMAIL";
GRANT ALL PRIVILEGES ON SCHEMA public TO "$SA_EMAIL";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "$SA_EMAIL";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "$SA_EMAIL";

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "$SA_EMAIL";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "$SA_EMAIL";

SELECT 'Database permissions granted successfully!' as status;
EOF

# Kill proxy
kill $PROXY_PID 2>/dev/null

echo ""
echo "=================================================="
echo "Setup Complete!"
echo "=================================================="
echo ""
echo "Add these to your .env file:"
echo ""
echo "DB_TYPE=postgres"
echo "DATABASE_URL=/cloudsql/$CLOUDSQL_INSTANCE"
echo "DB_NAME=$DB_NAME"
echo "DB_USER=$SA_EMAIL"
echo "IMPERSONATE_SERVICE_ACCOUNT=$SA_EMAIL"
echo ""
echo "To run migrations:"
echo "  cd /home/reindeer-vibe/workspace/vibe-coding"
echo "  npm run db:migrate:postgres"
echo ""
