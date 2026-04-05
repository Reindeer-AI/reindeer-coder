import { configService } from '../config-service';

interface HostRequirements {
	cpus?: number;
	memory?: string;
	storage?: string;
	gpu?: boolean | string | { cores?: number; memory?: string };
}

interface DevcontainerConfig {
	hostRequirements?: HostRequirements;
	[key: string]: unknown;
}

/**
 * Resolve a GCP machine type from devcontainer.json hostRequirements or an explicit override.
 * Falls back to the configured default (vm.machine_type) if no requirements are specified.
 */
export async function resolveMachineType(
	devcontainerJson: string,
	overrideMachineType?: string
): Promise<string> {
	if (overrideMachineType) return overrideMachineType;

	const config: DevcontainerConfig = JSON.parse(devcontainerJson);
	const reqs = config.hostRequirements;
	if (!reqs) {
		return await configService.get('vm.machine_type', 'e2-standard-4');
	}

	const cpus = reqs.cpus ?? 2;
	const memGb = parseMemory(reqs.memory ?? '4gb');

	// e2-standard-N: N vCPUs, 4GB per vCPU
	const neededForCpus = Math.max(2, nextPowerOf2(cpus));
	const neededForMem = Math.max(2, nextPowerOf2(Math.ceil(memGb / 4)));
	const size = Math.min(Math.max(neededForCpus, neededForMem), 32);

	return `e2-standard-${size}`;
}

function parseMemory(mem: string): number {
	const match = mem.toLowerCase().match(/^(\d+)\s*(gb|mb|tb)?$/);
	if (!match) return 4;
	const val = parseInt(match[1], 10);
	const unit = match[2] || 'gb';
	if (unit === 'mb') return val / 1024;
	if (unit === 'tb') return val * 1024;
	return val;
}

function nextPowerOf2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}
