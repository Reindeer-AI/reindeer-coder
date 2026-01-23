// @ts-expect-error - Optional dependency, only needed for direct VM management
import { InstancesClient, type protos } from '@google-cloud/compute';
import { configService } from '../config-service';
import type { Task } from '../db/schema';

const compute = new InstancesClient();

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const MACHINE_TYPE = process.env.VM_MACHINE_TYPE;
const IMAGE_FAMILY = process.env.VM_IMAGE_FAMILY;
const IMAGE_PROJECT = process.env.VM_IMAGE_PROJECT;

/**
 * Create a new VM instance for a coding task
 */
export async function createVM(name: string, zone: string, task: Task): Promise<void> {
	const startupScript = await generateStartupScript(task);

	const instance: protos.google.cloud.compute.v1.IInstance = {
		name,
		machineType: `zones/${zone}/machineTypes/${MACHINE_TYPE}`,
		disks: [
			{
				boot: true,
				autoDelete: true,
				initializeParams: {
					sourceImage: `projects/${IMAGE_PROJECT}/global/images/family/${IMAGE_FAMILY}`,
					diskSizeGb: '50',
				},
			},
		],
		networkInterfaces: [
			{
				network: 'global/networks/default',
				accessConfigs: [
					{
						name: 'External NAT',
						type: 'ONE_TO_ONE_NAT',
					},
				],
			},
		],
		metadata: {
			items: [
				{
					key: 'startup-script',
					value: startupScript,
				},
				{
					key: 'ssh-keys',
					value: `vibe:${process.env.SSH_PUBLIC_KEY || ''}`,
				},
			],
		},
		labels: {
			'vibe-task': task.id.slice(0, 63),
			'coding-cli': task.coding_cli,
		},
		serviceAccounts: [
			{
				email: 'default',
				scopes: ['https://www.googleapis.com/auth/cloud-platform'],
			},
		],
		tags: {
			items: ['vibe-coding', 'allow-ssh'],
		},
	};

	const [operation] = await compute.insert({
		project: PROJECT_ID,
		zone,
		instanceResource: instance,
	});

	// Wait for the operation to complete
	await operation.promise();
}

/**
 * Generate startup script for VM
 */
async function generateStartupScript(_task: Task): Promise<string> {
	const fallbackEmail = await configService.get('email.fallback_address', 'agent@example.com');
	const vmUser = await configService.get('vm.user', 'agent');

	return `#!/bin/bash
set -e

# Update and install dependencies
apt-get update
apt-get install -y git curl nodejs npm python3 python3-pip

# Install Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Create agent user
useradd -m -s /bin/bash ${vmUser} || true
mkdir -p /home/${vmUser}/.ssh
cp /root/.ssh/authorized_keys /home/${vmUser}/.ssh/ 2>/dev/null || true
chown -R ${vmUser}:${vmUser} /home/${vmUser}/.ssh
chmod 700 /home/${vmUser}/.ssh
chmod 600 /home/${vmUser}/.ssh/authorized_keys 2>/dev/null || true

# Set up environment variables for the agent
cat >> /home/${vmUser}/.bashrc << 'EOF'
export ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY || ''}"
export GOOGLE_API_KEY="${process.env.GOOGLE_API_KEY || ''}"
export OPENAI_API_KEY="${process.env.OPENAI_API_KEY || ''}"
export PATH="$HOME/.claude/bin:$HOME/.local/bin:$PATH"
EOF

# Configure git
sudo -u ${vmUser} git config --global user.email "${fallbackEmail}"
sudo -u ${vmUser} git config --global user.name "Coding Agent"

# Signal that VM is ready
touch /tmp/vibe_ready

echo "VM setup complete"
`;
}

/**
 * Wait for VM to be ready (running and startup script completed)
 */
export async function waitForVM(name: string, zone: string, timeoutMs = 300000): Promise<void> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		const [instance] = await compute.get({
			project: PROJECT_ID,
			zone,
			instance: name,
		});

		if (instance.status === 'RUNNING') {
			// Give startup script time to complete
			await sleep(10000);
			return;
		}

		await sleep(5000);
	}

	throw new Error(`Timeout waiting for VM ${name} to be ready`);
}

/**
 * Get external IP address of a VM
 */
export async function getVMExternalIP(name: string, zone: string): Promise<string | null> {
	const [instance] = await compute.get({
		project: PROJECT_ID,
		zone,
		instance: name,
	});

	const networkInterface = instance.networkInterfaces?.[0];
	const accessConfig = networkInterface?.accessConfigs?.[0];
	return accessConfig?.natIP || null;
}

/**
 * Delete a VM instance
 */
export async function deleteVM(name: string, zone: string): Promise<void> {
	try {
		const [operation] = await compute.delete({
			project: PROJECT_ID,
			zone,
			instance: name,
		});

		await operation.promise();
	} catch (err) {
		// Ignore if VM doesn't exist
		console.warn(`Failed to delete VM ${name}:`, err);
	}
}

/**
 * List all vibe-coding VMs
 */
export async function listVibeVMs(zone: string): Promise<string[]> {
	const [instances] = await compute.list({
		project: PROJECT_ID,
		zone,
		filter: 'labels.vibe-task:*',
	});

	return (instances || []).map((i: { name?: string }) => i.name || '').filter(Boolean);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
