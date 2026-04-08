# vibe

Command-line interface for [reindeer-coder](../README.md) — manage your remote dev environments from the terminal.

## Install

From the repo root:

```bash
npm install
npm run --workspace=cli build
npm link --workspace=cli
```

`vibe` is now on your `$PATH`.

## First-time setup

Point at your reindeer-coder instance and authenticate:

```bash
vibe login --server https://your-reindeer-coder.example.com
```

The server URL is saved to `~/.config/vibe/config.json` so subsequent commands don't need it.

## Commands

```
vibe login [--server <url>]              Authenticate against reindeer-coder
vibe env list                            List your environments
vibe env create --spec <name> --name <name>
                                         Provision a new environment from a spec
vibe env connect <env-id>                SSH into the environment's devcontainer
vibe env delete <env-id> [-y]            Delete an environment
```

## Configuration

Two files under `~/.config/vibe/`:

- `config.json` — server URL (safe to commit to dotfiles)
- `token.json` — OAuth tokens (mode 0600, never commit)

Override the server URL ad-hoc:

```bash
vibe --server https://other-instance.example.com env list
# or
VIBE_SERVER=https://other-instance.example.com vibe env list
```

## Requirements

- Node 20+
- `gcloud` CLI installed and authenticated (used for IAP-tunneled SSH into env VMs)

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success |
| 2    | Usage error |
| 3    | Network/server unreachable |
| 4    | Auth missing or expired |
| 5    | gcloud / IAP error |
| 6    | Environment failed to reach ready state |
| 7    | Resource not found |
