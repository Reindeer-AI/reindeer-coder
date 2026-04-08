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
	// resolveSpec's UUID path already calls getSpec (which includes the
	// devcontainer.json content). Its name path calls listSpecs instead,
	// which doesn't. Re-fetch by id only if we don't already have the
	// content to avoid a double round-trip.
	let spec = await api.resolveSpec(ref);
	if (spec.devcontainer_json === undefined) {
		spec = await api.getSpec(spec.id);
	}

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
