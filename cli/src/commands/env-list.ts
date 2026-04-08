import type { ApiClient } from '../api.js';
import { log, out, table } from '../util.js';

export async function envListCommand(api: ApiClient): Promise<void> {
	const envs = await api.listEnvironments();

	if (envs.length === 0) {
		log('No environments. Create one with: vibe env create --spec <name> --name <name>');
		return;
	}

	const rows = envs.map((env) => [
		env.id,
		env.name,
		env.status,
		env.vm_name ?? '-',
		env.vm_zone ?? '-',
	]);

	out(table(['ID', 'NAME', 'STATUS', 'VM', 'ZONE'], rows));
}
