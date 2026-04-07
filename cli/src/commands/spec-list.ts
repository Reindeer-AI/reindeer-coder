import type { ApiClient } from '../api.js';
import { log, out, table } from '../util.js';

export async function specListCommand(api: ApiClient): Promise<void> {
	const specs = await api.listSpecs();

	if (specs.length === 0) {
		log('No specs. Create one with: vibe spec create --name <name> --from <devcontainer.json>');
		return;
	}

	const rows = specs.map((spec) => [spec.id, spec.name, spec.created_at]);
	out(table(['ID', 'NAME', 'CREATED'], rows));
}
