import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, ExitCode } from './util.js';

/**
 * Persistent CLI config stored at ~/.config/vibe/config.json.
 *
 * Safe to commit to dotfile repos — contains no secrets. The OAuth tokens
 * live separately in token.json (mode 0600).
 */
export interface VibeConfig {
	server?: string;
}

export function configDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	return xdg ? join(xdg, 'vibe') : join(homedir(), '.config', 'vibe');
}

export function configPath(): string {
	return join(configDir(), 'config.json');
}

export function tokenPath(): string {
	return join(configDir(), 'token.json');
}

export function readConfig(): VibeConfig {
	try {
		const raw = readFileSync(configPath(), 'utf8');
		return JSON.parse(raw) as VibeConfig;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return {};
		}
		throw err;
	}
}

export function writeConfig(cfg: VibeConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/**
 * Resolve the reindeer-coder server URL from the precedence chain:
 * explicit override → $VIBE_SERVER → config file → error.
 */
export function resolveServer(override?: string): string {
	const candidate = override ?? process.env.VIBE_SERVER ?? readConfig().server;
	if (!candidate) {
		throw new CliError(
			'No reindeer-coder server configured.\n' +
				'Run: vibe login --server https://your-instance.example.com',
			ExitCode.USAGE,
		);
	}
	return candidate.replace(/\/+$/, '');
}
