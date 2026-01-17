# Agent Guide: Contributing to Reindeer Coder

This guide documents best practices for AI agents working in this repository.

## Project Structure

```
reindeer-coder/
├── app/                    # SvelteKit web application
│   ├── src/
│   │   ├── lib/server/     # Server-side code (db, vm, gitlab)
│   │   ├── lib/components/ # Svelte components
│   │   └── routes/         # API endpoints and pages
├── vscode-extension/       # VSCode extension
│   └── src/
├── package.json            # Bun workspace root
├── biome.json              # Linting/formatting config
└── .pre-commit-config.yaml # Git hooks config
```

## Development Workflow

### Setup

```bash
# Install dependencies
bun install

# Install pre-commit hooks
pre-commit install

# Start development server
bun run dev
```

### Before Committing

```bash
# Run linting (auto-fixes issues)
bun run lint:fix

# Type check the app
cd app && bunx svelte-kit sync && bunx svelte-check

# Run all pre-commit hooks manually
pre-commit run --all-files
```

## Coding Standards

### Use Bun, Not npm/yarn

```bash
# ✅ Correct
bun add axios
bun install

# ❌ Wrong - creates wrong lockfile
npm install axios
yarn add axios
```

### Biome Linting

Fix issues, don't disable warnings:

```typescript
// ❌ Wrong - bypasses safety checks
// biome-ignore lint/suspicious/noExplicitAny: lazy fix
const data = response as any;

// ✅ Correct - proper typing
interface ApiResponse {
  status: string;
  data: TaskData;
}
const data = response as ApiResponse;
```

### SvelteKit Environment Variables

```typescript
// ❌ Wrong - static vars must exist at build time
import { SECRET_KEY } from '$env/static/private';

// ✅ Correct - dynamic vars loaded at runtime
import { env } from '$env/dynamic/private';
const secretKey = env.SECRET_KEY;

// Always null-check dynamic env vars
if (!env.SECRET_KEY) {
  throw new Error('SECRET_KEY not configured');
}
```

## Database Support

The app supports both SQLite and PostgreSQL:

```typescript
// Set via environment variable
DB_TYPE=sqlite   // Local development
DB_TYPE=postgres // Production
```

Database adapters are in `app/src/lib/server/db/`:
- `sqlite-adapter.ts` - SQLite implementation
- `postgres-adapter.ts` - PostgreSQL implementation
- `adapter.ts` - Common interface

## Key Components

### VM Orchestration (`app/src/lib/server/vm/`)

- `orchestrator.ts` - Main VM lifecycle management
- `gcp.ts` - GCP Compute Engine API
- `ssh.ts` - SSH connection handling
- `gcloud.ts` - gcloud CLI wrapper

### Linear Integration (`app/src/lib/server/tasks/`)

- `linear-agent-monitor.ts` - Monitors Linear for agent-labeled issues
- `terminal-analyzer.ts` - Analyzes terminal output
- `code-review-handler.ts` - Handles GitLab MR reviews

### VSCode Extension (`vscode-extension/src/`)

- `extension.ts` - Extension entry point
- `api/vibe-client.ts` - API client for web app
- `connection/terminal-manager.ts` - Terminal handling
- `connection/sshfs-manager.ts` - Remote filesystem

## Commit Message Format

```
type(scope): Brief description

- Bullet point of change
- Another change

Co-Authored-By: Claude <model> <noreply@anthropic.com>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`

Example:
```
feat(app): Add task filtering by status

- Add status filter dropdown to task list
- Update API to support status query param
- Add tests for filtering logic

Co-Authored-By: Claude Sonnet 4 <noreply@anthropic.com>
```

## Common Pitfalls

### 1. Wrong Package Manager

**Symptom:** `package-lock.json` appears in git status

**Fix:**
```bash
rm package-lock.json yarn.lock
bun install
```

### 2. Static vs Dynamic Env Vars

**Symptom:** Build fails with "VAR_NAME is not exported"

**Fix:** Use `$env/dynamic/private` for runtime secrets

### 3. Forgetting to Sync SvelteKit

**Symptom:** Type errors about missing routes or imports

**Fix:**
```bash
cd app && bunx svelte-kit sync
```

### 4. Modifying Wrong Files

**Symptom:** Unrelated code changes in your branch

**Fix:**
```bash
# Check what changed
git diff origin/main...HEAD --name-only

# Reset if needed
git checkout origin/main -- path/to/wrong/file
```

## Useful Commands

```bash
# Development
bun run dev              # Start web app
bun run dev:ext          # Watch VSCode extension

# Building
bun run build            # Build web app
bun run build:ext        # Build VSCode extension

# Linting
bun run lint             # Check for issues
bun run lint:fix         # Auto-fix issues

# Type checking
bun run check            # Run svelte-check

# Pre-commit
pre-commit run --all-files    # Run all hooks
pre-commit run biome-check    # Run specific hook

# Git
git diff origin/main...HEAD --name-only  # Changed files
```

## Success Checklist

Before requesting review:

- [ ] No `package-lock.json` or `yarn.lock` added
- [ ] Pre-commit hooks pass locally
- [ ] Type errors fixed (not bypassed with `any`)
- [ ] Environment variables use dynamic imports for secrets
- [ ] Commit messages follow format

---

**Maintainer:** Reindeer AI Team
