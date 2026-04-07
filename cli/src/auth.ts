import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { URL } from 'node:url';
import open from 'open';
import type { ExtensionConfig } from './api.js';
import { tokenPath } from './config.js';
import { CliError, ExitCode, log } from './util.js';

/**
 * Persisted token bundle stored at ~/.config/vibe/token.json (mode 0600).
 *
 * The server URL is duplicated here so we can detect if the user has pointed
 * the CLI at a different reindeer-coder instance and invalidate the stale token.
 */
export interface TokenBundle {
	server: string;
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	sub?: string;
	email?: string;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
}

const CALLBACK_PORT = 54321;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ── Token store ────────────────────────────────────────────────

export function readToken(): TokenBundle | null {
	try {
		const raw = readFileSync(tokenPath(), 'utf8');
		return JSON.parse(raw) as TokenBundle;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
}

export function writeToken(bundle: TokenBundle): void {
	const path = tokenPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
	chmodSync(path, 0o600);
}

export function clearToken(): void {
	try {
		unlinkSync(tokenPath());
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
}

/**
 * Get a valid access token, refreshing it transparently if it's about to expire.
 * Returns null if there's no token at all (caller should prompt for login).
 */
export async function getValidAccessToken(server: string): Promise<string | null> {
	const bundle = readToken();
	if (!bundle) {
		return null;
	}
	if (bundle.server !== server) {
		// Stale token from a different deployment.
		return null;
	}

	// Refresh if expired or expiring within 5 minutes.
	const fiveMinutes = 5 * 60 * 1000;
	if (Date.now() >= bundle.expiresAt - fiveMinutes && bundle.refreshToken) {
		try {
			const refreshed = await refreshAccessToken(server, bundle);
			writeToken(refreshed);
			return refreshed.accessToken;
		} catch (err) {
			log(`warning: token refresh failed (${(err as Error).message}); will require re-login`);
			return null;
		}
	}

	return bundle.accessToken;
}

// ── PKCE flow ──────────────────────────────────────────────────

function generatePkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

function buildAuthorizeUrl(
	cfg: ExtensionConfig,
	challenge: string,
	state: string,
): string {
	const url = new URL(`https://${cfg.auth0.domain}/authorize`);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', cfg.auth0.clientId);
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('scope', 'openid profile email offline_access');
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	url.searchParams.set('audience', cfg.auth0.audience);
	if (cfg.auth0.organizationId) {
		url.searchParams.set('organization', cfg.auth0.organizationId);
	}
	return url.toString();
}

/**
 * Listen on localhost:54321 for the Auth0 redirect, return the authorization code.
 */
function captureAuthCode(state: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			if (!req.url) {
				return;
			}
			const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
			if (url.pathname !== '/callback') {
				res.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get('code');
			const returnedState = url.searchParams.get('state');
			const errParam = url.searchParams.get('error');

			if (errParam) {
				res.writeHead(400, { 'Content-Type': 'text/html' });
				res.end(`<html><body><h1>Login failed</h1><p>${errParam}</p></body></html>`);
				server.close();
				reject(new Error(`Auth0 returned error: ${errParam}`));
				return;
			}
			if (returnedState !== state || !code) {
				res.writeHead(400, { 'Content-Type': 'text/html' });
				res.end('<html><body><h1>Login failed</h1><p>Invalid state or missing code.</p></body></html>');
				server.close();
				reject(new Error('invalid state or missing code'));
				return;
			}

			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(
				'<html><body><h1>Login successful</h1><p>You can close this window and return to the terminal.</p></body></html>',
			);
			server.close();
			resolve(code);
		});

		server.on('error', (err) => {
			reject(new Error(`callback server failed: ${err.message}`));
		});

		server.listen(CALLBACK_PORT, () => {
			// listening — caller will open the browser
		});

		setTimeout(() => {
			server.close();
			reject(new Error('login timed out after 5 minutes'));
		}, LOGIN_TIMEOUT_MS);
	});
}

async function exchangeCodeForToken(
	cfg: ExtensionConfig,
	code: string,
	verifier: string,
): Promise<TokenResponse> {
	const response = await fetch(`https://${cfg.auth0.domain}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'authorization_code',
			client_id: cfg.auth0.clientId,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
			audience: cfg.auth0.audience,
		}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`token exchange failed: ${response.status} ${text}`);
	}
	return (await response.json()) as TokenResponse;
}

async function refreshAccessToken(server: string, current: TokenBundle): Promise<TokenBundle> {
	// We need the Auth0 config to refresh — fetch it from the server again.
	const cfgResponse = await fetch(`${server}/api/extension-config`);
	if (!cfgResponse.ok) {
		throw new Error(`failed to fetch extension config: ${cfgResponse.status}`);
	}
	const cfg = (await cfgResponse.json()) as ExtensionConfig;

	const response = await fetch(`https://${cfg.auth0.domain}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'refresh_token',
			client_id: cfg.auth0.clientId,
			refresh_token: current.refreshToken,
		}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`refresh failed: ${response.status} ${text}`);
	}
	const data = (await response.json()) as TokenResponse;
	return {
		...current,
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? current.refreshToken,
		expiresAt: Date.now() + data.expires_in * 1000,
	};
}

interface JwtPayload {
	sub?: string;
	email?: string;
	[claim: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return {};
	}
	try {
		return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString()) as JwtPayload;
	} catch {
		return {};
	}
}

/**
 * Run the full Auth0 PKCE flow against the given reindeer-coder server and
 * persist the resulting tokens. Returns the user's email if available.
 */
export async function login(server: string): Promise<TokenBundle> {
	// Bootstrap the Auth0 config from the server's public extension-config endpoint.
	let cfg: ExtensionConfig;
	try {
		const response = await fetch(`${server}/api/extension-config`);
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`);
		}
		cfg = (await response.json()) as ExtensionConfig;
	} catch (err) {
		throw new CliError(
			`Cannot fetch Auth0 config from ${server}/api/extension-config: ${(err as Error).message}`,
			ExitCode.NETWORK,
		);
	}

	const { verifier, challenge } = generatePkce();
	const state = randomBytes(16).toString('hex');
	const authUrl = buildAuthorizeUrl(cfg, challenge, state);

	const codePromise = captureAuthCode(state);

	log('Opening browser for authentication...');
	try {
		await open(authUrl);
	} catch {
		log(`Could not open browser automatically. Open this URL manually:\n  ${authUrl}`);
	}

	let code: string;
	try {
		code = await codePromise;
	} catch (err) {
		throw new CliError(`Login failed: ${(err as Error).message}`, ExitCode.AUTH);
	}

	let tokens: TokenResponse;
	try {
		tokens = await exchangeCodeForToken(cfg, code, verifier);
	} catch (err) {
		throw new CliError(`Login failed: ${(err as Error).message}`, ExitCode.AUTH);
	}

	const payload = decodeJwtPayload(tokens.access_token);
	const namespace = `${cfg.auth0.audience}/`;
	const email =
		(payload.email as string | undefined) ??
		(payload[`${namespace}email`] as string | undefined);

	const bundle: TokenBundle = {
		server,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + tokens.expires_in * 1000,
		sub: payload.sub,
		email,
	};
	writeToken(bundle);
	return bundle;
}
