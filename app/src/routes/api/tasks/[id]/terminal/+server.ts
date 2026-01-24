import { error } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { readTerminalFile } from '$lib/server/terminal-storage';
import { getActiveConnection, getConnectionStatus } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// SSE endpoint for terminal streaming
export const GET: RequestHandler = async ({ params, request, url }) => {
	const token = url.searchParams.get('token');
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const task = await getTaskById(params.id);
	if (!task) {
		throw error(404, 'Task not found');
	}

	// Check ownership
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	if (!isAdmin && task.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	console.log(`[terminal:sse] Starting stream for task ${params.id}, status: ${task.status}`);

	// Create SSE stream
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let isClosed = false;

			const safeClose = () => {
				if (!isClosed) {
					isClosed = true;
					console.log(`[terminal:sse] Closing stream for task ${params.id}`);
					try {
						controller.close();
					} catch {
						// Already closed
					}
				}
			};

			// Send initial terminal buffer
			let initialBuffer = '';
			if (task.terminal_file_path) {
				// Read from file (unlimited for streaming byte offset tracking)
				const fileContent = readTerminalFile(params.id, null);
				if (fileContent) {
					initialBuffer = fileContent;
					console.log(
						`[terminal:sse] Sending initial buffer from file (${fileContent.length} chars)`
					);
				}
			} else if (task.terminal_buffer) {
				// Legacy: read from DB
				initialBuffer = task.terminal_buffer;
				console.log(
					`[terminal:sse] Sending initial buffer from DB (${task.terminal_buffer.length} chars)`
				);
			}

			if (initialBuffer) {
				const data = JSON.stringify({ type: 'buffer', content: initialBuffer });
				controller.enqueue(encoder.encode(`data: ${data}\n\n`));
			}

			// Send task status
			const statusData = JSON.stringify({ type: 'status', status: task.status });
			controller.enqueue(encoder.encode(`data: ${statusData}\n\n`));

			// Send initial connection status
			const connStatus = getConnectionStatus(params.id);
			if (connStatus) {
				const connData = JSON.stringify({ type: 'connection', ...connStatus });
				controller.enqueue(encoder.encode(`data: ${connData}\n\n`));
			}

			// Poll for updates (in production, use proper pub/sub)
			let lastBufferLength = initialBuffer.length;
			let lastStatus = task.status;
			let lastConnStatus = connStatus?.status || null;
			let pollCount = 0;

			const pollInterval = setInterval(async () => {
				if (isClosed) {
					clearInterval(pollInterval);
					return;
				}

				pollCount++;
				const currentTask = await getTaskById(params.id);
				if (!currentTask) {
					console.log(`[terminal:sse] Task ${params.id} not found, closing stream`);
					clearInterval(pollInterval);
					safeClose();
					return;
				}

				// Check for new terminal output
				let currentBufferLength = 0;
				let newContent = '';

				if (currentTask.terminal_file_path) {
					// Read from file (unlimited for streaming byte offset tracking)
					const fileContent = readTerminalFile(params.id, null);
					currentBufferLength = fileContent?.length || 0;
					if (currentBufferLength > lastBufferLength && fileContent) {
						newContent = fileContent.slice(lastBufferLength);
					}
				} else {
					// Legacy: read from DB
					currentBufferLength = currentTask.terminal_buffer?.length || 0;
					if (currentBufferLength > lastBufferLength && currentTask.terminal_buffer) {
						newContent = currentTask.terminal_buffer.slice(lastBufferLength);
					}
				}

				if (newContent) {
					// Log every 10th update or significant changes
					if (pollCount % 10 === 0 || newContent.length > 100) {
						console.log(`[terminal:sse] Task ${params.id}: sending ${newContent.length} new chars`);
					}
					const data = JSON.stringify({ type: 'output', content: newContent });
					try {
						controller.enqueue(encoder.encode(`data: ${data}\n\n`));
					} catch {
						clearInterval(pollInterval);
						return;
					}
					lastBufferLength = currentBufferLength;
				}

				// Check for status changes
				if (currentTask.status !== lastStatus) {
					console.log(
						`[terminal:sse] Task ${params.id}: status changed from ${lastStatus} to ${currentTask.status}`
					);
					const statusData = JSON.stringify({ type: 'status', status: currentTask.status });
					try {
						controller.enqueue(encoder.encode(`data: ${statusData}\n\n`));
					} catch {
						clearInterval(pollInterval);
						return;
					}
					lastStatus = currentTask.status;

					// Close stream if task is done
					if (['completed', 'failed', 'stopped'].includes(currentTask.status)) {
						console.log(`[terminal:sse] Task ${params.id}: task finished, closing stream`);
						const doneData = JSON.stringify({ type: 'done', status: currentTask.status });
						try {
							controller.enqueue(encoder.encode(`data: ${doneData}\n\n`));
						} catch {
							// Ignore
						}
						clearInterval(pollInterval);
						safeClose();
					}
				}

				// Check for connection status changes
				const currentConnStatus = getConnectionStatus(params.id);
				const currentConnStatusValue = currentConnStatus?.status || null;
				if (currentConnStatusValue !== lastConnStatus) {
					console.log(
						`[terminal:sse] Task ${params.id}: connection status changed from ${lastConnStatus} to ${currentConnStatusValue}`
					);
					if (currentConnStatus) {
						const connData = JSON.stringify({ type: 'connection', ...currentConnStatus });
						try {
							controller.enqueue(encoder.encode(`data: ${connData}\n\n`));
						} catch {
							clearInterval(pollInterval);
							return;
						}
					}
					lastConnStatus = currentConnStatusValue;
				}
			}, 500);

			// Cleanup on abort
			request.signal.addEventListener('abort', () => {
				clearInterval(pollInterval);
				safeClose();
			});
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
};

// POST to send input to terminal (for interactive mode)
export const POST: RequestHandler = async ({ params, request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const task = await getTaskById(params.id);
	if (!task) {
		throw error(404, 'Task not found');
	}

	// Check ownership
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	if (!isAdmin && task.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	if (task.status !== 'running') {
		throw error(400, 'Task is not running');
	}

	const body = await request.json();
	const input = body.input as string;

	if (!input) {
		throw error(400, 'Missing input');
	}

	// Get active SSH connection and write to it
	const conn = getActiveConnection(params.id);
	if (!conn) {
		throw error(500, 'No active connection for task');
	}

	// Write to the SSH connection
	console.log(`[terminal:input] Sending input to task ${params.id}: ${JSON.stringify(input)}`);
	conn.write(input);

	return new Response(JSON.stringify({ success: true }), {
		headers: { 'Content-Type': 'application/json' },
	});
};
