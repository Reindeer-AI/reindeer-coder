import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => {
	return {
		env: {
			GCP_PROJECT_ID: env.GCP_PROJECT_ID || '',
			VM_USER: env.VM_USER || '',
			GCP_ZONE: env.GCP_ZONE || 'us-central1-a',
		},
	};
};
