/**
 * PM2 Ecosystem Configuration
 *
 * Deploy with: pm2 start deployment/ecosystem.config.cjs
 *
 * Note: The Linear Agent Monitor runs automatically as part of the web server
 * via hooks.server.ts. No need to run it separately.
 */

module.exports = {
	apps: [
		{
			name: 'vibe-coding',
			script: 'build/index.js',
			instances: 1,
			exec_mode: 'cluster',
			env: {
				NODE_ENV: 'production',
				PORT: 3000,
			},
			error_file: './logs/vibe-coding-error.log',
			out_file: './logs/vibe-coding-out.log',
			time: true,
			autorestart: true,
			max_restarts: 10,
			min_uptime: '10s',
			max_memory_restart: '750M', // Increased to account for Linear monitor
			cron_restart: '0 3 * * *', // Restart daily at 3 AM
		},
	],
};
