// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

// Environment variable types
declare module '$env/static/private' {
	export const AUTH0_DOMAIN: string;
	export const GCP_PROJECT_ID: string;
	export const GCP_ZONE: string;
	export const GCP_SERVICE_ACCOUNT: string;
	export const VM_IMAGE_FAMILY: string;
	export const VM_IMAGE_PROJECT: string;
	export const VM_MACHINE_TYPE: string;
	export const ANTHROPIC_API_KEY: string;
	export const GOOGLE_API_KEY: string;
	export const OPENAI_API_KEY: string;
	export const SSH_PRIVATE_KEY_PATH: string;
	export const SSH_PUBLIC_KEY: string;
	export const DB_PATH: string;
}

export {};
