import { CliError, ExitCode, sleep } from './util.js';

// ── Types mirrored from app/src/lib/server/db/schema.ts ────────

export type EnvironmentStatus =
	| 'pending'
	| 'provisioning'
	| 'ready'
	| 'stopped'
	| 'failed'
	| 'deleted';

export interface EnvironmentConnectionInfo {
	ssh_command?: string;
	container_shell_command?: string;
	forwarded_ports?: number[];
	container_id?: string;
	workspace_folder?: string;
}

export interface Environment {
	id: string;
	user_id: string;
	user_email: string;
	name: string;
	spec_id: string;
	status: EnvironmentStatus;
	vm_name: string | null;
	vm_zone: string | null;
	vm_machine_type: string | null;
	connection_info: EnvironmentConnectionInfo | null;
	metadata: Record<string, unknown> | null;
	created_at: string;
	updated_at: string;
}

export interface Spec {
	id: string;
	user_id: string;
	name: string;
	secret_path: string;
	created_at: string;
	updated_at: string;
	/** Only populated by GET /api/specs/:id, never by list. */
	devcontainer_json?: string;
}

export interface SpecCreateInput {
	name: string;
	devcontainer_json: string;
}

export interface SpecUpdateInput {
	name?: string;
	devcontainer_json?: string;
}

/**
 * Public bootstrap config returned by GET /api/extension-config.
 * Contains everything the CLI needs to drive the OAuth flow against
 * whichever Auth0 tenant the deployment is configured to use.
 */
export interface ExtensionConfig {
	auth0: {
		domain: string;
		clientId: string;
		audience: string;
		organizationId?: string;
	};
	gcp: { project: string };
	vm: { user: string };
	app: { url: string };
	agent: { defaultSystemPrompt: string };
}

// ── HTTP client ─────────────────────────────────────────────────

export class ApiClient {
	constructor(
		private readonly server: string,
		private readonly getToken: () => string | null,
	) {}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		opts: { auth?: boolean } = { auth: true },
	): Promise<T> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (opts.auth !== false) {
			const token = this.getToken();
			if (!token) {
				throw new CliError('Not logged in. Run: vibe login', ExitCode.AUTH);
			}
			headers.Authorization = `Bearer ${token}`;
		}

		let response: Response;
		try {
			response = await fetch(`${this.server}${path}`, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch (err) {
			throw new CliError(
				`Cannot reach reindeer-coder at ${this.server}: ${(err as Error).message}`,
				ExitCode.NETWORK,
			);
		}

		if (response.status === 401) {
			throw new CliError(
				'Authentication expired. Run: vibe login',
				ExitCode.AUTH,
			);
		}
		if (response.status === 404) {
			throw new CliError(`Not found: ${path}`, ExitCode.NOT_FOUND);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new CliError(
				`${method} ${path} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`,
				ExitCode.NETWORK,
			);
		}

		// 204 No Content
		if (response.status === 204) {
			return undefined as T;
		}
		return (await response.json()) as T;
	}

	async fetchExtensionConfig(): Promise<ExtensionConfig> {
		return this.request<ExtensionConfig>('GET', '/api/extension-config', undefined, {
			auth: false,
		});
	}

	async listEnvironments(): Promise<Environment[]> {
		const data = await this.request<{ environments: Environment[] }>(
			'GET',
			'/api/environments',
		);
		return data.environments;
	}

	async getEnvironment(id: string): Promise<Environment> {
		const data = await this.request<{ environment: Environment }>(
			'GET',
			`/api/environments/${encodeURIComponent(id)}`,
		);
		return data.environment;
	}

	async createEnvironment(input: {
		spec_id: string;
		name?: string;
		machine_type?: string;
	}): Promise<Environment> {
		const data = await this.request<{ environment: Environment }>(
			'POST',
			'/api/environments',
			input,
		);
		return data.environment;
	}

	async deleteEnvironment(id: string): Promise<void> {
		await this.request<{ success: true }>(
			'DELETE',
			`/api/environments/${encodeURIComponent(id)}`,
		);
	}

	async startEnvironment(id: string): Promise<Environment> {
		const data = await this.request<{ environment: Environment }>(
			'POST',
			`/api/environments/${encodeURIComponent(id)}/start`,
		);
		return data.environment;
	}

	async stopEnvironment(id: string): Promise<Environment> {
		const data = await this.request<{ environment: Environment }>(
			'POST',
			`/api/environments/${encodeURIComponent(id)}/stop`,
		);
		return data.environment;
	}

	/**
	 * Poll an environment until it reaches `ready`, throwing on failed/deleted
	 * or after the timeout. Emits a status line via `onStatus` whenever the
	 * value changes, so callers can show progress without polling themselves.
	 */
	async waitForEnvReady(
		id: string,
		opts: {
			timeoutMs: number;
			pollMs?: number;
			onStatus?: (status: EnvironmentStatus) => void;
		},
	): Promise<Environment> {
		const pollMs = opts.pollMs ?? 3000;
		const deadline = Date.now() + opts.timeoutMs;
		let lastStatus: EnvironmentStatus | '' = '';

		while (Date.now() < deadline) {
			const env = await this.getEnvironment(id);
			if (env.status !== lastStatus) {
				opts.onStatus?.(env.status);
				lastStatus = env.status;
			}
			if (env.status === 'ready') {
				return env;
			}
			if (env.status === 'failed' || env.status === 'deleted') {
				throw new CliError(
					`Environment ${id} entered terminal state: ${env.status}`,
					ExitCode.ENV_NOT_READY,
				);
			}
			await sleep(pollMs);
		}

		throw new CliError(
			`Environment ${id} did not become ready within ${Math.floor(opts.timeoutMs / 1000)}s`,
			ExitCode.ENV_NOT_READY,
		);
	}

	async listSpecs(): Promise<Spec[]> {
		const data = await this.request<{ specs: Spec[] }>('GET', '/api/specs');
		return data.specs;
	}

	async getSpec(id: string): Promise<Spec> {
		const data = await this.request<{ spec: Spec }>(
			'GET',
			`/api/specs/${encodeURIComponent(id)}`,
		);
		return data.spec;
	}

	async createSpec(input: SpecCreateInput): Promise<Spec> {
		const data = await this.request<{ spec: Spec }>('POST', '/api/specs', input);
		return data.spec;
	}

	async updateSpec(id: string, input: SpecUpdateInput): Promise<Spec> {
		const data = await this.request<{ spec: Spec }>(
			'PUT',
			`/api/specs/${encodeURIComponent(id)}`,
			input,
		);
		return data.spec;
	}

	async deleteSpec(id: string): Promise<void> {
		await this.request<{ success: true }>(
			'DELETE',
			`/api/specs/${encodeURIComponent(id)}`,
		);
	}

	/**
	 * Resolve a spec reference (id or name) to a Spec record. UUID-shaped
	 * inputs are looked up directly; everything else is treated as a name and
	 * resolved against the user's spec list.
	 */
	async resolveSpec(ref: string): Promise<Spec> {
		if (looksLikeUuid(ref)) {
			return this.getSpec(ref);
		}
		const specs = await this.listSpecs();
		const match = specs.find((s) => s.name === ref);
		if (!match) {
			throw new CliError(
				`Spec "${ref}" not found. List with: vibe spec list`,
				ExitCode.NOT_FOUND,
			);
		}
		return match;
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(s: string): boolean {
	return UUID_RE.test(s);
}
