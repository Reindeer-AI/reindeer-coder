import { type Auth0Client, createAuth0Client, type User } from '@auth0/auth0-spa-js';
import { get, writable } from 'svelte/store';
import { browser } from '$app/environment';

interface ExtendedUser extends User {
	accessDenied?: boolean;
}

let auth0Client: Auth0Client | null = null;
let authDisabled = false;

export const isAuthenticated = writable(false);
export const user = writable<ExtendedUser | null>(null);
export const authToken = writable<string | null>(null);
export const authLoading = writable(true);

// Default user when auth is disabled
const DEFAULT_USER: ExtendedUser = {
	sub: 'local-dev-user',
	email: 'dev@localhost',
	name: 'Local Developer',
};

/**
 * Initialize auth - checks if auth is disabled first
 * @param disableAuth - If true, skips Auth0 and uses default user
 * @param autoRedirect - If true and auth enabled, redirects to login if not authenticated
 */
export async function initAuth0(autoRedirect = true, disableAuth = false): Promise<void> {
	if (!browser) return;

	// If auth is disabled, set default user and return
	if (disableAuth) {
		authDisabled = true;
		isAuthenticated.set(true);
		user.set(DEFAULT_USER);
		authToken.set(null); // No token needed - API accepts requests without tokens
		authLoading.set(false);
		console.log('[Auth] Authentication disabled - using default user');
		return;
	}

	try {
		auth0Client = await createAuth0Client({
			domain: import.meta.env.VITE_AUTH0_DOMAIN,
			clientId: import.meta.env.VITE_AUTH0_CLIENT_ID,
			authorizationParams: {
				redirect_uri: window.location.origin,
				audience: import.meta.env.VITE_AUTH0_AUDIENCE,
				organization: import.meta.env.VITE_AUTH0_ORG_ID,
			},
			cacheLocation: 'localstorage',
		});

		// Handle redirect callback
		if (window.location.search.includes('code=')) {
			await auth0Client.handleRedirectCallback();
			window.history.replaceState({}, document.title, window.location.pathname);
		}

		const authenticated = await auth0Client.isAuthenticated();
		isAuthenticated.set(authenticated);

		if (authenticated) {
			const userData = await auth0Client.getUser();
			user.set(userData || null);

			try {
				const token = await auth0Client.getTokenSilently();
				authToken.set(token);
			} catch (err) {
				console.error('Failed to get token:', err);
				// User might not have access to the org - redirect to login
				user.set({ ...userData, accessDenied: true } as ExtendedUser);
				isAuthenticated.set(false);
				if (autoRedirect) {
					await auth0Client.loginWithRedirect();
					return;
				}
			}
		} else if (autoRedirect) {
			// Not authenticated - auto redirect to login
			await auth0Client.loginWithRedirect();
			return;
		}
	} catch (err) {
		console.error('Auth0 init failed:', err);
		// On auth error, try to redirect to login
		if (autoRedirect && auth0Client) {
			try {
				await auth0Client.loginWithRedirect();
				return;
			} catch {
				// Ignore redirect errors
			}
		}
	} finally {
		authLoading.set(false);
	}
}

export async function login(): Promise<void> {
	if (!auth0Client) return;
	await auth0Client.loginWithRedirect();
}

export async function logout(): Promise<void> {
	if (!auth0Client) return;
	await auth0Client.logout({
		logoutParams: {
			returnTo: window.location.origin,
		},
	});
}

export async function getToken(): Promise<string | null> {
	if (!auth0Client) return null;
	try {
		return await auth0Client.getTokenSilently();
	} catch {
		return null;
	}
}
