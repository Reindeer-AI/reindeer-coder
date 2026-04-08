import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CliError } from './util.js';
import { resolveServer } from './config.js';

describe('resolveServer precedence', () => {
	let tempHome: string;
	let originalXdg: string | undefined;
	let originalVibeServer: string | undefined;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), 'vibe-cfg-test-'));
		originalXdg = process.env.XDG_CONFIG_HOME;
		originalVibeServer = process.env.VIBE_SERVER;
		process.env.XDG_CONFIG_HOME = tempHome;
		delete process.env.VIBE_SERVER;
	});

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
		if (originalVibeServer === undefined) {
			delete process.env.VIBE_SERVER;
		} else {
			process.env.VIBE_SERVER = originalVibeServer;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it('errors when nothing is configured', () => {
		assert.throws(
			() => resolveServer(),
			(err: unknown) => err instanceof CliError && err.code === 2,
		);
	});

	it('uses the override flag when passed', () => {
		assert.equal(resolveServer('https://a.example.com'), 'https://a.example.com');
	});

	it('strips trailing slashes from the override', () => {
		assert.equal(resolveServer('https://a.example.com///'), 'https://a.example.com');
	});

	it('falls back to $VIBE_SERVER', () => {
		process.env.VIBE_SERVER = 'https://env.example.com';
		assert.equal(resolveServer(), 'https://env.example.com');
	});

	it('falls back to config file', () => {
		mkdirSync(join(tempHome, 'vibe'), { recursive: true });
		writeFileSync(
			join(tempHome, 'vibe', 'config.json'),
			JSON.stringify({ server: 'https://cfg.example.com' }),
		);
		assert.equal(resolveServer(), 'https://cfg.example.com');
	});

	it('override beats $VIBE_SERVER', () => {
		process.env.VIBE_SERVER = 'https://env.example.com';
		assert.equal(resolveServer('https://override.example.com'), 'https://override.example.com');
	});

	it('$VIBE_SERVER beats config file', () => {
		process.env.VIBE_SERVER = 'https://env.example.com';
		mkdirSync(join(tempHome, 'vibe'), { recursive: true });
		writeFileSync(
			join(tempHome, 'vibe', 'config.json'),
			JSON.stringify({ server: 'https://cfg.example.com' }),
		);
		assert.equal(resolveServer(), 'https://env.example.com');
	});
});
