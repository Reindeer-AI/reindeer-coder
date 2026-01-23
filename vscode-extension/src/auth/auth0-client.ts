import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
}

export class Auth0Client {
	private static readonly TOKEN_KEY = 'reindeer-coder-access-token';
	private static readonly REFRESH_TOKEN_KEY = 'reindeer-coder-refresh-token';
	private static readonly TOKEN_EXPIRY_KEY = 'reindeer-coder-token-expiry';

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly domain: string,
		private readonly clientId: string,
		private readonly audience: string,
		private readonly organizationId?: string,
		private readonly redirectUri: string = 'http://localhost:54321/callback'
	) {}

	/**
	 * Generate PKCE code verifier and challenge
	 */
	private generatePKCE(): { verifier: string; challenge: string } {
		const verifier = crypto.randomBytes(32).toString('base64url');
		const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
		return { verifier, challenge };
	}

	/**
	 * Start the OAuth2 PKCE flow
	 */
	async login(): Promise<boolean> {
		try {
			console.log('[Auth0] Starting login flow...');
			const { verifier, challenge } = this.generatePKCE();
			const state = crypto.randomBytes(16).toString('hex');

			console.log('[Auth0] PKCE challenge generated');

			// Build authorization URL
			const authUrl = new URL(`https://${this.domain}/authorize`);
			authUrl.searchParams.set('response_type', 'code');
			authUrl.searchParams.set('client_id', this.clientId);
			authUrl.searchParams.set('redirect_uri', this.redirectUri);
			authUrl.searchParams.set('scope', 'openid profile email offline_access');
			authUrl.searchParams.set('code_challenge', challenge);
			authUrl.searchParams.set('code_challenge_method', 'S256');
			authUrl.searchParams.set('state', state);
			authUrl.searchParams.set('audience', this.audience);

			// Add organization if provided
			if (this.organizationId) {
				authUrl.searchParams.set('organization', this.organizationId);
				console.log(`[Auth0] Organization ID set: ${this.organizationId}`);
			}

			console.log(`[Auth0] Authorization URL: ${authUrl.toString().substring(0, 100)}...`);

			// Open browser and start local server to capture callback
			console.log('[Auth0] Starting callback server on port 54321...');
			const authCode = await this.captureAuthCode(authUrl.toString(), state);

			if (!authCode) {
				console.error('[Auth0] Failed to get authorization code');
				throw new Error('Failed to get authorization code');
			}

			console.log('[Auth0] Authorization code received, exchanging for tokens...');

			// Exchange code for tokens
			await this.exchangeCodeForToken(authCode, verifier);

			console.log('[Auth0] Login successful');
			vscode.window.showInformationMessage('Successfully logged in to Reindeer Coder');
			return true;
		} catch (error) {
			console.error('[Auth0] Login failed:', error);
			vscode.window.showErrorMessage(`Login failed: ${error}`);
			return false;
		}
	}

	/**
	 * Capture authorization code from callback
	 */
	private async captureAuthCode(authUrl: string, state: string): Promise<string | null> {
		return new Promise((resolve) => {
			const http = require('node:http');

			const server = http.createServer((req: any, res: any) => {
				const url = new URL(req.url, 'http://localhost:54321');

				if (url.pathname === '/callback') {
					const code = url.searchParams.get('code');
					const returnedState = url.searchParams.get('state');

					if (returnedState === state && code) {
						res.writeHead(200, { 'Content-Type': 'text/html' });
						res.end(
							'<html><body><h1>Login successful!</h1><p>You can close this window.</p></body></html>'
						);
						server.close();
						resolve(code);
					} else {
						res.writeHead(400, { 'Content-Type': 'text/html' });
						res.end(
							'<html><body><h1>Login failed</h1><p>Invalid state or missing code.</p></body></html>'
						);
						server.close();
						resolve(null);
					}
				}
			});

			server.listen(54321, () => {
				vscode.env.openExternal(vscode.Uri.parse(authUrl));
			});

			// Timeout after 5 minutes
			setTimeout(() => {
				server.close();
				resolve(null);
			}, 300000);
		});
	}

	/**
	 * Exchange authorization code for access token
	 */
	private async exchangeCodeForToken(code: string, verifier: string): Promise<void> {
		const axios = require('axios');

		const tokenRequest: any = {
			grant_type: 'authorization_code',
			client_id: this.clientId,
			code,
			code_verifier: verifier,
			redirect_uri: this.redirectUri,
		};

		// Include audience if provided (required for custom APIs)
		if (this.audience) {
			tokenRequest.audience = this.audience;
		}

		const response = await axios.post<TokenResponse>(
			`https://${this.domain}/oauth/token`,
			tokenRequest,
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);

		const { access_token, refresh_token, expires_in } = response.data;
		const expiryTime = Date.now() + expires_in * 1000;

		// Store tokens securely
		await this.context.secrets.store(Auth0Client.TOKEN_KEY, access_token);
		if (refresh_token) {
			await this.context.secrets.store(Auth0Client.REFRESH_TOKEN_KEY, refresh_token);
		}
		await this.context.globalState.update(Auth0Client.TOKEN_EXPIRY_KEY, expiryTime);
	}

	/**
	 * Get current access token, refreshing if necessary
	 */
	async getAccessToken(): Promise<string | null> {
		console.log('[Auth0] Getting access token...');
		const token = await this.context.secrets.get(Auth0Client.TOKEN_KEY);
		const expiry = this.context.globalState.get<number>(Auth0Client.TOKEN_EXPIRY_KEY);

		if (!token) {
			console.log('[Auth0] No token found in storage');
			return null;
		}

		console.log('[Auth0] Token found');

		// Check if token is expired or will expire in next 5 minutes
		if (expiry) {
			const timeUntilExpiry = expiry - Date.now();
			console.log(`[Auth0] Token expires in ${Math.floor(timeUntilExpiry / 1000)} seconds`);

			if (Date.now() >= expiry - 300000) {
				console.log('[Auth0] Token expiring soon, refreshing...');
				const refreshed = await this.refreshToken();
				if (!refreshed) {
					console.error('[Auth0] Token refresh failed');
					return null;
				}
				return await this.context.secrets.get(Auth0Client.TOKEN_KEY);
			}
		}

		return token;
	}

	/**
	 * Refresh access token using refresh token
	 */
	private async refreshToken(): Promise<boolean> {
		try {
			const refreshToken = await this.context.secrets.get(Auth0Client.REFRESH_TOKEN_KEY);
			if (!refreshToken) {
				return false;
			}

			const axios = require('axios');
			const response = await axios.post<TokenResponse>(
				`https://${this.domain}/oauth/token`,
				{
					grant_type: 'refresh_token',
					client_id: this.clientId,
					refresh_token: refreshToken,
				},
				{
					headers: { 'Content-Type': 'application/json' },
				}
			);

			const { access_token, refresh_token, expires_in } = response.data;
			const expiryTime = Date.now() + expires_in * 1000;

			await this.context.secrets.store(Auth0Client.TOKEN_KEY, access_token);
			if (refresh_token) {
				await this.context.secrets.store(Auth0Client.REFRESH_TOKEN_KEY, refresh_token);
			}
			await this.context.globalState.update(Auth0Client.TOKEN_EXPIRY_KEY, expiryTime);

			return true;
		} catch (error) {
			console.error('Failed to refresh token:', error);
			return false;
		}
	}

	/**
	 * Logout and clear all stored tokens
	 */
	async logout(): Promise<void> {
		await this.context.secrets.delete(Auth0Client.TOKEN_KEY);
		await this.context.secrets.delete(Auth0Client.REFRESH_TOKEN_KEY);
		await this.context.globalState.update(Auth0Client.TOKEN_EXPIRY_KEY, undefined);
		vscode.window.showInformationMessage('Logged out from Reindeer Coder');
	}

	/**
	 * Check if user is currently authenticated
	 */
	async isAuthenticated(): Promise<boolean> {
		console.log('[Auth0] Checking authentication status...');
		const token = await this.getAccessToken();
		const isAuth = token !== null;
		console.log(`[Auth0] Is authenticated: ${isAuth}`);
		return isAuth;
	}

	/**
	 * Get user info from the access token
	 */
	async getUserInfo(): Promise<{ email?: string; name?: string } | null> {
		try {
			const token = await this.getAccessToken();
			if (!token) {
				return null;
			}

			// Decode JWT token (just the payload, no signature verification needed since we trust our own storage)
			const parts = token.split('.');
			if (parts.length !== 3) {
				console.error('[Auth0] Invalid JWT token format');
				return null;
			}

			const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

			// Try standard claims first, then check for custom namespace claims
			// The custom namespace is based on the audience URL
			const namespacePrefix = `${this.audience}/`;
			return {
				email: payload.email || payload[`${namespacePrefix}email`],
				name: payload.name || payload[`${namespacePrefix}name`],
			};
		} catch (error) {
			console.error('[Auth0] Failed to get user info:', error);
			return null;
		}
	}
}
