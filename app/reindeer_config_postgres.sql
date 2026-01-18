-- ============================================================================
-- PostgreSQL Version
-- ============================================================================

-- Create config table (if not exists)
CREATE TABLE IF NOT EXISTS config (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	description TEXT,
	is_secret BOOLEAN NOT NULL DEFAULT FALSE,
	category TEXT,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Insert/Update Reindeer-specific configuration
-- Use ON CONFLICT to update if exists, insert if not

-- Repositories Configuration
INSERT INTO config (key, value, description, is_secret, category)
VALUES ('repositories.list', '[{"id":"experimental","name":"reindeerai/experimental","url":"https://gitlab.com/reindeerai/experimental.git","baseBranch":"main","allowManual":true},{"id":"workflows","name":"reindeerai/workflows","url":"https://gitlab.com/reindeerai/workflows.git","baseBranch":"dev","allowManual":true},{"id":"app","name":"reindeerai/app","url":"https://gitlab.com/reindeerai/app.git","baseBranch":"staging","allowManual":true},{"id":"reindeer-ts","name":"reindeerai/reindeer-ts","url":"https://gitlab.com/reindeerai/reindeer-ts.git","baseBranch":"dev","allowManual":true},{"id":"cloud-infrastructure","name":"reindeerai/cloud-infrastructure","url":"https://gitlab.com/reindeerai/cloud-infrastructure.git","baseBranch":"main","allowManual":false}]', 'List of pre-configured repositories', FALSE, 'Repositories')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- UI Configuration (Reindeer branding)
INSERT INTO config (key, value, description, is_secret, category)
VALUES ('ui.brand_name', 'Reindeer Code', 'Application brand name shown in the UI', FALSE, 'UI')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('ui.logo_path', '/reindeer-logo-bot.png', 'Path to the application logo', FALSE, 'UI')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('ui.primary_color', '#004238', 'Primary brand color (hex)', FALSE, 'UI')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('ui.primary_color_dark', '#003329', 'Dark variant of primary brand color', FALSE, 'UI')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('ui.primary_color_light', '#00594d', 'Light variant of primary brand color', FALSE, 'UI')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('ui.background_color', '#f5f3ef', 'Background color (hex)', FALSE, 'UI')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- Git Configuration (Reindeer-specific)
INSERT INTO config (key, value, description, is_secret, category)
VALUES ('git.base_url', 'https://gitlab.com', 'Git repository base URL', FALSE, 'Git')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('git.org', 'reindeerai', 'Git organization/group name', FALSE, 'Git')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('git.user', 'oauth2', 'Git user for authentication', FALSE, 'Git')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('git.default_base_branch', 'main', 'Default base branch for new tasks', FALSE, 'Git')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('git.branch_prefix', 'vibe-coding', 'Prefix for generated branch names', FALSE, 'Git')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- VM Configuration
INSERT INTO config (key, value, description, is_secret, category)
VALUES ('vm.user', 'reindeer-vibe', 'VM user account name', FALSE, 'VM')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('vm.machine_type', 'e2-standard-4', 'GCP VM machine type', FALSE, 'VM')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('vm.image_family', 'ubuntu-2204-lts', 'VM image family', FALSE, 'VM')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('vm.image_project', 'ubuntu-os-cloud', 'VM image project', FALSE, 'VM')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- Agent Configuration
INSERT INTO config (key, value, description, is_secret, category)
VALUES ('agent.default_cli', 'claude-code', 'Default coding CLI (claude-code, gemini, codex)', FALSE, 'Agent')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('agent.default_system_prompt', 'IMPORTANT INSTRUCTIONS:
1. If the task description already contains an implementation plan, do NOT plan again. Use the existing plan and proceed directly to implementation.
2. If you need to create a plan, do NOT ask the user to approve it. Create the plan and immediately begin implementation.
3. Make best-effort decisions independently. Only ask for human input if absolutely critical (e.g., security implications, data loss risk, or when multiple approaches have significant trade-offs).
4. When you complete the implementation, ALWAYS create a merge request with your changes. Do not wait for the user to request this.
5. Be autonomous and proactive in your implementation approach.
6. If there is a run_local.py or run_local.ts script in the repository, use it to run the service locally - this is the preferred method as it handles environment setup automatically.
7. If no run_local script exists and you are building a web application (node / Svelte), run the server locally in development mode. There should be a background task with the web server running on http://localhost:5173
8. Environment setup: If there''s a .env.example file, create .env from it (cp .env.example .env) and ask the user if any additional environment variables need to be configured', 'Default system prompt for agents', FALSE, 'Agent')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- Authentication Configuration
INSERT INTO config (key, value, description, is_secret, category)
VALUES ('auth.admin_permission', 'reindeer.admin', 'Permission string for admin users', FALSE, 'Authentication')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- Email Configuration
INSERT INTO config (key, value, description, is_secret, category)
VALUES ('email.domain', 'reindeer.ai', 'Email domain for generated email addresses', FALSE, 'Email')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

INSERT INTO config (key, value, description, is_secret, category)
VALUES ('email.fallback_address', 'agent@reindeer.ai', 'Fallback email address for automated actions', FALSE, 'Email')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

-- Verify the configuration
SELECT category, key, value, is_secret FROM config ORDER BY category, key;
