import type { ApiClient } from '../api.js';
import { out } from '../util.js';

export interface SpecGetOptions {
	content: boolean;
}

export async function specGetCommand(
	api: ApiClient,
	ref: string,
	opts: SpecGetOptions,
): Promise<void> {
	// Resolve the ref to an id, then fetch full details (which include the
	// devcontainer.json content from Secret Manager).
	const resolved = await api.resolveSpec(ref);
	const spec = await api.getSpec(resolved.id);

	if (opts.content) {
		// Bare devcontainer.json on stdout — pipeable: vibe spec get foo --content > foo.json
		out(spec.devcontainer_json ?? '');
		return;
	}

	out(`id:         ${spec.id}`);
	out(`name:       ${spec.name}`);
	out(`created:    ${spec.created_at}`);
	out(`updated:    ${spec.updated_at}`);
	out('');
	out('devcontainer.json:');
	out(spec.devcontainer_json ?? '(empty)');
}
