import type { Handle } from '@sveltejs/kit';
import { initializeDefaultConfig } from './lib/server/config-service';
import { getLinearApiKey } from './lib/server/secrets';
import { LinearAgentMonitor } from './lib/server/tasks/linear-agent-monitor';

// Initialize default configuration
console.log('[Server] Initializing default configuration...');
initializeDefaultConfig().catch((error) => {
	console.error('[Server] Failed to initialize default configuration:', error);
});

// Global monitor instance
let monitor: LinearAgentMonitor | null = null;

// Start the Linear agent monitor when the server starts
async function startLinearMonitor() {
	try {
		const apiKey = await getLinearApiKey();
		if (apiKey) {
			console.log('[Server] Starting Linear Agent Monitor...');
			monitor = new LinearAgentMonitor();
			await monitor.start();
		}
	} catch (_error) {
		console.log('[Server] Linear Agent Monitor disabled (no Linear API key configured)');
	}
}

startLinearMonitor().catch((error) => {
	console.error('[Server] Fatal error starting Linear Agent Monitor:', error);
});

// Graceful shutdown
if (typeof process !== 'undefined') {
	process.on('SIGTERM', async () => {
		console.log('[Server] SIGTERM received, stopping Linear Agent Monitor...');
		if (monitor) {
			await monitor.stop();
		}
	});

	process.on('SIGINT', async () => {
		console.log('[Server] SIGINT received, stopping Linear Agent Monitor...');
		if (monitor) {
			await monitor.stop();
		}
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
