import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { initializeDefaultConfig } from './lib/server/config-service';
import { LinearAgentMonitor } from './lib/server/tasks/linear-agent-monitor';

// Initialize default configuration
console.log('[Server] Initializing default configuration...');
initializeDefaultConfig().catch((error) => {
	console.error('[Server] Failed to initialize default configuration:', error);
});

// Global monitor instance
let monitor: LinearAgentMonitor | null = null;

// Start the Linear agent monitor when the server starts
if (env.LINEAR_API_KEY) {
	console.log('[Server] Starting Linear Agent Monitor...');
	monitor = new LinearAgentMonitor();
	monitor.start().catch((error) => {
		console.error('[Server] Fatal error in Linear Agent Monitor:', error);
	});
} else {
	console.log('[Server] Linear Agent Monitor disabled (missing LINEAR_API_KEY)');
}

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
