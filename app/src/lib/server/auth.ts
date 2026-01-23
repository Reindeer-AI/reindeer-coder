import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';

export interface TokenPayload {
	sub: string;
	email?: string;
	permissions: string[];
}

// Cache JWKS
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
	if (!jwks) {
		const domain = env.AUTH0_DOMAIN;
		if (!domain) {
			throw new Error('AUTH0_DOMAIN environment variable is required');
		}
		jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
	}
	return jwks;
}

/**
 * Verify a JWT token from Auth0
 */
export async function verifyToken(token: string): Promise<TokenPayload | null> {
	try {
		if (!env.AUTH0_AUDIENCE) {
			throw new Error('AUTH0_AUDIENCE environment variable is required');
		}
		const { payload } = await jwtVerify(token, getJWKS(), {
			issuer: `https://${env.AUTH0_DOMAIN}/`,
			audience: env.AUTH0_AUDIENCE,
		});

		return {
			sub: payload.sub as string,
			email: payload.email as string | undefined,
			permissions: (payload.permissions as string[]) || [],
		};
	} catch (error) {
		console.error('Token verification failed:', error);
		return null;
	}
}

/**
 * Extract bearer token from Authorization header
 */
export function extractBearerToken(authHeader: string | null): string | null {
	if (!authHeader) return null;
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	return match ? match[1] : null;
}
